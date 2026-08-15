'use client';

import { useMemo } from 'react';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function extractYouTubeId(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
  let id: string | null = null;
  if (url.hostname === 'youtu.be') {
    id = url.pathname.slice(1);
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else if (url.pathname.startsWith('/shorts/') || url.pathname.startsWith('/embed/')) {
    id = url.pathname.split('/')[2] ?? null;
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/**
 * Server-sanitized HTML in; YouTube anchors (the `<a data-embed>` convention,
 * or any plain YouTube link) become player iframes WE construct — the LLM can
 * never author an iframe. Original link stays visible under the player as a
 * fallback for videos that disallow embedding.
 */
function transformEmbeds(html: string): string {
  const doc = new DOMParser().parseFromString(`<article>${html}</article>`, 'text/html');
  const root = doc.body.firstElementChild!;
  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    const href = anchor.getAttribute('href') ?? '';
    const id = extractYouTubeId(href);
    if (!id) continue;

    const figure = doc.createElement('figure');
    figure.className = 'jarvis-embed';

    const iframe = doc.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&rel=0`;
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    iframe.setAttribute('title', anchor.textContent ?? 'video');

    const caption = doc.createElement('figcaption');
    const link = doc.createElement('a');
    link.href = href;
    link.textContent = anchor.textContent || href;
    caption.appendChild(link);

    figure.appendChild(iframe);
    figure.appendChild(caption);
    anchor.replaceWith(figure);
  }
  return root.innerHTML;
}

export function JarvisProse({ html }: { html: string }) {
  const transformed = useMemo(
    () => (typeof window === 'undefined' ? html : transformEmbeds(html)),
    [html],
  );
  // Safe: html was sanitized server-side at POST time, and the only iframes
  // present are the ones transformEmbeds constructed above.
  return <article className="jarvis-prose" dangerouslySetInnerHTML={{ __html: transformed }} />;
}
