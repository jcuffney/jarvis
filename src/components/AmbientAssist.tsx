'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
const NAV_HOME = /\b(?:show|open|go to|back to|display)\b.*\b(?:display|dashboard|home|hud)\b/i;

/**
 * The ambient voice layer: always listening on devices with a microphone
 * (nothing to click — the TV/kiosk simply has no mic and stays passive),
 * closed-caption-style transcript along the bottom, replies spoken through
 * the Wyoming Jarvis voice (/api/tts; browser speechSynthesis fallback).
 * Voice nav: "show the brain map" / "back to the display".
 */
export function AmbientAssist({ children }: { children?: React.ReactNode }) {
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [interim, setInterim] = useState('');
  const [mic, setMic] = useState<MicState>('unavailable');
  const [busy, setBusy] = useState(false);
  const conversationId = useRef<string | undefined>(undefined);
  const recognizer = useRef<SpeechRecognitionLike | null>(null);
  const mutedRef = useRef(false);
  const captionSeq = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const pushCaption = useCallback((role: Caption['role'], text: string) => {
    const id = (captionSeq.current += 1);
    setCaptions((c) => [...c.slice(-3), { role, text, id }]);
    setTimeout(() => setCaptions((c) => c.filter((entry) => entry.id !== id)), CAPTION_TTL_MS);
  }, []);

  const pendingAudio = useRef<HTMLAudioElement | null>(null);

  const speak = useCallback(
    async (text: string) => {
      let audio: HTMLAudioElement | null = null;
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`tts ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        audioRef.current?.pause();
        audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => URL.revokeObjectURL(url);
      } catch {
        // Wyoming unavailable — browser voice fallback.
        if (window.speechSynthesis) {
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
        }
        return;
      }
      try {
        await audio.play();
      } catch {
        // Autoplay blocked: browsers require one interaction before sound.
        // Park the reply and release it on the next tap/keypress.
        pendingAudio.current = audio;
        pushCaption('system', 'tap anywhere to enable audio');
        const unlock = () => {
          const parked = pendingAudio.current;
          pendingAudio.current = null;
          void parked?.play().catch(() => {});
        };
        window.addEventListener('pointerdown', unlock, { once: true });
        window.addEventListener('keydown', unlock, { once: true });
      }
    },
    [pushCaption],
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
      // Continuous recognition times out on silence — keep it alive.
      if (!mutedRef.current) {
        setTimeout(() => {
          if (!mutedRef.current) {
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
          <div className="caption caption-assistant caption-busy">
            <span className="idle-dots">
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
        {children}
      </div>
    </>
  );
}
