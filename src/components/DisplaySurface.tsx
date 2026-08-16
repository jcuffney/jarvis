'use client';

import { useEffect, useState } from 'react';
import { useDisplaySocket } from '../hooks/useDisplaySocket';
import { JarvisProse } from './JarvisProse';
import { IdleScreen } from './IdleScreen';
import { ConnectionBadge } from './ConnectionBadge';
import { AssistPanel } from './AssistPanel';

const KNOWN_THEMES = new Set(['gym-dark', 'ultron', 'light']);
const DEFAULT_THEME = 'gym-dark';

export function DisplaySurface() {
  const { state, connected } = useDisplaySocket();
  const [assistOpen, setAssistOpen] = useState(false);

  useEffect(() => {
    const requested = state.mode === 'content' ? state.theme : undefined;
    const stored = window.localStorage.getItem('jarvis-theme') ?? undefined;
    const theme = [requested, stored, DEFAULT_THEME].find((t) => t && KNOWN_THEMES.has(t))!;
    document.documentElement.dataset.theme = theme;
  }, [state]);

  return (
    <main className="display-surface">
      {state.mode === 'idle' ? (
        <IdleScreen />
      ) : (
        <section className="display-content" key={state.id}>
          {state.title ? <header className="display-title">{state.title}</header> : null}
          <JarvisProse html={state.html} />
        </section>
      )}
      {assistOpen ? (
        <AssistPanel onClose={() => setAssistOpen(false)} />
      ) : (
        <>
          <button
            className="assist-toggle"
            onClick={() => setAssistOpen(true)}
            aria-label="Talk to Jarvis"
          >
            ✦ assist
          </button>
          <a className="brain-toggle" href="/brain" aria-label="Open brain map">
            ◈ brain
          </a>
        </>
      )}
      <ConnectionBadge connected={connected} />
    </main>
  );
}
