'use client';

/**
 * The assistant orb, movie-JARVIS style: a wireframe globe — longitude
 * great-circles plus latitude rings (true 3D lattice via CSS transforms,
 * latitude geometry in container-query units) precessing around a glowing
 * core. Colored entirely by theme tokens so data-theme re-skins it
 * (black/blue primary, black/yellow "ultron" test theme).
 */
const LONGITUDES = [0, 30, 60, 90, 120, 150];

export function Orb() {
  return (
    <div className="orb" aria-hidden="true">
      <div className="orb-halo" />
      <div className="orb-gyro">
        {LONGITUDES.map((deg) => (
          <div
            key={deg}
            className="orb-ring orb-long"
            style={{ transform: `rotateY(${deg}deg)` }}
          />
        ))}
        <div className="orb-ring orb-lat orb-lat-eq" />
        <div className="orb-ring orb-lat orb-lat-n" />
        <div className="orb-ring orb-lat orb-lat-s" />
      </div>
      {/* Outside the gyro so it faces the viewer instead of tilting into an ellipse. */}
      <div className="orb-core" />
    </div>
  );
}
