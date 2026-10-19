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
 *   exit-with-helper starts a long-lived helper, answers initialize, then exits
 *   dies-mid-turn sends a message chunk, then exits without answering
 *   fs-call       asks the client for fs/read_text_file and reports the answer
 *   fs-write-call asks the client for fs/write_text_file and reports the answer
 *   permission    asks the client for permission and reports the outcome
 *   unknown       streams an update kind the protocol's schema does not define
 *   extended      streams a schema-valid update kind madarch does not name
 *   old-protocol  answers initialize with a protocol version the client lacks
 *   no-session-id answers session/new without an id
 *   hang          never answers initialize
 *   late-initialize answers initialize long after the client's bound
 *   crash         writes to standard error and exits 1 before answering
 *   mcp-tools     starts the session's stdio MCP servers as an agent does, speaks
 *                 the Model Context Protocol to the first of them (initialize,
 *                 notifications/initialized, tools/list), and on each prompt calls
 *                 one of its tools and streams the answer back as a message chunk:
 *                 the prompt names the call as JSON (`{"tool":"neighbors",
 *                 "arguments":{"id":"..."}}`), and `neighbors` of the prompt's own
 *                 `id` is the default
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

/** One stdio MCP server a session was given (`mcpServers` of `session/new`), as this agent starts and speaks to it. */
interface McpServerSpec { name?: string; command?: string; args?: string[]; env?: { name: string; value: string }[]; url?: string }

/** One answer a tool call came back with, as this agent reads the protocol's result. */
interface McpToolAnswer { text: string; isError: boolean }

interface McpClient {
  readonly tools: readonly string[];
  call(tool: string, argumentsValue: unknown): Promise<McpToolAnswer>;
  stop(): void;
}

/**
 * A stdio MCP server spoken to the way the specification says (newline-delimited
 * JSON-RPC 2.0): `initialize`, the required `notifications/initialized`, then
 * `tools/list`. Hand-written, like this whole agent, so the server is proved to
 * speak the protocol and not merely to agree with a library.
 */
async function startMcp(servers: readonly McpServerSpec[]): Promise<McpClient> {
  const server = servers.find((each) => typeof each.command === 'string');
  if (server === undefined || server.command === undefined) throw new Error(`the session was given no stdio MCP server: ${JSON.stringify(servers)}`);
  const env = Object.fromEntries((server.env ?? []).map((each) => [each.name, each.value]));
  const child = Bun.spawn([server.command, ...(server.args ?? [])], { cwd: process.cwd(), env: { ...process.env, ...env }, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
  const pending = new Map<number, (message: Message) => void>();
  let nextId = 1;
  let buffered = '';
  const decoder = new TextDecoder();
  const send = (message: unknown): void => { child.stdin.write(`${JSON.stringify(message)}\n`); child.stdin.flush(); };
  const deliver = (line: string): void => {
    if (line.trim() === '') return;
    const message = JSON.parse(line) as Message;
    if (message.id === undefined) return;
    const settle = pending.get(Number(message.id));
    if (settle !== undefined) { pending.delete(Number(message.id)); settle(message); }
  };
  void (async () => {
    const stream = child.stdout.getReader();
    for (;;) {
      const chunk = await stream.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let cut = buffered.indexOf('\n');
      while (cut >= 0) { deliver(buffered.slice(0, cut)); buffered = buffered.slice(cut + 1); cut = buffered.indexOf('\n'); }
    }
  })();
  const ask = (method: string, params: unknown): Promise<Message> => {
    const id = nextId++;
    return new Promise((settle) => { pending.set(id, settle); send({ jsonrpc: '2.0', id, method, params }); });
  };
  const initialized = await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '1.0.0' } });
  if (initialized.error !== undefined) throw new Error(`the MCP server refused initialize: ${JSON.stringify(initialized.error)}`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await ask('tools/list', {});
  if (listed.error !== undefined) throw new Error(`the MCP server refused tools/list: ${JSON.stringify(listed.error)}`);
  const tools = ((listed.result as { tools?: { name?: string }[] } | undefined)?.tools ?? []).map((tool) => String(tool.name));
  return {
    tools,
    async call(tool: string, argumentsValue: unknown): Promise<McpToolAnswer> {
      const answered = await ask('tools/call', { name: tool, arguments: argumentsValue });
      if (answered.error !== undefined) throw new Error(`the MCP server refused tools/call ${tool}: ${JSON.stringify(answered.error)}`);
      const result = answered.result as { content?: { type?: string; text?: string }[]; isError?: boolean } | undefined;
      return { text: (result?.content ?? []).map((block) => String(block.text ?? '')).join(''), isError: result?.isError === true };
    },
    stop: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

/** The call one prompt asks for: the JSON the prompt carries, or `neighbors` of the id the prompt names. */
function callAskedBy(text: string): { tool: string; argumentsValue: unknown } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const asked = JSON.parse(trimmed) as { tool?: unknown; arguments?: unknown };
      if (typeof asked.tool === 'string') return { tool: asked.tool, argumentsValue: asked.arguments ?? {} };
    } catch { /* not a call: read it as the id of the node to look at */ }
  }
  return { tool: 'neighbors', argumentsValue: { id: trimmed } };
}

let sessionNumber = 0;
/** The one MCP client this agent's `mcp-tools` scenario speaks to. */
let mcp: McpClient | undefined;
let pendingPrompt: { id: number | string; sessionId: string; text: string; turn: number } | undefined;
let turn = 0;

function chunk(sessionId: string, text: string): void {
  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
}

async function runPrompt(id: number | string, sessionId: string, text: string): Promise<void> {
  turn += 1;
  if (scenario === 'mcp-tools') {
    const asked = callAskedBy(text);
    const started = mcp;
    if (started === undefined) {
      chunk(sessionId, 'no mcp server was started');
      respond(id, { stopReason: 'end_turn' });
      return;
    }
    const answered = await started.call(asked.tool, asked.argumentsValue);
    chunk(sessionId, JSON.stringify({ tool: asked.tool, isError: answered.isError, text: answered.text, tools: started.tools }));
    respond(id, { stopReason: 'end_turn' });
    return;
  }
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
  if (scenario === 'fs-call' || scenario === 'fs-write-call') {
    let answer: string;
    try {
      const reply = scenario === 'fs-call'
        ? await ask('fs/read_text_file', { sessionId, path: '/etc/hostname' })
        : await ask('fs/write_text_file', { sessionId, path: '/tmp/fake-agent-write', content: 'x' });
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
      if (scenario === 'exit-with-helper') {
        // A helper that inherits this agent's stdout and stderr — that is, the
        // client's pipes — and an agent that then ends on its own: the client
        // must still end the helper when it closes.
        const helper = Bun.spawn(['sleep', '30'], { stdio: ['ignore', 'inherit', 'inherit'] });
        appendFileSync(process.env.ACP_FAKE_HELPER_RECORD ?? '/dev/null', `${helper.pid}\n`);
        respond(message.id, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: false }, mcpCapabilities: { http: true, sse: true } },
          agentInfo: { name: 'fake-agent', title: 'Fake ACP agent', version: '1.0.0' },
          authMethods: [],
        });
        setTimeout(() => process.exit(0), 50);
        return;
      }
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
      if (scenario === 'mcp-tools') {
        // An agent starts the session's MCP servers before it answers `session/new`: the server is up by
        // the time a prompt arrives, which is what the real adapters do.
        const servers = (message.params?.['mcpServers'] ?? []) as McpServerSpec[];
        void startMcp(servers).then((client) => {
          mcp = client;
          respond(message.id, { sessionId: `fake-session-${sessionNumber}`, modes: { currentModeId: 'ask' } });
        }).catch((error: Error) => {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `the MCP server would not start: ${error.message}` } });
        });
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
