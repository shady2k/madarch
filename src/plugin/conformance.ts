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
import { PluginHost, type HostLimits, type UnitOutcome } from './host.js';
import type { PluginContractDeclaration, PluginUnitRequest } from './protocol.js';
import { byCodePoint } from '../model/order.js';

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
}

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
  for (const field of first.key) key[field] = 'conformance';
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

/**
 * Runs the kit: the introduction, one unit per probe (or one built from the
 * declaration), a pause past the heartbeat deadline, and a stop. The session
 * ends whatever the checks found, and the report says every line's answer.
 */
export async function checkConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const lines: ConformanceLine[] = [];
  const host = new PluginHost({
    pluginFolder: options.pluginFolder,
    repository: options.repository ?? options.pluginFolder,
    workRoot: join(options.workRoot, 'conformance'),
    trust: 'validation',
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cgroupParent === undefined ? {} : { cgroupParent: options.cgroupParent }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.releaseHashes === undefined ? {} : { releaseHashes: options.releaseHashes }),
  });
  let session;
  try {
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
