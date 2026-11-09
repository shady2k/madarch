/**
 * The plugin host (decision 0035, items 5, 7 and 13): it starts one plugin as
 * a separate process in the sandbox, takes its introduction, hands it units,
 * and keeps it in bounds — a handshake deadline, a deadline per unit and per
 * run, a heartbeat deadline that a pause suspends, a bound on one message and
 * on a unit's whole answer, and the plugin's standard error kept as a bounded
 * log. Pause and resume freeze the whole tree; stop asks it to finish and
 * exits, and after a grace period becomes a cancel; a cancel kills the tree.
 *
 * Every answer is held against the plugin's own introduction: a kind, a field
 * or an edge kind the plugin did not declare is refused, and a partial unit's
 * removals are dropped. A failed or timed-out unit is recorded as not
 * extracted with its cause, never dropped silently, and every iteration and
 * every decision of the host leaves a span and a log line.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { byCodePoint } from '../model/order.js';
import { log } from '../obs/log.js';
import { annotateSpan, withSpan } from '../obs/trace.js';
import type { CgroupCounters } from './cgroup.js';
import { ClosureRefusal, closureOf, interpreterPinProblem, type Closure } from './closure.js';
import { PluginProtocolMessage, PluginUnitResult, PROTOCOL_VERSION, type PluginIntroduce, type PluginProgress, type PluginUnitRequest, type PluginErrorReport } from './protocol.js';
import { validateUnitResult, type ResultRefusal, type ValidatedUnit } from './results.js';
import { closureTrustProblem, snapshotClosure, type ClosureTrust } from './snapshot.js';
import { startSandbox, sandboxSetupProblem, type SandboxProcess, type SandboxSpec, type StderrLog } from './sandbox.js';
import { startDarwinSandbox } from './sandbox-darwin.js';
import { errorReportOf, failureText, heartbeatOf, isNotification, isRequest, isResponse, lineReader, notificationText, progressOf, requestText, RPC_INVALID_PARAMS, RPC_INVALID_REQUEST, RPC_METHOD_NOT_FOUND, RPC_PARSE_ERROR, successText } from './wire.js';

/** Where a refusal stands. */
const WHERE = 'src/plugin/host.ts';

/**
 * The bounds of one plugin run, each with a default a caller may lower: the
 * handshake, one unit (an iteration), the whole run, the silence allowed
 * between heartbeats while a unit runs, one message, one unit's whole answer,
 * the grace a stop gets, and the memory, cpu and process bounds of the
 * plugin's cgroup.
 */
export interface HostLimits {
  readonly handshakeMs: number;
  readonly unitMs: number;
  readonly runMs: number;
  readonly heartbeatMs: number;
  readonly maxMessageBytes: number;
  readonly maxUnitOutputBytes: number;
  readonly stopGraceMs: number;
  readonly memoryBytes: number;
  readonly cpuQuotaMicros: number;
  readonly cpuPeriodMicros: number;
  readonly pids: number;
}

/** The defaults: a minute a unit, half an hour a run, five seconds of silence, a megabyte a message and eight a unit. */
export const DEFAULT_HOST_LIMITS: HostLimits = {
  handshakeMs: 10_000,
  unitMs: 60_000,
  runMs: 30 * 60_000,
  heartbeatMs: 5_000,
  maxMessageBytes: 1_048_576,
  maxUnitOutputBytes: 8 * 1_048_576,
  stopGraceMs: 2_000,
  memoryBytes: 512 * 1_048_576,
  cpuQuotaMicros: 100_000,
  cpuPeriodMicros: 100_000,
  pids: 128,
};

/** The product's concurrency setting (decision 0035, item 13): plugins at once, and units per plugin. */
export interface HostSettings {
  readonly pluginsAtOnce: number;
  readonly unitsPerPlugin: number;
}

/** The default concurrency: one plugin at a time, one unit at a time. */
export const DEFAULT_HOST_SETTINGS: HostSettings = { pluginsAtOnce: 1, unitsPerPlugin: 1 };

/** One failure, with the place a person can point at. */
export interface UnitCause {
  /** A stable code: `handshake-timeout`, `unit-timeout`, `heartbeat-missed`, `message-too-large`, `unit-output-too-large`, `plugin-error`, `plugin-exited`, `sandbox-unavailable`, `needs-approval`, `closure-changed`, `undeclared-kind` and the rest of `results.ts`'s refusals. */
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

/** What one unit's work left behind, whether it was extracted or not. */
export interface UnitTrace {
  readonly bytes: number;
  readonly durationMs: number;
  readonly counters: CgroupCounters;
  readonly stderr: StderrLog;
}

/** One unit's outcome: extracted and validated, or not extracted with its cause. */
export type UnitOutcome =
  | (UnitTrace & { readonly state: 'extracted'; readonly unitId: string; readonly result: ValidatedUnit })
  | (UnitTrace & { readonly state: 'not-extracted'; readonly unitId: string; readonly cause: UnitCause });

/** What a session is opened from. */
export interface PluginHostOptions {
  /** The plugin's folder, the closure's source. */
  readonly pluginFolder: string;
  /**
   * The closure a caller already read and holds — the hash it printed, or the one a person approved. It is used as
   * it stands instead of reading the folder again, so the copy is held to the closure the caller named.
   */
  readonly closure?: Closure;
  /** The repository snapshot the plugin may read, bound read-only. */
  readonly repository: string;
  /** The host's own scratch root for this run: snapshots, logs and the seccomp filter. */
  readonly workRoot: string;
  /** Whether the closure runs as production (a release closure only) or as validation (the conformance kit). */
  readonly trust: ClosureTrust;
  readonly limits?: Partial<HostLimits>;
  readonly settings?: Partial<HostSettings>;
  /** The release closures to trust; the compiled-in list unless a test names its own. */
  readonly releaseHashes?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cgroupParent?: string;
  readonly platform?: string;
}

/** One open plugin: its declaration, the way to run units, and the controls a run needs. */
export interface PluginSession {
  readonly closureHash: string;
  readonly declared: PluginIntroduce;
  readonly limits: HostLimits;
  /** The most units this plugin takes at once: the smaller of the setting and its declared count. */
  readonly unitsAtOnce: number;
  readonly workFolder: string;
  runUnit(unit: PluginUnitRequest): Promise<UnitOutcome>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Asks the plugin to finish and exit; `cancelled` when the grace period ran out and the tree was killed. */
  stop(): Promise<{ readonly state: 'exited' | 'cancelled' }>;
  cancel(): Promise<void>;
  /** What the kernel counted for the tree: its peak memory, any oom kill, any fork past the pids bound. */
  counters(): CgroupCounters;
  /** The cgroup the whole tree stands in, for a record and for a test that reads what is left. */
  cgroupFolder(): string | undefined;
  /** Stops what runs, closes the session's folder, and answers nothing further. */
  close(): Promise<void>;
}

/** One unit in flight: the deadline that bounds it, the silence allowed and the bytes it answered with. */
interface InFlight {
  readonly unitId: string;
  readonly startedAt: number;
  lastSign: number;
  bytes: number;
  readonly progress: PluginProgress[];
  readonly error: PluginErrorReport | undefined;
  settle(outcome: UnitOutcome): void;
}

/** A session that failed at its protocol: every unit after it answers with this cause. */
class SessionFailure {
  readonly cause: UnitCause;
  constructor(cause: UnitCause) {
    this.cause = cause;
  }
}

/** The host's clock and the session's state, all in one place so a deadline check reads one object. */
export class PluginHost {
  private readonly options: PluginHostOptions;
  private readonly limits: HostLimits;
  private readonly settings: HostSettings;
  private sandbox: SandboxProcess | undefined;
  private closure: Closure | undefined;
  private snapshot: { folder: string; hash: string } | undefined;
  private declared: PluginIntroduce | undefined;
  private failure: SessionFailure | undefined;
  private handshake: { startedAt: number; resolve: () => void; reject: (cause: UnitCause) => void } | undefined;
  private readonly inFlight = new Map<string, InFlight>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private paused = false;
  private stopping = false;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (cause: UnitCause) => void }>();
  /** The unit each request id belongs to, so an answer is counted against the unit that asked for it. */
  private readonly unitByRequest = new Map<string, string>();
  private readonly runStartedAt = Date.now();
  private closeRequested = false;

  constructor(options: PluginHostOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_HOST_LIMITS, ...(options.limits ?? {}) };
    this.settings = { ...DEFAULT_HOST_SETTINGS, ...(options.settings ?? {}) };
  }

  /** The closure this session holds, once opened. */
  get closureHash(): string {
    return this.snapshot?.hash ?? '';
  }

  /** Opens the plugin: hashes its closure, proves its trust, copies it, starts the sandbox and takes its introduction. */
  async open(): Promise<PluginSession> {
    const limits = this.limits;
    const workFolder = join(this.options.workRoot, 'plugin');
    mkdirSync(workFolder, { recursive: true });
    const closure = await withSpan('plugin.closure', { 'madarch.plugin.folder': this.options.pluginFolder }, async () => {
      const read = this.options.closure ?? closureOf(this.options.pluginFolder);
      log.info('plugin closure hashed', { folder: read.folder, files: read.files.length, hash: read.hash });
      return read;
    });
    this.closure = closure;
    const pin = interpreterPinProblem(closure);
    if (pin !== undefined) throw pin;
    const trust = closureTrustProblem(closure, this.options.trust, join(closure.folder, 'plugin.json'), this.options.releaseHashes);
    if (trust !== undefined) throw trust;
    const snapshot = await withSpan('plugin.snapshot', { 'madarch.plugin.hash': closure.hash }, async () => {
      const copy = await snapshotClosure(closure, this.options.workRoot);
      log.info('plugin closure copied', { folder: copy.folder, hash: copy.hash });
      return copy;
    });
    this.snapshot = snapshot;
    const platform = this.options.platform ?? `${process.platform}-${process.arch}`;
    const problem = await sandboxSetupProblem({ platform, cgroupParent: this.options.cgroupParent, ...(this.options.env === undefined ? {} : { env: this.options.env }) });
    if (problem !== undefined) {
      log.error('the sandbox cannot run here', { problem: problem.code }, problem.message);
      throw new ClosureRefusal('sandbox-unavailable', problem.message, WHERE);
    }
    const spec: SandboxSpec = {
      closureFolder: snapshot.folder,
      repository: this.options.repository,
      workFolder,
      runtime: process.execPath,
      entry: closure.manifest.entry,
      limits: { memoryBytes: limits.memoryBytes, cpuQuotaMicros: limits.cpuQuotaMicros, cpuPeriodMicros: limits.cpuPeriodMicros, pids: limits.pids },
      ...(this.options.cgroupParent === undefined ? {} : { cgroupParent: this.options.cgroupParent }),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      platform,
    };
    this.sandbox = platform.startsWith('darwin-') ? await startDarwinSandbox(spec) : await withSpan('plugin.spawn', { 'madarch.plugin.hash': snapshot.hash, 'madarch.sandbox': platform }, async () => await startSandbox(spec));
    log.info('plugin sandbox started', { pid: this.sandbox.pid, platform });
    this.timer = setInterval(() => this.checkDeadlines(), 25);
    const reader = lineReader(limits.maxMessageBytes);
    this.sandbox.onStdout(
      (chunk) => reader.push(chunk, (message) => this.receive(message.value, message.bytes), (bytes) => this.fail({ code: 'message-too-large', message: `${WHERE}:1: the plugin wrote a message of ${String(bytes)} bytes, more than the ${String(limits.maxMessageBytes)} one message may hold: the host refuses the unit and stops the plugin` })),
      (cause) => { if (!this.closeRequested) this.fail({ code: 'plugin-exited', message: `${WHERE}:1: the plugin's standard output closed${cause === undefined ? '' : `: ${cause}`}, and it cannot answer any unit after that` }); },
    );
    void this.sandbox.exited.then((exited) => {
      if (!this.closeRequested && this.failure === undefined) {
        this.fail({ code: 'plugin-exited', message: `${WHERE}:1: the plugin's process exited (${exited.signal ?? `code ${String(exited.code)}`}) while the host still held it; its log is ${this.sandbox?.stderr().file ?? 'not written'}` });
      }
    });
    let declared: PluginIntroduce;
    try {
      declared = await this.awaitIntroduction();
    } catch (error) {
      await this.close();
      throw error;
    }
    this.declared = declared;
    const declaredMax = declared.limits?.maxParallelUnits ?? 1;
    const unitsAtOnce = Math.max(1, Math.min(this.settings.unitsPerPlugin, declaredMax));
    const session: PluginSession = {
      closureHash: snapshot.hash,
      declared,
      limits,
      unitsAtOnce,
      workFolder,
      runUnit: async (unit) => await this.runUnit(unit),
      pause: async () => await this.pause(),
      resume: async () => await this.resume(),
      stop: async () => await this.stop(),
      cancel: async () => await this.cancel(),
      counters: () => this.sandbox?.counters() ?? { memoryPeakBytes: 0, oomKills: 0, pidsMaxHits: 0, cpuMicros: 0, pidsCurrent: 0 },
      cgroupFolder: () => this.sandbox?.cgroupFolder,
      close: async () => { await this.close(); },
    };
    return session;
  }

  /** Waits for the introduction, or fails the session with the handshake deadline's cause. */
  private async awaitIntroduction(): Promise<PluginIntroduce> {
    const limits = this.limits;
    return await withSpan('plugin.handshake', { 'madarch.plugin.deadline_ms': limits.handshakeMs }, async () => {
      const greeting = await new Promise<PluginIntroduce>((resolve, reject) => {
        this.handshake = { startedAt: Date.now(), resolve: () => resolve(this.declared!), reject };
      });
      return greeting;
    });
  }

  /** One message from the plugin: a request (its introduction), an answer to a unit, or a notification. */
  private receive(value: unknown, bytes: number): void {
    if (this.failure !== undefined) return;
    if (typeof value === 'object' && value !== null && 'parseFailure' in value) {
      const said = (value as { parseFailure?: unknown }).parseFailure;
      this.write(failureText(null, RPC_PARSE_ERROR, `${WHERE}:1: the plugin wrote a line that is not JSON: ${String(said)}`));
      this.fail({ code: 'malformed-message', message: `${WHERE}:1: the plugin wrote a line that is not JSON (${String(said)}): its messages are JSON-RPC over newline delimited JSON` });
      return;
    }
    const first = [...Value.Errors(PluginProtocolMessage, value)][0];
    if (first !== undefined) {
      this.fail({ code: 'malformed-message', message: `${WHERE}:1: the plugin wrote a message the protocol does not hold: ${first.instancePath === '' ? 'the message' : first.instancePath.slice(1)} ${first.message}` });
      return;
    }
    if (isRequest(value)) {
      if (value.method === 'introduce') {
        this.takeIntroduction(value.id, value.params);
        return;
      }
      this.write(failureText(value.id, RPC_METHOD_NOT_FOUND, `${WHERE}:1: the host knows no plugin request "${value.method}"; the plugin asks nothing of the host in this protocol version`));
      return;
    }
    if (isNotification(value)) {
      const beat = heartbeatOf(value);
      if (beat !== undefined) {
        this.sign(beat.unitId, bytes);
        return;
      }
      const progress = progressOf(value);
      if (progress !== undefined) {
        this.sign(progress.unitId, bytes);
        const held = progress.unitId === undefined ? undefined : this.inFlight.get(progress.unitId);
        held?.progress.push(progress);
        return;
      }
      const report = errorReportOf(value);
      if (report !== undefined) {
        log.warn('the plugin reported an error', { code: report.code, unitId: report.unitId ?? '' });
        const held = report.unitId === undefined ? undefined : this.inFlight.get(report.unitId);
        if (held !== undefined) {
          held.settle(this.notExtracted(held, { code: report.code, message: report.message, ...(report.file === undefined ? {} : { file: report.file }), ...(report.line === undefined ? {} : { line: report.line }) }));
        }
        return;
      }
      return;
    }
    if (isResponse(value)) {
      const key = String(value.id);
      const waiter = this.pending.get(key);
      if (waiter === undefined) return;
      this.pending.delete(key);
      const unitId = this.unitByRequest.get(key);
      this.unitByRequest.delete(key);
      const held = unitId === undefined ? undefined : this.inFlight.get(unitId);
      if (value.error === undefined) {
        if (held !== undefined) this.countBytes(held, bytes);
        waiter.resolve(value.result);
        return;
      }
      waiter.reject({ code: value.error.data?.cause ?? 'plugin-error', message: value.error.message });
      return;
    }
  }

  /** The introduction: held to the schema and the protocol version, then answered. */
  private takeIntroduction(id: number | string, params: unknown): void {
    const greeting = this.handshake;
    if (greeting === undefined) {
      this.write(failureText(id, RPC_INVALID_REQUEST, `${WHERE}:1: the plugin introduced itself twice`));
      return;
    }
    const declared = params as PluginIntroduce;
    if (declared === null || typeof declared !== 'object' || declared.protocol !== PROTOCOL_VERSION) {
      const said = declared === null || typeof declared !== 'object' ? 'no introduction' : `protocol ${String((declared as { protocol?: unknown }).protocol)}`;
      this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: the plugin speaks ${said}, and this host speaks ${PROTOCOL_VERSION}`));
      greeting.reject({ code: 'protocol-version', message: `${WHERE}:1: the plugin introduced itself as ${said}, and this host speaks ${PROTOCOL_VERSION}` });
      this.handshake = undefined;
      this.fail({ code: 'protocol-version', message: `${WHERE}:1: the plugin introduced itself as ${said}, and this host speaks ${PROTOCOL_VERSION}` });
      return;
    }
    if (declared.rights?.network !== undefined && declared.rights.network !== 'none') {
      const cause: UnitCause = { code: 'rights-unsupported', message: `${WHERE}:1: the plugin asks for the network profile "${String(declared.rights.network)}", and this build runs only "none": the network namespace is unshared and socket creation refused` };
      this.write(failureText(id, RPC_INVALID_PARAMS, cause.message));
      this.handshake = undefined;
      this.fail(cause);
      return;
    }
    this.declared = declared;
    this.write(successText(id, { protocol: PROTOCOL_VERSION, units: 1 }));
    this.handshake = undefined;
    greeting.resolve();
    log.info('plugin introduced', { name: declared.name, version: declared.version, vertices: declared.outputs?.vertices?.length ?? 0, edges: declared.outputs?.edges?.length ?? 0 });
  }

  /** Marks a sign of life for one unit, or for the session when no unit is named. */
  private sign(unitId: string | undefined, bytes: number): void {
    if (unitId === undefined) {
      for (const held of this.inFlight.values()) held.lastSign = Date.now();
      return;
    }
    const held = this.inFlight.get(unitId);
    if (held !== undefined) {
      held.lastSign = Date.now();
      this.countBytes(held, bytes);
    }
  }

  /**
   * Adds one message's bytes to a unit's answer and fails the unit the moment
   * it passes the bound: the host does not hold a longer answer to measure it later.
   */
  private countBytes(held: InFlight, bytes: number): void {
    held.bytes += bytes;
    const limit = this.outputLimit();
    if (held.bytes <= limit) return;
    const cause: UnitCause = { code: 'unit-output-too-large', message: `${WHERE}:1: unit ${held.unitId} answered with more than the ${String(limit)} bytes a unit may answer: it was recorded as not extracted, and the plugin stopped` };
    held.settle(this.notExtracted(held, cause));
    this.fail(cause);
  }

  /** The most one unit of this plugin may answer: the smaller of the host's bound and the plugin's declared one. */
  private outputLimit(): number {
    const declared = this.declared?.limits?.maxOutputBytes;
    return Math.min(this.limits.maxUnitOutputBytes, declared ?? this.limits.maxUnitOutputBytes);
  }

  /** Writes one message to the plugin, doing nothing when the session already failed. */
  private write(text: string): void {
    if (this.sandbox === undefined || this.failure !== undefined) return;
    try {
      this.sandbox.write(text);
    } catch (error) {
      this.fail({ code: 'plugin-exited', message: `${WHERE}:1: the plugin's standard input closed: ${(error as Error).message}` });
    }
  }

  /** The one way a session fails: every held unit answers with the cause, and the tree is killed. */
  private fail(cause: UnitCause): void {
    if (this.failure !== undefined) return;
    this.failure = new SessionFailure(cause);
    this.closeRequested = true;
    log.error(`the plugin session failed: ${cause.message}`, { code: cause.code });
    if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined; }
    for (const [key, waiter] of this.pending) {
      const held = this.inFlight.get(key.slice('unit-'.length));
      if (held !== undefined) held.settle(this.notExtracted(held, cause));
      waiter.reject(cause);
    }
    this.pending.clear();
    this.sandbox?.kill();
    this.handshake?.reject(cause);
    this.handshake = undefined;
  }

  /** The deadline check: the handshake, the run, every unit's own deadline and the silence between heartbeats. */
  private checkDeadlines(): void {
    const now = Date.now();
    if (this.handshake !== undefined && now - this.handshake.startedAt >= this.limits.handshakeMs) {
      this.fail({ code: 'handshake-timeout', message: `${WHERE}:1: the plugin did not introduce itself within ${String(this.limits.handshakeMs)} ms: a plugin that never introduces itself cannot be held to anything, and the host stops it` });
      return;
    }
    if (now - this.runStartedAt >= this.limits.runMs) {
      this.fail({ code: 'run-timeout', message: `${WHERE}:1: the run passed its ${String(this.limits.runMs)} ms deadline: the units not answered are recorded as not extracted, and the tree is killed` });
      return;
    }
    for (const held of this.inFlight.values()) {
      if (now - held.startedAt >= this.limits.unitMs) {
        held.settle(this.notExtracted(held, { code: 'unit-timeout', message: `${WHERE}:1: unit ${held.unitId} passed its ${String(this.limits.unitMs)} ms deadline: it was recorded as not extracted, and the plugin stopped` }));
        this.fail({ code: 'unit-timeout', message: `${WHERE}:1: unit ${held.unitId} passed its ${String(this.limits.unitMs)} ms deadline: the plugin was stopped` });
        return;
      }
      if (!this.paused && now - held.lastSign >= this.limits.heartbeatMs) {
        held.settle(this.notExtracted(held, { code: 'heartbeat-missed', message: `${WHERE}:1: unit ${held.unitId} heard nothing from the plugin for ${String(now - held.lastSign)} ms, more than the ${String(this.limits.heartbeatMs)} ms it may stay silent: it was recorded as not extracted, and the plugin stopped` }));
        this.fail({ code: 'heartbeat-missed', message: `${WHERE}:1: the plugin stopped sending heartbeats while unit ${held.unitId} ran (${String(now - held.lastSign)} ms of silence): the plugin was stopped` });
        return;
      }
    }
  }

  /** The outcome of a unit that did not extract, with the numbers read at this moment. */
  private notExtracted(held: InFlight, cause: UnitCause): UnitOutcome {
    return {
      state: 'not-extracted',
      unitId: held.unitId,
      cause,
      bytes: held.bytes,
      durationMs: Date.now() - held.startedAt,
      counters: this.sandbox?.counters() ?? { memoryPeakBytes: 0, oomKills: 0, pidsMaxHits: 0, cpuMicros: 0, pidsCurrent: 0 },
      stderr: this.sandbox?.stderr() ?? { file: '', totalBytes: 0, truncated: false },
    };
  }

  /** Runs one unit under its deadline and heartbeat, and holds the answer to the declaration. */
  async runUnit(unit: PluginUnitRequest): Promise<UnitOutcome> {
    if (this.failure !== undefined) {
      return { state: 'not-extracted', unitId: unit.unitId, cause: this.failure.cause, bytes: 0, durationMs: 0, counters: this.sandbox?.counters() ?? { memoryPeakBytes: 0, oomKills: 0, pidsMaxHits: 0, cpuMicros: 0, pidsCurrent: 0 }, stderr: this.sandbox?.stderr() ?? { file: '', totalBytes: 0, truncated: false } };
    }
    if (this.declared === undefined) {
      return { state: 'not-extracted', unitId: unit.unitId, cause: { code: 'no-introduction', message: `${WHERE}:1: the plugin never introduced itself, and no unit is handed to a plugin whose contract is unknown` }, bytes: 0, durationMs: 0, counters: this.sandbox?.counters() ?? { memoryPeakBytes: 0, oomKills: 0, pidsMaxHits: 0, cpuMicros: 0, pidsCurrent: 0 }, stderr: this.sandbox?.stderr() ?? { file: '', totalBytes: 0, truncated: false } };
    }
    return await withSpan('plugin.unit', { 'madarch.plugin.unit': unit.unitId, 'madarch.plugin.kind': unit.kind }, async (span) => {
      const id = `unit-${String(this.nextId++)}`;
      this.unitByRequest.set(id, unit.unitId);
      const now = Date.now();
      let settle: (outcome: UnitOutcome) => void = () => undefined;
      const answered = new Promise<UnitOutcome>((resolve) => { settle = resolve; });
      const held: InFlight = { unitId: unit.unitId, startedAt: now, lastSign: now, bytes: 0, progress: [], error: undefined, settle };
      this.inFlight.set(unit.unitId, held);
      const answer = new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
      });
      this.write(requestText(id, 'unit', { unit }));
      const outcome = await Promise.race([
        answer.then((result) => this.acceptAnswer(unit, held, id, result)).catch((cause: UnitCause) => this.notExtracted(held, cause)),
        answered,
      ]);
      this.inFlight.delete(unit.unitId);
      this.pending.delete(id);
      this.unitByRequest.delete(id);
      const limit = this.outputLimit();
      if (outcome.state === 'extracted' && outcome.bytes > limit) {
        const refused: UnitOutcome = this.notExtracted(held, { code: 'unit-output-too-large', message: `${WHERE}:1: unit ${unit.unitId} answered with ${String(outcome.bytes)} bytes, more than the ${String(limit)} a unit may answer: it was recorded as not extracted, and the plugin stopped` });
        this.fail({ code: 'unit-output-too-large', message: `${WHERE}:1: unit ${unit.unitId} answered with ${String(outcome.bytes)} bytes, more than the ${String(limit)} a unit may answer: the plugin was stopped` });
        return refused;
      }
      annotateSpan({ 'madarch.plugin.outcome': outcome.state, 'madarch.plugin.bytes': outcome.bytes, 'madarch.plugin.ms': outcome.durationMs, 'madarch.plugin.vertices': outcome.state === 'extracted' ? outcome.result.vertices.length : 0, 'madarch.plugin.edges': outcome.state === 'extracted' ? outcome.result.edges.length : 0, 'madarch.plugin.removals_dropped': outcome.state === 'extracted' ? outcome.result.removalsDropped : 0 });
      if (outcome.state === 'not-extracted') {
        log.warn(`unit not extracted: ${outcome.cause.message}`, { unitId: unit.unitId, code: outcome.cause.code });
        span.setStatus({ code: 2, message: outcome.cause.code });
      } else {
        log.info('unit extracted', { unitId: unit.unitId, vertices: outcome.result.vertices.length, edges: outcome.result.edges.length, bytes: outcome.bytes, ms: outcome.durationMs });
      }
      return outcome;
    });
  }

  /** Holds one unit's answer to the declaration, and records a refusal as the unit's cause. */
  private acceptAnswer(unit: PluginUnitRequest, held: InFlight, id: string, result: unknown): UnitOutcome {
    const declared = this.declared!;
    const answer = result as { unitId?: unknown } | undefined;
    if (answer === null || typeof answer !== 'object' || answer.unitId !== unit.unitId) {
      return this.notExtracted(held, { code: 'malformed-result', message: `${WHERE}:1: unit ${unit.unitId} was answered with ${answer === undefined ? 'no result' : `a result for ${String((answer as { unitId?: unknown }).unitId)}`}: an answer names the unit it answers` });
    }
    const shape = [...Value.Errors(PluginUnitResult, answer)][0];
    if (shape !== undefined) {
      return this.notExtracted(held, { code: 'malformed-result', message: `${WHERE}:1: the answer to unit ${unit.unitId} is not a unit result: ${shape.instancePath === '' ? 'the result' : shape.instancePath.slice(1)} ${shape.message}` });
    }
    const checked = validateUnitResult(declared.outputs, answer as Parameters<typeof validateUnitResult>[1]);
    if (!checked.ok) return this.notExtracted(held, refusalCause(checked.refusal, id));
    return {
      state: 'extracted',
      unitId: unit.unitId,
      result: checked.unit,
      bytes: held.bytes,
      durationMs: Date.now() - held.startedAt,
      counters: this.sandbox?.counters() ?? { memoryPeakBytes: 0, oomKills: 0, pidsMaxHits: 0, cpuMicros: 0, pidsCurrent: 0 },
      stderr: this.sandbox?.stderr() ?? { file: '', totalBytes: 0, truncated: false },
    };
  }

  /** Pauses the whole tree: the freezer holds every process, and the heartbeat deadline waits with it. */
  async pause(): Promise<void> {
    if (this.failure !== undefined) return;
    await withSpan('plugin.pause', { 'madarch.plugin.hash': this.closureHash }, async () => {
      this.paused = true;
      this.sandbox?.freeze();
      this.write(requestText(0, 'pause'));
      log.info('plugin paused', {});
    });
  }

  /** Thaws the tree and gives every unit its whole heartbeat deadline again. */
  async resume(): Promise<void> {
    if (this.failure !== undefined) return;
    await withSpan('plugin.resume', {}, async () => {
      this.paused = false;
      for (const held of this.inFlight.values()) held.lastSign = Date.now();
      this.write(requestText(0, 'resume'));
      this.sandbox?.thaw();
      log.info('plugin resumed', {});
    });
  }

  /** Asks the plugin to finish its unit and exit; after the grace period, cancels. */
  async stop(): Promise<{ readonly state: 'exited' | 'cancelled' }> {
    if (this.failure !== undefined) return { state: 'cancelled' };
    return await withSpan('plugin.stop', { 'madarch.plugin.grace_ms': this.limits.stopGraceMs }, async () => {
      this.stopping = true;
      this.write(requestText(0, 'stop'));
      const grace = await Promise.race([
        (this.sandbox?.exited ?? Promise.resolve({ code: 0, signal: null })).then(() => true),
        Bun.sleep(this.limits.stopGraceMs).then(() => false),
      ]);
      if (grace) return { state: 'exited' };
      log.warn('the plugin ignored stop', { grace_ms: this.limits.stopGraceMs });
      await this.cancel();
      if (this.failure === undefined) this.failure = new SessionFailure({ code: 'stop-ignored', message: `${WHERE}:1: the plugin did not exit within the ${String(this.limits.stopGraceMs)} ms grace a stop gets, and its tree was cancelled` });
      log.warn('the plugin was cancelled after ignoring stop', {});
      return { state: 'cancelled' };
    });
  }

  /** Kills the whole tree at once, through the cgroup (or the process group on macOS). */
  async cancel(): Promise<void> {
    await withSpan('plugin.cancel', { 'madarch.plugin.hash': this.closureHash }, async () => {
      this.closeRequested = true;
      if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined; }
      this.write(notificationText('cancel'));
      this.sandbox?.kill();
      log.info('plugin cancelled', {});
    });
  }

  /** Ends the session: stops the tree, waits for it, removes the cgroup, and settles every held unit. */
  async close(): Promise<void> {
    this.closeRequested = true;
    if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined; }
    const cause: UnitCause = { code: 'session-closed', message: `${WHERE}:1: the session was closed while this unit was in flight: it was recorded as not extracted` };
    for (const [key, waiter] of this.pending) {
      const held = this.inFlight.get(this.unitByRequest.get(key) ?? key);
      if (held !== undefined) held.settle(this.notExtracted(held, cause));
      waiter.reject(cause);
    }
    this.pending.clear();
    this.unitByRequest.clear();
    if (this.sandbox !== undefined) {
      this.sandbox.kill();
      await Promise.race([this.sandbox.exited, Bun.sleep(2_000)]);
      this.sandbox.dispose();
    }
  }
}

/** A validation refusal as the unit's cause, with the plugin's folder in the message. */
function refusalCause(refusal: ResultRefusal, id: string): UnitCause {
  return { code: refusal.code, message: `${WHERE}:1: within the answer to ${id}, ${refusal.message}` };
}

/** One unit the runner hands out, with the plugin it goes to: a unit's plugin is chosen by the caller. */
export interface RunnerUnit {
  readonly pluginFolder: string;
  readonly unit: PluginUnitRequest;
}

/** What one plugin's share of the work came to: its session's declaration and its units' outcomes. */
export interface PluginRunResult {
  readonly pluginFolder: string;
  readonly closureHash: string;
  readonly units: readonly UnitOutcome[];
}

/**
 * Runs units through plugins at the product's setting (decision 0035, item
 * 13): no more than `pluginsAtOnce` plugins at once, and each plugin no more
 * units at a time than the smaller of `unitsPerPlugin` and what it declared.
 * The units of one plugin keep their order; the plugins run in parallel.
 */
export async function runUnits(options: Omit<PluginHostOptions, 'pluginFolder' | 'settings'> & { readonly settings?: Partial<HostSettings> }, work: readonly RunnerUnit[], open?: (session: PluginSession) => void): Promise<PluginRunResult[]> {
  const settings: HostSettings = { ...DEFAULT_HOST_SETTINGS, ...(options.settings ?? {}) };
  const byPlugin = new Map<string, PluginUnitRequest[]>();
  for (const item of work) {
    const held = byPlugin.get(item.pluginFolder) ?? [];
    held.push(item.unit);
    byPlugin.set(item.pluginFolder, held);
  }
  const folders = [...byPlugin.keys()].sort(byCodePoint);
  const results: PluginRunResult[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < folders.length) {
      const folder = folders[next++]!;
      const units = byPlugin.get(folder)!;
      const host = new PluginHost({ ...options, pluginFolder: folder, settings });
      const session = await host.open();
      open?.(session);
      try {
        const outcomes: UnitOutcome[] = [];
        let at = 0;
        const lane = async (): Promise<void> => {
          while (at < units.length) outcomes.push(await session.runUnit(units[at++]!));
        };
        await Promise.all(Array.from({ length: session.unitsAtOnce }, () => lane()));
        results.push({ pluginFolder: folder, closureHash: session.closureHash, units: outcomes });
      } finally {
        await session.close();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(settings.pluginsAtOnce, folders.length || 1)) }, () => worker()));
  return results.sort((left, right) => byCodePoint(left.pluginFolder, right.pluginFolder));
}
