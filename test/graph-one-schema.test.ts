/**
 * The one graph's schema (decision 0034): identity only in `node`, a table per
 * kind keyed by `node_id` with its natural key unique there, edges apart with a
 * per-kind repeat rule, claims and evidence that names exactly one of a vertex,
 * an edge and a claim, the base context, the journal and the dictionaries.
 *
 * The case that matters most is the normal form the owner named: nothing in
 * `node` repeats a kind table's attribute.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { ONE_GRAPH_TABLES, createOneGraphSchema } from '../src/graph/one-graph.js';
import { generatedTableName } from '../src/graph/contract.js';
import { GIT_CONTRACT, GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { createTestDatabaseOwner } from './test-database.js';

const RECORD_TABLES = [
  ...ONE_GRAPH_TABLES,
  ...GIT_CONTRACT.vertex.map((kind) => generatedTableName(kind.name, 'vertex')),
  ...GIT_CONTRACT.edge.flatMap((kind) => (kind.fields.length === 0 ? [] : [generatedTableName(kind.name, 'edge')])),
  ...GIT_CONTRACT.dictionary.map((one) => generatedTableName(one.name, 'dictionary')),
] as const;

let owner: DatabaseOwner | undefined;

beforeAll(async () => {
  owner = await createTestDatabaseOwner({});
  await createOneGraphSchema(owner, GIT_CONTRACT);
});

afterAll(async () => {
  await owner?.close();
});

/** Runs one statement and answers the message the database refused it with, or null when it ran. */
async function refusal(sql: string, values: readonly unknown[] = []): Promise<string | null> {
  if (owner === undefined) throw new Error('the store was not opened');
  try {
    await owner.transaction('write', async (tx) => { await tx.query(sql, values); });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** One new vertex of the named kind, in a transaction of its own. */
async function nodeOf(kind: string): Promise<string> {
  if (owner === undefined) throw new Error('the store was not opened');
  return await owner.transaction('write', async (tx) => {
    const made = await tx.query<{ id: string }>('INSERT INTO node (kind_id) SELECT id FROM kind WHERE name = $1 RETURNING id::text AS id', [kind]);
    return made.rows[0]!.id;
  });
}

/** The id of one kind, in a transaction of its own. */
async function kindOf(name: string): Promise<string> {
  if (owner === undefined) throw new Error('the store was not opened');
  const found = await owner.transaction('snapshot', async (tx) => await tx.query<{ id: string }>('SELECT id::text AS id FROM kind WHERE name = $1', [name]));
  return found.rows[0]!.id;
}

describe('the tables and the dictionaries', () => {
  test('stand in the store, with no temporal column anywhere', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const found = await owner.transaction('snapshot', async (tx) => await tx.query(
      `SELECT c.relname AS name, a.attname AS column FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND c.relname = ANY($1::text[])`,
      [RECORD_TABLES as unknown as string[]],
    ));
    const columns = (found.rows as { name: string; column: string }[]).map((row) => `${row.name}.${row.column}`);
    for (const table of RECORD_TABLES) expect(columns.some((column) => column.startsWith(`${table}.`))).toBe(true);
    expect(columns.filter((column) => /^(valid_|recorded_)/u.test(column.split('.')[1] ?? ''))).toEqual([]);
    // The dictionaries stay (item 13), and the blob's and the commit's hash name their algorithm.
    expect(columns).toContain(`${GIT_TABLES.path}.text`);
    expect(columns).toContain(`${GIT_TABLES.language}.name`);
    expect(columns).toContain(`${GIT_TABLES.blob}.algorithm`);
    expect(columns).toContain(`${GIT_TABLES.commit}.algorithm`);
  }, 120_000);

  test('hold a base context the fill writes into', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const found = await owner.transaction('snapshot', async (tx) => await tx.query<{ id: string; parent: string | null; ref: string }>('SELECT id::text AS id, parent::text AS parent, ref FROM context'));
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]!.parent).toBeNull();
    expect(found.rows[0]!.ref).toBe('');
  }, 120_000);
});

describe('a vertex is identity only', () => {
  test('node holds the id and the kind, and no kind table repeats a column of it', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const found = await owner.transaction('snapshot', async (tx) => await tx.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [RECORD_TABLES as unknown as string[]],
    ));
    const nodeColumns = found.rows.filter((row) => row.table_name === 'node').map((row) => row.column_name);
    expect(nodeColumns.sort()).toEqual(['id', 'kind_id', 'uid']);
    // Every per-kind table's own attribute (everything but its key to the vertex) is absent from node.
    const perKind = found.rows.filter((row) => row.table_name !== 'node' && !['kind', 'edge', 'context', 'layer_entry', 'operation', 'gap', GIT_TABLES.path, GIT_TABLES.language, GIT_TABLES.blob].includes(row.table_name));
    for (const row of perKind) {
      // `id`, `node_id`, `edge_id` and `context_id` are keys, not attributes of a kind; every other column is.
      if (['id', 'node_id', 'edge_id', 'context_id'].includes(row.column_name)) continue;
      expect({ table: row.table_name, column: row.column_name, inNode: nodeColumns.includes(row.column_name) }).toEqual({ table: row.table_name, column: row.column_name, inNode: false });
    }
    // The old graph's three repeats are gone: no repository, no key, no blob on the vertex.
    expect(nodeColumns).not.toContain('repository_id');
    expect(nodeColumns).not.toContain('key');
  }, 120_000);

  test('the per-kind natural keys are unique there: a repository name, a repository and path, a commit hash, a signature', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const repository = await nodeOf('repository');
    expect(await refusal(`INSERT INTO ${GIT_TABLES.repository} (node_id, name, url) VALUES ($1::bigint, $2, $3)`, [repository, 'unique-name', 'file:///x'])).toBeNull();
    const other = await nodeOf('repository');
    expect(await refusal(`INSERT INTO ${GIT_TABLES.repository} (node_id, name, url) VALUES ($1::bigint, $2, $3)`, [other, 'unique-name', 'file:///y'])).toMatch(/_name_key/u);

    const path = await owner.transaction('write', async (tx) => (await tx.query<{ id: string }>(`INSERT INTO ${GIT_TABLES.path} (text) VALUES ($1) RETURNING id::text AS id`, ['a.ts'])).rows[0]!.id);
    const first = await nodeOf('file');
    expect(await refusal(`INSERT INTO ${GIT_TABLES.file} (node_id, repository_node, path_id) VALUES ($1::bigint, $2::bigint, $3::bigint)`, [first, repository, path])).toBeNull();
    const second = await nodeOf('file');
    expect(await refusal(`INSERT INTO ${GIT_TABLES.file} (node_id, repository_node, path_id) VALUES ($1::bigint, $2::bigint, $3::bigint)`, [second, repository, path])).toMatch(/_repository_node_path_id_key/u);

    const commit = await nodeOf('commit');
    expect(await refusal(`INSERT INTO ${GIT_TABLES.commit} (node_id, hash, algorithm) VALUES ($1::bigint, $2, 'sha1')`, [commit, 'a'.repeat(40)])).toBeNull();
    const again = await nodeOf('commit');
    expect(await refusal(`INSERT INTO ${GIT_TABLES.commit} (node_id, hash, algorithm) VALUES ($1::bigint, $2, 'sha1')`, [again, 'a'.repeat(40)])).toMatch(/_hash_key/u);

    const signature = await nodeOf('signature');
    expect(await refusal(`INSERT INTO ${GIT_TABLES.signature} (node_id, name, email) VALUES ($1::bigint, $2, $3)`, [signature, 'Ada', 'ada@example.test'])).toBeNull();
    const otherSignature = await nodeOf('signature');
    expect(await refusal(`INSERT INTO ${GIT_TABLES.signature} (node_id, name, email) VALUES ($1::bigint, $2, $3)`, [otherSignature, 'Ada', 'ada@example.test'])).toMatch(/_name_email_key/u);
  }, 120_000);
});

describe('an edge stands apart and says when it may repeat', () => {
  test('one edge of one kind between the same ends stands once unless its kind says repeats and tells them apart', async () => {
    const left = await nodeOf('file');
    const right = await nodeOf('file');
    const contains = await kindOf('contains');
    const rename = await kindOf('renamed-from');
    expect(await refusal('INSERT INTO edge (kind_id, from_node, to_node) VALUES ($1::bigint, $2::bigint, $3::bigint)', [contains, left, right])).toBeNull();
    expect(await refusal('INSERT INTO edge (kind_id, from_node, to_node) VALUES ($1::bigint, $2::bigint, $3::bigint)', [contains, left, right])).toMatch(/edge_once/u);
    // A repeated kind tells its edges apart by its discriminator; the same one twice is still one edge.
    expect(await refusal('INSERT INTO edge (kind_id, from_node, to_node, discriminator) VALUES ($1::bigint, $2::bigint, $3::bigint, $4)', [rename, left, right, 'c1'])).toBeNull();
    expect(await refusal('INSERT INTO edge (kind_id, from_node, to_node, discriminator) VALUES ($1::bigint, $2::bigint, $3::bigint, $4)', [rename, left, right, 'c2'])).toBeNull();
    expect(await refusal('INSERT INTO edge (kind_id, from_node, to_node, discriminator) VALUES ($1::bigint, $2::bigint, $3::bigint, $4)', [rename, left, right, 'c1'])).toMatch(/edge_once/u);
    // The kind's own declaration: a node kind never repeats, and a repeated edge kind names what tells it apart.
    const kinds = await owner!.transaction('snapshot', async (tx) => await tx.query<{ name: string; sort: string; repeats: boolean; discriminator: string | null }>('SELECT name, sort, repeats, discriminator FROM kind ORDER BY name'));
    expect(kinds.rows.find((row) => row.name === 'contains')).toEqual({ name: 'contains', sort: 'edge', repeats: false, discriminator: null });
    expect(kinds.rows.find((row) => row.name === 'renamed-from')).toEqual({ name: 'renamed-from', sort: 'edge', repeats: true, discriminator: 'commit' });
    expect(kinds.rows.filter((row) => row.sort === 'node').every((row) => row.repeats === false && row.discriminator === null)).toBe(true);
  }, 120_000);
});

describe('claims carry their sources and evidence names one thing', () => {
  test('evidence names exactly one of a vertex, an edge and a claim', async () => {
    const node = await nodeOf('file');
    expect(await refusal(`INSERT INTO evidence (producer) VALUES ('git')`)).toMatch(/evidence_check/u);
    const left = await nodeOf('file');
    const contains = await kindOf('contains');
    const edge = await owner!.transaction('write', async (tx) => (await tx.query<{ id: string }>('INSERT INTO edge (kind_id, from_node, to_node) VALUES ($1::bigint, $2::bigint, $3::bigint) RETURNING id::text AS id', [contains, node, left])).rows[0]!.id);
    expect(await refusal(`INSERT INTO evidence (node_id, edge_id, producer) VALUES ($1::bigint, $2::bigint, 'git')`, [node, edge])).toMatch(/evidence_check/u);
    const claim = await owner!.transaction('write', async (tx) => (await tx.query<{ id: string }>(`INSERT INTO claim (node_id, attribute, value, producer, producer_version) VALUES ($1::bigint, 'language', '{"language":"TypeScript"}', 'linguist', '9.5.0') RETURNING id::text AS id`, [node])).rows[0]!.id);
    expect(await refusal(`INSERT INTO evidence (claim_id, producer) VALUES ($1::bigint, 'linguist')`, [claim])).toBeNull();
    // Every claim is kept: a second producer adds a row, never replaces one.
    await owner!.transaction('write', async (tx) => { await tx.query(`INSERT INTO claim (node_id, attribute, value, producer, producer_version) VALUES ($1::bigint, 'language', '{"candidates":["JSON","OASv2-json"]}', 'linguist', '9.5.0')`, [node]); });
    const held = await owner!.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM claim WHERE node_id = $1::bigint', [node]));
    expect(held.rows[0]!.n).toBe('2');
  }, 120_000);

  test('a hash names its algorithm, and its length must match', async () => {
    expect(await refusal(`INSERT INTO ${GIT_TABLES.blob} (hash, algorithm, bytes, form, lines) VALUES ($1, 'sha1', 1, 'text', 1)`, ['a'.repeat(40)])).toBeNull();
    expect(await refusal(`INSERT INTO ${GIT_TABLES.blob} (hash, algorithm, bytes, form, lines) VALUES ($1, 'sha256', 1, 'text', 1)`, ['b'.repeat(64)])).toBeNull();
    expect(await refusal(`INSERT INTO ${GIT_TABLES.blob} (hash, algorithm, bytes, form, lines) VALUES ($1, 'sha1', 1, 'text', 1)`, ['c'.repeat(64)])).toMatch(/_check/u);
    expect(await refusal(`INSERT INTO ${GIT_TABLES.blob} (hash, algorithm, bytes, form, lines) VALUES ($1, 'sha1', 1, 'binary', 1)`, ['d'.repeat(40)])).toMatch(/_check/u);
  }, 120_000);
});
