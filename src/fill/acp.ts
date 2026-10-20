/**
 * The client madarch drives a coding agent with, over the Agent Client
 * Protocol (decision 0026): madarch starts one agent process, initializes the
 * connection once, and per unit creates one session — with the unit's MCP
 * server attached — sends one prompt, follows the streamed updates, and can
 * cancel the turn, and ends a turn itself when the caller's own bound passes
 * without an answer from the agent (decision 0026's ten minutes,
 * madarch-tzte.38). The protocol's schema and its JSON-RPC framing come from
 * the official TypeScript library (`@agentclientprotocol/sdk`), which the
 * compiled binary ships too: the library reaches the wire through web streams
 * over the child's stdio, and both `bun run` and `bun build --compile` were
 * checked with it (its peer dependency `zod` is installed with it).
 *
 * Three things stay this module's own rather than the library's:
 *
 * - The unit's agent reads code only through the MCP server madarch passes it,
 *   so the client advertises no file system capacities and no terminal: an
 *   agent that calls `fs/read_text_file` anyway receives an error naming the
 *   method, and every permission request is answered `cancelled`.
 * - A session's token accounting is the agent's own report, kept as reported
 *   and never invented. The protocol's published v1 schema, read on 2026-10-18,
 *   has no `usage` on the `session/prompt` response at all; the library's
 *   generated schema carries it as an unstable field, and its inner
 *   fields speak of totals across all turns while the response field speaks
 *   of this turn. Madarch therefore keeps the latest report as the session's
 *   figure, says "not reported" for a session whose agent reports none, and
 *   never adds reports that may already be cumulative. The context window an
 *   agent reports in `usage_update` is kept beside it, since that is what a
 *   unit's 70% and 80% limits are read from (decision 0026).
 * - Every failure names what failed and where: the ACP method, the agent id,
 *   the program resolved to its full path, the folder it runs in, and the end
 *   of the agent's standard error.
 * - A turn ends when the caller says so. An aborted `prompt` signal sends
 *   `session/cancel` and resolves the turn as cancelled without waiting for the
 *   agent: a turn that sends nothing and never answers is bounded by the
 *   caller's clock and not by the agent's willingness to read a cancel
 *   (madarch-tzte.38).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { runningVersion } from '../product/version.js';

/** The agent program as this machine spells it, and the id reports name it by. */
export interface AcpAgentSpec {
  /** A stable id the wizard and the probe report by, such as `omp`. */
  id: string;
  /** The program to start: a name on PATH, or a full path. */
  command: string;
  args?: readonly string[];
  /** Extra environment for the child, merged over this process's. */
  env?: Readonly<Record<string, string>>;
}

/** How madarch names an update the agent streamed. */
export type AcpUpdateKind = 'message' | 'thought' | 'tool-call' | 'tool-call-update' | 'plan' | 'usage' | 'mode' | 'commands' | 'config' | 'user-message' | 'other';

/** One `session/update`, normalized; the protocol's own object is kept as received. */
export interface AcpUpdate {
  /** Which kind of update this is, as madarch names the kinds. */
  kind: AcpUpdateKind;
  /** The protocol's own `sessionUpdate` tag, unchanged. */
  sessionUpdate: string;
  at: string;
  /** The text of a message or thought chunk. */
  text?: string;
  /** Identifies one tool call across its creation and its updates. */
  toolCallId?: string;
  title?: string;
  status?: string;
  /** The protocol's `kind` of a tool call: read, edit, execute and the rest. */
  toolKind?: string;
  /** Tokens the agent says are in the session's context, from a `usage_update`. */
  contextUsed?: number;
  /** The context window the agent names, from a `usage_update`. */
  contextSize?: number;
  /** The agent's cumulative cost, from a `usage_update`. */
  cost?: { amount: number; currency: string };
  raw: unknown;
}

/** A usage report, as the agent gave it. */
export interface AcpUsageReport {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
}

/**
 * A session's token accounting: the agent's latest report, or the fact that it
 * reported none. The figures are the last report's own — madarch never adds
 * reports together, because the protocol does not say whether they cumulate.
 */
export interface AcpSessionUsage extends AcpUsageReport {
  /** Whether the agent reported token usage at all for this session. */
  reported: boolean;
  /** How many prompt turns this session has run. */
  turns: number;
  /** How many of those turns carried a usage report. */
  reports: number;
  /** The last `usage_update`: tokens in the context window, and the window's size. */
  context?: { used: number; size: number };
}

/** What one prompt turn ended with. */
export interface AcpPromptResult {
  /** The protocol's stop reason: `end_turn`, `cancelled`, `max_tokens` and the rest. */
  stopReason: string;
  /** The assistant's message text, in the order its chunks arrived. */
  text: string;
  /** The turn's own usage report, when the agent gave one. */
  usage?: AcpUsageReport;
  /** Every update the turn streamed, in order. */
  updates: AcpUpdate[];
}

/** One ACP session: one unit's conversation with the agent. */
export interface AcpSession {
  readonly sessionId: string;
  /** The mode state `session/new` returned, when it returned one. */
  readonly modes: unknown;
  /**
   * Send one prompt turn and wait for its stop reason; `onUpdate` sees each update as it arrives. An aborted
   * `signal` ends the turn as cancelled: madarch sends `session/cancel` and stops waiting for the agent, so a turn
   * the agent never answers is bounded by the caller's own clock (decision 0026's ten minutes, madarch-tzte.38).
   */
  prompt(text: string, options?: { onUpdate?: (update: AcpUpdate) => void; signal?: AbortSignal }): Promise<AcpPromptResult>;
  /** Send `session/cancel`; the prompt in flight then ends with `stopReason: "cancelled"`. */
  cancel(): Promise<void>;
  /** This session's token accounting, as reported. */
  usage(): AcpSessionUsage;
  /** Whether a prompt is in flight right now. */
  running(): boolean;
}

/** What the agent answered to `initialize`. */
export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name?: string; title?: string; version?: string };
  agentCapabilities: Record<string, unknown>;
  authMethods: readonly { id: string; name?: string; description?: string }[];
}

/** A started, initialized agent process, from which sessions are created. */
export interface AcpConnection {
  readonly spec: AcpAgentSpec;
  /** The program as this machine resolved it, for reports and errors. */
  readonly executable: string;
  /** Initialize the connection; the protocol allows it once, before any session. */
  initialize(): Promise<AcpInitializeResult>;
  /** Create a session, handing the agent the MCP servers that carry the unit's tools. */
  newSession(options: { cwd: string; mcpServers?: readonly AcpMcpServer[] }): Promise<AcpSession>;
  /** The last bytes the agent wrote on standard error, bounded. */
  stderr(): string;
  /** Stop the agent process and close the connection; safe to call twice. */
  close(): Promise<void>;
  /** Resolves when the connection closed, for whatever reason. */
  readonly closed: Promise<void>;
}

/** One MCP server to attach to a session, in the shapes the protocol defines. */
export type AcpMcpServer =
  | { name: string; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }
  | { name: string; url: string; type?: 'http' | 'sse'; headers?: Readonly<Record<string, string>> };

/** Options for connecting to one agent. */
export interface ConnectAcpOptions {
  /** The folder the agent runs in; made absolute before it is sent. */
  cwd: string;
  /** Extra environment for the child, merged over this process's. */
  env?: Readonly<Record<string, string>>;
  /** How long `initialize` may take, in milliseconds. */
  timeoutMs?: number;
  /** How long `session/new` may take, in milliseconds: an agent starts the session's MCP servers there. */
  sessionTimeoutMs?: number;
  /** Receives every update of every session, for progress; a session's own handler runs as well. */
  onUpdate?: (update: AcpUpdate) => void;
}

/** A failure of this module; its message names what failed and where. */
export class AcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** A session may start the unit's MCP servers before it answers, so it gets longer than `initialize`. */
const DEFAULT_SESSION_TIMEOUT_MS = 120_000;
/** The protocol's own error codes madarch acts on, from the v1 schema's `ErrorCode`. */
const REQUEST_CANCELLED = -32800;
const AUTHENTICATION_REQUIRED = -32000;
/** How much of the agent's standard error is kept for the failure that names it. */
const STDERR_LIMIT = 4_096;
/** How long the agent has to end after SIGTERM before SIGKILL, in milliseconds. */
const KILL_GRACE_MS = 2_000;

/**
 * The full path a program resolves to on this machine, or `undefined` when
 * there is none. Something that is executable but is not a file — a folder
 * that happens to carry the name, say — is no program and is refused here
 * rather than failing at the spawn.
 */
export function resolveExecutable(command: string, pathValue = process.env.PATH ?? ''): string | undefined {
  const runs = (path: string): boolean => {
    try {
      accessSync(path, fsConstants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes('/')) return runs(command) ? resolve(command) : undefined;
  for (const folder of pathValue.split(delimiter)) {
    if (!folder) continue;
    const candidate = resolve(folder, command);
    if (runs(candidate)) return candidate;
  }
  return undefined;
}

/** What madarch prints for a session's tokens: the agent's own figures, or that it named none. */
export function describeUsage(usage: AcpSessionUsage): string {
  if (!usage.reported) {
    return usage.turns === 0
      ? 'token usage not reported: no turn ran in this session'
      : `token usage not reported: the agent gave none in ${usage.turns} turn${usage.turns === 1 ? '' : 's'}`;
  }
  const parts = [`input ${usage.inputTokens ?? 'not reported'}`, `output ${usage.outputTokens ?? 'not reported'}`];
  if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens}`);
  if (usage.thoughtTokens !== undefined) parts.push(`thought ${usage.thoughtTokens}`);
  if (usage.cachedReadTokens !== undefined) parts.push(`cache read ${usage.cachedReadTokens}`);
  if (usage.cachedWriteTokens !== undefined) parts.push(`cache write ${usage.cachedWriteTokens}`);
  return parts.join(', ');
}

/**
 * Normalize one `session/update` payload. A variant the protocol defines but
 * madarch does not name — `notice`, `compaction_update`, a session's metadata —
 * is kept as `other` with its raw object rather than dropped, so a newer
 * agent's update stays visible to a reader. A variant outside the protocol's
 * own schema never reaches here: the library refuses it before dispatch and
 * the turn carries on (see the module note above).
 */
export function normalizeUpdate(update: unknown, at = new Date().toISOString()): AcpUpdate {
  const record = (update !== null && typeof update === 'object' ? update : {}) as Record<string, unknown>;
  const sessionUpdate = typeof record.sessionUpdate === 'string' ? record.sessionUpdate : 'unknown';
  const base: AcpUpdate = { kind: 'other', sessionUpdate, at, raw: update };
  const textOf = (value: unknown): string | undefined => {
    const content = value as { type?: unknown; text?: unknown } | undefined;
    return content !== null && typeof content === 'object' && content.type === 'text' && typeof content.text === 'string' ? content.text : undefined;
  };
  switch (sessionUpdate) {
    case 'agent_message_chunk': return { ...base, kind: 'message', text: textOf(record.content) };
    case 'agent_thought_chunk': return { ...base, kind: 'thought', text: textOf(record.content) };
    case 'user_message_chunk': return { ...base, kind: 'user-message', text: textOf(record.content) };
    case 'tool_call': return { ...base, kind: 'tool-call', toolCallId: stringOf(record.toolCallId), title: stringOf(record.title), status: stringOf(record.status), toolKind: stringOf(record.kind) };
    case 'tool_call_update': return { ...base, kind: 'tool-call-update', toolCallId: stringOf(record.toolCallId), title: stringOf(record.title), status: stringOf(record.status), toolKind: stringOf(record.kind) };
    case 'plan': return { ...base, kind: 'plan' };
    case 'current_mode_update': return { ...base, kind: 'mode' };
    case 'available_commands_update': return { ...base, kind: 'commands' };
    case 'config_option_update': return { ...base, kind: 'config' };
    case 'usage_update': {
      const cost = record.cost as { amount?: unknown; currency?: unknown } | undefined;
      const amount = typeof cost?.amount === 'number' ? cost.amount : undefined;
      const currency = typeof cost?.currency === 'string' ? cost.currency : undefined;
      return {
        ...base,
        kind: 'usage',
        contextUsed: typeof record.used === 'number' ? record.used : undefined,
        contextSize: typeof record.size === 'number' ? record.size : undefined,
        ...(amount !== undefined && currency !== undefined ? { cost: { amount, currency } } : {}),
      };
    }
    default: return base;
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The `mcpServers` of `session/new`, in the shapes the protocol defines. */
export function toMcpServers(servers: readonly AcpMcpServer[] = [], pathValue = process.env.PATH ?? ''): acp.McpServer[] {
  return servers.map((server): acp.McpServer => {
    if ('command' in server) {
      if (!server.command.trim()) throw new AcpError(`src/fill/acp.ts:toMcpServers: the MCP server ${JSON.stringify(server.name)} has no command to run`);
      // The protocol wants the executable's absolute path, and the agent runs
      // it in its own folder: a bare name is looked up here, never resolved
      // against madarch's folder, which the agent would not find it in.
      const executable = resolveExecutable(server.command, pathValue);
      if (executable === undefined) {
        throw new AcpError(`src/fill/acp.ts:toMcpServers: the MCP server ${JSON.stringify(server.name)} cannot be started: no program named ${JSON.stringify(server.command)} is executable on this machine (PATH ${JSON.stringify(pathValue)})`);
      }
      return {
        name: server.name,
        command: executable,
        args: [...(server.args ?? [])],
        env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
      };
    }
    if (!server.url.trim()) throw new AcpError(`src/fill/acp.ts:toMcpServers: the MCP server ${JSON.stringify(server.name)} has no url`);
    return {
      name: server.name,
      url: server.url,
      type: server.type ?? 'http',
      headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
    };
  });
}

/** A usage report as the protocol sends it, or `undefined` when it carried no number at all. */
function readUsage(value: unknown): AcpUsageReport | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const report: AcpUsageReport = {};
  let found = false;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens'] as const) {
    const amount = usage[key];
    if (typeof amount === 'number' && Number.isFinite(amount)) { report[key] = amount; found = true; }
  }
  return found ? report : undefined;
}

/**
 * Start an agent process and connect to it over ACP. The connection is not
 * initialized: call `initialize()` first, as the protocol requires. A program
 * that is not on this machine fails here, naming the name looked for and the
 * PATH searched.
 */
export async function connectAcpAgent(spec: AcpAgentSpec, options: ConnectAcpOptions): Promise<AcpConnection> {
  const cwd = resolve(options.cwd);
  const searchPath = options.env?.PATH ?? process.env.PATH ?? '';
  const executable = resolveExecutable(spec.command, searchPath);
  if (executable === undefined) {
    throw new AcpError(`src/fill/acp.ts:connectAcpAgent: the agent ${spec.id} cannot be started: no program named ${JSON.stringify(spec.command)} is executable on this machine (PATH ${JSON.stringify(searchPath)})`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  for (const [name, value] of [['timeoutMs', timeoutMs], ['sessionTimeoutMs', sessionTimeoutMs]] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new AcpError(`src/fill/acp.ts:connectAcpAgent: ${name} must be a positive number of milliseconds, not ${JSON.stringify(value)}`);
    }
  }
  // Detached puts the agent in its own process group, so closing ends the
  // helpers it started as well as itself.
  const child: ChildProcess = spawn(executable, [...(spec.args ?? [])], { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...options.env } });
  if (child.stdin === null || child.stdout === null) {
    child.kill('SIGKILL');
    throw new AcpError(`src/fill/acp.ts:connectAcpAgent: the agent ${spec.id} (${executable}) started without the pipes ACP needs`);
  }
  let stderrText = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderrText = (stderrText + chunk).slice(-STDERR_LIMIT); });

  /**
   * How the child ended. `exit` rather than `close` decides it: a grandchild
   * that inherited the pipes keeps `close` from firing, and an agent's helper
   * process must never hold madarch's close open. The whole process group is
   * signalled on close for the same reason.
   */
  let ended = false;
  /** Why the system refused to start the program at all, when it did (a bad interpreter, say). */
  let startFailure: string | undefined;
  const finished = new Promise<void>((settle) => {
    child.once('error', (error: Error) => { startFailure = error.message; ended = true; settle(); });
    child.once('exit', () => { ended = true; settle(); });
  });
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // No process group of its own (it was not detached) or it is already
      // gone: signal the process itself instead.
      try { child.kill(signal); } catch { /* already gone */ }
    }
  };

  interface SessionState {
    updates: AcpUpdate[];
    text: string[];
    onUpdate?: (update: AcpUpdate) => void;
    /** The last context window the agent reported, whenever it reported it. */
    context?: { used: number; size: number };
  }
  const sessions = new Map<string, SessionState>();
  let settleClosed: () => void = () => undefined;
  const closedPromise = new Promise<void>((settle) => { settleClosed = settle; });

  const app = acp.client({ name: 'madarch' })
    .onNotification(acp.methods.client.session.update, (context) => {
      const notification = context.params;
      const update = normalizeUpdate(notification.update);
      const session = sessions.get(notification.sessionId);
      if (session !== undefined) {
        session.updates.push(update);
        if (update.kind === 'message' && update.text !== undefined) session.text.push(update.text);
        if (update.kind === 'usage' && update.contextUsed !== undefined && update.contextSize !== undefined) session.context = { used: update.contextUsed, size: update.contextSize };
        session.onUpdate?.(update);
      }
      options.onUpdate?.(update);
    })
    // An agent's own file tools are off (decision 0026): it reads and writes
    // only through the unit's MCP server, so a permission request and a raw
    // file call are both refused here.
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'cancelled' as const } }))
    .onRequest(acp.methods.client.fs.readTextFile, () => {
      throw new Error('the agent called fs/read_text_file, which madarch does not offer: code is read through the session\'s MCP server');
    })
    .onRequest(acp.methods.client.fs.writeTextFile, () => {
      throw new Error('the agent called fs/write_text_file, which madarch does not offer: writes go through the session\'s MCP server');
    });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );
  const client = app.connect(stream);
  void client.closed.then(() => settleClosed());
  void finished.then(() => settleClosed());

  /**
   * One request, raised on failure as a plain error whose message is the
   * detail: the caller wraps it once, with the method, the agent and its path.
   * A `null` bound means no bound — a prompt turn may legitimately run for
   * minutes, and the unit's own limits end it (decision 0026).
   */
  async function request<T>(method: string, params: unknown, bound: number | null): Promise<T> {
    const call = client.agent.request(method, params as never) as Promise<T>;
    if (bound === null) return await call;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<never>((_never, refuse) => {
      timer = setTimeout(() => refuse(new Error(`it did not answer within ${bound} ms`)), bound);
    });
    try {
      return await Promise.race([call, timed]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Wrap a failure so it names the ACP method, the agent, the program's full
   * path and folder, how the process ended and the end of what it wrote on
   * standard error. A message this module already wrote is complete and is
   * returned as it is, so a reader is never shown the same sentence twice.
   */
  async function wrapped(error: unknown, method: string): Promise<Error> {
    if (error instanceof AcpError) return error;
    // How the child ended is part of the evidence, and it may still be
    // settling when the request rejects — a program that cannot exec, say.
    if (child.exitCode === null && child.signalCode === null && startFailure === undefined) {
      await Promise.race([finished, new Promise<void>((settle) => { const timer = setTimeout(settle, 100); timer.unref?.(); })]);
    }
    const detail = error instanceof Error ? error.message : String(error);
    const code = error instanceof acp.RequestError ? ` (protocol error ${error.code}${error.code === AUTHENTICATION_REQUIRED ? ': the agent requires authentication' : ''})` : '';
    const end = child.signalCode !== null
      ? `; the process was ended by ${child.signalCode}`
      : child.exitCode !== null
        ? `; the process exited with ${String(child.exitCode)}`
        : startFailure === undefined ? '' : `; the process could not start: ${startFailure}`;
    const text = stderrText.trim();
    const tail = text === '' ? '' : `; its standard error ended with: ${text}`;
    return new AcpError(`src/fill/acp.ts:${method}: the agent ${spec.id} (${executable}) in ${cwd} failed: ${detail}${code}${end}${tail}`);
  }

  let initialized: AcpInitializeResult | undefined;
  /** Set by `close()`: a turn in flight then ends as cancelled, since it was madarch that ended it. */
  let closing = false;

  const connection: AcpConnection = {
    spec,
    executable,
    closed: closedPromise,
    stderr: () => stderrText,
    async initialize() {
      if (initialized !== undefined) return initialized;
      let answer: acp.InitializeResponse;
      try {
        answer = await request<acp.InitializeResponse>(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'madarch', title: 'madarch', version: runningVersion() },
        }, timeoutMs);
      } catch (error) {
        throw await wrapped(error, 'initialize');
      }
      if (answer.protocolVersion !== acp.PROTOCOL_VERSION) {
        const refusal = await wrapped(new Error(`it answered protocol version ${String(answer.protocolVersion)}; madarch speaks version ${acp.PROTOCOL_VERSION}`), 'initialize');
        await connection.close();
        throw refusal;
      }
      const info = answer.agentInfo;
      const result: AcpInitializeResult = {
        protocolVersion: answer.protocolVersion,
        ...(info === undefined || info === null ? {} : { agentInfo: { ...(typeof info.name === 'string' ? { name: info.name } : {}), ...(typeof info.title === 'string' ? { title: info.title } : {}), ...(typeof info.version === 'string' ? { version: info.version } : {}) } }),
        agentCapabilities: (answer.agentCapabilities ?? {}) as Record<string, unknown>,
        authMethods: (answer.authMethods ?? []).map((method) => ({
          id: method.id,
          ...(typeof method.name === 'string' ? { name: method.name } : {}),
          ...(typeof method.description === 'string' ? { description: method.description } : {}),
        })),
      };
      initialized = result;
      return result;
    },
    async newSession(sessionOptions) {
      if (initialized === undefined) {
        throw new AcpError(`src/fill/acp.ts:newSession: the connection to ${spec.id} (${executable}) must be initialized before a session is created`);
      }
      // The protocol lets a session name its own absolute folder, and this
      // client does not narrow that: the folder the caller asks for is the one
      // the agent is sent.
      const sessionCwd = resolve(sessionOptions.cwd);
      const mcpServers = toMcpServers(sessionOptions.mcpServers ?? [], searchPath);
      const capabilities = (initialized.agentCapabilities.mcpCapabilities ?? {}) as { http?: unknown; sse?: unknown };
      for (const server of mcpServers) {
        const transport = 'url' in server ? (server.type ?? 'http') : undefined;
        if (transport === 'http' && capabilities.http !== true) {
          throw new AcpError(`src/fill/acp.ts:newSession: the agent ${spec.id} (${executable}) did not advertise the http MCP transport, so the MCP server ${JSON.stringify(server.name)} cannot be attached over http`);
        }
        if (transport === 'sse' && capabilities.sse !== true) {
          throw new AcpError(`src/fill/acp.ts:newSession: the agent ${spec.id} (${executable}) did not advertise the sse MCP transport, so the MCP server ${JSON.stringify(server.name)} cannot be attached over sse`);
        }
      }
      let answer: acp.NewSessionResponse;
      try {
        answer = await request<acp.NewSessionResponse>(acp.methods.agent.session.new, { cwd: sessionCwd, mcpServers }, sessionTimeoutMs);
      } catch (error) {
        throw await wrapped(error, 'session/new');
      }
      const sessionId = answer.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw await wrapped(new Error('it answered session/new without a session id'), 'session/new');
      }
      const state: SessionState = { updates: [], text: [] };
      sessions.set(sessionId, state);
      let turns = 0;
      let reports = 0;
      let last: AcpUsageReport | undefined;
      let inFlight = false;
      const session: AcpSession = {
        sessionId,
        modes: answer.modes,
        running: () => inFlight,
        usage() {
          return { ...(last ?? {}), reported: reports > 0, turns, reports, ...(state.context === undefined ? {} : { context: state.context }) };
        },
        async prompt(text, promptOptions) {
          if (inFlight) throw new AcpError(`src/fill/acp.ts:prompt: session ${sessionId} of ${spec.id} (${executable}) already has a prompt in flight`);
          if (!text.trim()) throw new AcpError(`src/fill/acp.ts:prompt: the prompt for session ${sessionId} of ${spec.id} (${executable}) is empty`);
          const signal = promptOptions?.signal;
          // A turn the caller gave up on before it was sent is no turn: nothing goes to the agent, and the end is the
          // cancel the caller asked for rather than a failure of an agent that was never asked.
          if (signal?.aborted === true) return { stopReason: 'cancelled', text: '', updates: [] };
          inFlight = true;
          state.updates = [];
          state.text = [];
          state.onUpdate = (update) => promptOptions?.onUpdate?.(update);
          const cancelled = (): AcpPromptResult => ({ stopReason: 'cancelled', text: state.text.join(''), updates: [...state.updates] });
          /** Whether the agent ended this turn itself: a bound that passes afterwards has nothing to cancel. */
          let settled = false;
          /**
           * The turn ran: counted once. A turn ended by the caller's bound ran as much as one the agent answered —
           * what the agent did not report is its usage, not the turn.
           */
          let counted = false;
          const countTurn = (): void => { if (!counted) { counted = true; turns += 1; } };
          /** The turn as the agent ends it, read the way this module reads an agent's end. */
          const answered = async (): Promise<AcpPromptResult> => {
            try {
              const answer = await request<acp.PromptResponse>(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }, null);
              countTurn();
              const usage = readUsage(answer.usage);
              if (usage !== undefined) { reports += 1; last = usage; }
              return { stopReason: String(answer.stopReason), text: state.text.join(''), ...(usage === undefined ? {} : { usage }), updates: [...state.updates] };
            } catch (error) {
              // A cancelled turn may end as the protocol's own `-32800` instead
              // of a `cancelled` stop reason, and a turn cut short by this
              // client's own close is a cancel too; all three mean the same to a
              // caller.
              if (closing || (error instanceof acp.RequestError && error.code === REQUEST_CANCELLED)) {
                countTurn();
                return { stopReason: 'cancelled', text: state.text.join(''), updates: [...state.updates] };
              }
              throw await wrapped(error, 'session/prompt');
            } finally {
              settled = true;
            }
          };
          /** The caller's own end of the turn: the protocol's cancel, and this client's answer without waiting. */
          let release: (() => void) | undefined;
          const ended = signal === undefined ? undefined : new Promise<AcpPromptResult>((settle) => {
            const onAbort = (): void => {
              // A turn the agent already ended is no turn to cancel: the bound arrived after the answer.
              if (settled) return;
              // `session/cancel` is a notification and an agent may answer it or not — and its write is queued behind
              // the prompt's own on this connection, which an agent that stopped reading its standard input never
              // drains. The turn therefore ends here, on the caller's word, and the cancel is sent behind it: a bound
              // that waited for a pipe would be no bound at all (madarch-tzte.38).
              void client.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => undefined);
              countTurn();
              settle(cancelled());
            };
            signal.addEventListener('abort', onAbort, { once: true });
            release = () => signal.removeEventListener('abort', onAbort);
          });
          try {
            const turn = answered();
            return ended === undefined ? await turn : await Promise.race([turn, ended]);
          } finally {
            release?.();
            inFlight = false;
            state.onUpdate = undefined;
          }
        },
        async cancel() {
          await client.agent.notify(acp.methods.agent.session.cancel, { sessionId });
        },
      };
      return session;
    },
    async close() {
      closing = true;
      sessions.clear();
      try { client.close(); } catch { /* already closed */ }
      // The group is signalled whether or not the agent itself ended: an agent
      // that crashed or exited on its own can leave the helpers it started
      // alive, and they hold this connection's pipes. Signalling a group with
      // no member left throws ESRCH, which the helper swallows.
      signalGroup('SIGTERM');
      // The grace timer is left to run: a helper that ignores SIGTERM is
      // killed two seconds after the close, and the signal finds nothing to
      // send when the group is empty.
      setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS).unref();
      if (!ended) await finished;
      // This process's own ends of the pipes are dropped as well, so nothing a
      // helper still holds can keep the event loop alive after close.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      settleClosed();
    },
  };
  return connection;
}
