import { expect, test } from 'bun:test';
import { KnowledgeProduct } from '../src/knowledge/product.js';

test('eight polls share the Problems refresh before its reader and key are ready', async () => {
  let opened = 0;
  let keyed = 0;
  let collections = 0;
  let releaseOpen!: () => void;
  let releaseKey!: () => void;
  let releaseListing!: () => void;
  const opening = new Promise<void>((resolve) => { releaseOpen = resolve; });
  const keying = new Promise<void>((resolve) => { releaseKey = resolve; });
  const collecting = new Promise<void>((resolve) => { releaseListing = resolve; });
  const listing = { problems: [], categories: [], sections: { code: 0, documents: 0, wiki: 0 }, open: 0, closed: 0, dismissed: 0, notes: [] };
  const product = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
  Object.assign(product, {
    fill: { state: 'done' }, problemsSequence: 0,
    open: async () => { opened += 1; await opening; return {}; },
    problemsKeySafe: async () => { keyed += 1; await keying; return 'published'; },
    collectProblems: async () => { collections += 1; await collecting; return listing; },
  });
  const refresh = product as unknown as {
    refreshProblems(key: string): void;
    problemsRefresh: Promise<void> | undefined;
    problemsFlight: { promise: Promise<unknown> } | undefined;
  };
  for (let i = 0; i < 8; i += 1) refresh.refreshProblems('before-open');
  expect(opened).toBe(1);
  releaseOpen();
  await opening;
  await Promise.resolve();
  for (let i = 0; i < 8; i += 1) refresh.refreshProblems('before-key');
  expect(keyed).toBe(1);
  releaseKey();
  await keying;
  await Promise.resolve();
  for (let i = 0; i < 8; i += 1) refresh.refreshProblems('published');
  expect(collections).toBe(1);
  releaseListing();
  await refresh.problemsRefresh;
  expect(refresh.problemsFlight).toBeUndefined();
  expect(refresh.problemsRefresh).toBeUndefined();
  refresh.refreshProblems('published');
  expect(opened).toBe(1);
  expect(collections).toBe(1);
});

test('Problems reuse one graph revision across local reader generations but refresh a new graph revision', async () => {
  let collections = 0;
  const product = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
  const listing = { problems: [], categories: [], sections: { code: 0, documents: 0, wiki: 0 }, open: 0, closed: 0, dismissed: 0, notes: [] };
  Object.assign(product, {
    writer: { state: 'idle' }, pins: new Map([['code', { name: 'code', commit: 'commit' }]]),
    reader: { seq: 1 }, problemsSequence: 0,
    collectProblems: async () => { collections += 1; return listing; },
  });
  const cache = product as unknown as {
    reader: { seq: number };
    problemsKey(revision: string): Promise<string>;
    problemsFor(key: string, owner: never): Promise<unknown>;
  };
  const first = await cache.problemsKey('publication:operation8');
  await cache.problemsFor(first, undefined as never);
  cache.reader.seq += 1;
  const reopened = await cache.problemsKey('publication:operation8');
  expect(reopened).toBe(first);
  await cache.problemsFor(reopened, undefined as never);
  expect(collections).toBe(1);
  const changed = await cache.problemsKey('publication:operation9');
  expect(changed).not.toBe(first);
  await cache.problemsFor(changed, undefined as never);
  expect(collections).toBe(2);
});
