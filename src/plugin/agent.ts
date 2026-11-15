/** Host-side ACP agent bridge: graph-only reads, explicit writes and validated extraction results. */
import { constants, lstatSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import { choicesOf, type AgentPreferences } from '../fill/acp-choices.js';
import type { AcpAgentSpec, AcpConnection, AcpMcpServer, ConnectAcpOptions } from '../fill/acp.js';
import { log } from '../obs/log.js';
import type { AgentMeter } from '../fill/agent-meter.js';
import { withSpan } from '../obs/trace.js';
import type { PluginManifest } from './closure.js';
import { UnitBoundStop } from '../fill/unit-bound.js';
import type { GraphAnswerer } from './host.js';
import { PluginUnitResult, type PluginContractDeclaration } from './protocol.js';
import { validateUnitResult } from './results.js';

const WHERE = `src/plugin/agent.ts:1: ${fileURLToPath(import.meta.url)}`;

export interface PluginAgentReport {
  readonly unitId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly model: string | null;
  readonly usage: ReturnType<import('../fill/acp.js').AcpSession['usage']>;
}

/** Adapter configuration is host-owned and never becomes plugin closure data. */
export type PluginAgentConnection = AcpConnection & { freeze?(): void; thaw?(): void };

export interface PluginAgentOptions {
  readonly adapter: AcpAgentSpec;
  readonly preferences?: AgentPreferences;
  /** Host-owned adapter environment, including the person’s authentication settings. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Repository identities mapped to writable host folders. Missing identities cannot be written. */
  readonly repositories?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /**
   * The MCP servers the agent's session is given (owner's decision, 2026-11-15): madarch's own graph server for a fill,
   * whose reads the agent makes itself instead of being handed a list of files.
   */
  readonly mcpServers?: readonly AcpMcpServer[];
  /** Starts the host-supervised adapter process. */
  readonly connect: (spec: AcpAgentSpec, options: ConnectAcpOptions) => Promise<PluginAgentConnection>;
  /** A catalogue agent's contract, derived by the host from the product's bound kinds. */
  readonly outputs?: PluginContractDeclaration;
  /** Host-owned meter for this plugin unit; task text cannot choose its kind or field. */
  readonly meter?: AgentMeter;
  /**
   * A sign of life for the unit whose agent works (owner's decision, 2026-11-15): the host calls its heartbeat deadline
   * into silence, and an agent that thinks for minutes between answers must not be read as a stopped plugin.
   */
  readonly onActivity?: (unitId: string) => void;
  /** Host attribution writer receives the actual session identity and its reported usage. */
  readonly onSession?: (metadata: PluginAgentReport) => void;
}

type AgentPart = NonNullable<PluginManifest['agent']>;

/** A canonical virtual file name, without a leading slash. */
function virtualPath(path: string): string {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  if (!clean || clean.includes('\\') || clean.includes('\0') || clean.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`${WHERE}: refused non-canonical virtual path ${JSON.stringify(path)}`);
  return clean;
}

function under(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const clean = root === '/' || root === '.' ? '' : virtualPath(root.replace(/\/$/, ''));
    return clean === '' || path === clean || path.startsWith(`${clean}/`);
  });
}

/** One bridge is retained for the plugin session and owns every agent connection it starts. */
export class PluginAgentBridge {
  private readonly connections = new Set<PluginAgentConnection>();
  private paused = false;
  private readonly turns = new Set<AbortController>();
  private readonly activeUnits = new Set<string>();
  private closed = false;
  constructor(private readonly part: AgentPart, private readonly options: PluginAgentOptions, private readonly graph: GraphAnswerer, private readonly outputs: PluginContractDeclaration) {}

  async run(unitId: string, task: unknown): Promise<PluginUnitResult> {
    if (this.closed) throw new Error(`${WHERE}: the plugin agent bridge is closed`);
    if (this.activeUnits.has(unitId)) throw new Error(`${WHERE}: unit ${unitId} already has an agent turn`);
    return await withSpan('plugin.agent.run', { 'madarch.plugin.unit': unitId, 'madarch.agent': this.options.adapter.id }, async (span) => {
      const files = await this.graph.files('**/*');
      const byPath = new Map<string, (typeof files)[number]>();
      for (const file of files) {
        const repository = file.key['repository'];
        const path = file.key['path'];
        if (typeof repository !== 'string' || typeof path !== 'string') continue;
        const name = virtualPath(`${repository}/${path}`);
        if (under(name, this.part.roots)) {
          if (byPath.has(name)) throw new Error(`${WHERE}: graph files ambiguously map ${name}`);
          byPath.set(name, file);
        }
      }
      if (this.activeUnits.has(unitId)) throw new Error(`${WHERE}: unit ${unitId} already has an agent turn`);
      this.activeUnits.add(unitId);
      this.options.onActivity?.(unitId);
      const controller = new AbortController();
      this.turns.add(controller);
      let connection: PluginAgentConnection | undefined;
      let sessionId: string | undefined;
      const checkSession = (id: string): void => {
        if (sessionId === undefined || id !== sessionId || this.closed) throw new Error(`${WHERE}: file request names no active agent session`);
      };
      try {
        connection = await this.options.connect(this.options.adapter, {
          cwd: this.options.cwd ?? process.cwd(), env: this.options.environment,
          files: {
            readTextFile: async (params) => {
              this.options.onActivity?.(unitId);
              checkSession(params.sessionId);
              if ((params.line != null && (!Number.isInteger(params.line) || params.line < 1)) || (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 1))) throw new Error(`${WHERE}: line and limit must be positive integers`);
              const name = virtualPath(params.path);
              const file = byPath.get(name);
              if (file === undefined) throw new Error(`${WHERE}: graph read denied for ${name}`);
              const content = await this.graph.value(file.kind, file.key, 'content');
              if (typeof content !== 'string') throw new Error(`${WHERE}: graph file ${name} has no text content`);
              log.debug('plugin agent file read', { unitId, path: name });
              const lines = content.split('\n');
              const start = (params.line ?? 1) - 1;
              const limit = params.limit ?? undefined;
              return { content: params.line == null && limit === undefined ? content : lines.slice(start, limit === undefined ? undefined : start + limit).join('\n') };
            },
            writeTextFile: async (params) => {
              checkSession(params.sessionId);
              const name = virtualPath(params.path);
              if (!under(name, this.part.writeRoots ?? [])) throw new Error(`${WHERE}: write denied for ${name}`);
              const [repository, ...parts] = name.split('/');
              const root = this.options.repositories?.[repository!];
              if (root === undefined || parts.length === 0) throw new Error(`${WHERE}: no host write root for ${name}`);
              // ACP writes refuse symlink components.
              let target = root;
              if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error(`${WHERE}: unsafe host root ${root}`);
              for (const part of parts.slice(0, -1)) {
                target = join(target, part);
                try { mkdirSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
                if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) throw new Error(`${WHERE}: unsafe write directory ${target}`);
              }
              target = join(target, parts.at(-1)!);
              const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
              try { writeFileSync(fd, params.content); } finally { closeSync(fd); }
              log.info('plugin agent file written', { unitId, path: name });
              return {};
            },
          },
          onRefused: (refusal) => { this.options.onActivity?.(unitId); log.warn('plugin agent tool refused', { unitId, method: refusal.method }); },
          onUpdate: (update) => { this.options.onActivity?.(unitId); log.debug('plugin agent update', { unitId, kind: update.kind }); },
        });
        this.connections.add(connection);
        if (this.paused) connection.freeze?.();
        if (this.closed) throw new Error(`${WHERE}: bridge closed during runner startup`);
        await connection.initialize();
        const session = await connection.newSession({ cwd: this.options.cwd ?? process.cwd(), ...(this.options.mcpServers === undefined ? {} : { mcpServers: this.options.mcpServers }) });
        sessionId = session.sessionId;
        const choices = choicesOf(session);
        for (const kind of ['model', 'reasoning'] as const) {
          const wanted = this.options.preferences?.[kind];
          if (wanted === undefined) continue;
          const choice = choices[kind];
          if (choice === null || !choice.values.some((value) => value.value === wanted)) throw new Error(`${WHERE}: agent does not offer ${kind} ${wanted}`);
          if (choice.configId === null) await session.setModel(wanted);
          else await session.setConfigOption(choice.configId, wanted);
        }
        // The prompt is the agent's role and its tools (the plugin's own file) and the task, which names the kind it
        // fills and what that kind means: the graph it works on is read through the session's own MCP server, so no list
        // of files and no dump of context stands here (owner's decision, 2026-11-15).
        const prompt = `${this.part.prompt}\nTask: ${JSON.stringify(task ?? null)}`;
        const meter = this.options.meter;
        meter?.beginSession();
        // No prompt is asked under a spent bound: the unit ends with its reason before the model spends anything
        // (owner's decision, 2026-11-15). Once four fifths are spent the agent is told to finish with what it has, in
        // the words of its prompt and in every tool answer it reads.
        const over = meter?.overBudget();
        if (over !== undefined) throw new UnitBoundStop('tokens', over.message);
        const notice = meter?.wrapNotice();
        const asked = notice === undefined ? prompt : `${prompt}\n\n${notice}`;
        const turn = meter === undefined ? undefined : await meter.runTurn(session, asked, { model: session.model, signal: controller.signal });
        const answer = turn?.result ?? await session.prompt(asked, { signal: controller.signal });
        if (controller.signal.aborted || this.closed) throw new Error(`${WHERE}: agent turn cancelled`);
        const stop = turn?.stop ?? meter?.stop();
        // A cap crossed while the agent worked throws away nothing the agent produced (owner's decision, 2026-11-15): a
        // complete answer stands, and the caller records that the unit went over. A turn with no answer at all ends the
        // unit with the bound's reason; any other non-answer is the protocol's.
        if (answer.stopReason !== 'end_turn' && stop === undefined) throw new Error(`${WHERE}: agent ended with ${answer.stopReason}`);
        const usage = session.usage();
        span.setAttribute('madarch.agent.model', session.model ?? 'not reported');
        span.setAttribute('madarch.agent.session', session.sessionId);
        span.setAttribute('madarch.agent.usage_reported', usage.reported);
        if (usage.totalTokens !== undefined) span.setAttribute('madarch.agent.tokens', usage.totalTokens);
        if (usage.inputTokens !== undefined) span.setAttribute('madarch.agent.inputTokens', usage.inputTokens);
        if (usage.outputTokens !== undefined) span.setAttribute('madarch.agent.outputTokens', usage.outputTokens);
        this.options.onSession?.({ unitId, agentId: this.options.adapter.id, sessionId: session.sessionId, model: session.model, usage: session.usage() });
        /** A stop ends the unit where the answer cannot be used: it is the bound's reason, and the run does not retry it. */
        const unusable = (reason: string): Error => stop === undefined ? new Error(`${WHERE}: ${reason}`) : new UnitBoundStop('tokens', `${stop.message}; ${reason}`);
        let raw: unknown;
        try {
          raw = JSON.parse(answer.text);
        } catch {
          throw unusable('the agent answer is no JSON');
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw unusable('the agent answer is not a JSON object');
        // Whatever the agent produced is kept, entry by entry (owner's rule, 2026-11-15): an entry the contract or the
        // graph cannot take is left out and named, and never costs the entries beside it what the agent got right.
        const envelope = raw as Record<string, unknown>;
        const dropped: { where: string; reason: string }[] = [];
        const keeps = async (name: 'vertices' | 'edges', entry: unknown, index: number): Promise<boolean> => {
          const single = { unitId, vertices: name === 'vertices' ? [entry] : [], edges: name === 'edges' ? [entry] : [], end: { state: 'complete' as const } };
          if (!Value.Check(PluginUnitResult, single)) {
            dropped.push({ where: `${name}[${String(index)}]`, reason: `it is no ${name === 'vertices' ? 'vertex' : 'edge'} of the protocol` });
            return false;
          }
          const checked = validateUnitResult(this.outputs, single);
          if (!checked.ok) {
            // The single-entry check names its place from the entry's own zero: the answer's place is the one a person reads.
            const reason = checked.refusal.message.replace(new RegExp(`^${name}\\[0\\]\\.?`, 'u'), '');
            dropped.push({ where: `${name}[${String(index)}]`, reason });
            return false;
          }
          const evidence = (entry as { evidence?: { repository?: unknown; path?: unknown; lineStart?: unknown; lineEnd?: unknown } }).evidence;
          const reason = typeof evidence?.repository !== 'string' || typeof evidence.path !== 'string' || evidence.lineStart === undefined || evidence.lineEnd === undefined
            ? 'it names no graph file and line range as its evidence'
            : byPath.get(virtualPath(`${evidence.repository}/${evidence.path}`)) === undefined
              ? `its evidence ${JSON.stringify(`${evidence.repository}/${evidence.path}`)} is no file of the graph`
              : undefined;
          if (reason !== undefined) {
            dropped.push({ where: `${name}[${String(index)}]`, reason });
            return false;
          }
          const file = byPath.get(virtualPath(`${evidence!.repository as string}/${evidence!.path as string}`))!;
          const content = await this.graph.value(file.kind, file.key, 'content');
          const start = evidence!.lineStart as number;
          const end = evidence!.lineEnd as number;
          if (typeof content !== 'string' || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > content.split('\n').length) {
            dropped.push({ where: `${name}[${String(index)}]`, reason: 'its evidence line range is outside the graph file' });
            return false;
          }
          return true;
        };
        const vertices: unknown[] = [];
        for (const [index, entry] of (Array.isArray(envelope['vertices']) ? envelope['vertices'] : []).entries()) if (await keeps('vertices', entry, index)) vertices.push(entry);
        const edges: unknown[] = [];
        for (const [index, entry] of (Array.isArray(envelope['edges']) ? envelope['edges'] : []).entries()) if (await keeps('edges', entry, index)) edges.push(entry);
        const agentEnd = envelope['end'] as { readonly state?: unknown; readonly cause?: unknown } | undefined;
        const droppedText = dropped.length === 0
          ? undefined
          : `${String(dropped.length)} ${dropped.length === 1 ? 'entry' : 'entries'} could not be taken and were left out: ${dropped.map((one) => `${one.where}: ${one.reason}`).join('; ')}`;
        const end = droppedText === undefined
          ? agentEnd ?? { state: 'complete' }
          : { state: 'partial', cause: agentEnd?.state === 'partial' && typeof agentEnd.cause === 'string' ? `${agentEnd.cause}; ${droppedText}` : droppedText };
        const candidate = { ...envelope, unitId, vertices, edges, end };
        const result = Value.Check(PluginUnitResult, candidate) ? candidate : { unitId, vertices, edges, end };
        if (!Value.Check(PluginUnitResult, result)) throw unusable(`invalid agent result: ${[...Value.Errors(PluginUnitResult, result)][0]?.message}`);
        const whole = validateUnitResult(this.outputs, result);
        if (!whole.ok) throw unusable(whole.refusal.message);
        if (dropped.length > 0) log.warn('plugin agent entries left out', { unitId, leftOut: dropped.length, of: `${String(vertices.length + dropped.length)} vertices and edges` });
        log.info('plugin agent result validated', { unitId, vertices: vertices.length, edges: edges.length, leftOut: dropped.length });
        return result;
      } finally {
        this.activeUnits.delete(unitId);
        this.turns.delete(controller);
        if (connection !== undefined) { this.connections.delete(connection); await connection.close(); }
      }
    });
  }

  pause(): void {
    this.paused = true;
    for (const connection of this.connections) connection.freeze?.();
  }

  resume(): void {
    this.paused = false;
    for (const connection of this.connections) connection.thaw?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const turn of this.turns) turn.abort();
    await Promise.all([...this.connections].map(async (connection) => await connection.close()));
    this.connections.clear();
  }
}
