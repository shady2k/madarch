/**
 * The conformance kit (decision 0035, item 8): a plugin is held to the
 * protocol and to its own contract inside the sandbox, publishing nothing. It
 * introduces itself within the handshake deadline, answers a unit with a
 * result held against its declaration, stays alive through a pause longer
 * than the heartbeat deadline, and exits when asked to stop.
 *
 * A closure no release carries may run here and only here: validation that
 * publishes nothing (decision 0035, item 4).
 */
import { join, resolve } from 'node:path';
import type { PluginVertexResult, PluginEdgeResult, PluginGraphOwnFactsResult } from './protocol.js';
import { PluginHost, type GraphAnswerer, type HostLimits, type UnitOutcome } from './host.js';
import { PluginFactsApplyRequest, type PluginContractDeclaration, type PluginUnitRequest } from './protocol.js';
import { Value } from 'typebox/value';
import { validateUnitResult } from './results.js';
import { byCodePoint } from '../model/order.js';
import { readPluginManifest } from './closure.js';
import type { PluginAgentOptions } from './agent.js';

/** One line of the kit's report, and whether it passed. */
export interface ConformanceLine {
  readonly text: string;
  readonly ok: boolean;
}

/** What the kit found: one line per check, and every line's own answer. */
export interface ConformanceReport {
  readonly lines: readonly ConformanceLine[];
  readonly ok: boolean;
}

export interface ConformanceOptions {
  /** Validate source reconciliation as well as the lifecycle (0039 items 18–19). */
  readonly reconciliationUnit?: PluginUnitRequest;
  readonly readBlob?: ConstructorParameters<typeof PluginHost>[0]['readBlob'];
  readonly pluginFolder: string;
  /** The repository the probe unit is read from, bound read-only; the plugin's own folder when absent. */
  readonly repository?: string;
  readonly workRoot: string;
  /** The units to probe with; one built from the declared kinds when absent. */
  readonly units?: readonly PluginUnitRequest[];
  readonly limits?: Partial<HostLimits>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cgroupParent?: string;
  readonly platform?: string;
  readonly releaseHashes?: readonly string[];
  /**
   * The graph a graph-reading plugin asks (decision 0035, item 15). The kit's own holds nothing: a plugin that reads
   * the graph is held to the protocol and its contract, and it answers an empty graph — it publishes nothing either
   * way. A caller that validates against real vertices passes its own.
   */
  readonly graph?: GraphAnswerer;
  /** Host-owned agent configuration; catalogue plugins get a deterministic protocol probe when absent. */
  readonly agent?: PluginAgentOptions;
}

/** The kit's graph: no file vertex, and no value of one. */
const EMPTY_GRAPH: GraphAnswerer = {
  ownFacts: async () => ({ vertices: [], edges: [] }),
  files: async () => [],
  value: async (kind, _key, field) => { throw new Error(`the conformance kit's graph holds no ${JSON.stringify(kind)} to read ${JSON.stringify(field)} from: it validates the protocol, not the facts`); },
};

/**
 * The unit a kit probes a plugin with when its caller names none: the first
 * declared vertex kind, keyed by that kind's key fields with the value
 * `conformance`. It reads nothing a person wrote; a plugin whose work needs a
 * real unit is probed with one the caller passes.
 */
export function probeUnit(contract: PluginContractDeclaration, unitId = 'conformance-1'): PluginUnitRequest | undefined {
  const first = [...contract.vertices].sort((left, right) => byCodePoint(left.kind, right.kind))[0];
  if (first === undefined) return undefined;
  const key: Record<string, string> = {};
  for (const field of first.key ?? []) key[field] = 'conformance';
  return { unitId, kind: first.kind, key };
}

/** One outcome said in the kit's words: what it held, or the cause that stopped it. */
export function describeOutcome(outcome: UnitOutcome): ConformanceLine {
  if (outcome.state === 'extracted') {
    const end = outcome.result.end.state === 'partial' ? `partial (${outcome.result.end.cause})` : outcome.result.end.state;
    return { ok: true, text: `unit ${outcome.unitId}: ${end}, ${String(outcome.durationMs)} ms` };
  }
  return { ok: false, text: `unit ${outcome.unitId}: not extracted, ${outcome.cause.code}: ${outcome.cause.message}${outcome.stderr.file === '' ? '' : ` (log ${outcome.stderr.file})`}` };
}

/** A catalogue has no fixed kind: the kit supplies one bounded output and an in-process agent protocol peer. */
function catalogueAgent(): PluginAgentOptions {
  const outputs: PluginContractDeclaration = { vertices: [{ kind: 'conformance', key: ['id'], fields: [] }], edges: [] };
  return {
    adapter: { id: 'conformance', command: 'conformance' }, outputs,
    connect: async (spec) => {
      let end!: () => void;
      const closed = new Promise<void>((resolve) => { end = resolve; });
      return {
        spec, executable: 'conformance', closed,
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
        stderr: () => '', close: async () => { end(); },
        newSession: async () => ({
          sessionId: 'conformance', modes: null, configOptions: [], models: null, model: null,
          setConfigOption: async () => { throw new Error('the conformance agent offers no configuration options'); },
          setModel: async () => { throw new Error('the conformance agent offers no models'); },
          prompt: async () => ({ text: JSON.stringify({ vertices: [], edges: [], end: { state: 'complete' } }), stopReason: 'end_turn', updates: [] }),
          cancel: async () => {}, running: () => false,
          usage: () => ({ reported: false, turns: 1, reports: 0 }),
        }),
      };
    },
  };
}

/**
 * Runs the kit: the introduction, one unit per probe (or one built from the
 * declaration), a pause past the heartbeat deadline, and a stop. The session
 * ends whatever the checks found, and the report says every line's answer.
 */
export async function checkConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const lines: ConformanceLine[] = [];
  let session;
  try {
    const agent = options.agent ?? (readPluginManifest(options.pluginFolder).agent?.catalogue === true ? catalogueAgent() : undefined);
    let declaration: PluginContractDeclaration | undefined;
    const host = new PluginHost({
      ...(agent === undefined ? {} : { agent: { ...agent, onSession: (report) => {
        agent.onSession?.(report);
        lines.push({ ok: true, text: `agent: unit ${report.unitId}, session ${report.sessionId}, ${String(report.usage.turns)} turns` });
      } } }),
      pluginFolder: options.pluginFolder,
      repository: options.repository ?? options.pluginFolder,
      workRoot: join(options.workRoot, 'conformance'),
      trust: 'validation',
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cgroupParent === undefined ? {} : { cgroupParent: options.cgroupParent }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.releaseHashes === undefined ? {} : { releaseHashes: options.releaseHashes }),

      operations: { apply: async (unitId, key, operation, preconditions, contractVersion) => {
        if (!Value.Check(PluginFactsApplyRequest, { unitId, key, operation, ...(preconditions === undefined ? {} : { preconditions }), ...(contractVersion === undefined ? {} : { contractVersion }) })) throw new Error('conformance facts.apply has malformed parameters');
        if (declaration === undefined) throw new Error('conformance facts.apply precedes the introduction');
        const checked = validateUnitResult(declaration, { unitId, ...(operation as import('./protocol.js').PluginFactsApplyRequest['operation']), end: { state: 'complete' } });
        if (!checked.ok) throw new Error(checked.refusal.message);
        return { validation: true, key };
      } },
      graph: options.graph ?? EMPTY_GRAPH,
      ...(options.readBlob === undefined ? {} : { readBlob: options.readBlob }),
    });
    session = await host.open();
    declaration = session.declared.outputs;
  } catch (error) {
    const failed = error as Error & { code?: string; file?: string; line?: number };
    lines.push({ ok: false, text: `introduction: ${failed.code ?? 'failed'}: ${failed.message}` });
    return { lines, ok: false };
  }
  try {
    const declared = session.declared;
    lines.push({ ok: true, text: `introduction: ${declared.name} ${declared.version}, protocol ${declared.protocol}, ${String(declared.outputs.vertices.length)} vertex kinds and ${String(declared.outputs.edges.length)} edge kinds` });
    const duplicateKinds = declared.outputs.vertices.map((kind) => kind.kind).filter((kind, at, all) => all.indexOf(kind) !== at).sort(byCodePoint);
    lines.push(duplicateKinds.length === 0
      ? { ok: true, text: 'contract: every vertex kind stands once' }
      : { ok: false, text: `contract: the vertex kinds ${duplicateKinds.join(', ')} stand more than once` });
    const probes = options.units === undefined ? [probeUnit(declared.outputs)].filter((unit): unit is PluginUnitRequest => unit !== undefined) : options.units;
    if (probes.length === 0) lines.push({ ok: false, text: 'contract: the plugin declares no vertex kind to probe, and no unit was given' });
    let extracted = true;
    for (const unit of probes) {
      const line = describeOutcome(await session.runUnit(unit));
      lines.push(line);
      extracted = extracted && line.ok;
    }
    if (extracted) {
      await session.pause();
      await Bun.sleep(Math.min(options.limits?.heartbeatMs ?? 5_000, 5_000) + 250);
      await session.resume();
      lines.push({ ok: true, text: 'pause: the session stayed paused past the heartbeat deadline and resumed' });
    }
    await session.stop();
    lines.push({ ok: true, text: 'stop: the plugin exited when asked' });
  } catch (error) {
    lines.push({ ok: false, text: `session: ${(error as Error).message}` });
  } finally {
    await session.close();
  }
  if (options.reconciliationUnit !== undefined) {
    const reconciliation = await checkReconciliationConformance({ ...options, unit: options.reconciliationUnit });
    lines.push(...reconciliation.lines);
  }
  return { lines, ok: lines.every((line) => line.ok) };
}

/**
 * Decision 0039 items 18–19: exercise a real source reader and the SDK's three
 * differences, without publishing. The source must hold at least three vertices.
 * Earlier own facts hold one absent item, one stale value, and all
 * other facts unchanged. The next pass must write exactly add, remove, update.
 */
export async function checkReconciliationConformance(options: ConformanceOptions & { readonly unit: PluginUnitRequest }): Promise<ConformanceReport> {
  const lines: ConformanceLine[] = [];
  let current: PluginGraphOwnFactsResult = { vertices: [], edges: [] };
  let applied: { operation: 'add' | 'update' | 'remove'; vertex?: PluginVertexResult; edge?: PluginEdgeResult; evidence?: PluginVertexResult['evidence'] }[] = [];
  const identityKey = (fact: PluginVertexResult): string => JSON.stringify([fact.kind, fact.key, fact.keyEdges ?? {}]);
  const location = `${resolve(options.pluginFolder, 'plugin.json')}:1`;
  const graph: GraphAnswerer = {
    ...(options.graph ?? EMPTY_GRAPH),
    ownFacts: async () => current,
  };
  let session;
  try {
    session = await new PluginHost({
      pluginFolder: options.pluginFolder, repository: options.repository ?? options.pluginFolder,
      workRoot: join(options.workRoot, 'reconciliation'), trust: 'validation', graph,
      ...(options.readBlob === undefined ? {} : { readBlob: options.readBlob }),
      operations: { apply: async (_unitId, _key, operation) => {
        for (const vertex of operation.vertices ?? []) applied.push({ operation: current.vertices.some(held => identityKey(held) === identityKey(vertex)) ? 'update' : 'add', vertex, evidence: vertex.evidence });
        for (const edge of operation.edges ?? []) applied.push({ operation: current.edges.some(held => held.kind === edge.kind && JSON.stringify([held.from, held.to, held.discriminator ?? '']) === JSON.stringify([edge.from, edge.to, edge.discriminator ?? ''])) ? 'update' : 'add', edge, evidence: edge.evidence });
        for (const vertex of operation.removals ?? []) applied.push({ operation: 'remove', vertex, evidence: vertex.evidence });
        for (const edge of operation.edgeRemovals ?? []) applied.push({ operation: 'remove', edge, evidence: edge.evidence });
        return { accepted: true };
      } },
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    }).open();
    const first = await session.runUnit({ ...options.unit, unitId: 'reconciliation-source' });
    if (first.state !== 'extracted') throw new Error(`${first.cause.code}: ${first.cause.message}`);
    if (first.result.end.state === 'partial') throw new Error(`source is partial: ${first.result.end.cause}`);
    if (first.result.end.state === 'inapplicable') throw new Error(`source is inapplicable: ${first.result.end.searched}`);
    const initial = applied;
    if (initial.some(write => write.operation !== 'add')) throw new Error('an empty graph must receive only additions');
    const vertices = initial.flatMap(write => write.vertex === undefined ? [] : [write.vertex]);
    const edges = initial.flatMap(write => write.edge === undefined ? [] : [write.edge]);
    if (vertices.length < 3) throw new Error(`source fixture must produce at least three vertices, got ${String(vertices.length)}`);
    const added = vertices[0]!;
    const changedVertex = vertices.slice(1).find(vertex => Object.keys(vertex.values ?? {}).length > 0);
    const changedEdge = changedVertex === undefined ? edges.find(edge => Object.keys(edge.values ?? {}).length > 0) : undefined;
    const changed = changedVertex ?? changedEdge;
    if (changed === undefined) throw new Error('source fixture needs a fact with values to exercise an update');
    const staleValues = { ...changed.values };
    const field = Object.keys(staleValues).sort(byCodePoint)[0]!;
    const value = staleValues[field];
    staleValues[field] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : typeof value === 'string' ? `${value}-stale` : 'stale-conformance-value';
    const removed: PluginVertexResult = {
      ...vertices[2]!, key: Object.fromEntries(Object.entries(vertices[2]!.key).map(([key, value], at) => [key, at === 0 ? 'removed-conformance-item' : value])),
    };
    current = {
      vertices: [...vertices.slice(1).map(vertex => vertex === changedVertex ? { ...vertex, values: staleValues } : vertex), removed],
      edges: edges.map(edge => edge === changedEdge ? { ...edge, values: staleValues } : edge),
    };
    applied = [];
    const second = await session.runUnit({ ...options.unit, unitId: 'reconciliation-differences' });
    if (second.state !== 'extracted') throw new Error(`${second.cause.code}: ${second.cause.message}`);
    if (second.result.end.state === 'partial') throw new Error(`source is partial: ${second.result.end.cause}`);
    if (second.result.end.state === 'inapplicable') throw new Error(`source is inapplicable: ${second.result.end.searched}`);
    const writes = applied;
    const identity = (fact: unknown): string => {
      const held = fact as Record<string, unknown>;
      return JSON.stringify(Object.fromEntries(Object.entries(held).filter(([field]) => field !== 'evidence' && field !== 'values').sort(([a], [b]) => byCodePoint(a, b))));
    };
    const expected = [{ operation: 'add', fact: added }, { operation: 'remove', fact: removed }, { operation: 'update', fact: changed }];
    if (writes.length !== 3 || expected.some(wanted => !writes.some(write => write.operation === wanted.operation && identity(write.vertex ?? write.edge) === identity(wanted.fact)))) {
      throw new Error(`expected exactly add/remove/update for the fixture items; got ${JSON.stringify(writes)}`);
    }
    const update = writes.find(write => write.operation === 'update')!;
    if (JSON.stringify((update.vertex ?? update.edge)?.values) !== JSON.stringify(changed.values)) throw new Error('the update does not restore the source values');
    for (const write of writes) {
      const fact = write.vertex ?? write.edge!;
      const declaration = write.vertex === undefined ? session.declared.outputs.edges.find(kind => kind.kind === fact.kind) : session.declared.outputs.vertices.find(kind => kind.kind === fact.kind);
      const requiredProof = declaration?.fields?.some(field => field.evidence === true && Object.hasOwn(fact.values ?? {}, field.name)) ?? false;
      if (requiredProof && write.evidence === undefined) throw new Error(`difference for ${fact.kind} has no evidence for an evidence-required field`);
    }
    lines.push({ ok: true, text: `${location}: reconciliation: source added, removed and changed facts yield exactly three writes; unchanged facts yield none` });
  } catch (error) {
    lines.push({ ok: false, text: `${location}: reconciliation: ${(error as Error).message}` });
  } finally {
    await session?.close();
  }
  return { lines, ok: lines.every(line => line.ok) };
}
