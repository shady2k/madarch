/**
 * A page's one transaction (madarch-8bdc.2.5): a page is rendered inside one
 * snapshot of the store, a page that fails releases it, and a dated reader
 * inherits the page's transaction. The graph is the one graph; its signature
 * entity is the page's subject, because the test is about the transaction and
 * not about which kind a page shows.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { KnowledgeProduct, pageSnapshotOwner } from '../src/knowledge/product.js';
import { renderPage } from '../src/knowledge/render.js';
import { GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { repositoryContract, repositoryKindReads, repositoryEdgeReads } from './repository-contract-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import { workingTreeFiles } from '../src/plugin/product-files.js';
import { generatedTableName } from '../src/graph/contract.js';
import { ensureVertex, journalFor, publishOpinion, writeJournal } from '../src/graph/write.js';

const templateContract = {
  vertex: [{ name: 'template', table: generatedTableName('template', 'vertex'), key: ['path'], capability: 'fixture', fields: [{ name: 'path', type: 'text' as const }, { name: 'template_parts', type: 'json' as const }] }],
  edge: [], dictionary: [],
};
const contract = { ...repositoryContract, vertex: [...repositoryContract.vertex.filter(vertex => vertex.name !== 'template'), ...templateContract.vertex] };
const templates = new Map([['template', { kind: 'template', table: templateContract.vertex[0]!.table, key: ['path'], columns: ['template_parts'], types: { template_parts: 'json' as const } }]]);
const graph = (database: DatabaseOwner, transaction?: OuterTransaction): GraphReader => new GraphReader(database, () => at, undefined, transaction, undefined, new Map([...repositoryKindReads, ...templates]), repositoryEdgeReads);

const at = '2026-02-04T00:00:00.000Z';
const id = 'code.author:walk@example.test';
let owner: DatabaseOwner;

beforeAll(async () => {
  owner = await createTestDatabaseOwner({ graphContract: contract });
  await owner.transaction('write', async (tx) => {
    const node = await tx.query<{ id: string }>(`INSERT INTO node (entity_id, key) SELECT id, $2::jsonb FROM entity WHERE name = $1 RETURNING id::text AS id`, ['code.author', JSON.stringify({ name: 'Walk', email: 'walk@example.test' })]);
    await tx.query(`INSERT INTO ${GIT_TABLES.signature} (node_id, said_by) VALUES ($1::bigint, 'git-history@1')`, [node.rows[0]!.id]);
    const journal = journalFor('fixture@1');
    const template = await ensureVertex(tx, contract, { kind: 'template', key: { path: 'author.md' } }, 1, journal);
    await publishOpinion(tx, contract, {
      kind: 'template', nodeId: template.nodeId, producer: 'fixture', producerVersion: '1',
      values: { template_parts: [{ type: 'attribute', name: 'name', line: 1 }, { type: 'text', text: ' <', line: 1 }, { type: 'attribute', name: 'email', line: 1 }, { type: 'text', text: '>\n', line: 1 }] },
    }, 1, journal);
    await writeJournal(tx, journal);
  });
});

afterAll(async () => { await owner.close(); });

function context(folder: string, graph: GraphReader): RenderContext {
  return {
    productFolder: folder, files: workingTreeFiles(folder), graph, language: 'en', markdown: new Map(),
    manifest: { file: 'madarch/kinds.yaml', kinds: new Map([['code.author', { name: 'code.author', template: 'author.md', source: 'graph', title: 'label', relations: [], line: 1 }]]), roles: new Map(), groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] },
    resolver: { resolve: async () => { throw new Error('the fixture has no authored links'); } },
    repoOfScope: () => undefined, repositories: [],
  } as unknown as RenderContext;
}

function productFixture(folder: string, openOwner: DatabaseOwner) {
  const product = new KnowledgeProduct({ productFolder: folder, storeRoot: folder } as ConstructorParameters<typeof KnowledgeProduct>[0]);
  const seam = product as unknown as {
    open(): Promise<DatabaseOwner>;
    context(history?: unknown, snapshot?: { owner: DatabaseOwner; transaction: OuterTransaction; validAt: string }): Promise<{ ctx: RenderContext }>;
    plannedForPage(id: string): Promise<{ entity: null; statements: [] }>;
    validAt(): string;
  };
  seam.open = async () => openOwner;
  (product as unknown as { fill: { state: string } }).fill = { state: 'running' };
  seam.validAt = () => at;
  seam.plannedForPage = async () => ({ entity: null, statements: [] });
  seam.context = async (_history, snapshot) => ({ ctx: context(folder, graph(openOwner, snapshot!.transaction)) });
  return { product };
}

test('ordinary page shares exactly one transaction and retains the unbatched renderer output', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'page-batch-'));
  try {
    writeFileSync(join(folder, 'author.md'), '{{name}} <{{email}}>\n');
    let transactions = 0;
    const counted: DatabaseOwner = new Proxy(owner, {
      get(target, key) {
        if (key === 'transaction') return async (kind: string, work: (tx: OuterTransaction) => Promise<unknown>) => { transactions += 1; return await target.transaction(kind as never, work); };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const baseline = await renderPage(context(folder, graph(counted)), id);
    expect(baseline.ok).toBe(true);
    const before = transactions;
    const product = productFixture(folder, counted);
    const actual = await product.product.page(id);
    if (!baseline.ok || !actual.ok) throw new Error('both snapshot and standalone pages must render');
    expect(actual.page).toEqual({ ...baseline.page, planned: { entity: null, statements: [] }, historyNavigation: [] });
    expect(actual.ok).toBe(true);
    expect(transactions - before).toBe(1);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a page query failure releases its snapshot and the next page can read normally', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'page-batch-error-'));
  try {
    writeFileSync(join(folder, 'author.md'), '{{name}}\n');
    let fail = true;
    const failing: DatabaseOwner = new Proxy(owner, {
      get(target, key) {
        if (key === 'transaction') return async (kind: string, work: (tx: OuterTransaction) => Promise<unknown>) => await target.transaction(kind as never, async (tx) => await work({ query: async (sql: string, values: readonly unknown[] = []) => { if (fail) { fail = false; throw new Error('test query failed'); } return await tx.query(sql, values); } } as unknown as OuterTransaction));
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const product = productFixture(folder, failing);
    await expect(product.product.page(id)).rejects.toThrow('test query failed');
    expect((await product.product.page(id)).ok).toBe(true);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the page owner passes bare reads to its snapshot and rejects nested opens instead of deadlocking', async () => {
  let transactions = 0;
  await owner.transaction('snapshot', async (tx) => {
    transactions += 1;
    const held = pageSnapshotOwner(owner, tx);
    await held.run((query) => query.query('SELECT 1'));
    expect(() => held.transaction('snapshot', async () => undefined)).toThrow('cannot open a nested transaction');
  });
  expect(transactions).toBe(1);
});

test('dated graph readers inherit the page transaction, while standalone readers retain their snapshots', async () => {
  let transactions = 0;
  const counted: DatabaseOwner = new Proxy(owner, {
    get(target, key) {
      if (key === 'transaction') return async (kind: string, work: (tx: OuterTransaction) => Promise<unknown>) => { transactions += 1; return await target.transaction(kind as never, work); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await counted.transaction('snapshot', async (tx) => {
    const dated = graph(counted, tx).at('2026-02-01T00:00:00.000Z', '1');
    await dated.find(id); await dated.kindCounts();
    expect(transactions).toBe(1);
  });
  await graph(counted).find(id);
  expect(transactions).toBe(2);
});
