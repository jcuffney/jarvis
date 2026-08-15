'use client';

import { useEffect } from 'react';
import { useDisplaySocket } from '../hooks/useDisplaySocket';
import { JarvisProse } from './JarvisProse';
import { IdleScreen } from './IdleScreen';
import { ConnectionBadge } from './ConnectionBadge';

const KNOWN_THEMES = new Set(['gym-dark', 'light']);
const DEFAULT_THEME = 'gym-dark';

export function DisplaySurface() {
  const { state, connected } = useDisplaySocket();

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
      <ConnectionBadge connected={connected} />
    </main>
  );
}
