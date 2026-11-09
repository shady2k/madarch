/**
 * The TypeScript SDK of a madarch extraction plugin (decision 0035, item 8):
 * the protocol, the heartbeat, cancellation and batching, so the author
 * writes one function — `extract(unit, context)` — and nothing of the wire.
 *
 * A plugin's `main.ts` is:
 *
 *     import { definePlugin } from 'madarch-plugin-sdk';
 *
 *     await definePlugin({
 *       contract: { vertices: [{ kind: 'file', key: ['path'], fields: [{ name: 'size', claim: 'authoritative' }] }], edges: [] },
 *       extract(unit) {
 *         return { vertices: [{ kind: 'file', key: unit.key, attributes: { size: 12 } }], end: { state: 'complete' } };
 *       },
 *     });
 *
 * The function is called for every unit the host hands over, as many at once as
 * the contract's `limits.maxParallelUnits` allows; throwing is answered to the
 * host as that unit's failure with the error's message, and the returning of a
 * value is answered as its result. Nothing else is the author's to write: the
 * introduction, the heartbeats, the answers to pause, resume, stop and cancel
 * and the exit are the SDK's.
 */

/** The protocol version this SDK speaks. */
export const PROTOCOL_VERSION = 'madarch.plugins/1';

/** One entity named by its kind and key values. */
export interface EntityRef {
  readonly kind: string;
  readonly key: Readonly<Record<string, string | number>>;
}

/** Where one value was read. */
export interface Evidence {
  readonly repository?: string;
  readonly commitOrDigest?: string;
  readonly path?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

/** One claim of a claimed field. */
export interface Claim {
  readonly field: string;
  readonly value: unknown;
  readonly evidence?: Evidence;
}

/** One vertex a unit produced. */
export interface VertexResult {
  readonly kind: string;
  readonly key: Readonly<Record<string, string | number>>;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly claims?: readonly Claim[];
}

/** One edge a unit produced. */
export interface EdgeResult {
  readonly kind: string;
  readonly from: EntityRef;
  readonly to: EntityRef;
  readonly discriminator?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly claims?: readonly Claim[];
  readonly evidence?: Evidence;
}

/** How one unit ended. */
export type UnitEnd = { readonly state: 'complete' } | { readonly state: 'partial'; readonly cause: string };

/** One unit's answer. */
export interface UnitResult {
  readonly vertices?: readonly VertexResult[];
  readonly edges?: readonly EdgeResult[];
  readonly removals?: readonly EntityRef[];
  readonly end: UnitEnd;
}

/** The unit the host hands a plugin. */
export interface Unit {
  readonly unitId: string;
  readonly kind: string;
  readonly key: Readonly<Record<string, string | number>>;
  readonly inputs?: unknown;
}

/** What `extract` is handed beside the unit: the way back to the host while it works. */
export interface ExtractContext {
  /** Set when the host asked the plugin to stop: a long read should give up at the next check. */
  readonly signal: AbortSignal;
  /** Says the plugin is alive while a long unit runs; the SDK sends one on a timer as well. */
  heartbeat(): void;
  /** Where the unit stands, in counts of what it reads. */
  progress(done: number, total?: number, note?: string): void;
}

/** One field of a declared kind. */
export interface FieldDeclaration {
  readonly name: string;
  readonly claim: 'authoritative' | 'claimed';
}

/** One vertex kind a plugin declares it produces. */
export interface VertexKindDeclaration {
  readonly kind: string;
  readonly key: readonly string[];
  readonly fields?: readonly FieldDeclaration[];
}

/** One edge kind a plugin declares it produces. */
export interface EdgeKindDeclaration {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
  readonly fields?: readonly FieldDeclaration[];
}

/** The outputs a plugin declares: every kind, key field and edge kind a result may name. */
export interface ContractDeclaration {
  readonly vertices: readonly VertexKindDeclaration[];
  readonly edges: readonly EdgeKindDeclaration[];
}

/** What defining a plugin takes: its contract and the one function the author writes. */
export interface PluginDefinition {
  readonly name: string;
  readonly version: string;
  readonly contract: ContractDeclaration;
  /** How many units the plugin takes at once; absent, one. */
  readonly maxParallelUnits?: number;
  /** How much one unit's answer may weigh; absent, the host's own bound. */
  readonly maxOutputBytes?: number;
  /** How often the SDK tells the host it is alive while a unit runs, in milliseconds; 250 unless named. */
  readonly heartbeatMs?: number;
  /** The one function the author writes: the unit in, its answer out. */
  readonly extract: (unit: Unit, context: ExtractContext) => Promise<UnitResult> | UnitResult;
}

/** The JSON-RPC id a message answers or asks by. */
type RpcId = string | number;

/** One incoming message, as the SDK reads it. */
interface Incoming {
  readonly jsonrpc?: string;
  readonly id?: RpcId;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: { cause?: string; unitId?: string } };
}

const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_PLUGIN_ERROR = -32000;

/** Writes one message to standard output: one line, flushed by the stream itself. */
function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Reads standard input one line at a time, calling `onMessage` for each whole message. */
function readLines(onMessage: (message: Incoming) => void, onEnd: () => void): void {
  let held = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    held += chunk;
    let newline = held.indexOf('\n');
    while (newline !== -1) {
      const line = held.slice(0, newline);
      held = held.slice(newline + 1);
      if (line.trim() !== '') {
        try {
          onMessage(JSON.parse(line) as Incoming);
        } catch {
          // A line the host wrote and this plugin cannot read is the host's protocol failure, not a unit's: the
          // next heartbeat tells the host the plugin is alive, and the host answers the malformed exchange itself.
        }
      }
      newline = held.indexOf('\n');
    }
  });
  process.stdin.on('end', onEnd);
}

/** Positions the plugin's promises on the event loop, so a unit's failure is answered rather than thrown. */
function answer(id: RpcId, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

/** Answers a request with a failure carrying the cause. */
function refuse(id: RpcId | undefined, code: number, message: string, cause?: string, unitId?: string): void {
  const data = cause === undefined && unitId === undefined ? undefined : { ...(cause === undefined ? {} : { cause }), ...(unitId === undefined ? {} : { unitId }) };
  send({ jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } });
}

/**
 * Defines the plugin and runs its loop: it introduces itself, takes units,
 * sends heartbeats, answers pause, resume and stop, and exits when the host
 * cancels it or its standard input closes. The promise settles when the
 * process should end.
 */
export async function definePlugin(definition: PluginDefinition): Promise<void> {
  const heartbeatMs = definition.heartbeatMs ?? 250;
  const running = new Map<RpcId, AbortController>();
  let paused = false;
  let stopping = false;

  const heartbeat = (): void => {
    const unitIds = [...running.values()].map((controller) => (controller as AbortController & { unitId?: string }).unitId).filter((unitId): unitId is string => unitId !== undefined);
    send(unitIds.length === 0 ? { jsonrpc: '2.0', method: 'heartbeat' } : { jsonrpc: '2.0', method: 'heartbeat', params: { unitId: unitIds[0] } });
  };
  const timer = setInterval(() => { if (!paused && !stopping) heartbeat(); }, heartbeatMs);

  const finish = (): never => {
    clearInterval(timer);
    process.exit(0);
  };

  const takeUnit = (id: RpcId, params: Record<string, unknown> | undefined): void => {
    const unit = params?.['unit'] as Unit | undefined;
    if (unit === undefined || typeof unit.unitId !== 'string' || typeof unit.kind !== 'string' || typeof unit.key !== 'object' || unit.key === null) {
      refuse(id, RPC_INVALID_PARAMS, 'a unit stands under params.unit, with a unitId, a kind and a key');
      return;
    }
    const controller = new AbortController();
    (controller as AbortController & { unitId?: string }).unitId = unit.unitId;
    running.set(id, controller);
    void (async () => {
      try {
        const result = await definition.extract(unit, {
          signal: controller.signal,
          heartbeat,
          progress: (done, total, note) => send({ jsonrpc: '2.0', method: 'progress', params: { unitId: unit.unitId, done, ...(total === undefined ? {} : { total }), ...(note === undefined ? {} : { note }) } }),
        });
        if (!running.has(id)) return;
        const answerWith = { unitId: unit.unitId, ...result };
        answer(id, answerWith);
      } catch (error) {
        if (!running.has(id)) return;
        const failed = error as Error & { cause?: string; file?: string; line?: number };
        refuse(id, RPC_PLUGIN_ERROR, failed.message ?? String(error), failed.cause ?? 'extract-failed', unit.unitId);
      } finally {
        running.delete(id);
        if (stopping && running.size === 0) finish();
      }
    })();
  };

  readLines((message) => {
    if (message.method !== undefined && message.id !== undefined) {
      if (message.method === 'unit') {
        if (stopping) refuse(message.id, RPC_PLUGIN_ERROR, 'the plugin is stopping and takes no unit', 'stopping');
        else takeUnit(message.id, message.params);
        return;
      }
      if (message.method === 'pause') { paused = true; answer(message.id, { paused: true }); return; }
      if (message.method === 'resume') { paused = false; answer(message.id, { paused: false }); return; }
      if (message.method === 'stop') {
        stopping = true;
        for (const controller of running.values()) controller.abort();
        answer(message.id, { stopping: true, units: running.size });
        if (running.size === 0) finish();
        return;
      }
      refuse(message.id, RPC_METHOD_NOT_FOUND, `the plugin knows introduce, unit, pause, resume and stop, and not "${message.method}"`);
      return;
    }
    if (message.method === 'cancel') {
      for (const controller of running.values()) controller.abort();
      finish();
      return;
    }
    // The host's answer to the introduction: nothing to do, the loop is already taking units.
  }, () => finish());

  const introduce = {
    jsonrpc: '2.0',
    id: 'introduce',
    method: 'introduce',
    params: {
      protocol: PROTOCOL_VERSION,
      name: definition.name,
      version: definition.version,
      rights: { network: 'none' },
      limits: {
        ...(definition.maxParallelUnits === undefined ? {} : { maxParallelUnits: definition.maxParallelUnits }),
        ...(definition.maxOutputBytes === undefined ? {} : { maxOutputBytes: definition.maxOutputBytes }),
      },
      outputs: definition.contract,
    },
  };
  send(introduce);
  // The promise settles when the process is over: the loop above exits the process, and this keeps the module alive
  // until then without a busy wait.
  await new Promise<void>((done) => { process.on('exit', () => done()); });
}
