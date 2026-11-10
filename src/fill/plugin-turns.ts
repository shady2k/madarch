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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { byCodePoint } from '../model/order.js';
import { matchesAny, type KindDecl, type KindsManifest, type PluginDecl } from '../knowledge/kinds.js';
import type { GraphContract } from '../graph/contract.js';
import { fileContent, graphFiles, producerEntities } from '../graph/plugin-turns.js';
import { closureOf } from '../plugin/closure.js';
import { PluginHost, type GraphAnswerer } from '../plugin/host.js';
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
  /** The cgroup the plugin runs under, when the machine delegates one (`MADARCH_PLUGIN_CGROUP`). */
  readonly cgroupParent?: string;
}

/** One unit of a plugin's turn: the plugin, and the kind whose documents it reads. */
export interface PluginTurnUnit {
  readonly id: string;
  readonly plugin: PluginDecl;
  readonly kind: KindDecl;
  readonly lock: PluginLockEntry;
  readonly pattern: string;
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

/** One unit's id: its plugin and its kind, so a worker of any process derives it again. */
export function pluginTurnUnitId(plugin: string, kind: string): string {
  return `${plugin}:${kind}`;
}

/**
 * The units one fill's plugin turns plan: one per plugin and kind, so the plugin reads every document its kind names
 * through the host. A kind no plugin fills, or a product whose lock holds none of its plugins, plans nothing.
 */
export async function planPluginTurns(wiring: PluginTurnWiring): Promise<PluginTurnUnit[]> {
  const kinds = pluginKindsOf(wiring.manifest);
  if (kinds.length === 0) return [];
  // The units stand on the file vertices the tree pass publishes: a plan made before they stand finds nothing, and the
  // run plans this stage again once the tree published (decision 0027's re-planning of a stage that found nothing).
  const files = await graphFiles(wiring.owner, wiring.contract);
  if (files.length === 0) return [];
  const units: PluginTurnUnit[] = [];
  for (const kind of kinds) {
    const pattern = kind.terms?.[0];
    if (pattern === undefined) continue;
    if (!files.some((file) => matchesAny([pattern], file.path))) continue;
    for (const plugin of [...(wiring.manifest.plugins?.values() ?? [])].sort((left, right) => byCodePoint(left.id, right.id))) {
      const lock = wiring.locks.get(plugin.id);
      if (lock === undefined || !fills(plugin, kind)) continue;
      units.push({ id: pluginTurnUnitId(plugin.id, kind.name), plugin, kind, lock, pattern });
    }
  }
  return units.sort((left, right) => byCodePoint(left.id, right.id));
}

/** The unit a worker re-derives from its id, against the manifest it reads itself. */
function unitOf(wiring: PluginTurnWiring, id: string): PluginTurnUnit {
  const cut = id.indexOf(':');
  if (cut < 0) throw new Error(`src/fill/plugin-turns.ts:1: the unit id ${JSON.stringify(id)} is no plugin turn: it is <plugin>:<kind>`);
  const kindName = id.slice(cut + 1);
  const kind = wiring.manifest.kinds.get(kindName);
  const plugin = wiring.manifest.plugins?.get(id.slice(0, cut));
  const lock = plugin === undefined ? undefined : wiring.locks.get(plugin.id);
  const pattern = kind?.terms?.[0];
  if (kind === undefined || plugin === undefined || lock === undefined || pattern === undefined || !fills(plugin, kind)) {
    throw new Error(`src/fill/plugin-turns.ts:1: the unit ${JSON.stringify(id)} names a plugin or a kind the manifest no longer declares, or a plugin the lock no longer holds`);
  }
  return { id, plugin, kind, lock, pattern };
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

/** The one key of a vertex, rendered one way everywhere: its key fields in code point order with their values. */
function canonicalKey(key: Readonly<Record<string, string | number>>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(key).sort(byCodePoint).map((field) => [field, key[field]])));
}

/**
 * The graph the host answers a plugin's reads from: the file vertices its pattern names, and a file's content as the
 * files producer stored it. The plugin never sees a folder (decision 0035, item 9).
 */
function answererOf(wiring: PluginTurnWiring): GraphAnswerer {
  return {
    files: async (pattern) => (await graphFiles(wiring.owner, wiring.contract))
      .filter((file) => matchesAny([pattern], file.path))
      .map((file) => ({ kind: GIT_WIKI.file, key: { repository: file.repository, path: file.path } })),
    value: async (kind, key, field) => {
      if (kind !== GIT_WIKI.file) throw new Error(`the graph read of a ${JSON.stringify(kind)} is not one the host answers: a plugin reads the files producer's vertices (${GIT_WIKI.file})`);
      const repository = String(key['repository'] ?? '');
      const path = String(key['path'] ?? '');
      if (field !== 'content') throw new Error(`the field ${JSON.stringify(field)} is not one a plugin reads of a file: the files producer stores its content`);
      return await fileContent(wiring.owner, repository, path);
    },
  };
}

/**
 * Runs one unit of a plugin's turn: the plugin answers the terms of every document its kind names, read through the
 * host from the graph, and the answer lands as drafts — one vertex per entity with its claims, and one removal per
 * entity the producer holds and this answer does not (a complete unit only; a partial unit publishes no removal).
 */
export async function runPluginTurn(wiring: PluginTurnWiring, id: string, draft: StageDraftWriter): Promise<void> {
  const unit = unitOf(wiring, id);
  const pluginFolder = join(wiring.productFolder, unit.plugin.path ?? '');
  const closure = closureOf(pluginFolder);
  if (closure.hash !== unit.lock.closure) {
    throw new Error(`src/fill/plugin-turns.ts:1: the plugin ${unit.plugin.id} at ${pluginFolder} hashes to ${closure.hash}, and madarch/plugins.lock locks ${unit.lock.closure}: a fill runs exactly the closure the lock names, and a changed closure needs a person's approval`);
  }
  const workRoot = mkdtempSync(join(tmpdir(), 'madarch-plugin-turn-'));
  const host = new PluginHost({
    pluginFolder,
    closure,
    repository: wiring.productFolder,
    graph: answererOf(wiring),
    workRoot,
    trust: 'production',
    releaseHashes: wiring.releaseHashes ?? RELEASE_CLOSURE_HASHES,
    ...(wiring.cgroupParent === undefined ? {} : { cgroupParent: wiring.cgroupParent }),
  });
  try {
    const session = await host.open();
    try {
      const outcome = await session.runUnit({ unitId: id, kind: unit.kind.name, key: { pattern: unit.pattern }, inputs: { pattern: unit.pattern } });
      if (outcome.state !== 'extracted') throw new Error(`src/fill/plugin-turns.ts:1: the unit ${id} was not extracted (${outcome.cause.code}): ${outcome.cause.message}`);
      const where = draftEvidence(outcome.result.vertices.flatMap((vertex) => vertex.claims ?? [])[0]?.evidence);
      const answered = new Set<string>();
      for (const vertex of outcome.result.vertices) {
        if (vertex.kind !== unit.kind.name) throw new Error(`src/fill/plugin-turns.ts:1: the plugin ${unit.plugin.id} answered the kind ${JSON.stringify(vertex.kind)} in the turn of ${JSON.stringify(unit.kind.name)}`);
        answered.add(canonicalKey(vertex.key));
        draft.write({ kind: 'vertex', evidence: unit.kind.name, value: {
          kind: vertex.kind,
          key: vertex.key,
          ...(vertex.attributes === undefined ? {} : { attributes: vertex.attributes }),
          claims: (vertex.claims ?? []).map((claim) => ({ field: claim.field, value: claim.value, evidence: draftEvidence(claim.evidence) ?? where ?? {} })),
          ...(where === undefined ? {} : { evidence: where }),
          producer: unit.plugin.id,
          producerVersion: unit.lock.version,
        } });
      }
      if (outcome.result.end.state === 'complete') {
        for (const held of await producerEntities(wiring.owner, wiring.contract, unit.kind.name, unit.plugin.id)) {
          if (answered.has(canonicalKey(held.key))) continue;
          draft.write({ kind: 'vertex-removal', evidence: unit.kind.name, value: { kind: unit.kind.name, key: held.key, producer: unit.plugin.id } });
        }
      }
    } finally {
      await session.close();
    }
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
      return { units: units.map((unit) => ({ id: unit.id, scope: unit.kind.name })), coverage: 'planned' };
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
