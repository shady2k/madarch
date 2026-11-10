/**
 * The graph reads a plugin's turn plans by (decision 0035, item 15: plugins work
 * from the graph): the file vertices a kind's documents are, and the entities a
 * producer already holds — its claims and where each was read. The reads stand in
 * this module because only the storage layer runs a query; the turn that drives a
 * plugin asks for them by name and never builds a statement itself.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { GIT_KINDS, GIT_TABLES } from '../fill/stages/git-contract.js';
import type { GraphContract, VertexContract } from './contract.js';
import { generatedTableName } from './contract.js';

/** One file vertex of the graph: the repository it stands in and its path from that repository's root. */
export interface GraphFileRow {
  readonly repository: string;
  readonly path: string;
}

/**
 * Every file vertex of the graph, in code point order of its repository and path: a file that is in a repository's
 * current tree (its `contains` edge stands) and not removed. A product that declares no code kind holds no file
 * table, and the answer is empty — never an error.
 */
export async function graphFiles(owner: DatabaseOwner, contract: GraphContract): Promise<GraphFileRow[]> {
  if (!contract.vertex.some((kind) => kind.name === GIT_KINDS.file)) return [];
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ repository: string; path: string }>(
      `SELECT (f.key->'repository'->'key'->>'name') AS repository, (f.key->>'path') AS path
       FROM node f
       JOIN entity fe ON fe.id = f.entity_id AND fe.name = $1
       JOIN edge e ON e.to_node = f.id AND e.entity_id = (SELECT id FROM entity WHERE name = $2)
       WHERE NOT f.removed
       ORDER BY repository, path`,
      [GIT_KINDS.file, GIT_KINDS.contains],
    );
    return found.rows.map((row) => ({ repository: row.repository, path: row.path }));
  });
}

/** One entity a producer holds: its natural key values, and the file its open opinion was read in. */
export interface ProducerEntity {
  readonly key: Readonly<Record<string, string>>;
  readonly path: string | null;
}

/**
 * The text of one file the files producer stored in the graph (decision 0035, item 9): its content by blob, shared by
 * every file with the same bytes. `null` when the graph holds no content — a binary file, or a file no fill read.
 */
export async function fileContent(owner: DatabaseOwner, repository: string, path: string): Promise<string | null> {
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ content: string | null }>(
      `SELECT b.content FROM node f
       JOIN entity fe ON fe.id = f.entity_id AND fe.name = '${GIT_KINDS.file}'
       LEFT JOIN LATERAL (SELECT o."blob_id" FROM ${GIT_TABLES.file} o WHERE o."node_id" = f.id AND o."state" = 'open' AND split_part(o."said_by", '@', 1) = 'git-tree' ORDER BY o."id" DESC LIMIT 1) g ON true
       LEFT JOIN ${GIT_TABLES.blob} b ON b.id = g."blob_id"
       WHERE (f.key->'repository'->'key'->>'name') = $1 AND (f.key->>'path') = $2 AND NOT f.removed
       LIMIT 1`,
      [repository, path],
    );
    return found.rows[0]?.content ?? null;
  });
}

/**
 * The entities of one kind a producer already holds, with the path of their evidence: what a unit's answer is compared
 * with, so an entity the unit no longer holds is a removal. A kind with no table answers nothing.
 */
export async function producerEntities(owner: DatabaseOwner, contract: GraphContract, kind: string, producer: string): Promise<ProducerEntity[]> {
  const vertex: VertexContract | undefined = contract.vertex.find((held) => held.name === kind);
  if (vertex === undefined) return [];
  const table = generatedTableName(kind, 'vertex');
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ key: Record<string, unknown>; evidence: readonly Record<string, unknown>[] }>(
      `SELECT n.key AS key, o.evidence FROM ${table} o
       JOIN node n ON n.id = o.node_id
       WHERE o.state = 'open' AND split_part(o.said_by, '@', 1) = $1 AND NOT n.removed`,
      [producer],
    );
    const rows = found.rows.map((row) => ({
      key: Object.fromEntries(vertex.key.map((column) => [column, String(row.key[column] ?? '')])),
      path: row.evidence.map((one) => one['path']).find((one): one is string => typeof one === 'string') ?? null,
    }));
    // One vertex one opinion: a producer may hold the same key once, so a repeated key stands once.
    const seen = new Set<string>();
    return rows.filter((row) => {
      const rendered = JSON.stringify(Object.keys(row.key).sort().map((field) => [field, row.key[field]]));
      if (seen.has(rendered)) return false;
      seen.add(rendered);
      return true;
    }).sort((left, right) => (JSON.stringify(left.key) < JSON.stringify(right.key) ? -1 : 1));
  });
}
