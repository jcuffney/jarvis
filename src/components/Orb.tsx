'use client';

/**
 * The assistant orb, Age-of-Ultron JARVIS style: a hollow wireframe sphere —
 * tilted great-circle rings spinning gyroscope-fashion (CSS 3D transforms)
 * around a glowing core, with orbiting node dots. Colored entirely by theme
 * tokens (--accent, --orb-secondary) so it re-skins with data-theme.
 */
export function Orb() {
  return (
    <div className="orb" aria-hidden="true">
      <div className="orb-halo" />
      <div className="orb-gyro">
        <div className="orb-ring orb-ring-1" />
        <div className="orb-ring orb-ring-2" />
        <div className="orb-ring orb-ring-3" />
        <div className="orb-ring orb-ring-4" />
        <div className="orb-ring orb-ring-eq" />
        <div className="orb-ring orb-ring-eq2" />
      </div>
      {/* Outside the gyro so it faces the viewer instead of tilting into an ellipse. */}
      <div className="orb-core" />
    </div>
  );
}
