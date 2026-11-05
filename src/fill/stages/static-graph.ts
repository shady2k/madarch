/**
 * What a static stage's private draft writes into the product's one temporal
 * graph (decision 0033's "The file is the unit of static work"; decision 0028's
 * publication). A stage writes graph items into its draft; the orchestrator's
 * one publication transaction applies them through `GraphStore.publishUnit`, so
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
 * The graph store scopes a unit's publication by the caller's unit id
 * (`publication_scope`), so `complete: true` replaces exactly what that unit
 * wrote before: a vanished file's unit publishes nothing and its node and edges
 * end, and no other file's facts move. The store allocates the generation and
 * takes the publication lock itself; this module maps a draft and no more.
 */
import type { GraphId, GraphStore, PublishUnitInput, UnitEdgeDraft, UnitNodeDraft } from '../../graph/index.js';
import type { Fact, FactKind } from '../facts.js';
import type { StageDraftSet, StageDraftWrite, StageValidation } from '../stage.js';
import { fileFactIdOf } from './syntax-facts.js';

/** The node kinds this mapping writes, by the fact kind that writes them (decision 0028's `code.*`). */
const NODE_KIND: Partial<Record<FactKind, string>> = {
  file: 'code.file',
  directory: 'code.directory',
  repository: 'code.repository',
  snapshot: 'code.commit',
  // Stage 7's commit facts are the extractors' `code.commit` too (decision 0030's history).
  commit: 'code.commit',
  symbol: 'code.symbol',
  comment: 'code.comment',
  'entry-point': 'code.entry-point',
  test: 'code.test',
  coverage: 'code.coverage',
  // Stages 2, 5 and 6 of the fill (madarch-8bdc.2.3): a package a manifest
  // declares, the environment a manifest or a compose service declares, the
  // module the clustering finds, a document and its section. `package`,
  // `module`, `env-var` and `document-section` are the extractors' own names
  // (`src/extract/code/keys.ts`, `src/extract/driver/files.ts`); a document is
  // the fill's own reading (no extractor reads one), so it is `code.document`.
  package: 'code.package',
  'environment-variable': 'code.env-var',
  module: 'code.module',
  document: 'code.document',
  section: 'code.document-section',
};

/**
 * The node kind a deploy unit is written as, by the form the manifest declares:
 * the extractors read a Dockerfile and a compose service as two kinds
 * (`code.dockerfile`, `code.compose-service`), and the fill's one fact kind
 * carries both behind its `form`.
 */
function deployUnitKind(fact: Fact): string {
  const form = String((fact.value as unknown as Record<string, unknown>)['form']);
  if (form === 'dockerfile' || form === 'image') return 'code.dockerfile';
  if (form === 'service' || form === 'compose-service') return 'code.compose-service';
  return 'code.deploy-unit';
}

/** The relation types this mapping writes, by the fact kind that writes them. */
const EDGE_RELATION: Partial<Record<FactKind, string>> = {
  contains: 'code.contains',
  defines: 'code.contains',
  import: 'code.imports',
  occurrence: 'code.occurrence',
  // Stages 2, 6 and 7 write these (madarch-8bdc.2.3): a manifest's dependency on
  // another package of the pinned tree, the environment a file or a service
  // consumes, the link a document writes to another, and the task keys a commit
  // or a document names. Each is the extractors' own name for the same relation
  // (`src/extract/operations/dependencies.ts`, `src/extract/history/commits.ts`).
  dependency: 'code.dependency',
  consumes: 'code.consumes',
  'document-link': 'code.document-link',
  'task-key': 'code.tasks',
};

/**
 * The extractor vocabulary the mapping registers before its first publication:
 * the kinds and the relation types the three static stages emit. Registering
 * one that the store already knows changes nothing.
 */
export const CODE_GRAPH_VOCABULARY: { readonly kinds: readonly string[]; readonly relations: readonly { readonly key: string; readonly positioned?: boolean }[] } = {
  kinds: [
    'code.comment', 'code.commit', 'code.compose-service', 'code.coverage', 'code.dependency', 'code.deploy-unit', 'code.directory',
    'code.dockerfile', 'code.document', 'code.document-section', 'code.entry-point', 'code.env-var', 'code.file', 'code.link-target',
    // The names a file mentions, as the file pass writes them (decision 0033, item 14;
    // `mention-graph.ts`), beside the symbols they may name.
    'code.mention', 'code.module', 'code.package', 'code.rank', 'code.repository', 'code.symbol', 'code.task', 'code.test',
  ],
  relations: [
    { key: 'code.consumes' },
    { key: 'code.contains' },
    { key: 'code.dependency' },
    { key: 'code.document-link' },
    { key: 'code.imports' },
    { key: 'code.mentions' },
    { key: 'code.occurrence', positioned: true },
    // What the resolution stage folds a mention into (decision 0026's stage 4).
    { key: 'code.references' },
    { key: 'code.tasks' },
    // What a manifest declares: one edge from the manifest's file to the dependency it names
    // (`src/extract/operations/dependencies.ts`).
    { key: 'code.uses-dependency' },
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
type StaticGraphDraft =
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
function codeGraphOfFact(fact: Fact): StaticGraphDraft[] {
  const nodeKind = fact.kind === 'deploy-unit' ? deployUnitKind(fact) : NODE_KIND[fact.kind];
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
  // A `consumes` fact names the file that declares an environment variable by its `from`
  // and the variable by its `variable`, where an edge between two facts names them by
  // `from` and `to`: one mapping, two shapes of value (decision 0033, item 7).
  const value = fact.value as { readonly from: string; readonly to?: string; readonly variable?: string };
  const to = value.to ?? value.variable;
  if (to === undefined) {
    throw new Error(`fill-static-graph: the ${fact.kind} fact ${fact.id} names no end: an edge fact holds "to", or "variable" for the variable it consumes (src/fill/stages/static-graph.ts)`);
  }
  return [{
    kind: 'edge',
    edge: {
      relation,
      from: { key: value.from },
      to: { key: to },
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

/** What one static unit's publication is made of: the unit, the stage, its publication digest and its draft writes. */
export interface StaticUnitPublication {
  readonly unitId: string;
  /** The scope the unit publishes under, where it is not the unit's id: a stage whose unit id names what it read and whose scope is the one thing it replaces (the history stage's commit range under its repository). */
  readonly scopeKey?: string;
  readonly stageId: string;
  /** The publication digest the orchestrator computed; the graph's work item carries it too, so a repeat writes nothing. */
  readonly digest: string;
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
function staticProducerOf(stageId: string): string {
  return `fill.${stageId}`;
}

/**
 * The graph store's publication input for one static unit's draft (decision
 * 0033, items 3 and 7; decision 0027's one atomic operation). The draft's
 * `node` and `edge` writes are the graph's own items; every other write kind
 * is refused here, by name, before the store is asked to publish anything.
 *
 * The caller's key is the unit's id in the fill's store: the graph store owns
 * the scope it names (`publication_scope`) and allocates the generation, so a
 * later run of the same unit publishes under the same scope. The lease covers
 * the publication's own transaction: the store's publication lock, not this
 * lease, is what fences two publishers of one unit.
 */
export function staticUnitPublicationOf(input: StaticUnitPublication): PublishUnitInput {
  const nodes: UnitNodeDraft[] = [];
  const edges: UnitEdgeDraft[] = [];
  for (const [index, write] of input.writes.entries()) {
    if (write.kind === 'node') {
      nodes.push({ key: write.value.key, kind: write.value.kind, label: write.value.label, properties: { ...write.value.properties } });
      continue;
    }
    if (write.kind === 'edge') {
      edges.push({
        relation: write.value.relation,
        from: write.value.from,
        to: write.value.to,
        ...(write.value.properties === undefined ? {} : { properties: { ...write.value.properties } }),
        ...(write.value.position === undefined ? {} : { position: write.value.position }),
      });
      continue;
    }
    throw new Error(`src/fill/stages/static-graph.ts:319: write ${index + 1} of unit ${JSON.stringify(input.unitId)} of stage ${JSON.stringify(input.stageId)} is a "${write.kind}" write, and a static unit publishes graph nodes and edges only; full path ${import.meta.dir}/static-graph.ts`);
  }
  return {
    producer: staticProducerOf(input.stageId),
    scopeKey: input.scopeKey ?? input.unitId,
    inputDigest: input.digest,
    leaseToken: `fill-static:${input.digest}`,
    leaseUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    nodes,
    edges,
  };
}
