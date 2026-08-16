'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface Message {
  role: 'user' | 'assistant';
  text: string;
}

// Minimal typings for the (webkit-prefixed) Web Speech API.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

function getRecognizer(): SpeechRecognitionLike | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

/**
 * Overlay that turns the display into a Home Assistant Assist interface.
 * Voice in via the browser's SpeechRecognition (mic button hidden when the
 * browser lacks it), text input always available; replies rendered in the
 * transcript and spoken with speechSynthesis. The HUD keeps running under it.
 */
export function AssistPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const conversationId = useRef<string | undefined>(undefined);
  const recognizer = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSpeechSupported(Boolean(getRecognizer()));
    inputRef.current?.focus();
    return () => {
      recognizer.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [messages, interim, busy]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    setMessages((m) => [...m, { role: 'user', text: trimmed }]);
    setDraft('');
    setInterim('');
    setBusy(true);
    try {
      const res = await fetch('/api/assist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: trimmed, conversationId: conversationId.current }),
      });
      const data = (await res.json()) as {
        speech?: string;
        conversationId?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      conversationId.current = data.conversationId ?? conversationId.current;
      const speech = data.speech || '…';
      setMessages((m) => [...m, { role: 'assistant', text: speech }]);
      if (window.speechSynthesis && data.speech) {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(data.speech));
      }
    } catch {
      setError('could not reach jarvis');
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleMic = useCallback(() => {
    if (listening) {
      recognizer.current?.stop();
      return;
    }
    const rec = getRecognizer();
    if (!rec) return;
    recognizer.current = rec;
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    let finalText = '';
    rec.onresult = (event) => {
      let interimText = '';
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      setInterim(interimText || finalText);
    };
    rec.onend = () => {
      setListening(false);
      setInterim('');
      if (finalText.trim()) void send(finalText);
    };
    rec.onerror = (event) => {
      setListening(false);
      setInterim('');
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        setError(`microphone: ${event.error}`);
      }
    };
    setError(null);
    setListening(true);
    rec.start();
  }, [listening, send]);

  return (
    <div className="assist-panel">
      <div className="assist-header">
        <span className="assist-title">Jarvis</span>
        <button className="assist-close" onClick={onClose} aria-label="Close assist">
          ✕
        </button>
      </div>
      <div className="assist-transcript" ref={transcriptRef}>
        {messages.length === 0 && !interim ? (
          <div className="assist-empty">
            {speechSupported ? 'Tap the mic or type to talk to the house.' : 'Type to talk to the house.'}
          </div>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={`assist-msg assist-msg-${m.role}`}>
            {m.text}
          </div>
        ))}
        {interim ? <div className="assist-msg assist-msg-user assist-msg-interim">{interim}</div> : null}
        {busy ? (
          <div className="assist-msg assist-msg-assistant assist-msg-busy">
            <span className="idle-dots">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </div>
        ) : null}
        {error ? <div className="assist-error">{error}</div> : null}
      </div>
      <form
        className="assist-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        {speechSupported ? (
          <button
            type="button"
            className={`assist-mic${listening ? ' assist-mic-live' : ''}`}
            onClick={toggleMic}
            aria-label={listening ? 'Stop listening' : 'Start listening'}
          >
            {listening ? '◉' : '🎙'}
          </button>
        ) : null}
        <input
          ref={inputRef}
          className="assist-text"
          value={draft}
          placeholder={listening ? 'listening…' : 'Ask Jarvis…'}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="assist-send" disabled={busy || draft.trim() === ''}>
          Send
        </button>
      </form>
    </div>
  );
}
