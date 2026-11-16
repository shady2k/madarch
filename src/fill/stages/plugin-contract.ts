/**
 * The table a manifest kind declares for itself (decision 0034, item 14 and
 * decision 0035, items 17 and 18): each field of a kind in `madarch/catalog.yaml`
 * names its producer — a plugin field (`glossary@1.definition`) or the agent with
 * a description — and the kind's fields and key build the kind's table. No code
 * per kind: the engine reads the declarations, the plugin's own contract supplies
 * each bound field's type, and the key fields name the entity.
 *
 * Every field of the kind is a column of its opinion table (A3 of the 2026-11-10
 * amendment), its key fields among the declarations but not among the columns: the
 * key stands once in the vertex (`node.key`). A kind no declaration fills — a
 * document kind whose entities only the agent writes — is no part of this
 * contract, and no table stands for it.
 */
import { generatedTableName, type EdgeContract, type FieldContract, type GraphContract, type VertexContract } from '../../graph/contract.js';
import type { GeneratedEdgeRead, GeneratedKindRead } from '../../knowledge/graph-read.js';
import { deferredEdgesOf, pageTemplateKind, type KindsManifest } from '../../product/manifest/kinds.js';
import { cataloguePageTemplate } from '../../knowledge/page-template-kind.js';
import { fillKindsOf, planFillDeclarations } from '../../plugin/fill-declarations.js';

/**
 * The vertex tables a manifest's own declarations make: one for every kind whose
 * fields name a producer, with every bound field as a column of its opinion table,
 * one row per opinion of each.
 */
export function manifestContractOf(manifest: KindsManifest): GraphContract {
  const vertex: VertexContract[] = [];
  for (const kind of manifest.kinds.values()) {
    // Every kind the product takes has its table (owner's rule, 2026-11-13): the agent through MCP is a producer of
    // any kind, so a kind that declares no fields still holds its key and the label its page is named by. A kind with
    // no key is a kind of entities a producer makes with a random identity (the amendment, point 2).
    const keyFields = kind.key ?? [];
    const fields: FieldContract[] = [];
    let capability = '';
    for (const field of kind.fields ?? []) {
      if (field.binding?.kind === 'plugin') capability = capability === '' ? field.binding.plugin : capability;
      fields.push({ name: field.name, type: field.type, ...('valueType' in field && field.valueType !== undefined ? { valueType: field.valueType as string } : {}), ...(field.schema === undefined ? {} : { schema: field.schema }), ...(field.nullable === true ? { nullable: true } : {}) });
    }
    // A kind that declares no field still has a table, and it holds the label its page is named by.
    if (fields.length === 0) fields.push({ name: kind.title ?? 'label', type: 'text', nullable: true });
    vertex.push({ ...(kind.duplicateSubjectEdge===undefined?{}:{duplicateSubjectEdge:kind.duplicateSubjectEdge}), ...(kind.semantics==='term'?{duplicateSubjectRequired:true}:{}), ...(kind.evidence === undefined ? {} : { evidence: kind.evidence }), ...(kind.contractUid === undefined ? {} : { contractUid: kind.contractUid }), ...(kind.identity === undefined ? {} : { identity: kind.identity }), name: kind.name, table: generatedTableName(kind.name, 'vertex'), fields, key: keyFields, ...(kind.keyEdges === undefined ? {} : { keyEdges: kind.keyEdges }), capability: kind.systemBase === undefined ? (capability === '' ? 'agent' : capability) : 'system' });
  }
  if (pageTemplateKind(manifest) === undefined) {
    const fallback = cataloguePageTemplate();
    if (!vertex.some(kind => kind.name === fallback.name)) vertex.push(fallback.vertex);
  }
  return { vertex, edge: edgeContractsOf(manifest), dictionary: [], ...(manifest.valueTypes === undefined ? {} : { valueTypes: manifest.valueTypes }) };
}

/**
 * The edge tables a manifest's own edge declarations and their plugin's contract make (decision 0035, items 7 and 18):
 * an edge whose capability names a plugin that declares that edge kind takes the plugin's fields as its columns, and the
 * manifest states its ends, whether it repeats and what tells its repeats apart.
 */
function edgeContractsOf(manifest: KindsManifest): EdgeContract[] {
  const edges: EdgeContract[] = [];
  const deferred = new Set(deferredEdgesOf(manifest));
  for (const edge of [...(manifest.edges?.values() ?? [])].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (deferred.has(edge)) continue;
    // Every declared edge kind has its table (owner's rule, 2026-11-13): a plugin's contract supplies the attributes it
    // fills, and an edge no plugin fills keeps the attributes its own declaration names.
    const plugin = edge.capability === undefined ? undefined : manifest.plugins?.get(edge.capability);
    const declared = plugin?.contract?.edges.find((one) => one.kind === edge.name);
    const fields: FieldContract[] = declared !== undefined
      ? (declared.fields ?? []).map((field) => ({ name: field.name, type: field.type, ...('valueType' in field && field.valueType !== undefined ? { valueType: field.valueType as string } : {}), ...(field.schema === undefined ? {} : { schema: field.schema }), ...(field.required ? {} : { nullable: true }) }))
      : edge.fields.map((field) => ({ name: field.name, type: field.type, ...('valueType' in field && field.valueType !== undefined ? { valueType: field.valueType as string } : {}), ...(field.schema === undefined ? {} : { schema: field.schema }), ...(field.nullable === true ? { nullable: true } : {}) }));
    edges.push({
      // Every declared edge keeps an opinion table, even with no fields of its own: the table holds the statement that
      // the edge exists and who made it, which is what a complete answer is compared with and removed by.
      ...(edge.contractUid === undefined ? {} : { contractUid: edge.contractUid }), name: edge.name,
      table: generatedTableName(edge.name, 'edge'),
      cardinality: edge.cardinality,
      labels: edge.labels,
      from: edge.from,
      to: edge.to,
      repeats: edge.repeats,
      ...(edge.discriminator === undefined ? {} : { discriminator: edge.discriminator }),
      fields,
      capability: edge.capability ?? 'manifest',
    });
  }
  return edges;
}

/**
 * The manifest-declared kinds a reader reads, with the table each declaration made: the columns its opinions state,
 * the types they are stored as and the natural key. This is the whole of what a reader needs to answer one of these
 * kinds' vertices, and no kind's name stands in it.
 */
export function declaredKindReads(manifest: KindsManifest): Map<string, GeneratedKindRead> {
  const reads = new Map<string, GeneratedKindRead>();
  const plan = planFillDeclarations({
    kinds: fillKindsOf(manifest),
    plugins: [...(manifest.plugins?.values() ?? [])].flatMap((plugin) => plugin.declaration === undefined ? [] : [{ manifest: plugin.declaration, file: plugin.declarationFile ?? manifest.file, text: plugin.declarationText }]),
    selectedKinds: [],
  });
  for (const vertex of graphContractOf(manifest).vertex) {
    const columns = vertex.fields.filter((field) => !vertex.key.includes(field.name)).map((field) => field.name);
    const types = Object.fromEntries(vertex.fields.map((field) => [field.name, field.type]));
    reads.set(vertex.name, { kind: vertex.name, table: vertex.table, columns, types, key: vertex.key, ...(vertex.keyEdges === undefined ? {} : { keyEdges: vertex.keyEdges }),
      producers: Object.fromEntries(columns.map((field) => [field, plan.declaredProducers(vertex.name, field)])),
    });
  }
  return reads;
}

/**
 * The edge kinds a reader reads, with the table each declaration made: the columns, their types and the ends the
 * manifest states. A kind with no fields has no table of its own and answers from the `edge` row alone.
 */
export function declaredEdgeReads(manifest: KindsManifest): Map<string, GeneratedEdgeRead> {
  const reads = new Map<string, GeneratedEdgeRead>();
  for (const edge of edgeContractsOf(manifest)) {
    reads.set(edge.name, {
      kind: edge.name,
      ...(edge.table === undefined ? {} : { table: edge.table }),
      columns: edge.fields.map((field) => field.name),
      types: Object.fromEntries(edge.fields.map((field) => [field.name, field.type])) as GeneratedEdgeRead['types'],
      from: edge.from,
      to: edge.to,
    });
  }
  return reads;
}

/** The graph contract is exactly the product's ordinary declarations. */
export function graphContractOf(manifest: KindsManifest): GraphContract {
  return manifestContractOf(manifest);
}
