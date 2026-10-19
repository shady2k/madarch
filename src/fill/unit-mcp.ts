/**
 * The Model Context Protocol, as one unit's server speaks it (decision 0026,
 * "Agents and tools"; madarch-tzte.22.2): the stdio transport, hand-written from
 * the protocol's own specification (revisions 2025-06-18, 2025-03-26 and
 * 2024-11-05) rather than built on a library, for the reason the fake ACP agent
 * is hand-written: a test proves madarch speaks the protocol and not merely that
 * it agrees with itself.
 *
 * What a unit's server must answer, and nothing more:
 *
 * - `initialize`, with the protocol version, the one capability this server has
 *   (tools) and its own name and version. The version answered is the client's
 *   own when this build knows it and the newest this build knows otherwise, which
 *   is the specification's rule for a version a server does not support.
 * - `notifications/initialized`, and every other notification: nothing. A
 *   notification is answered by no message, whether or not it is one this server
 *   knows (`notifications/cancelled` included: the host's own reads run to their
 *   end, and a cancellation a tool cannot honour is not one it may pretend to).
 * - `tools/list`: the unit's tools, each with its name, what it is for and the
 *   JSON schema of its arguments.
 * - `tools/call`: one tool of the catalogue, answered with one text content block
 *   holding the tool's answer as JSON. A tool that refused what it was asked — a
 *   write the checks refused, an argument of no shape a tool takes — is answered
 *   as a *result* with `isError: true` and the refusal's own words, because the
 *   specification's rule is that a tool's own failure is content the model reads,
 *   not a protocol error that ends the call. A name that is no tool of this
 *   server, and a `tools/call` with no name at all, are protocol errors
 *   (`-32602`), since no tool was called.
 * - `ping`: an empty result, as the protocol asks of every server.
 * - Anything else: `-32601`, naming the method and what this server offers. This
 *   server declares no resources, no prompts and no logging, so it never answers
 *   their lists (a server that answered an empty list would claim it holds none).
 *
 * Framing: one JSON-RPC 2.0 message per line, as the stdio transport specifies —
 * no embedded newlines, and nothing but messages on this server's standard
 * output. Its own failures go to standard error, never into the stream: one stray
 * line there is a protocol error the agent reports as madarch's fault.
 */
import { runningVersion } from '../product/version.js';
import { UNIT_TOOL_NAMES, UNIT_TOOLS, type UnitToolAnswer, type UnitToolDefinition } from './unit-tools.js';

/** The protocol revisions this server knows, newest first. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** The version this server answers a client whose own version it does not know. */
export const MCP_FALLBACK_VERSION = MCP_PROTOCOL_VERSIONS[0];

/** What this server says it is, in `initialize`'s answer. */
export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

/** The server's own name and version, as an agent is told them. */
export const UNIT_MCP_INFO: McpServerInfo = { name: 'madarch-unit', version: runningVersion() };

/** What a message answers a tool call with: the host this server proxies to (`createUnitToolsHost`). */
export type UnitToolCallForwarder = (tool: string, argumentsValue: unknown) => Promise<UnitToolAnswer>;

/** What this server serves and how one call is answered. */
export interface UnitMcpOptions {
  /** The tools `tools/list` answers; the unit's catalogue unless a caller names its own. */
  readonly tools?: readonly UnitToolDefinition[];
  /** Where a tool call goes: the host that owns the database. */
  readonly call: UnitToolCallForwarder;
  /** What this server is called and which version it is; `madarch-unit` and this build's version by default. */
  readonly info?: McpServerInfo;
}

/** One JSON-RPC message as this server reads it. */
export interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

/** One JSON-RPC error's own fields, as the specification numbers them. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** One answer this server writes: a JSON-RPC response, or nothing at all. */
type McpAnswer = Record<string, unknown>;

/** A result answer to one request. */
function result(id: unknown, value: unknown): McpAnswer {
  return { jsonrpc: '2.0', id, result: value };
}

/** An error answer to one request. */
function error(id: unknown, code: number, message: string): McpAnswer {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** The protocol version this server answers one client's requested version with. */
export function answeredVersion(requested: unknown): string {
  return (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested) ? requested as string : MCP_FALLBACK_VERSION;
}

/** The tools `tools/list` answers, in the catalogue's own order, each with its own schema. */
function listed(tools: readonly UnitToolDefinition[]): readonly Record<string, unknown>[] {
  return tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

/**
 * Answers one message. `null` means this message earns no answer at all: a
 * notification, a response to a request this server never sends, or a message so
 * malformed that it names no id to answer to.
 */
export async function answerUnitMcpMessage(message: unknown, options: UnitMcpOptions): Promise<McpAnswer | null> {
  const tools = options.tools ?? UNIT_TOOLS;
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return error(null, INVALID_REQUEST, 'a message of the Model Context Protocol is a JSON-RPC 2.0 object (src/fill/unit-mcp.ts)');
  }
  const held = message as JsonRpcMessage;
  if (held.jsonrpc !== '2.0') {
    return held.id === undefined ? null : error(held.id, INVALID_REQUEST, `the message names jsonrpc ${JSON.stringify(held.jsonrpc)}: a JSON-RPC 2.0 message names "2.0" (src/fill/unit-mcp.ts)`);
  }
  // A message with an id but no method answers a request this server never made: nothing to say.
  if (held.method === undefined) return null;
  if (held.id === undefined) return null;
  const method = held.method;
  if (typeof method !== 'string') return error(held.id, INVALID_REQUEST, `the message names the method ${JSON.stringify(method)}: a method is a text, like "tools/call"`);
  const params = typeof held.params === 'object' && held.params !== null && !Array.isArray(held.params) ? held.params as Record<string, unknown> : {};
  switch (method) {
    case 'initialize':
      return result(held.id, {
        protocolVersion: answeredVersion(params['protocolVersion']),
        capabilities: { tools: { listChanged: false } },
        serverInfo: options.info ?? UNIT_MCP_INFO,
      });
    case 'ping':
      return result(held.id, {});
    case 'tools/list':
      return result(held.id, { tools: listed(tools) });
    case 'tools/call': {
      const name = params['name'];
      if (typeof name !== 'string' || name === '') {
        return error(held.id, INVALID_PARAMS, `tools/call names the tool ${JSON.stringify(name)}: a call names the tool it calls, one of ${tools.map((tool) => tool.name).join(', ')}`);
      }
      if (tools.some((tool) => tool.name === name) === false) {
        return error(held.id, INVALID_PARAMS, `${JSON.stringify(name)} is no tool of this server: the tools are ${tools.map((tool) => tool.name).join(', ')} (src/fill/unit-tools.ts)`);
      }
      const answered = await options.call(name, params['arguments']);
      // The answer's own JSON is the content block, compact: the caps a read answers within are counts of
      // the answer's own text, and a pretty-printed copy would be a longer text than the one they bounded.
      return result(held.id, { content: [{ type: 'text', text: JSON.stringify(answered.answer) }], isError: answered.isError });
    }
    default:
      return error(held.id, METHOD_NOT_FOUND, `${JSON.stringify(method)} is no method of this server: it offers initialize, ping, tools/list and tools/call, and the tools are ${UNIT_TOOL_NAMES.join(', ')}`);
  }
}

/** What a served stream looks like: lines in, lines out. */
export interface McpStreams {
  /** The messages as they arrive: each chunk is text or bytes, and a message ends at a newline. */
  readonly input: AsyncIterable<string | Uint8Array>;
  /** Where the answers go: one line per message. */
  write(text: string): void;
}

/**
 * Serves the protocol over one pair of streams until the input ends. A message
 * that does not parse is answered with the parse error the specification names
 * (when it named an id, which a text that does not parse cannot), and one call's
 * failure never ends the loop: the unit's session goes on serving what it can.
 */
export async function serveUnitMcp(options: UnitMcpOptions & { readonly streams: McpStreams }): Promise<void> {
  let pending = '';
  const decode = new TextDecoder();
  const answer = (message: McpAnswer): void => { options.streams.write(`${JSON.stringify(message)}\n`); };
  const handleLine = async (line: string): Promise<void> => {
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (parseFailure) {
      answer(error(null, PARSE_ERROR, `the line ${JSON.stringify(line)} is no JSON-RPC message: ${(parseFailure as Error).message} (src/fill/unit-mcp.ts)`));
      return;
    }
    const answered = await answerUnitMcpMessage(parsed, options);
    if (answered !== null) answer(answered);
  };
  for await (const chunk of options.streams.input) {
    pending += typeof chunk === 'string' ? chunk : decode.decode(chunk, { stream: true });
    let cut = pending.indexOf('\n');
    while (cut >= 0) {
      const line = pending.slice(0, cut);
      pending = pending.slice(cut + 1);
      await handleLine(line);
      cut = pending.indexOf('\n');
    }
  }
  // A last message with no newline after it is still a message the client sent.
  if (pending.trim() !== '') await handleLine(pending);
}
