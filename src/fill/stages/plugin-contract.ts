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
import { generatedTableName, type DictionaryContract, type FieldContract, type GraphContract, type VertexContract } from '../../graph/contract.js';
import type { GeneratedKindRead } from '../../knowledge/graph-read.js';
import type { FieldDecl, KindDecl, KindsManifest } from '../../knowledge/kinds.js';
import { gitContractOf } from './git-contract.js';

/** The path dictionary the one graph interns evidence paths in: the same declaration the git contract carries. */
const PATH_DICTIONARY: DictionaryContract = { name: 'path', fields: [{ name: 'text', type: 'text' }], key: ['text'] };

/** The field's type and where it takes a reference, as its declared producer states them or the manifest declares them. */
function resolved(field: FieldDecl, kind: KindDecl, manifest: KindsManifest): { type: FieldContract['type']; reference?: string } | undefined {
  const binding = field.binding;
  if (binding === undefined) return undefined;
  if (binding.kind === 'agent') return { type: field.type, ...(field.reference === undefined ? {} : { reference: field.reference }) };
  const plugin = manifest.plugins?.get(binding.plugin);
  const declared = plugin?.contract?.vertices.find((vertex) => vertex.kind === kind.name)?.fields.find((one) => one.name === binding.field);
  if (declared === undefined) return undefined;
  return { type: declared.type, ...(field.reference === undefined ? {} : { reference: field.reference }) };
}

/**
 * The vertex tables a manifest's own declarations make: one for every kind whose
 * fields name a producer, with every bound field as a column of its opinion table,
 * and the path dictionary its evidence paths are interned in.
 */
export function manifestContractOf(manifest: KindsManifest): GraphContract {
  const vertex: VertexContract[] = [];
  for (const kind of manifest.kinds.values()) {
    if (kind.fields === undefined || kind.key === undefined || kind.key.length === 0) continue;
    const fields: FieldContract[] = [];
    let bound = false;
    let capability = '';
    for (const field of kind.fields) {
      const held = resolved(field, kind, manifest);
      if (held === undefined) continue;
      bound = true;
      if (field.binding?.kind === 'plugin') capability = capability === '' ? field.binding.plugin : capability;
      fields.push({ name: field.name, type: held.type, ...(field.nullable === true ? { nullable: true } : {}), ...(held.reference === undefined ? {} : { reference: held.reference }) });
    }
    // A kind whose key has no declaration makes no table: a producer must be able to name the entity it writes about.
    if (!bound || !kind.key.every((field) => fields.some((held) => held.name === field))) continue;
    vertex.push({ name: kind.name, table: generatedTableName(kind.name, 'vertex'), fields, key: kind.key, capability: capability === '' ? 'agent' : capability });
  }
  if (vertex.length === 0) return { vertex: [], edge: [], dictionary: [] };
  return { vertex, edge: [], dictionary: [PATH_DICTIONARY] };
}

/**
 * The manifest-declared kinds a reader reads, with the table each declaration made: the columns its opinions state,
 * the types they are stored as and the natural key. This is the whole of what a reader needs to answer one of these
 * kinds' vertices, and no kind's name stands in it.
 */
export function declaredKindReads(manifest: KindsManifest): Map<string, GeneratedKindRead> {
  const reads = new Map<string, GeneratedKindRead>();
  for (const kind of manifest.kinds.values()) {
    if (kind.fields === undefined || kind.key === undefined || kind.key.length === 0) continue;
    const columns: string[] = [];
    const types: Record<string, GeneratedKindRead['types'][string]> = {};
    const bound = new Set<string>();
    for (const field of kind.fields) {
      const held = resolved(field, kind, manifest);
      if (held === undefined) continue;
      bound.add(field.name);
      if (kind.key.includes(field.name)) continue;
      columns.push(field.name);
      types[field.name] = held.type;
    }
    // A kind no declaration fills, or whose key no producer names, has no table a reader can answer from.
    if (bound.size === 0 || !kind.key.every((field) => bound.has(field))) continue;
    reads.set(kind.name, { kind: kind.name, table: generatedTableName(kind.name, 'vertex'), columns, types, key: kind.key });
  }
  return reads;
}

/** The two declarations of one contract, their kinds and dictionaries stated once each. */
function merge(left: GraphContract, right: GraphContract): GraphContract {
  const vertex = [...left.vertex];
  for (const kind of right.vertex) if (!vertex.some((held) => held.name === kind.name)) vertex.push(kind);
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
