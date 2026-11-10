/**
 * The wiki's reads of the one graph (decision 0034 and its amendment of 2026-11-10): a vertex is its identity and its
 * key, every value stands in its entity's table as an opinion, and an edge is never a vertex. A field one open opinion
 * states is that value; a field several do is every value with its source, never one picked silently. The reader
 * presents the graph's code kinds as the wiki's `code.*` kinds —
 * `code.repository`, `code.directory`, `code.file`, `code.commit`, `code.author`
 * (a git signature, not a person) — and answers nothing for a kind the one graph
 * does not hold yet: an empty result is the truth, never an error.
 */
import type { DatabaseOwner, OuterTransaction } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import type { LandmarkPlan } from './history-landmarks.js';
import { GIT_KINDS, GIT_TABLES } from '../fill/stages/git-contract.js';
import { commitWithPaths, fileContent, fileContents, fileFacts, fileHistory, fileTextAt, folderChildrenOf, folderFiles, listDirectories, listDocuments, listFiles, listRepositories, repositoryFacts } from '../graph/index.js';
import type { FileDate, FileHistoryRow, FileRecord } from '../graph/index.js';
import { entityAddress } from './addresses.js';
import { DOCUMENT_SUFFIXES } from './doc-sources.js';

export interface SourceSpan {
  path: string;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
}

/** One place a claim of an entity stands: the file, the lines, and the commit or digest the value was read at. */
export interface GraphEvidence {
  /** The field the evidence is under: the claim's attribute. */
  field: string;
  repository: string | null;
  path: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  commit: string | null;
  /** What the evidence names: a file place, a conversation or another opinion (the amendment's point 7). */
  type?: 'file' | 'conversation' | 'opinion';
  /** A conversation's or an opinion's id. */
  id?: string;
  speaker?: string | null;
  at?: string | null;
  /** The opinion that stated the value: the producer and its version, the agent, or a person's node. */
  saidBy?: string;
}

export interface GraphEntity {
  key: string;
  kind: string;
  label: string;
  properties: Record<string, unknown>;
  nodeIds: string[];
  scope: string;
  span?: SourceSpan;
  /** Where the entity's values were read, one per opinion's evidence: a term's page links to its definitions. */
  evidence?: readonly GraphEvidence[];
  /** Every field value with the opinion that stated it: value-to-source, never one picked silently (A4). */
  opinions?: readonly GraphEntityOpinion[];
}

/** One field value and the opinion that stated it: its stable id, its producer and version, its language, its evidence. */
export interface GraphEntityOpinion {
  readonly field: string;
  readonly value: unknown;
  readonly opinionId: string;
  readonly producer: string;
  readonly lang: string | null;
  readonly evidence: readonly GraphEvidence[];
}

/**
 * One kind's table as the manifest's declarations made it (decision 0034, item 14): the table, its columns and its
 * natural key. A reader with these reads the kind's vertices without naming any kind: the table and its key are the
 * product's own data.
 */
export interface GeneratedKindRead {
  readonly kind: string;
  readonly table: string;
  readonly columns: readonly string[];
  /** Each column's declared type, so a text column that holds digits stays text. */
  readonly types: Readonly<Record<string, 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json'>>;
  readonly key: readonly string[];
}

export interface NeighborEdge {
  relation: string;
  direction: 'out' | 'in';
  other: GraphEntity;
  properties: Record<string, unknown>;
  position: { start: number; end: number } | null;
  span?: SourceSpan;
}

export interface NeighborGroup {
  relation: string;
  direction: 'out' | 'in';
  total: number;
  edges: number;
  rows: { entity: GraphEntity; edges: number; span?: SourceSpan }[];
}

export interface RelationEdge {
  discriminator?: string;
  from: { key: string; kind: string; label: string };
  to: { key: string; kind: string; label: string };
  properties: Record<string, unknown>;
}

export interface HistoryEvidence {
  entities: GraphEntity[];
  edges: { from: string; to: string; relation: string; properties: Record<string, unknown> }[];
  /** The coupled files a path page found, including those its bounded rows leave out. */
  couplingTotal?: number;
}

type Raw = Record<string, unknown>;

/** A store that declares no code kind holds no file or repository table: an empty answer, never an error. */
const missingTable = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === '42P01';

const WIKI_KIND: Readonly<Record<string, string>> = {
  repository: 'code.repository',
  directory: 'code.directory',
  file: 'code.file',
  commit: 'code.commit',
  signature: 'code.author',
};

function graphKindOf(wikiKind: string): string | undefined {
  for (const [graph, wiki] of Object.entries(WIKI_KIND)) if (wiki === wikiKind) return graph;
  return undefined;
}

function graphRelationOf(relation: string): { kind: string } | undefined {
  const bare = relation.startsWith('code.') ? relation.slice('code.'.length) : relation;
  if (bare === `${GIT_KINDS.contains}` || bare === `${GIT_KINDS.touched}` || bare === `${GIT_KINDS.authored}` || bare === `${GIT_KINDS.parent}`) return { kind: bare };
  if (bare === 'renamed-to' || bare === `${GIT_KINDS.renamedFrom}`) return { kind: `${GIT_KINDS.renamedFrom}` };
  return undefined;
}

const WIKI_RELATION: Readonly<Record<string, string>> = {
  contains: 'code.contains',
  touched: 'code.touched',
  authored: 'code.authored',
  parent: 'code.parent',
  [GIT_KINDS.renamedFrom]: 'code.renamed-to',
};

export function spanFromProvenance(properties: Record<string, unknown>): SourceSpan | undefined {
  const provenance = properties['provenance'];
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) return undefined;
  const place = (provenance as Record<string, unknown>)['place'];
  if (place === null || typeof place !== 'object' || Array.isArray(place)) return undefined;
  const held = place as Record<string, unknown>;
  const range = held['range'];
  const path = held[GIT_KINDS.file];
  if (typeof path !== 'string' || range === null || typeof range !== 'object' || Array.isArray(range)) return undefined;
  const measured = range as Record<string, unknown>;
  const { startLine, endLine, startByte, endByte } = measured;
  if (typeof startLine !== 'number' || typeof endLine !== 'number' || typeof startByte !== 'number' || typeof endByte !== 'number') return undefined;
  return { path, lineStart: startLine, lineEnd: endLine, byteStart: startByte, byteEnd: endByte };
}

export function spanOf(value: unknown): SourceSpan | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const span = value as Record<string, unknown>;
  const { path, lineStart, lineEnd, byteStart, byteEnd } = span;
  if (typeof path !== 'string' || typeof lineStart !== 'number' || typeof lineEnd !== 'number' || typeof byteStart !== 'number' || typeof byteEnd !== 'number') return undefined;
  return { path, lineStart, lineEnd, byteStart, byteEnd };
}

export function presentedKey(kind: string, properties: Record<string, unknown>): string {
  if (kind === 'code.file' && typeof properties['path'] === 'string') return `code.file:${String(properties['repository'] ?? '')}/${properties['path']}`;
  if (kind === 'code.directory' && typeof properties['path'] === 'string') return `code.directory:${String(properties['repository'] ?? '')}/${properties['path']}`;
  if (kind === 'code.gitlink' && typeof properties['path'] === 'string') return `code.gitlink:${String(properties['repository'] ?? '')}/${properties['path']}`;
  if (kind === 'code.repository' && typeof properties['name'] === 'string') return `code.repository:${properties['name']}`;
  if (kind === 'code.commit' && typeof properties['hash'] === 'string') return `code.commit:${properties['hash']}`;
  if ((kind === 'code.author' || kind === 'code.signature') && typeof properties['email'] === 'string') return `code.author:${properties['email']}`;
  const recordKey = properties['recordKey'];
  return typeof recordKey === 'string' ? recordKey : String(recordKey ?? '');
}

function gitDateOf(localClock: string | null, offsetMin: number | null): string | undefined {
  if (localClock === null || offsetMin === null) return undefined;
  const sign = offsetMin < 0 ? '-' : '+';
  const total = Math.abs(offsetMin);
  return `${localClock}${sign}${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The repository a file, folder or gitlink names in its key, and the node it is. */
const REPOSITORY_KEY = (alias: string): string => `(${alias}.key->'repository'->'key'->>'name')`;
/** The path a file, folder or gitlink names in its key. */
const PATH_KEY = (alias: string): string => `(${alias}.key->>'path')`;

/**
 * Whether a vertex has an edge of one relation, as SQL: the entity's id is looked up once (an InitPlan), never per row
 * (a bulk read of 1 846 rows made 1 846 index scans of `entity` for the relation's name), and only the base context
 * counts, as every edge read does.
 */
const EDGE_EXISTS = (side: 'from_node' | 'to_node', relation: string, node: string): string =>
  `EXISTS (SELECT 1 FROM edge e WHERE e.${side} = ${node}.id AND e.context_id = 1 AND e.entity_id = (SELECT id FROM entity WHERE name = '${relation}'))`;

/**
 * One open opinion of a node's table as a jsonb array: its id, its producer and version, its language, its evidence —
 * or, for a bulk read, its language and its values alone (`values`): a list shows values, and nothing in a list shows
 * where a value was stated, so a listing does not pay to carry and parse the evidence of every opinion it reads
 * (madarch-64o5.2: 1 800 files with 5 538 opinions were 2.25 MB and 63 ms, against 1.21 MB and 24 ms without them).
 */
const OPINIONS_OF = (table: string, node: string, columns: readonly string[], values = false): string =>
  `(SELECT jsonb_agg(jsonb_build_object(${values ? '' : `'id', o."id"::text, 'said_by', o."said_by", `}'lang', o."lang"${values ? '' : `, 'evidence', o."evidence"`}${columns.map((column) => `, '${column}', o."${column}"`).join('')}) ORDER BY o."id")
     FROM ${table} o WHERE o."node_id" = ${node}.id AND o."state" = 'open' AND o."context_id" = 1)`;

/** The opinion columns of an entity row: every open opinion of the entity's kind, as jsonb arrays. */
const ENTITY_OPINION_COLUMNS = `  CASE WHEN k.name = '${GIT_KINDS.file}' THEN (SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence",
      'mode', o."mode", 'language', o."language", 'languages', o."languages",
      'blob', bb."hash", 'bytes', bb."bytes"::text, 'form', bb."form", 'lines', bb."lines"::text) ORDER BY o."id")
    FROM ${GIT_TABLES.file} o LEFT JOIN ${GIT_TABLES.blob} bb ON bb.id = o."blob_id"
    WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1) END AS file_opinions,
  CASE WHEN k.name = '${GIT_KINDS.commit}' THEN ${OPINIONS_OF(GIT_TABLES.commit, 'n', ['subject', 'author_date', 'author_offset_min', 'commit_date', 'commit_offset_min'])} END AS commit_opinions,
  CASE WHEN k.name = '${GIT_KINDS.repository}' THEN ${OPINIONS_OF(GIT_TABLES.repository, 'n', ['url', 'default_branch'])} END AS repository_opinions,`;

/** The same opinions without their sources: a bulk read of a kind's entities answers every value and no evidence. */
const ENTITY_VALUE_COLUMNS = `  CASE WHEN k.name = '${GIT_KINDS.file}' THEN (SELECT jsonb_agg(jsonb_build_object('lang', o."lang",
      'mode', o."mode", 'language', o."language", 'languages', o."languages",
      'blob', bb."hash", 'bytes', bb."bytes"::text, 'form', bb."form", 'lines', bb."lines"::text) ORDER BY o."id")
    FROM ${GIT_TABLES.file} o LEFT JOIN ${GIT_TABLES.blob} bb ON bb.id = o."blob_id"
    WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1) END AS file_opinions,
  CASE WHEN k.name = '${GIT_KINDS.commit}' THEN ${OPINIONS_OF(GIT_TABLES.commit, 'n', ['subject', 'author_date', 'author_offset_min', 'commit_date', 'commit_offset_min'], true)} END AS commit_opinions,
  CASE WHEN k.name = '${GIT_KINDS.repository}' THEN ${OPINIONS_OF(GIT_TABLES.repository, 'n', ['url', 'default_branch'], true)} END AS repository_opinions,`;

/** The same columns without the opinions: the history and graph reads answer keys, labels and edges only. */
const ENTITY_PLAIN_COLUMNS = `  NULL AS file_opinions, NULL AS commit_opinions, NULL AS repository_opinions,`;

/** The scope of a row when the caller names none: its repository's node, or its commit's repository. */
const ENTITY_SCOPE_EXPRESSION = `(CASE WHEN k.name = '${GIT_KINDS.repository}' THEN n.id
    WHEN k.name IN ('${GIT_KINDS.directory}', '${GIT_KINDS.file}', '${GIT_KINDS.gitlink}') THEN (SELECT rn.id FROM node rn JOIN entity re ON re.id = rn.entity_id AND re.name = '${GIT_KINDS.repository}' WHERE rn.key->>'name' = ${REPOSITORY_KEY('n')} AND rn.context_id = 1 LIMIT 1)
    ELSE coalesce(
      (SELECT min(he.from_node) FROM edge he JOIN entity hk ON hk.id = he.entity_id AND hk.name = '${GIT_KINDS.history}' WHERE he.to_node = n.id AND he.context_id = 1),
      (SELECT min(h2.from_node) FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}'
         JOIN edge h2 ON h2.to_node = ae.to_node AND h2.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.history}') AND h2.context_id = 1 WHERE ae.from_node = n.id AND ae.context_id = 1)
    ) END)::text`;

/**
 * The entity rows' statement: the key's values, the opinions (or none), the commit's author and the scope. A caller that
 * knows the scope — a history read of one repository — passes it, and every row carries it as a constant, so no row looks
 * its repository up; a caller that names none gets the correlated lookup, and reads few rows.
 */
function entitySelectSql(scope: string | null, columns: 'full' | 'values' | 'plain'): string {
  const scopeColumn = scope !== null && /^\d+$/u.test(scope) ? `'${scope}'::text` : ENTITY_SCOPE_EXPRESSION;
  return `SELECT n.id::text AS node_id, k.name AS kind,
  CASE WHEN k.name = '${GIT_KINDS.repository}' THEN (n.key->>'name') ELSE ${REPOSITORY_KEY('n')} END AS repository_name,
  ${REPOSITORY_KEY('n')} AS scope_repository_name,
  ${PATH_KEY('n')} AS path,
  (n.key->>'hash') AS commit_hash, (n.key->>'name') AS signature_name, (n.key->>'email') AS email,
${columns === 'plain' ? ENTITY_PLAIN_COLUMNS : columns === 'values' ? ENTITY_VALUE_COLUMNS : ENTITY_OPINION_COLUMNS}
  CASE WHEN k.name = '${GIT_KINDS.commit}' THEN (SELECT count(*)::int FROM edge pe JOIN entity pk ON pk.id = pe.entity_id AND pk.name = '${GIT_KINDS.parent}' WHERE pe.from_node = n.id AND pe.context_id = 1) ELSE 0 END AS parent_count,
  CASE WHEN k.name = '${GIT_KINDS.commit}' THEN (SELECT sa.key->>'name' FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}' JOIN node sa ON sa.id = ae.from_node WHERE ae.to_node = n.id AND ae.context_id = 1 LIMIT 1) END AS commit_author_name,
  CASE WHEN k.name = '${GIT_KINDS.commit}' THEN (SELECT sa.key->>'email' FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}' JOIN node sa ON sa.id = ae.from_node WHERE ae.to_node = n.id AND ae.context_id = 1 LIMIT 1) END AS commit_author_email,
  ${scopeColumn} AS scope
 FROM node n JOIN entity k ON k.id = n.entity_id AND n.context_id = 1 AND NOT n.removed`;
}

/** A value with the keys of every object in code point order, so two equal values render equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const held = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(held).sort().map((key) => [key, canonical(held[key])]));
  }
  return value;
}

/** The places one opinion's evidence list names, as a reader holds them: a file place, a conversation or an opinion. */
function evidencePlaces(value: unknown): readonly GraphEvidence[] {
  if (!Array.isArray(value)) return [];
  const out: GraphEvidence[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const held = entry as Record<string, unknown>;
    if (held['type'] === 'conversation') out.push({ type: 'conversation', id: String(held['id'] ?? ''), speaker: typeof held['speaker'] === 'string' ? held['speaker'] : null, at: typeof held['at'] === 'string' ? held['at'] : null, field: '', repository: null, path: null, lineStart: null, lineEnd: null, commit: null });
    else if (held['type'] === 'opinion') out.push({ type: 'opinion', id: String(held['id'] ?? ''), field: '', repository: null, path: null, lineStart: null, lineEnd: null, commit: null });
    else out.push({
      type: 'file',
      field: '',
      repository: typeof held['repository'] === 'string' ? held['repository'] : null,
      path: typeof held['path'] === 'string' ? held['path'] : null,
      lineStart: typeof held['line_start'] === 'number' ? held['line_start'] : null,
      lineEnd: typeof held['line_end'] === 'number' ? held['line_end'] : null,
      commit: typeof held['commit_or_digest'] === 'string' ? held['commit_or_digest'] : null,
    });
  }
  return out;
}

/** A text as a SQL literal: a kind's name stands in the counts that name it. */
function quoteLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** A table, column or key name of a generated table: lower-case letters, digits and underscores, quoted. */
function quoteColumn(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) throw new Error(`src/knowledge/graph-read.ts:1: ${JSON.stringify(name)} is not a column of a generated table: a column is a lower-case identifier`);
  return `"${name}"`;
}

/** The select over one manifest-declared kind's table: the vertices an opinion stands for, with their keys. */
function generatedSelect(decl: GeneratedKindRead): string {
  return `SELECT DISTINCT n.id::text AS node_id, n.key AS key FROM ${decl.table} t JOIN node n ON n.id = t.node_id WHERE t.state = 'open' AND NOT n.removed`;
}

/** One column's value as a reader holds it: a count as a number, a flag as a boolean, everything else as it stands. */
function valueOfColumn(value: unknown, type: GeneratedKindRead['types'][string]): unknown {
  if (value === null || value === undefined) return value;
  if (type === 'integer' || type === 'bigint') return Number(value);
  if (type === 'boolean') return value === true || value === 't' || value === 'true';
  return value;
}

/** One open opinion of an entity, as the reader holds it: its id, its producer, its language, its evidence, its values. */
interface GraphOpinion {
  readonly id: string;
  readonly producer: string;
  readonly saidBy: string;
  readonly lang: string | null;
  readonly evidence: readonly { readonly field: string; readonly value: unknown }[];
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * The opinions one aggregate column reads, from the jsonb array the statement builds. A bulk read (`sources`) states the
 * values alone: it carries no opinion id, no producer and no evidence, so nothing here may guess that it has them.
 */
function graphOpinions(value: unknown, fields: readonly string[], sources = true): GraphOpinion[] {
  // A plain read (the history and graph blocks) carries no opinion column: nothing is assembled for it.
  if (!Array.isArray(value) || value.length === 0) return [];
  return value.map((entry) => {
    const held = (entry ?? {}) as Record<string, unknown>;
    const saidBy = sources ? String(held['said_by'] ?? '') : '';
    const at = saidBy.lastIndexOf('@');
    const language = held['lang'] === null || held['lang'] === undefined ? null : String(held['lang']);
    const places = sources && Array.isArray(held['evidence']) ? held['evidence'] as readonly Record<string, unknown>[] : [];
    return {
      id: sources ? String(held['id'] ?? '') : '',
      saidBy,
      producer: at < 0 ? saidBy : saidBy.slice(0, at),
      lang: language,
      evidence: places.map((one) => ({ field: '', value: one })),
      values: Object.fromEntries(fields.map((field) => [field, held[field]])),
    };
  });
}

/** One field's values across opinions, each with its source. */
function fieldOpinions(opinions: readonly GraphOpinion[], field: string): { readonly value: unknown }[] {
  return opinions.flatMap((opinion) => (opinion.values[field] === null || opinion.values[field] === undefined ? [] : [{ value: opinion.values[field] }]));
}

/** One field's value when every opinion that states it agrees, else the list of their distinct values. */
function agreedValue(opinions: readonly GraphOpinion[], field: string): unknown {
  const values = fieldOpinions(opinions, field).map((one) => one.value);
  const distinct = new Map(values.map((one) => [JSON.stringify(one), one]));
  if (distinct.size === 0) return undefined;
  return distinct.size === 1 ? values[0] : [...distinct.values()];
}

/** One entity's opinions as the wiki holds them: every value with its opinion id, producer, language and evidence. */
function entityOpinions(opinions: readonly GraphOpinion[]): GraphEntityOpinion[] {
  const out: GraphEntityOpinion[] = [];
  for (const opinion of opinions) {
    for (const [field, value] of Object.entries(opinion.values)) {
      if (value === null || value === undefined) continue;
      out.push({ field, value, opinionId: opinion.id, producer: opinion.saidBy, lang: opinion.lang, evidence: evidencePlaces(opinionEvidence(opinion)) });
    }
  }
  return out;
}

/** The raw evidence list of one opinion. */
function opinionEvidence(opinion: GraphOpinion): unknown {
  return opinion.evidence.map((one) => one.value);
}

function keyOf(row: Raw): string {
  const kind = String(row['kind']);
  if (kind === `${GIT_KINDS.repository}`) return `code.repository:${String(row['repository_name'])}`;
  if (kind === `${GIT_KINDS.directory}`) return `code.directory:${String(row['scope_repository_name'])}/${String(row['path'])}`;
  if (kind === `${GIT_KINDS.file}`) return `code.file:${String(row['scope_repository_name'])}/${String(row['path'])}`;
  if (kind === `${GIT_KINDS.gitlink}`) return `code.gitlink:${String(row['scope_repository_name'])}/${String(row['path'])}`;
  if (kind === `${GIT_KINDS.commit}`) return `code.commit:${String(row['commit_hash'])}`;
  if (kind === `${GIT_KINDS.signature}`) return `code.author:${String(row['email'])}`;
  return `${kind}:${String(row['node_id'])}`;
}

function labelOf(row: Raw): string {
  const kind = String(row['kind']);
  if (kind === `${GIT_KINDS.repository}`) return String(row['repository_name']);
  if (kind === `${GIT_KINDS.directory}` || kind === `${GIT_KINDS.file}`) return String(row['path']);
  if (kind === `${GIT_KINDS.commit}`) return String(row['subject'] ?? row['commit_hash']);
  if (kind === `${GIT_KINDS.signature}`) return `${String(row['signature_name'])} <${String(row['email'])}>`;
  return String(row['node_id']);
}

/**
 * One entity row as the wiki holds it. `sources` says whether the row's statement carried the opinions' ids, producers
 * and evidence: a single entity's read does, a bulk listing (`entitiesOfKinds`) does not, and its entities therefore
 * carry no `evidence` or `opinions` — a list shows values, and no page shows where a value was stated from a list.
 */
function entityOf(row: Raw, sources = true): GraphEntity {
  const graphKind = String(row['kind']);
  const kind = WIKI_KIND[graphKind] ?? graphKind;
  const properties: Record<string, unknown> = { recordKey: keyOf(row) };
  const fileOpinions = graphOpinions(row['file_opinions'], ['mode', 'blob', 'bytes', 'form', 'lines', 'language', 'languages'], sources);
  const commitOpinions = graphOpinions(row['commit_opinions'], ['subject', 'author_date', 'author_offset_min', 'commit_date', 'commit_offset_min'], sources);
  const repositoryOpinions = graphOpinions(row['repository_opinions'], ['url', 'default_branch'], sources);
  if (graphKind === `${GIT_KINDS.repository}`) {
    properties['name'] = row['repository_name'];
    properties['url'] = agreedValue(repositoryOpinions, 'url');
    properties['defaultBranch'] = agreedValue(repositoryOpinions, 'default_branch');
  } else if (graphKind === `${GIT_KINDS.directory}` || graphKind === `${GIT_KINDS.file}` || graphKind === `${GIT_KINDS.gitlink}`) {
    properties['repository'] = row['scope_repository_name'];
    properties['path'] = row['path'];
    if (graphKind === `${GIT_KINDS.file}`) {
      // Every field the opinions agree on is its value; fields they differ on stand as every value, with the opinions
      // beside them (A4: nothing wins by rule).
      properties['mode'] = agreedValue(fileOpinions, 'mode');
      properties['blob'] = agreedValue(fileOpinions, 'blob');
      const bytes = agreedValue(fileOpinions, 'bytes');
      properties['bytes'] = bytes === undefined ? undefined : typeof bytes === 'string' ? Number(bytes) : bytes;
      properties['form'] = agreedValue(fileOpinions, 'form');
      const lines = agreedValue(fileOpinions, 'lines');
      properties['lines'] = lines === undefined ? undefined : typeof lines === 'string' ? Number(lines) : lines;
      const languages = agreedValue(fileOpinions, 'languages');
      const candidates = Array.isArray(languages) && languages.every((one) => typeof one === 'string') ? languages as string[] : [];
      // The file's programming language is an opinion field, like its mode: the opinion's `lang` is the natural language
      // of a text value, and a language name is no such text (madarch-64o5.2, the files worker's finding).
      properties['language'] = agreedValue(fileOpinions, 'language');
      properties['candidates'] = candidates;
    }
  } else if (graphKind === `${GIT_KINDS.commit}`) {
    properties['hash'] = row['commit_hash'];
    properties['subject'] = agreedValue(commitOpinions, 'subject');
    properties['authoredAt'] = gitDateOf(agreedValue(commitOpinions, 'author_date') as string | null, agreedValue(commitOpinions, 'author_offset_min') as number | null);
    properties['committedAt'] = gitDateOf(agreedValue(commitOpinions, 'commit_date') as string | null, agreedValue(commitOpinions, 'commit_offset_min') as number | null);
    properties['effectiveAt'] = properties['committedAt'];
    properties['merge'] = Number(row['parent_count'] ?? 0) > 1;
    properties['onFirstParent'] = true;
    if (row['commit_author_name'] !== null && row['commit_author_name'] !== undefined) properties['author'] = row['commit_author_name'];
    if (row['commit_author_email'] !== null && row['commit_author_email'] !== undefined) properties['authorEmail'] = row['commit_author_email'];
  } else if (graphKind === `${GIT_KINDS.signature}`) {
    properties['name'] = row['signature_name'];
    properties['email'] = row['email'];
  }
  const opinions = sources ? [...entityOpinions(fileOpinions), ...entityOpinions(commitOpinions), ...entityOpinions(repositoryOpinions)] : [];
  const evidence: GraphEvidence[] = [];
  if (sources) for (const one of opinions) for (const place of one.evidence) evidence.push(Object.assign({}, place, { field: one.field, ...(one.producer === '' ? {} : { saidBy: one.producer }) }));
  const span = spanOf(properties['span']) ?? spanFromProvenance(properties);
  return {
    key: presentedKey(kind, properties), kind, label: labelOf(row), properties,
    nodeIds: [String(row['node_id'])], scope: String(row['scope'] ?? ''),
    ...(span === undefined ? {} : { span }),
    ...(evidence.length === 0 ? {} : { evidence }),
    ...(opinions.length === 0 ? {} : { opinions }),
  };
}

/** The history's open opinion of one edge's own values: the attributes a reader shows beside the relation. */
/**
 * One edge's own values, as the wiki shows them beside the relation: every open opinion of the edge in the base
 * context is read, a field they all agree on is its value, and a field they differ on is the list of their values —
 * no producer's opinion is picked, and the newest row is not privileged (the review of stage 1c, finding 4).
 */
async function edgeProperties(tx: OuterTransaction, edgeId: string, graphKind: string): Promise<Record<string, unknown>> {
  const opinions = async (table: string, columns: readonly string[]): Promise<Record<string, unknown>[]> => {
    const found = await tx.query<Record<string, unknown>>(`SELECT ${columns.map((column) => `o."${column}"`).join(', ')} FROM ${table} o WHERE o."edge_id" = $1::bigint AND o."state" = 'open' AND o."context_id" = 1 ORDER BY o."id"`, [edgeId]);
    return found.rows;
  };
  const agreed = (rows: readonly Record<string, unknown>[], field: string): unknown => {
    const values = rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined);
    const distinct = new Map(values.map((value) => [JSON.stringify(value), value]));
    if (distinct.size === 0) return undefined;
    return distinct.size === 1 ? values[0] : [...distinct.values()];
  };
  if (graphKind === `${GIT_KINDS.touched}`) {
    const rows = await opinions(GIT_TABLES.touched, ['change', 'added', 'removed']);
    const added = agreed(rows, 'added');
    const removed = agreed(rows, 'removed');
    return { change: agreed(rows, 'change'), added: added === undefined ? undefined : Number(added), removed: removed === undefined ? undefined : Number(removed) };
  }
  if (graphKind === `${GIT_KINDS.parent}`) return { position: agreed(await opinions(GIT_TABLES.parent_position, ['position']), 'position') };
  if (graphKind === `${GIT_KINDS.history}`) return { walk: agreed(await opinions(GIT_TABLES.history, ['walk']), 'walk') };
  return {};
}


/** The repository as the graph states it, and the page a block shows of it. */
export interface GraphRepositoryFacts {
  readonly nodeId: string;
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string | null;
  readonly asIsCommit: string | null;
  readonly asIsHref: string | null;
  readonly counts: { readonly files: number; readonly commits: number; readonly folders: number };
  readonly gaps: readonly { readonly what: string; readonly reason: string }[];
  readonly steps: { readonly tree: boolean; readonly history: boolean };
}

/** One file of a repository as a block shows it. */
export interface GraphFileFacts {
  readonly repository: string;
  readonly path: string;
  readonly id: string;
  readonly href: string;
  readonly mode: string | null;
  readonly blob: string | null;
  readonly bytes: number | null;
  readonly lines: number | null;
  readonly form: 'text' | 'binary' | null;
  readonly language: string | null;
  readonly candidates: readonly string[];
  readonly created: (FileDate & { readonly href: string }) | null;
  readonly modified: (FileDate & { readonly href: string }) | null;
  readonly commitCount: number;
  readonly authors: readonly string[];
}

/** One file of a folder's listing: the fields the table shows, not the facts of its own page. */
export interface GraphFolderFile {
  readonly path: string;
  readonly id: string;
  readonly href: string;
  readonly mode: string | null;
  readonly blob: string | null;
  readonly bytes: number | null;
  readonly lines: number | null;
  readonly form: 'text' | 'binary' | null;
  readonly language: string | null;
  readonly candidates: readonly string[];
}

/** One page of a folder's own folders and files. */
export interface GraphFolderFacts {
  readonly repository: string;
  readonly id: string;
  readonly folder: string;
  readonly parent: { readonly path: string; readonly href: string } | null;
  readonly folders: readonly { readonly path: string; readonly href: string }[];
  readonly files: readonly GraphFolderFile[];
  readonly nextHref: string | null;
}

/** One commit, its author and dates, its parents and the paths it changed. */
export interface GraphCommitFacts {
  readonly repository: string;
  readonly hash: string;
  readonly href: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly authorDate: string;
  readonly authorOffsetMin: number;
  readonly commitDate: string;
  readonly commitOffsetMin: number;
  readonly subject: string;
  readonly parents: readonly string[];
  readonly changed: readonly { readonly path: string; readonly change: string | null; readonly added: number | null; readonly removed: number | null; readonly previousPath: string | null; readonly href: string | null }[];
}

/** The text one file held at one commit, or why the graph holds none of that version. */
export type ContentAt = { readonly text: string } | { readonly absent: string };

export class GraphReader {
  constructor(
    private readonly owner: DatabaseOwner,
    _validAt: () => Promise<string> | string,
    private readonly scope?: string,
    private readonly transaction?: OuterTransaction,
    /** The graph kinds the product declares; a reader without a set answers every kind a store holds. */
    private readonly declared?: ReadonlySet<string>,
    /** The kinds the manifest's own field declarations build tables for, by graph kind. */
    private readonly generated?: ReadonlyMap<string, GeneratedKindRead>,
  ) {}

  /** One page's repository facts: every block of a page asks for the same repository, and it is read once. */
  private readonly repositoryMemo = new Map<string, Promise<GraphRepositoryFacts | null>>();

  /** One page's history evidence: two blocks of a page ask for the same repository's story, and it is read once. */
  private readonly historyMemo = new Map<string, Promise<HistoryEvidence>>();

  at(instant: string, scope: string): GraphReader {
    return new GraphReader(this.owner, () => instant, BigInt(scope).toString(), this.transaction, this.declared, this.generated);
  }

  /** Whether the product declares the graph kind; a reader without a set answers every kind. */
  private holds(kind: string): boolean {
    return this.declared === undefined || this.declared.has(kind) || this.generated?.has(kind) === true;
  }

  /** The manifest-declared kind a key or a listing names, when the product's tables hold it. */
  private generatedKind(kind: string): GeneratedKindRead | undefined {
    return this.generated?.get(kind);
  }

  async landmarkPlan(_repo?: string, _scope?: string, _head?: string): Promise<LandmarkPlan | undefined> {
    return undefined;
  }

  private async run<T>(work: (tx: OuterTransaction) => Promise<T>): Promise<T> {
    if (this.transaction !== undefined) return await work(this.transaction);
    return await this.owner.transaction('snapshot', work);
  }

  private scoped(entities: readonly GraphEntity[]): GraphEntity[] {
    return this.scope === undefined ? [...entities] : entities.filter((entity) => entity.scope === this.scope);
  }

  async find(key: string): Promise<GraphEntity[]> {
    const colon = key.indexOf(':');
    const prefix = colon < 0 ? key : key.slice(0, colon);
    const tail = colon < 0 ? '' : key.slice(colon + 1);
    const generated = this.generatedKind(prefix);
    if (generated !== undefined) return this.scoped(await this.run(async (tx) => await this.generatedFind(tx, generated, tail)));
    const graphKind = graphKindOf(prefix);
    if (graphKind === undefined || !this.holds(graphKind)) return [];
    return await this.run(async (tx) => {
      const referenceKind = graphKind === `${GIT_KINDS.directory}` || graphKind === `${GIT_KINDS.file}` || graphKind === `${GIT_KINDS.gitlink}`;
      const slash = referenceKind ? tail.indexOf('/') : -1;
      const repository = slash < 0 ? '' : tail.slice(0, slash);
      const path = slash < 0 ? tail : tail.slice(slash + 1);
      const condition = graphKind === `${GIT_KINDS.repository}` ? `(k.name = '${GIT_KINDS.repository}' AND n.key->>'name' = $2)`
        : graphKind === `${GIT_KINDS.commit}` ? "(n.key->>'hash') = $2"
          : graphKind === `${GIT_KINDS.signature}` ? "(n.key->>'email') = $2"
            : referenceKind && repository !== '' ? `(${REPOSITORY_KEY('n')} = $2 AND ${PATH_KEY('n')} = $3)` : `${PATH_KEY('n')} = $2`;
      const params = referenceKind && repository !== '' ? [graphKind, repository, path] : [graphKind, referenceKind ? path : tail];
      const found = await tx.query<Raw>(`${entitySelectSql(this.scope ?? null, 'full')} WHERE k.name = $1 AND ${condition} ORDER BY n.id`, params);
      return this.scoped(found.rows.map((row) => entityOf(row)));
    });
  }


  /** The owner a graph read opens its own statement on: the page's transaction while a page is drawn, never a nested one. */
  private storeOwner(): DatabaseOwner {
    const transaction = this.transaction;
    if (transaction === undefined) return this.owner;
    const owner = this.owner;
    return new Proxy(owner, {
      get(target, key) {
        if (key === 'transaction') return async (_mode: string, work: (tx: OuterTransaction) => Promise<unknown>) => await work(transaction);
        if (key === 'run') return async (work: (tx: OuterTransaction) => Promise<unknown>) => await work(transaction);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseOwner;
  }

  /**
   * One repository as the graph states it: its facts, its as-is commit, its counts and its gaps. This is the graph's
   * answer, never a page model of another store.
   */
  async repository(name: string): Promise<GraphRepositoryFacts | null> {
    const held = this.repositoryMemo.get(name);
    if (held !== undefined) return await held;
    const read = this.repositoryOnce(name);
    this.repositoryMemo.set(name, read);
    // A read that failed stands no cache entry: the next block asks again rather than inheriting the failure.
    read.catch(() => { if (this.repositoryMemo.get(name) === read) this.repositoryMemo.delete(name); });
    return await read;
  }

  /** The repository's facts, read once for the page that holds this reader. */
  private async repositoryOnce(name: string): Promise<GraphRepositoryFacts | null> {
    const facts = await repositoryFacts(this.storeOwner(), name).catch((error: unknown) => { if (missingTable(error)) return null; throw error; });
    if (facts === null) return null;
    return {
      nodeId: facts.nodeId, id: `code.repository:${facts.name}`, name: facts.name, url: facts.url,
      defaultBranch: facts.defaultBranch, asIsCommit: facts.asIsCommit,
      asIsHref: facts.asIsCommit === null ? null : entityAddress(`code.commit:${facts.asIsCommit}`),
      counts: { files: facts.fileCount, commits: facts.commitCount, folders: facts.directoryCount },
      gaps: facts.gaps, steps: { tree: facts.asIsCommit !== null, history: facts.commitCount > 0 },
    };
  }

  /** Every repository the graph holds, in code point order of the names, each read as its page states it. */
  async repositoryFactsAll(): Promise<GraphRepositoryFacts[]> {
    const held = await listRepositories(this.storeOwner());
    const out: GraphRepositoryFacts[] = [];
    for (const one of held) {
      const facts = await this.repository(one.name);
      if (facts !== null) out.push(facts);
    }
    return out;
  }

  /** The text of one file the files producer stored: null when the graph holds none (binary, no fill read it, or the path left the tree). */
  async content(repository: string, path: string): Promise<string | null> {
    return await fileContent(this.storeOwner(), repository, path).catch((error: unknown) => { if (missingTable(error)) return null; throw error; });
  }

  /** The text of many files at once, by path: the listing's titles read in one statement, never one per file. */
  async contentsOf(repository: string, paths: readonly string[]): Promise<Map<string, string | null>> {
    return await fileContents(this.storeOwner(), repository, paths).catch((error: unknown) => { if (missingTable(error)) return new Map<string, string | null>(); throw error; });
  }

  /**
   * The text one file held at one commit, or why the graph holds none of that version: a path no commit after it
   * touched stands on the blob it has now, and a path one did touch is absent by name, never answered with today's text.
   */
  async contentAt(repository: string, path: string, commit: string): Promise<ContentAt> {
    const held = await fileTextAt(this.storeOwner(), repository, path, commit).catch((error: unknown) => {
      if (missingTable(error)) return { absent: 'no-file' as const };
      throw error;
    });
    if ('text' in held) return held;
    const where = `${JSON.stringify(path)} of ${JSON.stringify(repository)}`;
    switch (held.absent) {
      case 'no-file': return { absent: `the graph holds no file ${where} in the current tree: the fill has not read it (src/knowledge/graph-read.ts)` };
      case 'binary': return { absent: `the blob ${where} stood on at ${commit} is binary: the files producer stores no text of it (src/knowledge/graph-read.ts)` };
      case 'touched-after': return { absent: `a commit after ${commit} changed ${where}, and the graph keeps no text of the version before it: the answer is absent, never today's text under that commit's name (src/knowledge/graph-read.ts)` };
      case 'commit-not-in-history': return { absent: `the graph's history of ${JSON.stringify(repository)} holds no commit ${commit}: it cannot name the text ${where} held there (src/knowledge/graph-read.ts)` };
      case 'unread': return { absent: `the graph holds no text of ${where} at the commit ${commit}: the fill stored no content for its blob (src/knowledge/graph-read.ts)` };
    }
  }

  /**
   * One page of a repository's current Markdown documents, in code point order: the path rule stands in the statement,
   * so a repository of more files than a page holds still answers its documents, and a store that holds no such
   * repository answers an empty page.
   */
  async documents(repository: string, options: { readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
    return await listDocuments(this.storeOwner(), { repository, suffixes: DOCUMENT_SUFFIXES, ...(options.after === undefined ? {} : { after: options.after }), limit: options.limit })
      .catch((error: unknown) => { if (missingTable(error)) return { rows: [] as readonly FileRecord[], next: null }; throw error; });
  }

  /** One page of a repository's files, for an agent's listing: the graph's own answer, never a checkout's. */
  async files(repository: string, options: { readonly prefix?: string; readonly language?: string; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
    return await listFiles(this.storeOwner(), { repository, ...(options.prefix === undefined ? {} : { prefix: options.prefix }), ...(options.language === undefined ? {} : { language: options.language }), ...(options.after === undefined ? {} : { after: options.after }), limit: options.limit }).catch((error: unknown) => { if (missingTable(error)) return { rows: [], next: null }; throw error; });
  }

  /** One file with its dates and authors, as the graph holds it. */
  async file(repository: string, path: string): Promise<GraphFileFacts | null> {
    const facts = await fileFacts(this.storeOwner(), repository, path);
    if (facts === null) return null;
    return {
      repository, path, id: `code.file:${repository}/${path}`, href: entityAddress(`code.file:${repository}/${path}`),
      mode: facts.mode, blob: facts.blob, bytes: facts.bytes, lines: facts.lines, form: facts.form, language: facts.language, candidates: [...facts.candidates],
      created: facts.created === null ? null : { ...facts.created, href: entityAddress(`code.commit:${facts.created.commit}`) },
      modified: facts.modified === null ? null : { ...facts.modified, href: entityAddress(`code.commit:${facts.modified.commit}`) },
      commitCount: facts.commitCount, authors: [...facts.authors],
    };
  }

  /** One page of the commits that touched a path. */
  async fileHistory(repository: string, path: string, options: { readonly after?: { readonly walk: number; readonly commit: string }; readonly limit: number }): Promise<{ readonly rows: readonly FileHistoryRow[]; readonly next: { readonly walk: number; readonly commit: string } | null }> {
    return await fileHistory(this.storeOwner(), { repository, path, limit: options.limit, ...(options.after === undefined ? {} : { after: options.after }) });
  }

  /** One commit of a repository with its author, dates, parents and changed paths. */
  async commit(repository: string, hash: string): Promise<GraphCommitFacts | null> {
    const facts = await commitWithPaths(this.storeOwner(), repository, hash);
    if (facts === null) return null;
    const hrefOf = (path: string): string | null => entityAddress(`code.file:${repository}/${path}`);
    return {
      repository, hash: facts.hash, href: entityAddress(`code.commit:${facts.hash}`), author: { name: facts.author.name, email: facts.author.email },
      authorDate: facts.authorDate, authorOffsetMin: facts.authorOffsetMin, commitDate: facts.commitDate, commitOffsetMin: facts.commitOffsetMin,
      subject: facts.subject, parents: [...facts.parents],
      changed: facts.touched.map((one) => ({ path: one.path, change: one.change, added: one.added, removed: one.removed, previousPath: one.previousPath, href: one.change === 'deleted' ? null : hrefOf(one.path) })),
    };
  }

  /** One folder's page: its own subfolders and one page of its files, bounded by the cursor the page carries. */
  async folder(repository: string, folder: string, after: string | undefined, limit: number): Promise<GraphFolderFacts | null> {
    const facts = await this.repository(repository);
    if (facts === null || facts.asIsCommit === null) return null;
    const directories = await listDirectories(this.storeOwner(), repository);
    const found = folder === '' ? undefined : directories.find((one) => one.path === folder);
    if (folder !== '' && found === undefined) return null;
    const parent = folder === '' ? null : found?.parent ?? '';
    const page = await folderFiles(this.storeOwner(), { repository, folder, limit, ...(after === undefined ? {} : { after }) });
    const files: GraphFolderFile[] = page.rows.map((row) => ({
      path: row.path, id: `code.file:${repository}/${row.path}`, href: entityAddress(`code.file:${repository}/${row.path}`),
      mode: row.mode, blob: row.blob, bytes: row.bytes, lines: row.lines, form: row.form, language: row.language, candidates: [...row.candidates],
    }));
    const children = await folderChildrenOf(this.storeOwner(), repository, folder);
    const id = folder === '' ? `code.repository:${repository}` : `code.directory:${repository}/${folder}`;
    return {
      repository, id, folder,
      parent: parent === null || parent === '' ? null : { path: parent, href: entityAddress(`code.directory:${repository}/${parent}`) },
      folders: [...children].sort(byCodePoint).map((path) => ({ path, href: entityAddress(`code.directory:${repository}/${path}`) })),
      files,
      nextHref: page.next === null ? null : `${entityAddress(id)}?after=${encodeURIComponent(page.next)}`,
    };
  }

  /** The entities of one manifest-declared kind whose key values are the tail's, split on `/`. */
  private async generatedFind(tx: OuterTransaction, decl: GeneratedKindRead, tail: string): Promise<GraphEntity[]> {
    const values: string[] = [];
    let rest = tail;
    for (let at = 0; at < decl.key.length - 1; at += 1) {
      const cut = rest.indexOf('/');
      if (cut < 0) return [];
      values.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
    }
    values.push(rest);
    const where = decl.key.map((column, at) => `n.key->>'${column.replaceAll("'", "''")}' = $${String(at + 1)}`).join(' AND ');
    const found = await tx.query<Raw>(`${generatedSelect(decl)} AND ${where} ORDER BY node_id`, values);
    return await this.generatedEntities(tx, decl, found.rows);
  }

  /**
   * The rows of one manifest-declared kind as the wiki's entities: the vertex's key, and every open opinion of the
   * kind's fields. A field every opinion agrees on is that value; a field they differ on is every value, and every
   * value carries its opinion's id, producer, language and evidence, so no value is ever shown without its source.
   */
  private async generatedEntities(tx: OuterTransaction, decl: GeneratedKindRead, rows: readonly Raw[]): Promise<GraphEntity[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => String(row['node_id']));
    const opinionColumns = ['t.node_id::text AS node', 't.id::text AS opinion_id', 't.said_by', 't.lang', 't.evidence', ...decl.columns.map((column) => `t.${quoteColumn(column)} AS ${quoteColumn(column)}`)];
    const opinions = await tx.query<Raw>(
      `SELECT ${opinionColumns.join(', ')} FROM ${decl.table} t WHERE t.node_id = ANY($1::bigint[]) AND t.state = 'open' AND t.context_id = 1 ORDER BY t.id`,
      [`{${ids.join(',')}}`],
    );
    const held = new Map<string, Raw[]>();
    for (const opinion of opinions.rows) {
      const list = held.get(String(opinion['node'])) ?? [];
      list.push(opinion);
      held.set(String(opinion['node']), list);
    }
    return rows.map((row) => {
      const node = String(row['node_id']);
      const keyObject = (row['key'] ?? {}) as Record<string, unknown>;
      const keyValues = decl.key.map((column) => String(keyObject[column] ?? ''));
      const key = `${decl.kind}:${keyValues.join('/')}`;
      const properties: Record<string, unknown> = {};
      for (const column of decl.key) properties[column] = valueOfColumn(keyObject[column], decl.types[column] ?? 'text');
      const entityOpinions: GraphEntityOpinion[] = [];
      const evidence: GraphEvidence[] = [];
      for (const column of decl.columns) {
        const stated: unknown[] = [];
        for (const opinion of held.get(node) ?? []) {
          const value = valueOfColumn(opinion[column], decl.types[column] ?? 'text');
          if (value === null || value === undefined) continue;
          stated.push(value);
          const places = evidencePlaces(opinion['evidence']).map((place) => Object.assign({}, place, { field: column, saidBy: String(opinion['said_by']) }));
          entityOpinions.push({ field: column, value, opinionId: String(opinion['opinion_id']), producer: String(opinion['said_by']), lang: typeof opinion['lang'] === 'string' ? opinion['lang'] : null, evidence: places });
          evidence.push(...places);
        }
        const distinct = new Map(stated.map((one) => [JSON.stringify(canonical(one)), one]));
        if (distinct.size === 1) properties[column] = stated[0];
        else if (distinct.size > 1) properties[column] = [...distinct.values()];
      }
      properties['recordKey'] = key;
      const label = keyValues[0] ?? key;
      return { key, kind: decl.kind, label, properties, nodeIds: [node], scope: '', ...(evidence.length === 0 ? {} : { evidence }), ...(entityOpinions.length === 0 ? {} : { opinions: entityOpinions }) };
    });
  }

  async kindCounts(): Promise<{ kind: string; count: number }[]> {
    const parts: string[] = [];
    const ofKind = (name: string, alias: string): string => `node ${alias} JOIN entity e_${alias} ON e_${alias}.id = ${alias}.entity_id AND e_${alias}.name = '${name}'`;
    // Every count is of rows a reader sees: the base context, a vertex no removal hides, and its `contains` or
    // `history` relation standing.
    if (this.holds(`${GIT_KINDS.repository}`)) parts.push(`SELECT '${GIT_KINDS.repository}' AS kind, count(*)::text AS n FROM ${ofKind(GIT_KINDS.repository, 'r')} WHERE NOT r.removed AND r.context_id = 1`);
    if (this.holds(`${GIT_KINDS.directory}`)) parts.push(`SELECT '${GIT_KINDS.directory}', count(*)::text FROM ${ofKind(GIT_KINDS.directory, 'd')} JOIN edge e ON e.to_node = d.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.context_id = 1 WHERE NOT d.removed AND d.context_id = 1`);
    if (this.holds(`${GIT_KINDS.file}`)) parts.push(`SELECT '${GIT_KINDS.file}', count(*)::text FROM ${ofKind(GIT_KINDS.file, 'f')} JOIN edge e ON e.to_node = f.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.context_id = 1 WHERE NOT f.removed AND f.context_id = 1`);
    if (this.holds(`${GIT_KINDS.commit}`)) parts.push(`SELECT '${GIT_KINDS.commit}', count(*)::text FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.history}' JOIN node c ON c.id = e.to_node AND c.context_id = 1 AND NOT c.removed WHERE e.context_id = 1`);
    if (this.holds(`${GIT_KINDS.signature}`)) parts.push(`SELECT '${GIT_KINDS.signature}', count(*)::text FROM ${ofKind(GIT_KINDS.signature, 's')} WHERE NOT s.removed AND s.context_id = 1 AND EXISTS (SELECT 1 FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.authored}' WHERE e.from_node = s.id AND e.context_id = 1)`);
    for (const decl of this.generated?.values() ?? []) parts.push(`SELECT ${quoteLiteral(decl.kind)} AS kind, count(DISTINCT n.id)::text AS n FROM ${decl.table} t JOIN node n ON n.id = t.node_id WHERE t.state = 'open' AND t.context_id = 1 AND n.context_id = 1 AND NOT n.removed`);
    if (parts.length === 0) return [];
    return await this.run(async (tx) => {
      const found = await tx.query<{ kind: string; n: string }>(parts.join(' UNION ALL '));
      return found.rows.map((row) => ({ kind: WIKI_KIND[row.kind] ?? row.kind, count: Number(row.n) })).sort((a, b) => byCodePoint(a.kind, b.kind));
    });
  }

  async list(kind: string, options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    return await this.listKinds([kind], options);
  }

  /**
   * The wiki-wide search over the one graph: the entities of the declared kinds whose label or key holds the text, at
   * most `perKind` of each kind, with each kind's own total. The read is the same store the lists are read from.
   */
  async search(kinds: readonly string[], text: string, options: { perKind: number; limit: number }): Promise<{ kind: string; total: number; entities: GraphEntity[] }[]> {
    const needle = text.trim();
    if (kinds.length === 0 || needle === '') return [];
    const groups: { kind: string; total: number; entities: GraphEntity[] }[] = [];
    let remaining = options.limit;
    for (const kind of kinds) {
      if (remaining <= 0) break;
      const page = await this.list(kind, { q: needle, limit: Math.min(options.perKind, remaining) });
      if (page.total === 0) continue;
      groups.push({ kind, total: page.total, entities: page.rows });
      remaining -= page.rows.length;
    }
    return groups.sort((a, b) => byCodePoint(a.kind, b.kind));
  }

  async listOperations(options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    return await this.listKinds(['code.operation', 'code.channel'], options);
  }

  private async listKinds(kinds: readonly string[], options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    const graphKinds = kinds.map(graphKindOf).filter((one): one is string => one !== undefined && this.holds(one));
    const generated = kinds.map((kind) => this.generatedKind(kind)).filter((one): one is GeneratedKindRead => one !== undefined);
    if (graphKinds.length === 0 && generated.length === 0) return { rows: [], next: null, total: 0 };
    return await this.run(async (tx) => {
      // A page of a manifest-declared kind is chosen in SQL — its key's fields are the order and the cursor — and only
      // the page's opinions are loaded (the review of stage 1c, finding 15). A read of several kinds, or of code kinds,
      // merges what each kind answers and is bounded by those kinds' own counts.
      if (graphKinds.length === 0 && generated.length === 1) return await this.generatedPage(tx, generated[0]!, options);
      const entities = [...await this.entitiesOfKinds(tx, graphKinds), ...await this.generatedOfKinds(tx, generated)];
      const text = options.q === undefined || options.q.trim() === '' ? undefined : options.q.trim().toLowerCase();
      const matching = entities.filter((entity) => text === undefined || entity.key.toLowerCase().includes(text) || entity.label.toLowerCase().includes(text));
      matching.sort((a, b) => byCodePoint(a.key, b.key));
      const tail = options.after === undefined ? matching : matching.filter((entity) => byCodePoint(entity.key, options.after!) > 0);
      const shown = tail.slice(0, options.limit);
      return { rows: shown, next: tail.length > options.limit ? shown[shown.length - 1]?.key ?? null : null, total: matching.length };
    });
  }

  /**
   * One page of one manifest-declared kind, chosen in SQL: the key's values in the contract's order are the order and
   * the cursor, the search is a position over them, and the opinions of the page's vertices are loaded afterwards.
   */
  private async generatedPage(tx: OuterTransaction, decl: GeneratedKindRead, options: { q?: string; after?: string; limit: number }): Promise<{ rows: GraphEntity[]; next: string | null; total: number }> {
    const fields = decl.key.map((field) => `n.key->>'${field.replaceAll("'", "''")}'`);
    const rendered = fields.length === 0 ? `n.id::text` : `concat_ws('/', ${fields.join(', ')})`;
    const text = options.q === undefined || options.q.trim() === '' ? undefined : options.q.trim().toLowerCase();
    const after = options.after === undefined || options.after === '' ? null : (options.after.startsWith(`${decl.kind}:`) ? options.after.slice(decl.kind.length + 1) : options.after);
    const where = `t.state = 'open' AND t.context_id = 1 AND n.context_id = 1 AND NOT n.removed AND ($1::text IS NULL OR position($1::text in lower((${rendered}))) > 0) AND ($2::text IS NULL OR (${rendered}) > $2::text)`;
    const page = await tx.query<Raw>(`SELECT n.id::text AS node_id, n.key AS key FROM ${decl.table} t JOIN node n ON n.id = t.node_id WHERE ${where} ORDER BY (${rendered}) LIMIT $3::bigint`, [text ?? null, after, String(options.limit + 1)]);
    const total = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${decl.table} t JOIN node n ON n.id = t.node_id WHERE t.state = 'open' AND t.context_id = 1 AND n.context_id = 1 AND NOT n.removed AND ($1::text IS NULL OR position($1::text in lower((${rendered}))) > 0)`, [text ?? null]);
    const more = page.rows.length > options.limit;
    const shown = more ? page.rows.slice(0, options.limit) : page.rows;
    const entities = await this.generatedEntities(tx, decl, shown);
    return { rows: entities, next: more ? entities[entities.length - 1]?.key ?? null : null, total: Number(total.rows[0]?.n ?? '0') };
  }

  private async entitiesOfKinds(tx: OuterTransaction, graphKinds: readonly string[]): Promise<GraphEntity[]> {
    // A read of no code kind asks the store nothing: a product that declares only its own kinds holds no code table.
    if (graphKinds.length === 0) return [];
    const found = await tx.query<Raw>(
      `${entitySelectSql(this.scope ?? null, 'values')} WHERE k.name = ANY($1::text[])
       AND (k.name NOT IN ('${GIT_KINDS.directory}', '${GIT_KINDS.file}') OR ${EDGE_EXISTS('to_node', GIT_KINDS.contains, 'n')})
       AND (k.name <> '${GIT_KINDS.commit}' OR ${EDGE_EXISTS('to_node', GIT_KINDS.history, 'n')})
       AND (k.name <> '${GIT_KINDS.signature}' OR ${EDGE_EXISTS('from_node', GIT_KINDS.authored, 'n')})
       ORDER BY n.id`,
      [`{${graphKinds.join(',')}}`],
    );
    return this.scoped(found.rows.map((row) => entityOf(row, false)));
  }

  /** The entities of every manifest-declared kind a read names, from the tables their declarations made. */
  private async generatedOfKinds(tx: OuterTransaction, kinds: readonly GeneratedKindRead[]): Promise<GraphEntity[]> {
    const entities: GraphEntity[] = [];
    for (const decl of kinds) {
      const found = await tx.query<Raw>(`${generatedSelect(decl)} ORDER BY node_id`);
      entities.push(...await this.generatedEntities(tx, decl, found.rows));
    }
    return entities;
  }

  private async entitiesOfIds(tx: OuterTransaction, ids: readonly string[], scope: string | null = this.scope ?? null): Promise<Map<string, GraphEntity>> {
    if (ids.length === 0) return new Map();
    const found = await tx.query<Raw>(`${entitySelectSql(scope, 'plain')} WHERE n.id = ANY($1::bigint[]) ORDER BY n.id`, [`{${ids.join(',')}}`]);
    const held = new Map(found.rows.map((row) => [String(row['node_id']), entityOf(row)]));
    // A node the code kinds' select did not answer is one of a manifest-declared kind: its table answers it.
    const missing = ids.filter((id) => !held.has(id));
    if (missing.length === 0) return held;
    for (const decl of this.generated?.values() ?? []) {
      const rows = await tx.query<Raw>(`${generatedSelect(decl)} AND n.id = ANY($1::bigint[]) ORDER BY node_id`, [`{${missing.join(',')}}`]);
      for (const entity of await this.generatedEntities(tx, decl, rows.rows)) held.set(entity.nodeIds[0]!, entity);
    }
    return held;
  }

  async neighbors(entity: GraphEntity, options: { relations?: readonly string[]; direction?: 'out' | 'in' | 'both'; limit: number }): Promise<NeighborGroup[]> {
    if (this.declared !== undefined && this.declared.size === 0) return [];
    const wanted = (options.relations ?? ['code.contains', 'code.touched', 'code.authored', 'code.parent', 'code.renamed-to'])
      .map((relation) => ({ relation, graph: graphRelationOf(relation) }))
      .filter((one): one is { relation: string; graph: { kind: string } } => one.graph !== undefined);
    if (wanted.length === 0) return [];
    const directions: ('out' | 'in')[] = options.direction === 'out' ? ['out'] : options.direction === 'in' ? ['in'] : ['out', 'in'];
    return await this.run(async (tx) => {
      const found = await tx.query<Record<string, string>>(
        `SELECT e.id::text AS id, rk.name AS relation, e.from_node::text AS from_node, e.to_node::text AS to_node
         FROM edge e JOIN entity rk ON rk.id = e.entity_id
         WHERE rk.name = ANY($1::text[]) AND (e.from_node = ANY($2::bigint[]) OR e.to_node = ANY($2::bigint[]))`,
        [`{${[...new Set(wanted.map((one) => one.graph.kind))].join(',')}}`, `{${entity.nodeIds.join(',')}}`],
      );
      const groups: NeighborGroup[] = [];
      for (const direction of directions) {
        const [self, far] = direction === 'out' ? ['from_node', 'to_node'] : ['to_node', 'from_node'];
        const relevant = found.rows.filter((row) => entity.nodeIds.includes(row[self]!) && wanted.some((one) => one.graph.kind === row['relation']));
        const byRelation = new Map<string, Map<string, number>>();
        for (const row of relevant) {
          const relationName = row['relation']!;
          const wiki = WIKI_RELATION[relationName] ?? `code.${relationName}`;
          const held = byRelation.get(wiki) ?? new Map<string, number>();
          const other = row[far]!;
          held.set(other, (held.get(other) ?? 0) + 1);
          byRelation.set(wiki, held);
        }
        for (const [relation, byOther] of [...byRelation].sort((a, b) => byCodePoint(a[0], b[0]))) {
          const ids = [...byOther.keys()];
          const entities = await this.entitiesOfIds(tx, ids);
          const ordered = ids.map((id) => ({ id, entity: entities.get(id) })).filter((one): one is { id: string; entity: GraphEntity } => one.entity !== undefined).sort((a, b) => byCodePoint(a.entity.key, b.entity.key));
          const shown = ordered.slice(0, options.limit);
          groups.push({ relation, direction, total: ordered.length, edges: [...byOther.values()].reduce((sum, count) => sum + count, 0), rows: shown.map((one) => ({ entity: one.entity, edges: byOther.get(one.id) ?? 1 })) });
        }
      }
      return groups;
    });
  }

  async edgesOf(entity: GraphEntity, relation: string, direction: 'out' | 'in', limit: number): Promise<{ total: number; rows: NeighborEdge[] }> {
    if (this.declared !== undefined && this.declared.size === 0) return { total: 0, rows: [] };
    const graph = graphRelationOf(relation);
    if (graph === undefined) return { total: 0, rows: [] };
    const [self, far] = direction === 'out' ? ['from_node', 'to_node'] : ['to_node', 'from_node'];
    return await this.run(async (tx) => {
      const found = await tx.query<{ id: string; other: string; discriminator: string }>(
        `SELECT e.id::text AS id, e.${far}::text AS other, e.discriminator FROM edge e JOIN entity k ON k.id = e.entity_id
         WHERE k.name = $1 AND e.${self} = ANY($2::bigint[]) ORDER BY e.${far}, e.id`,
        [graph.kind, `{${entity.nodeIds.join(',')}}`],
      );
      const keys = [...new Set(found.rows.map((row) => row.other))];
      const entities = await this.entitiesOfIds(tx, keys);
      const ordered = keys.map((id) => entities.get(id)).filter((one): one is GraphEntity => one !== undefined).sort((a, b) => byCodePoint(a.key, b.key));
      const shown = ordered.slice(0, limit);
      const rows: NeighborEdge[] = [];
      for (const other of shown) {
        const edges = found.rows.filter((row) => row.other === other.nodeIds[0]);
        const first = edges[0];
        if (first === undefined) continue;
        rows.push({ relation, direction, other, properties: { ...(await edgeProperties(tx, first.id, graph.kind)), discriminator: first.discriminator, sites: edges.length }, position: null });
      }
      return { total: ordered.length, rows };
    });
  }

  async containers(entity: GraphEntity, relation: string, limit = 8): Promise<GraphEntity[]> {
    if (this.declared !== undefined && this.declared.size === 0) return [];
    const graph = graphRelationOf(relation);
    if (graph === undefined) return [];
    return await this.run(async (tx) => {
      const chain: GraphEntity[] = [];
      let current = entity;
      const seen = new Set<string>([entity.key]);
      for (let step = 0; step < limit; step += 1) {
        const parent = await tx.query<{ node: string }>(
          `SELECT e.from_node::text AS node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $1 WHERE e.to_node = ANY($2::bigint[]) LIMIT 1`,
          [graph.kind, `{${current.nodeIds.join(',')}}`],
        );
        const id = parent.rows[0]?.node;
        if (id === undefined) break;
        const [next] = [...(await this.entitiesOfIds(tx, [id])).values()];
        if (next === undefined || seen.has(next.key)) break;
        seen.add(next.key);
        chain.push(next);
        current = next;
      }
      return chain;
    });
  }

  async reach(entity: GraphEntity, relation: string, depth: number, limit: number): Promise<{ total: number; rows: { entity: GraphEntity; hops: number }[] }> {
    if (this.declared !== undefined && this.declared.size === 0) return { total: 0, rows: [] };
    const graph = graphRelationOf(relation);
    if (graph === undefined) return { total: 0, rows: [] };
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; hops: number }>(
        `WITH RECURSIVE reach(node_id, hops) AS (
           SELECT e.to_node, 1 FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $2 WHERE e.from_node = ANY($1::bigint[])
           UNION
           SELECT e.to_node, p.hops + 1 FROM reach p JOIN edge e ON e.from_node = p.node_id JOIN entity k ON k.id = e.entity_id AND k.name = $2 WHERE p.hops < $3::int
         )
         SELECT node_id::text AS node, min(hops)::int AS hops FROM reach GROUP BY node_id ORDER BY hops, node_id`,
        [`{${entity.nodeIds.join(',')}}`, graph.kind, depth],
      );
      const wanted = found.rows.filter((row) => !entity.nodeIds.includes(row.node));
      const shown = wanted.slice(0, limit);
      const entities = await this.entitiesOfIds(tx, shown.map((row) => row.node));
      return { total: wanted.length, rows: shown.flatMap((row) => { const one = entities.get(row.node); return one === undefined || one.key === entity.key ? [] : [{ entity: one, hops: Number(row.hops) }]; }) };
    });
  }

  async byPrefix(kind: string, prefix: string, limit: number, after?: string): Promise<{ total: number; rows: GraphEntity[] }> {
    if (this.declared !== undefined && this.declared.size === 0) return { total: 0, rows: [] };
    const graphKind = graphKindOf(kind);
    if (graphKind === undefined || !this.holds(graphKind)) return { total: 0, rows: [] };
    return await this.run(async (tx) => {
      const entities = await this.entitiesOfKinds(tx, [graphKind]);
      const referenceKind = graphKind === `${GIT_KINDS.directory}` || graphKind === `${GIT_KINDS.file}` || graphKind === `${GIT_KINDS.gitlink}`;
      const head = `code.${graphKind}:`;
      const rest = prefix.startsWith(head) ? prefix.slice(head.length) : '';
      const pathPrefix = referenceKind && rest !== '' && rest.includes('/') ? rest : undefined;
      const matching = entities.filter((entity) => pathPrefix !== undefined
        ? String(entity.properties['path'] ?? '').startsWith(pathPrefix)
        : entity.key.startsWith(prefix)).sort((a, b) => byCodePoint(a.key, b.key));
      const tail = after === undefined ? matching : matching.filter((entity) => byCodePoint(entity.key, after) > 0);
      return { total: matching.length, rows: tail.slice(0, limit) };
    });
  }

  async relationEdges(relation: string, limit: number): Promise<{ total: number; rows: RelationEdge[] }> {
    if (this.declared !== undefined && this.declared.size === 0) return { total: 0, rows: [] };
    const graph = graphRelationOf(relation);
    if (graph === undefined) return { total: 0, rows: [] };
    return await this.run(async (tx) => {
      const found = await tx.query<{ id: string; from_node: string; to_node: string; discriminator: string }>(
        `SELECT e.id::text AS id, e.from_node::text AS from_node, e.to_node::text AS to_node, e.discriminator
         FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $1 ORDER BY e.from_node, e.to_node, e.discriminator, e.id`,
        [graph.kind],
      );
      const entities = await this.entitiesOfIds(tx, [...new Set(found.rows.flatMap((row) => [row.from_node, row.to_node]))]);
      const rows: RelationEdge[] = [];
      for (const row of found.rows.slice(0, limit)) {
        const from = entities.get(row.from_node);
        const to = entities.get(row.to_node);
        if (from === undefined || to === undefined) continue;
        rows.push({ discriminator: row.discriminator, from: { key: from.key, kind: from.kind, label: from.label }, to: { key: to.key, kind: to.kind, label: to.label }, properties: await edgeProperties(tx, row.id, graph.kind) });
      }
      return { total: found.rows.length, rows };
    });
  }

  /** The in-degrees of entities the caller already read: one query for every entity, never one lookup per key. */
  async inDegreesOf(relation: string, entities: readonly GraphEntity[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>(entities.map((entity) => [entity.key, 0]));
    if (entities.length === 0) return counts;
    const graph = graphRelationOf(relation);
    if (graph === undefined) return counts;
    const ids = entities.flatMap((entity) => entity.nodeIds);
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; n: string }>(
        `SELECT e.to_node::text AS node, count(DISTINCT e.id)::text AS n FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $1
         WHERE e.to_node = ANY($2::bigint[]) GROUP BY 1`,
        [graph.kind, `{${ids.join(',')}}`],
      );
      const byNode = new Map(entities.flatMap((entity) => entity.nodeIds.map((id) => [id, entity.key] as const)));
      for (const row of found.rows) {
        const key = byNode.get(row.node);
        if (key !== undefined) counts.set(key, Number(row.n));
      }
      return counts;
    });
  }

  async inDegrees(relation: string, keys: readonly string[]): Promise<Map<string, number>> {
    if (this.declared !== undefined && this.declared.size === 0) return new Map(keys.map((key) => [key, 0]));
    const counts = new Map<string, number>(keys.map((key) => [key, 0]));
    if (keys.length === 0) return counts;
    const graph = graphRelationOf(relation);
    if (graph === undefined) return counts;
    const entities = new Map<string, GraphEntity>();
    for (const key of keys) for (const entity of await this.find(key)) entities.set(key, entity);
    const ids = [...entities.values()].flatMap((entity) => entity.nodeIds);
    if (ids.length === 0) return counts;
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; n: string }>(
        `SELECT e.to_node::text AS node, count(DISTINCT e.id)::text AS n FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = $1
         WHERE e.to_node = ANY($2::bigint[]) GROUP BY 1`,
        [graph.kind, `{${ids.join(',')}}`],
      );
      for (const row of found.rows) for (const [key, entity] of entities) if (entity.nodeIds.includes(row.node)) counts.set(key, Number(row.n));
      return counts;
    });
  }

  /** A commit's parents with their churn and author, in parent order. */
  async commitParents(commit: GraphEntity): Promise<{ entity: GraphEntity; when: string; who?: string; files: number; added: number; removed: number }[]> {
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; date: string | null; who: string | null; files: number; added: number; removed: number }>(
        `SELECT e.to_node::text AS node,
                to_char(pc.commit_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
                (sn.key->>'name') AS who,
                count(te.id)::int AS files,
                coalesce(sum(t.added), 0)::int AS added,
                coalesce(sum(t.removed), 0)::int AS removed
         FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
         JOIN LATERAL (SELECT o.position FROM ${GIT_TABLES.parent_position} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pp ON true
         JOIN node cn ON cn.id = e.to_node
         LEFT JOIN LATERAL (SELECT o.commit_date FROM ${GIT_TABLES.commit} o WHERE o.node_id = cn.id AND o.state = 'open' AND split_part(o.said_by, '@', 1) = 'git-history' ORDER BY o.id DESC LIMIT 1) pc ON true
         LEFT JOIN edge ae ON ae.to_node = cn.id AND ae.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.authored}')
         LEFT JOIN node sn ON sn.id = ae.from_node
         LEFT JOIN edge te ON te.from_node = cn.id AND te.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.touched}')
         LEFT JOIN LATERAL (SELECT o.added, o.removed FROM ${GIT_TABLES.touched} o WHERE o.edge_id = te.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) t ON true
         WHERE e.from_node = $1::bigint
         GROUP BY e.to_node, pc.commit_date, (sn.key->>'name'), pp.position
         ORDER BY pp.position`,
        [commit.nodeIds[0] ?? '0'],
      );
      const entities = await this.entitiesOfIds(tx, found.rows.map((row) => row.node));
      return found.rows.flatMap((row) => {
        const entity = entities.get(row.node);
        return entity === undefined ? [] : [{
          entity, when: row.date ?? '', ...(row.who === null ? {} : { who: row.who }),
          files: row.files, added: row.added, removed: row.removed,
        }];
      });
    });
  }

  /** The commits on a merge's other parents that its first parent does not reach. */
  async commitBranches(commit: GraphEntity, limit: number): Promise<{ entity: GraphEntity; when: string; who?: string }[]> {
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; date: string | null; who: string | null }>(
        `WITH RECURSIVE first(commit) AS (
           SELECT e.to_node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
             JOIN LATERAL (SELECT o.position FROM ${GIT_TABLES.parent_position} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pp ON true WHERE e.from_node = $1::bigint AND pp.position = 0
           UNION SELECT e.to_node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
             JOIN first f ON e.from_node = f.commit
         ), branch(commit) AS (
           SELECT e.to_node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
             JOIN LATERAL (SELECT o.position FROM ${GIT_TABLES.parent_position} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pp ON true WHERE e.from_node = $1::bigint AND pp.position > 0
           UNION SELECT e.to_node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
             JOIN branch b ON e.from_node = b.commit WHERE e.to_node NOT IN (SELECT commit FROM first)
         )
         SELECT c.id::text AS node, to_char(co.commit_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, (sn.key->>'name') AS who
         FROM branch b JOIN node c ON c.id = b.commit
         LEFT JOIN LATERAL (SELECT o.commit_date, o.subject FROM ${GIT_TABLES.commit} o WHERE o.node_id = c.id AND o.state = 'open' AND split_part(o.said_by, '@', 1) = 'git-history' ORDER BY o.id DESC LIMIT 1) co ON true
         LEFT JOIN edge ae ON ae.to_node = c.id AND ae.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.authored}')
         LEFT JOIN node sn ON sn.id = ae.from_node
         ORDER BY co.commit_date DESC, (c.key->>'hash') LIMIT $2::int`,
        [commit.nodeIds[0] ?? '0', limit],
      );
      const entities = await this.entitiesOfIds(tx, found.rows.map((row) => row.node));
      return found.rows.flatMap((row) => {
        const entity = entities.get(row.node);
        return entity === undefined ? [] : [{ entity, when: row.date ?? '', ...(row.who === null ? {} : { who: row.who }) }];
      });
    });
  }

  /** One commit's changed files in one read: churn, old path and symbol count, with the total, never one query per file. */
  async commitChanged(commit: GraphEntity, limit: number): Promise<{ rows: { entity: GraphEntity; change: string; added: number | null; removed: number | null; previousPath: string | null; symbols: number }[]; total: number }> {
    return await this.run(async (tx) => {
      const found = await tx.query<{ node: string; change: string; added: string | null; removed: string | null; previous: string | null; symbols: number; total: number }>(
        `SELECT e.to_node::text AS node, t.change, t.added::text AS added, t.removed::text AS removed,
                (pn.key->>'path') AS previous,
                (SELECT count(*)::int FROM edge se JOIN entity sk ON sk.id = se.entity_id AND sk.name = '${GIT_KINDS.contains}' WHERE se.from_node = e.to_node) AS symbols,
                count(*) OVER ()::int AS total
         FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
         JOIN LATERAL (SELECT o.change, o.added, o.removed FROM ${GIT_TABLES.touched} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) t ON true
         JOIN node ct ON ct.id = e.from_node
         LEFT JOIN edge r ON r.from_node = e.to_node AND r.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.renamedFrom}') AND r.discriminator = (ct.key->>'hash')
         LEFT JOIN node pn ON pn.id = r.to_node
         WHERE e.from_node = $1::bigint
         ORDER BY e.to_node LIMIT $2::int`,
        [commit.nodeIds[0] ?? '0', limit],
      );
      const entities = await this.entitiesOfIds(tx, found.rows.map((row) => row.node));
      return {
        total: found.rows[0]?.total ?? 0,
        rows: found.rows.flatMap((row) => {
          const entity = entities.get(row.node);
          return entity === undefined ? [] : [{
            entity, change: row.change, added: row.added === null ? null : Number(row.added),
            removed: row.removed === null ? null : Number(row.removed), previousPath: row.previous, symbols: row.symbols,
          }];
        }),
      };
    });
  }

  /** The bounded repository history the repository page's history block shows: aggregates and top rows, not every edge. */
  async repositoryHistory(scope: string, limit: number): Promise<{
    commits: number; firstParent: number; merges: number; nonMerge: number; authors: number;
    since?: string; until?: string;
    hotspots: { entity: GraphEntity; commits: number }[];
    hotspotsTotal: number;
    authorRows: { entity: GraphEntity; commits: number }[];
    authorsTotal: number;
  }> {
    return await this.run(async (tx) => {
      const summary = await tx.query<{ commits: number; merges: number; authors: number; since: string | null; until: string | null }>(
        `WITH hc AS (
           SELECT he.to_node AS commit FROM edge he JOIN entity hk ON hk.id = he.entity_id AND hk.name = '${GIT_KINDS.history}'
           WHERE he.from_node = $1::bigint
         )
         SELECT count(DISTINCT hc.commit)::int AS commits,
                count(DISTINCT hc.commit) FILTER (WHERE (
                  SELECT count(*) FROM edge pe JOIN entity pk ON pk.id = pe.entity_id AND pk.name = '${GIT_KINDS.parent}'
                  WHERE pe.from_node = hc.commit
                ) > 1)::int AS merges,
                (SELECT count(DISTINCT ae.from_node)::int FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}'
                  JOIN hc h2 ON h2.commit = ae.to_node) AS authors,
                to_char(min(o.commit_date AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS since,
                to_char(max(o.commit_date AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS until
         FROM hc JOIN ${GIT_TABLES.commit} o ON o.node_id = hc.commit AND o.state = 'open' AND o.context_id = 1`,
        [scope],
      );
      const row = summary.rows[0] ?? { commits: 0, merges: 0, authors: 0, since: null, until: null };
      const hotspots = await tx.query<{ node: string; n: number }>(
        `WITH hc AS (
           SELECT he.to_node AS commit FROM edge he JOIN entity hk ON hk.id = he.entity_id AND hk.name = '${GIT_KINDS.history}'
           WHERE he.from_node = $1::bigint
         )
         SELECT e.to_node::text AS node, count(*)::int AS n
         FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
         JOIN hc ON hc.commit = e.from_node
         WHERE (SELECT count(*) FROM edge pe JOIN entity pk ON pk.id = pe.entity_id AND pk.name = '${GIT_KINDS.parent}' WHERE pe.from_node = e.from_node) <= 1
         GROUP BY 1`,
        [scope],
      );
      // A rename joins two paths into one identity: the hotspots are the identity's, as the history projection reads them.
      const renamed = await tx.query<{ from: string; to: string }>(
        `SELECT e.from_node::text AS "from", e.to_node::text AS "to" FROM edge e
         JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.renamedFrom}'
         WHERE e.from_node = ANY($1::bigint[])`,
        [`{${hotspots.rows.map((one) => one.node).join(',') || '0'}}`],
      );
      const parentOf = new Map(renamed.rows.map((row) => [row.from, row.to]));
      const rootOf = (node: string): string => {
        let at = node; const seen = new Set<string>();
        while (parentOf.has(at) && !seen.has(at)) { seen.add(at); at = parentOf.get(at)!; }
        return at;
      };
      const merged = new Map<string, number>();
      for (const one of hotspots.rows) { const root = rootOf(one.node); merged.set(root, (merged.get(root) ?? 0) + one.n); }
      const hotspotEntities = await this.entitiesOfIds(tx, [...merged.keys()], scope);
      const authors = await tx.query<{ node: string; n: number }>(
        `WITH hc AS (
           SELECT he.to_node AS commit FROM edge he JOIN entity hk ON hk.id = he.entity_id AND hk.name = '${GIT_KINDS.history}'
           WHERE he.from_node = $1::bigint
         )
         SELECT ae.from_node::text AS node, count(*)::int AS n
         FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}'
         JOIN hc ON hc.commit = ae.to_node GROUP BY 1`,
        [scope],
      );
      const authorEntities = await this.entitiesOfIds(tx, authors.rows.map((one) => one.node));
      const sort = (rows: { node: string; n: number }[], entities: Map<string, GraphEntity>) => rows
        .flatMap((one) => { const entity = entities.get(one.node); return entity === undefined ? [] : [{ entity, commits: one.n }]; })
        .sort((left, right) => right.commits - left.commits || byCodePoint(left.entity.key, right.entity.key))
        .slice(0, limit);
      return {
        commits: row.commits, firstParent: row.commits, merges: row.merges, nonMerge: row.commits - row.merges,
        authors: row.authors, ...(row.since === null ? {} : { since: row.since }), ...(row.until === null ? {} : { until: row.until }),
        hotspots: sort([...merged].map(([node, n]) => ({ node, n })), hotspotEntities), hotspotsTotal: merged.size,
        authorRows: sort(authors.rows, authorEntities), authorsTotal: authors.rows.length,
      };
    });
  }

  async historyEvidence(scope: string): Promise<HistoryEvidence> {
    if (this.declared !== undefined && this.declared.size === 0) return { entities: [], edges: [] };
    const held = this.historyMemo.get(scope);
    if (held !== undefined) return await held;
    const read = this.historyEvidenceOnce(scope);
    this.historyMemo.set(scope, read);
    read.catch(() => { if (this.historyMemo.get(scope) === read) this.historyMemo.delete(scope); });
    return await read;
  }

  /** The history evidence of one scope, read once for the page that holds this reader. */
  private async historyEvidenceOnce(scope: string): Promise<HistoryEvidence> {
    return await this.run(async (tx) => {
      const found = await tx.query<Raw>(
        `${entitySelectSql(scope, 'plain')} WHERE
           n.id = $1::bigint
           OR (n.key->'repository'->'key'->>'name') = (SELECT r.key->>'name' FROM node r WHERE r.id = $1::bigint)
           OR n.id IN (SELECT e.to_node FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.history}' WHERE e.from_node = $1::bigint)
           OR n.id IN (SELECT ae.from_node FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}'
                        JOIN edge h ON h.to_node = ae.to_node AND h.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.history}') WHERE h.from_node = $1::bigint)
         ORDER BY n.id`,
        [scope],
      );
      const entities = found.rows.map((row) => entityOf(row));
      const byId = new Map(found.rows.map((row) => [String(row['node_id']), entityOf(row)]));
      const edges = await tx.query<{ id: string; relation: string; from_node: string; to_node: string; discriminator: string; change: string | null; added: string | null; removed: string | null; position: number | null; walk: number | null }>(
        `WITH evidence_nodes AS (
           SELECT n.id FROM node n
           WHERE n.id = $1::bigint OR (n.key->'repository'->'key'->>'name') = (SELECT r.key->>'name' FROM node r WHERE r.id = $1::bigint)
             OR n.id IN (SELECT he.to_node FROM edge he JOIN entity hk ON hk.id = he.entity_id AND hk.name = '${GIT_KINDS.history}' WHERE he.from_node = $1::bigint)
             OR n.id IN (SELECT ae.from_node FROM edge ae JOIN entity ak ON ak.id = ae.entity_id AND ak.name = '${GIT_KINDS.authored}'
                          JOIN edge he ON he.to_node = ae.to_node AND he.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.history}') WHERE he.from_node = $1::bigint)
         )
         SELECT e.id::text AS id, rk.name AS relation, e.from_node::text AS from_node, e.to_node::text AS to_node,
                e.discriminator, t.change, t.added::text AS added, t.removed::text AS removed, pp.position, h.walk
         FROM edge e JOIN entity rk ON rk.id = e.entity_id
         LEFT JOIN LATERAL (SELECT o.change, o.added, o.removed FROM ${GIT_TABLES.touched} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) t ON true
         LEFT JOIN LATERAL (SELECT o.position FROM ${GIT_TABLES.parent_position} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pp ON true
         LEFT JOIN LATERAL (SELECT o.walk FROM ${GIT_TABLES.history} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) h ON true
         WHERE rk.name IN ('${GIT_KINDS.contains}', '${GIT_KINDS.touched}', '${GIT_KINDS.authored}', '${GIT_KINDS.parent}', '${GIT_KINDS.renamedFrom}')
           AND e.from_node IN (SELECT id FROM evidence_nodes) AND e.to_node IN (SELECT id FROM evidence_nodes)
         ORDER BY rk.name, e.from_node, e.to_node, e.id`,
        [scope],
      );
      return {
        entities,
        edges: edges.rows.flatMap((row) => {
          const from = byId.get(row.from_node);
          const to = byId.get(row.to_node);
          if (from === undefined || to === undefined) return [];
          return [{ from: from.key, to: to.key, relation: WIKI_RELATION[row.relation] ?? `code.${row.relation}`, properties: {
            ...(row.change === null ? {} : { change: row.change }),
            ...(row.added === null ? {} : { added: Number(row.added) }),
            ...(row.removed === null ? {} : { removed: Number(row.removed) }),
            ...(row.position === null ? {} : { position: Number(row.position) }),
            ...(row.walk === null ? {} : { walk: Number(row.walk) }),
            ...(row.discriminator === '' ? {} : { discriminator: row.discriminator }),
          } }];
        }),
      };
    });
  }

  /**
   * The evidence a file's or an author's history page needs, bounded to that page: the file's own commits and the
   * files it changed with, or the author's commits and the files they touched. The whole repository's evidence is
   * never read for these two shapes.
   */
  async historyEvidenceFor(subject: GraphEntity, shape: 'path' | 'author', limit: number): Promise<HistoryEvidence> {
    if (this.declared !== undefined && this.declared.size === 0) return { entities: [], edges: [] };
    return await this.run(async (tx) => {
      const ids = `{${subject.nodeIds.join(',')}}`;
      const edgeRows = shape === 'author'
        ? await tx.query<Raw>(
          `WITH authored AS (
             SELECT e.to_node AS id FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.authored}' WHERE e.from_node = ANY($1::bigint[])
           ), touched AS (
             SELECT e.id FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
             WHERE e.from_node IN (SELECT id FROM authored)
               AND (SELECT count(*) FROM edge p JOIN entity pk ON pk.id = p.entity_id AND pk.name = '${GIT_KINDS.parent}' WHERE p.from_node = e.from_node) <= 1
           )
           SELECT e.id::text AS id, rk.name AS relation, e.from_node::text AS from_node, e.to_node::text AS to_node,
                  e.discriminator, t.change, t.added::text AS added, t.removed::text AS removed, pp.position, h.walk
           FROM edge e JOIN entity rk ON rk.id = e.entity_id
           LEFT JOIN LATERAL (SELECT o.change, o.added, o.removed FROM ${GIT_TABLES.touched} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) t ON true
           LEFT JOIN LATERAL (SELECT o.position FROM ${GIT_TABLES.parent_position} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pp ON true
           LEFT JOIN LATERAL (SELECT o.walk FROM ${GIT_TABLES.history} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) h ON true
           WHERE (rk.name = '${GIT_KINDS.authored}' AND e.from_node = ANY($1::bigint[]))
              OR (rk.name = '${GIT_KINDS.touched}' AND e.id IN (SELECT id FROM touched))`,
          [ids],
        )
        : await tx.query<Raw>(
          `WITH RECURSIVE focus AS (
             SELECT unnest($1::bigint[]) AS id
             UNION
             SELECT CASE WHEN e.from_node = f.id THEN e.to_node ELSE e.from_node END
             FROM focus f JOIN edge e ON e.from_node = f.id OR e.to_node = f.id
             JOIN entity rk ON rk.id = e.entity_id AND rk.name = '${GIT_KINDS.renamedFrom}'
           ), focus_commits AS (
             SELECT DISTINCT e.from_node AS id FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
             WHERE e.to_node IN (SELECT id FROM focus)
               AND (SELECT count(*) FROM edge p JOIN entity pk ON pk.id = p.entity_id AND pk.name = '${GIT_KINDS.parent}' WHERE p.from_node = e.from_node) <= 1
           ), coupled_all AS (
             SELECT e.to_node AS id, count(DISTINCT e.from_node) AS n FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
             WHERE e.from_node IN (SELECT id FROM focus_commits) AND e.to_node NOT IN (SELECT id FROM focus)
               AND (SELECT count(*) FROM edge p JOIN entity pk ON pk.id = p.entity_id AND pk.name = '${GIT_KINDS.parent}' WHERE p.from_node = e.from_node) <= 1
             GROUP BY 1 HAVING count(DISTINCT e.from_node) >= 2
           ), coupled AS (
             SELECT id, n FROM coupled_all ORDER BY n DESC, id LIMIT $2
           ), included AS (
             SELECT id FROM focus UNION SELECT id FROM coupled
           )
           SELECT e.id::text AS id, rk.name AS relation, e.from_node::text AS from_node, e.to_node::text AS to_node,
                  e.discriminator, t.change, t.added::text AS added, t.removed::text AS removed, pp.position, h.walk,
                  (SELECT count(*)::text FROM coupled_all) AS coupling_total
           FROM edge e JOIN entity rk ON rk.id = e.entity_id
           LEFT JOIN LATERAL (SELECT o.change, o.added, o.removed FROM ${GIT_TABLES.touched} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) t ON true
           LEFT JOIN LATERAL (SELECT o.position FROM ${GIT_TABLES.parent_position} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) pp ON true
           LEFT JOIN LATERAL (SELECT o.walk FROM ${GIT_TABLES.history} o WHERE o.edge_id = e.id AND o.state = 'open' ORDER BY o.id DESC LIMIT 1) h ON true
           WHERE (rk.name = '${GIT_KINDS.touched}' AND e.to_node IN (SELECT id FROM included) AND e.from_node IN (SELECT id FROM focus_commits))
              OR (rk.name = '${GIT_KINDS.authored}' AND e.to_node IN (SELECT id FROM focus_commits))
              OR rk.name IN ('${GIT_KINDS.renamedFrom}', '${GIT_KINDS.contains}', 'imports')`,
          [ids, limit],
        );
      const nodeIds = new Set<string>(subject.nodeIds);
      for (const row of edgeRows.rows) { nodeIds.add(row['from_node'] as string); nodeIds.add(row['to_node'] as string); }
      const entityRows = await tx.query<Raw>(`${entitySelectSql(subject.scope === '' ? null : subject.scope, 'plain')} WHERE n.id = ANY($1::bigint[]) ORDER BY n.id`, [`{${[...nodeIds].join(',')}}`]);
      const entities = entityRows.rows.map((row) => entityOf(row));
      const byId = new Map(entityRows.rows.map((row) => [String(row['node_id']), entityOf(row)]));
      const couplingTotal = edgeRows.rows.find((row) => row['coupling_total'] !== undefined)?.['coupling_total'];
      return {
        entities,
        ...(typeof couplingTotal === 'string' ? { couplingTotal: Number(couplingTotal) } : {}),
        edges: edgeRows.rows.flatMap((row) => {
          const from = byId.get(String(row['from_node']));
          const to = byId.get(String(row['to_node']));
          if (from === undefined || to === undefined) return [];
          return [{ from: from.key, to: to.key, relation: WIKI_RELATION[String(row['relation'])] ?? `code.${String(row['relation'])}`, properties: {
            ...(row['change'] === null ? {} : { change: row['change'] }),
            ...(row['added'] === null ? {} : { added: Number(row['added']) }),
            ...(row['removed'] === null ? {} : { removed: Number(row['removed']) }),
            ...(row['position'] === null ? {} : { position: Number(row['position']) }),
            ...(row['walk'] === null ? {} : { walk: Number(row['walk']) }),
            ...(row['discriminator'] === '' ? {} : { discriminator: row['discriminator'] }),
          } }];
        }),
      };
    });
  }

  async repositories(): Promise<{ nodeId: string; path: string }[]> {
    if (this.declared !== undefined && this.declared.size === 0) return [];
    return await this.run(async (tx) => {
      const found = await tx.query<{ node_id: string; name: string }>(`SELECT n.id::text AS node_id, (n.key->>'name') AS name FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.repository}' WHERE NOT n.removed ORDER BY name`);
      return found.rows.map((row) => ({ nodeId: row.node_id, path: row.name }));
    });
  }
}
