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
import { declareProducerScope } from '../graph/applicability.js';
import { fillProductProfile } from '../graph/product-profile.js';
import { storedApplicability, assertApplicability, assertProducedApplicability, cascadeApplicability } from '../graph/applicability.js';
import type { AgentUsageRecord } from '../adapters/agent-usage.js';
import { AgentMeter, type AgentRunBudget, type AgentUsageStop } from './agent-meter.js';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DEFAULT_ORCHESTRATOR_LIMITS } from './orchestrator.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { byCodePoint } from '../model/order.js';
import { kindsInDependencyOrder, matchesAny, type KindDecl, type KindsManifest, type PluginDecl } from '../product/manifest/kinds.js';
import type { GraphContract } from '../graph/contract.js';
import { graphFiles, producerEntities, successfulPluginSnapshot, pluginSnapshotVertices, pluginGraphValue, pluginPartitionOutcome } from '../graph/plugin-turns.js';
import { removedEdgeEnds, unevidencedAssertions, type EvidenceDeclaration } from '../graph/index.js';
import { generatedTableName, graphContractVersion } from '../graph/contract.js';
import { applyPluginFacts } from '../graph/graph-writes.js';
import { producerFacts } from '../graph/producer-facts.js';
import { closureOf, pluginManifestLine, pluginRightsOf } from '../plugin/closure.js';
import { prepareRepositoryInputs } from '../plugin/repository-input.js';
import { withSpan, withSpanSync } from '../obs/trace.js';
import { pluginLogFolder, recordFileName } from './run-records.js';
import { planManifestFill } from '../plugin/fill-declarations.js';
import { pluginInvocationAccess } from '../plugin/fill-access.js';
import type { GraphAnswerer, RequestLog } from '../plugin/host.js';
import { validateUnitResult, canonicalKey, canonicalEntity } from '../plugin/results.js';
import { canonicalJsonDigest } from '../model/canonical.js';
import type { PluginLockEntry } from '../plugin/lock.js';
import type { SnapshotSource } from '../plugin/repository-snapshot.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from './stage.js';
import type { PluginAgentOptions, PluginAgentReport } from '../plugin/agent.js';
import { startAgentGraphMcp } from './agent-graph.js';
import { UnitBoundStop } from './unit-bound.js';
import type { PluginContractDeclaration } from '../plugin/protocol.js';

/** The store one turn reads and writes, as the graph's own reads name it: the process's one owner, never a second. */
export type GraphOwner = Parameters<typeof producerEntities>[0];

/** What the plugin turn reads: the product's manifest, its lock, its checkouts and the graph the fill writes. */
export interface PluginTurnWiring {
  readonly sourceUid?: string;
  /** The runtime binds run, unit and principal; producers cannot choose authority. */
  readonly executeOperation?: <Result>(unit: string, key: string, request: unknown, apply: (tx: import('../history-types.js').OuterTransaction) => Promise<Result>, preconditions?: readonly { readonly uid: string; readonly recordedSequence: string }[]) => Promise<Result>;
  /** Host-owned adapter configuration, present only for a pressed agent fill. */
  readonly agent?: PluginAgentOptions;
  readonly productFolder: string;
  readonly manifest: KindsManifest;
  /** The plugins the lock records, by id; a declared plugin the lock does not hold does not run. */
  readonly locks: ReadonlyMap<string, PluginLockEntry>;
  readonly owner: GraphOwner;
  readonly snapshots: SnapshotSource;
  /** Run-owned sanitized sources; the host still copies them privately for every invocation. */
  readonly prepareRepositoryInputs?: typeof prepareRepositoryInputs;
  /** Optional repository-path prefixes selected by this fill. */
  readonly paths?: readonly string[];
  /** The contract the manifest's declarations made: the file table the units are read from, the tables the claims go to. */
  readonly contract: GraphContract;
  /** The release closures trusted without approval; the build's own unless a test names its own. */
  readonly releaseHashes?: readonly string[];
  /**
   * The kinds this fill was asked for (decision 0035, items 11 and 31; madarch-stm0.6): their turns only, in this
   * dependency order, and with a vertex, the one entity of that kind's unit whose answer is published. Absent, the
   * fill takes every kind an enabled plugin declares it produces.
   */
  readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string; readonly requested?: readonly string[]; readonly pluginsOnly?: boolean };
  /**
   * The store's `traces` folder (madarch-64o5.88): every unit's plugin standard error is kept there beside the run's
   * trace, under `<run>.plugins/`, so the logs page reads it after the unit's scratch folder is gone. Left out, the
   * plugin's log stays only as long as the unit's scratch folder.
   */
  readonly traces?: string;
  /** The cgroup the plugin runs under, when the machine delegates one (`MADARCH_PLUGIN_CGROUP`). */
  readonly cgroupParent?: string;
  /** This machine and its person chose to run plugins without isolation (decision 0038): the turn's own choice. */
  readonly unconfined?: boolean;
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

function declaredSupport(wiring: PluginTurnWiring, unit: PluginTurnUnit) {
  const requested = unit.plugin.declaration?.produces.find(output => output.kind === unit.kind.name)?.support;
  const vertices = new Map<string, readonly string[]>();
  for (const name of requested?.vertices ?? []) {
    if (name === unit.kind.name) continue;
    const vertex = unit.plugin.contract?.vertices.find(vertex => vertex.kind === name);
    const installed = wiring.manifest.kinds.get(name);
    if (vertex?.evidence?.immutable !== true || installed === undefined) throw new Error(`${unit.plugin.id}: support vertex ${name} must be an installed, declared immutable output`);
    const fields = vertex.fields.map(field => field.name);
    for (const name of fields) {
      const field = installed.fields?.find(field => field.name === name);
      if (field === undefined || (!field.producers?.includes(unit.plugin.id) && !(field.binding?.kind === 'plugin' && field.binding.plugin === unit.plugin.id))) throw new Error(`${unit.plugin.id}: support field ${vertex.kind}.${name} is not granted to this producer`);
    }
    vertices.set(name, fields);
  }
  const edges = new Set(requested?.edges ?? []);
  for (const kind of edges) {
    const edge = unit.plugin.contract?.edges.find(edge => edge.kind === kind);
    if (edge === undefined || !wiring.contract.edge.some(edge => edge.name === kind)) throw new Error(`${unit.plugin.id}: support edge ${kind} is not installed and declared`);
    const from = typeof edge.from === 'string' ? [edge.from] : edge.from;
    const to = typeof edge.to === 'string' ? [edge.to] : edge.to;
    if (![...from, ...to].some(kind => vertices.has(kind) || (kind === unit.kind.name && unit.plugin.contract?.vertices.find(vertex => vertex.kind === kind)?.evidence?.immutable === true))) throw new Error(`${unit.plugin.id}: support edge ${kind} has no declared immutable support endpoint`);
    for (const endpoint of [...from, ...to]) if (!wiring.manifest.kinds.has(endpoint)) throw new Error(`${unit.plugin.id}: support edge ${kind} names uninstalled endpoint ${endpoint}`);
  }
  return { vertices, edges };
}

/** Runtime-only authority, resolved from the selected plugin declaration rather than producer input. */
export function pluginTurnAuthority(wiring: PluginTurnWiring, id: string): { sourceName: string; version: string; permissions: import('../graph/write.js').WriteCapability['permissions'] } {
  const unit = unitOf(wiring, id);
  const plan = planManifestFill(wiring.manifest, wiring.productFolder, wiring.targets?.kinds, wiring.agent !== undefined, wiring.targets?.requested, wiring.targets?.pluginsOnly === true);
  const fields = plan.outputs.get(unit.plugin.id)?.get(unit.kind.name) ?? [];
  const support = declaredSupport(wiring, unit);
  return {
    sourceName: unit.plugin.id, version: unit.lock.version,
    permissions: [
      ...['system.kind-applicability','system.applicability-product','system.applicability-kind'].map(kind => ({kind,properties:['*'],assert:true,retractOwn:true})),
      ...[...support.vertices].map(([kind, fields]) => ({ kind, properties: ['$exists', ...fields], assert: true, retractOwn: false })),
      { kind: unit.kind.name, properties: ['$exists', ...fields, ...(unit.kind.key ?? [])], assert: true, retractOwn: true },
      ...(unit.plugin.contract?.edges ?? []).map(edge => ({ kind: edge.kind, properties: ['$exists', ...edge.fields.map(field => field.name)], assert: true, retractOwn: true })),
    ],
  };
}

/** One unit of a plugin's turn: its selected output kind and declared producer. */
export interface PluginTurnUnit {
  readonly id: string;
  readonly plugin: PluginDecl;
  readonly kind: KindDecl;
  readonly lock: PluginLockEntry;
  /** The document patterns the plugin's kinds name; the plugin also knows its own contract's patterns. */
  readonly patterns: readonly string[];
}

/** Whether a plugin declares output for a kind, regardless of its implementation or bindings. */
function fills(plugin: PluginDecl, kind: KindDecl): boolean {
  return plugin.declaration?.produces.some((output) => output.kind === '*' || output.kind === kind.name) === true;
}

/** The declaration-owned producer plugins of one kind, using the same matcher as turn planning. */
export function pluginsFillingKind(manifest: KindsManifest, kindName: string): string[] {
  const kind = manifest.kinds.get(kindName);
  return kind === undefined ? [] : [...(manifest.plugins?.values() ?? [])].filter((plugin) => fills(plugin, kind)).map((plugin) => plugin.id).sort(byCodePoint);
}

/** The plugin's kinds in the manifest, the earliest in the dependency order first. */
function outputKindsOf(manifest: KindsManifest, plugin: PluginDecl): KindDecl[] {
  const rank = new Map(kindsInDependencyOrder(manifest).map((name, at) => [name, at] as const));
  return [...manifest.kinds.values()].filter((kind) => fills(plugin, kind))
    .sort((left, right) => (rank.get(left.name) ?? 0) - (rank.get(right.name) ?? 0) || byCodePoint(left.name, right.name));
}

/** One unit's id: its plugin and its kind, so a worker of any process derives it again. */
export function pluginTurnUnitId(plugin: string, kind: string, vertex?: string): string {
  return `${plugin}:${kind}${vertex === undefined ? '' : `@${vertex}`}`;
}

/** A vertex selector scopes only its own kind, never the prerequisite units it needs. */
function selectedVertex(wiring: PluginTurnWiring, kind: string): string | undefined {
  const vertex = wiring.targets?.vertex;
  return vertex !== undefined && vertex.slice(0, vertex.indexOf(':')) === kind ? vertex : undefined;
}

/** One unit per selected output kind of every declared producer. Missing locks refuse the plan. */
export async function planPluginTurns(wiring: PluginTurnWiring): Promise<PluginTurnUnit[]> {
  const applicability = await fillProductProfile(wiring.owner, wiring.contract, wiring.manifest, wiring.snapshots);
  const plan = planManifestFill(wiring.manifest, wiring.productFolder, wiring.targets?.kinds, wiring.agent !== undefined, wiring.targets?.requested, wiring.targets?.pluginsOnly === true);
  const units: PluginTurnUnit[] = [];
  for (const name of plan.order) {
    const plugin = wiring.manifest.plugins!.get(name)!;
    const lock = wiring.locks.get(name);
    if (lock === undefined) {
      const file = plugin.declarationFile ?? join(wiring.productFolder, plugin.path ?? '', 'plugin.json');
      throw new Error(`${file}:1: selected producer ${name} has no enabled lock; enable its producer`);
    }
    const selected = outputKindsOf(wiring.manifest, plugin).filter((kind) => plan.outputs.get(name)?.has(kind.name) === true);
    for (const kind of selected.filter(kind => plugin.contract?.agent === undefined || !applicability.some(mark => mark.kind === kind.name && mark.state === 'inapplicable'))) units.push({ id: pluginTurnUnitId(name, kind.name, selectedVertex(wiring, kind.name)), plugin, kind, lock, patterns: [...new Set(kind.terms ?? [])] });
  }
  return units;
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
      const storageKind = vertex.kind;
      declarations.push({ kind: storageKind, table: generatedTableName(storageKind, 'vertex'), producer: plugin.id, fields, key: kind.key ?? [] });
    }
  }
  return declarations;
}

/** The unit a worker re-derives from its id, against the manifest it reads itself. */
function unitOf(wiring: PluginTurnWiring, id: string): PluginTurnUnit {
  const cut = id.indexOf(':');
  if (cut < 0) throw new Error(`${import.meta.path}:1: the unit id ${JSON.stringify(id)} is no plugin turn: it is <plugin>:<kind>`);
  const rest = id.slice(cut + 1).split('#')[0]!;
  const plugin = wiring.manifest.plugins?.get(id.slice(0, cut));
  const lock = plugin === undefined ? undefined : wiring.locks.get(plugin.id);
  const at = rest.indexOf('@');
  const kindName = at < 0 ? rest : rest.slice(0, at);
  const kind = wiring.manifest.kinds.get(kindName);
  const patterns = [...new Set(kind?.terms ?? [])];
  if (kind === undefined || plugin === undefined || lock === undefined || !fills(plugin, kind)) {
    throw new Error(`${import.meta.path}:1: the unit ${JSON.stringify(id)} names a plugin or a kind the manifest no longer declares, or a plugin the lock no longer holds`);
  }
  return { id, plugin, kind, lock, patterns };
}

/** The plugin names a pinned source; lineage names its declared graph endpoint (0039 item 14). */
function draftEvidence(evidence: import('../plugin/protocol.js').PluginEvidence | undefined): import('../graph/contract.js').EvidenceDraft[] {
  if (evidence === undefined) return [];
  return [{ target: evidence.target, locator: {
    ...(evidence.path === undefined ? {} : { path: evidence.path }),
    ...(evidence.commit === undefined ? {} : { commit: evidence.commit }),
    ...(evidence.digest === undefined ? {} : { digest: evidence.digest }),
    ...(evidence.lineStart === undefined ? {} : { lineStart: evidence.lineStart }),
    ...(evidence.lineEnd === undefined ? {} : { lineEnd: evidence.lineEnd }),
  } }];
}

/** One drafted vertex as the graph names the entity: `<kind>:<its key values in the contract's order, joined by /">`. */
function entityIdOf(wiring: PluginTurnWiring, kind: string, key: import('../plugin/protocol.js').PluginKeyValues): string | undefined {
  const ref = { kind, key };
  const vertex = wiring.contract.vertex.find((held) => held.name === ref.kind);
  if (vertex === undefined) return undefined;
  const values = vertex.key.map((field) => String(ref.key[field] ?? ''));
  return `${ref.kind}:${values.join('/')}`;
}


/**
 * The graph the host answers a plugin's reads from: the file vertices its pattern names, and a file's content as the
 * files producer stored it. The plugin never sees a folder (decision 0035, item 9). The host records each request it
 * answers — and each it refuses — in the unit's `RequestLog`, so the answerer states no sizes of its own.
 */
export function pluginGraphAnswerer(wiring: Pick<PluginTurnWiring, 'owner' | 'manifest' | 'contract' | 'sourceUid'>): GraphAnswerer {
  const snapshots = new Map<string, Promise<Map<string, { readonly key: import('../plugin/protocol.js').PluginKeyValues; readonly keyEdges?: Readonly<Record<string, import('../plugin/protocol.js').PluginEntityRef>>; readonly values: Readonly<Record<string, unknown>> }>>>();
  const vertices = (snapshot: import('../graph/plugin-turns.js').PluginSnapshot, kind: string) => {
    const identity = canonicalJsonDigest({ snapshot, kind });
    let held = snapshots.get(identity);
    if (held === undefined) {
      held = pluginSnapshotVertices(wiring.owner, snapshot, kind).then((rows) => new Map(rows.map((row) => [canonicalEntity({ kind, ...row }), row])));
      snapshots.set(identity, held);
    }
    return held;
  };
  return {
    ownFacts: async (query) => {
      const separator = query.unitId.indexOf(':');
      const producer = query.unitId.slice(0, separator);
      const kindName = query.unitId.slice(separator + 1).split('@')[0]!.split('#')[0]!;
      const plugin = wiring.manifest.plugins?.get(producer);
      const kind = wiring.manifest.kinds.get(kindName);
      if (separator < 0 || plugin === undefined || kind === undefined || !fills(plugin, kind)) throw new Error(`${import.meta.path}:218: invalid own-facts unit ${query.unitId}`);
      const edges = (plugin.contract?.edges ?? []).filter((edge) => edge.from === kindName || edge.to === kindName).map((edge) => edge.kind);
      if (wiring.sourceUid === undefined) throw new Error(`${import.meta.path}:1: authenticated producer source is unavailable`);
      return await producerFacts(wiring.owner, wiring.contract, wiring.sourceUid, [kindName], edges);
    },
    files: async (pattern, snapshot) => {
      const files = snapshot === undefined ? await graphFiles(wiring.owner, wiring.contract)
        : [...(await vertices(snapshot, 'code.file')).values()].map(({ key, keyEdges }) => {
          if (typeof key.path !== 'string') throw new Error('immutable code.file snapshot has an invalid declared key');
          return { path: key.path, keyEdges: keyEdges ?? {} };
        });
      return files.filter((file) => matchesAny([pattern], file.path))
        .map((file) => ({ kind: 'code.file', key: { path: file.path }, keyEdges: file.keyEdges }));
    },
    value: async (kind, key, field, keyEdges, snapshot) => {
      const ref = { kind, key };
      if (snapshot !== undefined) {
        const vertex = (await vertices(snapshot, kind)).get(canonicalEntity({ kind, key, ...(keyEdges === undefined ? {} : { keyEdges }) }));
        return vertex === undefined ? null : vertex.key[field] ?? vertex.values[field] ?? null;
      }
      return await pluginGraphValue(wiring.owner, wiring.contract, ref.kind, ref.key, field, keyEdges);
    },
    // The writer's consistency records (madarch-stm0.7.1, pieces 2 and 4), one bounded page at a time: the plugin asks
    // by name, and the store is read here, in the fill's own layer, never by the plugin.
    removedEnds: async (query) => {
      const page = await removedEdgeEnds(wiring.owner, query);
      return { edges: page.rows, ...(page.next === undefined ? {} : { next: page.next }) };
    },
    unevidenced: async (query) => {
      const page = await unevidencedAssertions(wiring.owner, evidenceDeclarations(wiring.manifest), query);
      return { assertions: page.rows, ...(page.next === undefined ? {} : { next: page.next }) };
    },
  };
}

/** Replay the same plugin read during execution, publication, and cache validation. */
export async function answerPluginGraphQuery(answerer: GraphAnswerer, text: string): Promise<readonly unknown[]> {
  const request = JSON.parse(text) as { read: string; method: keyof GraphAnswerer; args: unknown[] };
  if (request.read !== 'plugin') throw new Error(`${import.meta.path}:1: expected a plugin graph read`);
  switch (request.method) {
    case 'files': return [await answerer.files(...request.args as Parameters<GraphAnswerer['files']>)];
    case 'value': return [await answerer.value(...request.args as Parameters<GraphAnswerer['value']>)];
    case 'removedEnds': return [await answerer.removedEnds!(...request.args as Parameters<NonNullable<GraphAnswerer['removedEnds']>>)];
    case 'unevidenced': return [await answerer.unevidenced!(...request.args as Parameters<NonNullable<GraphAnswerer['unevidenced']>>)];
    default: throw new Error(`${import.meta.path}:1: unknown plugin graph read`);
  }
}

export function trackedPluginAnswerer(graph: { query(text: string): Promise<readonly unknown[]> }): GraphAnswerer {
  const read = async <T>(method: keyof GraphAnswerer, args: readonly unknown[]): Promise<T> => {
    const supplied = [...args];
    while (supplied.length > 0 && supplied[supplied.length - 1] === undefined) supplied.pop();
    return (await withSpan('graph.plugin-turns.trackedPluginAnswerer', {}, async () => await graph.query(JSON.stringify({ read: 'plugin', method, args: supplied }))))[0] as T;
  };
  return {
    files: (...args) => read('files', args),
    value: (...args) => read('value', args),
    removedEnds: (...args) => read('removedEnds', args),
    unevidenced: (...args) => read('unevidenced', args),
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
    kind: unit.kind.name,
    ...(unit.plugin.bounds === undefined ? {} : { bounds: unit.plugin.bounds }),
    ...(usage.budget === undefined ? {} : { budget: usage.budget }),
    save: usage.save,
  });
}

/**
 * The error one unit that did not extract is ended with: a bound the run declares — the agent's time, the plugin's
 * silence, the run's own time — is a `UnitBoundStop`, so the attempt fails the unit with its reason and spends no retry
 * on the same wall (owner's decision, 2026-11-15). Any other refusal stays a failure another attempt may survive.
 */
function unitStopped(id: string, code: string, message: string): Error {
  const named = `${import.meta.path}:1: the unit ${id} was not extracted (${code}): ${message}`;
  const bound = code === 'agent-timeout' ? 'agent-time' : code === 'heartbeat-missed' ? 'plugin-silence' : code === 'run-timeout' ? 'run-time' : code === 'agent-budget' ? 'tokens' : undefined;
  return bound === undefined ? new Error(named) : new UnitBoundStop(bound, named);
}

/**
 * The task a fill's agent is given (owner's decision, 2026-11-15): the kind it fills, what that kind is, and what each
 * field of its answer means, in English. Nothing of the graph is preloaded: the agent's session carries madarch's graph
 * server, and it reads there what it decides it needs.
 */
function agentTaskOf(kind: KindDecl, outputs: PluginContractDeclaration): Record<string, unknown> {
  const vertex = outputs.vertices.find((held) => held.kind === kind.name);
  return {
    kind: kind.name,
    what: kind.descriptions?.['en'] ?? kind.name,
    key: [...(vertex?.key ?? kind.key ?? [])],
    fields: (vertex?.fields ?? []).map((field) => ({ name: field.name, meaning: field.meaning })),
    relations: outputs.edges.map((edge) => ({ kind: edge.kind, from: edge.from, to: edge.to })),
  };
}

export async function runPluginTurn(wiring: PluginTurnWiring, id: string, completeOutcome: (outcome: import('./producer-outcomes.js').ProducerOutcomeDraft) => void, progress?: (note: string, fraction?: number) => void, signal?: AbortSignal, graph?: GraphAnswerer, runId?: string, partition?: { readonly keys?: readonly import('../plugin/protocol.js').PluginKeyValues[]; readonly plan?: (partitions: readonly { readonly keys: readonly import('../plugin/protocol.js').PluginKeyValues[] }[]) => void }): Promise<void> {
  const { PluginHost, RequestLog: PluginRequestLog } = await import('../plugin/host.js');
  const { RELEASE_CLOSURE_HASHES } = await import('../plugin/release-closures.js');
  const unit = unitOf(wiring, id);
  if (unit.plugin.contract?.agent !== undefined) {
    const marks = await storedApplicability(wiring.owner,wiring.contract);
    const mark = marks.find(mark => mark.kind === unit.kind.name && mark.state === 'inapplicable');
    if (mark !== undefined) {
      completeOutcome({plugin:unit.plugin.id,kind:unit.kind.name,outcome:'empty',produced:0,reason:mark.reason});
      return;
    }
  }
  if (wiring.executeOperation !== undefined) await wiring.executeOperation(id,'producer-scope',{kind:unit.kind.name,plugin:unit.plugin.id},async tx => await declareProducerScope(tx,wiring.contract,unit.kind.name,unit.plugin.id));
  // The unit's meter (madarch-stm0.4): the agent part of this plugin hands it each ACP session update, and what it holds
  // is written once the unit ends — a unit with no agent part wrote nothing, and says so by holding no row.
  const meter = pluginUnitMeter(wiring, unit);
  const pluginFolder = join(wiring.productFolder, unit.plugin.path ?? '');
  const closure = withSpanSync('plugin.closure.verify', {}, () => closureOf(pluginFolder));
  if (closure.hash !== unit.lock.closure) {
    throw new Error(`${import.meta.path}:1: the plugin ${unit.plugin.id} at ${pluginFolder} hashes to ${closure.hash}, and madarch/plugins.lock locks ${unit.lock.closure}: a fill runs exactly the closure the lock names, and a changed closure needs a person's approval`);
  }
  const requests: RequestLog | undefined = wiring.debug === true ? new PluginRequestLog() : undefined;
  let agentReport: PluginAgentReport | undefined;
  const declarationPlan = planManifestFill(wiring.manifest, wiring.productFolder, wiring.targets?.kinds, wiring.agent !== undefined, wiring.targets?.requested, wiring.targets?.pluginsOnly === true);
  const allowedFields = declarationPlan.outputs.get(unit.plugin.id)?.get(unit.kind.name) ?? [];
  const outputOrder = outputKindsOf(wiring.manifest, unit.plugin).map((kind) => kind.name);
  // The product's declared key-edge roles, by kind: a fact may reach a parent kind the unit does not output, and the
  // plugin prunes a role the product's declaration does not hold (0039, item 2) from facts it returns.
  const declaredKeyEdges = Object.fromEntries(wiring.contract.vertex.map(vertex => [vertex.name, (vertex.keyEdges ?? []).map(edge => edge.role)]));
  const support = declaredSupport(wiring, unit);
  const supportOutputs = support.vertices;
  // An edge is published in the turn of the later of its ends' kinds; an edge between two kinds the plugin reads rather
  // than produces — a file imports a file — belongs to the plugin's last output turn, the turn in which it reads them.
  // The plugin's reads, not the catalogue's derives-from, is what makes a file the source of such an edge.
  const edgeOwner = (from: string, to: string): string | undefined =>
    outputOrder.filter((kind) => kind === from || kind === to).at(-1) ?? outputOrder.at(-1);
  const edgeOutputs = (unit.plugin.contract?.edges ?? []).flatMap((edge) => {
    const fromKinds = typeof edge.from === 'string' ? [edge.from] : edge.from;
    const toKinds = typeof edge.to === 'string' ? [edge.to] : edge.to;
    return fromKinds.flatMap((from) => toKinds.filter((to) => support.edges.has(edge.kind) || edgeOwner(from, to) === unit.kind.name)
      .map((to) => ({ kind: edge.kind, from, to })));
  });
  const ownsEdge = (edge: { readonly kind: string; readonly from: { readonly kind: string }; readonly to: { readonly kind: string } }): boolean =>
    edgeOutputs.some((held) => held.kind === edge.kind && held.from === edge.from.kind && held.to === edge.to.kind);
  const unitEdges = new Set(edgeOutputs.map((edge) => edge.kind));
  const file = unit.plugin.declarationFile ?? join(wiring.productFolder, unit.plugin.path ?? '', 'plugin.json');
  const location = `${file}:${pluginManifestLine(unit.plugin.declarationText ?? '{}', ['produces'])}`;
  const reads = declarationPlan.readsFor(unit.plugin.id, unit.kind.name);
  const snapshots = new Map<string, Awaited<ReturnType<typeof successfulPluginSnapshot>>>();
  const capturedSnapshots = new Map<string, ReturnType<typeof successfulPluginSnapshot>>();
  const captureSnapshot = (producer: string, kind: string) => {
    const scope = pluginTurnUnitId(producer, kind, selectedVertex(wiring, kind));
    let captured = capturedSnapshots.get(scope);
    if (captured === undefined) {
      captured = successfulPluginSnapshot(wiring.owner, runId!, scope);
      capturedSnapshots.set(scope, captured);
    }
    return captured;
  };
  for (const read of reads) if (typeof read !== 'string') {
    if (runId === undefined) throw new Error(`${location}: output ${unit.kind.name} requires current-run identity to capture earlier snapshot ${read.kind} from ${read.producer}`);
    snapshots.set(read.kind, await captureSnapshot(read.producer, read.kind));
  }
  if (runId !== undefined) for (const read of reads) if (typeof read === 'string') {
    for (const field of wiring.manifest.kinds.get(read)?.fields ?? []) {
      const producer = declarationPlan.lastProducer(read, field.name);
      // A unit that reads its own kind reads what stands before its turn: its own generation is not a snapshot yet.
      if (producer !== undefined && !(producer === unit.plugin.id && read === unit.kind.name)) snapshots.set(`${read}.${field.name}`, await captureSnapshot(producer, read));
    }
  }
  const partitionKeys = partition?.keys === undefined ? undefined : new Set(partition.keys.map(canonicalKey));
  const only = selectedVertex(wiring, unit.kind.name);
  const currentPins = await withSpan('plugin.reconciliation-pins', {}, async () => await wiring.snapshots.pins());
  let priorFactCount = 0;
  const reconciliationGraph: GraphAnswerer = {
    ...(graph ?? pluginGraphAnswerer(wiring)),
    ownFacts: async (query) => {
      if (query.scope.commit !== undefined && query.scope.repository === undefined) throw new Error(`${location}: reconciliation commit scope requires its repository`);
      if (query.unitId !== id) throw new Error(`${location}: reconciliation names another unit`);
      if ((query.scope.repository !== undefined || query.scope.commit !== undefined) && !currentPins.some((pin) => (query.scope.repository === undefined || pin.id === query.scope.repository) && (query.scope.commit === undefined || pin.commit === query.scope.commit))) throw new Error(`${location}: reconciliation scope is not a current repository revision`);
      // Prior output is reconciliation state, never a dependency on this turn's own publication.
      const facts = await pluginGraphAnswerer(wiring).ownFacts!(query);
      const inScope = (ref: import('../plugin/protocol.js').PluginEntityRef, evidence?: import('../plugin/protocol.js').PluginEvidence): boolean => {
        if (query.scope.repository !== undefined && query.scope.parent === undefined) throw new Error(`${location}: repository reconciliation requires an explicit parent identity`);
        const underParent = (reference: import('../plugin/protocol.js').PluginEntityRef): boolean => canonicalEntity(reference) === canonicalEntity(query.scope.parent!) || Object.values(reference.keyEdges ?? {}).some(underParent);
        if (query.scope.parent !== undefined && !underParent(ref)) return false;
        if (partitionKeys !== undefined && !partitionKeys.has(canonicalKey(ref.key))) return false;
        const path = evidence?.path ?? ref.key['path'];
        if (wiring.paths !== undefined && (typeof path !== 'string' || !wiring.paths.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)))) return false;
        if (only !== undefined && entityIdOf(wiring, ref.kind, ref.key) !== only) return false;
        return true;
      };
      const scoped = {
        vertices: facts.vertices.filter((vertex) => inScope(vertex, vertex.evidence)),
        edges: facts.edges.filter((edge) => ownsEdge(edge) && inScope(edge.from.kind === unit.kind.name ? edge.from : edge.to, edge.evidence)),
      };
      priorFactCount = scoped.vertices.length + scoped.edges.length;
      return scoped;
    },
  };
  const access = pluginInvocationAccess(reconciliationGraph, {
    location, plugin: unit.plugin.id, output: unit.kind.name, fields: allowedFields, reads, supportOutputs,
    fileKind: 'code.file', edges: [...unitEdges], snapshots,
  });
  const outputs = {
    vertices: (unit.plugin.contract?.vertices ?? []).filter((vertex) => vertex.kind === unit.kind.name || supportOutputs.has(vertex.kind)).map(({ keyEdges, ...vertex }) => ({ ...vertex, ...(keyEdges === undefined ? {} : { keyEdges: keyEdges.map(edge => ({ ...edge })) }), key: [...vertex.key], fields: vertex.fields.filter((field) => vertex.key.includes(field.name) || (supportOutputs.get(vertex.kind) ?? allowedFields).includes(field.name)).map((field) => {
      return { ...field };
    }) })),
    // Both ends must exist at publication: the later producer turn owns the edge, or the sole agent end does.
    edges: (unit.plugin.contract?.edges ?? []).filter((edge) => unitEdges.has(edge.kind)).map((edge) => ({ ...edge, from: typeof edge.from === 'string' ? edge.from : [...edge.from], to: typeof edge.to === 'string' ? edge.to : [...edge.to], fields: edge.fields.map((field) => ({ ...field })) })),
  };
  const workRoot = withSpanSync('plugin.workspace', {}, () => mkdtempSync(join(tmpdir(), 'madarch-plugin-turn-')));
  const repositoryInputs = await (async () => {
    try {
      return pluginRightsOf(closure).filesystem === true
        ? await withSpan('plugin.repositories', {}, async () => await (wiring.prepareRepositoryInputs ?? prepareRepositoryInputs)(await wiring.snapshots.pins(), workRoot, { ...(wiring.unconfined === true ? { unconfined: true } : {}) }))
        : { filesystemInputs: [], repositories: currentPins.map((pin) => ({ repository: pin.id, commit: pin.commit })) };
    } catch (error) {
      withSpanSync('plugin.cleanup', {}, () => rmSync(workRoot, { recursive: true, force: true }));
      throw error;
    }
  })();
  // The agent's session is given madarch's own graph server (owner's decision, 2026-11-15): the agent reads what it
  // needs of the same graph the fill writes, and the task names only the kind it fills.
  const agentGraph = wiring.agent === undefined || unit.plugin.contract?.agent === undefined ? undefined : startAgentGraphMcp({ owner: wiring.owner, manifest: wiring.manifest, contract: wiring.contract, folder: wiring.productFolder }, { notice: () => meter?.wrapNotice() });
  // How long this plugin's agent unit may run: the product's own minutes, or the host's thirty (owner's decision,
  // 2026-11-15 — the run's token cap is the other bound, and the host's minute-a-unit would stop every agent).
  const agentMinutes = unit.plugin.bounds?.minutes;
  let committedEntries = 0;
  const host = new PluginHost({
    ...(wiring.agent === undefined ? {} : { agent: { ...wiring.agent, outputs, evidenceContracts: wiring.contract.vertex, ...(agentGraph === undefined ? {} : { mcpServers: [agentGraph.server] }), ...(meter === undefined ? {} : { meter }), onSession: (report: PluginAgentReport) => { agentReport = report; wiring.agent?.onSession?.(report); } } }),
    pluginFolder,
    closure,
    repository: wiring.productFolder,
    graph: access.graph,
    operations: { apply: async (unitId, key, operation, preconditions, contractVersion) => {
      if (unitId !== id) throw new Error(`${location}: operation names another unit`);
      if (contractVersion !== undefined && contractVersion !== graphContractVersion(wiring.contract)) throw new Error(`${location}: CONTRACT_VERSION_MISMATCH`);
      const checked = validateUnitResult(outputs, { unitId, ...operation, edges: [...(operation.edges ?? []), ...(operation.edgeRemovals ?? [])], end: { state: 'complete' } });
      if (!checked.ok) throw new Error(`${location}: ${checked.refusal.where}: ${checked.refusal.message}`);
      access.assertWrites(checked.unit);
      for (const fact of [...checked.unit.vertices, ...checked.unit.edges, ...(operation.removals ?? [])]) {
        const path = ('evidence' in fact ? fact.evidence?.path : undefined) ?? ('key' in fact ? fact.key['path'] : undefined);
        if (wiring.paths !== undefined && (typeof path !== 'string' || !wiring.paths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)))) throw new Error(`${location}: operation writes outside selected paths`);
      }
      const selected = selectedVertex(wiring, unit.kind.name);
      if (selected !== undefined && [...checked.unit.vertices, ...checked.unit.removals].some(vertex => !supportOutputs.has(vertex.kind) && entityIdOf(wiring, vertex.kind, vertex.key) !== selected)) throw new Error(`${location}: operation writes outside selected entity ${selected}`);
      const keys = partition?.keys === undefined ? undefined : new Set(partition.keys.map(canonicalKey));
      if (keys !== undefined) {
        for (const vertex of [...checked.unit.vertices, ...checked.unit.removals]) if (!supportOutputs.has(vertex.kind) && !keys.has(canonicalKey(vertex.key))) throw new Error(`${location}: operation writes outside selected partition keys`);
        for (const edge of checked.unit.edges) if (!supportOutputs.has(edge.from.kind) && !supportOutputs.has(edge.to.kind) && !keys.has(canonicalKey(edge.from.kind === unit.kind.name ? edge.from.key : edge.to.key))) throw new Error(`${location}: edge writes outside selected partition keys`);
      }
      for (const edge of checked.unit.edges) if (!ownsEdge(edge)) throw new Error(`${location}: write of unselected edge endpoints ${edge.kind}`);
      const execute = wiring.executeOperation;
      if (execute === undefined) throw new Error(`${location}: immediate operation authority is unavailable`);
      const written = await execute(id, key, operation, async (tx) => await applyPluginFacts(tx, wiring.contract, {
        vertices: checked.unit.vertices.map(vertex => ({ ...vertex, selectedFields: supportOutputs.get(vertex.kind) ?? allowedFields, evidence: draftEvidence(vertex.evidence), producer: unit.plugin.id, producerVersion: unit.lock.version })),
        edges: (operation.edges ?? []).map(edge => ({ ...edge, evidence: draftEvidence(edge.evidence), producer: unit.plugin.id, producerVersion: unit.lock.version })),
        edgeRemovals: (operation.edgeRemovals ?? []).map(edge => ({ ...edge, evidence: draftEvidence(edge.evidence), producer: unit.plugin.id })),
        removals: (operation.removals ?? []).map(ref => ({ ...ref, evidence: draftEvidence(ref.evidence), producer: unit.plugin.id, selectedFields: allowedFields })),
      }, 1, { author: `${unit.plugin.id}@${unit.lock.version}` }), preconditions);
      committedEntries += checked.unit.vertices.length + checked.unit.edges.length + checked.unit.removals.length;
      return written;
    } },
    workRoot,
    filesystemInputs: repositoryInputs.filesystemInputs,
    trust: 'production',
    ...(agentMinutes === undefined ? {} : { limits: { agentUnitMs: agentMinutes * 60_000 } }),
    releaseHashes: wiring.releaseHashes ?? RELEASE_CLOSURE_HASHES,
    ...(wiring.cgroupParent === undefined ? {} : { cgroupParent: wiring.cgroupParent }),
    ...(wiring.unconfined === true ? { unconfined: true } : {}),
    ...(requests === undefined ? {} : { requests }),
  });
  /** Whether the unit's own publication carries its requests: a unit that failed publishes nothing (see below). */
  /** What the unit's answer held, kept past the try so a bound that crossed after it still keeps the result. */
  let producedCount = 0;
  let pluginStderr: string | undefined;
  try {
    const session = await host.open();
    const cancel = (): void => { void session.cancel(); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted === true) cancel();
    try {
      // A catalogue agent's task is the kind it fills and what that kind means, in English (owner's decision,
      // 2026-11-15): it reads the graph through the unit's own server, so no list of files, no path of the product's
      // checkout and no locale map is handed to it. Another plugin's agent part keeps its own inputs.
      const catalogueAgent = unit.plugin.contract?.agent?.catalogue === true;
      const agentInputs = unit.plugin.contract?.agent === undefined ? undefined : catalogueAgent
        ? agentTaskOf(unit.kind, outputs)
        : { contract: outputs, kinds: [unit.kind], kind: unit.kind, files: [] };
      const request = { unitId: id, kind: unit.kind.name, key: { pattern: unit.patterns[0] ?? '' }, inputs: catalogueAgent && agentInputs !== undefined ? agentInputs : { ...(agentInputs ?? { ...(unit.patterns[0] === undefined ? {} : { pattern: unit.patterns[0] }), patterns: [...unit.patterns] }), contract: outputs, edgeOutputs, outputKinds: outputOrder, declaredKeyEdges, repositories: repositoryInputs.repositories, ...(unit.kind.classes === undefined ? {} : { classRules: unit.kind.classes }), ...(unit.kind.exclude === undefined ? {} : { exclude: unit.kind.exclude }), ...(wiring.paths === undefined ? {} : { paths: [...wiring.paths] }), ...(partition?.keys === undefined ? {} : { keys: partition.keys }) } };
      if (partition?.plan !== undefined) {
        const partitions: { readonly keys: readonly import('../plugin/protocol.js').PluginKeyValues[] }[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await session.planOutput(request, cursor);
          partitions.push(...page.partitions);
          cursor = page.next;
          if (cursor !== undefined && cursors.has(cursor)) throw new Error(`${location}: repeated output planning cursor`);
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
        access.assertAllowed();
        partition.plan(partitions);
        return;
      }
      const outcome = await session.runUnit(request);
      access.assertAllowed();
      if (outcome.state !== 'extracted') {
        // The agent part's own bound is a value on the meter, and a typed error cannot cross the plugin protocol: a unit
        // that failed while its run's tokens are spent ends with that reason, and is not retried (owner's decision,
        // 2026-11-15).
        const spent = meter?.overBudget() ?? meter?.stop();
        if (spent !== undefined) throw new UnitBoundStop('tokens', spent.message);
        throw unitStopped(id, outcome.cause.code, outcome.cause.message);
      }
      if (outcome.result.end.state === 'inapplicable') {
        if (committedEntries !== 0) throw new Error(`${location}: inapplicable result cannot contain instances`);
        const execute = wiring.executeOperation;
        if (execute === undefined) throw new Error(`${location}: applicability operation authority is unavailable`);
        await execute(id,'applicability',outcome.result.end,async tx => {
          const end = outcome.result.end;
          if (end.state !== 'inapplicable') throw new Error(`${location}: applicability result changed`);
          await assertApplicability(tx,wiring.contract,unit.kind.name,'inapplicable',end.searched,end.evidence.flatMap(draftEvidence));
          await cascadeApplicability(tx,wiring.contract,wiring.manifest);
        });
        completeOutcome({plugin:unit.plugin.id,kind:unit.kind.name,outcome:'empty',produced:0,reason:outcome.result.end.searched});
        return;
      }
      producedCount = committedEntries;
      // The places the unit could not read are its problems, with their file, line and cause: one unreadable file never
      // makes the rest of the answer a silence, and the reason is where a person finds what was left out. A partial unit
      // keeps its cause and its places alike, so a file-specific problem is never hidden under the general cause.
      const problems = outcome.result.problems ?? [];
      const problemsText = problems.length === 0 ? undefined : `${String(problems.length)} place${problems.length === 1 ? '' : 's'} could not be read: ${problems.map((problem) => `${problem.repository === undefined ? '' : `${problem.repository}/`}${problem.path}:${String(problem.line)}${problem.column === undefined ? '' : `:${String(problem.column)}`} ${problem.message}`).join('; ')}`;
      // A partial answer keeps every entry it holds (owner's rule, 2026-11-15): the entries the contract and the graph
      // could take are published, and the reason — the agent's own cause, the places it could not read, and the entries
      // the contract could not take — is written beside them. Only an answer that holds nothing abstains.
      const partialReason = outcome.result.end.state === 'partial'
        ? (problemsText === undefined ? outcome.result.end.cause : `${outcome.result.end.cause}; ${problemsText}`)
        : undefined;
      const producedEntries = committedEntries;
      if (producedEntries > 0) {
        const execute = wiring.executeOperation;
        if (execute === undefined || wiring.sourceUid === undefined) throw new Error(`${location}: applicability operation authority is unavailable`);
        await execute(id,'applicable',{kind:unit.kind.name},async tx => {
          await assertProducedApplicability(tx,wiring.contract,unit.kind.name);
          await cascadeApplicability(tx,wiring.contract,wiring.manifest);
        });
      }
      if (partialReason !== undefined && producedEntries === 0) {
        completeOutcome( { plugin: unit.plugin.id, kind: unit.kind.name, outcome: 'abstained', produced: 0, reason: partialReason });
        progress?.(`the plugin ${unit.plugin.id} abstained: ${partialReason}`);
        await meter?.flush();
        const stop = meter?.stop();
        if (stop !== undefined) throw unitStopped(id, 'agent-budget', stop.message);
        return;
      }
      if (partialReason !== undefined) progress?.(`the plugin ${unit.plugin.id} answered partly and published what it held (${String(producedEntries)}): ${partialReason}`);
      const producerVersion = agentReport === undefined ? unit.lock.version : `${unit.lock.version}/${agentReport.agentId}`;
      completeOutcome( { plugin: unit.plugin.id, kind: unit.kind.name, producerVersion, outcome: producedEntries === 0 ? (priorFactCount > 0 ? 'unchanged' : 'empty') : 'completed', produced: producedEntries, ...(partialReason === undefined ? (problemsText === undefined ? {} : { reason: problemsText }) : { reason: partialReason }) });
    } finally {
      signal?.removeEventListener('abort', cancel);
      const stderr = session.stderr();
      if (stderr.file !== '') pluginStderr = stderr.file;
      await withSpan('plugin.close', { 'madarch.plugin.id': unit.plugin.id }, async () => await session.close());
    }
    // The unit's spend goes to the store whatever the unit published: a bound that crossed is the unit's end, and the
    // rows say what it spent before it stopped.
    await meter?.flush();
    const stop: AgentUsageStop | undefined = meter?.stop();
    if (stop !== undefined) {
      // What the agent produced before the cap stands (owner's decision, 2026-11-15): the unit published it, and the run
      // says it went over. A unit that produced nothing ends with the bound's reason, and the run never retries it.
      if (producedCount === 0) throw unitStopped(id, 'agent-budget', stop.message);
      progress?.(`the plugin ${unit.plugin.id} went over its bound after producing ${String(producedCount)}: its result stands. ${stop.message}`);
    }
  } catch (error) {
    // What the unit spent is evidence whatever it published: a unit that failed still writes its rows.
    await meter?.flush().catch(() => undefined);
    throw error;
  } finally {
    // The plugin's own output goes with the run (madarch-64o5.88): the unit's scratch folder is temporary, and its log is
    // the only place a plugin's own words stand.
    if (pluginStderr !== undefined && wiring.traces !== undefined && runId !== undefined && existsSync(pluginStderr)) {
      try {
        const folder = pluginLogFolder(wiring.traces, runId);
        mkdirSync(folder, { recursive: true });
        copyFileSync(pluginStderr, join(folder, recordFileName(unit.id, 'log')));
      } catch {
        // The log is evidence, not the work: a folder that cannot be written must not fail the unit.
      }
    }
    await agentGraph?.close();
    withSpanSync('plugin.cleanup', { 'madarch.plugin.id': unit.plugin.id }, () => rmSync(workRoot, { recursive: true, force: true }));
  }
}

interface KeyPartition { readonly keys: readonly import('../plugin/protocol.js').PluginKeyValues[] }
type PartitionScope = KeyPartition | { readonly partitions: readonly KeyPartition[] };

function partitionChildren(id: string, runId: string | undefined, partitions: readonly KeyPartition[]): { id: string; scope: string }[] {
  const fanout = DEFAULT_ORCHESTRATOR_LIMITS.maxSplitChildren;
  const width = Math.ceil(partitions.length / fanout);
  const children: { id: string; scope: string }[] = [];
  for (let offset = 0; offset < partitions.length; offset += width) {
    const group = partitions.slice(offset, offset + width).map(({ keys }) => ({ keys: [...keys].sort((left, right) => byCodePoint(canonicalKey(left), canonicalKey(right))) }));
    const scope: PartitionScope = group.length === 1 ? group[0]! : { partitions: group };
    const hash = createHash('sha256').update(JSON.stringify({ runId, scope })).digest('hex');
    children.push({ id: `${id}#${hash}`, scope: JSON.stringify(scope) });
  }
  return children;
}

/** The fill stage of the plugin turns: the units are the manifest's, the work is each plugin's own. */
export function createPluginTurnStage(wiring: PluginTurnWiring): FillStage {
  const declarationPlan = planManifestFill(wiring.manifest, wiring.productFolder, wiring.targets?.kinds, wiring.agent !== undefined, wiring.targets?.requested, wiring.targets?.pluginsOnly === true);
  return {
    id: PLUGIN_TURN_STAGE_ID,
    version: 11,
    unitScheduling(id) {
      // A kind nothing produces is planned as one unit that fails with the plan's error, so the run reports that kind
      // and the others still run (madarch-64o5.60).
      if (id.startsWith(MISSING_KIND_UNIT)) return { after: [], group: id, concurrency: 1 };
      const unit = unitOf(wiring, id);
      const plan = declarationPlan;
      const after = plan.unitPredecessors(unit.plugin.id, unit.kind.name).map((dependency) => pluginTurnUnitId(dependency.plugin, dependency.kind, selectedVertex(wiring, dependency.kind)));
      return { after, group: unit.plugin.id, concurrency: plan.concurrency.get(unit.plugin.id) ?? 1 };
    },
    consumes: { required: [], optional: [] },
    produces: [{ kind: 'plugin-claim', schemaVersion: 1, scope: 'product' }],
    after: [],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, enabled: true, concurrency: [...(wiring.manifest.plugins?.values() ?? [])].reduce((sum, plugin) => sum + (plugin.declaration?.concurrency ?? 1), 0) || 1, config: {} },
    async plan() {
      const plan = declarationPlan;
      const units = await planPluginTurns(wiring);
      // A request nothing in the manifest can produce fails with the reason, never as a run that succeeded with no units
      // (madarch-64o5.49): kinds the agent covers are never here, because a plan that leaves them to it asks for one. A
      // kind the product cannot fill and nothing else runs for is the request's own answer, and it says why.
      if (units.length === 0 && plan.errors.length + plan.skipped.length > 0) {
        throw new Error(`${wiring.manifest.file}:1: nothing the fill was asked for has a producer: ${[
          ...plan.errors.map((error) => error.message),
          ...plan.skipped.map((skip) => `kind "${skip.kind}" ${skip.fields.length === 0 ? '' : `(the ${skip.fields.length === 1 ? 'field' : 'fields'} ${skip.fields.map((field) => `"${field}"`).join(', ')}) `}is skipped: ${skip.reason}`),
        ].join('; ')}`);
      }
      // A kind nothing produces is planned as one unit whose failure carries the plan's error, so that kind fails and
      // the others run.
      const missing = plan.errors.map((error) => ({ id: `${MISSING_KIND_UNIT}${error.kind}`, scope: error.kind }));
      return { units: [...units.map((unit) => ({ id: unit.id, scope: unit.kind.name })), ...missing],
        coverage: units.length === 0 && missing.length === 0 ? 'nothing-found' as const : 'planned' as const };
    },
    async execute(unit, context) {
      const scopedWiring: PluginTurnWiring = {
        ...wiring,
        sourceUid: context.operationSourceUid,
        executeOperation: context.executeOperation === undefined ? undefined : (_unit, key, request, apply, preconditions) => context.executeOperation!(key, request, apply, preconditions),
      };
      if (unit.id.startsWith(MISSING_KIND_UNIT)) {
        const kind = unit.id.slice(MISSING_KIND_UNIT.length);
        throw new Error(declarationPlan.errors.find((error) => error.kind === kind)?.message ?? `${wiring.manifest.file}:1: kind "${kind}" has no producer`);
      }
      const selected = unitOf(wiring, unit.id);
      const partitioned = selected.plugin.declaration?.produces.some((output) => (output.kind === selected.kind.name || output.kind === '*') && output.partition === 'key') === true;
      if (!partitioned) {
        await runPluginTurn(scopedWiring, unit.id, context.completeOutcome ?? (() => { throw new Error(`${import.meta.path}:1: operation outcome authority unavailable`); }), context.progress, context.signal, trackedPluginAnswerer(context.graph), context.runId);
        return { outcome: 'draft' };
      }
      const childScope = unit.id.includes('#') ? JSON.parse(unit.scope) as PartitionScope : undefined;
      if (childScope !== undefined && 'keys' in childScope) {
        const scope = childScope;
        let outcome: import('./producer-outcomes.js').ProducerOutcomeDraft | undefined;
        await runPluginTurn(scopedWiring, unit.id, value => { outcome = value; context.completeOutcome?.(value); }, context.progress, context.signal, trackedPluginAnswerer(context.graph), context.runId, { keys: scope.keys });
        if (!['completed', 'empty', 'unchanged'].includes(outcome?.outcome ?? '')) throw new Error(`partition ${unit.id} did not complete; earlier accepted operations remain committed`);
        return { outcome: 'draft' };
      }
      if (context.sealedChildren !== undefined) {
        if (context.runId === undefined) throw new Error('partition barrier requires a run identity');
        const partitions = context.sealedChildren.map((child) => ({ runId: context.runId!, unitId: child.unitId, generation: child.generation }));
        const outcome = await pluginPartitionOutcome(wiring.owner, partitions);
        if (!outcome.complete) throw new Error(`partitioned output ${unit.id} did not complete; earlier graph opinions remain unchanged`);
        context.completeOutcome?.({ plugin: selected.plugin.id, kind: selected.kind.name, producerVersion: selected.lock.version, outcome: outcome.produced === 0 ? 'empty' : 'completed', produced: outcome.produced });
        return { outcome: 'draft' };
      }
      if (childScope !== undefined && 'partitions' in childScope) return { outcome: 'split', children: partitionChildren(unit.id, context.runId, childScope.partitions) };
      let planned: readonly { readonly keys: readonly import('../plugin/protocol.js').PluginKeyValues[] }[] = [];
      await runPluginTurn(scopedWiring, unit.id, context.completeOutcome ?? (() => { throw new Error(`${import.meta.path}:1: operation outcome authority unavailable`); }), context.progress, context.signal, trackedPluginAnswerer(context.graph), context.runId, { plan: (partitions) => { planned = partitions; } });
      const declaredKey = wiring.contract.vertex.find((vertex) => vertex.name === selected.kind.name)?.key ?? [];
      const seen = new Set<string>();
      const partitions = planned.map((partition) => {
        if (partition.keys.length === 0) throw new Error('an output partition must declare at least one key');
        const keys = partition.keys.map((key) => {
          if (Object.keys(key).sort(byCodePoint).join('\0') !== [...declaredKey].sort(byCodePoint).join('\0')) throw new Error(`partition key does not match ${selected.kind.name} declared key`);
          const canonical = canonicalKey(key);
          if (seen.has(canonical)) throw new Error(`duplicate output partition key ${canonical}`);
          seen.add(canonical);
          return key;
        }).filter((key) => selectedVertex(wiring, selected.kind.name) === undefined || entityIdOf(wiring, selected.kind.name, key) === selectedVertex(wiring, selected.kind.name));
        return { keys };
      }).filter((partition) => partition.keys.length > 0);
      // Prior identities remain work even when enumeration is empty: missing keys retract only their own scoped fields.
      for (const entity of await producerEntities(wiring.owner, wiring.contract, selected.kind.name, scopedWiring.sourceUid!)) {
        if (wiring.paths !== undefined && !wiring.paths.some((path) => typeof entity.key.path === 'string' && (entity.key.path === path || entity.key.path.startsWith(`${path.endsWith('/') ? path.slice(0, -1) : path}/`)))) continue;
        if (selectedVertex(wiring, selected.kind.name) !== undefined && entityIdOf(wiring, selected.kind.name, entity.key) !== selectedVertex(wiring, selected.kind.name)) continue;
        if (!seen.has(canonicalKey(entity.key))) { seen.add(canonicalKey(entity.key)); partitions.push({ keys: [entity.key] }); }
      }
      if (partitions.length === 0) {
        context.completeOutcome?.( { plugin: selected.plugin.id, kind: selected.kind.name, producerVersion: selected.lock.version, outcome: 'empty', produced: 0 });
        return { outcome: 'draft' };
      }
      return { outcome: 'split', children: partitionChildren(unit.id, context.runId, partitions) };
    },
  };
}

/** The stage's id, as a workflow may name it. */
export const PLUGIN_TURN_STAGE_ID = 'plugin-turns';

/** The id prefix of the one unit a kind nothing produces is planned as: its failure carries the plan's error. */
const MISSING_KIND_UNIT = 'missing:';
