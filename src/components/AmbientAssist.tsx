'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { isDisplayMode } from '../lib/displayMode';

// Minimal typings for the (webkit-prefixed) Web Speech API.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

function makeRecognizer(): SpeechRecognitionLike | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

interface Caption {
  role: 'user' | 'assistant' | 'system';
  text: string;
  id: number;
}

type MicState = 'listening' | 'muted' | 'unavailable';

const CAPTION_TTL_MS = 9_000;
const NAV_BRAIN = /\b(?:show|open|go to|display|pull up)\b.*\bbrain\b/i;
const NAV_HOME =
  /\bgo (?:back|home)\b|\btake me (?:back|home)\b|\b(?:show|open|go to|back to|return to|display)\b.*\b(?:display|dashboard|home|hud|main)\b/i;

/**
 * The ambient voice layer: always listening on devices with a microphone
 * (nothing to click — the TV/kiosk simply has no mic and stays passive),
 * closed-caption-style transcript along the bottom, replies spoken through
 * the Wyoming Jarvis voice (/api/tts; browser speechSynthesis fallback).
 * Voice nav: "show the brain map" / "back to the display".
 */
export function AmbientAssist() {
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [interim, setInterim] = useState('');
  // Checked in state (not at module level) so SSR and hydration render the
  // same empty shell; the effect below then keeps the whole layer inert.
  const [displayOnly, setDisplayOnly] = useState(false);
  const [mic, setMic] = useState<MicState>('unavailable');
  const [busy, setBusy] = useState(false);
  const conversationId = useRef<string | undefined>(undefined);
  const recognizer = useRef<SpeechRecognitionLike | null>(null);
  const mutedRef = useRef(false);
  // Half-duplex: recognition is suspended while Jarvis speaks, or the mic
  // hears the reply and feeds it back in as input (no AEC in the browser).
  const speakingRef = useRef(false);
  const captionSeq = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const pushCaption = useCallback((role: Caption['role'], text: string) => {
    const id = (captionSeq.current += 1);
    setCaptions((c) => [...c.slice(-3), { role, text, id }]);
    setTimeout(() => setCaptions((c) => c.filter((entry) => entry.id !== id)), CAPTION_TTL_MS);
  }, []);

  const pendingUrl = useRef<string | null>(null);

  // One persistent element for ALL replies: browsers (iOS especially) unlock
  // audio per-element on user gesture, so a fresh `new Audio()` per reply
  // gets autoplay-blocked forever on an untouched page — silent captions.
  const getAudioEl = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = 'auto';
    }
    return audioRef.current;
  }, []);

  const speak = useCallback(
    async (text: string) => {
      const gate = () => {
        speakingRef.current = true;
        recognizer.current?.abort(); // drop any audio already in flight
        setInterim('');
      };
      const doneSpeaking = () => {
        if (!speakingRef.current) return;
        speakingRef.current = false;
        // Small tail so room reverb of the reply isn't re-captured.
        setTimeout(() => {
          if (!mutedRef.current) {
            try {
              recognizer.current?.start();
            } catch {
              /* already started */
            }
          }
        }, 400);
      };
      gate();
      const audio = getAudioEl();
      let url: string;
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`tts ${res.status}`);
        url = URL.createObjectURL(await res.blob());
      } catch {
        // Wyoming unavailable — browser voice fallback.
        if (window.speechSynthesis) {
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.onend = doneSpeaking;
          utterance.onerror = doneSpeaking;
          window.speechSynthesis.speak(utterance);
        } else {
          doneSpeaking();
        }
        return;
      }
      audio.pause();
      audio.src = url;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        doneSpeaking();
      };
      audio.onerror = doneSpeaking;
      try {
        await audio.play();
      } catch {
        // Autoplay blocked: browsers require one interaction before sound.
        // Park the reply and release it on the next tap/keypress — playing
        // through the persistent element keeps it unlocked from then on.
        doneSpeaking();
        if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
        pendingUrl.current = url;
        pushCaption('system', 'tap anywhere to enable audio');
        const unlock = () => {
          const parked = pendingUrl.current;
          pendingUrl.current = null;
          if (!parked) return;
          gate(); // suspend the mic again while the parked reply plays
          audio.src = parked;
          void audio.play().catch(doneSpeaking);
        };
        window.addEventListener('pointerdown', unlock, { once: true });
        window.addEventListener('keydown', unlock, { once: true });
      }
    },
    [getAudioEl, pushCaption],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (NAV_BRAIN.test(trimmed)) {
        pushCaption('system', '→ brain map');
        window.location.assign('/brain');
        return;
      }
      if (NAV_HOME.test(trimmed)) {
        pushCaption('system', '→ display');
        window.location.assign('/');
        return;
      }

      pushCaption('user', trimmed);
      setBusy(true);
      // Lets the rest of the page react while Jarvis reasons (the orb pulses).
      document.documentElement.dataset.assist = 'busy';
      try {
        const res = await fetch('/api/assist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: trimmed, conversationId: conversationId.current }),
        });
        const data = (await res.json()) as {
          speech?: string;
          responseType?: string;
          conversationId?: string;
          error?: string;
        };
        if (!res.ok) {
          pushCaption('system', data.error ?? `assist error (${res.status})`);
          return;
        }
        conversationId.current = data.conversationId ?? conversationId.current;
        if (data.speech) {
          pushCaption('assistant', data.speech);
          void speak(data.speech);
        }
      } catch {
        pushCaption('system', 'could not reach jarvis');
      } finally {
        setBusy(false);
        delete document.documentElement.dataset.assist;
      }
    },
    [pushCaption, speak],
  );

  const startListening = useCallback(() => {
    const rec = makeRecognizer();
    if (!rec) {
      setMic('unavailable');
      return;
    }
    recognizer.current = rec;
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      if (speakingRef.current) return; // Jarvis is talking — ignore echoes
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) {
          setInterim('');
          const finalText = result[0].transcript.trim();
          // Two words minimum keeps coughs and "um" out of the pipeline.
          if (finalText.split(/\s+/).length >= 2) void send(finalText);
        } else {
          interimText += result[0].transcript;
        }
      }
      if (interimText) setInterim(interimText);
    };
    rec.onend = () => {
      setInterim('');
      // Continuous recognition times out on silence — keep it alive, but not
      // while Jarvis speaks (doneSpeaking restarts it afterwards).
      if (!mutedRef.current && !speakingRef.current) {
        setTimeout(() => {
          if (!mutedRef.current && !speakingRef.current) {
            try {
              recognizer.current?.start();
            } catch {
              /* already started */
            }
          }
        }, 400);
      }
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        mutedRef.current = true;
        setMic('unavailable');
      }
      // 'no-speech' / 'aborted' / 'network' fall through to onend's restart.
    };
    try {
      rec.start();
      setMic('listening');
    } catch {
      setMic('unavailable');
    }
  }, [send]);

  useEffect(() => {
    if (isDisplayMode()) {
      setDisplayOnly(true);
      return;
    }
    if (window.localStorage.getItem('jarvis-mic') === 'off') {
      mutedRef.current = true;
      setMic(makeRecognizer() ? 'muted' : 'unavailable');
      return;
    }
    startListening();
    return () => {
      mutedRef.current = true;
      recognizer.current?.abort();
      audioRef.current?.pause();
      window.speechSynthesis?.cancel();
      delete document.documentElement.dataset.assist;
    };
  }, [startListening]);

  const toggleMic = () => {
    if (mic === 'listening') {
      mutedRef.current = true;
      window.localStorage.setItem('jarvis-mic', 'off');
      recognizer.current?.abort();
      setMic('muted');
      setInterim('');
    } else if (mic === 'muted') {
      mutedRef.current = false;
      window.localStorage.setItem('jarvis-mic', 'on');
      startListening();
    }
  };

  if (displayOnly) return null;

  return (
    <>
      <div className="captions" aria-live="polite">
        {captions.map((caption) => (
          <div key={caption.id} className={`caption caption-${caption.role}`}>
            {caption.role === 'assistant' ? <span className="caption-tag">JARVIS</span> : null}
            {caption.text}
          </div>
        ))}
        {interim ? <div className="caption caption-user caption-interim">{interim}</div> : null}
        {busy ? (
          <div className="caption caption-busy">
            <span className="caption-tag">JARVIS</span>
            thinking
            <span className="idle-dots" aria-hidden="true">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </div>
        ) : null}
      </div>
      <div className="corner-left">
        {mic !== 'unavailable' ? (
          <button
            className={`chip mic-chip${mic === 'listening' ? ' mic-chip-live' : ''}`}
            onClick={toggleMic}
            aria-label={mic === 'listening' ? 'Mute microphone' : 'Unmute microphone'}
          >
            {mic === 'listening' ? '🎙 listening' : '🎙 muted'}
          </button>
        ) : null}
      </div>
    </>
  );
}
