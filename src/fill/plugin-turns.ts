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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { byCodePoint } from '../model/order.js';
import { matchesAny, type KindDecl, type KindsManifest, type PluginDecl } from '../knowledge/kinds.js';
import type { GraphContract } from '../graph/contract.js';
import { fileContent, graphFiles, producerEntities, writeRequestEntry } from '../graph/plugin-turns.js';
import { removedEdgeEnds, unevidencedOpinions, unresolvedReferences, type EvidenceDeclaration } from '../graph/index.js';
import { generatedTableName } from '../graph/contract.js';
import { closureOf } from '../plugin/closure.js';
import { PluginHost, RequestLog, type GraphAnswerer } from '../plugin/host.js';
import { RELEASE_CLOSURE_HASHES } from '../plugin/release-closures.js';
import type { PluginLockEntry } from '../plugin/lock.js';
import type { SnapshotSource } from './snapshot.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageDraftWriter } from './stage.js';
import { GIT_WIKI } from './stages/git-contract.js';

/** The store one turn reads and writes, as the graph's own reads name it: the process's one owner, never a second. */
export type GraphOwner = Parameters<typeof producerEntities>[0];

/** What the plugin turn reads: the product's manifest, its lock, its checkouts and the graph the fill writes. */
export interface PluginTurnWiring {
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
}

/** One unit of a plugin's turn: the plugin and the kind whose documents it reads, or the whole graph. */
export interface PluginTurnUnit {
  readonly id: string;
  readonly plugin: PluginDecl;
  /** The kind whose documents the unit reads; absent for a plugin that reads the whole graph. */
  readonly kind?: KindDecl;
  readonly lock: PluginLockEntry;
  readonly pattern: string;
  /** Whether this unit reads the whole graph once, after every other plugin turn. */
  readonly wholeGraph: boolean;
}

/** Whether a plugin fills a kind the manifest binds fields of, and reads the kind's documents. */
function fills(plugin: PluginDecl, kind: KindDecl): boolean {
  return plugin.contract?.vertices.some((vertex) => vertex.kind === kind.name) === true;
}

/** The manifest kinds a plugin fills: their fields name a plugin field, and their documents are files. */
export function pluginKindsOf(manifest: KindsManifest): KindDecl[] {
  return [...manifest.kinds.values()]
    .filter((kind) => (kind.fields ?? []).some((field) => field.binding?.kind === 'plugin') && (kind.terms ?? []).length > 0)
    .sort((left, right) => byCodePoint(left.name, right.name));
}

/**
 * One unit's id: its plugin and its kind, so a worker of any process derives it again. A vertex fill is a unit of its own
 * (`<plugin>:<kind>@<entity id>`): it publishes one entity, and a later whole fill of the kind must not find it in its
 * own place and take the one entity for the kind's whole answer (madarch-stm0.6).
 */
export function pluginTurnUnitId(plugin: string, kind: string, vertex?: string): string {
  return `${plugin}:${kind}${vertex === undefined ? '' : `@${vertex}`}`;
}

/**
 * The units one fill's plugin turns plan: one per plugin and kind, so the plugin reads every document its kind names
 * through the host. A kind no plugin fills, or a product whose lock holds none of its plugins, plans nothing.
 *
 * A kind's turn is planned whether or not its pattern names a document the graph holds, and the plugin is what decides
 * what it no longer sees: its complete answer retracts the entities the producer held and this answer does not state
 * (decision 0035, item 7), so a declaration that narrowed a kind's pattern or moved a field — which committed in the
 * product repository, and so moved the unit's inputs — has its old facts taken out by the very turn that reads the new
 * declaration. A plan that skipped such a kind planned nothing, and the graph kept what the old declaration produced.
 */
/** The order the manifest's own declarations give the units' kinds, for a fill asked for a set of them. */
function targetOrder(wiring: PluginTurnWiring): ReadonlyMap<string, number> {
  return new Map((wiring.targets?.kinds ?? []).map((kind, at) => [kind, at] as const));
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
  for (const kind of kinds) {
    const pattern = kind.terms?.[0];
    if (pattern === undefined) continue;
    for (const plugin of [...(wiring.manifest.plugins?.values() ?? [])].sort((left, right) => byCodePoint(left.id, right.id))) {
      const lock = wiring.locks.get(plugin.id);
      if (lock === undefined || !fills(plugin, kind)) continue;
      units.push({ id: pluginTurnUnitId(plugin.id, kind.name, wiring.targets?.vertex), plugin, kind, lock, pattern, wholeGraph: false });
    }
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
  return whole.map((one) => ({ id: pluginTurnUnitId(one.plugin.id, `whole-graph@${digest}`), plugin: one.plugin, lock: one.lock, pattern: '', wholeGraph: true }));
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
    return { id, plugin, lock, pattern: '', wholeGraph: true };
  }
  const at = rest.indexOf('@');
  const kindName = at < 0 ? rest : rest.slice(0, at);
  const kind = wiring.manifest.kinds.get(kindName);
  const pattern = kind?.terms?.[0];
  if (kind === undefined || plugin === undefined || lock === undefined || pattern === undefined || !fills(plugin, kind)) {
    throw new Error(`src/fill/plugin-turns.ts:1: the unit ${JSON.stringify(id)} names a plugin or a kind the manifest no longer declares, or a plugin the lock no longer holds`);
  }
  return { id, plugin, kind, lock, pattern, wholeGraph: false };
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
function entityIdOf(wiring: PluginTurnWiring, kind: string, key: Readonly<Record<string, string | number>>): string | undefined {
  const vertex = wiring.contract.vertex.find((held) => held.name === kind);
  if (vertex === undefined) return undefined;
  const values = vertex.key.map((field) => String(key[field] ?? ''));
  return `${kind}:${values.join('/')}`;
}

/** The one key of a vertex, rendered one way everywhere: its key fields in code point order with their values. */
function canonicalKey(key: Readonly<Record<string, string | number>>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(key).sort(byCodePoint).map((field) => [field, key[field]])));
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
    value: async (kind, key, field) => {
      if (kind !== GIT_WIKI.file) throw new Error(`the graph read of a ${JSON.stringify(kind)} is not one the host answers: a plugin reads the files producer's vertices (${GIT_WIKI.file})`);
      const repository = String(key['repository'] ?? '');
      const path = String(key['path'] ?? '');
      if (field !== 'content') throw new Error(`the field ${JSON.stringify(field)} is not one a plugin reads of a file: the files producer stores its content`);
      return await fileContent(wiring.owner, repository, path);
    },
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

export async function runPluginTurn(wiring: PluginTurnWiring, id: string, draft: StageDraftWriter): Promise<void> {
  const unit = unitOf(wiring, id);
  const pluginFolder = join(wiring.productFolder, unit.plugin.path ?? '');
  const closure = closureOf(pluginFolder);
  if (closure.hash !== unit.lock.closure) {
    throw new Error(`src/fill/plugin-turns.ts:1: the plugin ${unit.plugin.id} at ${pluginFolder} hashes to ${closure.hash}, and madarch/plugins.lock locks ${unit.lock.closure}: a fill runs exactly the closure the lock names, and a changed closure needs a person's approval`);
  }
  const workRoot = mkdtempSync(join(tmpdir(), 'madarch-plugin-turn-'));
  const requests: RequestLog | undefined = wiring.debug === true ? new RequestLog() : undefined;
  const host = new PluginHost({
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
    try {
      const declared = new Set([...(unit.plugin.contract?.vertices.map((vertex) => vertex.kind) ?? []), ...(unit.kind === undefined ? [] : [unit.kind.name])]);
      const outcome = await session.runUnit(unit.wholeGraph
        ? { unitId: id, kind: 'whole-graph', key: {}, inputs: { wholeGraph: true } }
        : { unitId: id, kind: unit.kind!.name, key: { pattern: unit.pattern }, inputs: { pattern: unit.pattern } });
      if (outcome.state !== 'extracted') throw new Error(`src/fill/plugin-turns.ts:1: the unit ${id} was not extracted (${outcome.cause.code}): ${outcome.cause.message}`);
      const answered = new Set<string>();
      // A vertex fill rewrites exactly the entity it names (madarch-stm0.6): the plugin's other answers are dropped, and
      // nothing is removed, because the person asked for one value and not for the kind.
      const only = wiring.targets?.vertex;
      const stated = only === undefined || outcome.result.vertices.some((vertex) => entityIdOf(wiring, vertex.kind, vertex.key) === only);
      for (const vertex of outcome.result.vertices) {
        if (!declared.has(vertex.kind)) throw new Error(`src/fill/plugin-turns.ts:1: the plugin ${unit.plugin.id} answered the kind ${JSON.stringify(vertex.kind)}, which its contract does not declare`);
        if (!unit.wholeGraph && vertex.kind !== unit.kind!.name) throw new Error(`src/fill/plugin-turns.ts:1: the plugin ${unit.plugin.id} answered the kind ${JSON.stringify(vertex.kind)} in the turn of ${JSON.stringify(unit.kind!.name)}`);
        answered.add(`${vertex.kind}\u0000${canonicalKey(vertex.key)}`);
        if (only !== undefined && entityIdOf(wiring, vertex.kind, vertex.key) !== only) continue;
        draft.write({ kind: 'vertex', evidence: unit.kind?.name ?? 'whole-graph', value: {
          kind: vertex.kind,
          key: vertex.key,
          ...(vertex.values === undefined ? {} : { values: vertex.values }),
          ...(draftEvidence(vertex.evidence) === undefined ? {} : { evidence: [draftEvidence(vertex.evidence)!] }),
          producer: unit.plugin.id,
          producerVersion: unit.lock.version,
        } });
      }
      if (only !== undefined && !stated) {
        // The plugin answered no entity of that id: the reader asked for a value the plugin no longer states. Failing the
        // unit says so; answering an empty draft would be a silently smaller result.
        throw new Error(`src/fill/plugin-turns.ts:1: the plugin ${unit.plugin.id} answered no entity ${JSON.stringify(only)} in the unit ${unit.id}: the plugin states no such value at the commit this fill read, and nothing was rewritten`);
      }
      if (only === undefined) {
        for (const edge of outcome.result.edges ?? []) {
          draft.write({ kind: 'edge', evidence: unit.kind?.name ?? 'whole-graph', value: {
            kind: edge.kind,
            from: edge.from,
            to: edge.to,
            ...(edge.discriminator === undefined ? {} : { discriminator: edge.discriminator }),
            ...(edge.values === undefined ? {} : { values: edge.values }),
            ...(draftEvidence(edge.evidence) === undefined ? {} : { evidence: [draftEvidence(edge.evidence)!] }),
            producer: unit.plugin.id,
            producerVersion: unit.lock.version,
          } });
        }
      }
      // The unit's entry names its author and, under the debug setting, every request it made — its refusals, its
      // failures and any the unit abandoned included, each with its answer's size and its cause's class, never an
      // argument or a text. It is a draft like the rest, so it lands in the publication's own transaction.
      draft.write({ kind: 'journal', evidence: unit.kind?.name ?? 'whole-graph', value: { author, ...(requests === undefined ? {} : { reads: requests.finish() }) } });
      journaled = true;
      if (only === undefined && outcome.result.end.state === 'complete') {
        // A unit's complete answer retracts the entities its producer held and this answer does not state. A whole-graph
        // plugin states several kinds, so each of its declared kinds is compared; a unit turn states its one kind.
        const removalKinds = unit.wholeGraph
          ? [...new Set((unit.plugin.contract?.vertices ?? []).map((vertex) => vertex.kind))].filter((kind) => wiring.manifest.kinds.has(kind))
          : [unit.kind!.name];
        for (const kind of removalKinds) {
          for (const held of await producerEntities(wiring.owner, wiring.contract, kind, unit.plugin.id)) {
            if (answered.has(`${kind}\u0000${canonicalKey(held.key)}`)) continue;
            draft.write({ kind: 'vertex-removal', evidence: unit.kind?.name ?? 'whole-graph', value: { kind, key: held.key, producer: unit.plugin.id } });
          }
        }
      }
    } finally {
      await session.close();
    }
  } catch (error) {
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
    version: 1,
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
      await runPluginTurn(wiring, unit.id, context.draft);
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
      await runPluginTurn(wiring, unit.id, context.draft);
      return { outcome: 'draft' };
    },
    validate: () => ({ ok: true }),
  };
}

/** The stage's id, as a workflow may name it. */
export const PLUGIN_TURN_STAGE_ID = 'plugin-turns';
/** The whole-graph turn's stage id. */
export const WHOLE_GRAPH_STAGE_ID = 'whole-graph-turns';
