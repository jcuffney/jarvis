'use client';

import { useCallback, useEffect, useState } from 'react';

export interface TaskSummary {
  id: string;
  repo: string;
  status: string;
  prompt: string;
  branch?: string | null;
  prUrl?: string | null;
  createdAt: number;
  finishedAt?: number | null;
}

const REPOS = ['jarvis', 'homelab', 'devbox'];
const POLL_MS = 5_000;

export function statusDot(status: string): string {
  if (status === 'running') return 'task-dot task-dot-running';
  if (status === 'done') return 'task-dot task-dot-done';
  if (status === 'queued') return 'task-dot task-dot-queued';
  return 'task-dot task-dot-failed'; // failed | timeout | cancelled
}

function when(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Dispatch surface for the devbox Claude Code runner: a prompt box, the repo
 * sandbox to aim it at, and the run history. Submitting hops straight to the
 * live transcript view.
 */
export function TaskBoard() {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [repo, setRepo] = useState(REPOS[0]);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks');
      const data = (await res.json()) as { tasks?: TaskSummary[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      setTasks(data.tasks ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const submit = async () => {
    const text = prompt.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text, repo }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error ?? `submit failed (${res.status})`);
      window.location.assign(`/tasks/${data.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <main className="task-page">
      <header className="task-page-head">
        <h1 className="display-title">Claude tasks</h1>
        <a className="chip" href="/">
          ← display
        </a>
      </header>

      <section className="task-compose">
        <textarea
          className="task-prompt"
          value={prompt}
          placeholder="What should Claude do on the devbox?"
          rows={3}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        <div className="task-compose-row">
          <div className="task-repo-picker">
            {REPOS.map((name) => (
              <button
                key={name}
                type="button"
                className={`chip${repo === name ? ' chip-active' : ''}`}
                onClick={() => setRepo(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <button type="button" className="chip task-submit" onClick={() => void submit()} disabled={submitting}>
            {submitting ? 'dispatching…' : 'run task'}
          </button>
        </div>
      </section>

      {error ? <p className="task-status-line task-error">{error}</p> : null}
      {!tasks && !error ? <p className="task-status-line">loading runs…</p> : null}
      {tasks?.length === 0 ? <p className="task-status-line">no runs yet</p> : null}

      <ul className="task-list">
        {tasks?.map((task) => (
          <li key={task.id}>
            <a className="task-row" href={`/tasks/${task.id}`}>
              <span className={statusDot(task.status)} aria-hidden="true" />
              <span className="task-row-main">
                <span className="task-row-prompt">{task.prompt}</span>
                <span className="task-row-meta">
                  {task.repo} · {task.status} · {when(task.createdAt)}
                  {task.prUrl ? ' · PR ↗' : ''}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
