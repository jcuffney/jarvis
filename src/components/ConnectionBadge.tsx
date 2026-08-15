'use client';

export function ConnectionBadge({ connected }: { connected: boolean }) {
  if (connected) return null;
  return <div className="connection-badge">reconnecting…</div>;
}
