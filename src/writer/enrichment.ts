/**
 * Enrichment of a person's document (decision 0032, section 1): what the writer establishes
 * about a use case, a rule or an ADR is stored APART from the document, keyed by the source
 * entity's identity, and never written over the person's own text.
 *
 * Three rules hold that apart, and each is enforced here rather than promised:
 *
 * - the file's path is derived from the entity's identity alone (`enrichmentPath`), so the same
 *   entity is addressed the same way by every run and two entities never share a file;
 * - the file's page id is `enrichment:<entity id>`, the id the fill's own document reader gives
 *   the entity from its durable `stableId` — a renumbered heading keeps the identity, and a
 *   renumbered document keeps its enrichment (`parseEnrichment` refuses a file whose id names
 *   another entity);
 * - the page is a knowledge page of the writer's own format, so `checkPage` judges it like every
 *   other page and writes it in canonical form; a document of the product is not a page family
 *   the writer may write at all (`writerPageFamily`, `run.ts`), which is what keeps the person's
 *   text out of reach.
 *
 * The document a page's statements are grounded on is named by its ground, `doc:<path>#<anchor>`,
 * and the enrichment carries the source's revision in its `written-at`; nothing here copies the
 * person's sentences into the enrichment.
 */
import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify } from 'yaml';
import type { DocEntity } from '../knowledge/doc-entities.js';
import type { WrittenAt } from '../knowledge/index/page.js';
import { splitFrontMatter } from '../knowledge/markdown.js';

/** The schema tag of an enrichment page, in the front matter of every file the writer writes. */
export const ENRICHMENT_SCHEMA = 'madarch.enrichment@1';

/** The page id of an entity's enrichment: the source entity's identity, which no anchor spells. */
export function enrichmentPageId(entity: Pick<DocEntity, 'id'>): string {
  if (entity.id.trim() === '') throw new Error('src/writer/enrichment.ts: the document entity has no id, so its enrichment cannot be keyed by the entity it enriches');
  return `enrichment:${entity.id}`;
}

/** The source entity's identity an enrichment is keyed by: the id the document reader mints, never a heading or a number. */
export function enrichmentKey(entity: Pick<DocEntity, 'id'>): string {
  return enrichmentPageId(entity);
}

/** The document an enrichment is about, as the product names it: its path, or its repository's path and the document's. */
export function enrichmentSource(entity: Pick<DocEntity, 'repo' | 'path'>): string {
  return entity.repo === null ? entity.path : `repos/${entity.repo}/${entity.path}`;
}

/**
 * The file an entity's enrichment is stored in: a folder per entity kind and a name derived from the
 * identity, so the path is stable across runs, path-safe whatever the identity holds, and never the
 * document's own path. A digest rather than a slug is deliberate: an identity may hold a repository
 * path and a fragment, and a digest of it is the one name two different entities cannot share.
 */
export function enrichmentPath(entity: Pick<DocEntity, 'id' | 'kind'>): string {
  const kind = entity.kind.replace(/[^A-Za-z0-9._-]/g, '_');
  if (kind === '' || kind === '.' || kind === '..' || kind.trim() === '') {
    throw new Error(`src/writer/enrichment.ts: the document entity ${JSON.stringify(entity.id)} has the kind ${JSON.stringify(entity.kind)}, which gives no folder for its enrichment`);
  }
  if (entity.id.trim() === '') throw new Error('src/writer/enrichment.ts: the document entity has no id, so its enrichment has no place to be stored');
  return `docs/enrichment/${kind}/${createHash('sha256').update(enrichmentKey(entity), 'utf8').digest('hex')}.md`;
}

/**
 * The front matter keys an enrichment owns beside the format's own (`PageExpectation.extraFrontKeys`,
 * `src/writer/format.ts`): the entity it enriches and the document lines it stands at. Only an
 * enrichment page may carry them, and only the core writes them.
 */
export const ENRICHMENT_FRONT_KEYS: readonly string[] = ['schema', 'enriches', 'source-document', 'source-line', 'source-end-line'];

/** What one enrichment page is written from: the entity it enriches, its title, the body a unit wrote, and the revision it was read at. */
export interface EnrichmentDraft {
  readonly entity: DocEntity;
  /** The page's title: the entity's own title unless the unit wrote one. */
  readonly title: string;
  /** The body the unit wrote: headings, then statements each ending in its footnotes. */
  readonly body: string;
  /** The repositories and revisions the page was written from. */
  readonly basis?: readonly WrittenAt[];
}

/**
 * The page an enrichment is checked and written as: front matter the core owns (the identity, the
 * kind, the title, the producer and the source document) and the body the unit wrote. The writer
 * fills `written-at` in on the checked page, so it is not written here.
 */
export function renderEnrichment(draft: EnrichmentDraft): string {
  const body = draft.body.replace(/\r\n/g, '\n').trim();
  if (body === '') throw new Error(`src/writer/enrichment.ts: the enrichment of ${draft.entity.id} has no body: a page is its statements`);
  const title = draft.title.trim() === '' ? draft.entity.title : draft.title;
  const front = stringify({
    schema: ENRICHMENT_SCHEMA,
    id: enrichmentPageId(draft.entity),
    kind: 'enrichment',
    title: title.trim(),
    relates: [],
    producer: 'agent',
    sources: [],
    enriches: draft.entity.id,
    'source-document': enrichmentSource(draft.entity),
    'source-line': draft.entity.line,
    'source-end-line': draft.entity.endLine,
  }).trimEnd();
  return `---\n${front}\n---\n\n${body}\n`;
}

/** What reading an enrichment back says: the entity it enriches, or the line and rule that refuse it. */
export type EnrichmentRead =
  | { readonly ok: true; readonly entity: string; readonly schema: string; readonly body: string }
  | { readonly ok: false; readonly line: number; readonly message: string };

/**
 * Reads a file that claims to be an entity's enrichment, and refuses it when it is not: another
 * entity's, another schema's, or not a page at all. A refusal is returned, never thrown, so a caller
 * can report the file by its path and line instead of writing over it.
 */
export function parseEnrichment(path: string, text: string, entity: DocEntity): EnrichmentRead {
  if (text.replace(/\r\n/g, '\n').split('\n')[0] !== '---') return { ok: false, line: 1, message: `${path}:1: an enrichment starts with YAML front matter naming the entity it enriches` };
  let front: unknown;
  try {
    const split = splitFrontMatter(text.replace(/\r\n/g, '\n'));
    front = split.front === null ? null : (parseYaml(split.front) as unknown);
  } catch (error) {
    return { ok: false, line: 2, message: `${path}:2: the front matter of the enrichment is no YAML: ${(error as Error).message.split('\n')[0]}` };
  }
  if (typeof front !== 'object' || front === null || Array.isArray(front)) return { ok: false, line: 2, message: `${path}:2: the front matter of an enrichment is a mapping` };
  const record = front as Record<string, unknown>;
  if (record['schema'] !== ENRICHMENT_SCHEMA) return { ok: false, line: 2, message: `${path}:2: schema is ${JSON.stringify(record['schema'])} and an enrichment is ${JSON.stringify(ENRICHMENT_SCHEMA)}` };
  if (record['id'] !== enrichmentPageId(entity)) return { ok: false, line: 2, message: `${path}:2: id is ${JSON.stringify(record['id'])} and the id of ${entity.id}'s enrichment is ${JSON.stringify(enrichmentPageId(entity))}: the file is about another entity` };
  if (record['enriches'] !== entity.id) return { ok: false, line: 2, message: `${path}:2: enriches is ${JSON.stringify(record['enriches'])} and this file stands for ${JSON.stringify(entity.id)}` };
  if (record['producer'] !== 'agent') return { ok: false, line: 2, message: `${path}:2: producer is ${JSON.stringify(record['producer'])}: an enrichment is the writer's page, never a person's text` };
  const split = splitFrontMatter(text.replace(/\r\n/g, '\n'));
  const body = split.body.trim();
  if (body === '') return { ok: false, line: 2, message: `${path}:2: the enrichment holds no body` };
  return { ok: true, entity: entity.id, schema: ENRICHMENT_SCHEMA, body };
}

/** The page id a written page's front matter names, or undefined when the text is no page of the writer's. */
export function frontMatterId(text: string): string | undefined {
  if (text.replace(/\r\n/g, '\n').split('\n')[0] !== '---') return undefined;
  try {
    const split = splitFrontMatter(text.replace(/\r\n/g, '\n'));
    if (split.front === null) return undefined;
    const front: unknown = parseYaml(split.front);
    if (typeof front !== 'object' || front === null || Array.isArray(front)) return undefined;
    const id = (front as Record<string, unknown>)['id'];
    return typeof id === 'string' && id.trim() !== '' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why an enrichment file may not be replaced, or undefined when it is this entity's own page as the writer left it
 * (decision 0032, section 1: the person's text is never overwritten). A file that is no enrichment, another entity's
 * enrichment, or a page an outside hand rewrote carries the line and the reason.
 */
export function enrichmentOverwriteProblem(path: string, existing: string, entity: DocEntity): { readonly line: number; readonly message: string } | undefined {
  const read = parseEnrichment(path, existing, entity);
  if (read.ok) return undefined;
  return { line: read.line, message: `${read.message} (the file stands at its entity's place: ${path})` };
}

/**
 * Whether a file is a page this writer wrote: its front matter names the producer `agent`, which no
 * document a person wrote does. A caller about to write over an existing page reads this first, and
 * refuses the write rather than replace a person's words (decision 0032, section 1).
 */
export function isAgentPage(text: string): boolean {
  if (text.replace(/\r\n/g, '\n').split('\n')[0] !== '---') return false;
  try {
    const split = splitFrontMatter(text.replace(/\r\n/g, '\n'));
    if (split.front === null) return false;
    const front: unknown = parseYaml(split.front);
    return typeof front === 'object' && front !== null && !Array.isArray(front) && (front as Record<string, unknown>)['producer'] === 'agent';
  } catch {
    return false;
  }
}
