/**
 * What a plugin answered, held against what it declared (decision 0035, item
 * 7): a kind, a field or an edge kind the introduction does not name is
 * refused with the place in the answer that broke it, and a partial unit's
 * removals are dropped — an interrupted unit never deletes what it did not
 * see. A refusal is never a smaller answer: the unit is not extracted, and
 * the record says why.
 */
import { byCodePoint } from '../model/order.js';
import { Value } from 'typebox/value';
import { PluginEvidence } from './protocol.js';
import type {
  PluginContractDeclaration,
  PluginEdgeKindDeclaration,
  PluginEdgeResult,
  PluginEntityRef,
  PluginKeyValues,
  PluginUnitProblem,
  PluginVertexKindDeclaration,
  PluginVertexResult,
} from './protocol.js';

/** One entity's key, rendered one way everywhere: fields in code point order, their values beside them. */
export function canonicalKey(key: PluginKeyValues): string {
  const fields = Object.keys(key).sort(byCodePoint);
  return JSON.stringify(Object.fromEntries(fields.map((field) => {
    const value = key[field];
    return [field, value];
  })));
}

/** Scalar key plus declared parent roles form the producer identity. */
export function canonicalEntity(ref: PluginEntityRef): string {
  return JSON.stringify([ref.kind, canonicalKey(ref.key), Object.entries(ref.keyEdges ?? {}).sort(([a], [b]) => byCodePoint(a, b)).map(([role, parent]) => [role, canonicalEntity(parent)])]);
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
  /** The places the unit could not read, in path and line order: the answer's values stand beside them. */
  readonly problems: readonly PluginUnitProblem[];
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
  return [...(declaration.key ?? [])].sort(byCodePoint);
}

/** Whether a key's fields are exactly the declared ones, in whatever order the plugin wrote them. */
function keyConforms(key: PluginKeyValues, fields: readonly string[]): boolean {
  const held = Object.keys(key).sort(byCodePoint);
  return held.length === fields.length && held.every((field, at) => field === fields[at]);
}

/** The field names a declared kind states. */
function declaredFields(declaration: PluginVertexKindDeclaration | PluginEdgeKindDeclaration): string[] {
  return (declaration.fields ?? []).map((field) => field.name);
}

/** A refusal with its place written into the sentence. */
function refuse(code: string, where: string, message: string): ResultCheck {
  return { ok: false, refusal: { code, where, message: `${where}: ${message}` } };
}

/** One entity's field values, held against its kind's fields: every value belongs to a field the kind declares. */
function checkFields(declaration: PluginVertexKindDeclaration | PluginEdgeKindDeclaration, value: { values?: Readonly<Record<string, unknown>> }, where: string): ResultCheck | undefined {
  const declared = declaredFields(declaration);
  for (const field of Object.keys(value.values ?? {})) {
    if (!declared.includes(field)) {
      return refuse('undeclared-field', `${where}.values.${field}`, `the kind "${declaration.kind}" declares no field "${field}"; its fields are ${declared.length === 0 ? 'none' : declared.join(', ')}`);
    }
  }
  return undefined;
}

function checkKeyEdges(contract: PluginContractDeclaration, declaration: PluginVertexKindDeclaration, ref: PluginEntityRef, where: string): ResultCheck | undefined {
  const declared = declaration.keyEdges ?? [];
  for (const name of Object.keys(ref.keyEdges ?? {})) if (!declared.some(edge => edge.role === name)) return refuse('undeclared-key-edge', `${where}.keyEdges.${name}`, 'the kind declares no parent role with this name');
  for (const parent of declared) {
    const target = ref.keyEdges?.[parent.role];
    if (target === undefined) return refuse('missing-key-edge', `${where}.keyEdges.${parent.role}`, 'the required parent edge is missing');
    const edge = edgeKind(contract, parent.edge);
    if (edge !== undefined) {
      const end = parent.direction === 'from' ? edge.to : edge.from;
      const kinds = typeof end === 'string' ? [end] : end;
      if (!kinds.includes(target.kind)) return refuse('undeclared-edge-end', `${where}.keyEdges.${parent.role}.kind`, `expected one of ${kinds.join(', ')}`);
    }
    const targetKind = vertexKind(contract, target.kind);
    if (targetKind !== undefined) {
      if (!keyConforms(target.key, declaredKeyFields(targetKind))) return refuse('undeclared-key-field', `${where}.keyEdges.${parent.role}.key`, 'the parent names the wrong scalar key');
      const problem = checkKeyEdges(contract, targetKind, target, `${where}.keyEdges.${parent.role}`);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

/**
 * One unit's answer, held against the plugin's introduction: every kind, key
 * field, value and edge kind must be one the plugin declared, nothing may
 * be written twice in one answer, and a partial unit's removals are dropped.
 * The answer comes back in code point order of its kinds and keys, so two
 * runs of the same plugin answer the same bytes.
 */
export function validateUnitResult(contract: PluginContractDeclaration, result: { unitId: string; vertices?: readonly PluginVertexResult[]; edges?: readonly PluginEdgeResult[]; removals?: readonly PluginEntityRef[]; problems?: readonly PluginUnitProblem[]; end: ValidatedUnit['end'] }): ResultCheck {
  const vertices: PluginVertexResult[] = [];
  const seenVertices = new Set<string>();
  for (const [at, vertex] of (result.vertices ?? []).entries()) {
    const where = `vertices[${String(at)}]`;
    const declaration = vertexKind(contract, vertex.kind);
    if (declaration === undefined) {
      return refuse('undeclared-kind', `${where}.kind`, `the plugin declares no vertex kind "${vertex.kind}"; it declares ${contract.vertices.length === 0 ? 'none' : contract.vertices.map((declared) => declared.kind).join(', ')}`);
    }
    const fields = declaredKeyFields(declaration);
    if (!keyConforms(vertex.key ?? {}, fields)) {
      return refuse('undeclared-key-field', `${where}.key`, `the kind "${vertex.kind}" is keyed by ${fields.join(', ')}, and the answer names ${Object.keys(vertex.key).sort(byCodePoint).join(', ')}`);
    }
    const parentProblem = checkKeyEdges(contract, declaration, vertex, where);
    if (parentProblem !== undefined) return parentProblem;
    const fieldProblem = checkFields(declaration, vertex, where);
    if (fieldProblem !== undefined) return fieldProblem;
    if (vertex.evidence !== undefined) {
      const evidence = vertex.evidence;
      if (!Value.Check(PluginEvidence, evidence)) return refuse('malformed-evidence', `${where}.evidence`, 'evidence requires an actual entity target, with no repository alias');
      if ((evidence.lineStart !== undefined || evidence.lineEnd !== undefined) && evidence.path === undefined) return refuse('malformed-evidence', `${where}.evidence`, 'evidence line spans require a path');
      if (evidence.lineStart !== undefined && evidence.lineEnd !== undefined && evidence.lineEnd < evidence.lineStart) return refuse('malformed-evidence', `${where}.evidence`, 'evidence lineEnd precedes lineStart');
    }
    const identity = canonicalEntity(vertex);
    if (seenVertices.has(identity)) return refuse('duplicate-vertex', where, `the kind "${vertex.kind}" with key ${canonicalKey(vertex.key ?? {})} stands twice in one answer`);
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
      const allowed = typeof declaration[end] === 'string' ? [declaration[end]] : declaration[end];
      if (!allowed.includes(named.kind)) {
        return refuse('undeclared-edge-end', `${where}.${end}.kind`, `the edge kind "${edge.kind}" starts at "${declaration.from}" and ends at "${declaration.to}", and the answer names "${named.kind}" as its ${end}`);
      }
      const endDeclaration = vertexKind(contract, named.kind);
      // An end the plugin does not produce names an entity the product's own declarations make — a table declared in
      // a file, a file a table is read from. The plugin states its kind and key, and the graph's writer resolves the
      // entity and refuses a missing endpoint: its key is not the plugin's to declare.
      if (endDeclaration === undefined) {
        const held = named.key ?? {};
        if (Object.keys(held).length === 0) return refuse('undeclared-key-field', `${where}.${end}.key`, `the end of the edge kind "${edge.kind}" names the kind "${named.kind}" with no key: every end names the key of the entity it stands for`);
        continue;
      }
      const parentProblem = checkKeyEdges(contract, endDeclaration, named, `${where}.${end}`);
      if (parentProblem !== undefined) return parentProblem;
      const fields = declaredKeyFields(endDeclaration);
      if (!keyConforms(named.key ?? {}, fields)) {
        return refuse('undeclared-key-field', `${where}.${end}.key`, `the kind "${named.kind}" is keyed by ${fields.join(', ')}, and the answer names ${Object.keys(named.key).sort(byCodePoint).join(', ')}`);
      }
    }
    const fieldProblem = checkFields(declaration, edge, where);
    if (fieldProblem !== undefined) return fieldProblem;
    const identity = JSON.stringify([edge.kind, canonicalEntity(edge.from), canonicalEntity(edge.to), edge.discriminator ?? '']);
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
    const declaration = vertexKind(contract, removal.kind)!;
    if (!keyConforms(removal.key, declaredKeyFields(declaration))) return refuse('undeclared-key-field', `${where}.key`, 'the removal names the wrong key');
    const parentProblem = checkKeyEdges(contract, declaration, removal, where);
    if (parentProblem !== undefined) return parentProblem;
    const identity = canonicalEntity(removal);
    if (seenRemovals.has(identity)) return refuse('duplicate-removal', where, `the kind "${removal.kind}" with key ${canonicalKey(removal.key)} is removed twice in one answer`);
    seenRemovals.add(identity);
    removals.push(removal);
  }
  const problems = [...(result.problems ?? [])].sort((left, right) => byCodePoint(left.repository ?? '', right.repository ?? '') || byCodePoint(left.path, right.path) || left.line - right.line || (left.column ?? 0) - (right.column ?? 0));
  vertices.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(canonicalEntity(left), canonicalEntity(right)));
  edges.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(canonicalEntity(left.from), canonicalEntity(right.from)) || byCodePoint(canonicalEntity(left.to), canonicalEntity(right.to)) || byCodePoint(left.discriminator ?? '', right.discriminator ?? ''));
  removals.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(canonicalKey(left.key ?? {}), canonicalKey(right.key ?? {})));
  return {
    ok: true,
    unit: {
      unitId: result.unitId,
      vertices,
      edges,
      removals,
      problems,
      end: result.end,
      removalsDropped: partial ? (result.removals ?? []).length : 0,
    },
  };
}
