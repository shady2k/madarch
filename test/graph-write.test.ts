/**
 * The graph's one writer (decision 0035, items 6 and 7; the amendment of 2026-11-10): the contract a manifest's field
 * bindings make, and the rows a producer's answer becomes — a vertex with its key, one opinion of the kind's fields per
 * producer, a rerun that writes nothing, a changed value that closes the old opinion and opens a new one, and a removal
 * that takes the entity out of the reads.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { generatedTableName } from '../src/graph/contract.js';
import { createRecordSchema, publishTree } from '../src/graph/records.js';
import { GIT_CONTRACT, GIT_KINDS, GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { manifestContractOf } from '../src/fill/stages/plugin-contract.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { createTestDatabaseOwner } from './test-database.js';
import { publishGraphWrites } from '../src/graph/claims.js';
import { ensureEdges, ensureVertex, journalFor, journalOn, publishGraphDrafts, publishOpinion, writeJournal } from '../src/graph/write.js';
import type { GraphContract } from '../src/graph/contract.js';
import { producerEntities } from '../src/graph/plugin-turns.js';
import { unevidencedOpinions } from '../src/graph/consistency.js';
import type { VertexDraft } from '../src/graph/contract.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { declaredKindReads } from '../src/fill/stages/plugin-contract.js';

const HASH = 'a'.repeat(64);
const root = mkdtempSync(join(tmpdir(), 'madarch-graph-write-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A product holding a manifest, a plugin's contract and its lock, as a product made by `madarch new` does. */
function product(): string {
  const folder = mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'templates'), { recursive: true });
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  mkdirSync(join(folder, 'plugins', 'glossary'), { recursive: true });
  writeFileSync(join(folder, 'templates', 't.liquid'), '{% block lead %}{% endblock %}\n');
  writeFileSync(join(folder, 'plugins', 'glossary', 'contract.json'), JSON.stringify({
    id: 'glossary', version: '1.0.0',
    outputs: { vertices: [{ kind: 'doc.term', key: ['name'], fields: [
      { name: 'name', type: 'text', meaning: 'the term', example: 'Fill', required: true },
      { name: 'definition', type: 'text', meaning: 'what it means', example: 'a run', required: true },
      { name: 'strict', type: 'text', meaning: 'a word the producer settles', example: 'yes', required: false },
    ] }], edges: [] },
  }));
  writeFileSync(join(folder, 'madarch', 'plugins.lock'), `plugins:\n  - { id: glossary, version: 1.0.0, closure: ${HASH}, path: plugins/glossary }\n`);
  writeFileSync(join(folder, 'madarch', 'kinds.yaml'), [
    'kinds:',
    '  doc.term:',
    '    template: templates/t.liquid',
    '    source: document',
    '    terms: ["**/glossary*.md"]',
    '    semantics: term',
    '    fields:',
    '      - { name: name, type: text, binding: "glossary@1.name" }',
    '      - { name: definition, type: text, binding: "glossary@1.definition" }',
    '      - { name: strict, type: text, nullable: true, binding: "glossary@1.strict" }',
    '    key: [name]',
    'plugins:',
    '  - { id: glossary, version: 1, path: plugins/glossary, inputs: [doc.term], outputs: [doc.term], closure: [plugins/glossary/contract.json] }',
    '',
  ].join('\n'));
  return folder;
}

let owner: DatabaseOwner;
let contract: GraphContract;
let productFolder = '';

beforeAll(async () => {
  const folder = product();
  productFolder = folder;
  const read = parseKinds(await Bun.file(join(folder, 'madarch', 'kinds.yaml')).text(), 'madarch/kinds.yaml', folder);
  expect(read.findings).toEqual([]);
  contract = manifestContractOf(read);
  owner = await createTestDatabaseOwner();
  await createOneGraphSchema(owner, contract);
});

afterAll(async () => { await owner.close(); });

/** One term as the plugin answers it. */
function term(name: string, definition: string): VertexDraft {
  return {
    kind: 'doc.term', key: { name },
    values: { definition },
    evidence: [{ type: 'file', repository: 'madarch', commit_or_digest: 'c0ffee', path: 'docs/glossary.md', line_start: 3, line_end: 4 }],
    producer: 'glossary', producerVersion: '1.0.0',
  };
}

describe('the unevidenced read reports only a field whose contract requires evidence', () => {
  test('an opinion with no evidence of a declared field is reported, and one with evidence is not', async () => {
    // A bare opinion of the field the declaration names, and a cited one of the same kind.
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
      vertices: [{ kind: 'doc.term', key: { name: 'Bare' }, values: { definition: 'no source' }, producer: 'glossary', producerVersion: '1.0.0' }],
      removals: [],
    }, 1));
    const declarations = [{ kind: 'doc.term', table: contract.vertex[0]!.table, producer: 'glossary', fields: ['definition'], key: ['name'] }];
    const found = await unevidencedOpinions(owner, declarations);
    expect(found.rows.map((one) => [one.entity.label, one.field])).toEqual([['Bare', 'definition']]);
    // A field that declared nothing is never reported, whatever its opinion rests on.
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
      vertices: [{ kind: 'doc.term', key: { name: 'Bare' }, values: { definition: 'still no source' }, evidence: [{ type: 'file', repository: 'madarch', commit_or_digest: 'c0ffee', path: 'docs/glossary.md', line_start: 1, line_end: 2 }], producer: 'glossary', producerVersion: '1.0.0' }],
      removals: [],
    }, 1));
    expect((await unevidencedOpinions(owner, declarations)).rows).toEqual([]);
    expect((await unevidencedOpinions(owner, [{ ...declarations[0]!, fields: [] }])).rows).toEqual([]);
    // The case shares the file's store with the cases after it: its term leaves the store whole, rows and node.
    await owner.transaction('write', async (tx) => {
      await tx.query(`DELETE FROM ${declarations[0]!.table} WHERE node_id IN (SELECT id FROM node WHERE key->>'name' = 'Bare')`);
      await tx.query(`DELETE FROM node WHERE key->>'name' = 'Bare'`);
    });
  });
});

describe('a manifest-declared kind is read by prefix, as the Problems page reads its findings kind', () => {
  test('the reader answers a generated kind its table holds', async () => {
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
      vertices: [{ kind: 'doc.term', key: { name: 'Zeta' }, values: { definition: 'the last one' }, evidence: [{ type: 'file', repository: 'madarch', commit_or_digest: 'c0ffee', path: 'docs/glossary.md', line_start: 1, line_end: 2 }], producer: 'glossary', producerVersion: '1.0.0' }],
      removals: [],
    }, 1));
    const read = parseKinds(await Bun.file(join(productFolder, 'madarch', 'kinds.yaml')).text(), 'madarch/kinds.yaml', productFolder);
    const reader = new GraphReader(owner, () => 'now', undefined, undefined, undefined, declaredKindReads(read));
    const found = await reader.byPrefix('doc.term', 'doc.term:', 10);
    expect(found.rows.map((one) => one.key)).toContain('doc.term:Zeta');
    await owner.transaction('write', async (tx) => {
      await tx.query(`DELETE FROM ${contract.vertex[0]!.table} WHERE node_id IN (SELECT id FROM node WHERE key->>'name' = 'Zeta')`);
      await tx.query(`DELETE FROM node WHERE key->>'name' = 'Zeta'`);
    });
  });
});

describe('the manifest makes the table and the writer fills it', () => {
  test('the kind has a column for every field it states and none for its key', async () => {
    expect(contract.vertex.map((kind) => kind.name)).toEqual(['doc.term']);
    // The key is the vertex's; the fields are the columns of the opinion table, claimed ones included.
    expect(contract.vertex[0]?.fields.map((field) => field.name)).toEqual(['name', 'definition', 'strict']);
    expect(contract.vertex[0]?.key).toEqual(['name']);
  });

  test('a vertex is published with its opinion and its evidence, and a rerun writes nothing', async () => {
    const writes = [{ kind: 'vertex', evidence: 'docs/glossary.md', value: term('Fill', 'one run') }];
    const first = await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, writes));
    const second = await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, writes));
    expect(first).toBe(2);
    expect(second).toBe(0);
    const table = contract.vertex[0]!.table;
    const opinions = await owner.transaction('snapshot', async (tx) => await tx.query<{ said_by: string; state: string; definition: string; evidence: readonly Record<string, unknown>[] }>(`SELECT said_by, state, definition, evidence FROM ${table}`));
    expect(opinions.rows).toHaveLength(1);
    expect(opinions.rows[0]).toMatchObject({ said_by: 'glossary@1.0.0', state: 'open', definition: 'one run' });
    expect(opinions.rows[0]?.evidence).toEqual([{ type: 'file', repository: 'madarch', commit_or_digest: 'c0ffee', path: 'docs/glossary.md', line_start: 3, line_end: 4 }]);
    // The key is the vertex's, once, and no opinion repeats it.
    const nodes = await owner.transaction('snapshot', async (tx) => await tx.query<{ key: unknown }>('SELECT key FROM node'));
    expect(nodes.rows.map((row) => row.key)).toEqual([{ name: 'Fill' }]);
    expect(await producerEntities(owner, contract, 'doc.term', 'glossary')).toEqual([{ key: { name: 'Fill' }, path: 'docs/glossary.md' }]);
  });

  test('a changed value closes the producer\'s open opinion and opens a new one', async () => {
    const table = contract.vertex[0]!.table;
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'docs/glossary.md', value: term('Fill', 'two runs') }]));
    const opinions = await owner.transaction('snapshot', async (tx) => await tx.query<{ state: string; definition: string }>(`SELECT state, definition FROM ${table} ORDER BY id`));
    expect(opinions.rows).toEqual([{ state: 'closed', definition: 'one run' }, { state: 'open', definition: 'two runs' }]);
  });

  test('a removal closes the producer\'s opinions, takes the entity out of the reads and keeps its history', async () => {
    const table = contract.vertex[0]!.table;
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex-removal', evidence: 'docs/glossary.md', value: { kind: 'doc.term', key: { name: 'Fill' }, producer: 'glossary' } }]));
    const open = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} o JOIN node n ON n.id = o.node_id WHERE o.state = 'open' AND NOT n.removed`));
    expect(open.rows[0]?.n).toBe('0');
    const held = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`));
    expect(held.rows[0]?.n).toBe('2');
    expect(await producerEntities(owner, contract, 'doc.term', 'glossary')).toEqual([]);
  });

  test('a second producer states its own opinion of the same vertex beside the first', async () => {
    const table = contract.vertex[0]!.table;
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'docs/other.md', value: { ...term('Fill', 'the one run'), producer: 'other', producerVersion: '2.1.0' } }]));
    const opinions = await owner.transaction('snapshot', async (tx) => await tx.query<{ said_by: string; state: string; definition: string }>(`SELECT said_by, state, definition FROM ${table} WHERE state = 'open' ORDER BY said_by`));
    expect(opinions.rows).toEqual([{ said_by: 'other@2.1.0', state: 'open', definition: 'the one run' }]);
  });

  test('a field two producers disagree on shows every value with its source, never one picked silently', async () => {
    // A term of its own, so the earlier cases' opinions do not stand beside this one's.
    const table = contract.vertex[0]!.table;
    const vertex = (producer: string, definition: string): VertexDraft => ({
      kind: 'doc.term', key: { name: 'Run' },
      values: { definition },
      evidence: [{ type: 'file', repository: 'madarch', commit_or_digest: 'c0ffee', path: 'docs/glossary.md', line_start: 1, line_end: 2 }],
      producer, producerVersion: '1.0.0',
    });
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [
      { kind: 'vertex', evidence: 'docs/glossary.md', value: vertex('glossary', 'one run') },
      { kind: 'vertex', evidence: 'docs/glossary.md', value: vertex('other', 'the run') },
    ]));
    const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, new Map([['doc.term', { kind: 'doc.term', table, columns: ['definition'], types: { definition: 'text' }, key: ['name'] }]]));
    const [entity] = await reader.find('doc.term:Run');
    if (entity === undefined) throw new Error('the term was not read');
    // Several open opinions: every value stands, and each carries the opinion that stated it.
    expect(entity.properties['definition']).toEqual(['one run', 'the run']);
    expect((entity.evidence ?? []).map((one) => [one.field, one.saidBy, one.path]).sort()).toEqual([
      ['definition', 'glossary@1.0.0', 'docs/glossary.md'],
      ['definition', 'other@1.0.0', 'docs/glossary.md'],
    ]);
    // One open opinion standing is its value itself, never a list of one: the glossary's opinion of Fill was closed
    // when the term was removed, and the second producer's stands alone.
    const [fill] = await reader.list('doc.term', { limit: 20 }).then((page) => page.rows.filter((one) => one.label === 'Fill'));
    expect(fill?.properties['definition']).toBe('the one run');
  });

  test('a producer\'s new version supersedes its old version\'s opinion, and a removal by one producer leaves another\'s', async () => {
    const table = contract.vertex[0]!.table;
    const vertex = (producer: string, version: string, definition: string, name = 'Supersede'): VertexDraft => ({
      kind: 'doc.term', key: { name }, values: { definition },
      evidence: [{ type: 'file', repository: 'madarch', commit_or_digest: 'c0ffee', path: 'docs/glossary.md', line_start: 1, line_end: 2 }],
      producer, producerVersion: version,
    });
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: vertex('glossary', '1.0.0', 'first') }]));
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: vertex('glossary', '2.0.0', 'second') }]));
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: vertex('other', '1.0.0', 'theirs') }]));
    const open = await owner.transaction('snapshot', async (tx) => await tx.query<{ said_by: string; definition: string }>(`SELECT said_by, definition FROM ${table} o JOIN node n ON n.id = o.node_id WHERE o.state = 'open' AND (n.key->>'name') = 'Supersede' ORDER BY said_by`));
    // One producer stands once, whatever its version; a second producer's opinion stands beside it.
    expect(open.rows).toEqual([{ said_by: 'glossary@2.0.0', definition: 'second' }, { said_by: 'other@1.0.0', definition: 'theirs' }]);
    // A removal by one producer closes only its own opinions: the vertex stands while another opinion is open.
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex-removal', evidence: 'x', value: { kind: 'doc.term', key: { name: 'Supersede' }, producer: 'glossary' } }]));
    const removed = await owner.transaction('snapshot', async (tx) => await tx.query<{ removed: boolean; open: string }>(`SELECT n.removed, (SELECT count(*)::text FROM ${table} o WHERE o.node_id = n.id AND o.state = 'open') AS open FROM node n WHERE (n.key->>'name') = 'Supersede'`));
    expect(removed.rows[0]).toEqual({ removed: false, open: '1' });
    expect((await producerEntities(owner, contract, 'doc.term', 'glossary')).map((one) => one.key['name'])).not.toContain('Supersede');
  });

  test('a publication states the producer\'s whole opinion: a field it leaves out is no opinion of that field', async () => {
    const table = contract.vertex[0]!.table;
    const vertex = (values: Record<string, unknown>): VertexDraft => ({ kind: 'doc.term', key: { name: 'Omitted' }, values, producer: 'glossary', producerVersion: '1.0.0' });
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: vertex({ definition: 'a', strict: 'yes' }) }]));
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: vertex({ definition: 'b' }) }]));
    const open = await owner.transaction('snapshot', async (tx) => await tx.query<{ definition: string; strict: string | null; state: string }>(`SELECT definition, strict, state FROM ${table} o JOIN node n ON n.id = o.node_id WHERE (n.key->>'name') = 'Omitted' ORDER BY o.id`));
    expect(open.rows).toEqual([{ definition: 'a', strict: 'yes', state: 'closed' }, { definition: 'b', strict: null, state: 'open' }]);
  });

  test('declarations resolve before references: a file naming a repository no vertex holds still publishes, and the reference is recorded', async () => {
    // A file whose key names a repository the contract declares and no vertex holds: it is declared, its opinion stands,
    // and the reference is recorded for the consistency check — never a publication failure, never an invented vertex.
    const file = (name: string): VertexDraft => ({ kind: 'doc.term', key: { name }, values: { definition: 'a term' }, producer: 'glossary', producerVersion: '1.0.0' });
    const graph: GraphContract = {
      vertex: [
        ...contract.vertex,
        { name: 'doc.page', table: generatedTableName('doc.page', 'vertex'), fields: [{ name: 'repo', type: 'text', reference: 'doc.term' }, { name: 'path', type: 'text' }, { name: 'title', type: 'text' }], key: ['repo', 'path'], capability: 'glossary' },
      ],
      edge: [], dictionary: [],
    };
    await createOneGraphSchema(owner, graph);
    const page: VertexDraft = { kind: 'doc.page', key: { repo: { kind: 'doc.term', key: { name: 'Nowhere' } }, path: 'a.md' }, values: { title: 'A page' }, producer: 'glossary', producerVersion: '1.0.0' };
    const written = await owner.transaction('write', async (tx) => await publishGraphWrites(tx, graph, [{ kind: 'vertex', evidence: 'x', value: page }]));
    expect(written).toBeGreaterThan(0);
    const held = await owner.transaction('snapshot', async (tx) => await tx.query<{ field: string; target_entity: string; target_key: unknown }>('SELECT field, target_entity, target_key FROM unresolved_reference'));
    expect(held.rows).toEqual([{ field: 'repo', target_entity: 'doc.term', target_key: { name: 'Nowhere' } }]);
    // The reference stands once the term is declared: the next publication of the page clears its record.
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, graph, [{ kind: 'vertex', evidence: 'x', value: file('Nowhere') }]));
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, graph, [{ kind: 'vertex', evidence: 'x', value: page }]));
    const cleared = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM unresolved_reference'));
    expect(cleared.rows[0]?.n).toBe('0');
  });

  test('a store whose graph predates this shape resets as one and needs a fill; the journal is kept', async () => {
    const old = await createTestDatabaseOwner();
    try {
      // The pre-change shape, as this repository held it: `kind`, `node(kind_id)`, `edge(kind_id)`, `claim`, `evidence`.
      for (const statement of [
        `CREATE TABLE kind (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL UNIQUE, sort text NOT NULL, repeats boolean NOT NULL DEFAULT false, discriminator text)`,
        `CREATE TABLE node (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kind_id bigint NOT NULL REFERENCES kind (id), uid uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE)`,
        `CREATE TABLE edge (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kind_id bigint NOT NULL REFERENCES kind (id), from_node bigint NOT NULL REFERENCES node (id), to_node bigint NOT NULL REFERENCES node (id), discriminator text NOT NULL DEFAULT '', context_id bigint NOT NULL DEFAULT 1)`,
        `CREATE TABLE claim (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, node_id bigint NOT NULL REFERENCES node (id), attribute text NOT NULL, value jsonb NOT NULL)`,
        `CREATE TABLE evidence (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, claim_id bigint REFERENCES claim (id))`,
        `CREATE TABLE operation (id uuid PRIMARY KEY, author bigint REFERENCES node (id), change jsonb NOT NULL, at timestamptz NOT NULL DEFAULT now(), machine text NOT NULL DEFAULT '', session text NOT NULL DEFAULT '', words text NOT NULL DEFAULT '')`,
        `INSERT INTO kind (name, sort) VALUES ('file', 'node')`,
        `INSERT INTO node (kind_id) SELECT id FROM kind WHERE name = 'file'`,
        `INSERT INTO node (kind_id) SELECT id FROM kind WHERE name = 'file'`,
        `INSERT INTO operation (id, author, change) SELECT gen_random_uuid(), id, '{}'::jsonb FROM node LIMIT 1`,
      ]) await old.run(async (tx) => await tx.query(statement));
      const made = await createOneGraphSchema(old);
      expect(made.reset).toBe(true);
      const tables = await old.transaction('snapshot', async (tx) => await tx.query<{ name: string }>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname IN ('claim', 'evidence', 'kind')`));
      expect(tables.rows).toEqual([]);
      const nodes = await old.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM node'));
      expect(nodes.rows[0]?.n).toBe('0');
      // The journal's row is kept; its old node link is cleared and the author's word is empty, because no producer
      // stated it.
      const journal = await old.transaction('snapshot', async (tx) => await tx.query<{ n: string; author: string; author_node: string | null }>('SELECT count(*)::text AS n, min(author) AS author, min(author_node::text) AS author_node FROM operation'));
      expect(journal.rows[0]).toEqual({ n: '1', author: '', author_node: null });
      // The empty graph takes a fill: a publication writes its rows again.
      await createRecordSchema(old);
      const counts = await publishTree(old, { repository: { name: 'r', url: 'file:///x' }, commit: 'a'.repeat(40), files: [{ path: 'a.ts', mode: '100644', blob: 'b'.repeat(40), bytes: 3, form: 'text', lines: 1, content: 'x\n', language: 'TypeScript', candidates: ['TypeScript'] }], gitlinks: [] });
      expect(counts.inserted).toBeGreaterThan(0);
    } finally {
      await old.close();
    }
  }, 120_000);

  test('a store written under an older revision of the meaning resets as one and needs a fill; the journal is kept', async () => {
    const old = await createTestDatabaseOwner();
    try {
      // A store as d633a460's shape made it: the current tables, no revision row, and a journal without its order
      // column. Its file opinion carries a programming language where the old meaning kept one — in `lang`.
      await createOneGraphSchema(old, GIT_CONTRACT);
      const made = await old.transaction('write', async (tx) => await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, key: { repository: { kind: 'repository', key: { name: 'r' } }, path: 'a.ts' } }));
      await old.transaction('write', async (tx) => await publishOpinion(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, nodeId: made.nodeId, producer: 'linguist', producerVersion: '9.5.0', values: { language: 'TypeScript', languages: ['TypeScript'] } }));
      await old.run(async (tx) => await tx.query(`UPDATE ${GIT_TABLES.file} SET lang = 'TypeScript', language = NULL`));
      await old.run(async (tx) => await tx.query(`INSERT INTO operation (author, change) VALUES ('git-tree@1', '{"vertices":[],"edges":[],"opinions":[]}'::jsonb)`));
      await old.run(async (tx) => await tx.query(`DELETE FROM madarch_meta.schema_stamp WHERE name = 'one-graph-revision'`));
      await old.run(async (tx) => await tx.query('ALTER TABLE operation DROP COLUMN seq'));
      // The revision moved: the store's rows mean something else now, so the graph is reset as a whole and asks for a fill.
      const reset = await createOneGraphSchema(old, GIT_CONTRACT);
      expect(reset.reset).toBe(true);
      const opinions = await old.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${GIT_TABLES.file}`));
      expect(opinions.rows[0]?.n).toBe('0');
      const journal = await old.transaction('snapshot', async (tx) => await tx.query<{ n: string; author: string; seq: string }>('SELECT count(*)::text AS n, min(author) AS author, min(seq::text) AS seq FROM operation'));
      expect(journal.rows[0]).toEqual({ n: '1', author: 'git-tree@1', seq: '1' });
      const marks = await old.transaction('snapshot', async (tx) => await tx.query<{ name: string }>(`SELECT name FROM madarch_meta.schema_stamp WHERE name IN ('graph-reset', 'one-graph-revision') ORDER BY name`));
      expect(marks.rows.map((row) => row.name)).toEqual(['graph-reset', 'one-graph-revision']);
      // A second open finds the revision it wrote, and resets nothing again.
      expect((await createOneGraphSchema(old, GIT_CONTRACT)).reset).toBe(false);
      const kept = await old.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM operation'));
      expect(kept.rows[0]?.n).toBe('1');
    } finally {
      await old.close();
    }
  }, 120_000);

  test('two concurrent declarations of one vertex both find it', async () => {
    const draft: VertexDraft = { kind: 'doc.term', key: { name: 'Concurrent' }, values: { definition: 'one' }, producer: 'glossary', producerVersion: '1.0.0' };
    const [left, right] = await Promise.all([
      owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: draft }])),
      owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: draft }])),
    ]);
    expect(left + right).toBeGreaterThan(0);
    const nodes = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM node WHERE key @> '{"name":"Concurrent"}'::jsonb`));
    expect(nodes.rows[0]?.n).toBe('1');
  });

  test('a kind with no key stands by a random identity, and two declarations make two vertices', async () => {
    const graph: GraphContract = {
      vertex: [...contract.vertex, { name: 'doc.note', table: generatedTableName('doc.note', 'vertex'), fields: [{ name: 'text', type: 'text' }], key: [], capability: 'glossary' }],
      edge: [], dictionary: [],
    };
    await createOneGraphSchema(owner, graph);
    const note = (text: string): VertexDraft => ({ kind: 'doc.note', key: {}, values: { text }, producer: 'glossary', producerVersion: '1.0.0' });
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, graph, [{ kind: 'vertex', evidence: 'x', value: note('one') }]));
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, graph, [{ kind: 'vertex', evidence: 'x', value: note('two') }]));
    const nodes = await owner.transaction('snapshot', async (tx) => await tx.query<{ key: unknown; uid: string }>(`SELECT n.key, n.uid::text AS uid FROM node n JOIN entity e ON e.id = n.entity_id AND e.name = 'doc.note' ORDER BY n.id`));
    expect(nodes.rows.map((row) => row.key)).toEqual([{}, {}]);
    expect(new Set(nodes.rows.map((row) => row.uid)).size).toBe(2);
  });

  test('an edge end no vertex holds is recorded once per producer and cleared when the edge publishes', async () => {
    const graph: GraphContract = {
      vertex: [...contract.vertex, { name: 'doc.page', table: generatedTableName('doc.page', 'vertex'), fields: [{ name: 'title', type: 'text' }], key: ['title'], capability: 'glossary' }],
      edge: [{ name: 'doc.links', table: generatedTableName('doc.links', 'edge'), from: ['doc.page'], to: ['doc.page'], repeats: false, fields: [], capability: 'glossary' }],
      dictionary: [],
    };
    await createOneGraphSchema(owner, graph);
    const page = (title: string): VertexDraft => ({ kind: 'doc.page', key: { title }, values: {}, producer: 'glossary', producerVersion: '1.0.0' });
    const links = { kind: 'doc.links', from: { kind: 'doc.page', key: { title: 'A' } }, to: { kind: 'doc.page', key: { title: 'Missing' } }, producer: 'glossary', producerVersion: '1.0.0' };
    const once = async (): Promise<void> => { await owner.transaction('write', async (tx) => await publishGraphWrites(tx, graph, [{ kind: 'vertex', evidence: 'x', value: page('A') }, { kind: 'edge', evidence: 'x', value: links }])); };
    await once();
    await once();
    const held = await owner.transaction('snapshot', async (tx) => await tx.query<{ edge_entity: string; field: string; target_entity: string; producer: string; against: string | null }>('SELECT edge_entity, field, target_entity, producer, against_node::text AS against FROM unresolved_reference'));
    // One row for a rerun of the same answer; the kind, the field, the target, the producer and the end that stands are kept.
    expect(held.rows).toEqual([{ edge_entity: 'doc.links', field: 'to', target_entity: 'doc.page', producer: 'glossary@1.0.0', against: null }]);
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, graph, [{ kind: 'vertex', evidence: 'x', value: page('Missing') }]));
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, graph, [{ kind: 'edge', evidence: 'x', value: links }]));
    const cleared = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM unresolved_reference'));
    expect(cleared.rows[0]?.n).toBe('0');
  });

  test('one publication writes one journal entry, authored by the producer, naming the vertices and opinions by id', async () => {
    const before = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM operation'));
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [
      { kind: 'vertex', evidence: 'docs/glossary.md', value: { kind: 'doc.term', key: { name: 'Journaled' }, values: { definition: 'a term' }, producer: 'glossary', producerVersion: '1.0.0' } },
    ]));
    const after = await owner.transaction('snapshot', async (tx) => await tx.query<{ author: string; change: { vertices: { entity: string; uid: string; node: string; state: string }[]; edges: unknown[]; opinions: { id: string; node: string; state: string; fields: string[] }[] } }>('SELECT author, change FROM operation ORDER BY seq'));
    expect(after.rows).toHaveLength(Number(before.rows[0]?.n ?? '0') + 1);
    const entry = after.rows[after.rows.length - 1]!;
    expect(entry.author).toBe('glossary@1.0.0');
    expect(entry.change.vertices).toHaveLength(1);
    expect(entry.change.vertices[0]).toMatchObject({ entity: 'doc.term', state: 'declared' });
    const opened = entry.change.opinions.find((one) => one.state === 'opened');
    expect(opened?.fields).toEqual(['definition']);
    // The opinion's id is the row's id, and the vertex it names is the one that stands.
    const table = contract.vertex[0]!.table;
    const rows = await owner.transaction('snapshot', async (tx) => await tx.query<{ id: string; node: string }>(`SELECT o."id"::text AS id, n.uid::text AS node FROM ${table} o JOIN node n ON n.id = o.node_id WHERE o.state = 'open' AND (n.key->>'name') = 'Journaled'`));
    expect(rows.rows).toEqual([{ id: opened?.id ?? '', node: entry.change.vertices[0]?.uid ?? '' }]);
    expect((entry.change.opinions[0]?.node)).toBe(entry.change.vertices[0]?.uid);
  });

  test('a removal-only publication is journaled under its producer\'s author, and a publication with no author is refused', async () => {
    // A vertex with this producer's opinion, and a second producer's opinion beside it: the removal below withdraws one.
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: { kind: 'doc.term', key: { name: 'Left' }, values: { definition: 'one' }, producer: 'glossary', producerVersion: '1.0.0' } }]));
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: { kind: 'doc.term', key: { name: 'Left' }, values: { definition: 'another' }, producer: 'other', producerVersion: '2' } }]));
    const before = await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM operation'));
    // The removal names its producer and no journal draft: the entry's author is that producer, and the change is kept.
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex-removal', evidence: 'x', value: { kind: 'doc.term', key: { name: 'Left' }, producer: 'glossary' } }]));
    const entries = await owner.transaction('snapshot', async (tx) => await tx.query<{ author: string; change: { opinions: { state: string; said_by: string }[]; vertices: { state: string }[] } }>('SELECT author, change FROM operation ORDER BY seq'));
    expect(entries.rows).toHaveLength(Number(before.rows[0]?.n ?? '0') + 1);
    const entry = entries.rows[entries.rows.length - 1]!;
    expect(entry.author).toBe('glossary');
    expect(entry.change.opinions).toHaveLength(1);
    expect(entry.change.opinions[0]).toMatchObject({ state: 'closed', said_by: 'glossary@1.0.0' });
    // Another producer's opinion stands, so the vertex is not journaled as removed (codex, stage 2 review, item 4).
    expect(entry.change.vertices).toEqual([]);
    // A publication that states a change and names no author is refused by the writer, naming what is missing.
    await expect(owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, { vertices: [], removals: [] }, 1, { reads: [{ method: 'graph.files', size: 3, outcome: 'answered' }] }))).rejects.toThrow(/names its author/);
  }, 120_000);

  test('an ineffective withdrawal journals nothing, whether it repeats the first or follows a removal', async () => {
    const count = async (): Promise<number> => Number((await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM operation'))).rows[0]?.n ?? '0');
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: { kind: 'doc.term', key: { name: 'Gone' }, values: { definition: 'bye' }, producer: 'glossary', producerVersion: '1.0.0' } }]));
    await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex-removal', evidence: 'x', value: { kind: 'doc.term', key: { name: 'Gone' }, producer: 'glossary' } }]));
    const afterFirst = await count();
    // The producer holds nothing here any more: a second withdrawal changes no row and writes no entry.
    const wrote = await owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex-removal', evidence: 'x', value: { kind: 'doc.term', key: { name: 'Gone' }, producer: 'glossary' } }]));
    expect(wrote).toBe(0);
    expect(await count()).toBe(afterFirst);
  }, 120_000);

  test('a bulk declaration journals one edge event per edge it makes, with its ends by uid', async () => {
    // The pages kind and its links, the contract the case above made: the same stamp, so this case adds no table.
    const graph: GraphContract = {
      vertex: [...contract.vertex, { name: 'doc.page', table: generatedTableName('doc.page', 'vertex'), fields: [{ name: 'title', type: 'text' }], key: ['title'], capability: 'glossary' }],
      edge: [{ name: 'doc.links', table: generatedTableName('doc.links', 'edge'), from: ['doc.page'], to: ['doc.page'], repeats: false, fields: [], capability: 'glossary' }],
      dictionary: [],
    };
    await createOneGraphSchema(owner, graph);
    // Two vertices of the links kind's ends, declared by the writer, so the edge has something to name.
    for (const title of ['From', 'To']) await owner.transaction('write', async (tx) => await publishGraphWrites(tx, graph, [{ kind: 'vertex', evidence: 'x', value: { kind: 'doc.page', key: { title }, values: {}, producer: 'glossary', producerVersion: '1.0.0' } }]));
    const ids = await owner.transaction('snapshot', async (tx) => await tx.query<{ id: string; name: string }>(
      `SELECT n.id::text AS id, (n.key->>'title') AS name FROM node n JOIN entity en ON en.id = n.entity_id AND en.name = 'doc.page' WHERE (n.key->>'title') = ANY($1::text[])`, [['From', 'To']],
    ));
    const from = ids.rows.find((row) => row.name === 'From')!.id;
    const to = ids.rows.find((row) => row.name === 'To')!.id;
    const before = Number((await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM operation'))).rows[0]?.n ?? '0');
    await owner.transaction('write', async (tx) => {
      const journal = journalFor('bulk@1');
      journalOn(tx, journal);
      await ensureEdges(tx, graph, 'doc.links', [{ from, to }, { from: to, to: from }], 1);
      await writeJournal(tx, journal);
    });
    const entries = await owner.transaction('snapshot', async (tx) => await tx.query<{ change: { edges: { entity: string; from: string; to: string; discriminator: string; context: number; state: string }[] } }>('SELECT change FROM operation ORDER BY seq'));
    expect(entries.rows).toHaveLength(before + 1);
    const edges = entries.rows[entries.rows.length - 1]!.change.edges;
    expect(edges).toHaveLength(2);
    expect(edges.every((one) => one.state === 'declared' && one.entity === 'doc.links' && one.discriminator === '' && one.context === 1)).toBe(true);
    const uids = await owner.transaction('snapshot', async (tx) => await tx.query<{ uid: string }>(`SELECT uid::text AS uid FROM node WHERE id = ANY($1::bigint[])`, [`{${from},${to}}`]));
    expect(new Set(edges.flatMap((one) => [one.from, one.to]))).toEqual(new Set(uids.rows.map((row) => row.uid)));
    // The same batch again declares nothing: no edge is made, so no event is journaled and no entry is written.
    const again = Number((await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM operation'))).rows[0]?.n ?? '0');
    await owner.transaction('write', async (tx) => {
      const journal = journalFor('bulk@1');
      journalOn(tx, journal);
      await ensureEdges(tx, graph, 'doc.links', [{ from, to }, { from: to, to: from }], 1);
      await writeJournal(tx, journal);
    });
    expect(Number((await owner.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM operation'))).rows[0]?.n ?? '0')).toBe(again);
  }, 120_000);

  test('an agent operation is one entry with its words, and its opinion rests on the conversation', async () => {
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
      vertices: [{
        kind: 'doc.term', key: { name: 'Spoken' }, values: { definition: 'a term we said' },
        evidence: [{ type: 'conversation', id: 'talk-2026-11-11', speaker: 'the owner', at: '2026-11-11T09:00:00Z' }],
        producer: 'agent', producerVersion: '1',
      }],
      removals: [],
    }, 1, { author: 'agent', words: 'the owner said this term means a term we said' }));
    const entries = await owner.transaction('snapshot', async (tx) => await tx.query<{ author: string; words: string }>(`SELECT author, words FROM operation WHERE author = 'agent' ORDER BY seq DESC LIMIT 1`));
    expect(entries.rows).toEqual([{ author: 'agent', words: 'the owner said this term means a term we said' }]);
    const evidence = await owner.transaction('snapshot', async (tx) => await tx.query<{ evidence: readonly Record<string, unknown>[] }>(`SELECT o.evidence FROM ${contract.vertex[0]!.table} o JOIN node n ON n.id = o.node_id WHERE o.state = 'open' AND (n.key->>'name') = 'Spoken'`));
    expect(evidence.rows[0]?.evidence).toEqual([{ type: 'conversation', id: 'talk-2026-11-11', speaker: 'the owner', at: '2026-11-11T09:00:00Z' }]);
  });

  test('a kind the contract does not declare is refused by the writer, naming it', async () => {
    await expect(owner.transaction('write', async (tx) => await publishGraphWrites(tx, contract, [{ kind: 'vertex', evidence: 'x', value: { ...term('x', 'y'), kind: 'doc.other' } }]))).rejects.toThrow(/doc.other/);
  });
});
