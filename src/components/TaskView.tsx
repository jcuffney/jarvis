'use client';

import { useEffect, useRef, useState } from 'react';
import { statusDot } from './TaskBoard';

interface TaskMeta {
  id: string;
  repo: string;
  prompt: string;
  status: string;
  branch?: string | null;
  prUrl?: string | null;
  result?: string | null;
  error?: string | null;
}

/** One rendered transcript entry, distilled from the stream-json events. */
interface Entry {
  id: number;
  kind: 'text' | 'tool' | 'result';
  label?: string;
  text: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: { command?: string; file_path?: string; description?: string };
}

/** "Bash {command}" / "Edit {file_path}" → a one-line activity label. */
function toolLabel(name: string, input: ContentBlock['input']): string {
  if (name === 'Bash' && input?.command) return `$ ${input.command}`;
  const file = input?.file_path?.replace(/^.*\/repos\/[^/]+\//, '');
  if ((name === 'Edit' || name === 'Write' || name === 'Read') && file) {
    return `${name.toLowerCase()} ${file}`;
  }
  return input?.description ?? name.toLowerCase();
}

const TERMINAL = ['done', 'failed', 'timeout', 'cancelled'];

/**
 * Live transcript of one devbox Claude run: assistant reasoning as prose,
 * tool calls as terminal-style activity lines, then the final summary. Tails
 * /api/tasks/:id/stream (which replays the whole transcript first, so
 * finished runs render identically).
 */
export function TaskView({ taskId }: { taskId: string }) {
  const [meta, setMeta] = useState<TaskMeta | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const seq = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  useEffect(() => {
    fetch(`/api/tasks/${taskId}`)
      .then(async (res) => {
        const data = (await res.json()) as TaskMeta & { error?: string };
        if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
        setMeta(data);
      })
      .catch((err: Error) => setError(err.message));
  }, [taskId]);

  useEffect(() => {
    const controller = new AbortController();
    const push = (kind: Entry['kind'], text: string, label?: string) => {
      const id = (seq.current += 1);
      setEntries((all) => {
        // The result event repeats the final assistant text — restyle it
        // into the summary block instead of rendering it twice.
        const last = all[all.length - 1];
        if (kind === 'result' && last?.kind === 'text' && last.text.trim() === text.trim()) {
          return [...all.slice(0, -1), { ...last, kind: 'result' }];
        }
        return [...all, { id, kind, text, label }];
      });
    };
    (async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/stream`, { signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let newline;
          while ((newline = buffered.indexOf('\n')) !== -1) {
            const raw = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (!raw) continue;
            let ev: {
              type?: string;
              status?: string;
              prUrl?: string | null;
              result?: string | null;
              message?: { content?: ContentBlock[] };
            };
            try {
              ev = JSON.parse(raw);
            } catch {
              continue;
            }
            if (ev.type === 'assistant') {
              for (const block of ev.message?.content ?? []) {
                if (block.type === 'text' && block.text?.trim()) push('text', block.text);
                else if (block.type === 'tool_use' && block.name) {
                  push('tool', toolLabel(block.name, block.input));
                }
              }
            } else if (ev.type === 'result' && ev.result) {
              push('result', ev.result);
            } else if (ev.type === 'task-status') {
              setMeta((m) =>
                m
                  ? { ...m, status: ev.status ?? m.status, prUrl: ev.prUrl ?? m.prUrl }
                  : m,
              );
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) setError((err as Error).message);
      } finally {
        setLive(false);
      }
    })();
    return () => controller.abort();
  }, [taskId]);

  // Follow the tail unless the viewer scrolled up to read something.
  useEffect(() => {
    if (followRef.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [entries]);
  useEffect(() => {
    const onScroll = () => {
      followRef.current =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const cancel = async () => {
    await fetch(`/api/tasks/${taskId}/cancel`, { method: 'POST' }).catch(() => undefined);
  };

  const running = meta ? !TERMINAL.includes(meta.status) : false;

  return (
    <main className="task-page">
      <header className="task-page-head">
        <h1 className="display-title">Claude task</h1>
        <a className="chip" href="/tasks">
          ← tasks
        </a>
      </header>

      {meta ? (
        <section className="task-meta">
          <p className="task-meta-prompt">{meta.prompt}</p>
          <div className="task-meta-row">
            <span className={statusDot(meta.status)} aria-hidden="true" />
            <span>
              {meta.repo} · {meta.status}
              {meta.branch ? ` · ${meta.branch}` : ''}
            </span>
            {meta.prUrl ? (
              <a className="chip" href={meta.prUrl} target="_blank" rel="noreferrer">
                view PR ↗
              </a>
            ) : null}
            {running ? (
              <button type="button" className="chip" onClick={() => void cancel()}>
                cancel
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {error ? <p className="task-status-line task-error">{error}</p> : null}

      <section className="task-transcript">
        {entries.map((entry) =>
          entry.kind === 'tool' ? (
            <div key={entry.id} className="task-tool">
              {entry.text}
            </div>
          ) : (
            <div key={entry.id} className={`task-text${entry.kind === 'result' ? ' task-result' : ''}`}>
              {entry.text}
            </div>
          ),
        )}
        {live && entries.length === 0 && !error ? (
          <p className="task-status-line">waiting for the run to start…</p>
        ) : null}
        {live ? (
          <p className="task-status-line task-live">
            live
            <span className="idle-dots" aria-hidden="true">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </p>
        ) : null}
        <div ref={bottomRef} />
      </section>
    </main>
  );
}
