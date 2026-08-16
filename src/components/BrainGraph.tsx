'use client';

import { useEffect, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { AmbientAssist } from './AmbientAssist';

interface GraphNode extends SimulationNodeDatum {
  id: string;
  title: string;
  degree: number;
  missing?: boolean;
}

interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  noteCount: number;
}

interface ThemeColors {
  accent: string;
  secondary: string;
  text: string;
  muted: string;
  border: string;
  bg: string;
}

function readTheme(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    accent: get('--accent', '#38bdf8'),
    secondary: get('--orb-secondary', get('--accent', '#9be8ff')),
    text: get('--text', '#eef4fb'),
    muted: get('--text-muted', '#7e8ca1'),
    border: get('--border', '#223047'),
    bg: get('--bg', '#0a0e14'),
  };
}

const nodeRadius = (n: GraphNode) => 3 + Math.sqrt(n.degree + 1) * 2.2;

/**
 * Obsidian-style force-directed map of the second brain: notes as glowing
 * nodes, links as edges. Canvas-rendered, colored from theme tokens (re-read
 * on data-theme changes), pan/zoom/hover, and the simulation never fully
 * freezes — the map drifts, alive by default.
 */
export function BrainGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('mapping the brain…');
  const [noteCount, setNoteCount] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let colors = readTheme();
    let raf = 0;
    let sim: Simulation<GraphNode, undefined> | null = null;
    let nodes: GraphNode[] = [];
    let links: { source: GraphNode; target: GraphNode }[] = [];
    let hovered: GraphNode | null = null;
    let neighborIds = new Set<string>();
    const view = { x: 0, y: 0, k: 1 };
    let dragging = false;
    let lastPointer = { x: 0, y: 0 };

    const themeObserver = new MutationObserver(() => {
      colors = readTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2 + view.x, h / 2 + view.y);
      ctx.scale(view.k, view.k);

      const focused = hovered !== null;
      ctx.lineWidth = 1 / view.k;
      for (const link of links) {
        const active =
          focused && (link.source === hovered || link.target === hovered);
        ctx.strokeStyle = active ? colors.accent : colors.border;
        ctx.globalAlpha = focused ? (active ? 0.9 : 0.12) : 0.45;
        ctx.beginPath();
        ctx.moveTo(link.source.x!, link.source.y!);
        ctx.lineTo(link.target.x!, link.target.y!);
        ctx.stroke();
      }

      for (const node of nodes) {
        const r = nodeRadius(node);
        const active = !focused || node === hovered || neighborIds.has(node.id);
        ctx.globalAlpha = active ? 1 : 0.18;
        const fill = node.missing ? colors.muted : node === hovered ? colors.secondary : colors.accent;
        ctx.fillStyle = fill;
        ctx.shadowColor = fill;
        ctx.shadowBlur = active ? r * 2.5 * view.k : 0;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Labels: hubs always; everything else once zoomed in; hovered on top.
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const node of nodes) {
        const show = node === hovered || neighborIds.has(node.id) || node.degree >= 6 || view.k > 1.6;
        if (!show) continue;
        const r = nodeRadius(node);
        ctx.globalAlpha = focused && !(node === hovered || neighborIds.has(node.id)) ? 0.15 : 0.9;
        ctx.fillStyle = node === hovered ? colors.text : colors.muted;
        ctx.font = `${Math.max(10, 11 / view.k)}px system-ui, sans-serif`;
        ctx.fillText(node.title, node.x!, node.y! + r + 3 / view.k);
      }

      ctx.restore();
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };

    const toWorld = (px: number, py: number) => ({
      x: (px - canvas.clientWidth / 2 - view.x) / view.k,
      y: (py - canvas.clientHeight / 2 - view.y) / view.k,
    });

    const findNode = (px: number, py: number): GraphNode | null => {
      const p = toWorld(px, py);
      let best: GraphNode | null = null;
      let bestDist = Infinity;
      for (const node of nodes) {
        const dx = node.x! - p.x;
        const dy = node.y! - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist < Math.max(nodeRadius(node) + 4, 10 / view.k) && dist < bestDist) {
          best = node;
          bestDist = dist;
        }
      }
      return best;
    };

    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      lastPointer = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (dragging) {
        view.x += e.clientX - lastPointer.x;
        view.y += e.clientY - lastPointer.y;
        lastPointer = { x: e.clientX, y: e.clientY };
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const node = findNode(e.clientX - rect.left, e.clientY - rect.top);
      if (node !== hovered) {
        hovered = node;
        neighborIds = new Set();
        if (node) {
          for (const link of links) {
            if (link.source === node) neighborIds.add(link.target.id);
            if (link.target === node) neighborIds.add(link.source.id);
          }
        }
      }
    };
    const onPointerUp = () => {
      dragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(6, Math.max(0.2, view.k * factor));
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left - canvas.clientWidth / 2;
      const cy = e.clientY - rect.top - canvas.clientHeight / 2;
      view.x = cx - ((cx - view.x) / view.k) * next;
      view.y = cy - ((cy - view.y) / view.k) * next;
      view.k = next;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let cancelled = false;
    fetch('/api/brain/graph')
      .then(async (res) => {
        const data = (await res.json()) as GraphData & { error?: string };
        if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        nodes = data.nodes;
        sim = forceSimulation(nodes)
          .force(
            'link',
            forceLink<GraphNode, GraphLink>(data.links)
              .id((n) => n.id)
              .distance(64)
              .strength(0.35),
          )
          .force('charge', forceManyBody().strength(-160))
          .force('center', forceCenter(0, 0))
          .force('collide', forceCollide<GraphNode>().radius((n) => nodeRadius(n) + 3))
          // Never let it die completely — the map keeps a faint drift.
          .alphaMin(0.001)
          .alphaTarget(0.008);
        links = data.links as { source: GraphNode; target: GraphNode }[];
        setNoteCount(data.noteCount);
        setStatus('ready');
        draw();
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setStatus('error');
        setMessage(err.message);
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      sim?.stop();
      themeObserver.disconnect();
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  return (
    <div className="brain-view">
      <canvas ref={canvasRef} className="brain-canvas" />
      {status !== 'ready' ? (
        <div className={`brain-status${status === 'error' ? ' brain-status-error' : ''}`}>{message}</div>
      ) : (
        <div className="brain-meta">{noteCount} notes</div>
      )}
      <a className="brain-back" href="/">
        ← display
      </a>
      <AmbientAssist />
    </div>
  );
}
