import WebSocket from 'ws';

/**
 * Home Assistant assist pipeline over the WebSocket API. Unlike the REST
 * conversation/process endpoint (single blocking call, final speech only),
 * assist_pipeline/run streams intent-progress events while the agent works —
 * including the tool calls it makes — so the display can show live activity
 * instead of a bare "thinking" spinner.
 *
 * Event shapes verified against HA 2026.8: tool calls arrive as
 * intent-progress { chat_log_delta: { tool_calls: [{ tool_name, ... }] } },
 * the final reply as intent-end { intent_output: { response, conversation_id } }.
 */

export interface AssistResult {
  speech: string;
  responseType: string;
  conversationId?: string;
}

interface HaResultMessage {
  success?: boolean;
  result?: unknown;
  error?: { message?: string };
}

interface PipelineList {
  pipelines?: { id?: string; conversation_engine?: string }[];
}

interface ChatLogDelta {
  tool_calls?: { tool_name?: string }[];
}

interface HaEvent {
  type?: string;
  data?: {
    conversation_id?: string;
    chat_log_delta?: ChatLogDelta;
    intent_output?: {
      conversation_id?: string;
      response?: {
        response_type?: string;
        speech?: { plain?: { speech?: string } };
      };
    };
    message?: string;
  };
}

// The pipeline whose conversation agent matches HA_AGENT_ID, resolved once
// per process (assist_pipeline/run selects by pipeline id, not agent id).
// Cleared on a refused run so a deleted/recreated pipeline heals itself.
let cachedPipelineId: string | null | undefined;

export function runAssistPipeline(opts: {
  haUrl: string;
  token: string;
  agentId: string;
  text: string;
  conversationId?: string;
  timeoutMs: number;
  onToolCall: (name: string) => void;
}): Promise<AssistResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${opts.haUrl.replace(/^http/, 'ws')}/api/websocket`);
    const pending = new Map<number, (msg: HaResultMessage) => void>();
    let msgId = 0;
    let runId = 0;
    let runConversationId: string | undefined;
    let settled = false;

    const timer = setTimeout(() => fail(new Error('assist pipeline timed out')), opts.timeoutMs);

    function finish(result: AssistResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(result);
    }

    function fail(err: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      reject(err);
    }

    function send(msg: Record<string, unknown>): { id: number; ack: Promise<HaResultMessage> } {
      const id = (msgId += 1);
      const ack = new Promise<HaResultMessage>((res) => pending.set(id, res));
      ws.send(JSON.stringify({ id, ...msg }));
      return { id, ack };
    }

    async function start() {
      if (cachedPipelineId === undefined) {
        const list = await send({ type: 'assist_pipeline/pipeline/list' }).ack;
        const pipelines = (list.result as PipelineList | undefined)?.pipelines ?? [];
        const match = pipelines.find((p) => p.conversation_engine === opts.agentId);
        cachedPipelineId = match?.id ?? null;
        if (!match) {
          console.warn(`[assist] no pipeline uses ${opts.agentId} — falling back to HA's preferred pipeline`);
        }
      }
      const run = send({
        type: 'assist_pipeline/run',
        start_stage: 'intent',
        end_stage: 'intent',
        input: { text: opts.text },
        ...(cachedPipelineId ? { pipeline: cachedPipelineId } : {}),
        ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
      });
      runId = run.id;
      const ack = await run.ack;
      if (ack.success === false) {
        cachedPipelineId = undefined;
        throw new Error(ack.error?.message ?? 'assist_pipeline/run refused');
      }
    }

    function handleEvent(event: HaEvent) {
      switch (event.type) {
        case 'run-start':
          runConversationId = event.data?.conversation_id;
          break;
        case 'intent-progress':
          for (const call of event.data?.chat_log_delta?.tool_calls ?? []) {
            if (call.tool_name) opts.onToolCall(call.tool_name);
          }
          break;
        case 'intent-end': {
          const output = event.data?.intent_output;
          finish({
            speech: output?.response?.speech?.plain?.speech ?? '',
            responseType: output?.response?.response_type ?? 'unknown',
            conversationId: output?.conversation_id ?? runConversationId,
          });
          break;
        }
        case 'error':
          fail(new Error(event.data?.message ?? 'assist pipeline error'));
          break;
      }
    }

    ws.on('message', (raw) => {
      let msg: {
        id?: number;
        type?: string;
        message?: string;
        event?: HaEvent;
      } & HaResultMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (msg.type) {
        case 'auth_required':
          ws.send(JSON.stringify({ type: 'auth', access_token: opts.token }));
          break;
        case 'auth_invalid':
          fail(new Error('home assistant rejected the token'));
          break;
        case 'auth_ok':
          start().catch((err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
          break;
        case 'result':
          if (msg.id !== undefined) {
            pending.get(msg.id)?.(msg);
            pending.delete(msg.id);
          }
          break;
        case 'event':
          if (msg.id === runId && msg.event) handleEvent(msg.event);
          break;
      }
    });

    ws.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    ws.on('close', () => fail(new Error('home assistant closed the connection')));
  });
}
