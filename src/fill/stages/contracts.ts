/**
 * The contract documents of a repository, as a static stage (decision 0033,
 * items 5, 7, 14 and 15; madarch-8bdc.2.4): one unit per contract file, one
 * file's bytes, and the contracts, operations, channels and messages the file
 * writes down.
 *
 * **What it publishes.** The records the extract driver's contracts reading
 * publishes from a contract document, in the extractors' `code.*` vocabulary:
 * one `code.contract` node per document, one `code.operation` per operation a
 * document declares, one `code.channel` per channel of an AsyncAPI document and
 * one `code.message` per message a channel carries, with the `code.declares`
 * edges a contract's members hang from it, the `code.carries` edges a channel
 * carries its messages by, and the `code.contains` edges that reach every node
 * from the file it stands in.
 *
 * **The readers are the driver's own, per file.** `readOpenApi`,
 * `readAsyncApi` and `readProto` take a path and a text and answer the document
 * they read; `openApiNodes`, `asyncApiNodes` and `protoNodes` answer the nodes
 * the driver publishes for it. This stage hands them one pinned file's bytes
 * from its static context and writes what they answer, so the two cannot
 * disagree about a document's shape.
 *
 * **What it reads from elsewhere, and why.** Two records of a document are not
 * facts of the document's own bytes:
 *
 * - an OpenAPI operation's `service`: the one local service its servers resolve
 *   to. The per-file port fact the code-facts stage publishes
 *   (`code.listener-port`, with the port and the service it serves) answers it
 *   by a bounded read by property, by the same rule the driver's
 *   `portsByService` map is built with;
 * - a channel's `consumerFound`/`consumerStatus`: whether a `code.consumes` edge
 *   another file published ends at the channel, read by the topic the edge
 *   carries (`edgesByProperty`). The consumes edges are a code site's, and no
 *   stage on this branch publishes them yet: a channel read before they stand
 *   says `not-found-in-product`, which is the `channels` family the comparison
 *   still lists as remaining (the change record says what the fold needs).
 *
 * **What a unit publishes when it cannot read.** A path the pinned commit no
 * longer holds publishes nothing, so the publication retracts what an earlier
 * run wrote there. A file above the static cap, bytes that are not UTF-8 and a
 * document the reader could not parse are named in the file's coverage — a gap,
 * never a silence.
 *
 * **A refill writes nothing.** The plan compares each contract file's blob with
 * this stage's own coverage; a file it already read at the blob the pinned
 * commit holds is not planned again.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { isRepositoryPath } from '../facts.js';
import { FACT_KINDS, makeNodeFact, type CoverageGap, type CoverageValue, type FactSource } from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { readAsyncApi, asyncApiNodes, type AsyncApiContract } from '../../extract/contracts/asyncapi.js';
import { openApiNodes, readOpenApi, type OpenApiContract } from '../../extract/contracts/openapi.js';
import { protoNodes, readProto, type ProtoContract } from '../../extract/contracts/proto.js';
import {
  channelKey, contractKey, EDGE_CARRIES, EDGE_CONTAINS, EDGE_DECLARES, KIND_CHANNEL, KIND_CONTRACT, KIND_MESSAGE,
  messageKey, operationKey,
} from '../../extract/contracts/schema.js';
import type { ExtractedNode, SourceSpan } from '../../extract/records.js';
import { evidenceAtPlace } from './draft.js';
import type { StaticGraphNode, StaticStageContext, StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { fileFactIdOf } from './syntax-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';

/** The stage's id, as it is registered and as its units are named. */
const CONTRACTS_STAGE_ID = 'contracts';

/** The stage's own version, bumped when what it writes or plans changes. */
const CONTRACTS_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order. */
const CONTRACTS_STAGE_KINDS: readonly string[] = ['carries', 'channel', 'contains', 'contract', 'declares', 'message', 'operation', 'coverage'];

/** The reader every fact of this stage cites as its source: this fill's own reading of a contract document. */
export const CONTRACTS_SOURCE_SYSTEM = 'madarch-contracts';

/** The reader every fact of this stage cites. */
const CONTRACTS_SOURCE: FactSource = { system: CONTRACTS_SOURCE_SYSTEM, version: '1' };

/** The read the plan makes of what this stage published, by the file. */
export const PUBLISHED_CONTRACTS_READ = 'stage-contracts-published';

/** The read of one repository's published contract documents: one row per contract file this stage read. */
function publishedContractsRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_CONTRACTS_READ, repository });
}

/** One row of that read: one contract file this stage read, at the blob its bytes stood under. */
interface PublishedContractsRow {
  readonly kind: 'coverage';
  readonly path: string;
  readonly blob?: string;
}

/** The keys a row of that read holds, and no others. */
const CONTRACTS_ROW_FIELDS: readonly string[] = ['blob', 'kind', 'path', 'repository'];

/** The stage, built over the source that holds the run's pins. */
export function createContractsStage(sources: SnapshotSource): FillStage {
  return {
    id: CONTRACTS_STAGE_ID,
    version: CONTRACTS_STAGE_VERSION,
    staticReading: true,
    consumes: {
      required: [{ capability: 'file', scope: 'repository', freshness: 'current' }],
      optional: [
        // The per-file port fact the code-facts stage publishes: an operation's service is
        // resolved from it, and a run that has not published one resolves no service rather
        // than guessing a path.
        { capability: 'listener-port', scope: 'repository', freshness: 'current' },
        // The consumes edges the contracts-code stage publishes: a channel's consumer fold is a
        // read of them, and a run that published none reads the fold as not found.
        { capability: 'consumes', scope: 'repository', freshness: 'current' },
      ],
    },
    produces: [
      { kind: 'carries', schemaVersion: 1, scope: 'file' },
      { kind: 'channel', schemaVersion: 1, scope: 'file' },
      { kind: 'contains', schemaVersion: FACT_KINDS['contains'].version, scope: 'file' },
      { kind: 'contract', schemaVersion: 1, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'declares', schemaVersion: 1, scope: 'file' },
      { kind: 'message', schemaVersion: 1, scope: 'file' },
      { kind: 'operation', schemaVersion: 1, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planContracts(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeContractsUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(CONTRACTS_STAGE_ID, CONTRACTS_STAGE_KINDS, draft),
  };
}

/** The format a contract file is read in, by the extractor's own folder convention: `openapi`, `asyncapi`, `proto`, or none. */
function contractFormatOf(path: string): 'openapi' | 'asyncapi' | 'proto' | undefined {
  if (path.startsWith('contracts/openapi/') && /\.ya?ml$/.test(path)) return 'openapi';
  if (path.startsWith('contracts/asyncapi/') && /\.ya?ml$/.test(path)) return 'asyncapi';
  if (path.startsWith('contracts/proto/') && path.endsWith('.proto')) return 'proto';
  return undefined;
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run fills, in code point order of the unit ids: a unit per
 * contract file this stage's own coverage does not name at the blob the pinned
 * commit holds, and one per published file the commit no longer holds, whose
 * unit publishes nothing and so retracts what an earlier run wrote for it.
 */
async function planContracts(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const ownRead = publishedContractsRead(pin.id);
    const own = publishedContractsRows(await graph.query(ownRead), pin.id, ownRead);
    const readBlobs = new Map<string, string | undefined>(own.map((row) => [row.path, row.blob]));
    const mine = reader.files().filter((entry) => contractFormatOf(entry.path) !== undefined);
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    for (const entry of mine) {
      if (readBlobs.get(entry.path) === entry.id) continue;
      if (!tree.files.has(entry.path)) {
        blocked = true;
        continue;
      }
      units.push({ id: fileUnitId(pin.id, entry.path), scope: `${pin.id}:${entry.path}` });
    }
    for (const row of own) {
      if (present.has(row.path)) continue;
      units.push({ id: fileUnitId(pin.id, row.path), scope: `${pin.id}:${row.path}` });
    }
  }
  if (blocked) return { units: [], coverage: 'nothing-found' };
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anySource ? 'planned' : 'nothing-found' };
}

/** The plan's own read, read: each row is one contract file this stage read and the blob its bytes stood under. */
function publishedContractsRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedContractsRow[] {
  return rows.map((row, index) => {
    const refuse = (detail: string): Error => new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw refuse(`${JSON.stringify(row)} is no row: a row is an object naming its kind and its path`);
    const held = row as Record<string, unknown>;
    for (const key of Object.keys(held).sort(byCodePoint)) {
      if (!CONTRACTS_ROW_FIELDS.includes(key)) throw refuse(`it holds ${JSON.stringify(key)}, and a row holds ${CONTRACTS_ROW_FIELDS.join(', ')}`);
    }
    if (held['kind'] !== 'coverage') throw refuse(`its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" rows`);
    const path = held['path'];
    if (typeof path !== 'string' || !isRepositoryPath(path) || contractFormatOf(path) === undefined) {
      throw refuse(`its path ${JSON.stringify(path)} is no contract document of this repository: one stands under contracts/openapi, contracts/asyncapi or contracts/proto`);
    }
    const blob = held['blob'];
    if (blob !== undefined && (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob))) throw refuse(`its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits`);
    return { kind: 'coverage', path, ...(blob === undefined ? {} : { blob }) };
  });
}

// ---- one unit ------------------------------------------------------------

/** One document a unit read: its nodes, the declarations they make, the messages it carries and the gaps the reader named. */
interface DocumentRead {
  readonly nodes: readonly ExtractedNode[];
  readonly declarations: readonly { readonly contract: string; readonly member: string }[];
  readonly carries: readonly { readonly channel: string; readonly message: string; readonly topic: string }[];
  readonly channels: readonly string[];
  readonly operations: readonly { readonly key: string; readonly servers: readonly string[] }[];
  readonly gaps: readonly CoverageGap[];
}

/**
 * One unit: the contract file the unit names, read at the pinned commit, and the
 * documents its bytes write. A path the commit no longer holds publishes
 * nothing, so an earlier run's records for a file deleted or renamed away are
 * retracted by the publication itself.
 */
async function executeContractsUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const stage = staticSourceOf(unit, context);
  refuseWhenCancelled(unit, context);
  const source = stage.repository;
  const entry = await source.entry(planned.path);
  if (entry === undefined) {
    context.progress(`${planned.path} is not in the tree of ${planned.repository} at ${source.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  const file = await source.file(planned.path);
  if (file === undefined || file.unread !== undefined) {
    const reason = file === undefined ? 'inaccessible' : file.unread === 'too-large' ? 'too-large' : 'unsupported';
    writeCoverage(context, source, planned.path, { repository: planned.repository, scope: planned.path, complete: false, read: [], unread: [{ what: `${planned.path} at ${String(CONTRACTS_SOURCE.system)} ${CONTRACTS_SOURCE.version}`, reason }] }, entry.id);
    context.progress(`${planned.path} of ${planned.repository} is ${reason === 'too-large' ? 'above the static reading cap' : 'not a contract document this stage reads'}: the file is published as a ${reason} coverage gap`, 1);
    return { outcome: 'draft' };
  }
  const text = decodeText(file.content!);
  if (text === undefined) {
    writeCoverage(context, source, planned.path, { repository: planned.repository, scope: planned.path, complete: false, read: [], unread: [{ what: `${planned.path} is not UTF-8 text`, reason: 'unsupported' }] }, entry.id);
    context.progress(`${planned.path} of ${planned.repository} is not UTF-8 text: the file is published as an unsupported coverage gap`, 1);
    return { outcome: 'draft' };
  }
  const format = contractFormatOf(planned.path);
  if (format === undefined) {
    // A path this stage's own convention does not read is no unit this stage plans; the
    // refusal names the file rather than publishing a document read by a guess.
    throw new Error(`${planned.path}:1: the contracts stage planned a file it has no format for, and a contract file is one under contracts/openapi, contracts/asyncapi or contracts/proto (src/fill/stages/contracts.ts)`);
  }
  const read = readDocument(format, planned.path, text);
  const document = await withCrossFileFacts(read, planned.path, text, stage);
  const evidence = evidenceAtPlace(source, planned.path);
  const fileKey = fileFactIdOf(planned.repository, planned.path);
  for (const write of documentWrites({ repository: planned.repository, path: planned.path, fileKey, read: document, evidence })) context.draft.write(write);
  const coverage: CoverageValue = {
    repository: planned.repository,
    scope: planned.path,
    complete: document.gaps.length === 0,
    read: [planned.path],
    unread: document.gaps,
  };
  writeCoverage(context, source, planned.path, coverage, entry.id);
  context.progress(
    `read ${planned.path} of ${planned.repository} at ${source.commit}: ${String(document.nodes.length)} ${document.nodes.length === 1 ? 'record' : 'records'}, ${String(document.gaps.length)} ${document.gaps.length === 1 ? 'gap' : 'gaps'}`,
    1,
  );
  return { outcome: 'draft' };
}

/** The file's text, or none where the bytes are not UTF-8: a fatal decode names the file instead of guessing its characters. */
function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** What one contract file's reader answers: its nodes, the declarations they make and the gaps the reader named. */
function readDocument(format: 'openapi' | 'asyncapi' | 'proto', path: string, text: string): DocumentRead {
  if (format === 'openapi') {
    const { contract, gaps } = readOpenApi(path, text);
    return openApiDocument(contract, gaps, text);
  }
  if (format === 'asyncapi') {
    const { contract, gaps } = readAsyncApi(path, text);
    return asyncApiDocument(contract, gaps, text);
  }
  const { contract, gaps } = readProto(path, text);
  return protoDocument(contract, gaps, text);
}

/** An OpenAPI document's nodes and declarations, each with the place it was read at. */
function openApiDocument(contract: OpenApiContract, gaps: readonly { readonly path: string; readonly reason: string }[], text: string): DocumentRead {
  const span = wholeFileSpan(contract.path, text);
  const nodes = openApiNodes(contract).map((node) => node.kind === KIND_CONTRACT ? withPlace(node, span) : node);
  const declarations = contract.operations.map((operation) => ({
    contract: contractKey(contract.path),
    member: operationKey(contract.path, `${operation.method}:${operation.path}`),
  }));
  return {
    nodes,
    declarations,
    carries: [],
    channels: [],
    operations: contract.operations.map((operation) => ({ key: operationKey(contract.path, `${operation.method}:${operation.path}`), servers: operation.servers })),
    gaps: gaps.map((gap) => ({ what: `${gap.path}:1: ${gap.reason}`, reason: 'error' as const })),
  };
}

/** An AsyncAPI document's nodes, declarations and carried messages. */
function asyncApiDocument(contract: AsyncApiContract, gaps: readonly { readonly path: string; readonly reason: string }[], text: string): DocumentRead {
  const span = wholeFileSpan(contract.path, text);
  const nodes = asyncApiNodes(contract).map((node) => node.kind === KIND_CONTRACT ? withPlace(node, span) : node);
  const declarations: { contract: string; member: string }[] = [];
  const carries: { channel: string; message: string; topic: string }[] = [];
  const channels: string[] = [];
  for (const channel of contract.channels) {
    channels.push(channel.name);
    declarations.push({ contract: contractKey(contract.path), member: channelKey(channel.name) });
    for (const message of channel.messages) {
      declarations.push({ contract: contractKey(contract.path), member: messageKey(contract.path, message.name) });
      carries.push({ channel: channelKey(channel.name), message: messageKey(contract.path, message.name), topic: channel.name });
    }
  }
  return { nodes, declarations, carries, channels, operations: [], gaps: gaps.map((gap) => ({ what: `${gap.path}:1: ${gap.reason}`, reason: 'error' as const })) };
}

/** A proto document's nodes and declarations, each rpc an operation of its file's contract. */
function protoDocument(contract: ProtoContract, gaps: readonly { readonly path: string; readonly reason: string }[], text: string): DocumentRead {
  const span = wholeFileSpan(contract.path, text);
  const nodes = protoNodes(contract).map((node) => node.kind === KIND_CONTRACT ? withPlace(node, span) : node);
  const declarations = contract.services.flatMap((service) => service.rpcs.map((rpc) => ({
    contract: contractKey(contract.path),
    member: operationKey(contract.path, `${contract.package ?? ''}.${service.name}/${rpc.rpc}`),
  })));
  return { nodes, declarations, carries: [], channels: [], operations: [], gaps: gaps.map((gap) => ({ what: `${gap.path}:1: ${gap.reason}`, reason: 'error' as const })) };
}

/** The node a contract file's whole-document record stands at: the file's own first line to its last. */
function withPlace(node: ExtractedNode, span: SourceSpan): ExtractedNode {
  return { ...node, span };
}

/** The span of a whole file: its first line to its last, its first byte to its length. */
function wholeFileSpan(path: string, text: string): SourceSpan {
  const lines = text === '' ? 1 : text.split('\n').length;
  return { path, byteStart: 0, byteEnd: Buffer.byteLength(text, 'utf8'), lineStart: 1, lineEnd: lines };
}

// ---- the two cross-file facts a document's records carry ------------------

/**
 * The document's records with the two facts its own bytes cannot answer: an
 * operation's service, resolved from the per-file port facts by the driver's own
 * rule, and a channel's consumer fold, read from the consumes edges another file
 * published. Both are bounded reads by property.
 */
async function withCrossFileFacts(read: DocumentRead, path: string, text: string, stage: StaticStageContext): Promise<DocumentRead> {
  const span = wholeFileSpan(path, text);
  const services = new Map<string, string>();
  for (const operation of read.operations) {
    const scope = await servicesOfServers(operation.servers, stage);
    if (scope.size === 1) services.set(operation.key, [...scope][0]!);
  }
  const folds = new Map<string, { readonly consumerFound: boolean; readonly consumerStatus: string }>();
  for (const topic of read.channels) {
    const edges = await allPages((page) => stage.edgesByProperty('code.consumes', 'topic', topic, page));
    const consumers = edges.filter((edge) => edge.from.kind === 'code.symbol');
    folds.set(topic, { consumerFound: consumers.length > 0, consumerStatus: consumers.length > 0 ? 'found-in-product' : edges.length > 0 ? 'configured-consumer-function-not-resolved' : 'not-found-in-product' });
  }
  const nodes = read.nodes.map((node) => {
    if (node.kind !== KIND_CHANNEL && node.kind !== KIND_MESSAGE && node.kind !== KIND_CONTRACT) {
      return node.kind === 'code.operation' ? withService(node, services.get(node.key)) : node;
    }
    // A channel, a message and a contract carry the file's path, as the driver's own pass
    // gives it, and the file's whole-document span (madarch-m38l.16).
    const pathProperty = node.kind === KIND_MESSAGE ? messagePathOf(node) : path;
    return {
      ...node,
      properties: {
        ...node.properties,
        path: pathProperty,
        ...(node.kind === KIND_CHANNEL ? folds.get(String(node.properties['name'] ?? node.label)) ?? {} : {}),
      },
      span,
    };
  });
  return { ...read, nodes };
}

/** An operation node with the service its servers resolve to, where exactly one does. */
function withService(node: ExtractedNode, service: string | undefined): ExtractedNode {
  return service === undefined ? node : { ...node, properties: { ...node.properties, service } };
}

/** The contract path a message's key names: `code.message:<path>#<name>`. */
function messagePathOf(node: ExtractedNode): string {
  return node.key.slice(node.key.indexOf(':') + 1, node.key.lastIndexOf('#'));
}

/**
 * The services an operation's servers resolve to, by the driver's own rule: a
 * server whose hostname names a listening service is that service; otherwise a
 * local server's port that exactly one service listens on is that service. A
 * relative or variable server names none.
 */
async function servicesOfServers(servers: readonly string[], stage: StaticStageContext): Promise<Set<string>> {
  const services = new Set<string>();
  for (const server of servers) {
    let url: URL;
    try {
      url = new URL(server);
    } catch {
      continue;
    }
    if (url.hostname !== '') {
      const byName = await allPages((page) => stage.byProperty('code.listener-port', 'service', url.hostname, page));
      if (byName.length > 0) {
        services.add(url.hostname);
        continue;
      }
    }
    if (url.port !== '' && ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) {
      const byPort = await allPages((page) => stage.byProperty('code.listener-port', 'port', url.port, page));
      const listened = new Set(byPort.flatMap((node) => typeof node.properties['service'] === 'string' ? [node.properties['service'] as string] : []));
      if (listened.size === 1) services.add([...listened][0]!);
    }
  }
  return services;
}

/** Every page of one bounded read, in the order the pages answered. */
async function allPages<T>(fetch: (page: { readonly limit: number; readonly after?: string }) => Promise<{ readonly rows: readonly T[]; readonly next: string | null }>): Promise<readonly T[]> {
  const rows: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetch(after === undefined ? { limit: 256 } : { limit: 256, after });
    rows.push(...page.rows);
    if (page.next === null) return rows;
    after = page.next;
  }
}

// ---- what one unit's draft writes ----------------------------------------

/** The relation a contract's members hang from it by, the one a channel carries its messages by, and the one a file contains a node by. */
const DECLARES_RELATION = EDGE_DECLARES;
const CARRIES_RELATION = EDGE_CARRIES;
const CONTAINS_RELATION = EDGE_CONTAINS;

/** What one unit's draft writes: the document's nodes, its declarations and its containment. */
function documentWrites(input: {
  readonly repository: string;
  readonly path: string;
  readonly fileKey: string;
  readonly read: DocumentRead;
  readonly evidence: string;
}): readonly StageDraftWrite[] {
  const writes: StageDraftWrite[] = [];
  const commit = commitOf(input.evidence);
  for (const node of [...input.read.nodes].sort((left, right) => byCodePoint(left.key, right.key))) {
    const span = node.span;
    if (span === undefined) {
      throw new Error(`${input.path}:1: the contracts stage read a ${node.kind} with no span, and every contract record names the bytes it was read from (src/fill/stages/contracts.ts)`);
    }
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: node.key,
        kind: node.kind,
        label: node.label,
        properties: {
          ...node.properties,
          span: { ...span },
          recordKey: node.key,
          factKind: factKindOf(node.kind),
          layer: 'extracted',
          repository: input.repository,
          provenance: { source: CONTRACTS_SOURCE, repository: { id: input.repository, commit }, place: { file: span.path, range: { startLine: span.lineStart, startColumn: 0, endLine: span.lineEnd, endColumn: 0, startByte: span.byteStart, endByte: span.byteEnd } } },
        },
      },
    });
    writes.push(edgeWrite(CONTAINS_RELATION, input.fileKey, node.key, { span: { ...span }, discriminator: '' }, input.repository, input.evidence));
  }
  for (const declaration of input.read.declarations) writes.push(edgeWrite(DECLARES_RELATION, declaration.contract, declaration.member, { discriminator: '' }, input.repository, input.evidence));
  for (const carried of input.read.carries) writes.push(edgeWrite(CARRIES_RELATION, carried.channel, carried.message, { discriminator: '', channel: carried.topic }, input.repository, input.evidence));
  return writes;
}

/** The fact kind a document's node kind stands for. */
function factKindOf(kind: string): string {
  if (kind === KIND_CONTRACT) return 'contract';
  if (kind === KIND_CHANNEL) return 'channel';
  if (kind === KIND_MESSAGE) return 'message';
  return 'operation';
}

/** One edge write of this stage: its record's properties, its span and the discriminator the driver gives it. */
function edgeWrite(relation: string, from: string, to: string, record: { readonly span?: SourceSpan; readonly discriminator: string; readonly channel?: string }, repository: string, evidence: string): StageDraftWrite {
  return {
    kind: 'edge',
    evidence,
    value: {
      relation,
      from: { key: from },
      to: { key: to },
      properties: {
        factKind: relation.slice('code.'.length),
        layer: 'extracted',
        repository,
        discriminator: record.discriminator,
        ...(record.span === undefined ? {} : { span: { ...record.span } }),
        ...(record.channel === undefined ? {} : { channel: record.channel }),
        provenance: { source: CONTRACTS_SOURCE, repository: { id: repository, commit: commitOf(evidence) }, ...(record.span === undefined ? {} : { place: { file: record.span.path, range: { startLine: record.span.lineStart, startColumn: 0, endLine: record.span.lineEnd, endColumn: 0, startByte: record.span.byteStart, endByte: record.span.byteEnd } } }) },
      },
    },
  };
}

/** The commit the evidence text names (`<repository>@<commit>:<path>`), for a node's provenance. */
function commitOf(evidence: string): string {
  const at = evidence.indexOf('@');
  const rest = at < 0 ? evidence : evidence.slice(at + 1);
  const end = rest.indexOf(':');
  return end < 0 ? rest : rest.slice(0, end);
}

/** One file's coverage: what was read, and every place this stage could not read, with the blob the bytes stood under. */
function writeCoverage(context: StageContext, source: StaticStageSource, path: string, coverage: CoverageValue, blob: string): void {
  const fact = makeNodeFact({
    kind: 'coverage',
    layer: 'extracted',
    provenance: { source: CONTRACTS_SOURCE, repository: { id: coverage.repository, commit: source.commit } },
    value: coverage,
  });
  const evidence = evidenceAtPlace(source, path);
  for (const write of graphWritesOf(fact, evidence)) {
    context.draft.write(write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, blob } } }
      : write);
  }
}

/** The unit's static repository, refused by name where the run handed none. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageContext {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the contracts stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/contracts.ts, decision 0033)`);
  }
  return held;
}

/** A cancelled unit stops where it stands: a cancelled unit publishes nothing. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned file: a cancelled unit publishes nothing (src/fill/stages/contracts.ts)`);
  }
}
