/**
 * The agent's graph writes (owner's rule, 2026-11-13): nothing writes the graph but plugins and MCP writes, an MCP
 * write's source is the agent that made it, and every write names its source and its evidence. This module turns the
 * write tools' arguments into the one writer's drafts: it checks every field and type against the kind's contract,
 * refuses an unknown field by name, and requires typed evidence — a file line, a conversation with its verbatim words,
 * or an outside address. The drafts go through `publishGraphDrafts`, the one writer, inside one write transaction;
 * nothing else writes.
 */
import { generatedTableName, type FieldContract, type GraphContract, type VertexContract } from './contract.js';
import type { EdgeDraft, EvidenceDraft, EntityRefDraft, KeyValueDraft, VertexDraft, VertexRemovalDraft, EdgeRemovalDraft } from './contract.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { graphContractOf } from '../fill/stages/plugin-contract.js';
import { withManifestContract } from './manifest-contract.js';
import { readPublishedManifest } from './manifest-publication.js';
import { publishGraphDrafts } from './write.js';
import type { DatabaseOwner } from '../adapters/database-owner.js';

/** A refused write: the tool answers its message, naming the field when one is at fault. */
export class WriteRefusal extends Error {
  constructor(message: string, readonly field?: string, readonly status = 400) { super(message); }
}

/** The agent one write is made for: a stable producer name and the session it runs in, as the journal states them. */
export interface WriteSource {
  readonly producer: string;
  readonly version: string;
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
      ...(edge.discriminator === undefined ? {} : { discriminator: edge.discriminator }),
      fields: edge.fields.map((field) => ({ name: field.name, type: field.type, ...(field.nullable === true ? { nullable: true } : {}), ...(field.reference === undefined ? {} : { reference: field.reference }) })),
      capability: edge.capability ?? 'manifest',
    });
  }
  return { ...base, edge: edges };
}

const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u;

/** A time as the evidence states it: ISO 8601 with an offset. */
function instantOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ISO.test(value) || Number.isNaN(Date.parse(value))) throw new WriteRefusal(`${what} is an ISO 8601 time with an offset, such as 2026-11-13T12:00:00Z, got ${JSON.stringify(value)}`, what);
  return value;
}

/** One evidence entry, checked and made what the writer stores: every write rests on at least one. */
export function evidenceOf(input: unknown): EvidenceDraft[] {
  if (!Array.isArray(input) || input.length === 0) throw new WriteRefusal('evidence is required: a file line, a conversation or an outside address, at least one', 'evidence');
  const out: EvidenceDraft[] = [];
  for (const [at, raw] of input.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new WriteRefusal(`evidence[${String(at)}] is an object: a file line, a conversation or an outside address`, 'evidence');
    const held = raw as Record<string, unknown>;
    const type = held['type'] ?? 'file';
    if (type === 'conversation') {
      if (typeof held['id'] !== 'string' || held['id'].trim() === '') throw new WriteRefusal(`evidence[${String(at)}]: a conversation names its id`, 'evidence');
      if (typeof held['words'] !== 'string' || held['words'].trim() === '') throw new WriteRefusal(`evidence[${String(at)}]: a conversation keeps its verbatim words`, 'evidence');
      out.push({ type: 'conversation', id: held['id'], ...(held['at'] === undefined ? {} : { at: instantOf(held['at'], `evidence[${String(at)}].at`) }), ...(typeof held['speaker'] === 'string' ? { speaker: held['speaker'] } : {}), words: held['words'] });
    } else if (type === 'url') {
      let url: URL;
      try { url = new URL(String(held['url'])); } catch { throw new WriteRefusal(`evidence[${String(at)}]: the address is an http or https URL, got ${JSON.stringify(held['url'])}`, 'evidence'); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WriteRefusal(`evidence[${String(at)}]: the address is an http or https URL, got ${JSON.stringify(held['url'])}`, 'evidence');
      if (held['at'] === undefined) throw new WriteRefusal(`evidence[${String(at)}]: an outside address states when it was read`, 'evidence');
      out.push({ type: 'url', url: url.toString(), at: instantOf(held['at'], `evidence[${String(at)}].at`) });
    } else if (type === 'file') {
      if (typeof held['path'] !== 'string' || held['path'].trim() === '') throw new WriteRefusal(`evidence[${String(at)}]: a file line names its path`, 'evidence');
      const revision = typeof held['commit'] === 'string' && held['commit'] !== '' ? held['commit'] : typeof held['blob'] === 'string' && held['blob'] !== '' ? held['blob'] : undefined;
      if (revision === undefined) throw new WriteRefusal(`evidence[${String(at)}]: a file line names the commit or blob it was read at`, 'evidence');
      if (typeof held['lineStart'] !== 'number' || !Number.isInteger(held['lineStart']) || held['lineStart'] < 1) throw new WriteRefusal(`evidence[${String(at)}]: a file line names the line it starts at`, 'evidence');
      const lineEnd = held['lineEnd'] === undefined ? held['lineStart'] : held['lineEnd'];
      if (typeof lineEnd !== 'number' || !Number.isInteger(lineEnd) || lineEnd < held['lineStart']) throw new WriteRefusal(`evidence[${String(at)}]: a file line ends at or after its first line`, 'evidence');
      out.push({ type: 'file', ...(typeof held['repository'] === 'string' && held['repository'] !== '' ? { repository: held['repository'] } : {}), commit_or_digest: revision, path: held['path'], line_start: held['lineStart'], line_end: lineEnd });
    } else {
      throw new WriteRefusal(`evidence[${String(at)}]: the type is file, conversation or url, got ${JSON.stringify(type)}`, 'evidence');
    }
  }
  return out;
}

/** Whether a value is what the field's declared type states. */
function fits(field: FieldContract, value: unknown): boolean {
  if (field.reference !== undefined) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const held = value as Record<string, unknown>;
    return typeof held['kind'] === 'string' && held['kind'] === field.reference && held['key'] !== null && typeof held['key'] === 'object' && !Array.isArray(held['key']);
  }
  switch (field.type) {
    case 'text': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'bigint': return (typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^-?\d+$/u.test(value));
    case 'boolean': return typeof value === 'boolean';
    case 'timestamp': return typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value));
    case 'json': return value !== undefined;
  }
}

/** The word a field's type goes by in a refusal. */
function typeName(field: FieldContract): string {
  return field.reference === undefined ? field.type : `a reference to ${field.reference} ({kind, key})`;
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
export function valuesOfKind(vertex: VertexContract, values: unknown): Record<string, unknown> {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new WriteRefusal(`kind ${JSON.stringify(vertex.name)}: values is an object of field names and values`, 'values');
  const held = values as Record<string, unknown>;
  if (Object.keys(held).length === 0) throw new WriteRefusal(`kind ${JSON.stringify(vertex.name)}: values states at least one field`, 'values');
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
export function entityDraft(contract: GraphContract, input: { kind: string; key: Record<string, unknown>; values: unknown }, source: WriteSource, evidence: EvidenceDraft[]): { draft: VertexDraft; vertex: VertexContract } {
  const vertex = vertexOfKind(contract, input.kind);
  const key = keyOfKind(vertex, input.key);
  const values = valuesOfKind(vertex, input.values);
  return {
    vertex,
    draft: {
      kind: input.kind,
      key,
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
  if (edge.repeats && (input.discriminator === undefined || input.discriminator === '')) throw new WriteRefusal(`edge ${JSON.stringify(input.kind)} repeats between the same ends, so the write names its discriminator`, 'discriminator');
  if (!edge.repeats && input.discriminator !== undefined && input.discriminator !== '') throw new WriteRefusal(`edge ${JSON.stringify(input.kind)} does not repeat between the same ends, so it takes no discriminator`, 'discriminator');
  const values: Record<string, unknown> = {};
  if (input.values !== undefined) {
    if (input.values === null || typeof input.values !== 'object' || Array.isArray(input.values)) throw new WriteRefusal(`edge ${JSON.stringify(input.kind)}: values is an object of attribute names and values`, 'values');
    for (const [name, value] of Object.entries(input.values as Record<string, unknown>)) {
      const field = edge.fields.find((one) => one.name === name);
      if (field === undefined) throw new WriteRefusal(`field ${JSON.stringify(name)} is not an attribute of the edge ${JSON.stringify(input.kind)}: its attributes are ${edge.fields.map((one) => one.name).join(', ') || 'none'}`, name);
      if (value !== null && !fits(field, value)) throw new WriteRefusal(`field ${JSON.stringify(name)} is ${typeName(field)}, got ${JSON.stringify(value)}`, name);
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
export function entityRetraction(vertex: VertexContract, key: Record<string, unknown>, fields: readonly string[] | undefined, source: WriteSource, uid?: string): VertexRemovalDraft {
  if (fields !== undefined) {
    if (fields.length === 0) throw new WriteRefusal('fields names at least one field to retract, or is left out to retract every field', 'fields');
    for (const name of fields) {
      if (vertex.key.includes(name)) throw new WriteRefusal(`field ${JSON.stringify(name)} is part of the key: an identity is not an opinion`, name);
      if (!vertex.fields.some((one) => one.name === name)) throw new WriteRefusal(`field ${JSON.stringify(name)} is not a field of the kind ${JSON.stringify(vertex.name)}`, name);
    }
  }
  return {
    kind: vertex.name,
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
  readonly retracted?: boolean;
}

/** The published manifest one write is checked against, read inside the write's own transaction. */
async function manifestOf(tx: Parameters<Parameters<DatabaseOwner['transaction']>[1]>[0]): Promise<KindsManifest> {
  const manifest = await readPublishedManifest(tx);
  if (manifest === undefined) throw new WriteRefusal('the graph holds no published manifest: open the product once so its catalogue is published');
  return manifest;
}

/** The uid of the node the producer's newest open opinion is about: what a keyless entity's write answers. */
async function producerNodeOf(tx: Parameters<Parameters<DatabaseOwner['transaction']>[1]>[0], vertex: VertexContract, producer: string): Promise<string | undefined> {
  return (await tx.query<{ uid: string }>(
    `SELECT n.uid::text AS uid FROM "${vertex.table}" t JOIN node n ON n.id = t.node_id
     WHERE split_part(t.said_by, '@', 1) = $1 AND t.state = 'open' AND t.context_id = 1 ORDER BY t.id DESC LIMIT 1`,
    [producer],
  )).rows[0]?.uid;
}

/** Puts the agent's opinion of an entity's fields, creating the entity when its key names none. */
export async function putEntityOpinion(owner: DatabaseOwner, source: WriteSource, input: { readonly kind: string; readonly key?: unknown; readonly id?: string; readonly values: unknown; readonly evidence: unknown; readonly words?: string }): Promise<WriteAnswer> {
  const evidence = evidenceOf(input.evidence);
  return await owner.transaction('write', async (tx) => {
    const manifest = await manifestOf(tx);
    if (!manifest.kinds.has(input.kind)) throw new WriteRefusal(`kind ${JSON.stringify(input.kind)}: the published manifest declares no such kind`, 'kind');
    const contract = writeContractOf(manifest);
    const vertex = vertexOfKind(contract, input.kind);
    let key: Record<string, unknown>;
    if (input.id !== undefined) {
      if (vertex.key.length === 0) throw new WriteRefusal(`kind ${JSON.stringify(input.kind)} has no natural key: an entity is addressed by its uid alone and cannot be written again`, 'id');
      const rows = await tx.query<{ key: Record<string, unknown> }>(
        `SELECT n.key FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = $2 AND n.context_id = 1 AND NOT n.removed LIMIT 1`,
        [input.id, input.kind],
      );
      if (rows.rows[0] === undefined) throw new WriteRefusal(`id ${JSON.stringify(input.id)}: no entity of the kind ${JSON.stringify(input.kind)} has it`, 'id', 404);
      key = rows.rows[0].key;
    } else if (input.key === undefined && vertex.key.length === 0) {
      // A keyless kind is created by the write and answered by the uid of the opinion it just made.
      key = {};
    } else {
      if (input.key === undefined) throw new WriteRefusal('the entity is named by key or by id', 'key');
      key = keyOfKind(vertex, input.key);
    }
    const { draft } = entityDraft(contract, { kind: input.kind, key, values: input.values }, source, evidence);
    const written = await publishGraphDrafts(tx, contract, { vertices: [draft], removals: [] }, 1, { author: `${source.producer}@${source.version}`, ...(input.words === undefined ? {} : { words: input.words }) });
    const uid = await producerNodeOf(tx, vertex, source.producer);
    return { kind: input.kind, key: draft.key as Record<string, unknown>, ...(uid === undefined ? {} : { uid }), written };
  });
}

/** One end of an edge, named by {kind, key} or {kind, id}. */
async function edgeEndOf(tx: Parameters<Parameters<DatabaseOwner['transaction']>[1]>[0], contract: GraphContract, side: 'from' | 'to', input: unknown): Promise<EntityRefDraft> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new WriteRefusal(`the ${side} of the edge is {kind, key} or {kind, id}`, side);
  const held = input as Record<string, unknown>;
  if (typeof held['kind'] !== 'string' || held['kind'] === '') throw new WriteRefusal(`the ${side} of the edge names its kind`, side);
  const vertex = vertexOfKind(contract, held['kind']);
  if (held['id'] !== undefined) {
    const rows = await tx.query<{ key: Record<string, unknown> }>(
      `SELECT n.key FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = $2 AND n.context_id = 1 AND NOT n.removed LIMIT 1`,
      [held['id'], held['kind']],
    );
    if (rows.rows[0] === undefined) throw new WriteRefusal(`the ${side} id ${JSON.stringify(held['id'])}: no entity of the kind ${JSON.stringify(held['kind'])} has it`, side, 404);
    return { kind: held['kind'], key: rows.rows[0].key as Record<string, KeyValueDraft> };
  }
  return { kind: held['kind'], key: keyOfKind(vertex, held['key']) };
}

/** Puts the agent's opinion of an edge and its attributes. */
export async function putEdgeOpinion(owner: DatabaseOwner, source: WriteSource, input: { readonly kind: string; readonly from: unknown; readonly to: unknown; readonly discriminator?: string; readonly values?: unknown; readonly evidence: unknown; readonly words?: string }): Promise<WriteAnswer> {
  const evidence = evidenceOf(input.evidence);
  return await owner.transaction('write', async (tx) => {
    const manifest = await manifestOf(tx);
    const contract = writeContractOf(manifest);
    const edge = contract.edge.find((one) => one.name === input.kind);
    if (edge === undefined) throw new WriteRefusal(`edge kind ${JSON.stringify(input.kind)}: the graph holds no table for it`, 'kind');
    const from = await edgeEndOf(tx, contract, 'from', input.from);
    const to = await edgeEndOf(tx, contract, 'to', input.to);
    const draft = edgeDraft(contract, { kind: input.kind, from, to, ...(input.discriminator === undefined ? {} : { discriminator: input.discriminator }), ...(input.values === undefined ? {} : { values: input.values }) }, source, evidence);
    const written = await publishGraphDrafts(tx, contract, { vertices: [], edges: [draft], removals: [] }, 1, { author: `${source.producer}@${source.version}`, ...(input.words === undefined ? {} : { words: input.words }) });
    return { kind: input.kind, written };
  });
}

/** Closes only this agent's own open opinions of an entity, of the fields it names, or of an edge. */
export async function retractOpinion(owner: DatabaseOwner, source: WriteSource, input: { readonly entity?: unknown; readonly edge?: unknown; readonly words?: string }): Promise<WriteAnswer> {
  return await owner.transaction('write', async (tx) => {
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
        if (vertex.key.length === 0) key = {};
        else {
          const rows = await tx.query<{ key: Record<string, unknown> }>(
            `SELECT n.key FROM node n JOIN entity e ON e.id = n.entity_id WHERE n.uid = $1::uuid AND e.name = $2 AND n.context_id = 1 LIMIT 1`,
            [uid, held['kind']],
          );
          if (rows.rows[0] === undefined) throw new WriteRefusal(`id ${JSON.stringify(uid)}: no entity of the kind ${JSON.stringify(held['kind'])} has it`, 'id', 404);
          key = rows.rows[0].key;
        }
      } else key = keyOfKind(vertex, held['key']);
      const fields = Array.isArray(held['fields']) ? held['fields'].filter((one): one is string => typeof one === 'string') : undefined;
      if (held['fields'] !== undefined && (fields === undefined || fields.length !== (held['fields'] as unknown[]).length)) throw new WriteRefusal('retract.entity.fields is a list of field names', 'fields');
      const draft = entityRetraction(vertex, key, fields, source, uid);
      const written = await publishGraphDrafts(tx, contract, { vertices: [], removals: [draft] }, 1, { author, ...(input.words === undefined ? {} : { words: input.words }) });
      return { kind: held['kind'], retracted: written > 0 };
    }
    if (input.edge === null || typeof input.edge !== 'object' || Array.isArray(input.edge)) throw new WriteRefusal('retract.edge is {kind, from, to, discriminator?}', 'edge');
    const held = input.edge as Record<string, unknown>;
    if (typeof held['kind'] !== 'string' || held['kind'] === '') throw new WriteRefusal('retract.edge.kind names the edge kind', 'edge');
    const from = await edgeEndOf(tx, contract, 'from', held['from']);
    const to = await edgeEndOf(tx, contract, 'to', held['to']);
    const removal = edgeRetraction(contract, { kind: held['kind'], from, to, ...(typeof held['discriminator'] === 'string' ? { discriminator: held['discriminator'] } : {}) }, source);
    const written = await publishGraphDrafts(tx, contract, { vertices: [], removals: [], edgeRemovals: [removal] }, 1, { author, ...(input.words === undefined ? {} : { words: input.words }) });
    return { kind: held['kind'], retracted: written > 0 };
  });
}
