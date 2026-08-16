'use client';

import { useEffect, useState } from 'react';

/**
 * Odometer-style text: when a character changes, the old one rolls up and out
 * while the new one rolls in from below. Cells are positional, so "8:59" →
 * "9:00" rolls three digits at once.
 */
function Cell({ ch }: { ch: string }) {
  const [current, setCurrent] = useState(ch);
  const [previous, setPrevious] = useState<string | null>(null);

  useEffect(() => {
    if (ch === current) return;
    setPrevious(current);
    setCurrent(ch);
    const timer = setTimeout(() => setPrevious(null), 500);
    return () => clearTimeout(timer);
  }, [ch, current]);

  // Bare spaces collapse to zero width inside the inline-block cell.
  const visible = (c: string) => (c === ' ' ? '\u00A0' : c);

  return (
    <span className="roll-cell">
      {previous !== null ? (
        <span key={`out-${previous}-${current}`} className="roll-out">
          {visible(previous)}
        </span>
      ) : null}
      <span key={`in-${current}`} className={previous !== null ? 'roll-in' : undefined}>
        {visible(current)}
      </span>
    </span>
  );
}

export function RollingText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className} role="text" aria-label={text}>
      {text.split('').map((ch, i) => (
        <Cell key={i} ch={ch} />
      ))}
    </span>
  );
}
