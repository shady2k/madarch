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
import { REPO_TOOL_NAMES, REPO_TOOLS, callRepoTool } from './tools.js';
import { RepositorySession } from './session.js';

/** What this server calls itself in `initialize`, after the protocol's own fields. */
export const REPO_MCP_INFO: { readonly name: string; readonly version: string } = { name: 'madarch', version: runningVersion() };

/**
 * A session that is still opening: `initialize` and `tools/list` answer from the
 * tool list, which needs no graph, and a tool call answers that the graph is
 * building rather than making the client wait for a build inside its own
 * timeout (madarch-ztyq.10 review).
 */
export interface PendingRepository {
  readonly repository: string;
  readonly ready: Promise<RepositorySession>;
}

/** What answers the protocol: a session that is open, or one that is still opening. */
export type RepositoryProvider = RepositorySession | PendingRepository;

/** The answer a tool call gets while its graph is being built. */
function buildingAnswer(repository: string): Record<string, unknown> {
  return {
    source: { repository, commit: null, branch: null, at: new Date().toISOString(), dirty: [], reextracted: [], building: true },
    error: { code: 'graph-building', message: 'graph building: the graph of this repository is still being built; call the tool again in a moment' },
  };
}

/**
 * The answer a tool call gets once the start has failed for good: the failure is kept and reported on every call,
 * with the reason the start gave — a count, a bound, what to serve instead — rather than a progress note a client
 * would keep retrying (madarch-ztyq.10 recheck). A tree too large to build cold, with no graph to reuse, never
 * becomes servable by waiting.
 */
function failedAnswer(repository: string, failure: unknown): Record<string, unknown> {
  const message = failure instanceof Error ? failure.message : String(failure);
  return {
    source: { repository, commit: null, branch: null, at: new Date().toISOString(), dirty: [], reextracted: [], building: false },
    error: { code: 'startup-failed', message },
  };
}

/** What a provider holds now: an open session, a start still in flight, or a start that failed for good. */
type Opened = { readonly session: RepositorySession } | { readonly failure: unknown } | { readonly opening: true };

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
async function answerCall(repository: string, provider: RepositoryProvider, tool: string, argumentsValue: unknown): Promise<{ answer: Record<string, unknown>; isError: boolean }> {
  const opened = await openSession(provider);
  if ('failure' in opened) return { answer: failedAnswer(repository, opened.failure), isError: true };
  if ('opening' in opened) return { answer: buildingAnswer(repository), isError: false };
  const answered = await opened.session.call(tool, argumentsValue);
  return { answer: answered.answer as Record<string, unknown>, isError: answered.isError };
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
  const ready = RepositorySession.open({
    repository: options.repository,
    ...(options.folder === undefined ? {} : { folder: options.folder }),
    ...(options.env === undefined ? {} : { env: options.env }),
    log,
  });
  let failure: unknown;
  ready.then((session) => {
    const revision = session.current;
    log(`madarch mcp: serving ${revision.branch} at ${revision.commit.slice(0, 12)}${revision.dirty.length === 0 ? '' : ` with ${revision.dirty.length} changed file(s)`}; tools: ${REPO_TOOL_NAMES.join(', ')}`);
  }, (error: unknown) => { failure = error; log(error instanceof Error ? error.message : String(error)); });
  const provider: PendingRepository = { repository: options.repository, ready };
  try {
    await serveUnitMcp({
      tools: REPO_TOOLS as readonly McpToolDefinition[],
      info: REPO_MCP_INFO,
      call: (tool, argumentsValue) => answerCall(options.repository, provider, tool, argumentsValue),
      streams: { input: options.input ?? process.stdin, write: (text: string) => { (options.output ?? process.stdout).write(text); } },
    });
  } finally {
    await ready.then(async (session) => { await session.close(); }, () => undefined);
  }
  return failure === undefined ? 0 : 2;
}

/**
 * Answers one message of a session that is already open, or of one that is still
 * opening, as the transport does.
 */
export async function answerRepositoryMcpMessage(message: unknown, provider: RepositoryProvider, info: { name: string; version: string } = REPO_MCP_INFO): Promise<Record<string, unknown> | null> {
  return await answerUnitMcpMessage(message, {
    tools: REPO_TOOLS,
    info,
    call: (tool, argumentsValue) => answerCall('ready' in provider ? provider.repository : '', provider, tool, argumentsValue),
  });
}
