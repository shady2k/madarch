/**
 * The graph index of the product's Markdown (madarch-m38l.8) over a small
 * generated repository: pages, statements and their grounds become nodes and
 * edges; the wiki's three queries answer from them; a rebuild from the
 * Markdown restores the same index. Fixtures only: the repository is made in
 * a scratch folder, the pages are written here.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS } from '../src/extract/driver/extractors.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { changedGrounds, gitReader, indexCounts, indexKnowledge, readIndexedPage, statementsRelyingOn, type IndexedPage } from '../src/knowledge/index/index.js';
import { GraphView } from '../src/writer/index.js';
import { gitEnv } from './git-env.js';

const REQUIREMENTS = `# Requirements

## UC-1 Refund an order
The shopper asks for a refund.

## BR-2 Refund window
Refunds are allowed within 14 days.

## BR-3 Capture
Charges are captured when an order ships.
`;

const SOURCE = `export function refund(total: number, captured: number): boolean {
  return total <= captured;
}

export function capture(total: number): number {
  return total;
}
`;

let scratch: string;
let repository: string;
let commit1: string;
let commit2: string;
const stores: { owner: DatabaseOwner; store: GraphStore }[] = [];

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', env: gitEnv({ GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.test', GIT_AUTHOR_DATE: dates.next, GIT_COMMITTER_DATE: dates.next }) }).trim();
}
const dates = { next: '2020-01-01T10:00:00Z' };

async function openStore(name: string): Promise<{ owner: DatabaseOwner; store: GraphStore }> {
  const owner = createPGliteDatabaseOwner({ btreeGist: true, path: path.join(scratch, name) });
  const store = createGraphStore(owner);
  await owner.ready;
  await store.createSchema();
  stores.push({ owner, store });
  return { owner, store };
}

async function fill(held: { owner: DatabaseOwner; store: GraphStore }): Promise<void> {
  await fillGraph({ owner: held.owner, store: held.store, repository, extractors: TREE_EXTRACTORS, owners: OWNERS, history: HISTORY_EXTRACTOR, snapshots: {} });
}

async function keyOf(owner: DatabaseOwner, like: string): Promise<string> {
  const rows = (await owner.run((tx) => tx.query<{ key: string }>(`SELECT DISTINCT properties->>'recordKey' AS key FROM node_version WHERE properties->>'recordKey' LIKE $1 ORDER BY 1`, [like]))).rows;
  if (rows.length === 0) throw new Error(`the graph holds no key like ${like}`);
  return rows[0]!.key;
}

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'madarch-index-'));
  repository = path.join(scratch, 'training');
  mkdirSync(path.join(repository, 'docs'), { recursive: true });
  mkdirSync(path.join(repository, 'src'), { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repository, 'docs/requirements.md'), REQUIREMENTS);
  writeFileSync(path.join(repository, 'src/refund.ts'), SOURCE);
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  commit1 = git('rev-parse', 'HEAD');
}, 60_000);

afterAll(async () => {
  for (const held of stores) await held.owner.close();
  rmSync(scratch, { recursive: true, force: true });
}, 60_000);

const sha = (text: string): string => `${text.length}`;

function pages(refundKey: string, captureKey: string, extra = ''): IndexedPage[] {
  const front = (id: string, kind: string, title: string, relates: string): string => `---
id: ${id}
kind: ${kind}
title: ${title}
relates:
  - ${relates}
producer: agent
sources: [docs/requirements.md]
written-at:
  - repository: training
    commit: ${commit1}
    branch: main
    origin: git@github.com:acme/shop.git
---
`;
  const domain = `${front('domain:refunds', 'domain', 'Refunds', refundKey)}Refunds are decided by one function.[^refund-decision] A refund is allowed within 14 days.[^refund-window] Charges are captured when an order ships.[^capture-on-ship] The source file holds both rules.[^source-file]${extra}

[^refund-decision]: [refund](madarch:${refundKey}), [UC-1](madarch:doc:docs/requirements.md#uc-1)
[^refund-window]: [BR-2](madarch:doc:docs/requirements.md#br-2)
[^capture-on-ship]: [capture](madarch:${captureKey}), [BR-3](madarch:doc:docs/requirements.md#br-3)
[^source-file]: [refund.ts](madarch:code.file:src/refund.ts)
`;
  const product = `${front('product:shop', 'product', 'Shop', refundKey)}The shop refunds orders through the [refunds domain](madarch:domain:refunds).[^shop-refunds]

[^shop-refunds]: [UC-1](madarch:doc:docs/requirements.md#uc-1)
`;
  return [readIndexedPage('docs/domains/refunds.md', domain, sha), readIndexedPage('docs/product.md', product, sha)];
}

/** The index as a person would compare it: node keys and edges between keys, with the properties that are not instants or ids. */
async function dump(owner: DatabaseOwner): Promise<string[]> {
  const nodes = (await owner.run((tx) => tx.query<{ key: string; kind: string; label: string }>(
    `SELECT v.properties->>'key' AS key, k.key AS kind, v.label FROM node_version v JOIN node_kind k ON k.id = v.kind_id
     WHERE v.producer = 'knowledge.index' AND v.valid_to = 'infinity' AND v.recorded_to = 'infinity' ORDER BY 1`,
  ))).rows;
  const edges = (await owner.run((tx) => tx.query<{ relation: string; src: string; dst: string; properties: unknown }>(
    `SELECT r.key AS relation, s.properties->>'key' AS src, coalesce(d.properties->>'key', d.properties->>'recordKey') AS dst, e.properties
     FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
     JOIN node_version s ON s.node_id = e.src_id AND s.valid_to = 'infinity' AND s.recorded_to = 'infinity'
     JOIN node_version d ON d.node_id = e.dst_id AND d.valid_to = 'infinity' AND d.recorded_to = 'infinity'
     WHERE e.producer = 'knowledge.index' AND e.valid_to = 'infinity' AND e.recorded_to = 'infinity' ORDER BY 1, 2, 3`,
  ))).rows;
  return [...nodes.map((n) => `node ${n.kind} ${n.key} ${n.label}`), ...edges.map((e) => `edge ${e.relation} ${e.src} -> ${e.dst}`)].sort();
}

describe('the index of the Markdown over a filled graph', () => {
  let held: { owner: DatabaseOwner; store: GraphStore };
  let refundKey: string;
  let captureKey: string;
  let at: string;
  const head = (): { commit: string; git: ReturnType<typeof gitReader> } => ({ commit: git('rev-parse', 'HEAD'), git: gitReader(repository) });
  const repositories = (name: string): ReturnType<typeof gitReader> | undefined => (name === 'training' ? gitReader(repository) : undefined);

  beforeAll(async () => {
    held = await openStore('store-a');
    await fill(held);
    refundKey = await keyOf(held.owner, 'code.symbol:src/refund.ts#refund');
    captureKey = await keyOf(held.owner, 'code.symbol:src/refund.ts#capture');
    at = (await GraphView.open(held.owner, held.store)).at;
  }, 300_000);

  test('every grounded sentence is a statement node of its page, with a ground edge per ground', async () => {
    const report = await indexKnowledge(held.owner, held.store, { productId: 'shop', at, pages: pages(refundKey, captureKey), head: head(), repositories });
    expect(report.pages).toBe(2);
    expect(report.statements).toBe(5);
    expect(report.grounds).toBe(7); // refund-decision 2, window 1, capture 2, source-file 1, shop-refunds 1
    expect(report.unresolved).toEqual([]);
    const lines = await dump(held.owner);
    for (const id of ['refund-decision', 'refund-window', 'capture-on-ship', 'source-file']) {
      expect(lines).toContain(`node knowledge:statement statement:domain:refunds#${id} ${id}`);
      expect(lines.some((l) => l.startsWith(`edge knowledge:statement-of statement:domain:refunds#${id} -> page:domain:refunds`))).toBe(true);
    }
    expect(lines.filter((l) => l.startsWith('edge knowledge:grounded-by statement:domain:refunds#refund-decision ')).map((l) => l.split(' ')[4]).sort()).toEqual([refundKey, 'section:docs/requirements.md#uc-1']);
    expect(lines.some((l) => l.startsWith('edge knowledge:mentions page:') || l.startsWith('edge knowledge:mentions statement:product:shop#shop-refunds -> page:domain:refunds'))).toBe(true);
    expect(lines.some((l) => l.startsWith('edge knowledge:relates page:domain:refunds -> '))).toBe(true);
    expect(lines.filter((l) => l.startsWith('node knowledge:section'))).toHaveLength(report.sections);
  });

  test('a second index of the same Markdown writes nothing', async () => {
    const report = await indexKnowledge(held.owner, held.store, { productId: 'shop', at, pages: pages(refundKey, captureKey), head: head(), repositories });
    expect(report.unchanged).toBe(true);
  });

  test('the statements that rely on a function, a file and a document section', async () => {
    const onFunction = await statementsRelyingOn(held.owner, refundKey);
    expect(onFunction.map((s) => [s.page, s.statement, s.how])).toEqual([['domain:refunds', 'refund-decision', 'grounds']]);
    expect(onFunction[0]!.text).toBe('Refunds are decided by one function.');
    expect(onFunction[0]!.file).toBe('docs/domains/refunds.md');
    expect((await statementsRelyingOn(held.owner, 'code.file:src/refund.ts')).map((s) => s.statement)).toEqual(['source-file']);
    expect((await statementsRelyingOn(held.owner, 'doc:docs/requirements.md#uc-1')).map((s) => `${s.page}#${s.statement}`)).toEqual(['domain:refunds#refund-decision', 'product:shop#shop-refunds']);
    expect(await statementsRelyingOn(held.owner, 'code.symbol:src/nothing.ts#none')).toEqual([]);
  });

  test('a page that only names an entity is listed as a mention, not as a ground', async () => {
    const [shop] = await statementsRelyingOn(held.owner, 'domain:refunds');
    expect(shop).toMatchObject({ page: 'product:shop', statement: 'shop-refunds', how: 'mentions' });
  });

  test('counts per page kind', async () => {
    expect(await indexCounts(held.owner)).toEqual([{ kind: 'domain', pages: 1, statements: 4 }, { kind: 'product', pages: 1, statements: 1 }]);
  });

  test('a ground that resolves to nothing makes no edge and is reported with file and line', async () => {
    const text = `---\nid: domain:broken\nkind: domain\n---\nA claim with a broken ground.[^broken]\n\n[^broken]: [x](madarch:code.symbol:src/refund.ts#nope), [y](madarch:doc:docs/requirements.md#no-such-section)\n`;
    const report = await indexKnowledge(held.owner, held.store, { productId: 'shop', at, pages: [...pages(refundKey, captureKey), readIndexedPage('docs/domains/broken.md', text, sha)], head: head(), repositories });
    expect(report.unresolved.map((u) => `${u.file}:${u.line} ${u.target}`)).toEqual([
      'docs/domains/broken.md:5 code.symbol:src/refund.ts#nope',
      'docs/domains/broken.md:5 doc:docs/requirements.md#no-such-section',
    ]);
    expect((await dump(held.owner)).some((l) => l.startsWith('edge knowledge:grounded-by statement:domain:broken#broken '))).toBe(false);
    // back to the good set: the broken page's nodes end
    await indexKnowledge(held.owner, held.store, { productId: 'shop', at, pages: pages(refundKey, captureKey), head: head(), repositories });
    expect((await dump(held.owner)).some((l) => l.includes('domain:broken'))).toBe(false);
  });

  describe('after the repository changes', () => {
    test('nothing has changed at the commit the pages were written at', async () => {
      const changes = await changedGrounds(held.owner, head());
      expect(changes.length).toBe(7);
      expect(changes.every((c) => c.status === 'unchanged')).toBe(true);
    });

    test('a changed section marks its statements; an edit elsewhere in the file leaves a function alone', async () => {
      writeFileSync(path.join(repository, 'docs/requirements.md'), REQUIREMENTS.replace('within 14 days', 'within 30 days').replace('## BR-3 Capture\n', '## BR-4 Archive\n'));
      writeFileSync(path.join(repository, 'src/refund.ts'), SOURCE.replace('return total;', 'return Math.round(total);'));
      dates.next = '2020-01-02T10:00:00Z';
      git('add', '-A');
      git('commit', '-q', '-m', 'second');
      commit2 = git('rev-parse', 'HEAD');
      await fill(held);
      const changes = await changedGrounds(held.owner, head());
      const status = (statement: string, ground: string): string | undefined => changes.find((c) => c.statement === statement && c.ground === ground)?.status;
      expect(status('refund-window', 'doc:docs/requirements.md#br-2')).toBe('changed');
      expect(status('capture-on-ship', 'doc:docs/requirements.md#br-3')).toBe('removed');
      expect(status('refund-decision', 'doc:docs/requirements.md#uc-1')).toBe('unchanged');
      // the function refund is untouched although its file changed; capture changed; the file as a whole changed
      expect(status('refund-decision', refundKey)).toBe('unchanged');
      expect(status('capture-on-ship', captureKey)).toBe('changed');
      expect(status('source-file', 'code.file:src/refund.ts')).toBe('changed');
      const changed = changes.filter((c) => c.status === 'changed' || c.status === 'removed').map((c) => c.statement);
      expect(new Set(changed)).toEqual(new Set(['refund-window', 'capture-on-ship', 'source-file']));
      expect(changes.find((c) => c.statement === 'refund-window')!.writtenCommit).toBe(commit1);
    });

    test('a page of several repositories or none has no digest to compare and says so', async () => {
      const text = `---\nid: domain:loose\nkind: domain\n---\nA loose claim stands here.[^loose-claim]\n\n[^loose-claim]: [UC-1](madarch:doc:docs/requirements.md#uc-1)\n`;
      const atNow = (await GraphView.open(held.owner, held.store)).at;
      await indexKnowledge(held.owner, held.store, { productId: 'shop', at: atNow, pages: [...pages(refundKey, captureKey), readIndexedPage('docs/domains/loose.md', text, sha)], head: head(), repositories });
      const loose = (await changedGrounds(held.owner, head(), { page: 'domain:loose' }))[0]!;
      expect(loose.status).toBe('unknown');
      expect(loose.reason).toContain('no single repository');
    });

    test('rebuilding from the Markdown into a new graph restores the same index', async () => {
      const markdown = [...pages(refundKey, captureKey)];
      const atNow = (await GraphView.open(held.owner, held.store)).at;
      await indexKnowledge(held.owner, held.store, { productId: 'shop', at: atNow, pages: markdown, head: head(), repositories });
      const before = await dump(held.owner);
      const fresh = await openStore('store-b');
      await fill(fresh);
      const freshAt = (await GraphView.open(fresh.owner, fresh.store)).at;
      await indexKnowledge(fresh.owner, fresh.store, { productId: 'shop', at: freshAt, pages: markdown, head: head(), repositories });
      expect(await dump(fresh.owner)).toEqual(before);
      expect(before.length).toBeGreaterThan(20);
      // the digest of a document section is a function of git alone, so the rebuilt index holds the very same one
      const sectionDigests = async (owner: DatabaseOwner): Promise<string[]> => (await owner.run((tx) => tx.query<{ t: string }>(
        `SELECT e.properties->>'target' || ' ' || coalesce(e.properties->>'digest', '-') AS t FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id AND r.key = 'knowledge:grounded-by'
         WHERE e.valid_to = 'infinity' AND e.recorded_to = 'infinity' AND e.properties->>'method' = 'section' ORDER BY 1`,
      ))).rows.map((row) => row.t);
      expect(await sectionDigests(fresh.owner)).toEqual(await sectionDigests(held.owner));
    }, 300_000);
  });
});
