/**
 * `madarch mcp`: the seven tools of decision 0032 served over the Model Context
 * Protocol on standard input and output (madarch-ztyq.10).
 *
 * The protocol half is the project's own (`src/fill/unit-mcp.ts`, hand-written
 * from the specification for the units' server), called here with this server's
 * tools and its own call: `initialize`, `ping`, `tools/list`, `tools/call`, and
 * nothing that writes.
 *
 * Standard output carries JSON-RPC lines and nothing else: a line of prose on it
 * would be a message no client can parse. Everything the server says to a person
 * — what it built, how long it took, which revision it serves — goes to standard
 * error.
 */
import { answerUnitMcpMessage, serveUnitMcp, type McpToolDefinition } from '../fill/unit-mcp.js';
import { runningVersion } from '../product/version.js';
import { REPO_TOOLS, type RepoToolAnswer } from './tools.js';
import { RECORD_TOOLS } from './records.js';
import { RepositoryRecordSession } from './record-session.js';
import { readFillProgressOf, type FillProgress } from '../obs/progress.js';
import { bytesOf } from '../obs/trace.js';
import { closeTrace, openTrace, runInTrace, withSpan, type TraceRun } from '../obs/trace.js';
import { graphFolder, mcpStateRoot } from './graph.js';
import { readRevision } from './git.js';
import { join } from 'node:path';

/** What this server calls itself in `initialize`, after the protocol's own fields. */
export const REPO_MCP_INFO: { readonly name: string; readonly version: string } = { name: 'madarch', version: runningVersion() };

/** Every tool this server serves: this step's five, then the seven of decision 0032 whose step has not run. */
const SERVED_TOOLS: readonly McpToolDefinition[] = [...RECORD_TOOLS, ...REPO_TOOLS];

/** The served tools' names, in the served order. */
export const SERVED_TOOL_NAMES: readonly string[] = SERVED_TOOLS.map((tool) => tool.name);

/**
 * A session that is still opening: `initialize` and `tools/list` answer from the
 * tool list, which needs no graph, and a tool call answers that the graph is
 * building rather than making the client wait for a build inside its own
 * timeout (madarch-ztyq.10 review).
 */
export interface PendingRepository {
  readonly repository: string;
  readonly ready: Promise<ToolCalling>;
  /** The fill's state so far, read from its trace: what the `graph building` answer says. */
  readonly progress?: () => FillProgress;
}

/**
 * What answers a tool call: one session, whichever store it reads. The served
 * session reads this step's record store (`RepositoryRecordSession`); a caller
 * that hands its own session keeps the same shape, so the protocol layer is the
 * same over either.
 */
interface ToolCalling {
  call(tool: string, argumentsValue: unknown): Promise<RepoToolAnswer>;
  close(): Promise<void>;
}

/** What answers the protocol: a session that is open, or one that is still opening. */
export type RepositoryProvider = ToolCalling | PendingRepository;

/** The answer a tool call gets while its graph is being built. */
function buildingAnswer(repository: string, progress?: FillProgress): Record<string, unknown> {
  return {
    source: {
      repository, commit: null, branch: null, at: new Date().toISOString(), dirty: [], reextracted: [], building: true,
      ...(progress === undefined ? {} : { progress }),
    },
    error: { code: 'graph-building', message: 'graph building: the graph of this repository is still being built; call the tool again in a moment' },
  };
}

/**
 * The answer a tool call gets once the start has failed for good: the failure is kept and reported on every call,
 * with the reason the start gave rather than a progress note a client would keep retrying (madarch-ztyq.10
 * recheck). A start that failed does not become servable by waiting.
 */
function failedAnswer(repository: string, failure: unknown): Record<string, unknown> {
  const message = failure instanceof Error ? failure.message : String(failure);
  return {
    source: { repository, commit: null, branch: null, at: new Date().toISOString(), dirty: [], reextracted: [], building: false },
    error: { code: 'startup-failed', message },
  };
}

/** What a provider holds now: an open session, a start still in flight, or a start that failed for good. */
type Opened = { readonly session: ToolCalling } | { readonly failure: unknown } | { readonly opening: true };

/**
 * The session a provider holds now, without waiting for one that is still
 * opening: a `ready` promise that has already settled is read — as a session or
 * as the failure it settled with — and one that has not settled is not waited
 * for.
 */
async function openSession(provider: RepositoryProvider): Promise<Opened> {
  if (!('ready' in provider)) return { session: provider };
  let opened: Opened = { opening: true };
  provider.ready.then((one) => { opened = { session: one }; }, (error: unknown) => { opened = { failure: error }; });
  // A promise that already settled queues its continuation before this one, so one await is enough to read it.
  await Promise.resolve();
  return opened;
}

/** The result one tool call answers, whether its session is open, opening or failed. */
async function answerCall(repository: string, provider: RepositoryProvider, tool: string, argumentsValue: unknown, traced?: TraceRun): Promise<{ answer: Record<string, unknown>; isError: boolean }> {
  const answer = async (): Promise<{ answer: Record<string, unknown>; isError: boolean }> => {
    const opened = await openSession(provider);
    if ('failure' in opened) return { answer: failedAnswer(repository, opened.failure), isError: true };
    if ('opening' in opened) return { answer: buildingAnswer(repository, 'ready' in provider ? provider.progress?.() : undefined), isError: false };
    const answered = await opened.session.call(tool, argumentsValue);
    return { answer: answered.answer as Record<string, unknown>, isError: answered.isError };
  };
  if (traced === undefined) return await answer();
  // Each tool call is one span of the server's own trace: the tool, whether it answered or failed, and the bytes it said.
  return await runInTrace(traced, async () => await withSpan('mcp.tool', { 'mcp.tool': tool }, async (span) => {
    const answered = await answer();
    span.setAttribute('mcp.isError', answered.isError);
    span.setAttribute('mcp.answerBytes', bytesOf(answered.answer));
    return answered;
  }));
}

/** What a run of the server reads and writes; the process's own streams unless a test names others. */
export interface RepositoryMcpOptions {
  /** The checkout to serve. */
  readonly repository: string;
  /** The folder the graph and the journal are kept in. */
  readonly folder?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly input?: AsyncIterable<string | Uint8Array>;
  readonly output?: { write(text: string): void };
  readonly errorOutput?: { write(text: string): void };
}

/**
 * Serves one repository until the input ends.
 *
 * The session opens in the background and the stream starts at once: the
 * handshake and the tool list answer without a graph, and a tool call made while
 * the graph is building says so instead of making the client wait for the build
 * (madarch-ztyq.10 review). The build's progress is said on standard error.
 */
export async function serveRepositoryMcp(options: RepositoryMcpOptions): Promise<number> {
  const stderr = options.errorOutput ?? process.stderr;
  const log = (line: string): void => { stderr.write(`${line}\n`); };
  const folder = options.folder ?? graphFolder(options.repository, mcpStateRoot(options.env));
  // The fill's own trace is written beside the store as it happens, and the building answer reads
  // that run's file by its id: a person sees how far the fill is without opening the store, and the
  // server's own trace (its tool calls) cannot be mistaken for the fill's. A checkout that is
  // already filled writes no run, and the answer then carries no progress.
  const head = readRevision(options.repository).commit.slice(0, 12);
  const progress = (): FillProgress => readFillProgressOf(folder, `mcp-${head}`);
  const sessionTrace = openTrace({ store: folder, runId: `mcp-${String(process.pid)}` });
  // The served store is this step's record store, filled by the one runner: the five tools answer
  // from it, and the tools of the later steps say their step has not run.
  const ready = RepositoryRecordSession.open({
    repository: options.repository,
    folder,
    log,
  });
  let failure: unknown;
  ready.then((session) => {
    const revision = session.current;
    log(`madarch mcp: serving ${revision.commit.slice(0, 12)}${revision.dirty.length === 0 ? '' : ` with ${revision.dirty.length} changed file(s)`}; tools: ${SERVED_TOOL_NAMES.join(', ')}`);
  }, (error: unknown) => { failure = error; log(error instanceof Error ? error.message : String(error)); });
  const provider: PendingRepository = { repository: options.repository, ready, progress };
  try {
    await serveUnitMcp({
      tools: [...RECORD_TOOLS, ...REPO_TOOLS] as readonly McpToolDefinition[],
      info: REPO_MCP_INFO,
      call: (tool, argumentsValue) => answerCall(options.repository, provider, tool, argumentsValue, sessionTrace),
      streams: { input: options.input ?? process.stdin, write: (text: string) => { (options.output ?? process.stdout).write(text); } },
    });
  } finally {
    await ready.then(async (session) => { await session.close(); }, () => undefined);
    closeTrace(sessionTrace);
  }
  return failure === undefined ? 0 : 2;
}

/**
 * Answers one message of a session that is already open, or of one that is still
 * opening, as the transport does.
 */
export async function answerRepositoryMcpMessage(message: unknown, provider: RepositoryProvider, info: { name: string; version: string } = REPO_MCP_INFO): Promise<Record<string, unknown> | null> {
  return await answerUnitMcpMessage(message, {
    tools: SERVED_TOOLS,
    info,
    call: (tool, argumentsValue) => answerCall('ready' in provider ? provider.repository : '', provider, tool, argumentsValue),
  });
}
