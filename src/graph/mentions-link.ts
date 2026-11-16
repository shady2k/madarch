/**
 * Decision 0039 items 5 and 29: linking one name a page left unlinked. The link is the token in the entity's own text,
 * written by the one writer as the person's statement of that field: the reader's press names the exact span the page
 * showed, so a text that changed under the page is refused rather than linked in the wrong place.
 */
import type { SqlExecutor } from '../sql-driver.js';
import { withSpan } from '../obs/trace.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { withAssertionContract } from './system-contract.js';
import { publishGraphDrafts } from './write.js';
import { writeContractOf, WriteRefusal } from './graph-writes.js';
import { activateGraphProducer, producerIdentityOf, type ProducerBinding } from './producer-binding.js';
import { readKindAssertions } from './records.js';
import { scanMentionText } from './mention-text.js';
import { holdsMentions } from './mention-graph.js';

export interface LinkMentionInput {
  readonly kind: string;
  readonly uid: string;
  readonly field: string;
  /** The RFC 6901 pointer the page showed, its first segment the field's own. */
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly name: string;
  /** The entity the name means: the candidate the reader pressed. */
  readonly entity: string;
}

/** The field's JSON Pointer segments after the field's own name, RFC 6901 unescaping applied. */
function segmentsOf(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new WriteRefusal(`path ${JSON.stringify(path)}: a pointer begins with /`, 'path');
  return path.slice(1).split('/').map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function valueAt(value: unknown, segments: readonly string[]): unknown {
  let held = value;
  for (const segment of segments) {
    if (Array.isArray(held)) held = held[Number(segment)];
    else if (held !== null && typeof held === 'object') held = (held as Record<string, unknown>)[segment];
    else return undefined;
  }
  return held;
}

function withValueAt(value: unknown, segments: readonly string[], next: string): unknown {
  if (segments.length === 0) return next;
  const copy: unknown = Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
  const [head, ...rest] = segments as [string, ...string[]];
  if (Array.isArray(copy)) copy[Number(head)] = withValueAt(copy[Number(head)], rest, next);
  else (copy as Record<string, unknown>)[head] = withValueAt((copy as Record<string, unknown>)[head], rest, next);
  return copy;
}

/**
 * Links the name at the span the page showed: the field keeps every other character, the token stands where the name
 * stood, and the mention reaches the graph as the writer records it for this person's statement.
 */
export async function linkMention(tx: SqlExecutor, manifest: KindsManifest, binding: ProducerBinding, input: LinkMentionInput): Promise<{ readonly kind: string; readonly uid: string; readonly field: string; readonly text: string }> {
  return await withSpan('graph.mention.link', { 'graph.kind': input.kind }, async () => {
    const declaration = manifest.kinds.get(input.kind);
    if (declaration === undefined) throw new WriteRefusal(`kind ${JSON.stringify(input.kind)}: the published manifest declares no such kind`, 'kind', 404);
    const contract = withAssertionContract(writeContractOf(manifest));
    const vertex = contract.vertex.find((kind) => kind.name === input.kind)!;
    const field = vertex.fields.find((held) => held.name === input.field);
    if (field === undefined) throw new WriteRefusal(`field ${JSON.stringify(input.field)}: the kind ${JSON.stringify(input.kind)} declares no such field`, 'field', 404);
    if (!holdsMentions(field.type)) throw new WriteRefusal(`field ${JSON.stringify(input.field)}: a mention stands in text or a JSON string`, 'field');
    if (vertex.evidence?.contentField === input.field) throw new WriteRefusal(`field ${JSON.stringify(input.field)}: the kind's immutable evidence is never edited`, 'field');
    const now = new Date().toISOString();
    const record = (await readKindAssertions(tx, 'vertex', input.kind, [input.field], { contract, validAt: now, recordedAt: now, subjectUids: [input.uid] }))[0];
    if (record === undefined) throw new WriteRefusal(`uid ${JSON.stringify(input.uid)}: no entity of the kind ${JSON.stringify(input.kind)} has it`, 'uid', 404);
    const segments = segmentsOf(input.path);
    if (segments[0] !== field.name) throw new WriteRefusal(`path ${JSON.stringify(input.path)}: the page's pointer names its field first`, 'path');
    const held = valueAt(record.values[input.field], segments.slice(1));
    if (typeof held !== 'string') throw new WriteRefusal(`path ${JSON.stringify(input.path)}: the field holds no string there`, 'path', 409);
    const chars = Array.from(held);
    if (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end) || input.start < 0 || input.end <= input.start || input.end > chars.length) throw new WriteRefusal(`path ${JSON.stringify(input.path)}: the span is outside the written string`, 'start', 409);
    if (chars.slice(input.start, input.end).join('') !== input.name) throw new WriteRefusal(`path ${JSON.stringify(input.path)}: the text changed since the page showed it; read the page again`, 'name', 409);
    const blocked = scanMentionText(held).excludedSpans.some((span) => input.start < span.end && input.end > span.start);
    if (blocked) throw new WriteRefusal(`path ${JSON.stringify(input.path)}: the span is already a link or an escape`, 'start', 409);
    const target = (await tx.query<{ id: string; kind: string; active: boolean }>(`SELECT n.id::text AS id,k.name AS kind,graph_vertex_active(n.id,k.name,1) AS active FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid`, [input.entity])).rows[0];
    if (target === undefined || target.active !== true) throw new WriteRefusal(`entity ${JSON.stringify(input.entity)}: the graph holds no such entity`, 'entity', 404);
    const text = [...chars.slice(0, input.start), ...Array.from(`[[uid:${input.entity}]]`), ...chars.slice(input.end)].join('');
    await activateGraphProducer(tx, writeContractOf(manifest), binding, 1);
    await publishGraphDrafts(tx, contract, { vertices: [{ kind: input.kind, key: record.key as Readonly<Record<string, string | number | boolean>>, uid: record.uid, values: { [field.name]: withValueAt(record.values[field.name], segments.slice(1), text) }, selectedFields: [field.name], producer: producerIdentityOf(binding).producer, producerVersion: producerIdentityOf(binding).version }], removals: [] }, 1);
    return { kind: input.kind, uid: record.uid, field: field.name, text };
  });
}
