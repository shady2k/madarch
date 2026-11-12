/**
 * The table a manifest kind declares for itself (decision 0034, item 14 and
 * decision 0035, items 17 and 18): each field of a kind in `madarch/kinds.yaml`
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
import type { FieldDecl, KindsManifest } from '../../product/manifest/kinds.js';
import { planFillDeclarations } from '../../plugin/fill-declarations.js';

/** The field's type and where it takes a reference, as its declared producer states them or the manifest declares them. */
function resolved(field: FieldDecl): { type: FieldContract['type']; reference?: string } {
  return { type: field.type, ...(field.reference === undefined ? {} : { reference: field.reference }) };
}

/**
 * The vertex tables a manifest's own declarations make: one for every kind whose
 * fields name a producer, with every bound field as a column of its opinion table,
 * one row per opinion of each.
 */
export function manifestContractOf(manifest: KindsManifest): GraphContract {
  const vertex: VertexContract[] = [];
  for (const kind of manifest.kinds.values()) {
    // A kind with no key is a kind of entities a producer makes with a random identity (the amendment, point 2).
    if (kind.fields === undefined) continue;
    const keyFields = kind.key ?? [];
    const fields: FieldContract[] = [];
    let bound = false;
    let capability = '';
    for (const field of kind.fields) {
      const held = resolved(field);
      if (held === undefined) continue;
      bound = true;
      if (field.binding?.kind === 'plugin') capability = capability === '' ? field.binding.plugin : capability;
      fields.push({ name: field.name, type: held.type, ...(field.nullable === true ? { nullable: true } : {}), ...(held.reference === undefined ? {} : { reference: held.reference }) });
    }
    // A kind whose key has no declaration makes no table: a producer must be able to name the entity it writes about.
    if (!bound || !keyFields.every((field) => fields.some((held) => held.name === field))) continue;
    vertex.push({ name: kind.name, table: generatedTableName(kind.name, 'vertex'), fields, key: keyFields, capability: capability === '' ? 'agent' : capability });
  }
  return { vertex, edge: edgeContractsOf(manifest), dictionary: [] };
}

/**
 * The edge tables a manifest's own edge declarations and their plugin's contract make (decision 0035, items 7 and 18):
 * an edge whose capability names a plugin that declares that edge kind takes the plugin's fields as its columns, and the
 * manifest states its ends, whether it repeats and what tells its repeats apart.
 */
function edgeContractsOf(manifest: KindsManifest): EdgeContract[] {
  const edges: EdgeContract[] = [];
  for (const edge of [...(manifest.edges?.values() ?? [])].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (edge.capability === undefined) continue;
    const plugin = manifest.plugins?.get(edge.capability);
    const declared = plugin?.contract?.edges.find((one) => one.kind === edge.name);
    if (declared === undefined) continue;
    const fields: FieldContract[] = declared.fields?.map((field) => ({ name: field.name, type: field.type, ...(field.required ? {} : { nullable: true }) })) ?? [];
    edges.push({
      // Every declared edge keeps an opinion table, even with no fields of its own: the table holds the statement that
      // the edge exists and who made it, which is what a complete answer is compared with and removed by.
      name: edge.name,
      table: generatedTableName(edge.name, 'edge'),
      from: edge.from,
      to: edge.to,
      repeats: edge.repeats,
      ...(edge.discriminator === undefined ? {} : { discriminator: edge.discriminator }),
      fields,
      capability: edge.capability,
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
    kinds: [...manifest.kinds.values()].map((kind) => ({ name: kind.name, fields: (kind.fields ?? []).map((field) => field.name), file: manifest.file, line: kind.line, derivesFrom: kind.derivesFrom })),
    plugins: [...(manifest.plugins?.values() ?? [])].flatMap((plugin) => plugin.declaration === undefined ? [] : [{ manifest: plugin.declaration, file: plugin.declarationFile ?? manifest.file, text: plugin.declarationText }]),
    selectedKinds: [],
  });
  const storage = manifestContractOf(manifest);
  for (const kind of manifest.kinds.values()) {
    const vertex = storage.vertex.find((held) => held.name === kind.name);
    if (vertex === undefined) continue;
    const columns = vertex.fields.filter((field) => !vertex.key.includes(field.name)).map((field) => field.name);
    const types = Object.fromEntries(vertex.fields.map((field) => [field.name, field.type]));
    reads.set(kind.name, { kind: kind.name, table: vertex.table, columns, types, key: vertex.key,
      producers: Object.fromEntries(columns.map((field) => [field, plan.declaredProducers(kind.name, field)])),
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
