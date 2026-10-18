/**
 * A fake ACP agent for the client's tests: newline-delimited JSON-RPC 2.0 over
 * stdio, hand-written from the protocol rather than built on the library the
 * client uses, so a test proves the client speaks the protocol and not merely
 * that it agrees with itself.
 *
 * Run as `bun acp-fake-agent.ts --scenario <name> [--record <file>]`, where
 * `--record` receives every message the agent was sent, one JSON object per
 * line, for the test to assert on. Each scenario answers `initialize` and
 * `session/new` the same way, and differs in how it runs a prompt turn.
 *
 *   default       thought, two message chunks, a tool call and its update, a
 *                 usage update, then end_turn with a usage report
 *   no-usage      one message chunk, then end_turn with no usage at all
 *   two-turns     each turn reports a larger cumulative total
 *   cancellable   one message chunk, then waits for session/cancel
 *   cancel-error  like cancellable, but answers a cancel with protocol error -32800
 *   auth-required answers session/new with protocol error -32000
 *   no-http-mcp   advertises no MCP transport at all
 *   slow-turn     takes longer than the client's bound before it answers the prompt
 *   helper        starts a long-lived helper process, then waits for a cancel
 *   dies-mid-turn sends a message chunk, then exits without answering
 *   fs-call       asks the client for fs/read_text_file and reports the answer
 *   permission    asks the client for permission and reports the outcome
 *   unknown       streams an update kind the protocol's schema does not define
 *   extended      streams a schema-valid update kind madarch does not name
 *   old-protocol  answers initialize with a protocol version the client lacks
 *   no-session-id answers session/new without an id
 *   hang          never answers initialize
 *   late-initialize answers initialize long after the client's bound
 *   crash         writes to standard error and exits 1 before answering
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const scenario = option('scenario') ?? 'default';
const record = option('record');
const pidFile = option('pid-file');
if (pidFile !== undefined) writeFileSync(pidFile, `${process.pid}\n`);

interface Message { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function respond(id: number | string | undefined, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}
function notify(method: string, params: unknown): void {
  send({ jsonrpc: '2.0', method, params });
}

/** A request the agent sends the client, answered by the message carrying its id. */
let nextRequestId = 1000;
const pending = new Map<number, (message: Message) => void>();
function ask(method: string, params: unknown): Promise<Message> {
  const id = nextRequestId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

let sessionNumber = 0;
let pendingPrompt: { id: number | string; sessionId: string; text: string; turn: number } | undefined;
let turn = 0;

function chunk(sessionId: string, text: string): void {
  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
}

async function runPrompt(id: number | string, sessionId: string, text: string): Promise<void> {
  turn += 1;
  if (scenario === 'dies-mid-turn') {
    chunk(sessionId, 'stopping');
    setTimeout(() => process.exit(1), 20);
    return;
  }
  if (scenario === 'slow-turn') {
    setTimeout(() => respond(id, { stopReason: 'end_turn', usage: { totalTokens: 5, inputTokens: 4, outputTokens: 1 } }), 600);
    chunk(sessionId, 'slow');
    return;
  }
  if (scenario === 'helper') {
    pendingPrompt = { id, sessionId, text, turn };
    // The helper inherits the agent's own stdout and stderr, so it holds the
    // client's pipes open as a real adapter's helper process does: a client
    // that waits for the stream to close would wait for this process's end.
    const helper = Bun.spawn(['sleep', '30'], { stdio: ['ignore', 'inherit', 'inherit'] });
    appendFileSync(process.env.ACP_FAKE_HELPER_RECORD ?? '/dev/null', `${helper.pid}\n`);
    chunk(sessionId, `helper ${helper.pid}`);
    return;
  }
  if (scenario === 'cancellable' || scenario === 'cancel-error') {
    pendingPrompt = { id, sessionId, text, turn };
    chunk(sessionId, 'working');
    return;
  }
  if (scenario === 'fs-call') {
    let answer: string;
    try {
      const reply = await ask('fs/read_text_file', { sessionId, path: '/etc/hostname' });
      answer = reply.error === undefined ? 'fs answer without error' : JSON.stringify(reply.error);
    } catch (error) {
      answer = `fs refused: ${(error as Error).message}`;
    }
    chunk(sessionId, answer);
    respond(id, { stopReason: 'end_turn' });
    return;
  }
  if (scenario === 'permission') {
    const reply = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call-1', title: 'Write a file', kind: 'edit', status: 'pending' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    chunk(sessionId, `permission ${JSON.stringify(reply.result)}`);
    respond(id, { stopReason: 'end_turn' });
    return;
  }
  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } });
  chunk(sessionId, `echo: ${text}`);
  chunk(sessionId, ' done');
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read graph', kind: 'read', status: 'pending' } });
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' } });
  if (scenario === 'unknown') {
    notify('session/update', { sessionId, update: { sessionUpdate: 'brand_new_variant', payload: 1 } });
  }
  if (scenario === 'extended') {
    notify('session/update', { sessionId, update: { sessionUpdate: 'session_info_update', title: 'renamed session' } });
  }
  if (scenario === 'default') {
    notify('session/update', { sessionId, update: { sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: { amount: 0.5, currency: 'USD' } } });
    respond(id, { stopReason: 'end_turn', usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12 } });
    return;
  }
  if (scenario === 'two-turns') {
    const usage = turn === 1 ? { totalTokens: 42, inputTokens: 30, outputTokens: 12 } : { totalTokens: 95, inputTokens: 75, outputTokens: 20 };
    respond(id, { stopReason: 'end_turn', usage });
    return;
  }
  if (scenario === 'no-usage') {
    respond(id, { stopReason: 'end_turn' });
    return;
  }
  respond(id, { stopReason: 'end_turn' });
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line: string) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line) as Message;
  if (record !== undefined) appendFileSync(record, `${line}\n`);
  if (message.id !== undefined && message.method === undefined) {
    const settle = pending.get(Number(message.id));
    if (settle !== undefined) {
      pending.delete(Number(message.id));
      settle(message);
    }
    return;
  }
  switch (message.method) {
    case 'initialize':
      if (scenario === 'hang') return;
      if (scenario === 'late-initialize') {
        // Answers well after any sane bound, to prove the client survives a
        // request that settles when nothing is waiting for it any more.
        setTimeout(() => { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'late failure' } }); }, 400);
        return;
      }
      if (scenario === 'crash') {
        process.stderr.write('fake agent: the credentials are missing\n');
        process.exit(1);
      }
      respond(message.id, {
        protocolVersion: scenario === 'old-protocol' ? 99 : 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false }, ...(scenario === 'no-http-mcp' ? {} : { mcpCapabilities: { http: true, sse: true } }) },
        agentInfo: { name: 'fake-agent', title: 'Fake ACP agent', version: '1.0.0' },
        authMethods: [{ id: 'local', name: 'Local credentials', description: 'Use the credentials on this machine' }],
      });
      return;
    case 'session/new': {
      sessionNumber += 1;
      if (scenario === 'auth-required') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required' } });
        return;
      }
      if (scenario === 'no-session-id') {
        respond(message.id, {});
        return;
      }
      respond(message.id, { sessionId: `fake-session-${sessionNumber}`, modes: { currentModeId: 'ask' } });
      return;
    }
    case 'session/prompt': {
      const params = message.params ?? {};
      void runPrompt(message.id as number, String(params.sessionId), String((params.prompt as { text?: string }[] | undefined)?.[0]?.text ?? ''));
      return;
    }
    case 'session/cancel': {
      const params = message.params ?? {};
      if (pendingPrompt !== undefined && pendingPrompt.sessionId === String(params.sessionId)) {
        const stopped = pendingPrompt;
        pendingPrompt = undefined;
        if (scenario === 'cancel-error') send({ jsonrpc: '2.0', id: stopped.id, error: { code: -32800, message: 'Request cancelled' } });
        else respond(stopped.id, { stopReason: 'cancelled' });
      }
      return;
    }
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `fake agent knows no method ${String(message.method)}` } });
      }
  }
});
