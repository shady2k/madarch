/** Host-side ACP agent bridge: graph-only reads, explicit writes and validated extraction results. */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import { byCodePoint } from '../model/order.js';
import { englishOnly } from './english-task.js';
import { choicesOf, type AgentPreferences } from '../fill/acp-choices.js';
import type { AcpAgentSpec, AcpConnection, ConnectAcpOptions } from '../fill/acp.js';
import { log } from '../obs/log.js';
import type { AgentMeter } from '../fill/agent-meter.js';
import { startSpan, withSpan } from '../obs/trace.js';
import type { PluginManifest } from './closure.js';
import type { GraphAnswerer } from './host.js';
import { PluginUnitResult, type PluginContractDeclaration } from './protocol.js';
import { validateUnitResult } from './results.js';

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
  /** Starts the host-supervised adapter process. */
  readonly connect: (spec: AcpAgentSpec, options: ConnectAcpOptions) => Promise<PluginAgentConnection>;
  /** A catalogue agent's contract, derived by the host from the product's bound kinds. */
  readonly outputs?: PluginContractDeclaration;
  /** Host-owned meter for this plugin unit; task text cannot choose its kind or field. */
  readonly meter?: AgentMeter;
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
      const controller = new AbortController();
      this.turns.add(controller);
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
              checkSession(params.sessionId);
              if ((params.line != null && (!Number.isInteger(params.line) || params.line < 1)) || (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 1))) throw new Error(`${WHERE}: line and limit must be positive integers`);
              const name = virtualPath(params.path);
              const file = byPath.get(name);
              if (file === undefined) throw new Error(`${WHERE}: graph read denied for ${name}`);
              // The text is the blob the graph names, read by the host through the git plugin (decision 0037): the agent
              // and the page share one read path, and neither reads a working copy.
              const roles = this.options.fileText ?? catalogueFileTextRole();
              const blob = await this.graph.value(file.kind, file.key, roles.blob);
              if (typeof blob !== 'string' || blob === '') throw new Error(`${WHERE}: graph file ${name} holds no blob id, and a file's text is read by its blob`);
              if (this.options.readFile === undefined) throw new Error(`${WHERE}: this host answers no blob read, and a file's text is read through the host`);
              log.debug('plugin agent file read', { unitId, path: name, blob });
              const content = await this.readAgentFile(String(file.key[roles.repository]), blob, params.line ?? undefined, params.limit ?? undefined);
              return { content };
            },
          },
          onRefused: (refusal) => log.warn('plugin agent tool refused', { unitId, method: refusal.method }),
          onUpdate: (update) => log.debug('plugin agent update', { unitId, kind: update.kind }),
        });
        this.connections.add(connection);
        if (this.paused) connection.freeze?.();
        if (this.closed) throw new Error(`${WHERE}: bridge closed during runner startup`);
        await connection.initialize();
        const session = await connection.newSession({ cwd: workspace });
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
        // The agent reads one language (madarch-64o5.107): the task and the contract it is given are resolved to their
        // English text, and the contract the answer is validated against stays the declared one.
        const prompt = `${this.part.prompt}\nFiles available through ACP fs/read_text_file:\n${[...byPath.keys()].sort(byCodePoint).map((name) => `/${name}`).join('\n')}\nTask: ${JSON.stringify(englishOnly(task ?? null))}\nReturn only one JSON object with vertices, edges, and end:{"state":"complete"}. Every assertion must carry evidence identifying a listed repository/path and valid lineStart and lineEnd. Output contract: ${JSON.stringify(englishOnly(this.outputs))}`;
        const meter = this.options.meter;
        meter?.beginSession();
        const turn = meter === undefined ? undefined : await meter.runTurn(session, prompt, { model: session.model, signal: controller.signal });
        if (turn?.stop !== undefined) throw new Error(turn.stop.message);
        const answer = turn?.result ?? await session.prompt(prompt, { signal: controller.signal });
        if (controller.signal.aborted || this.closed) throw new Error(`${WHERE}: agent turn cancelled`);
        if (answer.stopReason !== 'end_turn') throw new Error(`${WHERE}: agent ended with ${answer.stopReason}`);
        const usage = session.usage();
        span.setAttribute('madarch.agent.model', session.model ?? 'not reported');
        span.setAttribute('madarch.agent.session', session.sessionId);
        span.setAttribute('madarch.agent.usage_reported', usage.reported);
        if (usage.totalTokens !== undefined) span.setAttribute('madarch.agent.tokens', usage.totalTokens);
        if (usage.inputTokens !== undefined) span.setAttribute('madarch.agent.inputTokens', usage.inputTokens);
        if (usage.outputTokens !== undefined) span.setAttribute('madarch.agent.outputTokens', usage.outputTokens);
        this.options.onSession?.({ unitId, agentId: this.options.adapter.id, sessionId: session.sessionId, model: session.model, usage: session.usage() });
        const raw: unknown = JSON.parse(answer.text);
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${WHERE}: agent answer is not a JSON object`);
        const result = { ...raw, unitId };
        if (!Value.Check(PluginUnitResult, result)) throw new Error(`${WHERE}: invalid agent result: ${[...Value.Errors(PluginUnitResult, result)][0]?.message}`);
        const checked = validateUnitResult(this.outputs, result);
        if (!checked.ok) throw new Error(`${WHERE}: ${checked.refusal.message}`);
        for (const item of [...(result.vertices ?? []), ...(result.edges ?? [])]) {
          const evidence = item.evidence;
          if (typeof evidence?.repository !== 'string' || typeof evidence.path !== 'string' || evidence.lineStart === undefined || evidence.lineEnd === undefined) throw new Error(`${WHERE}: agent assertion lacks evidence from an allowed graph file`);
          const file = byPath.get(virtualPath(`${evidence.repository}/${evidence.path}`));
          if (file === undefined) throw new Error(`${WHERE}: agent assertion lacks evidence from an allowed graph file`);
          // The evidence's line range is checked against the text the graph's blob names, read through the one gate
          // (decision 0037): the graph holds no text of its own.
          const roles = this.options.fileText ?? catalogueFileTextRole();
          const blob = await this.graph.value(file.kind, file.key, roles.blob);
          if (this.options.readFile === undefined || typeof blob !== 'string' || blob === '') throw new Error(`${WHERE}: agent evidence names a file whose text the host cannot read`);
          const content = await this.readAgentFile(String(file.key[roles.repository]), blob);
          const start = evidence.lineStart;
          const end = evidence.lineEnd;
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > content.split('\n').length) throw new Error(`${WHERE}: agent evidence line range is outside the graph file`);
        }
        log.info('plugin agent result validated', { unitId, vertices: result.vertices?.length ?? 0, edges: result.edges?.length ?? 0 });
        return result;
      } finally {
        this.activeUnits.delete(unitId);
        this.turns.delete(controller);
        if (connection !== undefined) { this.connections.delete(connection); await connection.close(); }
        if (workspace !== undefined) {
          const held = workspace;
          workspace = undefined;
          removeWorkspace(held);
        }
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
