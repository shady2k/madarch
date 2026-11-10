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
 *       contract: { vertices: [{ kind: 'file', key: ['path'], fields: [{ name: 'path', claim: 'authoritative', type: 'text', meaning: 'the path', example: 'a.ts', required: true }, { name: 'size', claim: 'authoritative', type: 'integer', meaning: 'its size', example: 12, required: false }] }], edges: [] },
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

/** One vertex the host answers a graph query with: its kind and key values. */
export interface GraphVertex {
  readonly kind: string;
  readonly key: Readonly<Record<string, string | number>>;
}

/** The graph reads a plugin declares and asks for (decision 0035, item 15): files by pattern, and a vertex's field. */
export interface GraphReads {
  /** The file vertices whose path matches the pattern (a glossary document in any folder, say), in code point order. */
  files(pattern: string): Promise<GraphVertex[]>;
  /** One field of one vertex: a file's content, as the files producer stored it, never a folder of the product. */
  value<T = unknown>(kind: string, key: Readonly<Record<string, string | number>>, field: string): Promise<T>;
}

/** What `extract` is handed beside the unit: the way back to the host while it works. */
export interface ExtractContext {
  /** Set when the host asked the plugin to stop: a long read should give up at the next check. */
  readonly signal: AbortSignal;
  /** Says the plugin is alive while a long unit runs; the SDK sends one on a timer as well. */
  heartbeat(): void;
  /** Where the unit stands, in counts of what it reads. */
  progress(done: number, total?: number, note?: string): void;
  /** The graph the plugin asked the host for; a query of a plugin that declared no `graph` right is refused. */
  readonly graph: GraphReads;
}

/** One field of a declared kind (decision 0035, item 18): its type, meaning, an example and whether it is required. */
export interface FieldDeclaration {
  readonly name: string;
  readonly claim: 'authoritative' | 'claimed';
  readonly type: 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json';
  /** What the field is, in plain words, for the person binding it in the product's manifest. */
  readonly meaning: string;
  /** One value the field holds. */
  readonly example: unknown;
  /** Whether the plugin cannot run without it: its kind's key and every field its reading needs. */
  readonly required: boolean;
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
  /** The repository snapshot at /repo this plugin reads; absent, it sees no repository, as the glossary does. */
  readonly filesystem?: boolean;
  /** Whether the plugin asks the host for graph reads (`context.graph`); absent, it may not. */
  readonly graph?: boolean;
  /** The one function the author writes: the unit in, its answer out. */
  readonly extract: (unit: Unit, context: ExtractContext) => Promise<UnitResult> | UnitResult;
}

/** The JSON-RPC id a message answers or asks by. */
type RpcId = string | number;

/** The requests this plugin asked the host and has not been answered for, by their id. */
const pendingOfHost = new Map<RpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let askedHost = 0;

/** One question to the host over the protocol: its answer, or the failure the host named. */
function askHost<T>(method: string, params: unknown): Promise<T> {
  const id = `plugin-${String((askedHost += 1))}`;
  return new Promise<T>((resolve, reject) => {
    pendingOfHost.set(id, { resolve: (value) => resolve(value as T), reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

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
          graph: {
            files: async (pattern) => await askHost<{ files: GraphVertex[] }>('graph.files', { pattern }).then((answer) => answer.files),
            value: async (kind, key, field) => await askHost<{ value: unknown }>('graph.value', { kind, key, field }).then((answer) => answer.value as never),
          },
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
      for (const waiter of pendingOfHost.values()) waiter.reject(new Error('the host cancelled the plugin while a graph read stood open'));
      pendingOfHost.clear();
      finish();
      return;
    }
    // An answer to a request this plugin made (a graph read): the waiter takes it, or the cause it failed with.
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = pendingOfHost.get(message.id);
      if (waiter !== undefined) {
        pendingOfHost.delete(message.id);
        if (message.error === undefined) waiter.resolve(message.result);
        else waiter.reject(new Error(message.error.message));
      }
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
      rights: { network: 'none', ...(definition.graph === true ? { graph: true } : {}), ...(definition.filesystem === true ? { filesystem: true } : {}) },
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
