/**
 * What a plugin answered, held against what it declared (decision 0035, item
 * 7): a kind, a field or an edge kind the introduction does not name is
 * refused with the place in the answer that broke it, and a partial unit's
 * removals are dropped — an interrupted unit never deletes what it did not
 * see. A refusal is never a smaller answer: the unit is not extracted, and
 * the record says why.
 */
import { byCodePoint } from '../model/order.js';
import type {
  PluginContractDeclaration,
  PluginEdgeKindDeclaration,
  PluginEdgeResult,
  PluginEntityRef,
  PluginKeyValues,
  PluginVertexKindDeclaration,
  PluginVertexResult,
} from './protocol.js';

/** One entity's key, rendered one way everywhere: fields in code point order, their values beside them. */
export function canonicalKey(key: PluginKeyValues): string {
  const fields = Object.keys(key).sort(byCodePoint);
  return JSON.stringify(Object.fromEntries(fields.map((field) => [field, key[field]])));
}

/** A refusal, with the place in the answer a person can point at. */
export interface ResultRefusal {
  /** A stable code: `undeclared-kind`, `undeclared-field`, `undeclared-edge-kind`, `undeclared-edge-end`, `duplicate-vertex`, `duplicate-edge`, `duplicate-removal`, `malformed-result`. */
  readonly code: string;
  /** The sentence a record carries, naming the place. */
  readonly message: string;
  /** The place in the result: `vertices[2].kind`, and the like. */
  readonly where: string;
}

/** One unit's answer, held against the declaration and put in a stable order. */
export interface ValidatedUnit {
  readonly unitId: string;
  readonly vertices: readonly PluginVertexResult[];
  readonly edges: readonly PluginEdgeResult[];
  readonly removals: readonly PluginEntityRef[];
  readonly end: { readonly state: 'complete' } | { readonly state: 'partial'; readonly cause: string };
  /** How many removals a partial unit carried and the host dropped. */
  readonly removalsDropped: number;
}

export type ResultCheck = { readonly ok: true; readonly unit: ValidatedUnit } | { readonly ok: false; readonly refusal: ResultRefusal };

/** The vertex kind a kind names, when the contract declares it. */
function vertexKind(contract: PluginContractDeclaration, kind: string): PluginVertexKindDeclaration | undefined {
  return contract.vertices.find((declared) => declared.kind === kind);
}

/** The edge kind a kind names, when the contract declares it. */
function edgeKind(contract: PluginContractDeclaration, kind: string): PluginEdgeKindDeclaration | undefined {
  return contract.edges.find((declared) => declared.kind === kind);
}

/** The key fields a declared vertex kind holds, in code point order. */
function declaredKeyFields(declaration: PluginVertexKindDeclaration): string[] {
  return [...declaration.key].sort(byCodePoint);
}

/** Whether a key's fields are exactly the declared ones, in whatever order the plugin wrote them. */
function keyConforms(key: PluginKeyValues, fields: readonly string[]): boolean {
  const held = Object.keys(key).sort(byCodePoint);
  return held.length === fields.length && held.every((field, at) => field === fields[at]);
}

/** The authoritative field names a declared kind writes as columns. */
function authoritativeFields(declaration: PluginVertexKindDeclaration | PluginEdgeKindDeclaration): string[] {
  return (declaration.fields ?? []).filter((field) => field.claim === 'authoritative').map((field) => field.name);
}

/** The claimed field names a declared kind writes as claims. */
function claimedFields(declaration: PluginVertexKindDeclaration | PluginEdgeKindDeclaration): string[] {
  return (declaration.fields ?? []).filter((field) => field.claim === 'claimed').map((field) => field.name);
}

/** A refusal with its place written into the sentence. */
function refuse(code: string, where: string, message: string): ResultCheck {
  return { ok: false, refusal: { code, where, message: `${where}: ${message}` } };
}

/** One vertex's attributes and claims, held against its kind's fields. */
function checkFields(declaration: PluginVertexKindDeclaration | PluginEdgeKindDeclaration, value: { attributes?: Readonly<Record<string, unknown>>; claims?: readonly { field: string }[] }, where: string): ResultCheck | undefined {
  const authoritative = authoritativeFields(declaration);
  const claimed = claimedFields(declaration);
  for (const field of Object.keys(value.attributes ?? {})) {
    if (!authoritative.includes(field)) {
      return refuse('undeclared-field', `${where}.attributes.${field}`, `the kind "${declaration.kind}" declares no authoritative field "${field}"; its authoritative fields are ${authoritative.length === 0 ? 'none' : authoritative.join(', ')}`);
    }
  }
  for (const [at, claim] of (value.claims ?? []).entries()) {
    if (!claimed.includes(claim.field)) {
      return refuse('undeclared-field', `${where}.claims[${String(at)}].field`, `the kind "${declaration.kind}" declares no claimed field "${claim.field}"; its claimed fields are ${claimed.length === 0 ? 'none' : claimed.join(', ')}`);
    }
  }
  return undefined;
}

/**
 * One unit's answer, held against the plugin's introduction: every kind, key
 * field, attribute and edge kind must be one the plugin declared, nothing may
 * be written twice in one answer, and a partial unit's removals are dropped.
 * The answer comes back in code point order of its kinds and keys, so two
 * runs of the same plugin answer the same bytes.
 */
export function validateUnitResult(contract: PluginContractDeclaration, result: { unitId: string; vertices?: readonly PluginVertexResult[]; edges?: readonly PluginEdgeResult[]; removals?: readonly PluginEntityRef[]; end: ValidatedUnit['end'] }): ResultCheck {
  const vertices: PluginVertexResult[] = [];
  const seenVertices = new Set<string>();
  for (const [at, vertex] of (result.vertices ?? []).entries()) {
    const where = `vertices[${String(at)}]`;
    const declaration = vertexKind(contract, vertex.kind);
    if (declaration === undefined) {
      return refuse('undeclared-kind', `${where}.kind`, `the plugin declares no vertex kind "${vertex.kind}"; it declares ${contract.vertices.length === 0 ? 'none' : contract.vertices.map((declared) => declared.kind).join(', ')}`);
    }
    const fields = declaredKeyFields(declaration);
    if (!keyConforms(vertex.key, fields)) {
      return refuse('undeclared-key-field', `${where}.key`, `the kind "${vertex.kind}" is keyed by ${fields.join(', ')}, and the answer names ${Object.keys(vertex.key).sort(byCodePoint).join(', ')}`);
    }
    const fieldProblem = checkFields(declaration, vertex, where);
    if (fieldProblem !== undefined) return fieldProblem;
    const identity = `${vertex.kind}\u0000${canonicalKey(vertex.key)}`;
    if (seenVertices.has(identity)) return refuse('duplicate-vertex', where, `the kind "${vertex.kind}" with key ${canonicalKey(vertex.key)} stands twice in one answer`);
    seenVertices.add(identity);
    vertices.push(vertex);
  }
  const edges: PluginEdgeResult[] = [];
  const seenEdges = new Set<string>();
  for (const [at, edge] of (result.edges ?? []).entries()) {
    const where = `edges[${String(at)}]`;
    const declaration = edgeKind(contract, edge.kind);
    if (declaration === undefined) {
      return refuse('undeclared-edge-kind', `${where}.kind`, `the plugin declares no edge kind "${edge.kind}"; it declares ${contract.edges.length === 0 ? 'none' : contract.edges.map((declared) => declared.kind).join(', ')}`);
    }
    for (const end of ['from', 'to'] as const) {
      const named = edge[end];
      if (named.kind !== declaration[end]) {
        return refuse('undeclared-edge-end', `${where}.${end}.kind`, `the edge kind "${edge.kind}" starts at "${declaration.from}" and ends at "${declaration.to}", and the answer names "${named.kind}" as its ${end}`);
      }
      const endDeclaration = vertexKind(contract, named.kind)!;
      const fields = declaredKeyFields(endDeclaration);
      if (!keyConforms(named.key, fields)) {
        return refuse('undeclared-key-field', `${where}.${end}.key`, `the kind "${named.kind}" is keyed by ${fields.join(', ')}, and the answer names ${Object.keys(named.key).sort(byCodePoint).join(', ')}`);
      }
    }
    const fieldProblem = checkFields(declaration, edge, where);
    if (fieldProblem !== undefined) return fieldProblem;
    const identity = `${edge.kind}\u0000${edge.from.kind}\u0000${canonicalKey(edge.from.key)}\u0000${edge.to.kind}\u0000${canonicalKey(edge.to.key)}\u0000${edge.discriminator ?? ''}`;
    if (seenEdges.has(identity)) return refuse('duplicate-edge', where, `the edge kind "${edge.kind}" between ${canonicalKey(edge.from.key)} and ${canonicalKey(edge.to.key)} stands twice in one answer`);
    seenEdges.add(identity);
    edges.push(edge);
  }
  const removals: PluginEntityRef[] = [];
  const seenRemovals = new Set<string>();
  const partial = result.end.state === 'partial';
  for (const [at, removal] of (partial ? [] : (result.removals ?? [])).entries()) {
    const where = `removals[${String(at)}]`;
    if (vertexKind(contract, removal.kind) === undefined) {
      return refuse('undeclared-kind', `${where}.kind`, `the plugin declares no vertex kind "${removal.kind}"`);
    }
    const identity = `${removal.kind}\u0000${canonicalKey(removal.key)}`;
    if (seenRemovals.has(identity)) return refuse('duplicate-removal', where, `the kind "${removal.kind}" with key ${canonicalKey(removal.key)} is removed twice in one answer`);
    seenRemovals.add(identity);
    removals.push(removal);
  }
  vertices.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(canonicalKey(left.key), canonicalKey(right.key)));
  edges.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(canonicalKey(left.from.key), canonicalKey(right.from.key)) || byCodePoint(canonicalKey(left.to.key), canonicalKey(right.to.key)) || byCodePoint(left.discriminator ?? '', right.discriminator ?? ''));
  removals.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(canonicalKey(left.key), canonicalKey(right.key)));
  return {
    ok: true,
    unit: {
      unitId: result.unitId,
      vertices,
      edges,
      removals,
      end: result.end,
      removalsDropped: partial ? (result.removals ?? []).length : 0,
    },
  };
}
