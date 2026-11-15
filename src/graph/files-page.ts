/**
 * The Files page's graph read (madarch-j9ao.1.1): every file the current tree
 * holds, with the facts the map and the table draw — its lines and bytes, the
 * language its open opinions accept, and the rhythm the history's `touched`
 * edges state. Nothing here runs git or reads a checkout.
 *
 * The files and their rhythm are read in two statements: the file facts are the
 * disk producer's values, and every `touched` edge from a commit to a file gives
 * the commit's date and its author. The caller maps the rhythm by the file node,
 * so a repository with many files is read without a statement per file.
 */
import type { OuterTransaction } from '../adapters/database-owner.js';
import { GIT_KINDS, GIT_TABLES } from '../fill/stages/git-contract.js';
import { byCodePoint } from '../model/order.js';

export interface FilesPageHeat {
  readonly d30: number;
  readonly d90: number;
  readonly d365: number;
  readonly all: number;
}

/** One file the page holds. */
export interface FilesPageFile {
  /** The file entity's kind and node id, so the page opens its address without naming a kind. */
  readonly kind: string;
  readonly node: string;
  readonly repository: string;
  readonly path: string;
  readonly lines: number | null;
  readonly bytes: number | null;
  /** The accepted language, or null when the open claims name no one language. */
  readonly language: string | null;
  readonly heat: FilesPageHeat;
  /** The last commit that touched it, as an ISO instant, or null. */
  readonly lastChange: string | null;
  readonly authorCount: number;
}

export interface FilesPageData {
  readonly files: readonly FilesPageFile[];
}

/** The columns a surface has, from the published kind's fields. */
export interface FilesPageColumns {
  readonly hasLines: boolean;
  readonly hasBytes: boolean;
  readonly hasLanguage: boolean;
  readonly hasTouched: boolean;
  readonly hasCommitDate: boolean;
  readonly hasAuthors: boolean;
}

const ZERO_HEAT: FilesPageHeat = { d30: 0, d90: 0, d365: 0, all: 0 };

/** The part of the tree a page reads: a repository and, when it is a folder's page, that folder's prefix. */
export interface FilesPageScope {
  readonly repository?: string;
  readonly path?: string;
}

/** Read every file in the current tree, then the rhythm of every file in one statement. */
export async function readFilesPage(tx: OuterTransaction, columns: FilesPageColumns, scope: FilesPageScope = {}): Promise<FilesPageData> {
  const lines = columns.hasLines
    ? `(SELECT CASE WHEN count(DISTINCT o."lines") = 1 THEN min(o."lines") END FROM ${GIT_TABLES.file} o WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1)`
    : 'NULL::integer';
  const bytes = columns.hasBytes
    ? `(SELECT CASE WHEN count(DISTINCT o."bytes") = 1 THEN min(o."bytes")::text END FROM ${GIT_TABLES.file} o WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1)`
    : 'NULL::text';
  const language = columns.hasLanguage
    ? `(SELECT CASE WHEN count(DISTINCT o."language") = 1 THEN min(o."language") END FROM ${GIT_TABLES.file} o WHERE o."node_id" = n.id AND o."state" = 'open' AND o."context_id" = 1)`
    : 'NULL::text';
  const found = await tx.query<Record<string, unknown>>(
    `SELECT n.uid::text AS node, (n.key->>'repository') AS repository, (n.key->>'path') AS path,
            ${lines} AS lines, ${bytes} AS bytes, ${language} AS language
       FROM node n
       JOIN entity en ON en.id = n.entity_id AND en.name = '${GIT_KINDS.file}'
       JOIN ${GIT_TABLES.file} f ON f.node_id = n.id AND f.state = 'open' AND f.context_id = 1
      WHERE n.context_id = 1 AND NOT n.removed
        AND EXISTS (SELECT 1 FROM edge e JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.contains}' WHERE e.to_node = n.id)
        AND ($1::text IS NULL OR (n.key->>'repository') = $1)
        AND ($2::text IS NULL OR (n.key->>'path') = $2 OR (n.key->>'path') LIKE $2 || '/%')
      ORDER BY (n.key->>'repository'), (n.key->>'path')`,
    [scope.repository ?? null, scope.path === undefined || scope.path === '' ? null : scope.path],
  );
  const rhythm = columns.hasTouched && columns.hasCommitDate ? await readRhythm(tx, columns.hasAuthors) : new Map<string, { heat: FilesPageHeat; last: string | null; authors: number }>();
  const files = found.rows.map((row): FilesPageFile => {
    const path = String(row['path'] ?? '');
    const repository = String(row['repository'] ?? '');
    const held = rhythm.get(String(row['node'])) ?? { heat: ZERO_HEAT, last: null, authors: 0 };
    return {
      kind: GIT_KINDS.file,
      node: String(row['node']),
      repository,
      path,
      lines: numberOrNull(row['lines']),
      bytes: numberOrNull(row['bytes']),
      language: typeof row['language'] === 'string' && row['language'] !== '' ? row['language'] : null,
      heat: held.heat,
      lastChange: held.last,
      authorCount: held.authors,
    };
  }).sort((left, right) => byCodePoint(left.repository, right.repository) || byCodePoint(left.path, right.path));
  return { files };
}

async function readRhythm(tx: OuterTransaction, hasAuthors: boolean): Promise<Map<string, { heat: FilesPageHeat; last: string | null; authors: number }>> {
  const author = hasAuthors
    ? `coalesce(sn.key->>'name', sn.key->>'email')`
    : `NULL::text`;
  const authorJoins = hasAuthors
    ? `LEFT JOIN edge ae ON ae.to_node = c.node_id AND ae.entity_id = (SELECT id FROM entity WHERE name = '${GIT_KINDS.authored}') AND ae.context_id = 1
       LEFT JOIN ${GIT_TABLES.signature} sig ON sig.node_id = ae.from_node
       LEFT JOIN node sn ON sn.id = sig.node_id`
    : '';
  const found = await tx.query<Record<string, unknown>>(
    `WITH marks AS (
       SELECT e.to_node::text AS file_node, c.commit_date AS at, ${author} AS author
       FROM edge e JOIN entity ek ON ek.id = e.entity_id AND ek.name = '${GIT_KINDS.touched}'
       JOIN ${GIT_TABLES.commit} c ON c.node_id = e.from_node
       ${authorJoins}
       WHERE c.commit_date IS NOT NULL
     )
     SELECT file_node,
            count(*) FILTER (WHERE at >= now() - interval '30 days')::text AS d30,
            count(*) FILTER (WHERE at >= now() - interval '90 days')::text AS d90,
            count(*) FILTER (WHERE at >= now() - interval '365 days')::text AS d365,
            count(*)::text AS all_count,
            max(at) AS last,
            count(DISTINCT author) FILTER (WHERE author IS NOT NULL)::text AS authors
       FROM marks GROUP BY file_node`,
    [],
  );
  const answer = new Map<string, { heat: FilesPageHeat; last: string | null; authors: number }>();
  for (const row of found.rows) {
    const last = row['last'] === null || row['last'] === undefined ? null : new Date(row['last'] as string | Date).toISOString();
    answer.set(String(row['file_node']), {
      heat: {
        d30: Number(row['d30'] ?? 0), d90: Number(row['d90'] ?? 0), d365: Number(row['d365'] ?? 0), all: Number(row['all_count'] ?? 0),
      },
      last,
      authors: Number(row['authors'] ?? 0),
    });
  }
  return answer;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

