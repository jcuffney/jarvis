// Wire contract shared by the server, the WS client, and any producer.

export type DisplayState =
  | { mode: 'idle' }
  | {
      mode: 'content';
      id: string;
      title?: string;
      /** Sanitized HTML — safe to inject verbatim. */
      html: string;
      theme?: string;
      createdAt: string;
      expiresAt?: string;
    };

/** Every server → client message carries the full state (replace-only, replay-safe). */
export type ServerMessage = { v: 1; type: 'state'; state: DisplayState };

export interface DisplayRequest {
  html: string;
  title?: string;
  durationSec?: number;
  theme?: string;
}
