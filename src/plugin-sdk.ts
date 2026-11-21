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
 *       contract: { vertices: [{ kind: 'file', key: ['path'], fields: [{ name: 'path', type: 'text', meaning: 'the path', example: 'a.ts', required: true }, { name: 'size', type: 'integer', meaning: 'its size', example: 12, required: false }] }], edges: [] },
 *       extract(unit) {
 *         return { vertices: [{ kind: 'file', key: unit.key, values: { size: 12 } }], end: { state: 'complete' } };
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

import { createHash } from 'node:crypto';

/** The protocol version this SDK speaks. */
export const PROTOCOL_VERSION = 'madarch.plugins/3';

/** The reader's request, as the host names it (decision 0037): a repository root the plugin sees, a blob id and lines. */
export interface PluginReadRequest {
  readonly repository: string;
  readonly blob: string;
  readonly from?: number;
  readonly to?: number;
}

/** What a read answers: the lines' text, the blob's counts, and whether it is text at all. */
export interface PluginReadResult {
  readonly text: string;
  readonly lines: number;
  readonly bytes: number;
  readonly binary: boolean;
}

/** One graph read a plugin may declare. */
export type GraphReadName = 'ownFacts' | 'files' | 'value' | 'removedEnds' | 'unevidenced';

export type KeyValues = Readonly<Record<string, string | number | boolean>>;

/** One entity named by its kind and key values. */
export interface EntityRef {
  readonly keyEdges?: Readonly<Record<string, EntityRef>>;
  readonly kind: string;
  readonly key: KeyValues;
}

/** Where one value was read. */
export interface Evidence {
  readonly target: EntityRef;
  readonly commit?: string;
  readonly digest?: string;
  readonly path?: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

/** One vertex a unit produced: its key, and the field values of one opinion with the evidence it stands on. */
export interface VertexResult {
  readonly keyEdges?: Readonly<Record<string, EntityRef>>;
  readonly kind: string;
  readonly key: KeyValues;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly evidence?: Evidence;
}

/** One edge a unit produced: its ends, and the field values of one opinion with the evidence it stands on. */
export interface EdgeResult {
  readonly kind: string;
  readonly from: EntityRef;
  readonly to: EntityRef;
  readonly discriminator?: string;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly evidence?: Evidence;
}

/** How one unit ended. */
export type UnitEnd = { readonly state: 'complete' } | { readonly state: 'partial'; readonly cause: string } | { readonly state: 'inapplicable'; readonly searched: string; readonly evidence: readonly Evidence[] };

/**
 * One place a unit could not read: a file, the line it stands on and the cause. The unit states everything else it read,
 * and the host records these as the unit's problems, so one unreadable file never costs the rest of the answer.
 */
export interface UnitProblem {
  /** The repository the file belongs to, when the product spans several. */
  readonly repository?: string;
  /** The repository-relative path of the file the problem stands in. */
  readonly path: string;
  /** The line the problem opens at, 1-based. */
  readonly line: number;
  /** The column the problem opens at, 1-based, when the reader has one. */
  readonly column?: number;
  /** What could not be read, in words a person can act on. */
  readonly message: string;
}

/** One unit's answer. */
export interface UnitResult {
  readonly vertices?: readonly VertexResult[];
  readonly edges?: readonly EdgeResult[];
  readonly removals?: readonly EntityRef[];
  /** The places the unit could not read; the answer's vertices and edges still stand. */
  readonly problems?: readonly UnitProblem[];
  readonly end: UnitEnd;
}

/** The covered source snapshot (decision 0039, items 18 and 26). */
export interface ReconciliationScope {
  /** Explicit parent identity bounding the covered source; no product kind is assumed. */
  readonly parent?: EntityRef;
  readonly repository?: string;
  readonly commit?: string;
}

/** Only the authenticated plugin's current facts in a covered scope. */
export interface OwnFacts {
  readonly vertices: readonly VertexResult[];
  readonly edges: readonly EdgeResult[];
}

/** One explicit difference submitted to the one writer. */
export interface ReconciliationWrite {
  readonly operation: 'add' | 'update' | 'remove';
  readonly vertex?: VertexResult;
  readonly edge?: EdgeResult;
  readonly evidence?: Evidence;
}

function codePointOrder(left: string, right: string): number {
  const a = Array.from(left), b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** Canonical JSON values; object field order is not a source change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort(codePointOrder).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function presentValues(values: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * Decision 0039 items 18 and 26: reconcile only this source, never sweep an
 * incomplete scan. Evidence changes alone do not turn equal values into updates.
 */
export function reconcileFacts(source: UnitResult, current: OwnFacts, scope: ReconciliationScope): ReconciliationWrite[] {
  const writes: ReconciliationWrite[] = [];
  if (scope.repository !== undefined && scope.parent === undefined) throw new Error(`${import.meta.filename}:1: repository reconciliation requires an explicit parent identity`);
  const underParent = (ref: EntityRef): boolean => canonical(ref) === canonical(scope.parent) || Object.values(ref.keyEdges ?? {}).some(underParent);
  const covered = (fact: VertexResult | EdgeResult): boolean => scope.parent === undefined || ('key' in fact ? underParent(fact) : underParent(fact.from) || underParent(fact.to));

  const compare = <T extends VertexResult | EdgeResult>(type: 'vertex' | 'edge', desired: readonly T[], existing: readonly T[], identity: (fact: T) => string): void => {
    const index = (facts: readonly T[]): Map<string, T> => {
      const indexed = new Map<string, T>();
      for (const fact of facts.filter(covered)) {
        const key = identity(fact);
        if (indexed.has(key)) throw new Error(`${import.meta.filename}:1: duplicate ${type} identity in reconciliation: ${key}`);
        indexed.set(key, fact);
      }
      return indexed;
    };
    for (const fact of desired) if (!covered(fact)) throw new Error(`${import.meta.filename}:1: source ${type} is outside the reconciliation parent scope`);
    const before = index(existing), after = index(desired);
    for (const key of [...after.keys()].sort(codePointOrder)) {
      const fact = after.get(key)!;
      const previous = before.get(key);
      if (previous !== undefined && canonical(presentValues(previous.values)) === canonical(presentValues(fact.values))) continue;
      writes.push({ operation: previous === undefined ? 'add' : 'update', [type]: fact, ...(fact.evidence === undefined ? {} : { evidence: fact.evidence }) });
    }
    if (source.end.state !== 'complete' || (source.problems?.length ?? 0) > 0) return;
    for (const key of [...before.keys()].sort(codePointOrder)) {
      if (!after.has(key)) {
        const fact = before.get(key)!;
        const evidence = fact.evidence;
        writes.push({ operation: 'remove', [type]: fact, ...(evidence === undefined ? {} : { evidence }) });
      }
    }
  };
  compare('vertex', source.vertices ?? [], current.vertices, (vertex) => canonical([vertex.kind, vertex.key, vertex.keyEdges ?? {}]));
  compare('edge', source.edges ?? [], current.edges, (edge) => canonical([edge.kind, edge.from, edge.to, edge.discriminator ?? '']));
  return writes;
}

// Half the protocol message limit leaves room for the RPC envelope and operation metadata.
const reconciliationBytes = 512 * 1024;
const reconciliationFacts = 500;
/** Pack atomic dependency groups, not individual facts, into deterministic requests. */
export function* reconciliationBatches(writes: readonly ReconciliationWrite[], contract: ContractDeclaration, unit: Unit): Generator<FactsOperation> {
  const identity = (ref: EntityRef): string => canonical([ref.kind, ref.key, ref.keyEdges ?? {}]);
  const phases = ['vertices', 'edges', 'edgeRemovals', 'removals'] as const;
  type Phase = (typeof phases)[number];
  type Fact = VertexResult | EdgeResult | (EntityRef & { readonly evidence?: Evidence });
  type Batch = Partial<Record<Phase, Fact[]>>;
  const retired = new Set(writes.filter(write => write.operation === 'remove' && write.vertex !== undefined).map(write => identity(write.vertex!)));
  // Keep implicit retractions in dependency analysis: retiring an old target must stay with its replacement.
  const implicit = (write: ReconciliationWrite): boolean => write.edge !== undefined && write.operation === 'remove' && (retired.has(identity(write.edge.from)) || retired.has(identity(write.edge.to)));
  const roots = writes.map((_, index) => index);
  const root = (index: number): number => {
    if (roots[index] !== index) roots[index] = root(roots[index]!);
    return roots[index]!;
  };
  const join = (left: number, right: number): void => { roots[root(right)] = root(left); };
  const additions = new Map<string, number>();
  const removals = new Map<string, number>();
  writes.forEach((write, index) => {
    if (write.vertex !== undefined) (write.operation === 'remove' ? removals : additions).set(identity(write.vertex), index);
  });
  const constrained = new Map<string, number>();
  writes.forEach((write, index) => {
    if (write.vertex !== undefined) {
      const vertices = write.operation === 'remove' ? removals : additions;
      for (const parent of Object.values(write.vertex.keyEdges ?? {})) {
        const dependency = vertices.get(identity(parent));
        if (dependency !== undefined) join(index, dependency);
      }
    }
    if (write.edge === undefined) return;
    const edge = write.edge;
    const declaration = contract.edges.find(kind => kind.kind === edge.kind);
    const required = declaration !== undefined && [declaration.cardinality.from, declaration.cardinality.to].some(bound => bound === 'one' || bound === 'some');
    for (const side of ['from', 'to'] as const) {
      const endpoint = edge[side];
      const added = additions.get(identity(endpoint));
      const bound = side === 'from' ? declaration?.cardinality.to : declaration?.cardinality.from;
      if (added !== undefined && required) join(index, added);
      const removed = removals.get(identity(endpoint));
      if (write.operation === 'remove' && removed !== undefined) join(index, removed);
      if (bound === undefined || bound === 'many') continue;
      const key = canonical([edge.kind, side, identity(endpoint)]);
      const previous = constrained.get(key);
      if (previous !== undefined) join(index, previous);
      constrained.set(key, index);
    }
  });
  const grouped = new Map<number, ReconciliationWrite[]>();
  writes.forEach((write, index) => {
    const key = root(index);
    const group = grouped.get(key) ?? [];
    group.push(write);
    grouped.set(key, group);
  });
  const factKey = (write: ReconciliationWrite): string => write.vertex === undefined
    ? canonical([write.edge!.kind, write.edge!.from, write.edge!.to, write.edge!.discriminator ?? ''])
    : identity(write.vertex);
  const orderedVertices = (facts: Fact[], removing: boolean): Fact[] => {
    const byKey = new Map(facts.map(fact => [identity(fact as EntityRef), fact]));
    const children = new Map<string, Fact[]>();
    if (removing) for (const fact of facts) {
      for (const parent of Object.values((fact as EntityRef).keyEdges ?? {})) {
        const key = identity(parent);
        const dependents = children.get(key) ?? [];
        dependents.push(fact);
        children.set(key, dependents);
      }
    }
    const ordered: Fact[] = [];
    const visited = new Set<string>();
    const visit = (fact: Fact): void => {
      const key = identity(fact as EntityRef);
      if (visited.has(key)) return;
      visited.add(key);
      const dependencies = removing
        ? children.get(key) ?? []
        : Object.values((fact as EntityRef).keyEdges ?? {}).map(parent => byKey.get(identity(parent))).filter((parent): parent is Fact => parent !== undefined);
      dependencies.sort((a, b) => codePointOrder(identity(a as EntityRef), identity(b as EntityRef))).forEach(visit);
      ordered.push(fact);
    };
    facts.forEach(visit);
    return ordered;
  };
  const groups = [...grouped.values()].map(writes => {
    writes.sort((a, b) => codePointOrder(factKey(a), factKey(b)) || codePointOrder(canonical(a), canonical(b)));
    const operation: Batch = {};
    for (const write of writes) {
      // removeEntity retracts incident edges; explicit retractions would resolve retired endpoints.
      if (implicit(write)) continue;
      const phase = write.vertex !== undefined ? (write.operation === 'remove' ? 'removals' : 'vertices') : (write.operation === 'remove' ? 'edgeRemovals' : 'edges');
      const fact = write.vertex !== undefined && write.operation === 'remove'
        ? { kind: write.vertex.kind, key: write.vertex.key, ...(write.vertex.keyEdges === undefined ? {} : { keyEdges: write.vertex.keyEdges }), ...(write.vertex.evidence === undefined ? {} : { evidence: write.vertex.evidence }) }
        : write.vertex ?? write.edge!;
      (operation[phase] ??= []).push(fact);
    }
    for (const phase of ['vertices', 'removals'] as const) {
      if (operation[phase] !== undefined) operation[phase] = orderedVertices(operation[phase]!, phase === 'removals');
    }
    const phase = operation.vertices !== undefined ? 0 : operation.edges !== undefined ? 1 : operation.edgeRemovals !== undefined ? 2 : 3;
    return { operation, phase, key: writes.some(write => write.vertex !== undefined) ? writes.filter(write => write.vertex !== undefined).map(factKey).sort(codePointOrder)[0]! : identity(writes[0]!.edge!.from), name: writes.some(write => write.vertex !== undefined) ? identity(writes.find(write => write.vertex !== undefined)!.vertex!) : canonical([writes[0]!.edge!.kind, writes[0]!.edge!.from, writes[0]!.edge!.to, writes[0]!.edge!.discriminator ?? '']), count: writes.filter(write => !implicit(write)).length };
  }).sort((a, b) => a.phase - b.phase || codePointOrder(a.key, b.key) || codePointOrder(canonical(a.operation), canonical(b.operation)));
  let batch: Batch = {};
  let count = 0;
  let bytes = 2;
  let phase = -1;
  for (const group of groups) {
    // Serialize each fact once. Add field names, separators and array brackets separately.
    const sizes = new Map(phases.filter(field => group.operation[field] !== undefined).map(field => [field, group.operation[field]!.reduce((sum, fact) => sum + Buffer.byteLength(JSON.stringify(fact)) + 1, 0)]));
    const growth = (target: Batch): number => {
      let added = 0;
      let fields = Object.keys(target).length;
      for (const [field, size] of sizes) {
        if (target[field] !== undefined) added += size;
        else {
          added += Buffer.byteLength(JSON.stringify(field)) + 3 + size - 1 + (fields > 0 ? 1 : 0);
          fields++;
        }
      }
      return added;
    };
    if (2 + growth({}) > reconciliationBytes) {
      throw new Error(`${import.meta.filename}:320: reconciliation unit ${unit.unitId} ${unit.kind} ${canonical(unit.key)} group ${group.name} exceeds 512 KB operation limit`);
    }
    if (count > 0 && ((phase !== group.phase && group.phase >= 2) || count + group.count > reconciliationFacts || bytes + growth(batch) > reconciliationBytes)) {
      yield batch as FactsOperation;
      batch = {};
      count = 0;
      bytes = 2;
    }
    bytes += growth(batch);
    for (const field of phases) if (group.operation[field] !== undefined) (batch[field] ??= []).push(...group.operation[field]!);
    count += group.count;
    phase = group.phase;
  }
  if (count > 0) yield batch as FactsOperation;
}

/** The unit the host hands a plugin. */
export interface Unit {
  readonly keyEdges?: Readonly<Record<string, EntityRef>>;
  readonly unitId: string;
  readonly kind: string;
  readonly key: KeyValues;
  readonly inputs?: unknown;
}

/** One vertex the host answers a graph query with: its kind and key values. */
export interface GraphVertex {
  readonly keyEdges?: Readonly<Record<string, EntityRef>>;
  readonly kind: string;
  readonly key: KeyValues;
}

/** One entity a host answer names: its kind, its key and a label a person reads. */
export interface GraphAddress {
  readonly keyEdges?: Readonly<Record<string, EntityRef>>;
  readonly kind: string;
  readonly key: KeyValues;
  readonly label: string;
}

/** One edge an unresolved reference or a removed end names, with the ends that stand. */
export interface GraphEdgeAddress {
  readonly kind: string;
  readonly from?: GraphAddress;
  readonly to?: GraphAddress;
  readonly discriminator?: string;
}

/** One edge whose end is removed. */
export interface GraphRemovedEnd {
  readonly edge: GraphEdgeAddress;
  readonly from: GraphAddress;
  readonly to: GraphAddress;
  readonly removed: readonly ('from' | 'to')[];
}

/** One open opinion of a field whose contract requires evidence and that states none. */
export interface GraphUnevidencedAssertion {
  readonly entity: GraphAddress;
  readonly field: string;
  readonly producer: string;
  readonly assertion: string;
}

/** One page asked of a consistency read: the cursor a previous page named, and a bound. */
export interface GraphPageQuery {
  readonly after?: string;
  readonly limit?: number;
}

/** One page answered by a consistency read, with the cursor of the next page when one stands. */
export interface GraphPage<T> {
  readonly rows: readonly T[];
  readonly next?: string;
}

/** The graph reads a plugin declares and asks for (decision 0035, item 15; madarch-stm0.7.1, pieces 2 and 4). */
export interface GraphReads {
  /** This source's current facts, including prior revisions, within the covered scope. */
  ownFacts(scope: ReconciliationScope): Promise<OwnFacts>;
  /** The file vertices whose path matches the pattern (a glossary document in any folder, say), in code point order. */
  files(pattern: string): Promise<GraphVertex[]>;
  /** One field of one vertex: a file's content, as the files producer stored it, never a folder of the product. */
  value<T = unknown>(kind: string, key: KeyValues, field: string, keyEdges?: Readonly<Record<string, EntityRef>>): Promise<T>;
  /** One page of the edges one of whose ends is removed. */
  removedEnds(query?: GraphPageQuery): Promise<GraphPage<GraphRemovedEnd>>;
  /** One page of the open opinions of fields whose contract requires evidence and that state none. */
  unevidenced(query?: GraphPageQuery): Promise<GraphPage<GraphUnevidencedAssertion>>;
}

/** What `extract` is handed beside the unit: the way back to the host while it works. */
export interface FactsOperation {
  readonly vertices?: readonly VertexResult[];
  readonly edges?: readonly EdgeResult[];
  readonly removals?: readonly (EntityRef & { readonly evidence?: Evidence })[];
  readonly edgeRemovals?: readonly EdgeResult[];
}

export interface ExtractContext {
  /** Compare a covered source snapshot and immediately apply only differences. */
  reconcile(source: UnitResult, scope: ReconciliationScope): Promise<void>;
  /** Applies one atomic operation; retry the same logical key only with identical content. */
  readonly facts: { apply(key: string, operation: FactsOperation, options?: { readonly preconditions?: readonly { readonly uid: string; readonly recordedSequence: string }[]; readonly contractVersion?: string }): Promise<unknown> };
  /** Set when the host asked the plugin to stop: a long read should give up at the next check. */
  readonly signal: AbortSignal;
  /** Says the plugin is alive while a long unit runs; the SDK sends one on a timer as well. */
  heartbeat(): void;
  /** Where the unit stands, in counts of what it reads. */
  progress(done: number, total?: number, note?: string): void;
  /** The graph the plugin asked the host for; a query of a plugin that declared no `graph` right is refused. */
  readonly graph: GraphReads;
  /** Runs the manifest's agent part through the host; adapters and credentials stay with the host. */
  agent(task?: unknown): Promise<UnitResult>;
  /**
   * A file's text, asked of the host (owner's decision, 2026-11-15; decision 0038): an ordinary plugin holds no
   * environment, names the repository and the blob id the graph holds, and the host routes the read to the core plugin
   * that owns git. A plugin whose capabilities name no "repository" is refused, with its name and the access.
   */
  read(request: PluginReadAsk): Promise<PluginReadResult>;
}

/** One file read a plugin asks of the host: a repository's name, the blob id the graph holds, and the lines it wants. */
export interface PluginReadAsk {
  readonly repository: string;
  readonly blob: string;
  readonly from?: number;
  readonly to?: number;
}

/** One field of a declared kind (decision 0035, item 18): its type, meaning, an example and whether it is required. */
export interface FieldDeclaration {
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly type: 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json';
  /** What the field is, in plain words, for the person binding it in the product's manifest. */
  readonly meaning: string;
  /** One value the field holds. */
  readonly example: unknown;
  /** Whether the plugin cannot run without it: its kind's key and every field its reading needs. */
  readonly required: boolean;
  /** Whether an opinion of this field must carry evidence: the host reports one that states none. */
  readonly evidence?: boolean;
}

/** One ordered parent role in a natural key (0039 item 28). */
export interface KeyEdgeDeclaration { readonly role: string; readonly edge: string; readonly direction: 'from' | 'to'; readonly onDelete: 'restrict' | 'cascade' }

/** One vertex kind a plugin declares it produces. */
export interface VertexKindDeclaration {
  readonly evidence?: { readonly immutable: true; readonly digestField?: string; readonly contentField?: string; readonly digestAlgorithm?: 'sha256' };
  readonly keyEdges?: readonly KeyEdgeDeclaration[];
  readonly kind: string;
  readonly key: readonly string[];
  readonly fields?: readonly FieldDeclaration[];
}

/** One edge kind a plugin declares it produces. */
export interface EdgeKindDeclaration {
  readonly cardinality: { readonly from: 'one' | 'optional' | 'many' | 'some'; readonly to: 'one' | 'optional' | 'many' | 'some' };
  readonly labels: { readonly en: { readonly out: string; readonly in: string }; readonly ru: { readonly out: string; readonly in: string } };
  readonly kind: string;
  readonly from: string | readonly string[];
  readonly to: string | readonly string[];
  readonly fields?: readonly FieldDeclaration[];
}

/** The outputs a plugin declares: every kind, key field and edge kind a result may name. */
export interface ContractDeclaration {
  readonly vertices: readonly VertexKindDeclaration[];
  readonly edges: readonly EdgeKindDeclaration[];
}

/** One finite page of byte-aware output key partitions; no next cursor means complete. */
export interface OutputPlan {
  readonly partitions: readonly { readonly keys: readonly KeyValues[] }[];
  readonly next?: string;
}

/** What defining a plugin takes: its contract and the one function the author writes. */
export interface PluginDefinition {
  /** Read-only plugins do not reconcile their extraction results. */
  readonly readOnly?: boolean;
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
  /** The graph reads the plugin asks for; absent, files and value. A read not named is refused by name. */
  readonly graphReads?: readonly GraphReadName[];
  /** What the plugin reads: one unit at a time ("unit", the default), or the whole graph once after every other plugin turn. */
  readonly reads?: 'unit' | 'whole-graph';
  /** The one function the author writes: the unit in, its answer out. */
  readonly planOutput?: (unit: Unit, context: ExtractContext, cursor?: string) => Promise<OutputPlan> | OutputPlan;
  readonly extract: (unit: Unit, context: ExtractContext) => Promise<UnitResult> | UnitResult;
  /**
   * The bytes one blob holds, read by the host on demand (decision 0037, madarch-u3vw.16): a page's «Текст» asks for
   * lines by blob id, and the agent's file reads ask the same way. A plugin that declares no read answers the host with
   * a refusal by name.
   */
  readonly read?: (request: PluginReadRequest) => Promise<PluginReadResult> | PluginReadResult;
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

  const takeUnit = (id: RpcId, params: Record<string, unknown> | undefined, planning = false): void => {
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
        const extract = planning ? definition.planOutput : definition.extract;
        if (extract === undefined) throw new Error('this plugin does not declare planOutput');
        const vertexIdentity = (vertex: EntityRef): string => canonical([vertex.kind, vertex.key, vertex.keyEdges ?? {}]);
        const edgeIdentity = (edge: EdgeResult): string => canonical([edge.kind, edge.from, edge.to, edge.discriminator ?? '']);
        const appliedVertices = new Set<string>();
        const appliedEdges = new Set<string>();
        const reconcile = async (source: UnitResult, scope: ReconciliationScope, retainApplied = false): Promise<void> => {
          const current = await askHost<OwnFacts>('graph.ownFacts', { unitId: unit.unitId, scope });
          // Discard the result intentionally: validate duplicates and scope before merging retained facts.
          if (retainApplied) reconcileFacts(source, { vertices: [], edges: [] }, scope);
          const desired = retainApplied ? {
            ...source,
            vertices: [...new Map([...current.vertices.filter(vertex => appliedVertices.has(vertexIdentity(vertex))), ...(source.vertices ?? [])].map(vertex => [vertexIdentity(vertex), vertex])).values()],
            edges: [...new Map([...current.edges.filter(edge => appliedEdges.has(edgeIdentity(edge))), ...(source.edges ?? [])].map(edge => [edgeIdentity(edge), edge])).values()],
          } : source;
          for (const operation of reconciliationBatches(reconcileFacts(desired, current, scope), definition.contract, unit)) {
            if (controller.signal.aborted) throw new Error(`${import.meta.filename}:639: reconciliation cancelled for unit ${unit.unitId}`);
            const key = `reconcile-${createHash('sha256').update(canonical(operation)).digest('hex')}`;
            await askHost('facts.apply', { unitId: unit.unitId, key, operation });
            for (const vertex of operation.vertices ?? []) appliedVertices.add(vertexIdentity(vertex));
            for (const edge of operation.edges ?? []) appliedEdges.add(edgeIdentity(edge));
            for (const vertex of operation.removals ?? []) appliedVertices.delete(vertexIdentity(vertex));
            for (const edge of operation.edgeRemovals ?? []) appliedEdges.delete(edgeIdentity(edge));
          }
          // A successful reconciliation also confirms facts whose values did not need a write.
          for (const vertex of desired.vertices ?? []) appliedVertices.add(vertexIdentity(vertex));
          for (const edge of desired.edges ?? []) appliedEdges.add(edgeIdentity(edge));
        };
        let explicitlyReconciled = false;
        const result = await extract(unit, {
          reconcile: async (source, scope) => { await reconcile(source, scope); explicitlyReconciled = true; },
          signal: controller.signal,
          facts: { apply: async (key, operation, options) => {
            const response = await askHost('facts.apply', { unitId: unit.unitId, key, operation, ...options });
            for (const vertex of operation.vertices ?? []) appliedVertices.add(vertexIdentity(vertex));
            for (const edge of operation.edges ?? []) appliedEdges.add(edgeIdentity(edge));
            for (const vertex of operation.removals ?? []) appliedVertices.delete(vertexIdentity(vertex));
            for (const edge of operation.edgeRemovals ?? []) appliedEdges.delete(edgeIdentity(edge));
            return response;
          } },
          agent: async (task) => await askHost<UnitResult>('agent.run', { unitId: unit.unitId, ...(task === undefined ? {} : { task }) }),
          heartbeat,
          progress: (done, total, note) => send({ jsonrpc: '2.0', method: 'progress', params: { unitId: unit.unitId, done, ...(total === undefined ? {} : { total }), ...(note === undefined ? {} : { note }) } }),
          read: async (request) => await askHost<PluginReadResult>('file.read', { ...request }),
          graph: {
            ownFacts: async (scope) => await askHost<OwnFacts>('graph.ownFacts', { unitId: unit.unitId, scope }),
            files: async (pattern) => await askHost<{ files: GraphVertex[] }>('graph.files', { pattern }).then((answer) => answer.files),
            value: async (kind, key, field, keyEdges) => await askHost<{ value: unknown }>('graph.value', { kind, key, field, ...(keyEdges === undefined ? {} : { keyEdges }) }).then((answer) => answer.value as never),
            removedEnds: async (query) => await askHost<{ edges: GraphRemovedEnd[]; next?: string }>('graph.removedEnds', query ?? {}).then((answer) => ({ rows: answer.edges, ...(answer.next === undefined ? {} : { next: answer.next }) })),
            unevidenced: async (query) => await askHost<{ assertions: GraphUnevidencedAssertion[]; next?: string }>('graph.unevidenced', query ?? {}).then((answer) => ({ rows: answer.assertions, ...(answer.next === undefined ? {} : { next: answer.next }) })),
          },
        }, typeof params?.['cursor'] === 'string' ? params['cursor'] : undefined);
        if (!running.has(id)) return;
        if (planning || definition.readOnly === true) answer(id, { unitId: unit.unitId, ...result });
        else {
          const produced = result as UnitResult;
          for (const vertex of produced.removals ?? []) appliedVertices.delete(vertexIdentity(vertex));
          if (!explicitlyReconciled || (produced.vertices?.length ?? 0) > 0 || (produced.edges?.length ?? 0) > 0 || (produced.removals?.length ?? 0) > 0) {
            await reconcile(produced, {}, true);
          }
          if (!running.has(id)) return;
          const { vertices: _vertices, edges: _edges, removals: _removals, ...terminal } = produced;
          answer(id, { unitId: unit.unitId, ...terminal });
        }
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
      if (message.method === 'unit' || message.method === 'planOutput') {
        if (stopping) refuse(message.id, RPC_PLUGIN_ERROR, 'the plugin is stopping and takes no unit', 'stopping');
        else takeUnit(message.id, message.params, message.method === 'planOutput');
        return;
      }
      if (message.method === 'read') {
        const request = message.params as unknown as PluginReadRequest | undefined;
        if (definition.read === undefined) { refuse(message.id, RPC_INVALID_PARAMS, 'this plugin declares no read: its contract answers no blob'); return; }
        if (request === undefined || typeof request.repository !== 'string' || typeof request.blob !== 'string') { refuse(message.id, RPC_INVALID_PARAMS, 'a read stands under params, with a repository and a blob id'); return; }
        void Promise.resolve(definition.read(request)).then(
          (result) => { answer(message.id!, result); },
          (error: unknown) => { refuse(message.id!, RPC_PLUGIN_ERROR, error instanceof Error ? error.message : String(error), 'read-failed'); },
        );
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
      ...(definition.read === undefined ? {} : { read: true }),
      name: definition.name,
      version: definition.version,
      rights: { network: 'none', ...(definition.graph === true || definition.readOnly !== true ? { graph: true } : {}), ...(definition.readOnly !== true ? { graphReads: [...new Set<GraphReadName>([...(definition.graphReads ?? ['files', 'value']), 'ownFacts'])] } : definition.graphReads === undefined ? {} : { graphReads: definition.graphReads }), ...(definition.filesystem === true ? { filesystem: true } : {}) },
      limits: {
        ...(definition.maxParallelUnits === undefined ? {} : { maxParallelUnits: definition.maxParallelUnits }),
        ...(definition.maxOutputBytes === undefined ? {} : { maxOutputBytes: definition.maxOutputBytes }),
      },
      outputs: definition.contract,
      ...(definition.planOutput === undefined ? {} : { planOutput: true }),
      reads: definition.reads ?? 'unit',
    },
  };
  send(introduce);
  // The promise settles when the process is over: the loop above exits the process, and this keeps the module alive
  // until then without a busy wait.
  await new Promise<void>((done) => { process.on('exit', () => done()); });
}
