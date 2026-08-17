# jarvis

Voice-assistant-driven display for the gym TV. A producer (Home Assistant,
the Hermes agent, or anything that can make an HTTP request) POSTs
LLM-generated vanilla HTML; every connected screen updates instantly over
WebSockets and renders it through a consistent, themeable design system.

Runs at `jarvis.cuffney.com` (VPN/LAN-only, k3s). TV renders it via a kiosk
device:

```
chromium --kiosk --autoplay-policy=no-user-gesture-required https://jarvis.cuffney.com
```

## Architecture

One Node process (`server.ts`): custom HTTP server hosting the Next.js app,
the REST push API, and the `/ws` WebSocket fan-out. Display state is an
in-memory singleton — replace-only, no persistence; a restart returns to the
idle screen.

```
producer ──POST /api/display──▶ server ──WS {v:1,type:'state',state}──▶ TV / phone / desktop
```

- Every WS message carries the **full state** (idempotent, replay-safe).
- New connections immediately receive the current state (a rebooting TV
  never shows a blank screen mid-workout).
- `durationSec` sets a TTL; the server flips back to idle and broadcasts.
- Heartbeat: server pings every 30s and drops dead sockets; the client
  reconnects with backoff and shows a "reconnecting…" badge.

## API

All endpoints except `/api/healthz` require `Authorization: Bearer $JARVIS_TOKEN`.

| Endpoint | Body | Behavior |
|---|---|---|
| `POST /api/display` | `{ html, title?, durationSec?, theme? }` | Sanitize, replace current state, broadcast. Returns `{ id, expiresAt? }`. Max body 256 KB. |
| `POST /api/clear` | — | Back to the idle screen. |
| `POST /api/navigate` | `{ path }` | Steer every connected screen to a route (`/` or `/brain`). |
| `GET /api/state` | — | Current display state (sanitized HTML). |
| `GET /api/healthz` | — | Liveness, no auth. |

```bash
curl -X POST https://jarvis.cuffney.com/api/display \
  -H "Authorization: Bearer $JARVIS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "title": "Back Squat",
    "html": "<h1>Back Squat</h1><a data-embed href=\"https://www.youtube.com/watch?v=ultWZbUMPL8\">How to Back Squat</a><ul><li>Brace before you descend</li><li>Knees track over toes</li></ul>",
    "durationSec": 600
  }'
```

## The HTML contract (for the producer's LLM prompt)

Include this verbatim in the system prompt of whatever generates display
content:

> Emit vanilla semantic HTML only. Allowed tags: h1, h2, h3, p, ul, ol, li,
> table, blockquote, strong, em, code, a, img. No inline styles, classes,
> scripts, or iframes — the display themes everything. At most one h1. For a
> video, emit `<a data-embed href='<youtube url>'>Title</a>`. Keep it to one
> screen of content.

Server-side sanitization enforces this (allowlist; `class`/`style`/`id`/`on*`
stripped; `https:` URLs only; no iframes ever). YouTube links — `data-embed`
or plain — are transformed client-side into embedded players constructed by
our own code, with the original link kept visible as a fallback for videos
that disallow embedding.

## Assist mode

The display is a heads-up display by default. The `✦ assist` corner button
(twin of the fullscreen affordance) opens an overlay that talks to Home
Assistant's Assist agent: mic input via the browser's SpeechRecognition
(hidden if unsupported), text input always, replies in a transcript and
spoken via speechSynthesis. The HUD keeps updating underneath.

Backend: `POST /api/assist {text, conversationId?}` proxies to
`$HA_URL/api/conversation/process` with the server-held `$HA_TOKEN`
(long-lived HA access token; `HA_AGENT_ID` optionally pins a specific
conversation agent). Unset → 503 and the button still renders but reports
assist as unconfigured.

Trust model: `/api/assist` is deliberately NOT behind the producer bearer
token — the TV/kiosk can't hold secrets. The vhost is LAN/VPN-only, so this
is the same exposure as a voice satellite speaker on the network. Anyone on
the LAN can talk to the agent; the HA token itself never leaves the server.

Kiosk note: Chromium needs mic permission — add
`--use-fake-ui-for-media-stream` (auto-grants) or grant once in the profile.
SpeechRecognition in Chromium uses Google's speech service (needs internet).

## Theming

Themes are CSS custom-property sets under `[data-theme="<name>"]` in
`src/styles/themes/` (`gym-dark` default, `light`). ~30 lines define a theme:
`--bg --surface --text --text-muted --accent --accent-contrast --border
--radius` plus a spacing scale. Producers can switch per-message via the
`theme` field. `src/styles/prose.css` styles the vanilla tags (the "designed
LLM output" layer); TV-first type via `font-size: clamp(...)` on the root and
a 4vmin overscan-safe padding.

## Producers

Home Assistant `configuration.yaml`:

```yaml
rest_command:
  jarvis_display:
    url: https://jarvis.cuffney.com/api/display
    method: post
    headers:
      Authorization: !secret jarvis_bearer
    content_type: application/json
    payload: >-
      {"html": {{ html | tojson }},
       "title": {{ title | default('') | tojson }},
       "durationSec": {{ duration_sec | default(600) }}}
```

(`secrets.yaml`: `jarvis_bearer: Bearer <token>`)

## Development

```bash
npm install
npm run dev        # tsx watch server.ts — Next HMR works through the custom server
# token in dev defaults to "dev":
curl -X POST localhost:3000/api/display -H 'Authorization: Bearer dev' \
  -H 'content-type: application/json' -d '{"html":"<h1>hello</h1>"}'
```

## Deploy

Push to `main` → GitHub Actions builds `ghcr.io/jcuffney/jarvis:{latest,sha-<short>}`.
The homelab repo (`infra/k8s/base/jarvis-*.yaml`) pins a `sha-` tag and runs
it on k3s behind Traefik + the gateway nginx (`JARVIS_TOKEN` from the
`jarvis-api` k8s secret, created out-of-band).
