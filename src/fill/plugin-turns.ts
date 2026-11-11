import { storedFileValueAnswerer } from '../plugin/stored-text.js';
/**
 * The plugin turn (decision 0035, items 1, 6, 9, 15 and 16): one fill step that runs each plugin
 * the product holds for a kind, once for the kind. A unit is not a path: the plugin asks its host
 * for the file vertices its kind's documents match and for their content, which the files
 * producer stored in the graph by blob — a plugin that declared no filesystem right sees no
 * repository at all. The answer's terms become claims the graph's writer publishes in the
 * publication's own transaction.
 *
 * The stage names no product kind: the kinds, the plugins, the patterns and the lock are the
 * manifest's data, and a product that declares no plugin-filled kind plans no unit and runs no
 * process.
 */
import { createHash } from 'node:crypto';
import type { AgentUsageRecord } from '../adapters/agent-usage.js';
import { AgentMeter, type AgentRunBudget, type AgentUsageStop } from './agent-meter.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { byCodePoint } from '../model/order.js';
import { kindsInDependencyOrder, matchesAny, type KindDecl, type KindsManifest, type PluginDecl } from '../product/manifest/kinds.js';
import type { GraphContract } from '../graph/contract.js';
import { graphFiles, producerEdges, producerEntities, writeRequestEntry } from '../graph/plugin-turns.js';
import { removedEdgeEnds, unevidencedOpinions, unresolvedReferences, type EvidenceDeclaration } from '../graph/index.js';
import { generatedTableName } from '../graph/contract.js';
import { closureOf } from '../plugin/closure.js';
import type { GraphAnswerer, RequestLog } from '../plugin/host.js';
import { canonicalKey } from '../plugin/results.js';
import type { PluginLockEntry } from '../plugin/lock.js';
import type { SnapshotSource } from '../plugin/repository-snapshot.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageDraftWriter } from './stage.js';
import { GIT_WIKI } from './stages/git-contract.js';
import type { PluginAgentOptions, PluginAgentReport } from '../plugin/agent.js';

/** The store one turn reads and writes, as the graph's own reads name it: the process's one owner, never a second. */
export type GraphOwner = Parameters<typeof producerEntities>[0];

/** What the plugin turn reads: the product's manifest, its lock, its checkouts and the graph the fill writes. */
export interface PluginTurnWiring {
  /** Host-owned adapter configuration, present only for a pressed agent fill. */
  readonly agent?: PluginAgentOptions;
  readonly productFolder: string;
  readonly manifest: KindsManifest;
  /** The plugins the lock records, by id; a declared plugin the lock does not hold does not run. */
  readonly locks: ReadonlyMap<string, PluginLockEntry>;
  readonly owner: GraphOwner;
  readonly snapshots: SnapshotSource;
  /** The contract the manifest's declarations made: the file table the units are read from, the tables the claims go to. */
  readonly contract: GraphContract;
  /** The release closures trusted without approval; the build's own unless a test names its own. */
  readonly releaseHashes?: readonly string[];
  /**
   * The kinds this fill was asked for (decision 0035, items 11 and 31; madarch-stm0.6): their turns only, in this
   * dependency order, and with a vertex, the one entity of that kind's unit whose answer is published. Absent, the
   * fill takes every kind the manifest binds a plugin to, as a whole fill does.
   */
  readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string };
  /** Whether every plugin turn of this run has published; absent, a whole-graph turn is planned at once. */
  readonly wholeGraphReady?: () => Promise<boolean>;
  /** The cgroup the plugin runs under, when the machine delegates one (`MADARCH_PLUGIN_CGROUP`). */
  readonly cgroupParent?: string;
  /** `journal.debug`: the journal keeps every request the plugin makes, its reads included, with its answer's size. */
  readonly debug?: boolean;
  /**
   * The run's agent metering (madarch-stm0.4, decision 0035, item 22): the fill run's id, the counter the run's plugin
   * meters share and where a unit's spend is written. A unit whose plugin has an agent part hands each of its ACP
   * session updates to the meter; a unit without one metered nothing and writes nothing.
   */
  readonly agentUsage?: {
    readonly run: string;
    /** The counter the whole fill run is held to, when the catalogue's cap declares one. */
    readonly budget?: AgentRunBudget;
    /** Where a unit's rows go: `recordAgentUsage` over the store's mechanism tables. */
    readonly save: (rows: readonly AgentUsageRecord[]) => Promise<void>;
  };
}

/** One unit of a plugin's turn: the plugin and the kind whose documents it reads, or the whole graph. */
export interface PluginTurnUnit {
  readonly id: string;
  readonly plugin: PluginDecl;
  /** The kind whose documents the unit reads; absent for a plugin that reads the whole graph. */
  readonly kind?: KindDecl;
  readonly lock: PluginLockEntry;
  /** The document patterns the plugin's kinds name; the plugin also knows its own contract's patterns. */
  readonly patterns: readonly string[];
  /** Whether this unit reads the whole graph once, after every other plugin turn. */
  readonly wholeGraph: boolean;
}

/** Whether a plugin fills a kind the manifest binds fields of, and reads the kind's documents. */
function fills(plugin: PluginDecl, kind: KindDecl): boolean {
  return plugin.contract?.vertices.some((vertex) => vertex.kind === kind.name) === true
    && kind.fields?.some((field) => field.binding?.kind === 'plugin' && field.binding.plugin === plugin.id) === true;
}

/** The manifest kinds a plugin fills: their fields name a plugin field. */
export function pluginKindsOf(manifest: KindsManifest): KindDecl[] {
  return [...manifest.kinds.values()]
    .filter((kind) => (kind.fields ?? []).some((field) => field.binding?.kind === 'plugin') || [...(manifest.plugins?.values() ?? [])].some((plugin) => plugin.contract?.agent !== undefined && fills(plugin, kind)))
    .sort((left, right) => byCodePoint(left.name, right.name));
}

/** The plugin's kinds in the manifest, the earliest in the dependency order first. */
function outputKindsOf(manifest: KindsManifest, plugin: PluginDecl): KindDecl[] {
  const rank = new Map(kindsInDependencyOrder(manifest).map((name, at) => [name, at] as const));
  return [...manifest.kinds.values()]
    .filter((kind) => fills(plugin, kind))
    .sort((left, right) => (rank.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.name) ?? Number.MAX_SAFE_INTEGER) || byCodePoint(left.name, right.name));
}

/** One unit's id: its plugin and its kind, so a worker of any process derives it again. */
export function pluginTurnUnitId(plugin: string, kind: string, vertex?: string): string {
  return `${plugin}:${kind}${vertex === undefined ? '' : `@${vertex}`}`;
}

/**
 * The units one fill's plugin turns plan: one per plugin, in the turn of the earliest kind it produces, so a plugin that
 * writes several kinds answers them in one read (decision 0035, item 11). A plugin the lock does not hold plans nothing.
 *
 * A plugin's turn is planned when one of its kinds' patterns names a document the graph holds, and also when the plugin
 * itself holds entities the graph still has (decision 0035, item 7): a complete answer retracts what the producer held
 * in every kind it produces and this answer does not state, so a declaration that narrowed a pattern — which committed
 * in the product repository, and so moved the unit's inputs — has its old facts taken out by the very turn that reads
 * the new declaration. Only a product that neither names a document of the plugin's kinds nor holds an entity the
 * plugin produced plans no unit, so a wiki-only product pays for no plugin read.
 */
/** The order the manifest's own declarations give the units' kinds, for a fill asked for a set of them. */
function targetOrder(wiring: PluginTurnWiring): ReadonlyMap<string, number> {
  return new Map((wiring.targets?.kinds ?? kindsInDependencyOrder(wiring.manifest)).map((kind, at) => [kind, at] as const));
}

export async function planPluginTurns(wiring: PluginTurnWiring): Promise<PluginTurnUnit[]> {
  const asked = wiring.targets === undefined ? undefined : new Set(wiring.targets.kinds);
  const kinds = pluginKindsOf(wiring.manifest).filter((kind) => asked === undefined || asked.has(kind.name));
  // A plugin that reads the whole graph is planned by its own stage, after these turns published. When a fill asks for
  // one of its output kinds, it is that plugin's turn that is asked for, even though the kind is no document kind.
  const normal = asked === undefined || kinds.length > 0;
  if (!normal && !wholeGraphPlugins(wiring, asked).some((one) => { const output = wholeGraphOutput(one); return output !== undefined && asked?.has(output) === true; })) return [];
  // The units stand on the file vertices the tree pass publishes: a plan made before they stand finds nothing, and the
  // run plans this stage again once the tree published (decision 0027's re-planning of a stage that found nothing).
  const files = await graphFiles(wiring.owner, wiring.contract);
  if (files.length === 0 && kinds.length > 0) return [];
  const units: PluginTurnUnit[] = [];
  for (const plugin of [...(wiring.manifest.plugins?.values() ?? [])].sort((left, right) => byCodePoint(left.id, right.id))) {
    const lock = wiring.locks.get(plugin.id);
    if (lock === undefined || plugin.contract?.reads === 'whole-graph') continue;
    const pluginKinds = outputKindsOf(wiring.manifest, plugin);
    const selected = wiring.targets === undefined ? pluginKinds : pluginKinds.filter((kind) => wiring.targets!.kinds.includes(kind.name));
    const earliest = selected[0];
    if (earliest === undefined) continue;
    if (plugin.contract?.agent !== undefined && wiring.agent === undefined) continue;
    if (plugin.contract?.agent?.catalogue === true) {
      for (const kind of selected) units.push({ id: pluginTurnUnitId(plugin.id, kind.name, wiring.targets?.vertex), plugin, kind, lock, patterns: [], wholeGraph: false });
      continue;
    }
    // A kind may name the document patterns its plugin reads; a plugin that reads the graph's own files names none, and
    // is asked what to read by its own contract's patterns (the glossary reads `**/glossary*.md`, db-schema `**/*.ts`).
    const patterns = [...new Set(pluginKinds.flatMap((kind) => kind.terms ?? []))];
    if (patterns.length > 0 && !files.some((file) => matchesAny(patterns, file.path))) {
      let held = false;
      for (const kind of pluginKinds) {
        if ((await producerEntities(wiring.owner, wiring.contract, kind.name, plugin.id)).length > 0) { held = true; break; }
      }
      if (!held) continue;
    }
    units.push({ id: pluginTurnUnitId(plugin.id, earliest.name, wiring.targets?.vertex), plugin, kind: earliest, lock, patterns, wholeGraph: false });
  }
  // The kinds' dependency order first (item 11): a kind's plugins run before the plugins of the kinds that depend on it,
  // so a turn that a later turn reads has published by then. Ties keep the plugin's id and the kind's name in code point
  // order, so two runs of one request plan the same units in the same order.
  const rank = targetOrder(wiring);
  return units.sort((left, right) => (rank.get(left.kind!.name) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.kind!.name) ?? Number.MAX_SAFE_INTEGER) || byCodePoint(left.id, right.id));
}

/** One whole-graph plugin of the manifest, with its lock, in code point order of the plugin's id. */
function wholeGraphPlugins(wiring: PluginTurnWiring, asked: ReadonlySet<string> | undefined): { plugin: PluginDecl; lock: PluginLockEntry }[] {
  const held: { plugin: PluginDecl; lock: PluginLockEntry }[] = [];
  for (const plugin of [...(wiring.manifest.plugins?.values() ?? [])].sort((left, right) => byCodePoint(left.id, right.id))) {
    const lock = wiring.locks.get(plugin.id);
    if (lock === undefined || plugin.contract?.reads !== 'whole-graph') continue;
    if (asked !== undefined && ![...asked].some((kind) => plugin.contract?.vertices.some((vertex) => vertex.kind === kind))) continue;
    held.push({ plugin, lock });
  }
  return held;
}

/** The first output kind of a whole-graph plugin, for a target that names one of its kinds. */
function wholeGraphOutput(one: { plugin: PluginDecl }): string | undefined {
  return one.plugin.contract?.vertices[0]?.kind;
}

/**
 * The whole-graph turns of a fill, planned after every other plugin turn published (madarch-stm0.7.1, piece 3): one unit
 * per plugin, with the digest of what it reads now — the writer's unresolved references and removed ends, and the
 * unevidenced opinions its contract lets the host report. A fill that moved nothing inherits the generation it published.
 */
export async function planWholeGraphTurns(wiring: PluginTurnWiring): Promise<PluginTurnUnit[]> {
  const asked = wiring.targets === undefined ? undefined : new Set(wiring.targets.kinds);
  const whole = wholeGraphPlugins(wiring, asked);
  if (whole.length === 0) return [];
  if (wiring.wholeGraphReady !== undefined && !(await wiring.wholeGraphReady())) return [];
  const digest = await wholeGraphDigest(wiring);
  // A single-vertex fill and a whole fill are two cache identities: the target is part of the unit's id.
  return whole.map((one) => ({ id: pluginTurnUnitId(one.plugin.id, `whole-graph@${digest}`, wiring.targets?.vertex), plugin: one.plugin, lock: one.lock, patterns: [], wholeGraph: true }));
}

/** The digest of everything a whole-graph plugin reads: the three consistency reads, as the graph stands now. */
async function wholeGraphDigest(wiring: PluginTurnWiring): Promise<string> {
  const references: unknown[] = [];
  const ends: unknown[] = [];
  const opinions: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await unresolvedReferences(wiring.owner, cursor === undefined ? {} : { after: cursor });
    references.push(...page.rows);
    cursor = page.next;
  } while (cursor !== undefined);
  cursor = undefined;
  do {
    const page = await removedEdgeEnds(wiring.owner, cursor === undefined ? {} : { after: cursor });
    ends.push(...page.rows);
    cursor = page.next;
  } while (cursor !== undefined);
  cursor = undefined;
  do {
    const page = await unevidencedOpinions(wiring.owner, evidenceDeclarations(wiring.manifest), cursor === undefined ? {} : { after: cursor });
    opinions.push(...page.rows);
    cursor = page.next;
  } while (cursor !== undefined);
  return createHash('sha256').update(JSON.stringify({ references, ends, opinions }), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The fields whose opinions must carry evidence (madarch-stm0.7.1, piece 4), as the product's plugins declare them in
 * their contracts: one declaration per kind and producer, naming the evidence-required fields and the table the
 * declarations made for the kind. A field whose contract says nothing is not here, and so is never reported.
 */
function evidenceDeclarations(manifest: KindsManifest): EvidenceDeclaration[] {
  const declarations: EvidenceDeclaration[] = [];
  for (const plugin of [...(manifest.plugins?.values() ?? [])].sort((left, right) => byCodePoint(left.id, right.id))) {
    const contract = plugin.contract;
    if (contract === undefined) continue;
    for (const vertex of contract.vertices) {
      const kind = manifest.kinds.get(vertex.kind);
      if (kind === undefined) continue;
      const fields = vertex.fields.filter((field) => field.evidence === true && kind.fields?.some((declared) => declared.name === field.name) === true).map((field) => field.name);
      if (fields.length === 0) continue;
      declarations.push({ kind: vertex.kind, table: generatedTableName(vertex.kind, 'vertex'), producer: plugin.id, fields, key: kind.key ?? [] });
    }
  }
  return declarations;
}

/** The unit a worker re-derives from its id, against the manifest it reads itself. */
function unitOf(wiring: PluginTurnWiring, id: string): PluginTurnUnit {
  const cut = id.indexOf(':');
  if (cut < 0) throw new Error(`src/fill/plugin-turns.ts:1: the unit id ${JSON.stringify(id)} is no plugin turn: it is <plugin>:<kind> or <plugin>:whole-graph@<digest>`);
  const rest = id.slice(cut + 1);
  const plugin = wiring.manifest.plugins?.get(id.slice(0, cut));
  const lock = plugin === undefined ? undefined : wiring.locks.get(plugin.id);
  if (plugin !== undefined && lock !== undefined && rest.startsWith('whole-graph@')) {
    if (plugin.contract?.reads !== 'whole-graph') throw new Error(`src/fill/plugin-turns.ts:1: the unit ${JSON.stringify(id)} names a whole-graph turn, and the plugin ${plugin.id} reads one unit at a time`);
    return { id, plugin, lock, patterns: [], wholeGraph: true };
  }
  const at = rest.indexOf('@');
  const kindName = at < 0 ? rest : rest.slice(0, at);
  const kind = wiring.manifest.kinds.get(kindName);
  const patterns = [...new Set((plugin === undefined ? [] : outputKindsOf(wiring.manifest, plugin)).flatMap((one) => one.terms ?? []))];
  if (kind === undefined || plugin === undefined || lock === undefined || !fills(plugin, kind)) {
    throw new Error(`src/fill/plugin-turns.ts:1: the unit ${JSON.stringify(id)} names a plugin or a kind the manifest no longer declares, or a plugin the lock no longer holds`);
  }
  return { id, plugin, kind, lock, patterns, wholeGraph: false };
}

/** One evidence of a plugin's answer as the graph's writer states it: `commitOrDigest` is the commit or digest. */
function draftEvidence(evidence: { readonly repository?: string; readonly commitOrDigest?: string; readonly path?: string; readonly lineStart?: number; readonly lineEnd?: number } | undefined): { repository?: string; commit?: string; path?: string; lineStart?: number; lineEnd?: number } | undefined {
  if (evidence === undefined) return undefined;
  return {
    ...(evidence.repository === undefined ? {} : { repository: evidence.repository }),
    ...(evidence.commitOrDigest === undefined ? {} : { commit: evidence.commitOrDigest }),
    ...(evidence.path === undefined ? {} : { path: evidence.path }),
    ...(evidence.lineStart === undefined ? {} : { lineStart: evidence.lineStart }),
    ...(evidence.lineEnd === undefined ? {} : { lineEnd: evidence.lineEnd }),
  };
}

/** One drafted vertex as the graph names the entity: `<kind>:<its key values in the contract's order, joined by /">`. */
function entityIdOf(wiring: PluginTurnWiring, kind: string, key: import('../plugin/protocol.js').PluginKeyValues): string | undefined {
  const vertex = wiring.contract.vertex.find((held) => held.name === kind);
  if (vertex === undefined) return undefined;
  const values = vertex.key.map((field) => String(key[field] ?? ''));
  return `${kind}:${values.join('/')}`;
}

/** One edge's identity inside one answer: its kind, both ends by kind and key, and its discriminator. */
function edgeIdentity(kind: string, from: { readonly kind: string; readonly key: import('../plugin/protocol.js').PluginKeyValues }, to: { readonly kind: string; readonly key: import('../plugin/protocol.js').PluginKeyValues }, discriminator: string): string {
  return JSON.stringify([kind, from.kind, canonicalKey(from.key), to.kind, canonicalKey(to.key), discriminator]);
}

/**
 * The graph the host answers a plugin's reads from: the file vertices its pattern names, and a file's content as the
 * files producer stored it. The plugin never sees a folder (decision 0035, item 9). The host records each request it
 * answers — and each it refuses — in the unit's `RequestLog`, so the answerer states no sizes of its own.
 */
function answererOf(wiring: PluginTurnWiring): GraphAnswerer {
  return {
    files: async (pattern) => {
      const files = (await graphFiles(wiring.owner, wiring.contract))
        .filter((file) => matchesAny([pattern], file.path))
        .map((file) => ({ kind: GIT_WIKI.file, key: { repository: file.repository, path: file.path } }));
      return files;
    },
    value: storedFileValueAnswerer(wiring.owner),
    // The writer's consistency records (madarch-stm0.7.1, pieces 2 and 4), one bounded page at a time: the plugin asks
    // by name, and the store is read here, in the fill's own layer, never by the plugin.
    unresolved: async (query) => {
      const page = await unresolvedReferences(wiring.owner, query);
      return { references: page.rows, ...(page.next === undefined ? {} : { next: page.next }) };
    },
    removedEnds: async (query) => {
      const page = await removedEdgeEnds(wiring.owner, query);
      return { edges: page.rows, ...(page.next === undefined ? {} : { next: page.next }) };
    },
    unevidenced: async (query) => {
      const page = await unevidencedOpinions(wiring.owner, evidenceDeclarations(wiring.manifest), query);
      return { opinions: page.rows, ...(page.next === undefined ? {} : { next: page.next }) };
    },
  };
}

/** The meter of one plugin turn: the unit's own spend, in the kind it fills and one row per field and model. */
function pluginUnitMeter(wiring: PluginTurnWiring, unit: PluginTurnUnit): AgentMeter | undefined {
  const usage = wiring.agentUsage;
  if (usage === undefined) return undefined;
  return new AgentMeter({
    run: usage.run,
    unit: unit.id,
    plugin: unit.plugin.id,
    pluginVersion: unit.lock.version,
    kind: unit.kind?.name ?? 'whole-graph',
    ...(unit.plugin.bounds === undefined ? {} : { bounds: unit.plugin.bounds }),
    ...(usage.budget === undefined ? {} : { budget: usage.budget }),
    save: usage.save,
  });
}

export async function runPluginTurn(wiring: PluginTurnWiring, id: string, draft: StageDraftWriter, progress?: (note: string, fraction?: number) => void, signal?: AbortSignal): Promise<void> {
  const { PluginHost, RequestLog: PluginRequestLog } = await import('../plugin/host.js');
  const { RELEASE_CLOSURE_HASHES } = await import('../plugin/release-closures.js');
  const unit = unitOf(wiring, id);
  // The unit's meter (madarch-stm0.4): the agent part of this plugin hands it each ACP session update, and what it holds
  // is written once the unit ends — a unit with no agent part wrote nothing, and says so by holding no row.
  const meter = pluginUnitMeter(wiring, unit);
  const pluginFolder = join(wiring.productFolder, unit.plugin.path ?? '');
  const closure = closureOf(pluginFolder);
  if (closure.hash !== unit.lock.closure) {
    throw new Error(`src/fill/plugin-turns.ts:1: the plugin ${unit.plugin.id} at ${pluginFolder} hashes to ${closure.hash}, and madarch/plugins.lock locks ${unit.lock.closure}: a fill runs exactly the closure the lock names, and a changed closure needs a person's approval`);
  }
  const workRoot = mkdtempSync(join(tmpdir(), 'madarch-plugin-turn-'));
  const requests: RequestLog | undefined = wiring.debug === true ? new PluginRequestLog() : undefined;
  let agentReport: PluginAgentReport | undefined;
  const catalogue = unit.plugin.contract?.agent?.catalogue === true;
  const outputs = {
    vertices: (unit.plugin.contract?.vertices ?? []).filter((vertex) => !catalogue || vertex.kind === unit.kind?.name).map((vertex) => ({ ...vertex, key: [...vertex.key], fields: vertex.fields.map((field) => {
      const reference = wiring.manifest.kinds.get(vertex.kind)?.fields?.find((held) => held.name === field.name)?.reference;
      return { ...field, ...(reference === undefined ? {} : { reference }) };
    }) })),
    // Both ends must exist at publication: the later producer turn owns the edge, or the sole agent end does.
    edges: (unit.plugin.contract?.edges ?? []).filter((edge) => !catalogue || outputKindsOf(wiring.manifest, unit.plugin).filter((kind) => kind.name === edge.from || kind.name === edge.to).at(-1)?.name === unit.kind?.name).map((edge) => ({ ...edge, fields: edge.fields.map((field) => ({ ...field })) })),
  };
  const host = new PluginHost({
    ...(wiring.agent === undefined ? {} : { agent: { ...wiring.agent, outputs, ...(meter === undefined ? {} : { meter }), onSession: (report: PluginAgentReport) => { agentReport = report; wiring.agent?.onSession?.(report); } } }),
    pluginFolder,
    closure,
    repository: wiring.productFolder,
    graph: answererOf(wiring),
    workRoot,
    trust: 'production',
    releaseHashes: wiring.releaseHashes ?? RELEASE_CLOSURE_HASHES,
    ...(wiring.cgroupParent === undefined ? {} : { cgroupParent: wiring.cgroupParent }),
    ...(requests === undefined ? {} : { requests }),
  });
  const author = `${unit.plugin.id}@${unit.lock.version}`;
  /** Whether the unit's own publication carries its requests: a unit that failed publishes nothing (see below). */
  let journaled = false;
  try {
    const session = await host.open();
    const cancel = (): void => { void session.cancel(); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted === true) cancel();
    try {
      const vertexKinds = new Set(outputs.vertices.map((vertex) => vertex.kind));
      const edgeKinds = new Set(outputs.edges.map((edge) => edge.kind));
      const agentInputs = unit.plugin.contract?.agent === undefined ? undefined : {
        contract: outputs,
        kinds: [unit.kind], kind: unit.kind,
        files: (await graphFiles(wiring.owner, wiring.contract)).map((file) => ({ path: `${file.repository}/${file.path}`, repository: file.repository, filePath: file.path })),
      };
      const outcome = await session.runUnit(unit.wholeGraph
        ? { unitId: id, kind: 'whole-graph', key: {}, inputs: { wholeGraph: true } }
        : { unitId: id, kind: unit.kind!.name, key: { pattern: unit.patterns[0] ?? '' }, inputs: agentInputs ?? { pattern: unit.patterns[0] ?? '', patterns: [...unit.patterns] } });
      if (outcome.state !== 'extracted') throw new Error(`src/fill/plugin-turns.ts:1: the unit ${id} was not extracted (${outcome.cause.code}): ${outcome.cause.message}`);
      const producerVersion = agentReport === undefined ? unit.lock.version : `${unit.lock.version}/${agentReport.agentId}`;
      const only = wiring.targets?.vertex;
      // A whole-graph plugin answers every kind its contract declares in one turn, so its whole answer is drafted and
      // compared; a unit turn drafts the kinds the fill asked for (madarch-stm0.7.1; madarch-47vw.3 item 3).
      const selectedKinds = unit.wholeGraph || wiring.targets === undefined ? vertexKinds : new Set(wiring.targets.kinds);
      if (only !== undefined && !outcome.result.vertices.some((vertex) => entityIdOf(wiring, vertex.kind, vertex.key) === only)) {
        throw new Error(`src/fill/plugin-turns.ts:1: the plugin ${unit.plugin.id} answered no entity ${JSON.stringify(only)} in the unit ${unit.id}: the plugin states no such value at the commit this fill read, and nothing was rewritten`);
      }
      const answered = new Map<string, Set<string>>();
      for (const vertex of outcome.result.vertices) {
        if (!vertexKinds.has(vertex.kind)) throw new Error(`src/fill/plugin-turns.ts:1: the plugin ${unit.plugin.id} answered the kind ${JSON.stringify(vertex.kind)} in the turn of ${JSON.stringify(unit.kind?.name ?? 'whole-graph')}, and its contract declares ${[...vertexKinds].join(', ') || 'none'}`);
        if (!selectedKinds.has(vertex.kind) || (only !== undefined && entityIdOf(wiring, vertex.kind, vertex.key) !== only)) continue;
        const held = answered.get(vertex.kind) ?? new Set<string>();
        held.add(canonicalKey(vertex.key));
        answered.set(vertex.kind, held);
        draft.write({ kind: 'vertex', evidence: vertex.kind, value: {
          kind: vertex.kind,
          key: vertex.key,
          ...(vertex.values === undefined ? {} : { values: vertex.values }),
          ...(draftEvidence(vertex.evidence) === undefined ? {} : { evidence: [draftEvidence(vertex.evidence)!] }),
          producer: unit.plugin.id,
          producerVersion,
        } });
      }
      const answeredEdges = new Set<string>();
      for (const edge of only === undefined ? outcome.result.edges ?? [] : []) {
        if (!edgeKinds.has(edge.kind)) throw new Error(`src/fill/plugin-turns.ts:1: the plugin ${unit.plugin.id} answered the edge kind ${JSON.stringify(edge.kind)}, and its contract declares ${[...edgeKinds].join(', ') || 'none'}`);
        answeredEdges.add(edgeIdentity(edge.kind, edge.from, edge.to, edge.discriminator ?? ''));
        draft.write({ kind: 'edge', evidence: edge.kind, value: {
          kind: edge.kind,
          from: edge.from,
          to: edge.to,
          ...(edge.discriminator === undefined ? {} : { discriminator: edge.discriminator }),
          ...(edge.values === undefined ? {} : { values: edge.values }),
          ...(draftEvidence(edge.evidence) === undefined ? {} : { evidence: [draftEvidence(edge.evidence)!] }),
          producer: unit.plugin.id,
          producerVersion,
        } });
      }
      // The unit's entry names its author and, under the debug setting, every request it made — its refusals, its
      // failures and any the unit abandoned included, each with its answer's size and its cause's class, never an
      // argument or a text. It is a draft like the rest, so it lands in the publication's own transaction.
      draft.write({ kind: 'journal', evidence: unit.kind?.name ?? 'whole-graph', value: { author, ...(requests === undefined ? {} : { reads: requests.finish() }) } });
      journaled = true;
      if (outcome.result.end.state === 'complete' && only === undefined) {
        // A unit's complete answer retracts the entities its producer held and this answer does not state. A whole-graph
        // plugin states every kind its contract declares, so each is compared; a unit turn states the kinds the fill asked for.
        const removalKinds = (unit.wholeGraph
          ? [...new Set((unit.plugin.contract?.vertices ?? []).map((vertex) => vertex.kind))].filter((kind) => wiring.manifest.kinds.has(kind))
          : [...vertexKinds].filter((kind) => selectedKinds.has(kind))).sort(byCodePoint);
        for (const kind of removalKinds) {
          const held = answered.get(kind) ?? new Set<string>();
          for (const entity of await producerEntities(wiring.owner, wiring.contract, kind, unit.plugin.id)) {
            if (held.has(canonicalKey(entity.key))) continue;
            draft.write({ kind: 'vertex-removal', evidence: kind, value: { kind, key: entity.key, producer: unit.plugin.id } });
          }
        }
        for (const kind of [...edgeKinds].sort(byCodePoint)) {
          if (!wiring.contract.edge.some((edge) => edge.name === kind)) continue;
          for (const edge of await producerEdges(wiring.owner, wiring.contract, kind, unit.plugin.id)) {
            if (answeredEdges.has(edgeIdentity(kind, edge.from, edge.to, edge.discriminator))) continue;
            draft.write({ kind: 'edge-removal', evidence: kind, value: { kind, from: edge.from, to: edge.to, ...(edge.discriminator === '' ? {} : { discriminator: edge.discriminator }), producer: unit.plugin.id } });
          }
        }
      } else if (outcome.result.end.state === 'partial') {
        // A partial unit publishes what it read and says where it stopped short: never a silence about the rest.
        progress?.(`the plugin ${unit.plugin.id} answered a partial unit: ${outcome.result.end.cause}`);
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      await session.close();
    }
    // The unit's spend goes to the store whatever the unit published: a bound that crossed is the unit's end, and the
    // rows say what it spent before it stopped.
    await meter?.flush();
    const stop: AgentUsageStop | undefined = meter?.stop();
    if (stop !== undefined) throw new Error(stop.message);
  } catch (error) {
    // What the unit spent is evidence whatever it published: a unit that failed still writes its rows.
    await meter?.flush().catch(() => undefined);
    // A unit that crashed or timed out publishes nothing, and its requests are evidence all the same: they go to the
    // journal in one transaction of their own, so the record survives the unit's failure (codex, stage 2 review, 5).
    if (requests !== undefined && !journaled) await writeRequestEntry(wiring.owner, author, requests.finish()).catch(() => undefined);
    throw error;
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

/** The fill stage of the plugin turns: the units are the manifest's, the work is each plugin's own. */
export function createPluginTurnStage(wiring: PluginTurnWiring): FillStage {
  return {
    id: PLUGIN_TURN_STAGE_ID,
    // Agent units carry their effective per-kind contract and run in dependency order.
    version: 4,
    maxConcurrency: 1,
    consumes: { required: [], optional: [] },
    produces: [{ kind: 'plugin-claim', schemaVersion: 1, scope: 'product' }],
    after: ['repository-tree'],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, enabled: true, concurrency: 1, config: {} },
    async plan(): Promise<{ units: { id: string; scope: string }[]; coverage?: 'planned' | 'nothing-found' }> {
      const holdsKinds = pluginKindsOf(wiring.manifest).length > 0;
      const units = await planPluginTurns(wiring);
      if (units.length === 0) return { units: [], ...(holdsKinds ? { coverage: 'nothing-found' as const } : {}) };
      return { units: units.map((unit) => ({ id: unit.id, scope: unit.kind?.name ?? 'whole-graph' })), coverage: 'planned' };
    },
    async execute(unit, context) {
      await runPluginTurn(wiring, unit.id, context.draft, context.progress, context.signal);
      return { outcome: 'draft' };
    },
    validate: () => ({ ok: true }),
  };
}

/**
 * The whole-graph turn (madarch-stm0.7.1, piece 3): a plugin whose contract reads the whole graph is planned here, in a
 * stage of its own after every plugin turn, and only once the run's plugin turns have all published. Its plan reads the
 * digest of what the graph holds then, not the digest a plan made before those turns could have known.
 */
export function createWholeGraphTurnStage(wiring: PluginTurnWiring): FillStage {
  return {
    id: WHOLE_GRAPH_STAGE_ID,
    version: 1,
    consumes: { required: [{ capability: 'plugin-claim', scope: 'product' }], optional: [] },
    produces: [{ kind: 'plugin-claim', schemaVersion: 1, scope: 'product' }],
    after: ['plugin-turns'],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, enabled: true, concurrency: 1, config: {} },
    async plan(): Promise<{ units: { id: string; scope: string }[]; coverage?: 'planned' | 'nothing-found' }> {
      const holds = [...(wiring.manifest.plugins?.values() ?? [])].some((plugin) => plugin.contract?.reads === 'whole-graph');
      const units = await planWholeGraphTurns(wiring);
      if (units.length === 0) return { units: [], ...(holds ? { coverage: 'nothing-found' as const } : {}) };
      return { units: units.map((unit) => ({ id: unit.id, scope: 'whole-graph' })), coverage: 'planned' };
    },
    async execute(unit, context) {
      await runPluginTurn(wiring, unit.id, context.draft, context.progress, context.signal);
      return { outcome: 'draft' };
    },
    validate: () => ({ ok: true }),
  };
}

/** The stage's id, as a workflow may name it. */
export const PLUGIN_TURN_STAGE_ID = 'plugin-turns';
/** The whole-graph turn's stage id. */
export const WHOLE_GRAPH_STAGE_ID = 'whole-graph-turns';
