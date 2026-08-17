/**
 * `?mode=display` marks a screen as render-only: the ambient assist layer
 * never mounts, so no SpeechRecognition, no mic chip, no TTS — regardless of
 * what mic hardware the device grows later. The gym TV kiosk pins this in its
 * start URL; voice lives on the satellite, the TV only renders what producers
 * push. Purely URL-driven (nothing sticky): drop the param and the screen is
 * interactive again on the next load.
 */
export function isDisplayMode(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('mode') === 'display';
}
