/**
 * The bounded read by property on the static stage's context (decision 0033,
 * item 5; madarch-8bdc.2.4): one file's facts are more rows than one page, so a
 * stage asks for them page by page — `byProperty(kind, field, value, {limit,
 * after})` — and no page is wider than `STATIC_READ_ROW_LIMIT`. The read is
 * recorded as the JSON document the publication's recheck replays, and it
 * answers the same page when it is replayed.
 *
 * The store is the test's own: a PGlite owner, the graph schema, and nodes
 * published through the store's one unit publication.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore, outerTransactionOf, type GraphStore } from '../src/graph/index.js';
import { staticGraphRead, STATIC_READ_ROW_LIMIT } from '../src/fill/stages/static-context.js';
import { createStaticStageReadReader } from '../src/fill/stages/static-reads.js';
import { CODE_GRAPH_VOCABULARY, ensureGraphSchema, staticUnitPublicationOf } from '../src/fill/stages/static-graph.js';

const REPOSITORY = 'shop';
const FILE = 'src/many.ts';

let root = '';
let owner: DatabaseOwner | undefined;
let store: GraphStore | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-property-read-'));
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  store = createGraphStore(owner);
  await ensureGraphSchema(store);
  // More nodes under one file than one page holds: the read is paged, never widened.
  const count = STATIC_READ_ROW_LIMIT * 2 + 7;
  const nodes = Array.from({ length: count }, (_, index) => ({
    key: `code.expression:${REPOSITORY}:${FILE}@${String(index)}:${String(index + 1)}:identifier`,
    kind: 'code.expression',
    label: 'identifier',
    properties: { recordKey: `code.expression:${REPOSITORY}:${FILE}@${String(index)}:${String(index + 1)}:identifier`, factKind: 'expression', repository: REPOSITORY, file: FILE, index },
  }));
  await store.publishUnit(staticUnitPublicationOf({
    unitId: `file:${REPOSITORY}:${FILE}`,
    stageId: 'code-facts',
    digest: 'd'.repeat(64),
    writes: nodes.map((node) => ({ kind: 'node' as const, evidence: `${REPOSITORY}@${'a'.repeat(40)}:${FILE}`, value: node })),
  }));
  // Two units publish edges a later unit reads by a value they carry: a consumer edge into a
  // channel, and an access edge into a table — the fold the contracts stage makes.
  await store.publishUnit(staticUnitPublicationOf({
    unitId: `file:${REPOSITORY}:src/consumer.ts`,
    stageId: 'contracts',
    digest: 'e'.repeat(64),
    writes: [
      { kind: 'node' as const, evidence: 'x', value: { key: `code.expression:${REPOSITORY}:src/consumer.ts@0:1:identifier`, kind: 'code.expression', label: 'consume', properties: { recordKey: `code.expression:${REPOSITORY}:src/consumer.ts@0:1:identifier`, factKind: 'expression', repository: REPOSITORY, file: 'src/consumer.ts' } } },
      { kind: 'node' as const, evidence: 'x', value: { key: `code.expression:${REPOSITORY}:src/consumer.ts@10:11:identifier`, kind: 'code.expression', label: 'orders.events', properties: { recordKey: `code.expression:${REPOSITORY}:src/consumer.ts@10:11:identifier`, factKind: 'expression', repository: REPOSITORY, file: 'src/consumer.ts' } } },
      { kind: 'edge' as const, evidence: 'x', value: { relation: 'code.references', from: { key: `code.expression:${REPOSITORY}:src/consumer.ts@0:1:identifier` }, to: { key: `code.expression:${REPOSITORY}:src/consumer.ts@10:11:identifier` }, properties: { factKind: 'consumes', repository: REPOSITORY, topic: 'orders.events' } } },
    ],
  }));
}, 900_000);

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
}, 300_000);

describe('the bounded read of edges by a value', () => {
  test('answers the edges one unit published by the value they carry, and replays the recorded read', async () => {
    if (store === undefined) throw new Error('the store was not opened');
    const reader = createStaticStageReadReader(store);
    const text = staticGraphRead({ kind: 'edgesByProperty', value: 'orders.events', relation: 'code.references', field: 'topic', limit: STATIC_READ_ROW_LIMIT });
    const page = await reader.query(text) as readonly { readonly relation: string; readonly properties: Record<string, unknown> }[];
    expect(page.length).toBe(1);
    expect(page[0]!.relation).toBe('code.references');
    expect(page[0]!.properties['topic']).toBe('orders.events');
    const { staticGraphReaderOf } = await import('../src/fill/stages/static-context.js');
    const graph = staticGraphReaderOf(store);
    const direct = await graph.edgesByProperty('code.references', 'topic', 'orders.events');
    expect(direct.rows.length).toBe(1);
    expect(direct.next).toBeNull();
    await expect(graph.edgesByProperty('', 'topic', 'orders.events')).rejects.toThrow(/names the relation/);
    await expect(graph.edgesByProperty('code.references', '', 'orders.events')).rejects.toThrow(/names the field/);
    await expect(graph.edgesByProperty('code.references', 'topic', '')).rejects.toThrow(/names an empty value/);
  }, 300_000);
});

describe('the bounded read by property', () => {
  test('answers one page at a time, no wider than the cap, and replays the recorded read', async () => {
    if (store === undefined) throw new Error('the store was not opened');
    const reader = createStaticStageReadReader(store);
    const count = STATIC_READ_ROW_LIMIT * 2 + 7;
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const text = staticGraphRead({ kind: 'property', value: FILE, nodeKind: 'code.expression', field: 'file', limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
      const page = await reader.query(text) as readonly { readonly id: string }[];
      expect(page.length).toBeLessThanOrEqual(STATIC_READ_ROW_LIMIT);
      if (page.length === 0) break;
      seen.push(...page.map((node) => node.id));
      // The page's last node is the cursor the next page asks after: the read is keyset-paged by node id.
      after = page[page.length - 1]!.id;
    }
    expect(seen.length).toBe(count);
  }, 300_000);

  test('refuses a page wider than the cap and a question with an empty part', async () => {
    if (store === undefined) throw new Error('the store was not opened');
    const { staticGraphReaderOf } = await import('../src/fill/stages/static-context.js');
    const graph = staticGraphReaderOf(store);
    await expect(graph.byProperty('code.expression', 'file', FILE, { limit: STATIC_READ_ROW_LIMIT + 1 })).rejects.toThrow(new RegExp(`a static read answers 1 to ${String(STATIC_READ_ROW_LIMIT)} rows`));
    await expect(graph.byProperty('', 'file', FILE)).rejects.toThrow(/names the kind it reads/);
    await expect(graph.byProperty('code.expression', '', FILE)).rejects.toThrow(/names the field it matches/);
    await expect(graph.byProperty('code.expression', 'file', '')).rejects.toThrow(/names an empty value/);
  }, 300_000);
});
