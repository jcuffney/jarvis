import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { store } from './src/lib/store';
import { buildBrainGraph, invalidateBrainCache } from './src/lib/brain';
import { sanitizeDisplayHtml } from './src/lib/sanitize';
import { isAuthorized } from './src/lib/auth';
import type { DisplayState, ServerMessage } from './src/lib/protocol';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
const token = process.env.JARVIS_TOKEN ?? (dev ? 'dev' : '');
if (!token) {
  console.error('JARVIS_TOKEN is required in production');
  process.exit(1);
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_DURATION_SEC = 24 * 60 * 60;
const HEARTBEAT_MS = 30_000;

// Optional Home Assistant Assist bridge (POST /api/assist). Unset HA_TOKEN
// disables it with a 503 — the display still works standalone.
const HA_URL = (process.env.HA_URL ?? '').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN ?? '';
const HA_AGENT_ID = process.env.HA_AGENT_ID ?? '';
const ASSIST_TIMEOUT_MS = 60_000; // LLM-backed agents can be slow

// Second-brain graph (GET /api/brain/graph). BRAIN_DIR points at the vault
// (read-only NFS mount in production); unset disables with a 503.
const BRAIN_DIR = process.env.BRAIN_DIR ?? '';

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void> | void;

/**
 * Dev: the full next() entry (HMR websocket included). Prod: NextServer from
 * next/dist/server/next-server, exactly like standalone's generated server.js
 * — the pruned standalone node_modules doesn't carry the compiled-webpack
 * internals that the next() entry requires.
 */
async function createNextHandlers(): Promise<{
  handleRequest: RequestHandler;
  handleUpgrade: UpgradeHandler | null;
}> {
  if (dev) {
    const next = (await import('next')).default;
    const app = next({ dev: true });
    await app.prepare();
    return {
      handleRequest: app.getRequestHandler(),
      handleUpgrade: app.getUpgradeHandler(),
    };
  }
  const { config } = JSON.parse(
    readFileSync(join(process.cwd(), '.next', 'required-server-files.json'), 'utf8'),
  );
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
  // Extension required: this survives esbuild as a runtime ESM import(),
  // and Node's ESM resolver doesn't do extension guessing.
  const mod = await import('next/dist/server/next-server.js');
  // Node's native import() of this CJS file nests the class one level deeper
  // than TS's view of it (interop puts module.exports at .default).
  const NextServer = ((mod.default as unknown as { default?: typeof mod.default }).default ??
    mod.default) as typeof mod.default;
  // No customServer flag: that tells NextServer someone else serves
  // /_next/static, and everything under it 404s (found the hard way).
  const app = new NextServer({
    dev: false,
    dir: process.cwd(),
    conf: config,
    hostname: '0.0.0.0',
    port,
  });
  return { handleRequest: app.getRequestHandler() as unknown as RequestHandler, handleUpgrade: null };
}

// ---------- helpers ----------

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        resolve({ ok: false, status: 413, error: `body exceeds ${MAX_BODY_BYTES} bytes` });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ ok: false, status: 400, error: 'invalid JSON body' });
      }
    });
    req.on('error', () => resolve({ ok: false, status: 400, error: 'request aborted' }));
  });
}

// ---------- /_next/static (production only) ----------
// In standalone output, Next's own startServer() serves these from a router
// layer that sits OUTSIDE NextServer — hosting NextServer directly leaves
// them 404ing. They're content-hashed immutable files, so serve them here.

const STATIC_ROOT = join(process.cwd(), '.next', 'static');
const STATIC_MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

function serveNextStatic(res: ServerResponse, pathname: string): boolean {
  if (dev || !pathname.startsWith('/_next/static/')) return false;
  const rel = normalize(decodeURIComponent(pathname.slice('/_next/static/'.length)));
  const file = join(STATIC_ROOT, rel);
  if (!file.startsWith(STATIC_ROOT + sep) || file.includes('\0')) {
    res.writeHead(400);
    res.end();
    return true;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end();
    return true;
  }
  res.writeHead(200, {
    'content-type': STATIC_MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
  return true;
}

// ---------- REST API ----------

/**
 * Browser-facing bridge to Home Assistant's conversation API. Deliberately
 * NOT behind the producer bearer token: the TV/kiosk can't hold secrets, and
 * the vhost is LAN/VPN-only — same trust model as a voice satellite on the
 * network. The HA token stays server-side.
 */
async function handleAssist(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  if (!HA_URL || !HA_TOKEN) {
    sendJson(res, 503, { error: 'assist not configured (set HA_URL and HA_TOKEN)' });
    return;
  }
  const result = await readJsonBody(req);
  if (!result.ok) {
    sendJson(res, result.status, { error: result.error });
    return;
  }
  const body = result.body as Record<string, unknown>;
  if (typeof body?.text !== 'string' || body.text.trim() === '') {
    sendJson(res, 400, { error: 'text (non-empty string) is required' });
    return;
  }
  try {
    const haResponse = await fetch(`${HA_URL}/api/conversation/process`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${HA_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: body.text,
        ...(typeof body.conversationId === 'string' ? { conversation_id: body.conversationId } : {}),
        ...(HA_AGENT_ID ? { agent_id: HA_AGENT_ID } : {}),
      }),
      signal: AbortSignal.timeout(ASSIST_TIMEOUT_MS),
    });
    if (!haResponse.ok) {
      console.error(`[assist] HA returned ${haResponse.status}`);
      sendJson(res, 502, { error: `home assistant returned ${haResponse.status}` });
      return;
    }
    const data = (await haResponse.json()) as {
      conversation_id?: string;
      response?: {
        response_type?: string;
        speech?: { plain?: { speech?: string } };
      };
    };
    sendJson(res, 200, {
      speech: data.response?.speech?.plain?.speech ?? '',
      responseType: data.response?.response_type ?? 'unknown',
      conversationId: data.conversation_id,
    });
  } catch (err) {
    console.error('[assist] request failed:', err);
    sendJson(res, 502, { error: 'could not reach home assistant' });
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (pathname === '/api/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/assist') {
    await handleAssist(req, res);
    return;
  }

  // Same trust model as /api/assist: viewer-facing, LAN/VPN-only vhost.
  if (pathname === '/api/brain/graph') {
    if (!BRAIN_DIR) {
      sendJson(res, 503, { error: 'brain graph not configured (set BRAIN_DIR)' });
      return;
    }
    try {
      const url = new URL(req.url ?? '/', 'http://jarvis.internal');
      if (url.searchParams.get('refresh') === '1') invalidateBrainCache();
      sendJson(res, 200, buildBrainGraph(BRAIN_DIR));
    } catch (err) {
      console.error('[brain] graph build failed:', err);
      sendJson(res, 500, { error: 'could not read the vault' });
    }
    return;
  }

  if (!isAuthorized(req.headers.authorization, token)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    sendJson(res, 200, store.get());
    return;
  }

  if (pathname === '/api/clear' && req.method === 'POST') {
    store.clear();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/display' && req.method === 'POST') {
    const result = await readJsonBody(req);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return;
    }
    const body = result.body as Record<string, unknown>;
    if (typeof body?.html !== 'string' || body.html.trim() === '') {
      sendJson(res, 400, { error: 'html (non-empty string) is required' });
      return;
    }
    if (body.durationSec !== undefined && (typeof body.durationSec !== 'number' || body.durationSec <= 0 || body.durationSec > MAX_DURATION_SEC)) {
      sendJson(res, 400, { error: `durationSec must be a number in (0, ${MAX_DURATION_SEC}]` });
      return;
    }
    if (body.title !== undefined && typeof body.title !== 'string') {
      sendJson(res, 400, { error: 'title must be a string' });
      return;
    }
    if (body.theme !== undefined && typeof body.theme !== 'string') {
      sendJson(res, 400, { error: 'theme must be a string' });
      return;
    }
    const html = sanitizeDisplayHtml(body.html);
    if (html.trim() === '') {
      sendJson(res, 400, { error: 'html was empty after sanitization' });
      return;
    }
    const state = store.setContent({
      html,
      title: body.title as string | undefined,
      theme: body.theme as string | undefined,
      durationSec: body.durationSec as number | undefined,
    });
    if (state.mode === 'content') {
      sendJson(res, 200, { id: state.id, ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}) });
    }
    return;
  }

  sendJson(res, pathname === '/api/display' || pathname === '/api/clear' || pathname === '/api/state' ? 405 : 404, {
    error: 'not found',
  });
}

// ---------- WebSocket fan-out ----------

interface LiveSocket extends WebSocket {
  missedPongs: number;
}

const wss = new WebSocketServer({ noServer: true });

function stateMessage(state: DisplayState): string {
  const msg: ServerMessage = { v: 1, type: 'state', state };
  return JSON.stringify(msg);
}

wss.on('connection', (socket) => {
  const ws = socket as LiveSocket;
  ws.missedPongs = 0;
  ws.on('pong', () => {
    ws.missedPongs = 0;
  });
  // Replay: every new viewer immediately gets the current screen.
  ws.send(stateMessage(store.get()));
});

store.subscribe((state) => {
  const payload = stateMessage(state);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
});

setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as LiveSocket;
    if (ws.missedPongs >= 2) {
      ws.terminate();
      continue;
    }
    ws.missedPongs += 1;
    ws.ping();
  }
}, HEARTBEAT_MS);

// ---------- boot ----------

createNextHandlers().then(({ handleRequest, handleUpgrade }) => {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://jarvis.internal');
    if (pathname.startsWith('/api/')) {
      void handleApi(req, res, pathname);
      return;
    }
    if (serveNextStatic(res, pathname)) return;
    void handleRequest(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://jarvis.internal');
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }
    if (handleUpgrade) {
      // Next's HMR websocket in dev.
      void handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });

  server.listen(port, () => {
    console.log(`jarvis listening on :${port} (${dev ? 'dev' : 'production'})`);
  });
});
