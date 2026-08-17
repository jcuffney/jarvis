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

/** Display state messages carry the full state (replace-only, replay-safe);
 * navigate messages steer every connected screen to a route. */
export type ServerMessage =
  | { v: 1; type: 'state'; state: DisplayState }
  | { v: 1; type: 'navigate'; path: string };

/** Routes producers may navigate screens to. */
export const NAVIGABLE_PATHS = ['/', '/brain', '/tasks'] as const;

export interface DisplayRequest {
  html: string;
  title?: string;
  durationSec?: number;
  theme?: string;
}
