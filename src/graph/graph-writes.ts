import { withSpan } from '../obs/trace.js';
import {Value} from 'typebox/value';
import {GraphEvidenceEntrySchema} from './evidence-schema.js';
import {validateEvidenceLocator} from './evidence-locator.js';
import { canonicalJson, canonicalJsonDigest } from '../model/canonical.js';
/**
 * The agent's graph writes (owner's rule, 2026-11-13): nothing writes the graph but plugins and MCP writes, an MCP
 * write's source is the agent that made it, and every write names its source and its evidence. This module turns the
 * write tools' arguments into the one writer's drafts: it checks every field and type against the kind's contract,
 * refuses an unknown field by name, and requires typed evidence — a file line, a conversation with its verbatim words,
 * or an outside address. The drafts go through `publishGraphDrafts`, the one writer, inside one write transaction;
 * nothing else writes.
 */
import { generatedTableName, type FieldContract, type GraphContract, type VertexContract } from './contract.js';
import type { EdgeDraft, EvidenceDraft, EvidenceEntry, EntityRefDraft, KeyValueDraft, VertexDraft, VertexRemovalDraft, EdgeRemovalDraft } from './contract.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { graphContractOf } from '../fill/stages/plugin-contract.js';
import { withManifestContract } from './manifest-contract.js';
import { readPublishedManifest } from './manifest-publication.js';
import { semanticBinding } from '../knowledge/semantic-bindings.js';
import { resolveEntityRef, publishGraphDrafts } from './write.js';
import { readKindAssertions } from './records.js';
import { newUid } from './uid.js';
import { scanMentionHints, type MentionCandidate, type MentionHint } from './mentions.js';
import type { OuterTransaction } from '../history-types.js';

/** A refused write: the tool answers its message, naming the field when one is at fault. */
export class WriteRefusal extends Error {
  constructor(message: string, readonly field?: string, readonly status = 400) { super(`${import.meta.path}:1: ${message}`); }
}

/** Display metadata and transport request identity. Authority is a separate host-issued binding. */
export interface WriteSource {
  readonly producer: string;
  readonly version: string;
  /** Display metadata only; this structure cannot authenticate a principal. */
  readonly principal?: { readonly kind: string; readonly identity: string };
  /** Authenticated transport request identity; never read from mutation arguments. */
  readonly operationId?: string;
}

/**
 * The contract the product's graph is written with: the manifest's kinds and plugins, plus the manifest's own tables,
 * plus every edge kind the manifest declares with its own attributes — an edge a plugin does not fill is still a
 * declared relation the agent may state.
 */
export function writeContractOf(manifest: KindsManifest): GraphContract {
  const base = withManifestContract(graphContractOf(manifest));
  const edges = [...base.edge];
  for (const edge of manifest.edges?.values() ?? []) {
    if (edges.some((one) => one.name === edge.name)) continue;
    edges.push({
      name: edge.name,
      table: generatedTableName(edge.name, 'edge'),
      from: edge.from,
      to: edge.to,
      repeats: edge.repeats,
      cardinality: edge.cardinality,
      labels: edge.labels,
      ...(edge.discriminator === undefined ? {} : { discriminator: edge.discriminator }),
      fields: edge.fields.map((field) => ({ name: field.name, type: field.type, ...(field.nullable === true ? { nullable: true } : {}) })),
      capability: edge.capability ?? 'manifest',
    });
  }
  return { ...base, edge: edges };
}

/** A graph reference is explicit; the writer resolves and validates its target. */
function entityRefOf(input: unknown, where: string): EntityRefDraft {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new WriteRefusal(`${where}: expected {kind, key, keyEdges?, uid?}`, where);
  const held = input as Record<string, unknown>;
  for (const field of Object.keys(held)) if (!['kind', 'key', 'keyEdges', 'uid'].includes(field)) throw new WriteRefusal(`${where}.${field}: undeclared entity reference field`, where);
  if (typeof held.kind !== 'string' || held.kind === '') throw new WriteRefusal(`${where}.kind: expected a declared kind`, where);
  if (held.key === null || typeof held.key !== 'object' || Array.isArray(held.key)) throw new WriteRefusal(`${where}.key: expected scalar key fields`, where);
  const key = held.key as Record<string, unknown>;
  for (const [name, value] of Object.entries(key)) if (!['string', 'number', 'boolean'].includes(typeof value)) throw new WriteRefusal(`${where}.key.${name}: expected a scalar key value`, where);
  const keyEdges = keyEdgesOf(held.keyEdges, `${where}.keyEdges`);
  if (held.uid !== undefined && typeof held.uid !== 'string') throw new WriteRefusal(`${where}.uid: expected a uid`, where);
  return { kind: held.kind, key: key as Record<string, KeyValueDraft>, ...(held.uid === undefined ? {} : { uid: held.uid as string }), ...(keyEdges === undefined ? {} : { keyEdges }) };
}

function keyEdgesOf(input: unknown, where = 'keyEdges'): Readonly<Record<string, EntityRefDraft>> | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new WriteRefusal(`${where}: expected a role-to-reference map`, where);
  return Object.fromEntries(Object.entries(input).map(([role, value]) => [role, entityRefOf(value, `${where}.${role}`)]));
}

/** Evidence names real graph vertices; source names and free-form identity blobs are refused. */
export function evidenceOf(input: unknown): EvidenceEntry[] {
  if (!Array.isArray(input) || input.length === 0) throw new WriteRefusal('evidence: at least one graph target is required', 'evidence');
  return input.map((raw, at) => {
    const where = `evidence[${at}]`;
    if(!Value.Check(GraphEvidenceEntrySchema,raw)){
      const failure=[...Value.Errors(GraphEvidenceEntrySchema,raw)][0];
      throw new WriteRefusal(`${where}${failure?.instancePath??''}: ${failure?.message??'expected graph evidence'}`,where);
    }
    const entry=raw as EvidenceEntry;
    if(entry.locator!==undefined)try{validateEvidenceLocator(entry.locator);}catch(error){throw new WriteRefusal(`${where}.locator: ${error instanceof Error?error.message:String(error)}`,where);}
    return entry;
  });
}

/** Whether a value is what the field's declared type states. */
function fits(field: FieldContract, value: unknown): boolean {
  switch (field.type) {
    case 'text': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'bigint': return (typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && value.length > 0 && [...(value.startsWith('-') ? value.slice(1) : value)].every(char => char >= '0' && char <= '9') && value !== '-');
    case 'boolean': return typeof value === 'boolean';
    case 'timestamp': return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'json': return value !== undefined;
  }
}

/** The word a field's type goes by in a refusal. */
function typeName(field: FieldContract): string {
  return field.type;
}

/** The vertex a kind's write is checked against, or the refusal that the graph holds no table for it. */
export function vertexOfKind(contract: GraphContract, kind: string): VertexContract {
  const vertex = contract.vertex.find((one) => one.name === kind);
  if (vertex === undefined) throw new WriteRefusal(`kind ${JSON.stringify(kind)}: the graph holds no table for it, because its declaration names no field producer`, 'kind');
  return vertex;
}

/** The key values one write names, checked against the kind's key declaration. */
export function keyOfKind(vertex: VertexContract, key: unknown): Record<string, KeyValueDraft> {
  if (key === null || typeof key !== 'object' || Array.isArray(key)) throw new WriteRefusal(`kind ${JSON.stringify(vertex.name)}: key is an object of the key fields (${vertex.key.join(', ') || 'none: the kind has no natural key'})`, 'key');
  const held = key as Record<string, unknown>;
  for (const name of vertex.key) {
    if (!(name in held)) throw new WriteRefusal(`kind ${JSON.stringify(vertex.name)}: key names every key field, and ${JSON.stringify(name)} is missing`, 'key');
    const field = vertex.fields.find((one) => one.name === name)!;
    if (!fits(field, held[name])) throw new WriteRefusal(`key.${name} is ${typeName(field)}, got ${JSON.stringify(held[name])}`, name);
  }
  for (const name of Object.keys(held)) if (!vertex.key.includes(name)) throw new WriteRefusal(`key.${name}: the kind ${JSON.stringify(vertex.name)} is keyed by ${vertex.key.join(', ') || 'nothing'}`, name);
  return held as Record<string, KeyValueDraft>;
}

/** The values one write states, checked field by field: an unknown field is refused naming it. */
export function valuesOfKind(vertex: VertexContract, values: unknown, keyed = false): Record<string, unknown> {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new WriteRefusal(`kind ${JSON.stringify(vertex.name)}: values is an object of field names and values`, 'values');
  const held = values as Record<string, unknown>;
  // A keyed entity is stated by its key alone: the product's page names itself, and one write with no opinion of its
  // other fields says only that it exists. A keyless entity with no value would say nothing at all.
  if (Object.keys(held).length === 0 && !keyed) throw new WriteRefusal(`kind ${JSON.stringify(vertex.name)}: values states at least one field`, 'values');
  for (const [name, value] of Object.entries(held)) {
    if (vertex.key.includes(name)) throw new WriteRefusal(`field ${JSON.stringify(name)} of the kind ${JSON.stringify(vertex.name)} is part of its key: an identity is not an opinion`, name);
    const field = vertex.fields.find((one) => one.name === name);
    if (field === undefined) throw new WriteRefusal(`field ${JSON.stringify(name)} is not a field of the kind ${JSON.stringify(vertex.name)}: its fields are ${vertex.fields.filter((one) => !vertex.key.includes(one.name)).map((one) => one.name).join(', ')}`, name);
    if (value === null) {
      if (field.nullable !== true) throw new WriteRefusal(`field ${JSON.stringify(name)} is ${typeName(field)} and not nullable`, name);
      continue;
    }
    if (!fits(field, value)) throw new WriteRefusal(`field ${JSON.stringify(name)} is ${typeName(field)}, got ${JSON.stringify(value)}`, name);
  }
  return held;
}

/** The draft one put_entity call writes: the agent's opinion of the given fields. */
export function entityDraft(contract: GraphContract, input: { kind: string; key: Record<string, unknown>; keyEdges?: unknown; values: unknown; uid?: string }, source: WriteSource, evidence: EvidenceDraft[]): { draft: VertexDraft; vertex: VertexContract } {
  const vertex = vertexOfKind(contract, input.kind);
  const key = keyOfKind(vertex, input.key);
  const values = valuesOfKind(vertex, input.values, Object.keys(key).length > 0);
  return {
    vertex,
    draft: {
      kind: input.kind,
      key,
      ...(input.keyEdges === undefined ? {} : { keyEdges: keyEdgesOf(input.keyEdges) }),
      ...(input.uid === undefined ? {} : { uid: input.uid }),
      values,
      selectedFields: Object.keys(values),
      evidence,
      producer: source.producer,
      producerVersion: source.version,
    },
  };
}

/** The draft one put_edge call writes: the agent's opinion of an edge and its attributes. */
export function edgeDraft(contract: GraphContract, input: { kind: string; from: EntityRefDraft; to: EntityRefDraft; discriminator?: string; values?: unknown }, source: WriteSource, evidence: EvidenceDraft[]): EdgeDraft {
  const edge = contract.edge.find((one) => one.name === input.kind);
  if (edge === undefined) throw new WriteRefusal(`edge kind ${JSON.stringify(input.kind)}: the graph holds no table for it`, 'kind');
  // An end is one of the kinds the edge kind declares, or `any`.
  if (!edge.from.includes('any') && !edge.from.includes(input.from.kind)) throw new WriteRefusal(`the from of the edge ${JSON.stringify(input.kind)} is one of the kinds ${edge.from.join(', ')}, got ${JSON.stringify(input.from.kind)}`, 'from');
  if (!edge.to.includes('any') && !edge.to.includes(input.to.kind)) throw new WriteRefusal(`the to of the edge ${JSON.stringify(input.kind)} is one of the kinds ${edge.to.join(', ')}, got ${JSON.stringify(input.to.kind)}`, 'to');
  if (edge.repeats && (input.discriminator === undefined || input.discriminator === '')) throw new WriteRefusal(`edge ${JSON.stringify(input.kind)} repeats between the same ends, so the write names its discriminator`, 'discriminator');
  if (!edge.repeats && input.discriminator !== undefined && input.discriminator !== '') throw new WriteRefusal(`edge ${JSON.stringify(input.kind)} does not repeat between the same ends, so it takes no discriminator`, 'discriminator');
  const values: Record<string, unknown> = {};
  if (input.values !== undefined) {
    if (input.values === null || typeof input.values !== 'object' || Array.isArray(input.values)) throw new WriteRefusal(`edge ${JSON.stringify(input.kind)}: values is an object of attribute names and values`, 'values');
    for (const [name, value] of Object.entries(input.values as Record<string, unknown>)) {
      const field = edge.fields.find((one) => one.name === name);
      if (field === undefined) throw new WriteRefusal(`field ${JSON.stringify(name)} is not an attribute of the edge ${JSON.stringify(input.kind)}: its attributes are ${edge.fields.map((one) => one.name).join(', ') || 'none'}`, name);
      if (value === null) {
        if (field.nullable !== true) throw new WriteRefusal(`field ${JSON.stringify(name)} is ${typeName(field)} and not nullable`, name);
      } else if (!fits(field, value)) throw new WriteRefusal(`field ${JSON.stringify(name)} is ${typeName(field)}, got ${JSON.stringify(value)}`, name);
      values[name] = value;
    }
  }
  return {
    kind: input.kind,
    from: input.from,
    to: input.to,
    ...(edge.repeats && input.discriminator !== undefined ? { discriminator: input.discriminator } : {}),
    ...(Object.keys(values).length === 0 ? {} : { values }),
    evidence,
    producer: source.producer,
    producerVersion: source.version,
  };
}

/** The removal one retract writes: only this agent's own open opinions of the entity, or of the named fields. */
export function entityRetraction(vertex: VertexContract, key: Record<string, unknown>, fields: readonly string[] | undefined, source: WriteSource, uid?: string, keyEdges?: Readonly<Record<string, EntityRefDraft>>): VertexRemovalDraft {
  if (fields !== undefined) {
    if (fields.length === 0) throw new WriteRefusal('fields names at least one field to retract, or is left out to retract every field', 'fields');
    for (const name of fields) {
      if (vertex.key.includes(name)) throw new WriteRefusal(`field ${JSON.stringify(name)} is part of the key: an identity is not an opinion`, name);
      if (!vertex.fields.some((one) => one.name === name)) throw new WriteRefusal(`field ${JSON.stringify(name)} is not a field of the kind ${JSON.stringify(vertex.name)}`, name);
    }
  }
  return {
    kind: vertex.name,
    ...(keyEdges === undefined ? {} : { keyEdges }),
    key: key as Record<string, KeyValueDraft>,
    ...(uid === undefined ? {} : { uid }),
    ...(fields === undefined ? {} : { selectedFields: fields }),
    producer: source.producer,
  };
}

/** The removal of one edge this agent stated. */
export function edgeRetraction(contract: GraphContract, input: { kind: string; from: EntityRefDraft; to: EntityRefDraft; discriminator?: string }, source: WriteSource): EdgeRemovalDraft {
  const edge = contract.edge.find((one) => one.name === input.kind);
  if (edge === undefined) throw new WriteRefusal(`edge kind ${JSON.stringify(input.kind)}: the graph holds no table for it`, 'kind');
  return {
    kind: input.kind,
    from: input.from,
    to: input.to,
    ...(input.discriminator === undefined ? {} : { discriminator: input.discriminator }),
    producer: source.producer,
  };
}


/** One agent write's answer. */
export interface WriteAnswer {
  readonly kind: string;
  readonly key?: Record<string, unknown>;
  readonly uid?: string;
  readonly written?: number;
  readonly hints?: readonly MentionHint[];
  readonly imported?: { readonly identity: { readonly migration: string; readonly path: string; readonly legacyId: string }; readonly words: string };
  readonly retracted?: boolean;
}

/** The published manifest one write is checked against, read inside the write's own transaction. */
async function manifestOf(tx: OuterTransaction): Promise<KindsManifest> {
  const manifest = await readPublishedManifest(tx);
  if (manifest === undefined) throw new WriteRefusal('the graph holds no published manifest: open the product once so its catalogue is published');
  return manifest;
}

/** Names come only from the manifest's declared page-title field, never a guessed field name. */
async function writeHints(tx: OuterTransaction, manifest: KindsManifest, contract: GraphContract, values: unknown): Promise<MentionHint[]> {
  const dictionary = new Map<string, MentionCandidate[]>();
  const cutoff = (await withSpan('graph.graph-writes.writeHints', { 'db.system': 'postgres' }, async () => await tx.query<{ now: string }>('SELECT clock_timestamp()::text AS now'))).rows[0]!.now;
  for (const kind of manifest.kinds.values()) {
    const vertex = contract.vertex.find(candidate => candidate.name === kind.name);
    const labelField = kind.naming === undefined ? kind.title : kind.naming.label;
    if (vertex === undefined || !vertex.fields.some(field => field.name === labelField && field.type === 'text')) continue;
    const namingFields = [...new Set([labelField, kind.naming?.synonyms, kind.naming?.domain].filter((field): field is string => field !== undefined))];
    const records = await readKindAssertions(tx, 'vertex', kind.name, namingFields, { contract, validAt: cutoff, recordedAt: cutoff });
    for (const record of records) {
      const values = record.values;
      const label = values[labelField];
      if (typeof label !== 'string' || label.length === 0) continue;
      const domain = kind.naming?.domain === undefined ? '' : values[kind.naming.domain];
      const synonyms = kind.naming?.synonyms === undefined ? [] : values[kind.naming.synonyms];
      const candidate = { uid: record.uid, kind: kind.name, label, domain: typeof domain === 'string' ? domain : '' };
      const names = new Set([label, ...(Array.isArray(synonyms) ? synonyms as string[] : [])]);
      for (const name of names) {
        if (name.length === 0) continue;
        const candidates = dictionary.get(name) ?? [];
        candidates.push(candidate);
        dictionary.set(name, candidates);
      }
    }
  }
  for (const candidates of dictionary.values()) candidates.sort((left, right) => {
    const leftKey = Array.from(`${left.kind}\0${left.uid}`, char => char.codePointAt(0)!);
    const rightKey = Array.from(`${right.kind}\0${right.uid}`, char => char.codePointAt(0)!);
    for (let index = 0; index < Math.min(leftKey.length, rightKey.length); index++) {
      if (leftKey[index] !== rightKey[index]) return leftKey[index]! - rightKey[index]!;
    }
    return leftKey.length - rightKey.length;
  });
  return scanMentionHints(values, '', dictionary);
}

/** Puts the agent's opinion of an entity's fields, creating the entity when its key names none. */
export async function putEntityAssertion(tx: OuterTransaction, source: WriteSource, input: { readonly kind: string; readonly key?: unknown; readonly keyEdges?: unknown; readonly edges?: readonly { kind: string; from: EntityRefDraft; to: EntityRefDraft; discriminator?: string; values?: unknown }[]; readonly id?: string; readonly values: unknown; readonly evidence: unknown; readonly words?: string }): Promise<WriteAnswer> {
  const evidence = evidenceOf(input.evidence);
    const manifest = await manifestOf(tx);
    if (!manifest.kinds.has(input.kind)) throw new WriteRefusal(`kind ${JSON.stringify(input.kind)}: the published manifest declares no such kind`, 'kind');
    const contract = writeContractOf(manifest);
    const vertex = vertexOfKind(contract, input.kind);
    let key: Record<string, unknown>;
    let writeUid: string | undefined;
    if (input.id !== undefined) {
      const rows = await withSpan('graph.graph-writes.putEntityAssertion', { 'db.system': 'postgres' }, async () => await tx.query<{ key: Record<string, unknown> }>(
        `SELECT n.key FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = $2 AND n.context_id = 1 LIMIT 1`,
        [input.id, input.kind],
      ));
      if (rows.rows[0] === undefined) {
        // A uid names one entity of one kind, so a write of another kind that names it is refused: attaching its opinion to
        // that entity would make it a row of a kind it is not. The refusal says which kind the uid belongs to.
        const held = await withSpan('graph.graph-writes.putEntityAssertion', { 'db.system': 'postgres' }, async () => await tx.query<{ kind: string }>(
          `SELECT e.name AS kind FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid LIMIT 1`,
          [input.id],
        ));
        const other = held.rows[0]?.kind;
        if (other !== undefined && other !== input.kind) throw new WriteRefusal(`id ${JSON.stringify(input.id)} belongs to an entity of the kind ${JSON.stringify(other)}, and this write names the kind ${JSON.stringify(input.kind)}: a uid is one entity of one kind`, 'id', 409);
        // A keyless kind's identity is its uid, so a write that names one makes that entity: two writes of one name meet
        // on one row (the insert waits on the uid's unique index) instead of making a second. A keyed kind is named by
        // its key, and an id no entity of it holds is still refused.
        if ((vertex.key.length !== 0 || (vertex.keyEdges?.length ?? 0) !== 0)) throw new WriteRefusal(`id ${JSON.stringify(input.id)}: no entity of the kind ${JSON.stringify(input.kind)} has it`, 'id', 404);
        key = {};
        writeUid = input.id;
      } else {
        key = rows.rows[0].key;
        writeUid = input.id;
      }
    } else if (input.key === undefined && vertex.key.length === 0 && (vertex.keyEdges?.length ?? 0) === 0) {
      // A keyless kind is created by the write and answered by the uid of the opinion it just made.
      key = {};
    } else {
      if (input.key === undefined) throw new WriteRefusal('the entity is named by key or by id', 'key');
      key = keyOfKind(vertex, input.key);
    }
    // A keyless creation names its uid here, so the answer is always the entity this write made or restated.
    if (vertex.key.length === 0 && (vertex.keyEdges?.length ?? 0) === 0 && writeUid === undefined) writeUid = newUid();
    const { draft } = entityDraft(contract, { kind: input.kind, key, keyEdges: input.keyEdges, values: input.values, ...(writeUid === undefined ? {} : { uid: writeUid }) }, source, evidence);
    const written = await publishGraphDrafts(tx, contract, { vertices: [draft], edges: (input.edges ?? []).map(edge => edgeDraft(contract, edge, source, evidence)), removals: [] }, 1, { author: `${source.producer}@${source.version}`, ...(input.words === undefined ? {} : { words: input.words }) });
    const uid = (await resolveEntityRef(tx, contract, draft, 1)).uid;
    return { kind: input.kind, key: draft.key as Record<string, unknown>, ...(uid === undefined ? {} : { uid }), written, hints: await writeHints(tx, manifest, contract, { ...draft.key, ...draft.values }) };
}

/** One end of an edge, named by {kind, key} or {kind, id}. */
async function edgeEndOf(tx: OuterTransaction, contract: GraphContract, side: 'from' | 'to', input: unknown): Promise<EntityRefDraft> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new WriteRefusal(`the ${side} of the edge is {kind, key} or {kind, id}`, side);
  const held = input as Record<string, unknown>;
  if (typeof held['kind'] !== 'string' || held['kind'] === '') throw new WriteRefusal(`the ${side} of the edge names its kind`, side);
  const kind = held['kind'];
  const vertex = vertexOfKind(contract, kind);
  if (held['id'] !== undefined) {
    const rows = await withSpan('graph.graph-writes.edgeEndOf', { 'db.system': 'postgres' }, async () => await tx.query<{ key: Record<string, unknown> }>(
      `SELECT n.key FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = $2 AND n.context_id = 1 LIMIT 1`,
      [held['id'], kind],
    ));
    if (rows.rows[0] === undefined) throw new WriteRefusal(`the ${side} id ${JSON.stringify(held['id'])}: no entity of the kind ${JSON.stringify(kind)} has it`, side, 404);
    return { kind, key: rows.rows[0].key as Record<string, KeyValueDraft>, uid: String(held['id']) };
  }
  return { kind, key: keyOfKind(vertex, held['key']), ...(held['keyEdges'] === undefined ? {} : { keyEdges: keyEdgesOf(held['keyEdges']) }) };
}

/** Puts the agent's opinion of an edge and its attributes. */
export async function putEdgeAssertion(tx: OuterTransaction, source: WriteSource, input: { readonly kind: string; readonly from: unknown; readonly to: unknown; readonly discriminator?: string; readonly values?: unknown; readonly evidence: unknown; readonly words?: string }): Promise<WriteAnswer> {
  const evidence = evidenceOf(input.evidence);
    const manifest = await manifestOf(tx);
    const contract = writeContractOf(manifest);
    const edge = contract.edge.find((one) => one.name === input.kind);
    if (edge === undefined) throw new WriteRefusal(`edge kind ${JSON.stringify(input.kind)}: the graph holds no table for it`, 'kind');
    const from = await edgeEndOf(tx, contract, 'from', input.from);
    const to = await edgeEndOf(tx, contract, 'to', input.to);
    const draft = edgeDraft(contract, { kind: input.kind, from, to, ...(input.discriminator === undefined ? {} : { discriminator: input.discriminator }), ...(input.values === undefined ? {} : { values: input.values }) }, source, evidence);
    const written = await publishGraphDrafts(tx, contract, { vertices: [], edges: [draft], removals: [] }, 1, { author: `${source.producer}@${source.version}`, ...(input.words === undefined ? {} : { words: input.words }) });
    return { kind: input.kind, written, hints: await writeHints(tx, manifest, contract, draft.values ?? {}) };
}

/** Closes only this agent's own open opinions of an entity, of the fields it names, or of an edge. */
export async function retractAssertion(tx: OuterTransaction, source: WriteSource, input: { readonly entity?: unknown; readonly edge?: unknown; readonly evidence: unknown; readonly words?: string }): Promise<WriteAnswer> {
  // Why it is withdrawn is evidence too: a withdrawal names its grounds like every other write.
  const evidence = evidenceOf(input.evidence);
    const manifest = await manifestOf(tx);
    const contract = writeContractOf(manifest);
    if ((input.entity === undefined) === (input.edge === undefined)) throw new WriteRefusal('retract names either an entity or an edge, and one of them', 'entity');
    const author = `${source.producer}@${source.version}`;
    if (input.entity !== undefined) {
      if (input.entity === null || typeof input.entity !== 'object' || Array.isArray(input.entity)) throw new WriteRefusal('retract.entity is {kind, key or id, fields?}', 'entity');
      const held = input.entity as Record<string, unknown>;
      if (typeof held['kind'] !== 'string') throw new WriteRefusal('retract.entity.kind names the kind', 'entity');
      if (!manifest.kinds.has(held['kind'])) throw new WriteRefusal(`kind ${JSON.stringify(held['kind'])}: the published manifest declares no such kind`, 'kind');
      const vertex = vertexOfKind(contract, held['kind']);
      let key: Record<string, unknown>;
      let uid: string | undefined;
      if (held['id'] !== undefined) {
        uid = String(held['id']);
        if (vertex.key.length === 0 && (vertex.keyEdges?.length ?? 0) === 0) key = {};
        else {
          const rows = await withSpan('graph.graph-writes.retractAssertion', { 'db.system': 'postgres' }, async () => await tx.query<{ key: Record<string, unknown> }>(
            `SELECT n.key FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = $2 AND n.context_id = 1 LIMIT 1`,
            [uid, held['kind']],
          ));
          if (rows.rows[0] === undefined) throw new WriteRefusal(`id ${JSON.stringify(uid)}: no entity of the kind ${JSON.stringify(held['kind'])} has it`, 'id', 404);
          key = rows.rows[0].key;
        }
      } else key = keyOfKind(vertex, held['key']);
      const fields = Array.isArray(held['fields']) ? held['fields'].filter((one): one is string => typeof one === 'string') : undefined;
      if (held['fields'] !== undefined && (fields === undefined || fields.length !== (held['fields'] as unknown[]).length)) throw new WriteRefusal('retract.entity.fields is a list of field names', 'fields');
      const draft = entityRetraction(vertex, key, fields, source, uid, keyEdgesOf(held['keyEdges']));
      const written = await publishGraphDrafts(tx, contract, { vertices: [], removals: [draft] }, 1, { author, ...(input.words === undefined ? {} : { words: input.words }), withdrawal: { entity: String(held['kind']), ...(fields === undefined ? {} : { fields }), evidence } });
      return { kind: held['kind'], retracted: written > 0 };
    }
    if (input.edge === null || typeof input.edge !== 'object' || Array.isArray(input.edge)) throw new WriteRefusal('retract.edge is {kind, from, to, discriminator?}', 'edge');
    const held = input.edge as Record<string, unknown>;
    if (typeof held['kind'] !== 'string' || held['kind'] === '') throw new WriteRefusal('retract.edge.kind names the edge kind', 'edge');
    const from = await edgeEndOf(tx, contract, 'from', held['from']);
    const to = await edgeEndOf(tx, contract, 'to', held['to']);
    const removal = edgeRetraction(contract, { kind: held['kind'], from, to, ...(typeof held['discriminator'] === 'string' ? { discriminator: held['discriminator'] } : {}) }, source);
    const written = await publishGraphDrafts(tx, contract, { vertices: [], removals: [], edgeRemovals: [removal] }, 1, { author, ...(input.words === undefined ? {} : { words: input.words }), withdrawal: { edge: held['kind'], evidence } });
    return { kind: held['kind'], retracted: written > 0 };
}

/** Semantic plugin facts enter the one physical writer only after trusted admission. */
export async function applyPluginFacts(tx: OuterTransaction, contract: GraphContract, facts: Parameters<typeof publishGraphDrafts>[2], context = 1, metadata?: Parameters<typeof publishGraphDrafts>[4]): Promise<number> {
  return await publishGraphDrafts(tx, contract, facts, context, metadata);
}

/** The host's problem action records the protected finding and its explicitly bound product task atomically. */
export async function putProblemTaskAssertion(tx: OuterTransaction, source: WriteSource, input: { readonly rule: string; readonly fingerprint: string; readonly reason: string; readonly title: string; readonly description: string; readonly about?: EntityRefDraft }): Promise<WriteAnswer> {
  const manifest = await manifestOf(tx);
  const binding = semanticBinding(manifest, 'problem-task');
  if (!binding || !binding.edges?.['problems'] || binding.edges['problems'].direction !== 'from') throw new WriteRefusal(`${manifest.file}:1: semantic-bindings.problem-task requires its outgoing problems relation`);
  const contract = writeContractOf(manifest);
  const taskKind = vertexOfKind(contract, binding.kind);
  const values: Record<string, unknown> = {};
  for (const [role, value] of Object.entries({ title: input.title, description: input.description, tracker: binding.values?.['tracker']?.['local'], key: input.fingerprint })) {
    const field = binding.fields[role];
    if (field !== undefined && value !== undefined) values[field] = value;
  }
  const status = binding.values?.['status']?.['open'];
  if (binding.fields['status'] !== undefined && status !== undefined) values[binding.fields['status']] = status;
  const key = keyOfKind(taskKind, Object.fromEntries(taskKind.key.map(field => [field, values[field]])));
  if (Object.values(key).some(value => value === undefined)) throw new WriteRefusal(`${manifest.file}:1: problem-task identity fields require explicit tracker/key bindings`);
  const cutoff = (await withSpan('graph.graph-writes.putProblemTaskAssertion', { 'db.system': 'postgres' }, async () => await tx.query<{ now: string }>('SELECT clock_timestamp()::text AS now'))).rows[0]!.now;
  const held = (await readKindAssertions(tx, 'vertex', 'system.problem', ['rule', 'fingerprint'], { validAt: cutoff, recordedAt: cutoff })).filter(record => record.values['rule'] === input.rule && record.values['fingerprint'] === input.fingerprint);
  if (held.length > 1) throw new WriteRefusal('ambiguous protected problem fingerprint');
  const problemUid = held[0]?.uid ?? newUid();
  const problem = { kind: 'system.problem', key: {}, uid: problemUid };
  const producer = source.producer;
  const producerVersion = source.version;
  const writtenProblem = await publishGraphDrafts(tx, contract, { vertices: [{ ...problem, values: { rule: input.rule, fingerprint: input.fingerprint, reason: input.reason }, producer, producerVersion }], edges: input.about === undefined ? [] : [{ kind: 'system.problem-about', from: problem, to: input.about, discriminator: input.about.uid, producer, producerVersion }], removals: [] });
  const diagnostic = { rule: input.rule, fingerprint: input.fingerprint, reason: input.reason, about: input.about?.uid ?? null };
  const content = canonicalJson(diagnostic);
  const digest = canonicalJsonDigest(diagnostic);
  const snapshot = { kind: 'system.content-snapshot', key: { digest } };
  const writtenSnapshot = await publishGraphDrafts(tx, contract, { vertices: [{ ...snapshot, values: { content }, producer, producerVersion }], removals: [] });
  const taskValues = Object.fromEntries(Object.entries(values).filter(([field]) => !taskKind.key.includes(field)));
  const task = entityDraft(contract, { kind: binding.kind, key, values: taskValues }, source, [{ target: snapshot }]).draft;
  const written = await publishGraphDrafts(tx, contract, { vertices: [task], edges: [{ kind: binding.edges['problems'].kind, from: { kind: binding.kind, key }, to: problem, producer, producerVersion }], removals: [] });
  const uid = (await resolveEntityRef(tx, contract, task, 1)).uid;
  return { kind: binding.kind, key, uid, written: written + writtenProblem + writtenSnapshot };
}
