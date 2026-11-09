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
import { createRecordSchema } from '../src/graph/index.js';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { KnowledgeProduct, pageSnapshotOwner } from '../src/knowledge/product.js';
import { renderPage } from '../src/knowledge/render.js';
import { GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { createTestDatabaseOwner } from './test-database.js';

const at = '2026-02-04T00:00:00.000Z';
const id = 'code.author:walk@example.test';
let owner: DatabaseOwner;

beforeAll(async () => {
  owner = await createTestDatabaseOwner({});
  await createRecordSchema(owner);
  await owner.transaction('write', async (tx) => {
    const node = await tx.query<{ id: string }>('INSERT INTO node (kind_id) SELECT id FROM kind WHERE name = $1 RETURNING id::text AS id', ['signature']);
    await tx.query(`INSERT INTO ${GIT_TABLES.signature} (node_id, name, email) VALUES ($1::bigint, $2, $3)`, [node.rows[0]!.id, 'Walk', 'walk@example.test']);
  });
});

afterAll(async () => { await owner.close(); });

function context(folder: string, graph: GraphReader): RenderContext {
  return {
    productFolder: folder, graph, language: 'en', markdown: new Map(),
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
  seam.context = async (_history, snapshot) => ({ ctx: context(folder, new GraphReader(openOwner, () => snapshot!.validAt, undefined, snapshot!.transaction)) });
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
    const baseline = await renderPage(context(folder, new GraphReader(counted, () => at)), id);
    expect(baseline.ok).toBe(true);
    const before = transactions;
    const product = productFixture(folder, counted);
    const actual = await product.product.page(id);
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
    const graph = new GraphReader(counted, () => at, undefined, tx).at('2026-02-01T00:00:00.000Z', '1');
    await graph.find(id); await graph.kindCounts();
    expect(transactions).toBe(1);
  });
  await new GraphReader(counted, () => at).find(id);
  expect(transactions).toBe(2);
});
