/**
 * The real writer agent: a coding agent driven over ACP (decision 0026).
 *
 * One agent process serves the whole run; every unit gets a session of its
 * own whose only tools are this unit's, served by a local HTTP MCP endpoint
 * bound to one token (the unit's `UnitTools` session). The agent's own file
 * tools stay off (`connectAcpAgent` refuses `fs/*` and every permission), the
 * session's working folder is an empty scratch folder, and the unit's limits
 * are decision 0026's: a 272K window with a wrap-up at 70% and a stop at 80%,
 * about 30 turns, ten minutes, 16K output.
 *
 * The cost of a run is one session per unit: a product unit, then one unit
 * per declared domain.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectAcpAgent, type AcpConnection, type AcpAgentSpec, type AcpRefusal, type AcpUpdate } from '../fill/acp.js';
import { answerUnitMcpMessage } from '../fill/unit-mcp.js';
import { DEFAULT_STAGE_LIMITS, type StageLimits } from '../fill/stage.js';
import { createUnitLimitGuard, PROCESS_TIMERS, watchUnitTimeLimit, type UnitLimitCause, type UnitTimers } from '../fill/unit-limits.js';
import type { Journal, JournalContext, JournalEntry } from './journal.js';
import type { ToolClient, UnitAgent, UnitRequest } from './run.js';
import type { ToolAnswer } from './tools.js';

export interface AcpAgentOptions {
  readonly spec: AcpAgentSpec;
  readonly limits?: StageLimits;
  /** Environment for the agent process (its PATH must reach the adapter's binary). */
  readonly env?: Readonly<Record<string, string>>;
  readonly timers?: UnitTimers;
  readonly progress?: (line: string) => void;
  /** Where every call the agent makes, and every request madarch refuses, is recorded (madarch-m38l.13). */
  readonly journal?: Journal;
}

/** What `serveTools` tells the journal about the agent's requests. */
export interface ToolObserver {
  /** A call the unit's tools answered (or raised on). */
  served(call: { readonly tool: string; readonly arguments: unknown; readonly answer: ToolAnswer | undefined; readonly error?: string; readonly startedAt: Date; readonly durationMs: number }): void;
  /** A `tools/call` the endpoint answered with a protocol error: no tool of this unit has that name. */
  rejected(call: { readonly tool: string | null; readonly arguments: unknown; readonly message: string; readonly startedAt: Date }): void;
}

const FAILURE_CODES = new Set(['tool-failed', 'worker-gone']);

/** The reason in words that a refused or failed answer gives, with the rule and line of a refused page. */
export function reasonOf(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null;
  const held = answer as { refused?: unknown; error?: unknown; problems?: unknown };
  if (Array.isArray(held.refused)) return held.refused.map((r: { line?: unknown; rule?: unknown; message?: unknown }) => `line ${String(r.line)} ${String(r.rule)}: ${String(r.message)}`).join('\n');
  if (typeof held.error === 'object' && held.error !== null) {
    const error = held.error as { code?: unknown; message?: unknown };
    return `${String(error.code)}: ${String(error.message)}`;
  }
  if (typeof held.error === 'string') return held.error;
  return null;
}

/** The journal entry for a call the tools answered. */
export function entryOfCall(call: Parameters<ToolObserver['served']>[0]): JournalEntry {
  const answer = call.answer;
  const isError = answer === undefined ? true : answer.isError;
  const code = answer !== undefined && typeof answer.answer === 'object' && answer.answer !== null ? (answer.answer as { error?: { code?: unknown } | string }).error : undefined;
  const failed = answer === undefined || (isError && typeof code === 'object' && code !== null && FAILURE_CODES.has(String(code.code)));
  return {
    kind: 'tool-call',
    tool: call.tool,
    arguments: call.arguments,
    response: answer === undefined ? null : JSON.stringify(answer.answer),
    isError,
    outcome: !isError ? 'ok' : failed ? 'failed' : 'refused',
    reason: call.error ?? (isError ? reasonOf(answer?.answer) : null),
    startedAt: call.startedAt,
    durationMs: call.durationMs,
  };
}

const CHARACTERS_PER_TOKEN = 4;

/** A local MCP endpoint (streamable HTTP, one JSON answer per POST) for one unit's tools. */
export async function serveTools(client: ToolClient, token: string, observer?: ToolObserver): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const send = (status: number, body?: unknown): void => {
      response.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (request.method !== 'POST') { send(405, { error: 'the unit endpoint answers POST only' }); return; }
    if (request.headers['authorization'] !== `Bearer ${token}`) { send(401, { error: 'unknown unit token' }); return; }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        try {
          await handle();
        } catch (error) {
          // A journal that cannot be written ends the request in words; the unit is never left waiting for an answer.
          if (!response.headersSent) send(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        }
      })();
      async function handle(): Promise<void> {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'the body is no JSON' } });
          return;
        }
        const known = new Set(client.definitions.map((tool) => tool.name));
        const call = async (tool: string, args: unknown): Promise<ToolAnswer> => {
          const startedAt = new Date();
          const began = performance.now();
          let answer: ToolAnswer;
          try {
            answer = await client.call(tool, args);
          } catch (error) {
            observer?.served({ tool, arguments: args, answer: undefined, error: error instanceof Error ? error.message : String(error), startedAt, durationMs: performance.now() - began });
            throw error;
          }
          observer?.served({ tool, arguments: args, answer, startedAt, durationMs: performance.now() - began });
          return answer;
        };
        // A tools/call for a name this unit does not have is a protocol error the endpoint answers itself: no call, but a refusal on record.
        for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
          const held = message as { method?: unknown; id?: unknown; params?: { name?: unknown; arguments?: unknown } } | null;
          if (typeof held !== 'object' || held === null || held.method !== 'tools/call' || held.id === undefined) continue;
          const name = held.params?.name;
          if (typeof name === 'string' && name !== '' && known.has(name)) continue;
          observer?.rejected({ tool: typeof name === 'string' ? name : null, arguments: held.params?.arguments ?? null, message: `${JSON.stringify(name ?? null)} is no tool of this unit: the tools are ${[...known].join(', ')}`, startedAt: new Date() });
        }
        const options = { tools: client.definitions, call, info: { name: 'madarch-writer', version: '1' } };
        if (Array.isArray(parsed)) {
          const answers = (await Promise.all(parsed.map((message) => answerUnitMcpMessage(message, options)))).filter((a) => a !== null);
          send(answers.length === 0 ? 202 : 200, answers.length === 0 ? undefined : answers);
          return;
        }
        const answer = await answerUnitMcpMessage(parsed, options);
        send(answer === null ? 202 : 200, answer ?? undefined);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

export function acpUnitAgent(options: AcpAgentOptions): UnitAgent & { close(): Promise<void> } {
  const limits = options.limits ?? DEFAULT_STAGE_LIMITS;
  const timers = options.timers ?? PROCESS_TIMERS;
  let connection: AcpConnection | undefined;
  let scratch: string | undefined;
  // The journal's context for each session, so a refusal the agent's connection reports is filed under the unit that made it.
  const contexts = new Map<string, JournalContext>();
  let latest: JournalContext | undefined;
  const refusedRequest = (refusal: AcpRefusal): void => {
    const journal = options.journal;
    if (journal === undefined) return;
    const context = (refusal.sessionId === null ? undefined : contexts.get(refusal.sessionId)) ?? latest;
    if (context === undefined) return;
    journal.record(context, { kind: 'refusal', tool: refusal.method, arguments: refusal.params, response: refusal.message, isError: true, outcome: 'rejected', reason: refusal.message, startedAt: new Date(), durationMs: 0 });
  };

  const connect = async (): Promise<AcpConnection> => {
    if (connection !== undefined) return connection;
    scratch = await mkdtemp(path.join(tmpdir(), 'madarch-writer-'));
    let started: AcpConnection | undefined;
    try {
      started = await connectAcpAgent(options.spec, { cwd: scratch, onRefused: refusedRequest, ...(options.env === undefined ? {} : { env: options.env }) });
      await started.initialize();
    } catch (error) {
      await started?.close().catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
      scratch = undefined;
      throw error;
    }
    connection = started;
    return started;
  };

  return {
    async run(request: UnitRequest): Promise<void> {
      const acp = await connect();
      const token = randomBytes(24).toString('hex');
      let context: JournalContext | undefined;
      const journal = options.journal;
      const now = (): JournalContext => context ?? { run: journal!.run, unit: request.id, agent: options.spec.id, model: null, session: null };
      const endpoint = await serveTools(request.tools, token, journal === undefined ? undefined : {
        served: (call) => journal.record(now(), entryOfCall(call)),
        rejected: (call) => journal.record(now(), { kind: 'refusal', tool: call.tool ?? '(no tool named)', arguments: call.arguments, response: call.message, isError: true, outcome: 'rejected', reason: call.message, startedAt: call.startedAt, durationMs: 0 }),
      });
      const guard = createUnitLimitGuard({ limits, clock: () => Date.now() });
      let stop: UnitLimitCause | undefined;
      let wrapPending = false;
      try {
        const session = await acp.newSession({ cwd: scratch!, mcpServers: [{ name: 'madarch-writer', type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${token}` } }] });
        if (journal !== undefined) {
          context = { run: journal.run, unit: request.id, agent: options.spec.id, model: session.model, session: session.sessionId };
          contexts.set(session.sessionId, context);
          latest = context;
        }
        let prompt = request.prompt;
        for (let turns = 1; turns <= limits.maxTurns && stop === undefined; turns += 1) {
          guard.sent(Math.ceil([...prompt].length / CHARACTERS_PER_TOKEN));
          const turn = new AbortController();
          const watch = watchUnitTimeLimit({ guard, timers, onStop: (cause) => { stop ??= cause; turn.abort(); }, onWrap: () => { wrapPending = true; } });
          try {
            await session.prompt(prompt, {
              signal: turn.signal,
              onUpdate: (update: AcpUpdate) => {
                if (update.kind !== 'usage') return;
                const judged = guard.observe({ ...(update.contextUsed === undefined ? {} : { contextUsed: update.contextUsed }), ...(update.contextSize === undefined ? {} : { contextSize: update.contextSize }) });
                if (judged.kind === 'wrap') wrapPending = true;
                if (judged.kind === 'stop' && stop === undefined) { stop = judged.cause; turn.abort(); }
              },
            });
          } finally {
            watch.disarm();
          }
          if (request.tools.finished() || stop !== undefined) break;
          const judged = guard.observe({ turns });
          if (judged.kind === 'stop') { stop = judged.cause; break; }
          prompt = wrapPending || judged.kind === 'wrap'
            ? guard.wrapUpMessage()
            : 'The page is not written yet. Call write_page with the whole page now; if it was refused, fix every listed problem first.';
          wrapPending = false;
        }
        if (stop !== undefined) options.progress?.(`${request.id} stopped: ${guard.describe({ kind: 'stop', cause: stop, state: guard.state() })}`);
      } finally {
        await endpoint.close();
      }
    },
    async close(): Promise<void> {
      await connection?.close();
      connection = undefined;
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
      scratch = undefined;
    },
  };
}
