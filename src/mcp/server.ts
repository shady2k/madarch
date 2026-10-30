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
 * Serves one repository until the input ends. The session is opened before the
 * first message, so a client's first `tools/call` does not pay for the graph
 * build inside its own timeout: the build's progress is said on standard error.
 */
export async function serveRepositoryMcp(options: RepositoryMcpOptions): Promise<number> {
  const stderr = options.errorOutput ?? process.stderr;
  const log = (line: string): void => { stderr.write(`${line}\n`); };
  let session: RepositorySession;
  try {
    session = await RepositorySession.open({
      repository: options.repository,
      ...(options.folder === undefined ? {} : { folder: options.folder }),
      ...(options.env === undefined ? {} : { env: options.env }),
      log,
    });
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const revision = session.current;
  log(`madarch mcp: serving ${revision.branch} at ${revision.commit.slice(0, 12)}${revision.dirty.length === 0 ? '' : ` with ${revision.dirty.length} changed file(s)`}; tools: ${REPO_TOOL_NAMES.join(', ')}`);
  try {
    await serveUnitMcp({
      tools: REPO_TOOLS as readonly McpToolDefinition[],
      info: REPO_MCP_INFO,
      call: async (tool, argumentsValue) => {
        const answered = await session.call(tool, argumentsValue);
        return { answer: answered.answer, isError: answered.isError };
      },
      streams: { input: options.input ?? process.stdin, write: (text: string) => { (options.output ?? process.stdout).write(text); } },
    });
  } finally {
    await session.close();
  }
  return 0;
}

/** Answers one message of a session that is already open, as the transport does. */
export async function answerRepositoryMcpMessage(message: unknown, session: RepositorySession, info: { name: string; version: string } = REPO_MCP_INFO): Promise<Record<string, unknown> | null> {
  return await answerUnitMcpMessage(message, {
    tools: REPO_TOOLS,
    info,
    call: async (tool, argumentsValue) => {
      const answered = await session.call(tool, argumentsValue);
      return { answer: answered.answer, isError: answered.isError };
    },
  });
}
