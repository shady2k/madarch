import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { KnowledgeProduct, pageSnapshotOwner } from '../src/knowledge/product.js';
import { renderPage } from '../src/knowledge/render.js';

const at = '2026-02-04T00:00:00.000Z';
const id = 'code.symbol:src/example.ts#example';
function ownerFixture() {
  let transactions = 0; let active = false; let fail = false;
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  const tx = { query: async (sql: string, values: readonly unknown[] = []) => {
    if (!active) throw new Error('statement outside snapshot');
    statements.push({ sql, values });
    if (fail) { fail = false; throw new Error('test query failed'); }
    if (sql.includes("v.properties->>'recordKey' = $2")) return { rows: [{ node_id: '2', scope_id: '1', kind: 'code.symbol', label: 'example', producer: 'code', properties: { recordKey: id, symbolKind: 'function' } }] };
    return { rows: [] };
  } } as unknown as OuterTransaction;
  const owner = {
    transaction: async (_kind: unknown, work: (value: OuterTransaction) => Promise<unknown>) => {
      if (active) throw new Error('nested owner transaction');
      transactions++; active = true;
      try { return await work(tx); } finally { active = false; }
    },
    run: async () => { throw new Error('owner.run must use the held page transaction'); },
  } as unknown as DatabaseOwner;
  return { owner, tx, statements, n: () => transactions, active: () => active, fail: () => { fail = true; } };
}
function context(folder: string, graph: GraphReader): RenderContext {
  return {
    productFolder: folder, graph, language: 'en', markdown: new Map(), docEntities: new Map(),
    manifest: { file: 'madarch/kinds.yaml', kinds: new Map([['code.symbol', { name: 'code.symbol', template: 'symbol.md', source: 'graph', title: 'label', relations: [], line: 1 }]]), roles: new Map(), groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] },
    resolver: { resolve: async () => { throw new Error('the fixture has no authored links'); } },
    repoOfScope: () => 'sample', repositories: ['sample'],
  } as unknown as RenderContext;
}
function productFixture(folder: string, f: ReturnType<typeof ownerFixture>) {
  const product = new KnowledgeProduct({ productFolder: folder, storeRoot: folder } as ConstructorParameters<typeof KnowledgeProduct>[0]);
  const seam = product as unknown as {
    open(): Promise<DatabaseOwner>;
    context(history?: unknown, snapshot?: { owner: DatabaseOwner; transaction: OuterTransaction; validAt: string }): Promise<{ ctx: RenderContext }>;
    plannedForPage(id: string): Promise<{ entity: null; statements: [] }>;
    validAt(): string;
  };
  seam.open = async () => f.owner;
  seam.validAt = () => at;
  seam.plannedForPage = async () => { expect(f.active()).toBe(false); return { entity: null, statements: [] }; };
  seam.context = async (_history, snapshot) => {
    expect(snapshot?.owner).toBe(f.owner);
    expect(f.active()).toBe(true);
    return { ctx: context(folder, new GraphReader(f.owner, () => snapshot!.validAt, undefined, snapshot!.transaction)) };
  };
  return product;
}

test('ordinary page shares exactly one transaction and retains the unbatched renderer output', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'page-batch-'));
  try {
    writeFileSync(join(folder, 'symbol.md'), '{{symbolKind}} {{label}}\n\n:::callers\n:::callees\n');
    const baseline = ownerFixture();
    const rendered = await renderPage(context(folder, new GraphReader(baseline.owner, () => at)), id);
    expect(rendered.ok).toBe(true);
    expect(baseline.n()).toBeGreaterThan(1);
    const f = ownerFixture(); const product = productFixture(folder, f);
    const actual = await product.page(id);
    expect(actual).toEqual(rendered.ok ? { ok: true, page: { ...rendered.page, planned: { entity: null, statements: [] }, historyNavigation: [] } } : rendered);
    expect(f.n()).toBe(1);
    expect(f.statements.map((statement) => statement.sql)).toEqual(baseline.statements.map((statement) => statement.sql));
    expect(f.statements.every((statement) => statement.values[0] === at)).toBe(true);
    expect(f.active()).toBe(false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a page query failure releases its snapshot and the next page can read normally', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'page-batch-error-'));
  try {
    writeFileSync(join(folder, 'symbol.md'), '{{label}}\n');
    const f = ownerFixture(); const product = productFixture(folder, f); f.fail();
    await expect(product.page(id)).rejects.toThrow('test query failed');
    expect(f.active()).toBe(false);
    expect((await product.page(id)).ok).toBe(true);
    expect(f.n()).toBe(2);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the page owner passes bare reads to its snapshot and rejects nested opens instead of deadlocking', async () => {
  const f = ownerFixture();
  await f.owner.transaction('snapshot', async (tx) => {
    const held = pageSnapshotOwner(f.owner, tx);
    await held.run((query) => query.query('SELECT 1'));
    expect(() => held.transaction('snapshot', async () => undefined)).toThrow('cannot open a nested transaction');
  });
  expect(f.n()).toBe(1); expect(f.statements).toHaveLength(1); expect(f.active()).toBe(false);
});

test('dated graph readers inherit the page transaction, while standalone readers retain their snapshots', async () => {
  const f = ownerFixture();
  await f.owner.transaction('snapshot', async (tx) => {
    const graph = new GraphReader(f.owner, () => at, undefined, tx).at('2026-02-01T00:00:00.000Z', '1');
    await graph.find(id); await graph.kindCounts();
    expect(f.n()).toBe(1);
  });
  expect(f.statements.every((statement) => statement.values[0] === '2026-02-01T00:00:00.000Z')).toBe(true);
  expect(f.statements.every((statement) => statement.sql.includes('scope_id = 1::bigint'))).toBe(true);
  await new GraphReader(f.owner, () => at).find(id);
  expect(f.n()).toBe(2);
});
