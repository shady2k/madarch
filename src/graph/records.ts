/** Reads of ordinary published repository facts, preserving every opinion and its evidence. */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import type { OuterTransaction } from '../history-types.js';
import { withSpan } from '../obs/trace.js';
import { GIT_KINDS, GIT_TABLES } from '../fill/stages/git-contract.js';
import type { EvidenceEntry } from './contract.js';

const REPOSITORY_OF = (alias: string): string => `(${alias}.key->>'repository')`;
const PATH_OF = (alias: string): string => `(${alias}.key->>'path')`;

/** One commit as a reader sees it. */
export interface CommitRecord {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly author: { readonly name: string; readonly email: string };
  /** The author's clock with its offset, as `git log %aI` writes it. */
  readonly authorDate: string;
  /** The offset `authorDate` stands at, in minutes east of UTC: the same number `authorDate` carries. */
  readonly authorOffsetMin: number;
  /** The committer's clock with its offset, as `git log %aI` writes it. */
  readonly commitDate: string;
  /** The offset `commitDate` stands at, in minutes east of UTC: the same number `commitDate` carries. */
  readonly commitOffsetMin: number;
  readonly subject: string;
}

/**
 * One git date as `git log %aI` writes it: the clock the author wrote, and the offset it stood at.
 *
 * The store keeps git's two numbers apart — the clock as it stood and the minutes east of UTC — and
 * a reader that gets the clock back must put the offset beside it, never convert the clock to UTC
 * and keep the offset.
 */
function gitDateOf(localClock: string, offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+';
  const total = Math.abs(offsetMin);
  return `${localClock}${sign}${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** One path the walk has not read: the store says so rather than answering nothing. */
export class RecordGap extends Error {}


// ---- what a reader asks ----------------------------------------------------

/**
 * One open opinion of a vertex or an edge, as the record reads hold it: its id (one sequence for the whole graph), the
 * producer and its version, the language of its text, the tagged evidence it rests on, and the field values it states.
 */
export interface HeldOpinion {
  readonly id: string;
  readonly saidBy: string;
  /** The producer's name, without its version: a new version is the same producer. */
  readonly producer: string;
  readonly lang: string | null;
  readonly evidence: readonly EvidenceEntry[];
  readonly values: Readonly<Record<string, unknown>>;
}

/** One value of one field and the opinion that stated it: value-to-source is never lost. */
export interface FieldValue<T> {
  readonly value: T;
  readonly opinion: HeldOpinion;
}

/** One field as the reads answer it: every opinion's value, and the value they all agree on (null when they differ). */
export interface FieldRead<T> {
  readonly value: T | null;
  readonly contested: boolean;
  readonly values: readonly FieldValue<T>[];
}

/** The opinions one aggregate reads, from the jsonb array a page's statement builds. */
function opinionsOfJson(value: unknown, carried: readonly string[]): HeldOpinion[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const held = (entry ?? {}) as Record<string, unknown>;
    const saidBy = String(held['said_by'] ?? '');
    const at = saidBy.lastIndexOf('@');
    const values: Record<string, unknown> = {};
    for (const field of [...carried, 'lang', 'mode', 'blob', 'bytes', 'form', 'lines', 'content', 'language', 'languages', 'subject', 'author_date', 'author_offset_min', 'commit_date', 'commit_offset_min', 'url', 'default_branch', 'history_shallow', 'change', 'added', 'removed', 'walk', 'position', 'other_repository', 'commit_hash', 'algorithm']) values[field] = held[field];
    return {
      id: String(held['id'] ?? ''),
      saidBy,
      producer: at < 0 ? saidBy : saidBy.slice(0, at),
      lang: held['lang'] === null || held['lang'] === undefined ? null : String(held['lang']),
      evidence: Array.isArray(held['evidence']) ? held['evidence'] as readonly EvidenceEntry[] : [],
      values,
    };
  });
}

/** One field across opinions: every value with its source, and the value they all agree on. */
export function fieldRead<T>(opinions: readonly HeldOpinion[], field: string, convert: (value: unknown) => T | null): FieldRead<T> {
  const values: FieldValue<T>[] = [];
  for (const opinion of opinions) {
    const held = convert(opinion.values[field]);
    if (held === null || held === undefined) continue;
    values.push({ value: held, opinion });
  }
  const distinct = new Set(values.map((one) => JSON.stringify(one.value)));
  return { value: distinct.size === 1 ? values[0]!.value : null, contested: distinct.size > 1, values };
}

/** A value as a text, or null where the opinion states none. */
function asText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** A value as a number, or null where the opinion states none. */
function asNumber(value: unknown): number | null {
  return value === null || value === undefined || value === '' ? null : Number(value);
}

/** Whether a file stands in its repository's current tree: the `contains` edge is what places it there. */
const IN_TREE = `EXISTS (SELECT 1 FROM edge e JOIN entity en2 ON en2.id = e.entity_id AND en2.name = '${GIT_KINDS.contains}' WHERE e.to_node = n.id)`;

/** The opinions of one file, as a jsonb array: each opinion's id, producer, language, evidence and the values it states. */
const FILE_OPINIONS = `LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence",
      'mode', o."mode", 'language', o."language", 'languages', o."languages",
      'blob', o."blob", 'bytes', o."bytes"::text, 'form', o."form", 'lines', o."lines"::text, 'content', o."content") ORDER BY o."id") AS opinions
    FROM ${GIT_TABLES.file} o
    WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1) fo ON true`;

/** The file columns a page reads: its key's path, and every open opinion of it with the blob it names. */
const FILE_SELECT = `SELECT (n.key->>'path') AS path, fo.opinions
  FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.file}'
  ${FILE_OPINIONS}`;

/** One file as a reader sees it: the fields every open opinion agrees on, and the opinions themselves. */
export interface FileRecord {
  readonly path: string;
  readonly mode: string | null;
  readonly blob: string | null;
  readonly bytes: number | null;
  readonly form: 'text' | 'binary' | null;
  readonly lines: number | null;
  /** The accepted language, or null when the opinions name candidates and no one language. */
  readonly language: string | null;
  readonly candidates: readonly string[];
  /** Every open opinion about the file, with its source: a field's value is never shown without it. */
  readonly opinions?: readonly HeldOpinion[];
}

/** One file as a reader sees it: the fields every open opinion agrees on, and the opinions themselves. */
function fileOf(row: Record<string, unknown>): FileRecord {
  const opinions = opinionsOfJson(row['opinions'], ['blob', 'bytes', 'form', 'lines']);
  const mode = fieldRead(opinions, 'mode', asText);
  const blob = fieldRead(opinions, 'blob', asText);
  const languages = fieldRead(opinions, 'languages', (value) => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : null));
  const language = fieldRead(opinions, 'language', asText);
  return {
    path: String(row['path']),
    mode: mode.value,
    blob: blob.value,
    bytes: fieldRead(opinions, 'bytes', asNumber).value,
    form: fieldRead(opinions, 'form', (value) => (value === 'binary' ? 'binary' : value === 'text' ? 'text' : null)).value,
    lines: fieldRead(opinions, 'lines', asNumber).value,
    language: language.value,
    candidates: [...(languages.value ?? (language.value === null ? [] : [language.value]))],
    opinions,
  };
}

/** One page's repository id: every read of a page's folder and files asks for it, and it is read once. */
const REPOSITORY_ID_MEMO = new WeakMap<object, Map<string, Promise<string>>>();

/** The repository's node id, or a gap when the store holds no such repository: read once per transaction. */
async function repositoryIdOf(tx: OuterTransaction, repository: string): Promise<string> {
  const memo = REPOSITORY_ID_MEMO.get(tx) ?? new Map<string, Promise<string>>();
  REPOSITORY_ID_MEMO.set(tx, memo);
  const held = memo.get(repository);
  if (held !== undefined) return await held;
  const read = readRepositoryId(tx, repository);
  memo.set(repository, read);
  read.catch(() => { if (memo.get(repository) === read) memo.delete(repository); });
  return await read;
}

/** The id of one repository, in one statement. */
async function readRepositoryId(tx: OuterTransaction, repository: string): Promise<string> {
  const found = await tx.query<{ node_id: string }>(
    `SELECT n.id::text AS node_id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.repository}' WHERE n.key @> jsonb_build_object('name', $1::text) AND n.context_id = 1 AND NOT n.removed`,
    [repository],
  );
  const row = found.rows[0];
  if (row === undefined) throw new RecordGap(`the store holds no repository ${JSON.stringify(repository)}: the fill of this step has not run for it (src/graph/records.ts)`);
  return row.node_id;
}


/** The files one page of a repository holds, paged in SQL before any opinion is loaded. */
async function filePage(tx: OuterTransaction, repository: string, where: string, extra: readonly unknown[], after: string | null, limit: number): Promise<Record<string, unknown>[]> {
  const found = await tx.query<Record<string, unknown>>(
    `SELECT (n.key->>'path') AS path, fo.opinions FROM (
       SELECT n.id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.file}'
       WHERE (n.key->>'repository') = $1::text AND n.context_id = 1 AND NOT n.removed AND ${IN_TREE} AND ${where}
         AND ($2::text IS NULL OR (n.key->>'path') > $2) ORDER BY (n.key->>'path') LIMIT $3::bigint) p
     JOIN node n ON n.id = p.id ${FILE_OPINIONS} ORDER BY (n.key->>'path')`,
    [repository, after, String(limit + 1), ...extra],
  );
  return found.rows;
}

export async function listFiles(owner: DatabaseOwner, input: { readonly repository: string; readonly prefix?: string; readonly language?: string; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
  return await withSpan('records.listFiles', {
    'records.prefix': input.prefix ?? '',
    'records.language': input.language ?? '',
    'records.limit': input.limit,
  }, async () => await owner.transaction('snapshot', async (tx) => {
    await repositoryIdOf(tx, input.repository);
    const where = `($4::text IS NULL OR left((n.key->>'path'), length($4::text)) = $4::text)
      AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM ${GIT_TABLES.file} lo WHERE lo."node_id" = n.id AND lo."state" = 'open' AND lo."context_id" = 1 AND lo."language" = $5))`;
    const found = await filePage(tx, input.repository, where, [input.prefix ?? null, input.language ?? null], input.after ?? null, input.limit);
    const rows = found.map(fileOf);
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    return { rows: shown, next: more ? shown[shown.length - 1]!.path : null };
  }));
}

/**
 * One page of a repository's current Markdown documents, in code point order of the paths. The suffix and the
 * hidden-folder rules stand in the statement, so a repository of many files answers with its documents and never with
 * the first files of the whole tree: a path a dot begins, and a path a folder a dot begins, is no document.
 */
export async function listDocuments(owner: DatabaseOwner, input: { readonly repository: string; readonly suffixes: readonly string[]; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
  return await withSpan('records.listDocuments', {
    'records.repository': input.repository,
    'records.limit': input.limit,
  }, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await filePage(tx, input.repository,
      `left((n.key->>'path'), 1) <> '.' AND position('/.' in (n.key->>'path')) = 0
       AND EXISTS (SELECT 1 FROM unnest($4::text[]) AS suffix WHERE right(lower((n.key->>'path')), length(suffix)) = suffix)`,
      [[...input.suffixes]], input.after ?? null, input.limit);
    const rows = found.map(fileOf);
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    return { rows: shown, next: more ? shown[shown.length - 1]!.path : null };
  }));
}

/** One path a commit changed, as the history pass read it. */
export interface TouchedRecord {
  readonly path: string;
  readonly change: 'added' | 'modified' | 'deleted' | 'renamed' | null;
  readonly added: number | null;
  readonly removed: number | null;
  readonly previousPath: string | null;
  /** Every opinion of what the commit did to the path, with its source. */
  readonly opinions?: readonly HeldOpinion[];
}

/** One row of a file's history: the commit that touched the path and what it did to it. */
export interface FileHistoryRow extends TouchedRecord {
  readonly commit: string;
  /** The author's clock with its offset, as `git log %aI` writes it. */
  readonly date: string;
  /** The offset `date` stands at, in minutes east of UTC: the same number `date` carries. */
  readonly offsetMin: number;
  readonly subject: string;
  /** The commit's position in the walk from the tip: its order in the history, not on the clock. */
  readonly walk: number;
}

/** What one commit did to a path, from the opinions that agree on it. */
function changeOf(opinions: readonly HeldOpinion[]): TouchedRecord['change'] {
  const value = fieldRead<string>(opinions, 'change', (one) => (typeof one === 'string' ? one : null)).value;
  return value === 'added' || value === 'modified' || value === 'deleted' || value === 'renamed' ? value : null;
}

/** The SQL that reaches a file and every path it was renamed from, through `renamed-from` edges (new file to old). */
const RENAME_CHAIN = `WITH RECURSIVE chain(file_node) AS (
    SELECT n.id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.file}'
    WHERE n.key @> jsonb_build_object('repository', (SELECT rn.key->>'name' FROM node rn WHERE rn.id = $1::bigint), 'path', $2::text)
    UNION
    SELECT e.to_node FROM chain c JOIN edge e ON e.from_node = c.file_node JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.renamedFrom}'
  )`;

/** The open opinions of one `touched` edge, as a jsonb array. */
const TOUCHED_OPINIONS = (edge: string): string => `(SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'change', o."change", 'added', o."added", 'removed', o."removed") ORDER BY o."id") FROM ${GIT_TABLES.touched} o WHERE o."edge_id" = ${edge}.id AND o."state" = 'open' AND o."context_id" = 1)`;
/** The open opinions of one `history` edge (its walk), as a jsonb array. */
const WALK_OPINIONS = (edge: string): string => `(SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'walk', o."walk") ORDER BY o."id") FROM ${GIT_TABLES.history} o WHERE o."edge_id" = ${edge}.id AND o."state" = 'open' AND o."context_id" = 1)`;
/** The open opinions of one commit, as a jsonb array. */
const COMMIT_OPINIONS = (node: string): string => `(SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'subject', o."subject", 'author_date', to_char(o."author_date" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'), 'author_offset_min', o."author_offset_min", 'commit_date', to_char(o."commit_date" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'), 'commit_offset_min', o."commit_offset_min") ORDER BY o."id") FROM ${GIT_TABLES.commit} o WHERE o."node_id" = ${node}.id AND o."state" = 'open' AND o."context_id" = 1)`;

/** One commit's clock as `%aI` writes it, from the opinions that agree on it. */
function clockOf(opinions: readonly HeldOpinion[], field: 'commit_date' | 'author_date', offsetField: 'commit_offset_min' | 'author_offset_min'): { readonly date: string; readonly offsetMin: number } {
  const instant = fieldRead(opinions, field, (value) => value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null).value;
  const offset = fieldRead(opinions, offsetField, asNumber).value ?? 0;
  if (instant === null) return { date: '', offsetMin: offset };
  // SQL's aggregate formats the timestamp at UTC without a suffix; restore it before applying Git's original offset.
  const utc = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(instant) ? instant : `${instant}Z`;
  const localClock = new Date(new Date(utc).getTime() + offset * 60_000).toISOString().slice(0, 19);
  return { date: gitDateOf(localClock, offset), offsetMin: offset };
}

/**
 * A page of a file's history, newest first. `next` names the exact row the page ended on — the walk and the commit — so
 * a page boundary between two commits written in the same second neither repeats a row nor skips one.
 */
export async function fileHistory(owner: DatabaseOwner, input: { readonly repository: string; readonly path: string; readonly after?: { readonly walk: number; readonly commit: string }; readonly limit: number }): Promise<{ readonly rows: readonly FileHistoryRow[]; readonly next: { readonly walk: number; readonly commit: string } | null }> {
  return await withSpan('records.fileHistory', { 'records.path': input.path, 'records.limit': input.limit }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, input.repository);
    const found = await tx.query<Record<string, unknown>>(
      `${RENAME_CHAIN}
       SELECT (ct.key->>'hash') AS commit, ${TOUCHED_OPINIONS('e')} AS touched, ${COMMIT_OPINIONS('ct')} AS commit_opinions, ${WALK_OPINIONS('he')} AS walk, ${PATH_OF('pn')} AS previous
       FROM chain ch JOIN edge e ON e.to_node = ch.file_node JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.touched}'
       JOIN node ct ON ct.id = e.from_node
       JOIN edge he ON he.from_node = $1::bigint AND he.to_node = e.from_node AND he.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.history}') AND he.context_id = 1
       LEFT JOIN edge r ON r.from_node = ch.file_node AND r.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.renamedFrom}') AND r.context_id = 1 AND r.discriminator = (ct.key->>'hash')
       LEFT JOIN node pn ON pn.id = r.to_node
       WHERE ($3::int IS NULL OR (SELECT min((o.item->>'walk')::int) FROM jsonb_array_elements(${WALK_OPINIONS('he')}) AS o(item)) > $3::int OR ((SELECT min((o.item->>'walk')::int) FROM jsonb_array_elements(${WALK_OPINIONS('he')}) AS o(item)) = $3::int AND (ct.key->>'hash') > $4))
       ORDER BY (SELECT min((o.item->>'walk')::int) FROM jsonb_array_elements(${WALK_OPINIONS('he')}) AS o(item)) ASC, (ct.key->>'hash') ASC LIMIT $5::bigint`,
      [repositoryId, input.path, input.after?.walk ?? null, input.after?.commit ?? '', String(input.limit + 1)],
    );
    const rows = found.rows.map((row) => {
      const touched = opinionsOfJson(row['touched'], []);
      const commitOpinions = opinionsOfJson(row['commit_opinions'], []);
      const walk = opinionsOfJson(row['walk'], []).map((one) => Number(one.values['walk'])).sort((a, b) => a - b)[0] ?? 0;
      const clock = clockOf(commitOpinions, 'commit_date', 'commit_offset_min');
      return {
        commit: String(row['commit']), path: input.path,
        change: changeOf(touched),
        added: fieldRead(touched, 'added', asNumber).value,
        removed: fieldRead(touched, 'removed', asNumber).value,
        previousPath: row['previous'] === null || row['previous'] === undefined ? null : String(row['previous']),
        date: clock.date, offsetMin: clock.offsetMin,
        subject: fieldRead(commitOpinions, 'subject', asText).value ?? '',
        walk, opinions: touched,
      } satisfies FileHistoryRow;
    });
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    const last = shown[shown.length - 1];
    return { rows: shown, next: more && last !== undefined ? { walk: last.walk, commit: last.commit } : null };
  }));
}

/** One commit with the paths it changed, or null when the store holds no such commit. */
/** One page's commit read, bound to the page's transaction: a page asks for the same commit twice, and reads it once. */
const COMMIT_MEMO = new WeakMap<object, Map<string, Promise<(CommitRecord & { readonly touched: readonly TouchedRecord[] }) | null>>>();

/** One commit with the paths it changed, or null when the store holds no such commit; read once per transaction. */
export async function commitWithPaths(owner: DatabaseOwner, repository: string, hash: string): Promise<(CommitRecord & { readonly touched: readonly TouchedRecord[] }) | null> {
  return await withSpan('records.commitPaths', { 'records.commit': hash }, async () => await owner.transaction('snapshot', async (tx) => {
    const memo = COMMIT_MEMO.get(tx) ?? new Map<string, Promise<(CommitRecord & { readonly touched: readonly TouchedRecord[] }) | null>>();
    COMMIT_MEMO.set(tx, memo);
    const held = memo.get(hash);
    if (held !== undefined) return await held;
    const read = readCommitWithPaths(tx, repository, hash);
    memo.set(hash, read);
    read.catch(() => { if (memo.get(hash) === read) memo.delete(hash); });
    return await read;
  }));
}

/** The commit and its changed paths, in statements of this transaction; `commitWithPaths` shares the result per page. */
async function readCommitWithPaths(tx: OuterTransaction, repository: string, hash: string): Promise<(CommitRecord & { readonly touched: readonly TouchedRecord[] }) | null> {
  const commit = await readCommitFacts(tx, repository, hash);
  if (commit === null) return null;
  const found = await tx.query<Record<string, unknown>>(
    // The touched rows and their opinions in one pass, grouped per edge: no opinion subquery per row (the page's
    // history navigation reads a commit's 1 800 changed paths, and a query per row made that span four times main's).
    `SELECT ${PATH_OF('fn')} AS path,
            jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'change', o."change", 'added', o."added", 'removed', o."removed") ORDER BY o."id") AS touched,
            ${PATH_OF('pn')} AS previous
     FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.touched}'
     JOIN node ct ON ct.id = e.from_node JOIN node fn ON fn.id = e.to_node
     LEFT JOIN ${GIT_TABLES.touched} o ON o."edge_id" = e.id AND o."state" = 'open' AND o."context_id" = 1
     LEFT JOIN edge r ON r.from_node = e.to_node AND r.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.renamedFrom}') AND r.context_id = 1 AND r.discriminator = (ct.key->>'hash')
     LEFT JOIN node pn ON pn.id = r.to_node
     WHERE (ct.key->>'hash') = $1
     GROUP BY e.id, ${PATH_OF('fn')}, ${PATH_OF('pn')}
     ORDER BY ${PATH_OF('fn')}`,
    [hash],
  );
  const touched = found.rows.map((row) => {
    const opinions = opinionsOfJson(row['touched'], []);
    return {
      path: String(row['path']),
      change: changeOf(opinions),
      added: fieldRead(opinions, 'added', asNumber).value,
      removed: fieldRead(opinions, 'removed', asNumber).value,
      previousPath: row['previous'] === null || row['previous'] === undefined ? null : String(row['previous']),
      opinions,
    };
  });
  return { ...commit, touched };
}

/** One page of a folder's own files (not its subfolders'), in code point order of the paths. */
export async function folderFiles(owner: DatabaseOwner, input: { readonly repository: string; readonly folder: string; readonly after?: string; readonly limit: number }): Promise<{ readonly rows: readonly FileRecord[]; readonly next: string | null }> {
  return await withSpan('records.folderFiles', { 'records.folder': input.folder, 'records.limit': input.limit }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, input.repository);
    const parent = input.folder === '' ? repositoryId : (await tx.query<{ node_id: string }>(`SELECT n.id::text AS node_id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.directory}' WHERE (n.key->>'repository') = $1::text AND (n.key->>'path') = $2::text AND n.context_id = 1 AND NOT n.removed`, [input.repository, input.folder])).rows[0]?.node_id;
    if (parent === undefined) return { rows: [], next: null };
    const found = await tx.query<Record<string, unknown>>(
      `SELECT (n.key->>'path') AS path, fo.opinions FROM (
         SELECT n.id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.file}'
         JOIN edge e ON e.to_node = n.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}')
         WHERE e.from_node = $1::bigint AND e.context_id = 1 AND NOT n.removed AND ($2::text IS NULL OR (n.key->>'path') > $2)
         ORDER BY (n.key->>'path') LIMIT $3::bigint) p
       JOIN node n ON n.id = p.id ${FILE_OPINIONS} ORDER BY (n.key->>'path')`,
      [parent, input.after ?? null, String(input.limit + 1)],
    );
    const rows = found.rows.map(fileOf);
    const more = rows.length > input.limit;
    const shown = more ? rows.slice(0, input.limit) : rows;
    return { rows: shown, next: more ? shown[shown.length - 1]!.path : null };
  }));
}

/** The immediate subfolders of one folder, in code point order; `''` is the repository's root. */
export async function folderChildrenOf(owner: DatabaseOwner, repository: string, folder: string): Promise<readonly string[]> {
  return await withSpan('records.folderChildren', { 'records.folder': folder }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, repository);
    const parent = folder === '' ? repositoryId : (await tx.query<{ node_id: string }>(`SELECT n.id::text AS node_id FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.directory}' WHERE (n.key->>'repository') = $1::text AND (n.key->>'path') = $2::text AND n.context_id = 1 AND NOT n.removed`, [repository, folder])).rows[0]?.node_id;
    if (parent === undefined) return [];
    const found = await tx.query<{ path: string }>(
      `SELECT (dn.key->>'path') AS path FROM edge e
       JOIN node dn ON dn.id = e.to_node AND dn.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.directory}')
       WHERE e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.from_node = $1::bigint AND e.context_id = 1
       ORDER BY (dn.key->>'path')`, [parent],
    );
    return found.rows.map((row) => row.path);
  }));
}

/** One date a file's page states: the author's clock with its offset, and the commit it belongs to. */
export interface FileDate {
  /** The author's clock with its offset, as `git log %aI` writes it. */
  readonly date: string;
  /** The offset `date` stands at, in minutes east of UTC: the same number `date` carries. */
  readonly offsetMin: number;
  readonly commit: string;
  readonly author: string;
}

export async function fileFacts(owner: DatabaseOwner, repository: string, path: string, options: { readonly history?: boolean } = {}): Promise<(FileRecord & { readonly created: FileDate | null; readonly modified: FileDate | null; readonly commitCount: number; readonly authors: readonly string[] }) | null> {
  return await withSpan('records.fileFacts', { 'records.path': path }, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<Record<string, unknown>>(`${FILE_SELECT} WHERE (n.key->>'repository') = $1::text AND (n.key->>'path') = $2::text AND n.context_id = 1 AND NOT n.removed`, [repository, path]);
    const row = found.rows[0];
    if (row === undefined) return null;
    // A product that declares no commit, touched or history kind holds no history table: the file's own facts stand,
    // and its dates and authors are absent rather than a read of a table the manifest never made (madarch-hsqs stage C).
    if (options.history === false) return { ...fileOf(row), created: null, modified: null, commitCount: 0, authors: [] };
    const repositoryId = await repositoryIdOf(tx, repository);
    const history = await tx.query<Record<string, unknown>>(
      `${RENAME_CHAIN}
       SELECT (ct.key->>'hash') AS commit, ${COMMIT_OPINIONS('ct')} AS commit_opinions, ${WALK_OPINIONS('he')} AS walk, (sn.key->>'name') AS name
       FROM chain ch JOIN edge e ON e.to_node = ch.file_node JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.touched}'
       JOIN node ct ON ct.id = e.from_node
       JOIN edge he ON he.from_node = $1::bigint AND he.to_node = e.from_node AND he.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.history}') AND he.context_id = 1
       LEFT JOIN edge a ON a.to_node = e.from_node AND a.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.authored}') AND a.context_id = 1 LEFT JOIN node sn ON sn.id = a.from_node
       WHERE $2 = $2 ORDER BY (SELECT min((o.item->>'walk')::int) FROM jsonb_array_elements(${WALK_OPINIONS('he')}) AS o(item)) ASC, (ct.key->>'hash') ASC`,
      [repositoryId, path],
    );
    const commits = history.rows.map((entry) => {
      const opinions = opinionsOfJson(entry['commit_opinions'], []);
      const clock = clockOf(opinions, 'commit_date', 'commit_offset_min');
      const walk = opinionsOfJson(entry['walk'], []).map((one) => Number(one.values['walk'])).sort((a, b) => a - b)[0] ?? 0;
      return { commit: String(entry['commit']), date: clock.date, offsetMin: clock.offsetMin, name: String(entry['name'] ?? ''), walk };
    });
    const created = commits.reduce((deepest, entry) => (entry.walk > deepest.walk ? entry : deepest), commits[0]!);
    const last = commits[0];
    const distinct = new Map(commits.map((entry) => [entry.commit, entry]));
    const authors = [...new Set(commits.map((entry) => entry.name).filter((name) => name !== ''))].sort();
    return {
      ...fileOf(row),
      created: created === undefined ? null : { date: created.date, offsetMin: created.offsetMin, commit: created.commit, author: created.name },
      modified: last === undefined ? null : { date: last.date, offsetMin: last.offsetMin, commit: last.commit, author: last.name },
      commitCount: distinct.size,
      authors,
    };
  }));
}

/** The text of many files of a repository's current tree, by path: the listing's titles read in one statement. */
/** The text of many files of a repository's current tree, by path: the listing's titles read in one statement. */
export async function storedFileTexts(owner: DatabaseOwner, repository: string, paths: readonly string[]): Promise<Map<string, string | null>> {
  const answer = new Map<string, string | null>();
  if (paths.length === 0) return answer;
  return await withSpan('records.fileContents', { 'records.repository': repository, 'records.paths': paths.length }, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<Record<string, unknown>>(
      `${FILE_SELECT} WHERE ${REPOSITORY_OF('n')} = $1 AND ${PATH_OF('n')} = ANY($2::text[])
       AND n.context_id = 1 AND NOT n.removed AND ${IN_TREE}`, [repository, [...paths]],
    );
    for (const row of found.rows) answer.set(String(row['path']), fieldRead(opinionsOfJson(row['opinions'], ['content']), 'content', asText).value);
    return answer;
  }));
}

/** Every current published file, with its opinions and evidence. */
export async function repositoryFileIndex(owner: DatabaseOwner, repository: string): Promise<readonly FileRecord[]> {
  return await withSpan('records.repositoryFileIndex', { 'records.repository': repository }, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<Record<string, unknown>>(
      `${FILE_SELECT} WHERE ${REPOSITORY_OF('n')} = $1 AND n.context_id = 1 AND NOT n.removed AND ${IN_TREE} ORDER BY ${PATH_OF('n')}`, [repository],
    );
    return found.rows.map(fileOf);
  }));
}

/** Every repository the store holds, in code point order of the names. */
export async function listRepositories(owner: DatabaseOwner, declared?: ReadonlySet<string>): Promise<readonly { readonly name: string; readonly url: string; readonly defaultBranch: string | null; readonly asIsCommit: string | null }[]> {
  // A product that declares no repository kind has no repository table: its contract answers no repository, and the
  // SQL never names a table the manifest did not make (madarch-hsqs stage C). A caller that names no contract asks the
  // store's own materialized declaration first — one statement on the base entity table, never a failed read.
  if (declared !== undefined && !declared.has(GIT_KINDS.repository)) return [];
  return await withSpan('records.listRepositories', {}, async () => await owner.transaction('snapshot', async (tx) => {
    if (declared === undefined && (await tx.query<{ id: string }>("SELECT id FROM entity WHERE name = $1 LIMIT 1", [GIT_KINDS.repository])).rows.length === 0) return [];
    const found = await tx.query<{ name: string; opinions: unknown; as_is: string | null }>(
      `SELECT (n.key->>'name') AS name,
         (SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'url', o."url", 'default_branch', o."default_branch") ORDER BY o."id") FROM ${GIT_TABLES.repository} o WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1) AS opinions,
         (SELECT (c.key->>'hash') FROM edge e JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.asIs}' JOIN node c ON c.id = e.to_node WHERE e.from_node = n.id LIMIT 1) AS as_is
       FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.repository}' WHERE NOT n.removed ORDER BY (n.key->>'name')`,
    );
    return found.rows.map((row) => {
      const opinions = opinionsOfJson(row.opinions, []);
      return { name: row.name, url: fieldRead(opinions, 'url', asText).value ?? '', defaultBranch: fieldRead(opinions, 'default_branch', asText).value, asIsCommit: row.as_is };
    });
  }));
}

/** Every folder of one repository's current tree, in code point order of the paths, with the parent it hangs from. */
export async function listDirectories(owner: DatabaseOwner, repository: string): Promise<readonly { readonly path: string; readonly parent: string }[]> {
  return await withSpan('records.listDirectories', { 'records.repository': repository }, async () => await owner.transaction('snapshot', async (tx) => {
    const repositoryId = await repositoryIdOf(tx, repository);
    const found = await tx.query<{ path: string; parent: string }>(
      `SELECT (n.key->>'path') AS path, coalesce((pn.key->>'path'), '') AS parent
       FROM node n
       JOIN edge e ON e.to_node = n.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.context_id = 1
       LEFT JOIN node pn ON pn.id = e.from_node AND pn.id <> $1::bigint
       WHERE n.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.directory}')
         AND (n.key->>'repository') = $2::text AND n.context_id = 1 AND NOT n.removed ORDER BY (n.key->>'path')`,
      [repositoryId, repository],
    );
    return found.rows;
  }));
}

/** One commit with its parents, its author and its dates, from the opinions that agree on them. */
/** The commit's own facts in one statement each, in the transaction the caller holds. */
async function readCommitFacts(tx: OuterTransaction, _repository: string, hash: string): Promise<CommitRecord | null> {
  const found = await tx.query<{ commit: string; opinions: unknown; author_name: string; author_email: string }>(
    `SELECT (c.key->>'hash') AS commit, ${COMMIT_OPINIONS('c')} AS opinions, coalesce(sn.key->>'name', '') AS author_name, coalesce(sn.key->>'email', '') AS author_email
     FROM node c JOIN entity en ON en.id = c.entity_id AND en.name = '${GIT_KINDS.commit}'
     LEFT JOIN edge e ON e.to_node = c.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.authored}')
     LEFT JOIN node sn ON sn.id = e.from_node
     WHERE c.key @> jsonb_build_object('hash', $1::text)`,
    [hash],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  const opinions = opinionsOfJson(row.opinions, []);
  const parents = await tx.query<{ hash: string }>(
    `SELECT (pn.key->>'hash') AS hash FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.parent}'
     JOIN ${GIT_TABLES.parent_position} o ON o."edge_id" = e.id AND o."state" = 'open' AND o."context_id" = 1
     JOIN node pn ON pn.id = e.to_node WHERE e.from_node = (SELECT id FROM node WHERE key @> jsonb_build_object('hash', $1::text) AND entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.commit}')) ORDER BY o.position`,
    [hash],
  );
  const [authorDate, authorOffset] = [clockOf(opinions, 'author_date', 'author_offset_min'), fieldRead(opinions, 'author_offset_min', asNumber).value ?? 0];
  const [commitDate, commitOffset] = [clockOf(opinions, 'commit_date', 'commit_offset_min'), fieldRead(opinions, 'commit_offset_min', asNumber).value ?? 0];
  return {
    hash: row.commit, parents: parents.rows.map((entry) => entry.hash),
    author: { name: row.author_name, email: row.author_email },
    authorDate: authorDate.date, authorOffsetMin: authorOffset,
    commitDate: commitDate.date, commitOffsetMin: commitOffset,
    subject: fieldRead(opinions, 'subject', asText).value ?? '',
  };

}
/** The facts one repository page states, read once per page: its key, its address, its as-is commit and its counts. */
export interface RepositoryFacts {
  readonly nodeId: string;
  readonly name: string;
  readonly url: string;
  readonly defaultBranch: string | null;
  readonly asIsCommit: string | null;
  /** Current containment or a successful inventory publication, including an empty tree. */
  readonly hasTree: boolean;
  readonly fileCount: number;
  readonly commitCount: number;
  readonly directoryCount: number;
  /** Whether the clone the history pass read is shallow: the pass's opinion of the repository, never a table of its own. */
  readonly historyShallow: boolean | null;
}

/** One page's repository facts, bound to the page's transaction so every block of the page shares one read. */
const FACTS_MEMO = new WeakMap<object, Map<string, Promise<RepositoryFacts | null>>>();

/**
 * One page asks every block that shows a repository for the same facts: this reads them once per transaction, however
 * many readers ask (the review of stage 1c, point 15, and the CI page budget). A failed read stands no cache entry.
 */
export async function repositoryFacts(owner: DatabaseOwner, repository: string, declared?: ReadonlySet<string>): Promise<RepositoryFacts | null> {
  if (declared !== undefined && !declared.has(GIT_KINDS.repository)) return null;
  return await withSpan('records.repositoryFacts', { 'records.repository': repository }, async () => await owner.transaction('snapshot', async (tx) => {
    const memo = FACTS_MEMO.get(tx) ?? new Map<string, Promise<RepositoryFacts | null>>();
    FACTS_MEMO.set(tx, memo);
    const held = memo.get(repository);
    if (held !== undefined) return await held;
    const read = readRepositoryFacts(tx, repository, declared);
    memo.set(repository, read);
    read.catch(() => { if (memo.get(repository) === read) memo.delete(repository); });
    return await read;
  }));
}

/** The facts of one repository, read in statements of its own; the page shares the result through `repositoryFacts`. */
async function readRepositoryFacts(tx: OuterTransaction, repository: string, declared?: ReadonlySet<string>): Promise<RepositoryFacts | null> {
  // The declared contract decides: a product that declares no repository kind is answered before the table is named.
  if (declared === undefined && (await tx.query<{ id: string }>("SELECT id FROM entity WHERE name = $1 LIMIT 1", [GIT_KINDS.repository])).rows.length === 0) return null;
  // One statement for the repository row and everything a page states about it: its opinions, its as-is commit and its
  // counts (the CI page budget counts statements, not only rows). A successful inventory header also proves an
  // empty tree, but only for a producer whose repository opinion names this repository in its evidence.
  const found = await tx.query<{ node_id: string; opinions: unknown; as_is: string | null; has_tree: boolean; files: string; commits: string; directories: string }>(

    `SELECT n.id::text AS node_id,
       (SELECT jsonb_agg(jsonb_build_object('id', o."id"::text, 'said_by', o."said_by", 'lang', o."lang", 'evidence', o."evidence", 'url', o."url", 'default_branch', o."default_branch", 'history_shallow', o."history_shallow") ORDER BY o."id") FROM ${GIT_TABLES.repository} o WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1) AS opinions,
       (SELECT (c.key->>'hash') FROM edge e JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.asIs}' JOIN node c ON c.id = e.to_node WHERE e.from_node = n.id AND e.context_id = 1 LIMIT 1) AS as_is,
       (EXISTS (SELECT 1 FROM edge e JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.contains}' WHERE e.from_node = n.id AND e.context_id = 1)
        OR EXISTS (
          SELECT 1 FROM fill_unit u
          JOIN fill_unit_generation g ON g.unit_id = u.unit_id AND g.generation = u.generation AND g.state = 'published'
          JOIN fill_publication p ON p.unit_id = g.unit_id AND p.generation = g.generation
          JOIN fill_unit_draft d ON d.unit_id = g.unit_id AND d.generation = g.generation
          CROSS JOIN LATERAL jsonb_array_elements(d.writes) w
          JOIN ${GIT_TABLES.repository} o ON o.node_id = n.id AND o.state = 'open' AND o.context_id = 1
            AND split_part(o.said_by, '@', 1) = w->'value'->>'plugin'
          WHERE u.stage_id = 'plugin-turns' AND w->>'kind' = 'producer-outcome'
            AND w->'value'->>'kind' IN ('${GIT_KINDS.file}', '${GIT_KINDS.directory}')
            AND w->'value'->>'outcome' IN ('completed', 'unchanged', 'empty')
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.evidence) place WHERE place->>'repository' = $1::text)
        )) AS has_tree,
       (SELECT count(*)::text FROM node f JOIN entity fe ON fe.id = f.entity_id AND fe.name = '${GIT_KINDS.file}' JOIN edge e ON e.to_node = f.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.context_id = 1 WHERE (f.key->>'repository') = $1::text) AS files,
       (SELECT count(*)::text FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.history}' WHERE e.from_node = n.id AND e.context_id = 1) AS commits,
       (SELECT count(*)::text FROM node d JOIN entity de ON de.id = d.entity_id AND de.name = '${GIT_KINDS.directory}' JOIN edge e ON e.to_node = d.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.context_id = 1 WHERE (d.key->>'repository') = $1::text) AS directories
     FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.repository}' WHERE n.key @> jsonb_build_object('name', $1::text) AND n.context_id = 1 AND NOT n.removed`,
    [repository],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  const opinions = opinionsOfJson(row['opinions'], []);
  return {
    nodeId: row['node_id'], name: repository, url: fieldRead(opinions, 'url', asText).value ?? '', defaultBranch: fieldRead(opinions, 'default_branch', asText).value,
    asIsCommit: row['as_is'],
    hasTree: row['has_tree'],
    fileCount: Number(row['files'] ?? '0'),
    commitCount: Number(row['commits'] ?? '0'),
    directoryCount: Number(row['directories'] ?? '0'),
    historyShallow: fieldRead(opinions, 'history_shallow', (value) => (typeof value === 'boolean' ? value : null)).value,
  };

}

/** The entities per kind of the one graph, in code point order: the catalogue's counts, the store's own. */
export async function graphKindCounts(owner: DatabaseOwner): Promise<readonly { readonly kind: string; readonly count: number }[]> {
  return await withSpan('records.graphKindCounts', {}, async () => await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ kind: string; n: string }>(
      `SELECT '${GIT_KINDS.repository}' AS kind, count(*)::text AS n FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.repository}' WHERE NOT n.removed
       UNION ALL SELECT '${GIT_KINDS.directory}', count(*)::text FROM node d JOIN entity de ON de.id = d.entity_id AND de.name = '${GIT_KINDS.directory}' JOIN edge e ON e.to_node = d.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}')
       UNION ALL SELECT '${GIT_KINDS.file}', count(*)::text FROM node f JOIN entity fe ON fe.id = f.entity_id AND fe.name = '${GIT_KINDS.file}' JOIN edge e ON e.to_node = f.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}')
       UNION ALL SELECT '${GIT_KINDS.gitlink}', count(*)::text FROM node g JOIN entity ge ON ge.id = g.entity_id AND ge.name = '${GIT_KINDS.gitlink}' JOIN edge e ON e.to_node = g.id AND e.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.contains}') AND e.context_id = 1
       UNION ALL SELECT '${GIT_KINDS.commit}', count(*)::text FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.history}'
       UNION ALL SELECT '${GIT_KINDS.signature}', count(*)::text FROM node s JOIN entity se ON se.id = s.entity_id AND se.name = '${GIT_KINDS.signature}' WHERE EXISTS (SELECT 1 FROM edge e JOIN entity k ON k.id = e.entity_id AND k.name = '${GIT_KINDS.authored}' WHERE e.from_node = s.id)`,
    );
    return found.rows.map((row) => ({ kind: row.kind, count: Number(row.n) })).sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0));
  }));
}
