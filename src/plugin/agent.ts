/** Host-side ACP agent bridge: graph-only reads, explicit writes and validated extraction results. */
import { constants, lstatSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import { byCodePoint } from '../model/order.js';
import { choicesOf, type AgentPreferences } from '../fill/acp-choices.js';
import type { AcpAgentSpec, AcpConnection, ConnectAcpOptions } from '../fill/acp.js';
import { log } from '../obs/log.js';
import { withSpan } from '../obs/trace.js';
import type { PluginManifest } from './closure.js';
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
  /** Starts the host-supervised adapter process. */
  readonly connect: (spec: AcpAgentSpec, options: ConnectAcpOptions) => Promise<PluginAgentConnection>;
  /** A catalogue agent's contract, derived by the host from the product's bound kinds. */
  readonly outputs?: PluginContractDeclaration;
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
      const checkSession = (id: string): void => {
        if (sessionId === undefined || id !== sessionId || this.closed) throw new Error(`${WHERE}: file request names no active agent session`);
      };
      try {
        connection = await this.options.connect(this.options.adapter, {
          cwd: this.options.cwd ?? process.cwd(), env: this.options.environment,
          files: {
            readTextFile: async (params) => {
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
          onRefused: (refusal) => log.warn('plugin agent tool refused', { unitId, method: refusal.method }),
          onUpdate: (update) => log.debug('plugin agent update', { unitId, kind: update.kind }),
        });
        this.connections.add(connection);
        if (this.paused) connection.freeze?.();
        if (this.closed) throw new Error(`${WHERE}: bridge closed during runner startup`);
        await connection.initialize();
        const session = await connection.newSession({ cwd: this.options.cwd ?? process.cwd() });
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
        const prompt = `${this.part.prompt}\nFiles available through ACP fs/read_text_file:\n${[...byPath.keys()].sort(byCodePoint).map((name) => `/${name}`).join('\n')}\nTask: ${JSON.stringify(task ?? null)}\nReturn only one JSON object with vertices, edges, and end:{"state":"complete"}. Every assertion must carry evidence identifying a listed repository/path and valid lineStart and lineEnd. Output contract: ${JSON.stringify(this.outputs)}`;
        const answer = await session.prompt(prompt, { signal: controller.signal });
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
          const content = await this.graph.value(file.kind, file.key, 'content');
          const start = evidence.lineStart;
          const end = evidence.lineEnd;
          if (typeof content !== 'string' || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > content.split('\n').length) throw new Error(`${WHERE}: agent evidence line range is outside the graph file`);
        }
        log.info('plugin agent result validated', { unitId, vertices: result.vertices?.length ?? 0, edges: result.edges?.length ?? 0 });
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
