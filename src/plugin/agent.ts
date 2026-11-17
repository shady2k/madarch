/** Host-side ACP agent bridge: graph-only reads, explicit writes and validated extraction results. */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import { Type, type Static } from 'typebox';
import { agentExchangeFolder, AgentExchangeRecorder } from '../fill/agent-exchange.js';
import { englishOnly } from './english-task.js';
import { choicesOf, type AgentPreferences } from '../fill/acp-choices.js';
import type { AcpAgentSpec, AcpConnection, AcpMcpServer, ConnectAcpOptions } from '../fill/acp.js';
import { log } from '../obs/log.js';
import type { AgentMeter } from '../fill/agent-meter.js';
import { startSpan, withSpan } from '../obs/trace.js';
import type { PluginManifest } from './closure.js';
import { UnitBoundStop } from '../fill/unit-bound.js';
import type { GraphAnswerer } from './host.js';
import { PluginUnitResult, PluginFactsApplyRequest, type PluginContractDeclaration } from './protocol.js';

import { canonicalEntity, validateUnitResult } from './results.js';

const AgentExtraction = Type.Object({ ...PluginUnitResult.properties, ...PluginFactsApplyRequest.properties.operation.properties }, { additionalProperties: false });
type AgentExtraction = Static<typeof AgentExtraction>;

import { catalogueFileTextRole, type FileTextRole } from '../knowledge/file-text-kind.js';

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
  /**
   * Reads one blob's text through the same plugin path a page uses (decision 0037): the host supplies it, and the agent's
   * file reads ask it by the blob id the graph holds, never by a working-copy path.
   */
  readonly readFile?: (request: { readonly repository: string; readonly blob: string; readonly from?: number; readonly limit?: number }) => Promise<string>;
  /** The roles a file's entity names its repository and blob by; the catalogue's when a product declares none (0037). */
  readonly fileText?: FileTextRole;
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
  readonly evidenceContracts?: readonly Pick<import('../graph/contract.js').VertexContract, 'name' | 'evidence'>[];
  /** Host-owned meter for this plugin unit; task text cannot choose its kind or field. */
  readonly meter?: AgentMeter;
  /**
   * A sign of life for the unit whose agent works (owner's decision, 2026-11-15): the host calls its heartbeat deadline
   * into silence, and an agent that thinks for minutes between answers must not be read as a stopped plugin.
   */
  readonly onActivity?: (unitId: string) => void;
  /** Host attribution writer receives the actual session identity and its reported usage. */
  readonly onSession?: (metadata: PluginAgentReport) => void;
  /**
   * Where the unit's whole ACP exchange is kept (madarch-64o5.88): the fill run it belongs to and the store's `traces`
   * folder. Left out, the unit runs as before and madarch keeps no exchange of its own.
   */
  readonly exchange?: { readonly run: string; readonly traces: string };
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
    const clean = root === '/' || root === '.' ? '' : virtualPath(root.endsWith('/') ? root.slice(0, -1) : root);
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

  async run(unitId: string, task: unknown): Promise<AgentExtraction> {
    if (this.closed) throw new Error(`${WHERE}: the plugin agent bridge is closed`);
    if (this.activeUnits.has(unitId)) throw new Error(`${WHERE}: unit ${unitId} already has an agent turn`);
    return await withSpan('plugin.agent.run', { 'madarch.plugin.unit': unitId, 'madarch.agent': this.options.adapter.id }, async (span) => {
      const files = await this.graph.files('**/*');
      const byPath = new Map<string, (typeof files)[number]>();
      for (const file of files) {
        const repository = file.keyEdges?.['code.file-repository']?.key['name'];
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
      // The exchange is madarch's own record of the unit (madarch-64o5.88): it starts before the agent does, so a unit
      // that never answered still leaves what it was given and why it failed.
      const exchange = this.options.exchange === undefined ? undefined : new AgentExchangeRecorder({
        folder: agentExchangeFolder(this.options.exchange.traces, this.options.exchange.run),
        run: this.options.exchange.run, unit: unitId, agent: this.options.adapter.id,
      });
      // The agent asks its MCP server for graph context, rather than receiving a second file inventory.
      const prompt = `${this.part.prompt}\nTask: ${JSON.stringify(englishOnly(task ?? null))}`;
      exchange?.setGiven({ prompt, task: englishOnly(task ?? null), files: [] });
      let connection: PluginAgentConnection | undefined;
      let sessionId: string | undefined;
      /** The empty folder the agent runs in: made for the session, and removed with it. */
      let workspace: string | undefined;
      const checkSession = (id: string): void => {
        if (sessionId === undefined || id !== sessionId || this.closed) throw new Error(`${WHERE}: file request names no active agent session`);
      };
      try {
        // No workspace and no file tools (owner's decision, 2026-11-15; decision 0038): the agent runs in an empty scratch
        // folder, writes nothing, and its one file read is a blob the graph names, answered by the host. A path that is no
        // graph file, a write and a terminal are refused by the client.
        workspace = mkdtempSync(join(tmpdir(), 'madarch-agent-session-'));
        connection = await this.options.connect(this.options.adapter, {
          cwd: workspace, env: this.options.environment,
          files: {
            readTextFile: async (params) => {
              this.options.onActivity?.(unitId);
              checkSession(params.sessionId);
              if ((params.line != null && (!Number.isInteger(params.line) || params.line < 1)) || (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 1))) throw new Error(`${WHERE}: line and limit must be positive integers`);
              const name = virtualPath(params.path);
              const file = byPath.get(name);
              if (file === undefined) throw new Error(`${WHERE}: graph read denied for ${name}`);
              // The text is the blob the graph names, read by the host through the git plugin (decision 0037): the agent
              // and the page share one read path, and neither reads a working copy.
              const roles = this.options.fileText ?? catalogueFileTextRole();
              const blob = await this.graph.value(file.kind, file.key, roles.blob, file.keyEdges);
              if (typeof blob !== 'string' || blob === '') throw new Error(`${WHERE}: graph file ${name} holds no blob id, and a file's text is read by its blob`);
              if (this.options.readFile === undefined) throw new Error(`${WHERE}: this host answers no blob read, and a file's text is read through the host`);
              log.debug('plugin agent file read', { unitId, path: name, blob });
              const repository = file.keyEdges?.['code.file-repository']?.key['name'];
              if (typeof repository !== 'string') throw new Error(`${WHERE}: graph file ${name} lacks its repository key edge`);
              const content = await this.readAgentFile(repository, blob, params.line ?? undefined, params.limit ?? undefined);
              // Which file the unit opened, and how much it was shown, is the record's own answer to «what did it do».
              exchange?.fileOpen({
                repository, path: String(file.key[roles.path]),
                ...(params.line == null ? {} : { line: params.line }), ...(params.limit == null ? {} : { limit: params.limit }),
                bytes: Buffer.byteLength(content, 'utf8'),
              });
              return { content };
            },
          },
          onRefused: (refusal) => { this.options.onActivity?.(unitId); log.warn('plugin agent tool refused', { unitId, method: refusal.method }); },
          onUpdate: (update) => { this.options.onActivity?.(unitId); log.debug('plugin agent update', { unitId, kind: update.kind }); exchange?.step(update); },
        });
        this.connections.add(connection);
        if (this.paused) connection.freeze?.();
        if (this.closed) throw new Error(`${WHERE}: bridge closed during runner startup`);
        await connection.initialize();
        const session = await connection.newSession({ cwd: workspace, ...(this.options.mcpServers === undefined ? {} : { mcpServers: this.options.mcpServers }) });
        sessionId = session.sessionId;
        exchange?.setSession(session.sessionId, session.model);
        const choices = choicesOf(session);
        for (const kind of ['model', 'reasoning'] as const) {
          const wanted = this.options.preferences?.[kind];
          if (wanted === undefined) continue;
          const choice = choices[kind];
          if (choice === null || !choice.values.some((value) => value.value === wanted)) throw new Error(`${WHERE}: agent does not offer ${kind} ${wanted}`);
          if (choice.configId === null) await session.setModel(wanted);
          else await session.setConfigOption(choice.configId, wanted);
        }
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
        const stop = turn?.stop ?? meter?.stop();
        const usage = session.usage();
        exchange?.answer(answer.text, answer.stopReason);
        exchange?.setUsage(usage);
        if (controller.signal.aborted || this.closed) { exchange?.cancelled(); throw new Error(`${WHERE}: agent turn cancelled`); }
        if (answer.stopReason !== 'end_turn' && stop === undefined) throw new Error(`${WHERE}: agent ended with ${answer.stopReason}`);
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
        if ((envelope['end'] as { state?: unknown } | undefined)?.state === 'inapplicable' &&
          ['vertices', 'edges', 'removals', 'problems'].some(name => envelope[name] !== undefined && (!Array.isArray(envelope[name]) || (envelope[name] as unknown[]).length > 0))) throw unusable('inapplicable requires a complete search with no instances, removals or unread places');
        // A malformed collection is a malformed answer, never an empty complete one: an answer whose `vertices` or
        // `edges` is no list names nothing, so it retracts nothing and the unit fails with that reason.
        for (const name of ['vertices', 'edges'] as const) {
          const held = envelope[name];
          if (held !== undefined && !Array.isArray(held)) throw unusable(`the agent answer's ${JSON.stringify(name)} is no list`);
        }
        const dropped: { where: string; reason: string }[] = [];
        const keeps = async (name: 'vertices' | 'edges', entry: unknown, index: number): Promise<boolean> => {
          const single: unknown = { unitId, vertices: name === 'vertices' ? [entry] : [], edges: name === 'edges' ? [entry] : [], end: { state: 'complete' as const } };
          if (!Value.Check(AgentExtraction, single)) {
            dropped.push({ where: `${name}[${String(index)}]`, reason: `it is no ${name === 'vertices' ? 'vertex' : 'edge'} of the protocol` });
            return false;
          }
          const checked = validateUnitResult(this.outputs, single);
          if (!checked.ok) {
            // The single-entry check names its place from the entry's own zero: the answer's place is the one a person
            // reads. The name is cut by plain comparison, never by a pattern (the architecture gate's no-regex rule).
            const prefix = `${name}[0]`;
            const head = checked.refusal.message.startsWith(prefix) ? checked.refusal.message.slice(prefix.length) : checked.refusal.message;
            const reason = head.startsWith('.') ? head.slice(1) : head;
            dropped.push({ where: `${name}[${String(index)}]`, reason });
            return false;
          }
          const evidence = (entry as { evidence?: import('./protocol.js').PluginEvidence }).evidence;
          const declaration = evidence === undefined ? undefined : this.options.evidenceContracts?.find(kind => kind.name === evidence.target.kind && kind.evidence?.immutable === true);
          const descriptor = declaration?.evidence;
          let content: unknown;
          if (evidence !== undefined && descriptor?.contentField !== undefined) content = await this.graph.value(evidence.target.kind, evidence.target.key, descriptor.contentField, evidence.target.keyEdges);
          const reason = evidence === undefined || descriptor === undefined || typeof content !== 'string' || evidence.lineStart === undefined || evidence.lineEnd === undefined
            ? 'it names no declared immutable graph content and line range as its evidence'
            : descriptor.digestField !== undefined && evidence.target.key[descriptor.digestField] !== createHash('sha256').update(content).digest('hex')
              ? 'its immutable evidence digest does not match the graph content'
              : undefined;
          if (reason !== undefined) {
            dropped.push({ where: `${name}[${String(index)}]`, reason });
            return false;
          }
          const start = evidence!.lineStart as number;
          const end = evidence!.lineEnd as number;
          if (typeof content !== 'string' || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > content.split('\n').length) {
            dropped.push({ where: `${name}[${String(index)}]`, reason: 'its evidence line range is outside the graph file' });
            return false;
          }
          return true;
        };
        // Two entries of one identity are one answer: the first stands, the later is left out and named (the store's
        // whole-result validation refuses a repeat, and the owner's rule keeps what the agent got right).
        const firstAt = new Map<string, string>();
        const identityOf = (name: 'vertices' | 'edges', entry: unknown): string => {
          if (name === 'vertices') return `v:${canonicalEntity(entry as import('./protocol.js').PluginEntityRef)}`;
          const held = entry as import('./protocol.js').PluginEdgeResult;
          return `e:${held.kind}:${canonicalEntity(held.from)}:${canonicalEntity(held.to)}:${held.discriminator ?? ''}`;
        };
        const collect = async (name: 'vertices' | 'edges'): Promise<unknown[]> => {
          const kept: unknown[] = [];
          const list = Array.isArray(envelope[name]) ? envelope[name] as unknown[] : [];
          for (const [index, entry] of list.entries()) {
            const where = `${name}[${String(index)}]`;
            if (!(await keeps(name, entry, index))) continue;
            const identity = identityOf(name, entry);
            const first = firstAt.get(identity);
            if (first !== undefined) { dropped.push({ where, reason: `it is a duplicate of ${first}: the same ${name === 'vertices' ? 'kind and key' : 'ends and discriminator'}` }); continue; }
            firstAt.set(identity, where);
            kept.push(entry);
          }
          return kept;
        };
        const vertices = await collect('vertices');
        const edges = await collect('edges');
        const agentEnd = envelope['end'] as { readonly state?: unknown; readonly cause?: unknown } | undefined;
        const droppedText = dropped.length === 0
          ? undefined
          : `${String(dropped.length)} ${dropped.length === 1 ? 'entry' : 'entries'} could not be taken and were left out: ${dropped.map((one) => `${one.where}: ${one.reason}`).join('; ')}`;
        const end = droppedText === undefined
          ? agentEnd ?? { state: 'complete' }
          : { state: 'partial', cause: agentEnd?.state === 'partial' && typeof agentEnd.cause === 'string' ? `${agentEnd.cause}; ${droppedText}` : droppedText };
        const candidate = { ...envelope, unitId, vertices, edges, end };
        const result: unknown = Value.Check(AgentExtraction, candidate) ? candidate : { unitId, vertices, edges, end };
        if (!Value.Check(AgentExtraction, result)) throw unusable(`invalid agent result: ${[...Value.Errors(AgentExtraction, result)][0]?.message}`);
        const whole = validateUnitResult(this.outputs, result);
        if (!whole.ok) throw unusable(whole.refusal.message);
        if (dropped.length > 0) log.warn('plugin agent entries left out', { unitId, leftOut: dropped.length, of: `${String(vertices.length + dropped.length)} vertices and edges` });
        log.info('plugin agent result validated', { unitId, vertices: vertices.length, edges: edges.length, leftOut: dropped.length });
        return result;
      } catch (error) {
        exchange?.failed(error);
        throw error;
      } finally {
        this.activeUnits.delete(unitId);
        this.turns.delete(controller);
        if (connection !== undefined) { this.connections.delete(connection); await connection.close(); }
        if (workspace !== undefined) {
          const held = workspace;
          workspace = undefined;
          removeWorkspace(held);
        }
        exchange?.finish();
      }
    });
  }

  /** One file's text for the agent, read in a span of its own: the host answers it by the blob's id. */
  private async readAgentFile(repository: string, blob: string, from?: number, limit?: number): Promise<string> {
    const span = startSpan('plugin.agent.file', { 'madarch.plugin': 'agent' });
    try {
      return await this.options.readFile!({ repository, blob, ...(from === undefined ? {} : { from }), ...(limit === undefined ? {} : { limit }) });
    } finally { span.end(); }
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

/** Removes one agent's scratch workspace, in a span of its own: the conversation has ended and its files go with it. */
function removeWorkspace(folder: string): void {
  const span = startSpan('plugin.agent.workspace', {});
  try { rmSync(folder, { recursive: true, force: true }); } finally { span.end(); }
}
