'use client';

import { useEffect, useRef, useState } from 'react';
import type { DisplayState, ServerMessage } from '../lib/protocol';

const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 10_000;

export function useDisplaySocket(): { state: DisplayState; connected: boolean } {
  const [state, setState] = useState<DisplayState>({ mode: 'idle' });
  const [connected, setConnected] = useState(false);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const applyState = (next: DisplayState) => {
      setState(next);
      if (expiryTimer.current) {
        clearTimeout(expiryTimer.current);
        expiryTimer.current = null;
      }
      // Belt-and-suspenders local TTL: even if the server's idle broadcast is
      // lost, the screen clears itself at expiresAt.
      if (next.mode === 'content' && next.expiresAt) {
        const ms = new Date(next.expiresAt).getTime() - Date.now();
        if (ms > 0) {
          expiryTimer.current = setTimeout(() => setState({ mode: 'idle' }), ms);
        } else {
          setState({ mode: 'idle' });
        }
      }
    };

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${window.location.host}/ws`);

      socket.onopen = () => {
        attempts = 0;
        setConnected(true);
      };
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          if (msg.type === 'state') applyState(msg.state);
          else if (msg.type === 'navigate' && window.location.pathname !== msg.path) {
            window.location.assign(msg.path);
          }
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(BACKOFF_START_MS * 2 ** attempts, BACKOFF_CAP_MS);
        attempts += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };

    const reconnectNow = () => {
      if (closed) return;
      if (socket && socket.readyState !== WebSocket.CLOSED) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      attempts = 0;
      connect();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reconnectNow();
    };

    connect();
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      closed = true;
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisibility);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (expiryTimer.current) clearTimeout(expiryTimer.current);
      socket?.close();
    };
  }, []);

  return { state, connected };
}
