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
import { canonicalGitKind, gitContractOf } from './git-contract.js';
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
  const native = gitContractOf(manifest);
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
    const storageName = canonicalGitKind(manifest, kind.name);
    const storage = native.vertex.find((held) => held.name === storageName);
    if (storage !== undefined) {
      vertex.push({ ...storage, fields: [...storage.fields, ...fields.filter((field) => !storage.fields.some((held) => held.name === field.name))].map((field) => ({ ...field, ...(field.reference === undefined ? {} : { reference: canonicalGitKind(manifest, field.reference) }) })) });
    } else {
      vertex.push({ name: kind.name, table: generatedTableName(kind.name, 'vertex'), fields: fields.map((field) => ({ ...field, ...(field.reference === undefined ? {} : { reference: canonicalGitKind(manifest, field.reference) }) })), key: keyFields, capability: capability === '' ? 'agent' : capability });
    }
  }
  // The path index evidence names is mechanism state (`src/graph/one-graph.ts`), not a kind the manifest declares.
  return { vertex, edge: edgeContractsOf(manifest), dictionary: [] };
}

/**
 * The edge tables a manifest's own edge declarations and their plugin's contract make (decision 0035, items 7 and 18):
 * an edge whose capability names a plugin that declares that edge kind takes the plugin's fields as its columns, and the
 * manifest states its ends, whether it repeats and what tells its repeats apart. An edge a capability fills in the
 * engine's own contract (git's) is no part of this one.
 */
function edgeContractsOf(manifest: KindsManifest): EdgeContract[] {
  const edges: EdgeContract[] = [];
  for (const edge of [...(manifest.edges?.values() ?? [])].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (edge.capability === undefined) continue;
    const plugin = manifest.plugins?.get(edge.capability);
    const declared = plugin?.contract?.edges.find((one) => one.kind === edge.name);
    if (declared === undefined) continue;
    const fields: FieldContract[] = declared.fields?.map((field) => ({ name: field.name, type: field.type, ...(field.required ? {} : { nullable: true }) })) ?? [];
    // The manifest names a kind the wiki shows (`code.file`); the graph's kind of a git kind is its name without the prefix.
    const graphKinds = (names: readonly string[]): string[] => names.map((name) => canonicalGitKind(manifest, name));
    edges.push({
      // Every declared edge keeps an opinion table, even with no fields of its own: the table holds the statement that
      // the edge exists and who made it, which is what a complete answer is compared with and removed by.
      name: edge.name,
      table: generatedTableName(edge.name, 'edge'),
      from: graphKinds(edge.from),
      to: graphKinds(edge.to),
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
    const vertex = storage.vertex.find((held) => held.name === canonicalGitKind(manifest, kind.name));
    if (vertex === undefined) continue;
    const columns = vertex.fields.filter((field) => !vertex.key.includes(field.name)).map((field) => field.name);
    const types = Object.fromEntries(vertex.fields.map((field) => [field.name, field.type]));
    reads.set(kind.name, { kind: kind.name, table: vertex.table, columns, types, key: vertex.key,
      producers: Object.fromEntries(columns.map((field) => [field, plan.producers(kind.name, field)])),
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

/** The two declarations of one contract, their kinds and dictionaries stated once each. */
function merge(left: GraphContract, right: GraphContract): GraphContract {
  const vertex = [...left.vertex];
  for (const kind of right.vertex) {
    const index = vertex.findIndex((held) => held.name === kind.name);
    if (index < 0) vertex.push(kind);
    else vertex[index] = kind;
  }
  const edge = [...left.edge];
  for (const kind of right.edge) if (!edge.some((held) => held.name === kind.name)) edge.push(kind);
  const dictionary = [...left.dictionary];
  for (const one of right.dictionary) if (!dictionary.some((held) => held.name === one.name)) dictionary.push(one);
  return { vertex, edge, dictionary };
}

/**
 * The whole contract a product's manifest makes: the code kinds its `capability`
 * declarations bind to the git reader, and the tables its own field bindings
 * declare. A product that declares neither gets no table at all.
 */
export function graphContractOf(manifest: KindsManifest): GraphContract {
  return merge(gitContractOf(manifest), manifestContractOf(manifest));
}
