/**
 * The unit's MCP server as a program of its own (`madarch mcp-unit`;
 * madarch-tzte.22.2): the process an agent starts through the ACP session's
 * `mcpServers` (`src/fill/unit-mcp.ts` speaks the protocol on its standard input
 * and output), and a thin proxy to the host that owns the database (decision
 * 0026: "The background server owns the database and is its only writer; the
 * units' MCP servers are thin proxies to it").
 *
 * It carries three things and nothing else: the host's address, the token that
 * names one unit's session, and the proxy's own bound. No database, no snapshot,
 * no scope, no limits of its own — so it can answer nothing the host does not
 * answer for it, and it cannot widen what its unit may read or write.
 *
 * A host that cannot be reached, answers a status other than 200, or does not
 * answer within the bound is a tool failure the agent reads: the call is answered
 * with `isError` and a message naming the address, the status and what the host
 * said. A tool call never ends this server's loop, and a host's silence never
 * leaves the agent waiting without an answer.
 */
import { serveUnitMcp } from './unit-mcp.js';
import { UNIT_TOOL_TOKEN_VARIABLE, UNIT_TOOL_URL_VARIABLE, type UnitToolAnswer } from './unit-tools.js';

/**
 * How long one proxied call may take before it is given up on, in milliseconds:
 * a read of a large graph and a write that reads its cited bytes both take
 * seconds, and a minute is far past either while still ending a dead host's call
 * inside a unit's own ten minutes (0026's limit).
 */
export const UNIT_TOOL_TIMEOUT_MS = 60_000;

/** What the started server needs from its environment. */
export interface UnitToolEnvironment {
  /** The address the host answers a tool call at. */
  readonly url: string;
  /** The token naming this server's unit session. */
  readonly token: string;
}

/** Reads the host's address and the session's token, or says which variable is missing or unusable. */
export function unitToolEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): UnitToolEnvironment | string {
  const url = env[UNIT_TOOL_URL_VARIABLE];
  const token = env[UNIT_TOOL_TOKEN_VARIABLE];
  if (typeof url !== 'string' || url.trim() === '') {
    return `the unit's MCP server cannot start: ${UNIT_TOOL_URL_VARIABLE} names the address its host answers tool calls at, and it is ${JSON.stringify(url)} (src/fill/unit-mcp-server.ts)`;
  }
  if (typeof token !== 'string' || token.trim() === '') {
    return `the unit's MCP server cannot start: ${UNIT_TOOL_TOKEN_VARIABLE} names the unit session this server answers for, and it is ${JSON.stringify(token)} (src/fill/unit-mcp-server.ts)`;
  }
  return { url, token };
}

/** What one proxied call is sent and read as, over the host's own JSON answer. */
export interface UnitToolProxyOptions {
  /** The host's address, as the environment named it. */
  readonly url: string;
  /** The session's token. */
  readonly token: string;
  /** How long one call may take; `UNIT_TOOL_TIMEOUT_MS` when it is left out. */
  readonly timeoutMs?: number;
  /** The runtime's own `fetch`; given here so a test can answer without a server. */
  readonly fetch?: typeof fetch;
}

/** One answer a proxy could not get: the agent reads it as the tool failing, never as a hung call. */
function unreachable(url: string, what: string): UnitToolAnswer {
  return {
    answer: { error: { code: 'unreachable', message: `the unit's tools could not be answered at ${url}: ${what} (src/fill/unit-mcp-server.ts)` } },
    isError: true,
  };
}

/**
 * The forwarder the protocol layer calls for every tool call: one POST to the
 * host, whose answer is the tool's own. Every way it can go wrong is an answer
 * the agent reads — the address, the status and the host's own words — so a tool
 * call never fails the server's loop and never hangs it.
 */
export function unitToolProxy(options: UnitToolProxyOptions): (tool: string, argumentsValue: unknown) => Promise<UnitToolAnswer> {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? UNIT_TOOL_TIMEOUT_MS;
  return async (tool, argumentsValue) => {
    let response: Response;
    try {
      response = await send(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: options.token, tool, arguments: argumentsValue }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      return unreachable(options.url, `the request failed after at most ${timeoutMs} ms: ${reason}`);
    }
    const text = await response.text().catch(() => '');
    if (response.status !== 200) {
      return unreachable(options.url, `the host answered ${response.status}${text === '' ? '' : ` with ${text}`}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (failure) {
      return unreachable(options.url, `the host's answer is no JSON: ${(failure as Error).message}`);
    }
    const held = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
    if (typeof held['isError'] !== 'boolean' || held['answer'] === undefined) {
      return unreachable(options.url, `the host's answer holds no tool answer and no error flag: ${JSON.stringify(parsed).slice(0, 500)}`);
    }
    return { answer: held['answer'], isError: held['isError'] };
  };
}

/**
 * The program's own entry: reads its environment, serves the protocol on this
 * process's standard input and output, and answers the exit code — 0 when the
 * input ended, 2 when the environment names no host or no session.
 */
export async function serveUnitMcpServer(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly input?: AsyncIterable<string | Uint8Array>;
  readonly output?: { write(text: string): void };
  readonly errorOutput?: { write(text: string): void };
  readonly timeoutMs?: number;
} = {}): Promise<number> {
  const env = options.env ?? process.env;
  const read = unitToolEnvironment(env);
  if (typeof read === 'string') {
    (options.errorOutput ?? process.stderr).write(`${read}\n`);
    return 2;
  }
  await serveUnitMcp({
    call: unitToolProxy({ url: read.url, token: read.token, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }),
    streams: { input: options.input ?? process.stdin, write: (text: string) => { (options.output ?? process.stdout).write(text); } },
  });
  return 0;
}
