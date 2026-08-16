'use client';

import { useEffect, useState } from 'react';
import { Orb } from './Orb';
import { RollingText } from './RollingText';

/**
 * Burn-in-safe idle screen: the orb + clock drift to a new position every
 * minute; digits roll odometer-style as time changes. One-tap fullscreen for
 * TV browsers (harmless in kiosk mode, which is already fullscreen).
 */
export function IdleScreen() {
  const [now, setNow] = useState<Date | null>(null);
  const [drift, setDrift] = useState({ x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    setNow(new Date());
    const clock = setInterval(() => setNow(new Date()), 1_000);
    const drifter = setInterval(() => {
      setDrift({ x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 20 });
    }, 60_000);
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    onFsChange();
    return () => {
      clearInterval(clock);
      clearInterval(drifter);
      document.removeEventListener('fullscreenchange', onFsChange);
    };
  }, []);

  const time = now
    ? now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';

  return (
    <div className="idle-screen">
      <div
        className="idle-center"
        style={{ transform: `translate(${drift.x}vmin, ${drift.y}vmin)` }}
      >
        <Orb />
        <div className="idle-clock" suppressHydrationWarning>
          {time ? <RollingText text={time} /> : ' '}
        </div>
        <div className="idle-hint">
          listening
          <span className="idle-dots" aria-hidden="true">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </div>
      </div>
      {!fullscreen ? (
        <button
          className="idle-fullscreen"
          onClick={() => document.documentElement.requestFullscreen().catch(() => {})}
        >
          ⛶ fullscreen
        </button>
      ) : null}
    </div>
  );
}
