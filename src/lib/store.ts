import { randomUUID } from 'node:crypto';
import type { DisplayState, DisplayRequest } from './protocol';

type Listener = (state: DisplayState) => void;

const IDLE: DisplayState = { mode: 'idle' };

/**
 * Single source of truth for what's on screen. Lives only in server.ts's
 * module graph — never import this from Next route handlers, which get a
 * separate bundle (and would see a second, empty store).
 */
class DisplayStore {
  private state: DisplayState = IDLE;
  private listeners = new Set<Listener>();
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;

  get(): DisplayState {
    return this.state;
  }

  setContent(input: DisplayRequest & { html: string }): DisplayState {
    this.cancelTtl();
    const expiresAt = input.durationSec
      ? new Date(Date.now() + input.durationSec * 1000).toISOString()
      : undefined;
    this.state = {
      mode: 'content',
      id: randomUUID(),
      html: input.html,
      ...(input.title ? { title: input.title } : {}),
      ...(input.theme ? { theme: input.theme } : {}),
      createdAt: new Date().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
    };
    if (input.durationSec) {
      this.ttlTimer = setTimeout(() => this.clear(), input.durationSec * 1000);
    }
    this.broadcast();
    return this.state;
  }

  clear(): DisplayState {
    this.cancelTtl();
    this.state = IDLE;
    this.broadcast();
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private cancelTtl() {
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
  }

  private broadcast() {
    for (const fn of this.listeners) fn(this.state);
  }
}

export const store = new DisplayStore();
