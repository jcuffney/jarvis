'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { JarvisProse } from './JarvisProse';

interface NoteLink {
  id: string;
  missing?: boolean;
}

interface NoteData {
  id: string;
  title: string;
  path?: string;
  modifiedAt?: string;
  html?: string;
  frontmatter?: string;
  missing?: boolean;
  outgoing?: NoteLink[];
  incoming?: NoteLink[];
}

function LinkChips({
  heading,
  links,
  onOpenNote,
}: {
  heading: string;
  links: NoteLink[] | undefined;
  onOpenNote: (id: string) => void;
}) {
  if (!links?.length) return null;
  return (
    <section className="note-links">
      <h3 className="note-links-heading">{heading}</h3>
      <div className="note-link-chips">
        {links.map((link) => (
          <button
            key={link.id}
            type="button"
            className={`chip note-link${link.missing ? ' note-link-missing' : ''}`}
            onClick={() => onOpenNote(link.id)}
          >
            {link.id}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * The audit surface for one node of the brain map: the note's rendered
 * content, its file path and freshness, and every link in and out — each a
 * hop to the next note. Phantom nodes get a "doesn't exist yet" state that
 * shows who references them.
 */
export function NotePanel({
  noteId,
  onClose,
  onOpenNote,
}: {
  noteId: string;
  onClose: () => void;
  onOpenNote: (id: string) => void;
}) {
  const [note, setNote] = useState<NoteData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setNote(null);
    setError(null);
    fetch(`/api/brain/note?id=${encodeURIComponent(noteId)}`, { signal: controller.signal })
      .then(async (res) => {
        const data = (await res.json()) as NoteData & { error?: string };
        if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
        setNote(data);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [noteId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Wikilink anchors hop within the panel; external links open a new tab so
  // a kiosk screen never navigates away.
  const onBodyClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const target = anchor.getAttribute('data-note');
    if (target) {
      e.preventDefault();
      onOpenNote(target);
      return;
    }
    const href = anchor.getAttribute('href');
    if (href && /^https?:/i.test(href)) {
      e.preventDefault();
      window.open(href, '_blank', 'noopener');
    }
  };

  const modified = note?.modifiedAt
    ? new Date(note.modifiedAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <aside className="note-panel" role="dialog" aria-label={`note: ${noteId}`}>
      <header className="note-panel-head">
        <div>
          <h2 className="note-panel-title">{note?.title ?? noteId}</h2>
          <div className="note-panel-meta">
            {note?.missing
              ? 'not written yet'
              : [note?.path, modified ? `updated ${modified}` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <button type="button" className="chip note-panel-close" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="note-panel-body" onClick={onBodyClick}>
        {error ? <p className="note-panel-status note-panel-error">{error}</p> : null}
        {!note && !error ? <p className="note-panel-status">opening the note…</p> : null}
        {note?.missing ? (
          <p className="note-panel-status">
            This note doesn&apos;t exist yet — the vault links to it, but nothing has been
            written. The references below are where it&apos;s expected.
          </p>
        ) : null}
        {note?.frontmatter ? (
          <details className="note-frontmatter">
            <summary>frontmatter</summary>
            <pre>{note.frontmatter}</pre>
          </details>
        ) : null}
        {note?.html ? <JarvisProse html={note.html} /> : null}
        <LinkChips heading="links to" links={note?.outgoing} onOpenNote={onOpenNote} />
        <LinkChips heading="linked from" links={note?.incoming} onOpenNote={onOpenNote} />
      </div>
    </aside>
  );
}
