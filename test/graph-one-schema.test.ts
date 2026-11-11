/**
 * The one graph's schema (decision 0034 and its amendment of 2026-11-10): identity and key in `node`, a table per
 * entity whose rows are opinions, edges apart with a per-entity repeat rule, the base context, the journal and the
 * dictionaries. The cases that matter most are the owner's words: «Сущность файл», the key on the vertex, and
 * «Мнение это просто… Запись… Кто как считает» — one row per opinion, no `claim` and no `evidence` table beside it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { FILE_BLOB_TABLE, FILE_ENTRY_TABLE, FILE_PATH_TABLE } from '../src/graph/one-graph.js';
import { OPINION_FIELDS, generatedTableName } from '../src/graph/contract.js';
import { GIT_CONTRACT, GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { createTestDatabaseOwner } from './test-database.js';

/** The graph's own tables, which every store holds: the mechanism the product's contracts build on. */
const MECHANISM_TABLES = ['context', 'edge', 'entity', 'node', 'operation', 'unresolved_reference', FILE_ENTRY_TABLE, FILE_PATH_TABLE, FILE_BLOB_TABLE] as const;

const RECORD_TABLES = [
  ...MECHANISM_TABLES,
  ...GIT_CONTRACT.vertex.map((kind) => generatedTableName(kind.name, 'vertex')),
  ...GIT_CONTRACT.edge.map((kind) => generatedTableName(kind.name, 'edge')),
  ...GIT_CONTRACT.dictionary.map((one) => generatedTableName(one.name, 'dictionary')),
] as const;

let owner: DatabaseOwner | undefined;

beforeAll(async () => {
  owner = await createTestDatabaseOwner({ graphContract: GIT_CONTRACT });
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

/** One new vertex of the named entity, with the key the caller names, in a transaction of its own. */
async function nodeOf(entity: string, key: unknown = {}): Promise<string> {
  if (owner === undefined) throw new Error('the store was not opened');
  return await owner.transaction('write', async (tx) => {
    const made = await tx.query<{ id: string }>('INSERT INTO node (entity_id, key) SELECT id, $2::jsonb FROM entity WHERE name = $1 RETURNING id::text AS id', [entity, JSON.stringify(key)]);
    return made.rows[0]!.id;
  });
}

/** The id of one entity, in a transaction of its own. */
async function entityOf(name: string): Promise<string> {
  if (owner === undefined) throw new Error('the store was not opened');
  const found = await owner.transaction('snapshot', async (tx) => await tx.query<{ id: string }>('SELECT id::text AS id FROM entity WHERE name = $1', [name]));
  return found.rows[0]!.id;
}

describe('the tables and the dictionaries', () => {
  test('stand in the store, with no temporal column anywhere and no claim or evidence table', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const found = await owner.transaction('snapshot', async (tx) => await tx.query(
      `SELECT c.relname AS name, a.attname AS column FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND c.relname = ANY($1::text[])`,
      [RECORD_TABLES as unknown as string[]],
    ));
    const columns = (found.rows as { name: string; column: string }[]).map((row) => `${row.name}.${row.column}`);
    for (const table of RECORD_TABLES) expect(columns.some((column) => column.startsWith(`${table}.`))).toBe(true);
    expect(columns.filter((column) => /^(valid_|recorded_)/u.test(column.split('.')[1] ?? ''))).toEqual([]);
    // The path index and the blob text are mechanism state (stage C): every product's own files stand there, and the
    // language is the product's opinion layer. The blob's hash names its algorithm.
    expect(columns).toContain(`${FILE_PATH_TABLE}.text`);
    expect(columns).toContain(`${GIT_TABLES.language}.name`);
    expect(columns).toContain(`${FILE_BLOB_TABLE}.algorithm`);
    expect(columns).toContain(`${FILE_ENTRY_TABLE}.repository`);
    // A claim and an evidence table stand nowhere any more (A3): the opinion holds both.
    const tables = await owner.transaction('snapshot', async (tx) => await tx.query<{ name: string | null }>(`SELECT to_regclass(current_schema() || '.' || name)::text AS name FROM unnest(ARRAY['claim', 'evidence', 'kind']) AS name`));
    expect(tables.rows.map((row) => row.name)).toEqual([null, null, null]);
  }, 120_000);

  test('hold a base context the fill writes into', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const found = await owner.transaction('snapshot', async (tx) => await tx.query<{ id: string; parent: string | null; ref: string }>('SELECT id::text AS id, parent::text AS parent, ref FROM context'));
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]!.parent).toBeNull();
    expect(found.rows[0]!.ref).toBe('');
  }, 120_000);
});

describe('a vertex is identity and its key', () => {
  test('node holds the id, the entity, the stable id, the key, the context and whether it was removed', async () => {
    if (owner === undefined) throw new Error('the store was not opened');
    const found = await owner.transaction('snapshot', async (tx) => await tx.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [RECORD_TABLES as unknown as string[]],
    ));
    const nodeColumns = found.rows.filter((row) => row.table_name === 'node').map((row) => row.column_name);
    expect(nodeColumns.sort()).toEqual(['context_id', 'entity_id', 'id', 'key', 'removed', 'uid']);
    // The key is the vertex's: no entity's table repeats it as a column.
    const perEntity = found.rows.filter((row) => !['node', 'entity', 'edge', 'context', 'operation', GIT_TABLES.path, GIT_TABLES.language, GIT_TABLES.blob].includes(row.table_name));
    for (const row of perEntity) {
      if ([...OPINION_FIELDS, 'node_id', 'edge_id'].includes(row.column_name)) continue;
      expect({ table: row.table_name, column: row.column_name, key: row.column_name === 'name' || row.column_name === 'path' || row.column_name === 'hash' || row.column_name === 'email' }).not.toEqual({ table: row.table_name, column: row.column_name, key: true });
    }
    expect(nodeColumns).not.toContain('kind_id');
  }, 120_000);

  test('one entity and key stand once in a context, and the same key in another context is another vertex', async () => {
    const repository = await nodeOf('repository', { name: 'unique-name' });
    expect(repository).not.toBe('');
    expect(await refusal(`INSERT INTO node (entity_id, key) SELECT id, $2::jsonb FROM entity WHERE name = $1`, ['repository', JSON.stringify({ name: 'unique-name' })])).toMatch(/node_key_context/u);
    const entity = await entityOf('repository');
    const other = await owner!.transaction('write', async (tx) => (await tx.query<{ id: string }>(`INSERT INTO context (parent, ref) VALUES ($1::bigint, 'branch') RETURNING id::text AS id`, [null])).rows[0]!.id).catch(() => undefined);
    if (other === undefined) throw new Error('no second context was made');
    const second = await owner!.transaction('write', async (tx) => (await tx.query<{ id: string }>(`INSERT INTO node (entity_id, key, context_id) VALUES ($1::bigint, $2::jsonb, $3::bigint) RETURNING id::text AS id`, [entity, JSON.stringify({ name: 'unique-name' }), other])).rows[0]!.id);
    expect(second).not.toBe('');
  }, 120_000);

  test('meaningless evidence the casing of a key is one key, and a text and a number are two', async () => {
    await nodeOf('repository', { name: 'keyed' });
    // jsonb equality, not the text a key was written as: the same object in another key order is the same key.
    expect(await refusal(`INSERT INTO node (entity_id, key) SELECT id, $2::jsonb FROM entity WHERE name = $1`, ['repository', JSON.stringify({ name: 'keyed' })])).toMatch(/node_key_context/u);
    await nodeOf('signature', { name: 'Ada', email: 'ada@example.test' });
    expect(await refusal(`INSERT INTO node (entity_id, key) SELECT id, $2::jsonb FROM entity WHERE name = $1`, ['signature', JSON.stringify({ name: 'Ada', email: 'ada@example.test' })])).toMatch(/node_key_context/u);
  }, 120_000);
});

describe('an entity\'s table holds one row per opinion', () => {
  test('two producers state their own opinion of one vertex, and each row carries who, when, its state and its evidence', async () => {
    const repository = await nodeOf('repository', { name: 'opinions' });
    const file = await nodeOf('file', { repository: { kind: 'repository', key: { name: 'opinions' } }, path: 'a.ts' });
    const columns = `node_id, said_by, evidence, mode, blob_id`;
    expect(await refusal(`INSERT INTO ${GIT_TABLES.file} (${columns}) VALUES ($1::bigint, 'git-tree@1', '[]'::jsonb, '100644', NULL)`, [file])).toBeNull();
    expect(await refusal(`INSERT INTO ${GIT_TABLES.file} (${columns}) VALUES ($1::bigint, 'git-history@1', '[]'::jsonb, NULL, NULL)`, [file])).toBeNull();
    const held = await owner!.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${GIT_TABLES.file} WHERE node_id = $1::bigint AND state = 'open'`, [file]));
    expect(held.rows[0]!.n).toBe('2');
    const opinion = await owner!.transaction('snapshot', async (tx) => await tx.query(`SELECT said_by, state, reason, confirmed_with, lang, translated_from, source_digest, context_id, evidence FROM ${GIT_TABLES.file} WHERE node_id = $1::bigint ORDER BY id LIMIT 1`, [file]));
    expect(opinion.rows[0]).toMatchObject({ said_by: 'git-tree@1', state: 'open', reason: null, confirmed_with: null, lang: null, translated_from: null, source_digest: null, evidence: [] });
    void repository;
  }, 120_000);

  test('a state is open, confirmed or closed, and the evidence is a list', async () => {
    const file = await nodeOf('file', { repository: { kind: 'repository', key: { name: 'opinions' } }, path: 'b.ts' });
    expect(await refusal(`INSERT INTO ${GIT_TABLES.file} (node_id, said_by, state) VALUES ($1::bigint, 'agent', 'settled')`, [file])).toMatch(/_check/u);
    expect(await refusal(`INSERT INTO ${GIT_TABLES.file} (node_id, said_by, evidence) VALUES ($1::bigint, 'agent', '{"a":1}'::jsonb)`, [file])).toMatch(/_check/u);
    expect(await refusal(`INSERT INTO ${GIT_TABLES.file} (node_id, said_by, evidence) VALUES ($1::bigint, 'agent', '[{"repository":"madarch","commit_or_digest":"c0ffee","path":"docs/glossary.md","line_start":3,"line_end":4}]'::jsonb)`, [file])).toBeNull();
  }, 120_000);

  test('the opinions resting on one path are found by an index over the evidence, never by a scan', async () => {
    const found = await owner!.transaction('snapshot', async (tx) => await tx.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND indexdef ILIKE '%gin%'`,
      [GIT_TABLES.file],
    ));
    expect(found.rows.map((row) => row.indexdef).join('\n')).toMatch(/evidence/u);
    const plan = await owner!.transaction('snapshot', async (tx) => await tx.query<{ plan: string }>(`EXPLAIN SELECT 1 FROM ${GIT_TABLES.file} WHERE evidence @> '[{"path":"docs/glossary.md"}]'::jsonb`));
    expect(plan.rows.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('an edge stands apart and says when it may repeat', () => {
  test('one edge of one entity between the same ends stands once unless its entity says repeats and tells them apart', async () => {
    const left = await nodeOf('file', { repository: { kind: 'repository', key: { name: 'edges' } }, path: 'x' });
    const right = await nodeOf('file', { repository: { kind: 'repository', key: { name: 'edges' } }, path: 'y' });
    const contains = await entityOf('contains');
    const rename = await entityOf('renamed-from');
    expect(await refusal('INSERT INTO edge (entity_id, from_node, to_node) VALUES ($1::bigint, $2::bigint, $3::bigint)', [contains, left, right])).toBeNull();
    expect(await refusal('INSERT INTO edge (entity_id, from_node, to_node) VALUES ($1::bigint, $2::bigint, $3::bigint)', [contains, left, right])).toMatch(/edge_once/u);
    // A repeated entity tells its edges apart by its discriminator; the same one twice is still one edge.
    expect(await refusal('INSERT INTO edge (entity_id, from_node, to_node, discriminator) VALUES ($1::bigint, $2::bigint, $3::bigint, $4)', [rename, left, right, 'c1'])).toBeNull();
    expect(await refusal('INSERT INTO edge (entity_id, from_node, to_node, discriminator) VALUES ($1::bigint, $2::bigint, $3::bigint, $4)', [rename, left, right, 'c2'])).toBeNull();
    expect(await refusal('INSERT INTO edge (entity_id, from_node, to_node, discriminator) VALUES ($1::bigint, $2::bigint, $3::bigint, $4)', [rename, left, right, 'c1'])).toMatch(/edge_once/u);
    const entities = await owner!.transaction('snapshot', async (tx) => await tx.query<{ name: string; sort: string; repeats: boolean; discriminator: string | null }>('SELECT name, sort, repeats, discriminator FROM entity ORDER BY name'));
    expect(entities.rows.find((row) => row.name === 'contains')).toEqual({ name: 'contains', sort: 'edge', repeats: false, discriminator: null });
    expect(entities.rows.find((row) => row.name === 'renamed-from')).toEqual({ name: 'renamed-from', sort: 'edge', repeats: true, discriminator: 'commit' });
    expect(entities.rows.filter((row) => row.sort === 'node').every((row) => row.repeats === false && row.discriminator === null)).toBe(true);
  }, 120_000);

  test('an edge\'s own values are opinions of its table, keyed by the edge', async () => {
    const commit = await nodeOf('commit', { hash: 'a'.repeat(40) });
    const file = await nodeOf('file', { repository: { kind: 'repository', key: { name: 'edges' } }, path: 'z' });
    const touched = await entityOf('touched');
    const edge = await owner!.transaction('write', async (tx) => (await tx.query<{ id: string }>('INSERT INTO edge (entity_id, from_node, to_node) VALUES ($1::bigint, $2::bigint, $3::bigint) RETURNING id::text AS id', [touched, commit, file])).rows[0]!.id);
    expect(await refusal(`INSERT INTO ${GIT_TABLES.touched} (edge_id, said_by, change, added, removed) VALUES ($1::bigint, 'git-history@1', 'added', 3, 0)`, [edge])).toBeNull();
    expect(await refusal(`INSERT INTO ${GIT_TABLES.touched} (edge_id, said_by, change, added, removed) VALUES ($1::bigint, 'git-history@1', 'exploded', 3, 0)`, [edge])).toMatch(/_check/u);
  }, 120_000);
});

describe('a confirmation is per field, and the database refuses a second one', () => {
  test('one confirmed opinion stands per node, field, language and context', async () => {
    const file = await nodeOf('file', { repository: { kind: 'repository', key: { name: 'confirmed' } }, path: 'a.ts' });
    const confirmed = `INSERT INTO ${GIT_TABLES.file} (node_id, said_by, state, confirmed_field, lang) VALUES ($1::bigint, $2, 'confirmed', $3, $4)`;
    expect(await refusal(confirmed, [file, 'agent', 'mode', 'en'])).toBeNull();
    // The same field in the same language and context: the partial unique index refuses the second.
    expect(await refusal(confirmed, [file, 'agent', 'mode', 'en'])).toMatch(/_confirmed/u);
    // A field of its own, a null language, and another language are tuples of their own.
    expect(await refusal(confirmed, [file, 'agent', 'blob_id', 'en'])).toBeNull();
    expect(await refusal(confirmed, [file, 'agent', 'mode', null])).toBeNull();
    expect(await refusal(confirmed, [file, 'agent', 'mode', 'ru'])).toBeNull();
    // A confirmed row names exactly one field, and an open row names none.
    expect(await refusal(confirmed, [file, 'agent', null, 'en'])).toMatch(/_check/u);
    expect(await refusal(`INSERT INTO ${GIT_TABLES.file} (node_id, said_by, confirmed_field) VALUES ($1::bigint, 'agent', 'mode')`, [file])).toMatch(/_check/u);
  }, 120_000);
});

describe('evidence is a tagged list, and a path lookup keeps repository and path from one entry', () => {
  test('a file place, a conversation and an opinion stand in one list', async () => {
    const file = await nodeOf('file', { repository: { kind: 'repository', key: { name: 'evidence' } }, path: 'a.ts' });
    expect(await refusal(`INSERT INTO ${GIT_TABLES.file} (node_id, said_by, evidence) VALUES ($1::bigint, 'agent', $2::jsonb)`, [file, JSON.stringify([
      { type: 'file', repository: 'madarch', commit_or_digest: 'c0ffee', path: 'docs/glossary.md', line_start: 3, line_end: 4 },
      { type: 'conversation', id: 'talk-2026-11-10', speaker: 'the owner', at: '2026-11-10T21:00:00Z' },
      { type: 'opinion', id: '42' },
    ])])).toBeNull();
    const held = await owner!.transaction('snapshot', async (tx) => await tx.query<{ evidence: readonly Record<string, unknown>[] }>(`SELECT evidence FROM ${GIT_TABLES.file} WHERE node_id = $1::bigint`, [file]));
    expect(held.rows[0]?.evidence.map((one) => one['type'])).toEqual(['file', 'conversation', 'opinion']);
  }, 120_000);

  test('the opinions resting on one repository and one path are one containment lookup, served by the evidence index', async () => {
    const file = await nodeOf('file', { repository: { kind: 'repository', key: { name: 'evidence' } }, path: 'b.ts' });
    await refusal(`INSERT INTO ${GIT_TABLES.file} (node_id, said_by, evidence) VALUES ($1::bigint, 'agent', $2::jsonb)`, [file, JSON.stringify([{ type: 'file', repository: 'R', commit_or_digest: 'c', path: 'P', line_start: 1, line_end: 2 }])]);
    // A file place of another repository holds the same path: the containment query keeps both from one entry.
    await refusal(`INSERT INTO ${GIT_TABLES.file} (node_id, said_by, evidence) VALUES ($1::bigint, 'agent', $2::jsonb)`, [file, JSON.stringify([{ type: 'file', repository: 'Other', commit_or_digest: 'c', path: 'P' }])]);
    const found = await owner!.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${GIT_TABLES.file} WHERE evidence @> '[{"type":"file","repository":"R","path":"P"}]'::jsonb`, []));
    expect(found.rows[0]?.n).toBe('1');
    const plan = await owner!.transaction('snapshot', async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      return await tx.query<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) SELECT 1 FROM ${GIT_TABLES.file} WHERE evidence @> '[{"type":"file","repository":"R","path":"P"}]'::jsonb`);
    });
    expect(JSON.stringify(plan.rows)).toContain(`${GIT_TABLES.file}_evidence`);
  }, 120_000);
});

describe('a hash names its algorithm', () => {
  test('a hash names its algorithm, and its length must match', async () => {
    expect(await refusal(`INSERT INTO ${GIT_TABLES.blob} (hash, algorithm, bytes, form, lines) VALUES ($1, 'sha1', 1, 'text', 1)`, ['a'.repeat(40)])).toBeNull();
    expect(await refusal(`INSERT INTO ${GIT_TABLES.blob} (hash, algorithm, bytes, form, lines) VALUES ($1, 'sha256', 1, 'text', 1)`, ['b'.repeat(64)])).toBeNull();
    expect(await refusal(`INSERT INTO ${GIT_TABLES.blob} (hash, algorithm, bytes, form, lines) VALUES ($1, 'sha1', 1, 'text', 1)`, ['c'.repeat(64)])).toMatch(/_check/u);
    expect(await refusal(`INSERT INTO ${GIT_TABLES.blob} (hash, algorithm, bytes, form, lines) VALUES ($1, 'sha1', 1, 'binary', 1)`, ['d'.repeat(40)])).toMatch(/_check/u);
  }, 120_000);
});
