import WebSocket from 'ws';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendTranscript, memoryEnabled } from './memory';

/**
 * Captures Assist conversations that never touch this process — satellites,
 * the phone app, anything driving HA's pipelines directly. HA emits no bus
 * event for pipeline runs (verified 2026-08-17: the run events go only to
 * the initiating WebSocket subscriber), so the one hook available is the
 * pipeline debug store: a ~10-run ring buffer per pipeline, queryable over
 * the WS API. We poll it and append anything we didn't initiate ourselves
 * to the short-term memory store.
 *
 * Dedup against our own runs: everything this server initiates (WS pipeline
 * or REST fallback) is registered via markLocalConversation() and skipped
 * here — otherwise every TV utterance would be captured twice. Runs are only
 * harvested once they're SETTLE_MS old, so the local registration always
 * wins the race.
 */

const SETTLE_MS = 90_000;
const CURSOR_KEEP_IDS = 200;
const LOCAL_CONVERSATIONS_MAX = 200;

const localConversations = new Set<string>();

export function markLocalConversation(id: string | undefined): void {
  if (!id) return;
  localConversations.add(id);
  if (localConversations.size > LOCAL_CONVERSATIONS_MAX) {
    const first = localConversations.values().next().value;
    if (first) localConversations.delete(first);
  }
}

interface Cursor {
  since: string; // ISO timestamp: runs at or before this are already handled
  seenRunIds: string[];
}

interface HaMessage {
  id?: number;
  type?: string;
  success?: boolean;
  result?: unknown;
  error?: { message?: string };
}

interface DebugRun {
  pipeline_run_id?: string;
  timestamp?: string;
}

interface DebugEvent {
  type?: string;
  data?: {
    conversation_id?: string;
    intent_input?: string;
    stt_output?: { text?: string };
    intent_output?: {
      conversation_id?: string;
      response?: { speech?: { plain?: { speech?: string } } };
    };
  };
}

function loadCursor(file: string): Cursor {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as Cursor;
    if (typeof c.since === 'string' && Array.isArray(c.seenRunIds)) return c;
  } catch {
    // first run or corrupt state — start from now, never backfill (old runs
    // can't be deduped against a process that no longer remembers its own)
  }
  return { since: new Date().toISOString(), seenRunIds: [] };
}

/** One authenticated WS session per poll tick — cheap on the LAN. */
function haCall(haUrl: string, token: string, requests: Record<string, unknown>[]): Promise<HaMessage[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${haUrl.replace(/^http/, 'ws')}/api/websocket`);
    const results: HaMessage[] = [];
    let sent = 0;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('pipeline capture poll timed out'));
    }, 30_000);
    ws.on('message', (raw) => {
      let msg: HaMessage;
      try {
        msg = JSON.parse(String(raw)) as HaMessage;
      } catch {
        return;
      }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      } else if (msg.type === 'auth_invalid') {
        clearTimeout(timer);
        ws.terminate();
        reject(new Error('home assistant rejected the token'));
      } else if (msg.type === 'auth_ok') {
        for (const req of requests) {
          sent += 1;
          ws.send(JSON.stringify({ id: sent, ...req }));
        }
      } else if (msg.type === 'result') {
        results.push(msg);
        if (results.length === requests.length) {
          clearTimeout(timer);
          ws.close();
          resolve(results.sort((a, b) => (a.id ?? 0) - (b.id ?? 0)));
        }
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function extractRun(events: DebugEvent[]): { user: string; assistant: string; conversationId?: string } | null {
  let user = '';
  let assistant = '';
  let conversationId: string | undefined;
  let complete = false;
  for (const ev of events) {
    const d = ev.data ?? {};
    if (ev.type === 'run-start') conversationId = d.conversation_id ?? conversationId;
    if (ev.type === 'stt-end' && d.stt_output?.text) user = d.stt_output.text;
    if (ev.type === 'intent-start' && d.intent_input && !user) user = d.intent_input;
    if (ev.type === 'intent-end') {
      complete = true;
      assistant = d.intent_output?.response?.speech?.plain?.speech ?? '';
      conversationId = d.intent_output?.conversation_id ?? conversationId;
    }
  }
  if (!complete || user.trim() === '') return null;
  return { user, assistant, conversationId };
}

async function poll(haUrl: string, token: string, cursorFile: string): Promise<void> {
  const cursor = loadCursor(cursorFile);
  const [listMsg] = await haCall(haUrl, token, [{ type: 'assist_pipeline/pipeline/list' }]);
  const pipelines = ((listMsg.result as { pipelines?: { id?: string }[] })?.pipelines ?? [])
    .map((p) => p.id)
    .filter((id): id is string => typeof id === 'string');
  if (pipelines.length === 0) return;

  const runLists = await haCall(
    haUrl,
    token,
    pipelines.map((id) => ({ type: 'assist_pipeline/pipeline_debug/list', pipeline_id: id })),
  );

  const settled = Date.now() - SETTLE_MS;
  const candidates: { pipelineId: string; runId: string; timestamp: string }[] = [];
  runLists.forEach((msg, i) => {
    for (const run of (msg.result as { pipeline_runs?: DebugRun[] })?.pipeline_runs ?? []) {
      if (!run.pipeline_run_id || !run.timestamp) continue;
      const ts = Date.parse(run.timestamp);
      if (Number.isNaN(ts) || ts > settled) continue;
      if (Date.parse(cursor.since) >= ts) continue;
      if (cursor.seenRunIds.includes(run.pipeline_run_id)) continue;
      candidates.push({ pipelineId: pipelines[i], runId: run.pipeline_run_id, timestamp: run.timestamp });
    }
  });
  if (candidates.length === 0) {
    // Persist even when idle: the first write freezes the start-of-capture
    // cursor — otherwise loadCursor re-initializes `since` to "now" on every
    // tick and no run can ever get past it.
    writeFileSync(cursorFile, JSON.stringify(cursor));
    return;
  }
  candidates.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const details = await haCall(
    haUrl,
    token,
    candidates.map((c) => ({
      type: 'assist_pipeline/pipeline_debug/get',
      pipeline_id: c.pipelineId,
      pipeline_run_id: c.runId,
    })),
  );

  let captured = 0;
  details.forEach((msg, i) => {
    const run = extractRun(((msg.result as { events?: DebugEvent[] })?.events ?? []));
    const candidate = candidates[i];
    cursor.seenRunIds.push(candidate.runId);
    if (Date.parse(candidate.timestamp) > Date.parse(cursor.since)) cursor.since = candidate.timestamp;
    if (!run) return;
    if (run.conversationId && localConversations.has(run.conversationId)) return;
    appendTranscript({
      ts: candidate.timestamp,
      source: 'ha-pipeline',
      ...(run.conversationId ? { conversationId: run.conversationId } : {}),
      user: run.user,
      assistant: run.assistant,
    });
    captured += 1;
  });
  cursor.seenRunIds = cursor.seenRunIds.slice(-CURSOR_KEEP_IDS);
  writeFileSync(cursorFile, JSON.stringify(cursor));
  if (captured > 0) console.log(`[pipeline-capture] captured ${captured} external run(s)`);
}

export function startPipelineCapture(opts: { haUrl: string; token: string; pollMs?: number }): void {
  if (!memoryEnabled || !opts.haUrl || !opts.token) return;
  const dataDir = process.env.DATA_DIR ?? '';
  const cursorFile = join(dataDir, 'state', 'pipeline-capture.json');
  mkdirSync(dirname(cursorFile), { recursive: true });
  const pollMs = Math.max(15_000, opts.pollMs ?? 60_000);
  const tick = () => {
    poll(opts.haUrl, opts.token, cursorFile).catch((err) => {
      console.error('[pipeline-capture] poll failed:', err instanceof Error ? err.message : err);
    });
  };
  setInterval(tick, pollMs);
  setTimeout(tick, 5_000);
  console.log(`[pipeline-capture] polling HA pipeline debug store every ${pollMs / 1000}s`);
}
