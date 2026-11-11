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
import { join } from 'node:path';
import { PluginHost, type GraphAnswerer, type HostLimits, type UnitOutcome } from './host.js';
import type { PluginContractDeclaration, PluginUnitRequest } from './protocol.js';
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
    const end = outcome.result.end.state === 'complete' ? 'complete' : `partial (${outcome.result.end.cause})`;
    return { ok: true, text: `unit ${outcome.unitId}: extracted ${String(outcome.result.vertices.length)} vertices and ${String(outcome.result.edges.length)} edges, ${end}, ${String(outcome.durationMs)} ms${outcome.result.removalsDropped === 0 ? '' : `, ${String(outcome.result.removalsDropped)} removals dropped for a partial unit`}` };
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
      graph: options.graph ?? EMPTY_GRAPH,
    });
    session = await host.open();
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
  return { lines, ok: lines.every((line) => line.ok) };
}
