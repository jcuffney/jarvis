'use client';

/**
 * The assistant orb: layered CSS animations (breathing core, counter-rotating
 * sheens, drifting halo) colored entirely by theme tokens (--accent,
 * --orb-secondary) so it re-skins with data-theme like everything else.
 * No animation library — the layers run on the compositor.
 */
export function Orb() {
  return (
    <div className="orb" aria-hidden="true">
      <div className="orb-halo" />
      <div className="orb-core" />
      <div className="orb-sheen orb-sheen-a" />
      <div className="orb-sheen orb-sheen-b" />
      <div className="orb-highlight" />
    </div>
  );
}
