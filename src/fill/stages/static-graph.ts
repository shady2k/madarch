/**
 * What a static stage's private draft writes into the product's one temporal
 * graph (decision 0033's "The file is the unit of static work"; decision 0028's
 * publication). A stage writes graph items into its draft; the orchestrator's
 * one publication transaction applies them through `GraphStore.publish`, so
 * nothing of the stage reaches a database on its own.
 *
 * Item 7 of decision 0033 keeps two vocabularies. The stages construct facts in
 * the fill's own vocabulary (`src/fill/facts.ts`) because that vocabulary is
 * the extractors' reading of a file. This module is the versioned mapping from
 * that vocabulary to the extractors' `code.*` graph vocabulary: a `file` fact
 * becomes a `code.file` node, an `import` edge becomes `code.imports`, and an
 * `occurrence` fact becomes the positioned `code.occurrence` edge the store
 * already knows. Every graph node carries the fact's id as its `recordKey`, so
 * the next run finds the same node by the same key and corrects it instead of
 * opening a second identity.
 *
 * A unit's publication is scoped to the unit (a bare identity from
 * `graph-scope.ts`), so `complete: true` replaces exactly what that unit wrote
 * before: a vanished file's unit publishes nothing and its node and edges end,
 * and no other file's facts move.
 */
import { byCodePoint } from '../../model/order.js';
import type { GraphId, GraphStore, PublishEdge, PublishNode } from '../../graph/index.js';
import type { OuterTransaction } from '../../history/types.js';
import type { SqlExecutor } from '../../query/sql-driver.js';
import type { Fact, FactKind } from '../facts.js';
import type { StageDraftSet, StageDraftWrite, StageValidation } from '../stage.js';
import { staticScopeOf } from './graph-scope.js';
import { fileFactIdOf } from './syntax-facts.js';

/** The node kinds this mapping writes, by the fact kind that writes them (decision 0028's `code.*`). */
const NODE_KIND: Partial<Record<FactKind, string>> = {
  file: 'code.file',
  directory: 'code.directory',
  repository: 'code.repository',
  snapshot: 'code.commit',
  symbol: 'code.symbol',
  comment: 'code.comment',
  'entry-point': 'code.entry-point',
  test: 'code.test',
  coverage: 'code.coverage',
};

/** The relation types this mapping writes, by the fact kind that writes them. */
const EDGE_RELATION: Partial<Record<FactKind, string>> = {
  contains: 'code.contains',
  defines: 'code.contains',
  import: 'code.imports',
  occurrence: 'code.occurrence',
};

/**
 * The extractor vocabulary the mapping registers before its first publication:
 * the kinds and the relation types the three static stages emit. Registering
 * one that the store already knows changes nothing.
 */
export const CODE_GRAPH_VOCABULARY: { readonly kinds: readonly string[]; readonly relations: readonly { readonly key: string; readonly positioned?: boolean }[] } = {
  kinds: ['code.comment', 'code.commit', 'code.coverage', 'code.directory', 'code.entry-point', 'code.file', 'code.repository', 'code.symbol', 'code.test'],
  relations: [
    { key: 'code.contains' },
    { key: 'code.imports' },
    { key: 'code.occurrence', positioned: true },
  ],
};

/** One end of a draft edge: a node of the same draft, by key, or a node already in the graph, by key. */
export type StaticEnd = { readonly key: string } | { readonly id: GraphId };

/** One node a static stage's draft writes. `key` is the fact id the next run asks the graph by. */
export interface StaticNodeDraft {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** One edge a static stage's draft writes; both ends are named by a key the publication resolves. */
export interface StaticEdgeDraft {
  readonly relation: string;
  readonly from: StaticEnd;
  readonly to: StaticEnd;
  readonly properties?: Readonly<Record<string, unknown>>;
  /** The byte span of a positioned occurrence; absent for a relation type the store does not position. */
  readonly position?: { readonly start: number; readonly end: number };
}

/** One graph item a stage writes into its draft. */
export type StaticGraphDraft =
  | { readonly kind: 'node'; readonly node: StaticNodeDraft }
  | { readonly kind: 'edge'; readonly edge: StaticEdgeDraft };

/** The label a node is shown by: the fact's most readable name, never an id unless it has none. */
function labelOf(fact: Fact): string {
  const value = fact.value as unknown as Record<string, unknown>;
  switch (fact.kind) {
    case 'file':
    case 'directory':
      return String(value['path']);
    case 'symbol':
      return String(value['qualifiedName']);
    case 'repository':
      return String(value['repository']);
    case 'snapshot':
      return `${String(value['repository'])}@${String(value['commit'])}`;
    case 'coverage':
      return `${String(value['repository'])}:${String(value['scope'])}`;
    case 'comment': {
      const text = String(value['text']);
      const first = text.split('\n')[0]!.trim();
      return first === '' ? fact.id : first;
    }
    case 'entry-point':
    case 'test':
      return String(value['name']);
    default:
      return fact.id;
  }
}

/** The properties a node carries: the fact's whole value, its kind, its layer and the provenance it was read with. */
function propertiesOf(fact: Fact): Record<string, unknown> {
  return {
    ...(fact.value as unknown as Record<string, unknown>),
    recordKey: fact.id,
    factKind: fact.kind,
    layer: fact.layer,
    status: fact.status,
    provenance: fact.provenance,
  };
}

/** The key of the file a place stands in: the inventory's own file fact id, which is the snapshot's node key. */
function fileKeyOf(fact: Fact): string {
  const place = fact.provenance.place;
  if (place === undefined) {
    throw new Error(`fill-static-graph: the ${fact.kind} fact ${fact.id} cites no place, so no file key names the file its occurrence stands in (src/fill/stages/static-graph.ts)`);
  }
  return fileFactIdOf(fact.provenance.repository.id, place.file);
}

/** One fact's graph items: a node for a node kind, an edge for an edge kind, and the positioned occurrence for a mention. */
export function codeGraphOfFact(fact: Fact): StaticGraphDraft[] {
  const nodeKind = NODE_KIND[fact.kind];
  if (nodeKind !== undefined) {
    return [{ kind: 'node', node: { key: fact.id, kind: nodeKind, label: labelOf(fact), properties: propertiesOf(fact) } }];
  }
  const relation = EDGE_RELATION[fact.kind];
  if (relation === undefined) {
    throw new Error(`fill-static-graph: the ${fact.kind} fact ${fact.id} has no entry in the mapping to the extractor vocabulary: a static stage writes only the kinds this module maps (decision 0033, item 7; src/fill/stages/static-graph.ts)`);
  }
  if (fact.kind === 'occurrence') {
    const value = fact.value as { readonly symbol: string; readonly roles: readonly string[] };
    const range = fact.provenance.place?.range;
    if (range?.startByte === undefined || range.endByte === undefined) {
      throw new Error(`fill-static-graph: the occurrence fact ${fact.id} carries no byte span, and code.occurrence is a positioned relation: the syntax stage's own span gives one (src/fill/stages/static-graph.ts)`);
    }
    return [{
      kind: 'edge',
      edge: {
        relation,
        from: { key: fileKeyOf(fact) },
        to: { key: value.symbol },
        position: { start: range.startByte, end: range.endByte },
        properties: { ...propertiesOf(fact), repository: fact.provenance.repository.id, roles: [...value.roles], symbol: value.symbol, file: fact.provenance.place!.file },
      },
    }];
  }
  const value = fact.value as { readonly from: string; readonly to: string };
  return [{
    kind: 'edge',
    edge: {
      relation,
      from: { key: value.from },
      to: { key: value.to },
      properties: { ...propertiesOf(fact), repository: fact.provenance.repository.id },
    },
  }];
}

/** The draft writes one fact makes, each citing the bytes it stands on. */
export function graphWritesOf(fact: Fact, evidence: string): StageDraftWrite[] {
  return codeGraphOfFact(fact).map((item) => (item.kind === 'node'
    ? { kind: 'node' as const, evidence, value: item.node }
    : { kind: 'edge' as const, evidence, value: item.edge }));
}

/** A non-empty text, or the error naming the path that must hold one. */
function textAt(value: unknown, path: string, stageId: string, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`the ${stageId} stage's ${where} names ${JSON.stringify(value)} at ${path}, and this is a non-empty text (src/fill/stages/static-graph.ts)`);
  }
  return value;
}

/** One end of a draft edge, read: exactly one of a key and an id, as a non-empty text. */
function endAt(value: StaticEnd | undefined, path: string, stageId: string, where: string): StaticEnd {
  if (value === null || typeof value !== 'object') {
    throw new Error(`the ${stageId} stage's ${where} names ${JSON.stringify(value)} at ${path}, and an edge end is an object with one of "key" and "id" (src/fill/stages/static-graph.ts)`);
  }
  const keys = Object.keys(value).filter((key) => key === 'key' || key === 'id');
  if (keys.length !== 1 || Object.keys(value).length !== 1) {
    throw new Error(`the ${stageId} stage's ${where} names ${JSON.stringify(value)} at ${path}, and an edge end holds exactly one of "key" and "id" (src/fill/stages/static-graph.ts)`);
  }
  const held = (value as Record<string, unknown>)[keys[0]!];
  textAt(held, `${path}.${keys[0]}`, stageId, where);
  return value;
}

/**
 * Reads a static stage's draft back: every write is a graph item of a fact kind
 * the stage declares it produces, every node has a unique key and every edge
 * unique ends, and every text the graph will hold is one it can hold. Every
 * error names the stage, the write, what it cites and the path inside the item.
 */
export function checkStaticGraphDraft(stageId: string, kinds: readonly string[], draft: StageDraftSet): StageValidation {
  const errors: string[] = [];
  const nodeKeys = new Set<string>();
  const edgeKeys = new Set<string>();
  draft.writes.forEach((write, index) => {
    const at = `write ${index + 1} (${write.evidence})`;
    if (write.kind !== 'node' && write.kind !== 'edge') {
      errors.push(`${at}: the ${stageId} stage writes graph nodes and edges, and a "${write.kind}" write is not one`);
      return;
    }
    try {
      if (write.kind === 'node') {
        const node = write.value;
        const key = textAt(node.key, `${at}.key`, stageId, at);
        textAt(node.kind, `${at}.kind`, stageId, at);
        textAt(node.label, `${at}.label`, stageId, at);
        if (!node.kind.startsWith('code.')) {
          errors.push(`${at}: the ${stageId} stage's node kind ${JSON.stringify(node.kind)} is not an extractor kind: every static node stands under "code." (decision 0033, item 7)`);
        }
        if (!kinds.includes(String((node.properties as Record<string, unknown>)['factKind']))) {
          errors.push(`${at}: the ${stageId} stage does not produce a "${String((node.properties as Record<string, unknown>)['factKind'])}" fact: it produces ${kinds.join(', ')}`);
        }
        if (nodeKeys.has(key)) errors.push(`${at}: the node key ${JSON.stringify(key)} stands in an earlier write of this draft: one draft names one node by one key`);
        nodeKeys.add(key);
        return;
      }
      const edge = write.value;
      textAt(edge.relation, `${at}.relation`, stageId, at);
      if (!edge.relation.startsWith('code.')) {
        errors.push(`${at}: the ${stageId} stage's relation ${JSON.stringify(edge.relation)} is not an extractor relation: every static edge stands under "code." (decision 0033, item 7)`);
      }
      const from = endAt(edge.from, `${at}.from`, stageId, at);
      const to = endAt(edge.to, `${at}.to`, stageId, at);
      if (edge.position !== undefined) {
        const { start, end } = edge.position;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
          errors.push(`${at}: the byte span [${String(start)}, ${String(end)}) is no span: 0 <= start < end (decision 0028)`);
        }
      }
      const identity = JSON.stringify([edge.relation, from, to, edge.position ?? null]);
      if (edgeKeys.has(identity)) errors.push(`${at}: the edge ${identity} stands in an earlier write of this draft: one draft names one edge once`);
      edgeKeys.add(identity);
      if (!kinds.includes(String((edge.properties as Record<string, unknown> | undefined)?.['factKind']))) {
        errors.push(`${at}: the ${stageId} stage does not produce a "${String((edge.properties as Record<string, unknown> | undefined)?.['factKind'])}" fact: it produces ${kinds.join(', ')}`);
      }
    } catch (error) {
      errors.push(`${at}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** What one static unit's publication is made of: the unit, the stage, its generation, its digest and its draft writes. */
export interface StaticUnitPublication {
  readonly unitId: string;
  readonly stageId: string;
  readonly generation: number;
  /** The publication digest the orchestrator computed; the graph's work item carries it too, so a repeat writes nothing. */
  readonly digest: string;
  /** The valid time the graph records for these versions; the caller's clock when it names none. */
  readonly validFrom?: string;
  readonly writes: readonly StageDraftWrite[];
}

/**
 * Creates the 0028 graph's tables and registers the extractor vocabulary once
 * per process: a second call changes nothing. It is a write, so it runs before
 * a run plans, never inside a publication's transaction.
 */
export async function ensureGraphSchema(store: GraphStore): Promise<void> {
  await store.createSchema();
  await store.registerCodeSchema(CODE_GRAPH_VOCABULARY);
}

/** The graph producer one static stage publishes under. */
export function staticProducerOf(stageId: string): string {
  return `fill.${stageId}`;
}

/**
 * The publication's executor as the store's outer transaction: the orchestrator
 * hands the apply step an `SqlExecutor`, and the graph's reads and writes take
 * the same `{ query }` shape under the store's own row type.
 */
export function outerTransactionOf(executor: SqlExecutor): OuterTransaction {
  return {
    query: async <Row extends object>(sql: string, values?: readonly unknown[]) => await executor.query<Row & Record<string, unknown>>(sql, values),
  };
}

/**
 * Applies one static unit's draft to the 0028 graph, inside the transaction the
 * orchestrator opened for its publication: the same atomic operation that
 * settles the queue job and writes the unit's events, so the graph and the
 * fill's state move together or not at all.
 *
 * The unit publishes under its own stable scope, with `complete: true`: every
 * version of this unit's producer and scope that the draft does not repeat
 * ends. A file deleted from the tree therefore retracts exactly its own node
 * and edges, and no other unit's facts move.
 */
export async function publishStaticUnit(executor: OuterTransaction, store: GraphStore, input: StaticUnitPublication): Promise<number> {
  const nodes = input.writes.filter((write): write is Extract<StageDraftWrite, { kind: 'node' }> => write.kind === 'node').map((write) => write.value);
  const edges = input.writes.filter((write): write is Extract<StageDraftWrite, { kind: 'edge' }> => write.kind === 'edge').map((write) => write.value);
  if (nodes.length !== input.writes.length - edges.length) {
    const wrong = input.writes.find((write) => write.kind !== 'node' && write.kind !== 'edge');
    throw new Error(`fill-static-graph: unit ${JSON.stringify(input.unitId)} of stage ${JSON.stringify(input.stageId)} submitted a "${String(wrong?.kind)}" write, and a static unit publishes graph nodes and edges only (src/fill/stages/static-graph.ts)`);
  }
  const producer = staticProducerOf(input.stageId);
  const scope = await staticScopeOf(executor, store, input.unitId);
  // One generation per publication under this unit's own scope. The advisory lock is the one the store's
  // publication takes, so two publishers of one unit cannot allocate one generation twice.
  await executor.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`graph-publication:${producer}:${scope}`]);
  const generationRow = await executor.query<{ g: string }>(
    'SELECT (coalesce(max(generation), 0) + 1)::text AS g FROM work_item WHERE producer = $1 AND scope_id = $2::bigint',
    [producer, scope],
  );
  const generation = Number(generationRow.rows[0]!.g);
  const leaseToken = `fill-static:${input.digest}`;
  const leaseUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await store.openWorkItem({ producer, scope, generation, inputDigest: input.digest, leaseToken, leaseUntil }, executor);

  const validFrom = input.validFrom ?? new Date().toISOString();
  // A node the unit published before keeps its identity: the graph corrects it instead of opening a second
  // node with one key. A key that names more than one current node is a corrupt graph, never a choice.
  const held = new Map<string, GraphId>();
  for (const node of nodes) {
    const page = await store.byKey(node.key, { limit: 2 }, executor);
    if (page.rows.length > 1) {
      throw new Error(`fill-static-graph: unit ${JSON.stringify(input.unitId)} of stage ${JSON.stringify(input.stageId)} writes the key ${JSON.stringify(node.key)}, and ${String(page.rows.length)} current nodes carry it: one key names one node (src/fill/stages/static-graph.ts)`);
    }
    const found = page.rows[0];
    if (found !== undefined) held.set(node.key, found.nodeId);
  }
  const drafted = new Set(nodes.map((node) => node.key));
  const endpoint = async (end: StaticEnd, where: string): Promise<{ id: GraphId } | { ref: string }> => {
    if ('id' in end) return { id: end.id };
    if (drafted.has(end.key)) return { ref: end.key };
    const page = await store.byKey(end.key, { limit: 2 }, executor);
    if (page.rows.length === 0) {
      throw new Error(`fill-static-graph: unit ${JSON.stringify(input.unitId)} of stage ${JSON.stringify(input.stageId)} writes ${where} to the key ${JSON.stringify(end.key)}, and no node in the graph carries it: an edge joins nodes that exist (decision 0028; src/fill/stages/static-graph.ts)`);
    }
    if (page.rows.length > 1) {
      throw new Error(`fill-static-graph: unit ${JSON.stringify(input.unitId)} of stage ${JSON.stringify(input.stageId)} writes ${where} to the key ${JSON.stringify(end.key)}, and ${String(page.rows.length)} current nodes carry it: one key names one node (src/fill/stages/static-graph.ts)`);
    }
    return { id: page.rows[0]!.nodeId };
  };

  // Deterministic order: two runs of one draft publish the same rows in the same order, so a replay is the
  // same input digest and writes nothing.
  const publishNodes: PublishNode[] = [...nodes]
    .sort((left, right) => byCodePoint(left.key, right.key))
    .map((node) => ({
      ref: node.key,
      ...(held.has(node.key) ? { id: held.get(node.key)! } : {}),
      kind: node.kind,
      label: node.label,
      properties: { ...node.properties },
      validFrom,
    }));
  const publishEdges: PublishEdge[] = [];
  for (const edge of [...edges].sort((left, right) => byCodePoint(JSON.stringify([left.relation, left.from, left.to, left.position ?? null]), JSON.stringify([right.relation, right.from, right.to, right.position ?? null])))) {
    const where = `edges to ${JSON.stringify([edge.relation, edge.from, edge.to])}`;
    publishEdges.push({
      relation: edge.relation,
      src: await endpoint(edge.from, where),
      dst: await endpoint(edge.to, where),
      ...(edge.position === undefined ? {} : { position: { start: edge.position.start, end: edge.position.end } }),
      ...(edge.properties === undefined ? {} : { properties: { ...edge.properties } }),
      validFrom,
    });
  }
  await store.publish({ producer, scope, generation, leaseToken, inputDigest: input.digest, nodes: publishNodes, edges: publishEdges, complete: true }, executor);
  return nodes.length + edges.length;
}
