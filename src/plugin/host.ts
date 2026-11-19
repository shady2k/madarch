/**
 * The plugin host (decision 0035, items 5, 7 and 13): it starts one plugin as
 * a separate process in the sandbox, takes its introduction, hands it units,
 * and keeps it in bounds — a handshake deadline, a deadline per unit and per
 * run, a heartbeat deadline that a pause suspends, a bound on one message and
 * on a unit's whole answer, and the plugin's standard error kept as a bounded
 * log. Pause and resume freeze the whole tree; stop asks it to finish and
 * exits, and after a grace period becomes a cancel; a cancel kills the tree.
 *
 * Facts are admitted immediately through the trusted operation host. Each
 * operation is held against the plugin declaration and active unit. A unit
 * completion carries only its status and problems; it publishes no facts.
 * A failed or timed-out unit is recorded as not
 * extracted with its cause, never dropped silently, and every iteration and
 * every decision of the host leaves a span and a log line.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { snapshotTools, type TrustedTool } from './tools.js';
import { snapshotFilesystemInputs } from './filesystem-inputs.js';
import { PluginAgentBridge, type PluginAgentOptions, type PluginAgentReport } from './agent.js';
import { basename, join, resolve } from 'node:path';
import { Value } from 'typebox/value';
import { byCodePoint } from '../model/order.js';
import { log } from '../obs/log.js';
import { annotateSpan, withSpan, withSpanSync } from '../obs/trace.js';
import type { CgroupCounters } from './cgroup.js';
import { ClosureRefusal, closureOf, interpreterPinProblem, PLUGIN_MANIFEST_FILE, pluginReadsOf, pluginRightsOf, type Closure } from './closure.js';
import { PluginGraphOwnFactsRequest, type PluginGraphOwnFactsResult, graphReadsOf, PluginOutputPlan, PluginReadResult, PluginFileReadAsk, type PluginReadRequest, PluginFactsApplyRequest, PluginGraphFilesRequest, PluginAgentRunRequest, PluginGraphValueRequest, PluginUnitResult, PROTOCOL_VERSION, PluginGraphPageRequest, type PluginGraphRead, type PluginGraphRemovedEnd, type PluginGraphUnevidencedAssertion, type PluginIntroduce, type PluginProgress, type PluginUnitRequest, type PluginErrorReport, type PluginRights } from './protocol.js';
import { capabilityProblem, declarationOf, environmentOf, type PluginEnvironment } from './capabilities.js';
import { closureTrustProblem, snapshotClosure, type ClosureTrust } from './snapshot.js';
import { startPluginProcess, type SandboxProcess, type SandboxSpec, type StderrLog } from './sandbox.js';
import { errorReportOf, failureText, heartbeatOf, isNotification, isRequest, isResponse, lineReader, notificationText, progressOf, protocolMessageProblem, requestText, RPC_INVALID_PARAMS, RPC_INVALID_REQUEST, RPC_METHOD_NOT_FOUND, RPC_PARSE_ERROR, successText } from './wire.js';

/** Where a refusal stands. */
const WHERE = 'src/plugin/host.ts';

/** How long one blob read may take: a repository on the machine answers in milliseconds, and a hang must not hold a page. */
const READ_DEADLINE_MS = 20_000;

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
  /**
   * How long one unit of a plugin that declares an agent part may run (owner's decision, 2026-11-15): an agent explores
   * the graph through its tools and needs minutes, so its unit lives while it works — every ACP event and tool call is a
   * sign of life — and the run's token cap and this bound are what stop it. The product's manifest names the bound per
   * plugin (`plugins[].bounds.minutes`).
   */
  readonly agentUnitMs: number;
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

/** The defaults: a minute a unit (half an hour one with an agent part), half an hour a run, five seconds of silence, a megabyte a message and eight a unit. */
export const DEFAULT_HOST_LIMITS: HostLimits = {
  handshakeMs: 10_000,
  unitMs: 60_000,
  agentUnitMs: 30 * 60_000,
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
  /** A stable code: `handshake-timeout`, `unit-timeout`, `agent-timeout`, `heartbeat-missed`, `message-too-large`, `unit-output-too-large`, `plugin-error`, `plugin-exited`, `sandbox-unavailable`, `needs-approval`, `closure-changed`, `undeclared-kind` and the rest of `results.ts`'s refusals. */
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
  | (UnitTrace & { readonly state: 'extracted'; readonly unitId: string; readonly result: PluginUnitResult })
  | (UnitTrace & { readonly state: 'not-extracted'; readonly unitId: string; readonly cause: UnitCause });

/** The graph request methods the host answers, and the capability each one needs from the contract. */
type GraphMethod = 'graph.ownFacts' | 'graph.files' | 'graph.value' | 'graph.removedEnds' | 'graph.unevidenced';
const GRAPH_READ_OF: Readonly<Record<GraphMethod, PluginGraphRead>> = {
  'graph.ownFacts': 'ownFacts', 'graph.files': 'files', 'graph.value': 'value', 'graph.removedEnds': 'removedEnds', 'graph.unevidenced': 'unevidenced',
};

/**
 * The graph reads a plugin asks its host for (decision 0035, item 15): the file vertices a pattern names, and one field
 * of one vertex — a file's content, which the files producer stored by blob. The host answers from the graph and only
 * from it; a plugin that declared no `graph` right is refused, and a host given no answerer answers none.
 */
export interface GraphAnswerer {
  ownFacts?(query: PluginGraphOwnFactsRequest): Promise<PluginGraphOwnFactsResult>;
  files(pattern: string, snapshot?: import('../graph/plugin-turns.js').PluginSnapshot): Promise<readonly import('./protocol.js').PluginEntityRef[]>;
  value(kind: string, key: import('./protocol.js').PluginKeyValues, field: string, keyEdges?: Readonly<Record<string, import('./protocol.js').PluginEntityRef>>, snapshot?: import('../graph/plugin-turns.js').PluginSnapshot): Promise<unknown>;
  /** A page of the edges one of whose ends is removed (piece 2). Absent: refused. */
  removedEnds?(query: PluginGraphPageRequest): Promise<{ readonly edges: readonly PluginGraphRemovedEnd[]; readonly next?: string }>;
  /** A page of the active assertions of evidence-required fields that state none (piece 4). Absent: refused. */
  unevidenced?(query: PluginGraphPageRequest): Promise<{ readonly assertions: readonly PluginGraphUnevidencedAssertion[]; readonly next?: string }>;
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
  /** Trusted host binding. The producer names no source, principal or attempt. */
  readonly operations?: {
    apply(unitId: string, key: string, operation: PluginFactsApplyRequest['operation'], preconditions?: readonly { readonly uid: string; readonly recordedSequence: string }[], contractVersion?: string): Promise<unknown>;
  };
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
  /** This machine and its person chose to run plugins without isolation. */
  readonly unconfined?: boolean;
  readonly platform?: string;
  /** `journal.debug`: where the host records every request the plugin makes, refused and abandoned ones included. */
  readonly requests?: RequestLog;
  /**
   * The one reader of outside file bytes, when the caller has one (decision 0037, decision 0038): a fill role answers a
   * plugin's `file.read` and an agent's file read through it; left out, the host opens the git core plugin in the product's
   * folder, which is what a page's fill does.
   */
  readonly readBlob?: (ask: { readonly repository: string; readonly blob: string; readonly from?: number; readonly to?: number }) => Promise<{ readonly text: string; readonly lines: number; readonly bytes: number; readonly binary: boolean }>;
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
  /** One blob read, by the repository the sandbox binds and the blob id the graph holds (decision 0037). */
  readBlob(request: PluginReadRequest): Promise<PluginReadResult>;
  runUnit(unit: PluginUnitRequest): Promise<UnitOutcome>;
  agentReports(): ReadonlyMap<string, PluginAgentReport>;
  /** The plugin's standard error, kept as a bounded log in the session's work folder; its file is written when it is asked. */
  stderr(): StderrLog;
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
  readonly acceptsOperations: boolean;
  readonly startedAt: number;
  lastSign: number;
  pendingOperations: number;
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
  /** The plugin's own manifest, read with the closure: its tier, capabilities, tools and agent part. */
  private closureManifest: Closure['manifest'] | undefined;
  /** The environment the plugin's manifest declares and the host grants (decision 0038): nothing until a manifest names it. */
  private environment: PluginEnvironment = environmentOf({ tier: 'ordinary', capabilities: [] });
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
    withSpanSync('plugin.workspace', {}, () => mkdirSync(workFolder, { recursive: true }));
    const closure = await withSpan('plugin.closure', { 'madarch.plugin.folder': this.options.pluginFolder }, async () => {
      const read = this.options.closure ?? closureOf(this.options.pluginFolder);
      log.info('plugin closure hashed', { folder: read.folder, files: read.files.length, hash: read.hash });
      return read;
    });
    const pin = interpreterPinProblem(closure);
    if (pin !== undefined) throw pin;
    const trust = closureTrustProblem(closure, this.options.trust, join(closure.folder, 'plugin.json'), this.options.releaseHashes);
    if (trust !== undefined) throw trust;
    // The environment is the manifest's declaration (owner's decision, 2026-11-15; decision 0038): a core plugin is the
    // one gate to one outside source and the host mounts exactly that; an ordinary plugin holds no environment at all.
    const declaration = declarationOf(closure.manifest);
    const declarationProblem = capabilityProblem(declaration, closure.manifest.name);
    const manifestFile = join(closure.folder, PLUGIN_MANIFEST_FILE);
    if (declarationProblem !== undefined) throw new ClosureRefusal('plugin-capabilities', `${manifestFile}:1: ${declarationProblem}`, manifestFile);
    this.closureManifest = closure.manifest;
    this.environment = environmentOf(declaration);
    this.agentPart = closure.manifest.agent;
    if (this.agentPart !== undefined && !this.environment.agents) {
      throw new ClosureRefusal('plugin-capabilities', `${manifestFile}:1: the plugin "${closure.manifest.name}" declares an agent part and declares no "agents" capability: an agent is outside access, and the host runs one only for a plugin that declares it`, manifestFile);
    }
    if (!this.environment.repository && (closure.manifest.tools ?? []).length > 0) {
      throw new ClosureRefusal('plugin-capabilities', `${manifestFile}:1: the ${this.environment.tier} plugin "${closure.manifest.name}" names the tool ${JSON.stringify(closure.manifest.tools![0]!.name)}: a tool runs in a core plugin's environment, and no other plugin has one`, manifestFile);
    }
    // The rights are the contract's, read before the process starts: the protocol's own (the graph, the network profile).
    this.contractRights = pluginRightsOf(closure);
    this.contractReads = pluginReadsOf(closure);
    if (this.contractRights?.filesystem === true && !this.environment.repository) {
      throw new ClosureRefusal('plugin-capabilities', `${manifestFile}:1: the plugin "${closure.manifest.name}" declares the filesystem right in its contract and declares no source in its manifest: its tier "${this.environment.tier}" grants no environment, so the contract's right is the one a plugin of the other tier holds`, manifestFile);
    }
    const snapshot = await withSpan('plugin.snapshot', { 'madarch.plugin.hash': closure.hash }, async () => {
      const copy = await snapshotClosure(closure, this.options.workRoot);
      log.info('plugin closure copied', { folder: copy.folder, hash: copy.hash });
      return copy;
    });
    this.snapshot = snapshot;
    if (this.agentPart !== undefined) {
      const prompt = this.agentPart.prompt;
      if (prompt.startsWith('/') || prompt.split('/').some((part) => part === '..' || part === '.' || part === '') || prompt.includes('\\')) throw new ClosureRefusal('agent-prompt', `${WHERE}:1: agent.prompt must name a file inside the closure`, join(this.options.pluginFolder, 'plugin.json'));
      try { this.agentPrompt = withSpanSync('plugin.agent.prompt', {}, () => readFileSync(join(snapshot.folder, prompt), 'utf8')); }
      catch (error) { throw new ClosureRefusal('agent-prompt', `${WHERE}:1: cannot read agent prompt ${join(snapshot.folder, prompt)}: ${(error as Error).message}`, join(this.options.pluginFolder, 'plugin.json')); }
    }
    const platform = this.options.platform ?? `${process.platform}-${process.arch}`;
    // Only a core plugin that owns git's store or the working tree sees a repository: the glossary reads the graph, and
    // the two gates to the repository and the tree read the source (decision 0035, item 9; decision 0038).
    const readsRepository = this.environment.repository;
    const tools = snapshotTools(closure.manifest.tools, this.options.tools ?? {}, workFolder, this.options.env ?? process.env);
    if ((this.options.filesystemInputs?.length ?? 0) > 0 && !readsRepository) throw new ClosureRefusal('plugin-filesystem', `${WHERE}:1: filesystem inputs require the declared filesystem right`, WHERE);
    const spec: SandboxSpec = {
      closureFolder: snapshot.folder,
      tools,
      filesystemInputs: withSpanSync('plugin.filesystem-inputs', { 'madarch.plugin.hash': closure.hash }, () => snapshotFilesystemInputs(this.options.filesystemInputs ?? [], this.options.workRoot)),
      ...(readsRepository && (this.options.filesystemInputs?.length ?? 0) === 0 ? { repository: this.options.repository } : {}),
      // An ordinary plugin holds no environment: its sandbox root is empty, and the host's file system is not there for
      // it (decision 0038). A core plugin is trusted and reads its one source.
      emptyRoot: !this.environment.repository,
      workFolder,
      runtime: process.execPath,
      entry: closure.manifest.entry,
      limits: { memoryBytes: limits.memoryBytes, cpuQuotaMicros: limits.cpuQuotaMicros, cpuPeriodMicros: limits.cpuPeriodMicros, pids: limits.pids },
      ...(this.options.cgroupParent === undefined ? {} : { cgroupParent: this.options.cgroupParent }),
      ...(this.options.unconfined === true ? { unconfined: true } : {}),
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
      readBlob: async (request) => await this.readBlob(request),
      runUnit: async (unit) => await this.runUnit(unit),
      agentReports: () => new Map(this.reports),
      stderr: () => this.sandbox?.stderr() ?? { file: '', totalBytes: 0, truncated: false },
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

  private async answerOperation(id: string | number, params: unknown): Promise<{ outcome: 'answered' | 'refused' | 'failed'; size: number; cause?: string }> {
    return await withSpan('plugin.operation.apply', {}, async () => {
      if (!Value.Check(PluginFactsApplyRequest, params)) {
        this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:437: facts.apply requires unitId, nonempty key and operation`));
        return { outcome: 'refused', size: 0, cause: 'malformed-operation' };
      }
      const request = params as PluginFactsApplyRequest;
      if (this.inFlight.get(request.unitId)?.acceptsOperations !== true || this.options.operations === undefined) {
        this.write(failureText(id, RPC_INVALID_REQUEST, `${WHERE}:441: facts.apply requires an active unit and a trusted operation host`));
        return { outcome: 'refused', size: 0, cause: 'operation-not-bound' };
      }
      if (this.closureManifest?.readOnly === true) {
        this.write(failureText(id, RPC_INVALID_REQUEST, `${WHERE}:1: read-only plugin cannot apply graph operations`));
        return { outcome: 'refused', size: 0, cause: 'writer-denied' };
      }
      try {
        const answer = await this.options.operations.apply(request.unitId, request.key, request.operation, request.preconditions, request.contractVersion);
        const size = Buffer.byteLength(JSON.stringify(answer));
        this.write(successText(id, answer));
        return { outcome: 'answered', size };
      } catch (error) {
        this.write(failureText(id, RPC_INVALID_REQUEST, `${WHERE}:451: operation refused: ${error instanceof Error ? error.message : String(error)}`));
        return { outcome: 'failed', size: 0, cause: 'operation-failed' };
      }
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
      if (value.method === 'facts.apply') {
        const slot = log?.begin(value.method);
        const held = this.inFlight.get((value.params as { unitId: string }).unitId);
        if (held !== undefined) this.countBytes(held, bytes);
        if (this.failure !== undefined) {
          log?.settle(slot, 'refused', 0, 'unit-output-too-large');
          return;
        }
        if (held !== undefined) held.pendingOperations += 1;
        void this.answerOperation(value.id, value.params).then((answer) => log?.settle(slot, answer.outcome, answer.size, answer.cause)).finally(() => {
          if (held === undefined) return;
          // The host has answered the operation: the unit's silence is measured from here, not from before the wait.
          held.lastSign = Date.now();
          held.pendingOperations = Math.max(0, held.pendingOperations - 1);
        });
        return;
      }
      if (value.method === 'agent.run') {
        const slot = log?.begin(value.method);
        void this.answerAgent(value.id, value.params).then((answer) => log?.settle(slot, answer.outcome, answer.size, answer.cause));
        return;
      }
      if (value.method === 'graph.ownFacts' || value.method === 'graph.files' || value.method === 'graph.value' || value.method === 'graph.removedEnds' || value.method === 'graph.unevidenced') {
        const slot = log?.begin(value.method);
        void this.answerGraph(value.id, value.method, value.params).then((answer) => log?.settle(slot, answer.outcome, answer.size, answer.cause));
        return;
      }
      if (value.method === 'file.read') {
        const slot = log?.begin(value.method);
        void this.answerFileRead(value.id, value.params).then((answer) => log?.settle(slot, answer.outcome, answer.size, answer.cause));
        return;
      }
      const slot = log?.begin(String(value.method));
      this.write(failureText(value.id, RPC_METHOD_NOT_FOUND, `${WHERE}:1: the host knows no plugin request "${value.method}"; its requests are introduce, facts.apply, graph.files, graph.value, graph.removedEnds, graph.unevidenced, agent.run and file.read`));
      log?.settle(slot, 'refused', 0, 'method-not-found');
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

  /**
   * One file read a plugin asks of the host (owner's decision, 2026-11-15; decision 0038): an ordinary plugin holds no
   * environment, so the text it reads is asked for here and routed to the core plugin that owns git's object store —
   * the same read the page and the agent make (decision 0037). A plugin that declares no "repository" capability is
   * refused, naming the plugin and the access.
   */
  private async answerFileRead(id: number | string, params: unknown): Promise<{ outcome: 'answered' | 'refused' | 'failed'; size: number; cause?: string }> {
    const name = this.declared?.name ?? this.closureManifest?.name ?? 'unknown';
    if (!this.accessesRepository()) {
      this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: the plugin ${JSON.stringify(name)} declares neither the "repository" capability nor a tier that grants one, so it asks the host for no file text: declare "repository" in its capabilities, and the host routes the read to the plugin that owns git`, { cause: 'read-denied' }));
      return { outcome: 'refused', size: 0, cause: 'read-denied' };
    }
    if (!Value.Check(PluginFileReadAsk, params)) {
      const first = [...Value.Errors(PluginFileReadAsk, params)][0];
      this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: file.read takes { repository, blob, from?, to? }, and was given ${first === undefined ? 'another shape' : first.message}`, { cause: 'read-invalid' }));
      return { outcome: 'refused', size: 0, cause: 'read-invalid' };
    }
    try {
      // Its own environment reads git directly; an ordinary plugin's read is routed to the core plugin that owns it. The
      // read is bounded in bytes, so a range past the bound is asked again from where it continued: the plugin's answer
      // is the whole range it asked for, and no part of it is dropped (the owner's review of madarch-u3vw.16).
      let text = '';
      let lines = 0;
      let bytes = 0;
      let binary = false;
      let from = params.from;
      let fromColumn: number | undefined;
      for (let step = 0; ; step += 1) {
        if (step >= 1_000) throw new Error(`${WHERE}:1: the read of blob ${JSON.stringify(params.blob)} of ${JSON.stringify(params.repository)} for the plugin ${JSON.stringify(name)} did not reach its end in 1000 bounded reads`);
        const read = await this.readBlobThroughCore({ repository: params.repository, blob: params.blob, ...(from === undefined ? {} : { from }), ...(fromColumn === undefined ? {} : { fromColumn }), ...(params.to === undefined ? {} : { to: params.to }) });
        text += read.text;
        lines = read.lines;
        bytes = read.bytes;
        binary = read.binary;
        const next = read.next ?? null;
        if (read.complete !== false || next === null) break;
        from = next.line;
        fromColumn = next.column === 1 ? undefined : next.column;
      }
      this.write(successText(id, { text, lines, bytes, binary }));
      return { outcome: 'answered', size: text.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: the read of blob ${JSON.stringify(params.blob)} of ${JSON.stringify(params.repository)} for the plugin ${JSON.stringify(name)} failed: ${message}`, { cause: 'read-failed' }));
      return { outcome: 'failed', size: 0, cause: 'read-failed' };
    }
  }

  /**
   * One blob, through the one gate that owns git's object store (decision 0038): the caller's own reader when it gave
   * one (a fill's host), else the git core plugin opened over the product's `repos/` — the same read a page and an agent
   * make (decision 0037). There is no second path to the bytes.
   */
  private async readBlobThroughCore(ask: { readonly repository: string; readonly blob: string; readonly from?: number; readonly fromColumn?: number; readonly to?: number }): Promise<PluginReadResult & { readonly complete?: boolean; readonly next?: { readonly line: number; readonly column: number } | null }> {
    if (this.options.readBlob !== undefined) return await this.options.readBlob(ask);
    const { readBlobThroughPlugin } = await import('./file-reads.js');
    // A connected repository lies under the product's repos/; the product's own repository is the product's folder.
    const connected = join(this.options.repository, 'repos', ask.repository);
    const root = existsSync(connected) || ask.repository !== basename(resolve(this.options.repository)) ? connected : this.options.repository;
    return await readBlobThroughPlugin({
      product: this.options.repository,
      plugin: join('plugins', 'git'),
      repository: ask.repository,
      root,
      blob: ask.blob,
      ...(ask.from === undefined ? {} : { from: ask.from }),
      ...(ask.fromColumn === undefined ? {} : { fromColumn: ask.fromColumn }),
      ...(ask.to === undefined ? {} : { to: ask.to }),
    });
  }

  /** Whether the plugin's declaration lets it ask for outside data at all: a source it owns, or one it asks the host for. */
  private accessesRepository(): boolean {
    if (this.environment.repository) return true;
    const declaration = declarationOf(this.closureManifest ?? {});
    return declaration.capabilities.includes('git');
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
      if (method === 'graph.ownFacts') {
        if (!Value.Check(PluginGraphOwnFactsRequest, params) || !this.inFlight.has(params.unitId)) {
          this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: graph.ownFacts requires {unitId,scope} naming an active unit`, { cause: 'graph-invalid' }));
          return { outcome: 'refused', size: 0, cause: 'graph-invalid' };
        }
        if (this.options.graph.ownFacts === undefined) return this.graphUnavailable(id, method);
        const answer = await this.options.graph.ownFacts(params);
        this.write(successText(id, answer));
        return { outcome: 'answered', size: answer.vertices.length + answer.edges.length };
      }
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
        const value = await this.options.graph.value(params.kind, params.key, params.field, params.keyEdges);
        this.write(successText(id, { value }));
        return { outcome: 'answered', size: typeof value === 'string' ? value.length : 0 };
      }
      // The three consistency reads take a page request and answer one page each.
      if (!Value.Check(PluginGraphPageRequest, params)) {
        const first = [...Value.Errors(PluginGraphPageRequest, params)][0];
        this.write(failureText(id, RPC_INVALID_PARAMS, `${WHERE}:1: ${method} takes { after?, limit? }, and was given ${first === undefined ? 'another shape' : first.message}`, { cause: 'graph-invalid' }));
        return { outcome: 'refused', size: 0, cause: 'graph-invalid' };
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
      return { outcome: 'answered', size: answer.assertions.length };
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
      // Every ACP event and every file the agent reads is a sign of life for its unit (owner's decision, 2026-11-15):
      // an agent thinks for minutes without answering, and the heartbeat deadline must not read that as silence.
      this.agentBridge = new PluginAgentBridge({ ...this.agentPart, prompt: this.agentPrompt! }, { ...this.options.agent, onActivity: (unitId: string) => this.sign(unitId, 0), onSession: (report) => {
        this.reports.set(report.unitId, report);
        this.options.agent?.onSession?.(report);
      }, readFile: async (request) => {
        // The agent's file reads go through the one blob read (decision 0037, decision 0038): the blob the graph names,
        // and the gate that owns git's store — never a working copy.
        const read = await this.readBlobThroughCore({
          repository: request.repository,
          blob: request.blob,
          ...(request.from === undefined ? {} : { from: request.from }),
          ...(request.limit === undefined ? {} : { to: request.from === undefined ? request.limit : request.from + request.limit - 1 }),
        });
        // A text cut at the read's byte bound says so, and where it continues: nothing an agent reads is dropped in
        // silence (the owner's review of madarch-u3vw.16).
        const next = read.next ?? null;
        return read.complete === false && next !== null
          ? `${read.text}\n[the read was cut at its byte bound; it continues at line ${String(next.line)}, column ${String(next.column)}]`
          : read.text;
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
    if (now - this.runStartedAt >= this.runBound()) {
      this.fail({ code: 'run-timeout', message: `${WHERE}:1: the run passed its ${String(this.runBound())} ms deadline: the units not answered are recorded as not extracted, and the tree is killed` });
      return;
    }
    // A plugin with an agent part runs its units under the agent bound (owner's decision, 2026-11-15): the agent explores
    // the graph through its tools, its ACP events keep the unit's silence fresh, and only its own bound or the run's token
    // cap stops it. Every other plugin keeps the minute a unit may take.
    const agentUnit = this.agentPart !== undefined;
    const unitBound = agentUnit ? this.limits.agentUnitMs : this.limits.unitMs;
    for (const held of this.inFlight.values()) {
      if (now - held.startedAt >= unitBound) {
        const code = agentUnit ? 'agent-timeout' : 'unit-timeout';
        const bound = agentUnit ? 'agent bound (the plugin declares an agent part; plugins[].bounds.minutes sets it)' : 'deadline';
        held.settle(this.notExtracted(held, { code, message: `${WHERE}:1: unit ${held.unitId} passed its ${String(unitBound)} ms ${bound}: it was recorded as not extracted, and the plugin stopped` }));
        this.fail({ code, message: `${WHERE}:1: unit ${held.unitId} passed its ${String(unitBound)} ms ${bound}: the plugin was stopped` });
        return;
      }
      if (!this.paused && held.pendingOperations === 0 && now - held.lastSign >= this.limits.heartbeatMs) {
        held.settle(this.notExtracted(held, { code: 'heartbeat-missed', message: `${WHERE}:1: unit ${held.unitId} heard nothing from the plugin for ${String(now - held.lastSign)} ms, more than the ${String(this.limits.heartbeatMs)} ms it may stay silent: it was recorded as not extracted, and the plugin stopped` }));
        this.fail({ code: 'heartbeat-missed', message: `${WHERE}:1: the plugin stopped sending heartbeats while unit ${held.unitId} ran (${String(now - held.lastSign)} ms of silence): the plugin was stopped` });
        return;
      }
    }
  }

  /**
   * The run's own deadline: its limit, and never shorter than the agent unit it must outlive — a run that stopped before
   * its agent part's bound would answer with the wrong reason (owner's decision, 2026-11-15).
   */
  private runBound(): number {
    return this.agentPart === undefined ? this.limits.runMs : Math.max(this.limits.runMs, this.limits.agentUnitMs + 60_000);
  }

  /** The outcome of a unit that did not extract, with the numbers read at this moment. */
  private notExtracted(held: InFlight, cause: UnitCause): UnitOutcome {
    let counters: CgroupCounters = { memoryPeakBytes: 0, oomKills: 0, pidsMaxHits: 0, cpuMicros: 0, pidsCurrent: 0 };
    let stderr: StderrLog = { file: '', totalBytes: 0, truncated: false };
    // Diagnostics must not prevent settling a unit or stopping its process tree.
    try {
      counters = this.sandbox?.counters() ?? counters;
    } catch (error) {
      log.warn(`${WHERE}:1: could not collect plugin counters: ${String(error)}`, {});
    }
    try {
      stderr = this.sandbox?.stderr() ?? stderr;
    } catch (error) {
      log.warn(`${WHERE}:1: could not collect plugin stderr: ${String(error)}`, {});
    }
    return {
      state: 'not-extracted',
      unitId: held.unitId,
      cause,
      bytes: held.bytes,
      durationMs: Date.now() - held.startedAt,
      counters,
      stderr,
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
      const held: InFlight = { unitId: unit.unitId, acceptsOperations: true, startedAt: now, lastSign: now, pendingOperations: 0, bytes: 0, progress: [], error: undefined, settle };
      this.inFlight.set(unit.unitId, held);
      const answer = new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
      });
      this.write(requestText(id, 'unit', { unit }));
      const outcome = await Promise.race([
        answer.then((result) => this.acceptAnswer(unit, held, result)).catch((cause: UnitCause) => this.notExtracted(held, cause)),
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
      annotateSpan({ 'madarch.plugin.outcome': outcome.state, 'madarch.plugin.bytes': outcome.bytes, 'madarch.plugin.ms': outcome.durationMs });
      if (outcome.state === 'not-extracted') {
        log.warn(`unit not extracted: ${outcome.cause.message}`, { unitId: unit.unitId, code: outcome.cause.code });
        span.setStatus({ code: 2, message: outcome.cause.code });
      } else {
        log.info('unit extracted', { unitId: unit.unitId, bytes: outcome.bytes, ms: outcome.durationMs });
      }
      return outcome;
    });
  }

  /** Holds one unit's answer to the declaration, and records a refusal as the unit's cause. */
  /**
   * One blob read the host asks of the plugin (decision 0037): the plugin reads its own repository copy with its own
   * code, and the host bounds the wait. A plugin that declared no read answers by name.
   */
  private async readBlob(request: PluginReadRequest): Promise<PluginReadResult> {
    if (!this.environment.repository) {
      throw { code: 'read-unsupported', message: `${WHERE}:1: the plugin ${JSON.stringify(this.declared?.name ?? 'unknown')} declares the tier "${this.environment.tier}" and no source, and a blob is read by a core plugin that owns the repository: declare "repository" as the one capability of a core plugin` };
    }
    if (this.declared?.read !== true) throw { code: 'read-unsupported', message: `${WHERE}:1: the plugin ${this.declared?.name ?? 'unknown'} declares no read, and a blob is read through the plugin that holds the repository` };
    if (this.failure !== undefined) throw this.failure.cause;
    if (this.sandbox === undefined) throw { code: 'plugin-exited', message: `${WHERE}:1: the plugin's process is gone, so it cannot read a blob` };
    const id = `read-${String(this.nextId++)}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject({ code: 'read-timeout', message: `${WHERE}:1: the plugin answered no read of ${request.blob} within ${String(READ_DEADLINE_MS)} ms` }), READ_DEADLINE_MS);
    });
    const response = new Promise<unknown>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    this.write(requestText(id, 'read', { ...request }));
    try {
      const value = await Promise.race([response, deadline]);
      const [error] = Value.Errors(PluginReadResult, value);
      if (error !== undefined) throw { code: 'malformed-read', message: `${WHERE}:1: a read answers text, lines, bytes and binary: ${error.message}` };
      return value as PluginReadResult;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  private async planOutput(unit: PluginUnitRequest, cursor?: string): Promise<PluginOutputPlan> {
    if (this.declared?.planOutput !== true) throw { code: 'plan-unsupported', message: `${WHERE}:1: plugin does not declare planOutput` };
    if (this.failure !== undefined) throw this.failure.cause;
    if (this.inFlight.has(unit.unitId)) throw { code: 'plan-busy', message: `${WHERE}:1: a unit with this id is already active` };
    const id = `plan-${String(this.nextId++)}`;
    const now = Date.now();
    let failed!: (cause: UnitCause) => void;
    const failure = new Promise<never>((_resolve, reject) => { failed = reject; });
    const held: InFlight = { unitId: unit.unitId, acceptsOperations: false, startedAt: now, lastSign: now, pendingOperations: 0, bytes: 0, progress: [], error: undefined, settle: (outcome) => { if (outcome.state === 'not-extracted') failed(outcome.cause); } };
    this.inFlight.set(unit.unitId, held);
    this.unitByRequest.set(id, unit.unitId);
    const response = new Promise<unknown>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    this.write(requestText(id, 'planOutput', { unit, ...(cursor === undefined ? {} : { cursor }) }));
    try {
      const value = await Promise.race([response, failure]) as { unitId: string; partitions?: unknown; next?: unknown };
      const { unitId: _unitId, ...page } = value;
      if (!Value.Check(PluginOutputPlan, page)) throw { code: 'malformed-plan', message: `${WHERE}:1: planOutput must return bounded partitions and an optional next cursor` };
      return page;
    } finally {
      this.inFlight.delete(unit.unitId);
      this.pending.delete(id);
      this.unitByRequest.delete(id);
    }
  }

  private acceptAnswer(unit: PluginUnitRequest, held: InFlight, result: unknown): UnitOutcome {
    if (held.pendingOperations !== 0) return this.notExtracted(held, { code: 'operation-pending', message: `${WHERE}:1: unit completion cannot precede its facts.apply responses` });
    const answer = result as { unitId?: unknown } | undefined;
    if (answer === null || typeof answer !== 'object' || answer.unitId !== unit.unitId) {
      return this.notExtracted(held, { code: 'malformed-result', message: `${WHERE}:1: unit ${unit.unitId} was answered with ${answer === undefined ? 'no result' : `a result for ${String((answer as { unitId?: unknown }).unitId)}`}: an answer names the unit it answers` });
    }
    const shape = [...Value.Errors(PluginUnitResult, answer)][0];
    if (shape !== undefined) {
      return this.notExtracted(held, { code: 'malformed-result', message: `${WHERE}:1: the answer to unit ${unit.unitId} is not a unit result: ${shape.instancePath === '' ? 'the result' : shape.instancePath.slice(1)} ${shape.message}` });
    }
    return {
      state: 'extracted',
      unitId: unit.unitId,
      result: answer as PluginUnitResult,
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
      const cause: UnitCause = { code: 'session-cancelled', message: `${WHERE}:1: the session was cancelled while this unit was in flight: it was recorded as not extracted` };
      for (const held of this.inFlight.values()) {
        held.pendingOperations = 0;
        held.settle(this.notExtracted(held, cause));
      }
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
