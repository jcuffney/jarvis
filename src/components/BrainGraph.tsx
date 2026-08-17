'use client';

import { useEffect, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { AmbientAssist } from './AmbientAssist';
import { NotePanel } from './NotePanel';
import { useDisplaySocket } from '../hooks/useDisplaySocket';

interface GraphNode extends SimulationNodeDatum {
  id: string;
  title: string;
  degree: number;
  path?: string;
  missing?: boolean;
  cluster: string;
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

/** A note's cluster is its parent folder — the vault's own organization
 * (projects, reference, family, …). Root notes fall into "vault". */
function clusterOf(path: string | undefined): string {
  if (!path) return '';
  const parts = path.split('/');
  const folder = parts.length >= 2 ? parts[parts.length - 2] : '';
  return (folder.replace(/^_/, '') || 'vault').toLowerCase();
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = hex.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let raw = m[1];
  if (raw.length === 3) raw = [...raw].map((c) => c + c).join('');
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/** Cluster colors: the theme accent's hue rotated around the wheel, so every
 * theme keeps its own character. Falls back to the accent for all clusters
 * when the token isn't parseable hex. */
function buildPalette(accent: string, clusters: string[]): Map<string, string> {
  const palette = new Map<string, string>();
  const base = hexToHsl(accent);
  clusters.forEach((cluster, i) => {
    if (!base) {
      palette.set(cluster, accent);
      return;
    }
    const hue = (base.h + (i * 360) / Math.max(clusters.length, 1)) % 360;
    palette.set(
      cluster,
      `hsl(${hue.toFixed(0)} ${(base.s * 100).toFixed(0)}% ${(base.l * 100).toFixed(0)}%)`,
    );
  });
  return palette;
}

/**
 * Obsidian-style force-directed map of the second brain: notes as glowing
 * nodes, links as edges. Canvas-rendered, colored from theme tokens (re-read
 * on data-theme changes), pan/zoom/hover, and the simulation never fully
 * freezes — the map drifts, alive by default.
 *
 * Organization: every note belongs to a cluster (its vault folder — a part
 * of life, a project, a goal). Clusters get their own hue, a watermark
 * label, and a gentle gravitational anchor spread across the screen, while
 * cross-cluster wikilinks keep the parts of the brain visibly interconnected.
 * Clicking a node opens the note itself in a side panel for auditing.
 */
export function BrainGraph() {
  // Keeps a socket open so producer-driven navigate messages reach this page.
  useDisplaySocket();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('mapping the brain…');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Selection lives inside the canvas effect (it owns highlight + pan); the
  // panel drives it from outside through this ref (wikilink hops, close).
  const selectRef = useRef<(id: string | null) => void>(() => {});

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
    let clusterNames: string[] = [];
    let palette = new Map<string, string>();
    let hovered: GraphNode | null = null;
    let neighborIds = new Set<string>();
    let selected: GraphNode | null = null;
    let selectedNeighborIds = new Set<string>();
    let panTarget: { x: number; y: number } | null = null;
    const view = { x: 0, y: 0, k: 1 };
    let userMoved = false;
    let dragging = false;
    let moved = false;
    let downAt = { x: 0, y: 0 };
    let lastPointer = { x: 0, y: 0 };

    const themeObserver = new MutationObserver(() => {
      colors = readTheme();
      palette = buildPalette(colors.accent, clusterNames);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    /** Frame the whole graph with a little breathing room. One-shot: never
     * fights a user who has panned or zoomed. */
    const fitView = () => {
      if (!nodes.length) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of nodes) {
        const pad = nodeRadius(node) + 24;
        minX = Math.min(minX, node.x! - pad);
        maxX = Math.max(maxX, node.x! + pad);
        minY = Math.min(minY, node.y! - pad);
        maxY = Math.max(maxY, node.y! + pad);
      }
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const k = Math.min(2.5, Math.max(0.2, 0.92 * Math.min(w / (maxX - minX), h / (maxY - minY))));
      view.k = k;
      view.x = (-(minX + maxX) / 2) * k;
      view.y = (-(minY + maxY) / 2) * k;
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!userMoved) fitView();
    };
    resize();
    window.addEventListener('resize', resize);

    const clusterColor = (cluster: string) => palette.get(cluster) ?? colors.accent;

    const draw = () => {
      // Ease toward a selected node; any manual pan/zoom cancels the glide.
      if (panTarget) {
        view.x += (panTarget.x - view.x) * 0.08;
        view.y += (panTarget.y - view.y) * 0.08;
        if (Math.hypot(panTarget.x - view.x, panTarget.y - view.y) < 0.5) panTarget = null;
      }

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2 + view.x, h / 2 + view.y);
      ctx.scale(view.k, view.k);

      // Cluster watermarks at the live centroids, behind everything.
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const cluster of clusterNames) {
        let cx = 0;
        let cy = 0;
        let count = 0;
        for (const node of nodes) {
          if (node.cluster !== cluster) continue;
          cx += node.x!;
          cy += node.y!;
          count += 1;
        }
        if (!count) continue;
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = clusterColor(cluster);
        ctx.font = `650 ${36 / view.k}px system-ui, sans-serif`;
        ctx.fillText(cluster, cx / count, cy / count);
      }

      // Hover wins the spotlight while it lasts; selection holds it otherwise.
      const focus = hovered ?? selected;
      const focusNeighbors = hovered ? neighborIds : selectedNeighborIds;
      const focused = focus !== null;
      ctx.lineWidth = 1 / view.k;
      for (const link of links) {
        const active =
          focused && (link.source === focus || link.target === focus);
        ctx.strokeStyle = active ? colors.accent : colors.border;
        ctx.globalAlpha = focused ? (active ? 0.9 : 0.12) : 0.45;
        ctx.beginPath();
        ctx.moveTo(link.source.x!, link.source.y!);
        ctx.lineTo(link.target.x!, link.target.y!);
        ctx.stroke();
      }

      for (const node of nodes) {
        const r = nodeRadius(node);
        const active = !focused || node === focus || focusNeighbors.has(node.id);
        ctx.globalAlpha = active ? 1 : 0.18;
        const fill = node.missing
          ? colors.muted
          : node === focus
            ? colors.secondary
            : clusterColor(node.cluster);
        ctx.fillStyle = fill;
        ctx.shadowColor = fill;
        ctx.shadowBlur = active ? r * 2.5 * view.k : 0;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (node === selected) {
          ctx.strokeStyle = colors.secondary;
          ctx.lineWidth = 1.5 / view.k;
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, r + 4 / view.k, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1 / view.k;
        }
      }

      // Labels: hubs always; everything else once zoomed in; focused on top.
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const node of nodes) {
        const spotlit = node === focus || focusNeighbors.has(node.id);
        const show = spotlit || node.degree >= 6 || view.k > 1.6;
        if (!show) continue;
        const r = nodeRadius(node);
        ctx.globalAlpha = focused && !spotlit ? 0.15 : 0.9;
        ctx.fillStyle = node === focus ? colors.text : colors.muted;
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

    const neighborsOf = (node: GraphNode): Set<string> => {
      const ids = new Set<string>();
      for (const link of links) {
        if (link.source === node) ids.add(link.target.id);
        if (link.target === node) ids.add(link.source.id);
      }
      return ids;
    };

    /** Select (or clear) a node: sticky highlight, glide it into the space
     * the note panel leaves visible, and mount the panel via React state. */
    const applySelect = (node: GraphNode | null) => {
      selected = node;
      selectedNeighborIds = node ? neighborsOf(node) : new Set();
      if (node) {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const portrait = h > w;
        const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        // Mirrors the .note-panel CSS: right sheet in landscape, bottom in portrait.
        const panelW = portrait ? 0 : Math.min(36 * rootPx, 0.46 * w);
        const panelH = portrait ? 0.55 * h : 0;
        const cx = (w - panelW) / 2;
        const cy = (h - panelH) / 2;
        panTarget = { x: cx - w / 2 - node.x! * view.k, y: cy - h / 2 - node.y! * view.k };
      } else {
        panTarget = null;
      }
      setSelectedId(node ? node.id : null);
    };

    // The panel's hooks land here: exact id first, then case-insensitive,
    // then path-style targets ([[folder/note]]) by basename.
    selectRef.current = (id) => {
      if (id === null) {
        applySelect(null);
        return;
      }
      const wanted = id.trim().toLowerCase();
      const base = wanted.split('/').pop() ?? wanted;
      const node =
        nodes.find((n) => n.id === id) ??
        nodes.find((n) => n.id.toLowerCase() === wanted) ??
        nodes.find((n) => n.id.toLowerCase() === base) ??
        null;
      if (node) applySelect(node);
    };

    const onPointerDown = (e: PointerEvent) => {
      dragging = true;
      moved = false;
      downAt = { x: e.clientX, y: e.clientY };
      lastPointer = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (dragging) {
        if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) {
          moved = true;
          userMoved = true;
          panTarget = null; // the user took the wheel
        }
        if (moved) {
          view.x += e.clientX - lastPointer.x;
          view.y += e.clientY - lastPointer.y;
        }
        lastPointer = { x: e.clientX, y: e.clientY };
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const node = findNode(e.clientX - rect.left, e.clientY - rect.top);
      if (node !== hovered) {
        hovered = node;
        neighborIds = node ? neighborsOf(node) : new Set();
        canvas.style.cursor = node ? 'pointer' : '';
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      const wasTap = dragging && !moved;
      dragging = false;
      if (!wasTap) return;
      const rect = canvas.getBoundingClientRect();
      applySelect(findNode(e.clientX - rect.left, e.clientY - rect.top));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userMoved = true;
      panTarget = null;
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

        // Assign clusters: real notes by folder, phantoms adopt the cluster
        // that references them (first linker wins).
        const byId = new Map(nodes.map((n) => [n.id, n]));
        for (const node of nodes) node.cluster = clusterOf(node.path);
        for (const link of data.links) {
          const source = byId.get(link.source as string);
          const target = byId.get(link.target as string);
          if (source && target && !target.cluster) target.cluster = source.cluster;
          if (source && target && !source.cluster) source.cluster = target.cluster;
        }
        for (const node of nodes) if (!node.cluster) node.cluster = 'vault';

        // One gravitational anchor per cluster, spread on an ellipse scaled
        // to the screen — parts of a life, laid out side by side.
        const sizes = new Map<string, number>();
        for (const node of nodes) sizes.set(node.cluster, (sizes.get(node.cluster) ?? 0) + 1);
        clusterNames = [...sizes.keys()].sort((a, b) => sizes.get(b)! - sizes.get(a)!);
        palette = buildPalette(colors.accent, clusterNames);
        const anchors = new Map<string, { x: number; y: number }>();
        const rx = Math.max(canvas.clientWidth, 320) * 0.3;
        const ry = Math.max(canvas.clientHeight, 240) * 0.3;
        clusterNames.forEach((cluster, i) => {
          if (clusterNames.length === 1) {
            anchors.set(cluster, { x: 0, y: 0 });
            return;
          }
          const angle = -Math.PI / 2 + (i * 2 * Math.PI) / clusterNames.length;
          anchors.set(cluster, { x: rx * Math.cos(angle), y: ry * Math.sin(angle) });
        });
        const anchorOf = (n: GraphNode) => anchors.get(n.cluster)!;
        // Links bind tightly inside a cluster and stay loose across clusters,
        // so parts of the brain hold their own space while the interconnections
        // stretch visibly between them.
        const sameCluster = (l: GraphLink) =>
          (l.source as GraphNode).cluster === (l.target as GraphNode).cluster;

        sim = forceSimulation(nodes)
          .force(
            'link',
            forceLink<GraphNode, GraphLink>(data.links)
              .id((n) => n.id)
              .distance((l) => (sameCluster(l) ? 52 : 150))
              .strength((l) => (sameCluster(l) ? 0.5 : 0.06)),
          )
          .force('charge', forceManyBody().strength(-180))
          .force('center', forceCenter(0, 0))
          .force('collide', forceCollide<GraphNode>().radius((n) => nodeRadius(n) + 3))
          // The cluster gravity that gives each part of life its own region.
          .force('cluster-x', forceX<GraphNode>((n) => anchorOf(n).x).strength(0.14))
          .force('cluster-y', forceY<GraphNode>((n) => anchorOf(n).y).strength(0.14))
          // Never let it die completely — the map keeps a faint drift.
          .alphaMin(0.001)
          .alphaTarget(0.008);
        links = data.links as { source: GraphNode; target: GraphNode }[];
        // Warm start: settle the layout before first paint, then frame it —
        // the map arrives organized instead of exploding into place.
        sim.tick(180);
        fitView();
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
      selectRef.current = () => {};
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
      ) : null}
      {selectedId ? (
        <NotePanel
          noteId={selectedId}
          onClose={() => selectRef.current(null)}
          onOpenNote={(id) => selectRef.current(id)}
        />
      ) : null}
      <AmbientAssist />
    </div>
  );
}
