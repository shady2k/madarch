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
import { mkdirSync, readFileSync } from 'node:fs';
import { snapshotTools, type TrustedTool } from './tools.js';
import { releaseTools } from './release-tools.js';
import { snapshotFilesystemInputs } from './filesystem-inputs.js';
import { PluginAgentBridge, type PluginAgentOptions, type PluginAgentReport } from './agent.js';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { byCodePoint } from '../model/order.js';
import { log } from '../obs/log.js';
import { annotateSpan, withSpan, withSpanSync } from '../obs/trace.js';
import type { CgroupCounters } from './cgroup.js';
import { ClosureRefusal, closureOf, interpreterPinProblem, pluginReadsOf, pluginRightsOf, type Closure } from './closure.js';
import { graphReadsOf, PluginOutputPlan, PluginResultChunk, PluginGraphFilesRequest, PluginAgentRunRequest, PluginGraphValueRequest, PluginUnitResult, PROTOCOL_VERSION, PluginGraphPageRequest, type PluginGraphRead, type PluginGraphRemovedEnd, type PluginGraphUnevidencedOpinion, type PluginGraphUnresolvedReference, type PluginIntroduce, type PluginProgress, type PluginUnitRequest, type PluginErrorReport, type PluginRights } from './protocol.js';
import { validateUnitResult, type ResultRefusal, type ValidatedUnit } from './results.js';
import { closureTrustProblem, snapshotClosure, type ClosureTrust } from './snapshot.js';
import { startPluginProcess, type SandboxProcess, type SandboxSpec, type StderrLog } from './sandbox.js';
import { errorReportOf, failureText, heartbeatOf, isNotification, isRequest, isResponse, lineReader, notificationText, progressOf, protocolMessageProblem, requestText, RPC_INVALID_PARAMS, RPC_INVALID_REQUEST, RPC_METHOD_NOT_FOUND, RPC_PARSE_ERROR, successText } from './wire.js';

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

/** The graph request methods the host answers, and the capability each one needs from the contract. */
type GraphMethod = 'graph.files' | 'graph.value' | 'graph.unresolved' | 'graph.removedEnds' | 'graph.unevidenced';
const GRAPH_READ_OF: Readonly<Record<GraphMethod, PluginGraphRead>> = {
  'graph.files': 'files', 'graph.value': 'value', 'graph.unresolved': 'unresolved', 'graph.removedEnds': 'removedEnds', 'graph.unevidenced': 'unevidenced',
};

/**
 * The graph reads a plugin asks its host for (decision 0035, item 15): the file vertices a pattern names, and one field
 * of one vertex — a file's content, which the files producer stored by blob. The host answers from the graph and only
 * from it; a plugin that declared no `graph` right is refused, and a host given no answerer answers none.
 */
export interface GraphAnswerer {
  files(pattern: string, snapshot?: { readonly runId: string; readonly unitId: string; readonly generation: number }): Promise<readonly { readonly kind: string; readonly key: Readonly<Record<string, string | number>> }[]>;
  value(kind: string, key: import('./protocol.js').PluginKeyValues, field: string, snapshot?: { readonly runId: string; readonly unitId: string; readonly generation: number }): Promise<unknown>;
  /** A page of the references the writer recorded and no vertex holds (madarch-stm0.7.1, piece 2). Absent: refused. */
  unresolved?(query: PluginGraphPageRequest): Promise<{ readonly references: readonly PluginGraphUnresolvedReference[]; readonly next?: string }>;
  /** A page of the edges one of whose ends is removed (piece 2). Absent: refused. */
  removedEnds?(query: PluginGraphPageRequest): Promise<{ readonly edges: readonly PluginGraphRemovedEnd[]; readonly next?: string }>;
  /** A page of the open opinions of evidence-required fields that state none (piece 4). Absent: refused. */
  unevidenced?(query: PluginGraphPageRequest): Promise<{ readonly opinions: readonly PluginGraphUnevidencedOpinion[]; readonly next?: string }>;
}

/**
 * One request a plugin made of the host, as the debug journal keeps it: the method, the size of the answer, what came
 * of it and — for a refusal or a failure — the class of the cause. It never carries the request's arguments, a file's
 * text or an answer's content.
 */
export interface RecordedRequest {
  readonly method: string;
  readonly size: number;
  readonly outcome: 'answered' | 'refused' | 'failed' | 'abandoned' | 'truncated';
  readonly cause?: string;
}

/** How many requests one unit's debug journal keeps, and how many serialized bytes its records may take. */
export const REQUEST_LOG_REQUESTS = 256;
export const REQUEST_LOG_BYTES = 4 * 1024 * 1024;

/**
 * The requests one unit made, kept in the host's dispatcher (codex, stage 2 review, items 5 and 6): a request is
 * recorded when it is received — before the protocol and the dispatcher hold it to anything — so a malformed, a
 * refused, a failed and an abandoned one stand beside an answered one, and the record holds a method, a size and a
 * class, never an argument or a text. The bound is on the records themselves: how many one unit may make the entry
 * hold, and how many bytes their serialization takes; past it nothing more is kept, and the entry ends with one
 * `truncated` record naming how many were.
 */
export class RequestLog {
  private readonly kept: { method: string; state: 'answered' | 'refused' | 'failed' | 'pending'; size: number; cause?: string }[] = [];
  private bytes = 0;
  private truncatedAt: number | undefined;
  private emitted: readonly RecordedRequest[] | undefined;
  constructor(private readonly maxRequests = REQUEST_LOG_REQUESTS, private readonly maxBytes = REQUEST_LOG_BYTES) {}

  /** Keeps one request, unless the journal's bound is reached; answers the slot its outcome is settled through. */
  begin(method: string): { method: string; state: 'answered' | 'refused' | 'failed' | 'pending'; size: number; cause?: string } | undefined {
    if (this.emitted !== undefined) return undefined;
    if (this.kept.length >= this.maxRequests || this.bytes >= this.maxBytes) {
      this.truncatedAt ??= this.kept.length;
      return undefined;
    }
    const slot: { method: string; state: 'answered' | 'refused' | 'failed' | 'pending'; size: number; cause?: string } = { method, state: 'pending', size: 0 };
    this.kept.push(slot);
    return slot;
  }

  /** States what came of one kept request; a slot settled after the log was emitted changes nothing. */
  settle(slot: { method: string; state: 'answered' | 'refused' | 'failed' | 'pending'; size: number; cause?: string } | undefined, outcome: 'answered' | 'refused' | 'failed', size: number, cause?: string): void {
    if (slot === undefined || this.emitted !== undefined) return;
    slot.state = outcome;
    slot.size = size;
    if (cause !== undefined) slot.cause = cause;
    // What the bound counts is the entry these records make: their serialized bytes, never an answer's size (codex,
    // stage 2 review, item 6).
    this.bytes += Buffer.byteLength(JSON.stringify({ method: slot.method, size, outcome, ...(cause === undefined ? {} : { cause }) }), 'utf8');
  }

  /** The records an entry carries: a request still waiting is abandoned, and a bound hit leaves one marker. */
  finish(): readonly RecordedRequest[] {
    if (this.emitted !== undefined) return this.emitted;
    const records: RecordedRequest[] = this.kept.map((held) => ({
      method: held.method, size: held.size,
      outcome: held.state === 'pending' ? 'abandoned' : held.state,
      ...(held.cause === undefined ? {} : { cause: held.cause }),
    }));
    if (this.truncatedAt !== undefined) records.push({ method: 'truncated', size: this.truncatedAt, outcome: 'truncated', cause: `after ${String(this.truncatedAt)} requests or ${String(REQUEST_LOG_BYTES)} bytes` });
    this.emitted = records;
    return records;
  }
}

/** What a session is opened from. */
export interface PluginHostOptions {
  /** The plugin's folder, the closure's source. */
  readonly pluginFolder: string;
  /**
   * The closure a caller already read and holds — the hash it printed, or the one a person approved. It is used as
   * it stands instead of reading the folder again, so the copy is held to the closure the caller named.
   */
  readonly closure?: Closure;
  /** The repository snapshot a plugin that declared the `filesystem` right may read, bound read-only. */
  readonly repository: string;
  /** Explicit read-only filesystem inputs; callers supply isolated pinned snapshots. */
  readonly filesystemInputs?: readonly { readonly name: string; readonly folder: string }[];
  /** Approved executable pins. A manifest declaration alone never grants trust. */
  readonly tools?: Readonly<Record<string, TrustedTool>>;
  /** The graph a plugin that declared the `graph` right reads through its queries; absent, every query is refused. */
  readonly graph?: GraphAnswerer;
  /** Host-owned ACP adapter, environment, confined connector and optional catalogue outputs. */
  readonly agent?: PluginAgentOptions;
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
  /** `journal.debug`: where the host records every request the plugin makes, refused and abandoned ones included. */
  readonly requests?: RequestLog;
}

/** One open plugin: its declaration, the way to run units, and the controls a run needs. */
export interface PluginSession {
  readonly closureHash: string;
  readonly declared: PluginIntroduce;
  readonly limits: HostLimits;
  /** The most units this plugin takes at once: the smaller of the setting and its declared count. */
  readonly unitsAtOnce: number;
  readonly workFolder: string;
  planOutput(unit: PluginUnitRequest, cursor?: string): Promise<PluginOutputPlan>;
  runUnit(unit: PluginUnitRequest): Promise<UnitOutcome>;
  agentReports(): ReadonlyMap<string, PluginAgentReport>;
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
  private agentBridge: PluginAgentBridge | undefined;
  private agentPart: Closure['manifest']['agent'];
  private agentPrompt: string | undefined;
  private readonly reports = new Map<string, PluginAgentReport>();
  private snapshot: { folder: string; hash: string } | undefined;
  private declared: PluginIntroduce | undefined;
  /** The rights the closure's own contract declares, read before the plugin starts. */
  private contractRights: PluginRights | undefined;
  /** What the closure's own contract says it reads, read before the plugin starts. */
  private contractReads: 'unit' | 'whole-graph' = 'unit';
  private failure: SessionFailure | undefined;
  private handshake: { startedAt: number; resolve: () => void; reject: (cause: UnitCause) => void } | undefined;
  private readonly inFlight = new Map<string, InFlight>();
  private readonly resultChunks = new Map<string, { count: number; bytes: Buffer[] }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private paused = false;
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
    const pin = interpreterPinProblem(closure);
    if (pin !== undefined) throw pin;
    const trust = closureTrustProblem(closure, this.options.trust, join(closure.folder, 'plugin.json'), this.options.releaseHashes);
    if (trust !== undefined) throw trust;
    // The rights are the contract's, read before the process starts: the sandbox binds a repository only for a plugin
    // whose contract declared the filesystem right (decision 0035, item 9).
    this.agentPart = closure.manifest.agent;
    this.contractRights = pluginRightsOf(closure);
    this.contractReads = pluginReadsOf(closure);
    const snapshot = await withSpan('plugin.snapshot', { 'madarch.plugin.hash': closure.hash }, async () => {
      const copy = await snapshotClosure(closure, this.options.workRoot);
      log.info('plugin closure copied', { folder: copy.folder, hash: copy.hash });
      return copy;
    });
    this.snapshot = snapshot;
    if (this.agentPart !== undefined) {
      const prompt = this.agentPart.prompt;
      if (prompt.startsWith('/') || prompt.split('/').some((part) => part === '..' || part === '.' || part === '') || prompt.includes('\\')) throw new ClosureRefusal('agent-prompt', `${WHERE}:1: agent.prompt must name a file inside the closure`, join(this.options.pluginFolder, 'plugin.json'));
      try { this.agentPrompt = readFileSync(join(snapshot.folder, prompt), 'utf8'); }
      catch (error) { throw new ClosureRefusal('agent-prompt', `${WHERE}:1: cannot read agent prompt ${join(snapshot.folder, prompt)}: ${(error as Error).message}`, join(this.options.pluginFolder, 'plugin.json')); }
    }
    const platform = this.options.platform ?? `${process.platform}-${process.arch}`;
    // Only a plugin whose contract declared the filesystem right sees a repository: the glossary reads the graph, and
    // the files producer alone reads the source tree (decision 0035, item 9).
    const readsRepository = this.contractRights?.filesystem === true;
    const tools = snapshotTools(closure.manifest.tools, this.options.tools ?? releaseTools(platform), workFolder);
    if ((this.options.filesystemInputs?.length ?? 0) > 0 && !readsRepository) throw new ClosureRefusal('plugin-filesystem', `${WHERE}:1: filesystem inputs require the declared filesystem right`, WHERE);
    const spec: SandboxSpec = {
      closureFolder: snapshot.folder,
      tools,
      filesystemInputs: withSpanSync('plugin.filesystem-inputs', { 'madarch.plugin.hash': closure.hash }, () => snapshotFilesystemInputs(this.options.filesystemInputs ?? [], this.options.workRoot)),
      ...(readsRepository && (this.options.filesystemInputs?.length ?? 0) === 0 ? { repository: this.options.repository } : {}),
      workFolder,
      runtime: process.execPath,
      entry: closure.manifest.entry,
      limits: { memoryBytes: limits.memoryBytes, cpuQuotaMicros: limits.cpuQuotaMicros, cpuPeriodMicros: limits.cpuPeriodMicros, pids: limits.pids },
      ...(this.options.cgroupParent === undefined ? {} : { cgroupParent: this.options.cgroupParent }),
      ...(this.options.env === undefined ? {} : { env: this.options.env }),
      platform,
    };
    this.sandbox = await withSpan('plugin.spawn', { 'madarch.plugin.hash': snapshot.hash, 'madarch.sandbox': platform }, async () => await startPluginProcess(spec));
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
      const cause = error as UnitCause;
      if (cause.code === 'plugin-exited' && this.sandbox !== undefined) {
        const stderr = this.sandbox.stderr();
        const text = readFileSync(stderr.file, 'utf8');
        throw { ...cause, message: `${cause.message}
Plugin stderr (${stderr.file}${stderr.truncated ? '; truncated to the log tail' : ''}):
${text === '' ? '(empty)' : text}` };
      }
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
      planOutput: async (unit, cursor) => await this.planOutput(unit, cursor),
      runUnit: async (unit) => await this.runUnit(unit),
      agentReports: () => new Map(this.reports),
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
    const problem = protocolMessageProblem(value);
    if (problem !== undefined) {
      // A message the protocol does not hold is recorded before it is refused, under the method it named: a malformed
      // graph request stands in the journal with its class, not only a well-formed refusal (codex, stage 2 review, 5).
      const named = typeof value === 'object' && value !== null && typeof (value as { method?: unknown }).method === 'string' ? (value as { method: string }).method : '';
      if (named !== '') {
        const slot = this.options.requests?.begin(named);
        this.options.requests?.settle(slot, 'refused', 0, 'malformed-message');
      }
      this.fail({ code: 'malformed-message', message: `${WHERE}:1: the plugin wrote a message the protocol does not hold: ${problem}` });
      return;
    }
    if (isRequest(value)) {
      // Every request is recorded where it is received, so a refusal, a failure and a request the unit never saw
      // answered stand beside an answered one in the debug journal (codex, stage 2 review, item 5).
      const log = this.options.requests;
      if (value.method === 'introduce') {
        const slot = log?.begin('introduce');
        const taken = this.takeIntroduction(value.id, value.params);
        log?.settle(slot, taken ? 'answered' : 'refused', 0, taken ? undefined : 'introduce-refused');
        return;
      }
      if (value.method === 'agent.run') {
        const slot = log?.begin(value.method);
        void this.answerAgent(value.id, value.params).then((answer) => log?.settle(slot, answer.outcome, answer.size, answer.cause));
        return;
      }
      if (value.method === 'graph.files' || value.method === 'graph.value' || value.method === 'graph.unresolved' || value.method === 'graph.removedEnds' || value.method === 'graph.unevidenced') {
        const slot = log?.begin(value.method);
        void this.answerGraph(value.id, value.method, value.params).then((answer) => log?.settle(slot, answer.outcome, answer.size, answer.cause));
        return;
      }
      const slot = log?.begin(String(value.method));
      this.write(failureText(value.id, RPC_METHOD_NOT_FOUND, `${WHERE}:1: the host knows no plugin request "${value.method}"; its requests are introduce, graph.files, graph.value, graph.unresolved, graph.removedEnds and graph.unevidenced`));
      log?.settle(slot, 'refused', 0, 'method-not-found');
      return;
    }
    if (isNotification(value)) {
      if (value.method === 'unit.resultChunk') {
        const chunk = value.params;
        if (!Value.Check(PluginResultChunk, chunk)) {
          this.fail({ code: 'malformed-result', message: `${WHERE}:1: result chunk must carry a unitId, sequence and base64 data` });
          return;
        }
        const held = this.inFlight.get(chunk.unitId);
        if (held === undefined) { this.fail({ code: 'malformed-result', message: `${WHERE}:1: result chunk names no active unit` }); return; }
        const decoded = Buffer.from(chunk.data, 'base64');
        this.countBytes(held, decoded.byteLength);
        if (this.failure !== undefined) return;
        const accumulated = this.resultChunks.get(chunk.unitId) ?? { count: 0, bytes: [] };
        if (chunk.sequence !== accumulated.count) { this.fail({ code: 'malformed-result', message: `${WHERE}:1: result chunks must arrive in sequence` }); return; }
        accumulated.count += 1;
        accumulated.bytes.push(decoded);
        this.resultChunks.set(chunk.unitId, accumulated);
        held.lastSign = Date.now();
        return;
      }
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
        if (held !== undefined && !this.resultChunks.has(held.unitId)) this.countBytes(held, bytes);
        waiter.resolve(value.result);
        return;
      }
      waiter.reject({ code: value.error.data?.cause ?? 'plugin-error', message: value.error.message });
      return;
    }
  }

  /**
   * One graph read of a plugin (decision 0035, item 15; madarch-stm0.7.1, piece 2): answered from the graph when the
   * plugin declared the right and the read, and the host was given an answerer; refused by name otherwise. The plugin
   * never sees a folder or the store: a file's content comes through an answer, and so do the writer's consistency
   * records.
   */
  private async answerGraph(id: number | string, method: GraphMethod, params: unknown): Promise<{ outcome: 'answered' | 'refused' | 'failed'; size: number; cause?: string }> {
    const read = GRAPH_READ_OF[method];
    const granted = graphReadsOf(this.declared?.rights);
    if (this.declared?.rights?.graph !== true || !granted.includes(read)) {
      const cause = this.declared?.rights?.graph !== true
        ? `${WHERE}:1: the plugin declared no graph right in its introduction, so it may read nothing of the graph: declare "graph": true beside the rights it needs, or read no graph`
        : `${WHERE}:1: the plugin declared the graph reads ${granted.map((one) => JSON.stringify(one)).join(', ') || 'none'}, and not ${JSON.stringify(read)}: a read its contract does not name is refused by name`;
      this.write(failureText(id, RPC_INVALID_PARAMS, cause, { cause: 'graph-denied' }));
      return { outcome: 'refused', size: 0, cause: 'graph-denied' };
    }
    if (this.options.graph === undefined) {
      this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: the host was given no graph to answer from, so the query is refused`, { cause: 'graph-denied' }));
      return { outcome: 'refused', size: 0, cause: 'graph-denied' };
    }
    try {
      if (method === 'graph.files') {
        if (!Value.Check(PluginGraphFilesRequest, params)) {
          const first = [...Value.Errors(PluginGraphFilesRequest, params)][0];
          this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: graph.files takes { pattern }, and was given ${first === undefined ? 'another shape' : first.message}`, { cause: 'graph-invalid' }));
          return { outcome: 'refused', size: 0, cause: 'graph-invalid' };
        }
        const files = await this.options.graph.files(params.pattern);
        this.write(successText(id, { files }));
        return { outcome: 'answered', size: files.length };
      }
      if (method === 'graph.value') {
        if (!Value.Check(PluginGraphValueRequest, params)) {
          const first = [...Value.Errors(PluginGraphValueRequest, params)][0];
          this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: graph.value takes { kind, key, field }, and was given ${first === undefined ? 'another shape' : first.message}`, { cause: 'graph-invalid' }));
          return { outcome: 'refused', size: 0, cause: 'graph-invalid' };
        }
        const value = await this.options.graph.value(params.kind, params.key, params.field);
        this.write(successText(id, { value }));
        return { outcome: 'answered', size: typeof value === 'string' ? value.length : 0 };
      }
      // The three consistency reads take a page request and answer one page each.
      if (!Value.Check(PluginGraphPageRequest, params)) {
        const first = [...Value.Errors(PluginGraphPageRequest, params)][0];
        this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: ${method} takes { after?, limit? }, and was given ${first === undefined ? 'another shape' : first.message}`, { cause: 'graph-invalid' }));
        return { outcome: 'refused', size: 0, cause: 'graph-invalid' };
      }
      if (method === 'graph.unresolved') {
        if (this.options.graph.unresolved === undefined) return this.graphUnavailable(id, method);
        const answer = await this.options.graph.unresolved(params);
        this.write(successText(id, answer));
        return { outcome: 'answered', size: answer.references.length };
      }
      if (method === 'graph.removedEnds') {
        if (this.options.graph.removedEnds === undefined) return this.graphUnavailable(id, method);
        const answer = await this.options.graph.removedEnds(params);
        this.write(successText(id, answer));
        return { outcome: 'answered', size: answer.edges.length };
      }
      if (this.options.graph.unevidenced === undefined) return this.graphUnavailable(id, method);
      const answer = await this.options.graph.unevidenced(params);
      this.write(successText(id, answer));
      return { outcome: 'answered', size: answer.opinions.length };
    } catch (error) {
      this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: the graph answered ${JSON.stringify(method)} with a failure: ${(error as Error).message}`, { cause: 'graph-failed' }));
      return { outcome: 'failed', size: 0, cause: 'graph-failed' };
    }
  }

  /** Agent requests belong to an active unit and only the manifest's agent part can grant them. */
  private async answerAgent(id: number | string, params: unknown): Promise<{ outcome: 'answered' | 'refused' | 'failed'; size: number; cause?: string }> {
    if (!Value.Check(PluginAgentRunRequest, params) || !this.inFlight.has(params.unitId) || this.agentBridge === undefined) {
      this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: agent.run needs an active unit, a manifest agent part, host adapter and graph`, { cause: 'agent-denied' }));
      return { outcome: 'refused', size: 0, cause: 'agent-denied' };
    }
    try {
      const result = await this.agentBridge.run(params.unitId, params.task);
      const size = Buffer.byteLength(JSON.stringify(result));
      const held = this.inFlight.get(params.unitId);
      if (held === undefined) return { outcome: 'failed', size: 0, cause: 'unit-ended' };
      this.countBytes(held, size);
      this.write(successText(id, result));
      return { outcome: 'answered', size };
    } catch (error) {
      this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: agent.run failed: ${(error as Error).message}`, { cause: 'agent-failed' }));
      return { outcome: 'failed', size: 0, cause: 'agent-failed' };
    }
  }

  /** A read the host's answerer has no way to answer: refused by name, never answered with an empty list. */
  private graphUnavailable(id: number | string, method: GraphMethod): { outcome: 'refused'; size: number; cause: string } {
    this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: the host was given no answer for ${JSON.stringify(method)}, so the query is refused`, { cause: 'graph-denied' }));
    return { outcome: 'refused', size: 0, cause: 'graph-denied' };
  }

  /** The introduction: held to the schema and the protocol version, then answered; false when it was refused. */
  private takeIntroduction(id: number | string, params: unknown): boolean {
    const greeting = this.handshake;
    if (greeting === undefined) {
      this.write(failureText(id, RPC_INVALID_REQUEST, `${WHERE}:1: the plugin introduced itself twice`));
      return false;
    }
    const declared = params as PluginIntroduce;
    if (declared === null || typeof declared !== 'object' || declared.protocol !== PROTOCOL_VERSION) {
      const said = declared === null || typeof declared !== 'object' ? 'no introduction' : `protocol ${String((declared as { protocol?: unknown }).protocol)}`;
      this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: the plugin speaks ${said}, and this host speaks ${PROTOCOL_VERSION}`));
      greeting.reject({ code: 'protocol-version', message: `${WHERE}:1: the plugin introduced itself as ${said}, and this host speaks ${PROTOCOL_VERSION}` });
      this.handshake = undefined;
      this.fail({ code: 'protocol-version', message: `${WHERE}:1: the plugin introduced itself as ${said}, and this host speaks ${PROTOCOL_VERSION}` });
      return false;
    }
    if (this.contractRights !== undefined && JSON.stringify(canonicalRights(declared.rights ?? { network: 'none' })) !== JSON.stringify(canonicalRights(this.contractRights))) {
      const cause: UnitCause = { code: 'rights-mismatch', message: `${WHERE}:1: the plugin introduced itself with the rights ${JSON.stringify(declared.rights ?? { network: 'none' })}, and its own contract ${join(this.options.pluginFolder, 'contract.json')} declares ${JSON.stringify(this.contractRights)}: the contract is what the host grants, and the introduction repeats it` };
      this.write(failureText(id, RPC_INVALID_PARAMS, cause.message));
      this.handshake = undefined;
      this.fail(cause);
      return false;
    }
    if ((declared.reads ?? 'unit') !== this.contractReads) {
      const cause: UnitCause = { code: 'reads-mismatch', message: `${WHERE}:1: the plugin introduced itself as reading ${JSON.stringify(declared.reads ?? 'unit')}, and its own contract ${join(this.options.pluginFolder, 'contract.json')} declares ${JSON.stringify(this.contractReads)}: the contract is what the host plans it by, and the introduction repeats it` };
      this.write(failureText(id, RPC_INVALID_PARAMS, cause.message));
      this.handshake = undefined;
      this.fail(cause);
      return false;
    }
    if (declared.rights?.network !== undefined && declared.rights.network !== 'none') {
      const cause: UnitCause = { code: 'rights-unsupported', message: `${WHERE}:1: the plugin asks for the network profile "${String(declared.rights.network)}", and this build runs only "none": the network namespace is unshared and socket creation refused` };
      this.write(failureText(id, RPC_INVALID_PARAMS, cause.message));
      this.handshake = undefined;
      this.fail(cause);
      return false;
    }
    const agentOutputs = this.options.agent?.outputs;
    if (this.agentPart !== undefined && agentOutputs !== undefined) declared.outputs = agentOutputs;
    this.declared = declared;
    if (this.agentPart !== undefined && this.options.agent !== undefined && this.options.graph !== undefined) {
      this.agentBridge = new PluginAgentBridge({ ...this.agentPart, prompt: this.agentPrompt! }, { ...this.options.agent, onSession: (report) => {
        this.reports.set(report.unitId, report);
        this.options.agent?.onSession?.(report);
      } }, this.options.graph, declared.outputs);
    }
    this.write(successText(id, { protocol: PROTOCOL_VERSION, units: 1 }));
    this.handshake = undefined;
    greeting.resolve();
    log.info('plugin introduced', { name: declared.name, version: declared.version, vertices: declared.outputs?.vertices?.length ?? 0, edges: declared.outputs?.edges?.length ?? 0 });
    return true;
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
    void this.agentBridge?.close();
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
      this.resultChunks.delete(unit.unitId);
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
  private decodeResult(unitId: string, value: unknown): unknown {
    const answer = value as { unitId?: unknown; chunkCount?: unknown } | null;
    if (answer === null || typeof answer !== 'object' || answer.unitId !== unitId) throw { code: 'malformed-result', message: `${WHERE}:1: answer must name its unit` };
    const chunks = this.resultChunks.get(unitId);
    this.resultChunks.delete(unitId);
    if (chunks === undefined && answer.chunkCount === undefined) return answer;
    if (chunks === undefined || answer.chunkCount !== chunks.count || Object.keys(answer).some((field) => field !== 'unitId' && field !== 'chunkCount')) throw { code: 'malformed-result', message: `${WHERE}:1: final chunk count must match the complete result fragments` };
    try {
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.bytes)));
      if (decoded === null || typeof decoded !== 'object' || (decoded as { unitId?: unknown }).unitId !== unitId) throw new Error('fragmented result names the wrong unit');
      return decoded;
    } catch (error) { throw { code: 'malformed-result', message: `${WHERE}:1: fragmented result is invalid: ${(error as Error).message}` }; }
  }

  private async planOutput(unit: PluginUnitRequest, cursor?: string): Promise<PluginOutputPlan> {
    if (this.declared?.planOutput !== true) throw { code: 'plan-unsupported', message: `${WHERE}:1: plugin does not declare planOutput` };
    if (this.failure !== undefined) throw this.failure.cause;
    if (this.inFlight.has(unit.unitId)) throw { code: 'plan-busy', message: `${WHERE}:1: a unit with this id is already active` };
    const id = `plan-${String(this.nextId++)}`;
    const now = Date.now();
    let failed!: (cause: UnitCause) => void;
    const failure = new Promise<never>((_resolve, reject) => { failed = reject; });
    const held: InFlight = { unitId: unit.unitId, startedAt: now, lastSign: now, bytes: 0, progress: [], error: undefined, settle: (outcome) => { if (outcome.state === 'not-extracted') failed(outcome.cause); } };
    this.inFlight.set(unit.unitId, held);
    this.unitByRequest.set(id, unit.unitId);
    const response = new Promise<unknown>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    this.write(requestText(id, 'planOutput', { unit, ...(cursor === undefined ? {} : { cursor }) }));
    try {
      const value = this.decodeResult(unit.unitId, await Promise.race([response, failure])) as { unitId: string; partitions?: unknown; next?: unknown };
      const { unitId: _unitId, ...page } = value;
      if (!Value.Check(PluginOutputPlan, page)) throw { code: 'malformed-plan', message: `${WHERE}:1: planOutput must return bounded partitions and an optional next cursor` };
      return page;
    } finally {
      this.inFlight.delete(unit.unitId);
      this.resultChunks.delete(unit.unitId);
      this.pending.delete(id);
      this.unitByRequest.delete(id);
    }
  }

  private acceptAnswer(unit: PluginUnitRequest, held: InFlight, id: string, result: unknown): UnitOutcome {
    const declared = this.declared!;
    let answer = result as { unitId?: unknown; chunkCount?: unknown; vertices?: unknown; edges?: unknown; removals?: unknown } | undefined;
    if (answer === null || typeof answer !== 'object' || answer.unitId !== unit.unitId) {
      return this.notExtracted(held, { code: 'malformed-result', message: `${WHERE}:1: unit ${unit.unitId} was answered with ${answer === undefined ? 'no result' : `a result for ${String((answer as { unitId?: unknown }).unitId)}`}: an answer names the unit it answers` });
    }
    try { answer = this.decodeResult(unit.unitId, answer) as typeof answer; }
    catch (cause) { return this.notExtracted(held, cause as UnitCause); }
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
      this.agentBridge?.pause();
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
      this.agentBridge?.resume();
      log.info('plugin resumed', {});
    });
  }

  /** Asks the plugin to finish its unit and exit; after the grace period, cancels. */
  async stop(): Promise<{ readonly state: 'exited' | 'cancelled' }> {
    if (this.failure !== undefined) return { state: 'cancelled' };
    return await withSpan('plugin.stop', { 'madarch.plugin.grace_ms': this.limits.stopGraceMs }, async () => {
      await this.agentBridge?.close();
      this.write(requestText(0, 'stop'));
      const grace = await Promise.race([
        (this.sandbox?.exited ?? Promise.resolve({ code: 0, signal: null })).then(() => true),
        Bun.sleep(this.limits.stopGraceMs).then(() => false),
      ]);
      if (grace) { await this.agentBridge?.close(); return { state: 'exited' }; }
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
      await this.agentBridge?.close();
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
    await this.agentBridge?.close();
    if (this.sandbox !== undefined) {
      this.sandbox.kill();
      await Promise.race([this.sandbox.exited, Bun.sleep(2_000)]);
      await this.sandbox.dispose();
    }
  }
}

/** Rights with their keys in code point order, so two declarations of the same rights compare equal. */
function canonicalRights(rights: PluginRights): Record<string, unknown> {
  const graphReads = rights.graphReads === undefined ? undefined : [...new Set(rights.graphReads)].sort(byCodePoint);
  return Object.fromEntries(Object.entries({ ...rights, ...(graphReads === undefined ? {} : { graphReads }) })
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
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
