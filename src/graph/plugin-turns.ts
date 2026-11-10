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
 * current tree (its `contains` edge stands) and not tombstoned. A product that declares no code kind holds no file
 * table, and the answer is empty — never an error.
 */
export async function graphFiles(owner: DatabaseOwner, contract: GraphContract): Promise<GraphFileRow[]> {
  if (!contract.vertex.some((kind) => kind.name === GIT_KINDS.file)) return [];
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<{ repository: string; path: string }>(
      `SELECT r.name AS repository, p.text AS path
       FROM ${GIT_TABLES.file} f
       JOIN ${GIT_TABLES.repository} r ON r.node_id = f.repository_node
       JOIN ${GIT_TABLES.path} p ON p.id = f.path_id
       JOIN edge e ON e.to_node = f.node_id AND e.kind_id = (SELECT id FROM kind WHERE name = $1)
       WHERE NOT f.tombstone
       ORDER BY r.name, p.text`,
      [GIT_KINDS.contains],
    );
    return found.rows.map((row) => ({ repository: row.repository, path: row.path }));
  });
}

/** One entity a producer holds: its natural key values, and the file its newest claim was read in. */
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
      `SELECT b.content FROM ${GIT_TABLES.file} f
       JOIN ${GIT_TABLES.repository} r ON r.node_id = f.repository_node
       JOIN ${GIT_TABLES.path} p ON p.id = f.path_id
       LEFT JOIN ${GIT_TABLES.blob} b ON b.id = f.blob_id
       WHERE r.name = $1 AND p.text = $2 AND NOT f.tombstone
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
  const pathTable = contract.dictionary.some((one) => one.name === 'path') ? generatedTableName('path', 'dictionary') : undefined;
  const keyColumns = vertex.key.map((column) => `t."${column}" AS "${column}"`).join(', ');
  return await owner.transaction('snapshot', async (tx) => {
    const found = await tx.query<Record<string, unknown>>(
      `SELECT ${keyColumns}, min(${pathTable === undefined ? 'NULL::text' : 'p.text'}) AS path
       FROM claim c
       JOIN kind k ON k.id = (SELECT id FROM kind WHERE name = $1)
       JOIN node n ON n.id = c.node_id AND n.kind_id = k.id
       JOIN ${table} t ON t.node_id = n.id
       LEFT JOIN evidence e ON e.claim_id = c.id AND e.producer = c.producer
       ${pathTable === undefined ? '' : `LEFT JOIN ${pathTable} p ON p.id = e.path_id`}
       WHERE c.producer = $2
       GROUP BY ${vertex.key.map((column) => `t."${column}"`).join(', ')}
       ORDER BY ${vertex.key.map((column) => `t."${column}"`).join(', ')}`,
      [kind, producer],
    );
    return found.rows.map((row) => ({
      key: Object.fromEntries(vertex.key.map((column) => [column, String(row[column] ?? '')])),
      path: typeof row['path'] === 'string' ? row['path'] : null,
    }));
  });
}
