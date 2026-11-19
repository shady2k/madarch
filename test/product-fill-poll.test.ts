import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { createRun, advanceRun } from '../src/graph/fill-state.js';
import { appendProgress, writeFillEnd } from '../src/graph/fill-orchestration.js';
import { publishValidatedManifests, validateProductManifests, readPublishedManifest } from '../src/graph/manifest-publication.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { openTrace, runInTrace, closeTrace } from '../src/obs/trace.js';
import { prepareTestProduct } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import type { ChangeNotice } from '../src/knowledge/model.js';

let root: string;
let reader: KnowledgeProduct;
let owner: DatabaseOwner;
let release: () => Promise<void>;
let database: import('../src/graph/fill-state.js').FillStateDatabase;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-fill-poll-'));
  const home = join(root, 'products'), storeRoot = join(root, 'stores');
  const draft = createDraft({ home, name: 'poll', gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  release = await prepareTestProduct(draft.folder, home, storeRoot);
  reader = new KnowledgeProduct({ productFolder: draft.folder, storeRoot });
  owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(draft.folder, storeRoot)), connectOnly: true });
  const validated = validateProductManifests(draft.folder);
  if (!validated.ok || validated.value === undefined) throw new Error('fixture manifest validation failed');
  await publishValidatedManifests(owner, validated.value);
  const manifest = await owner.run(tx => readPublishedManifest(tx));
  if (manifest === undefined) throw new Error('fixture published manifest missing');
  database = { transaction: owner.transaction.bind(owner), graphContract: withAssertionContract(withManifestContract(graphContractOf(manifest))) };
}, 120_000);
afterAll(async () => {
  await reader?.close(); await owner?.close(); await release?.();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

test('unchanged active and settled status polls read no assertions, while run and progress writes invalidate them', async () => {
  const notices: ChangeNotice[] = [];
  const unsubscribe = reader.changes.subscribe(notice => notices.push(notice));
  let traceIndex = 0;
  async function unchangedPoll() {
    const trace = openTrace({ store: join(root, 'poll-traces'), runId: `poll-${String(traceIndex++)}`, console: false });
    try { await runInTrace(trace, () => reader.status()); } finally { closeTrace(trace); }
    const spans = readFileSync(trace.file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { name: string });
    expect(spans.filter(span => ['graph.records.batch', 'graph.assertions.read'].includes(span.name)).map(span => span.name)).toEqual([]);
  }
  try {
    await reader.status();
    await createRun(database, { runId: 'first', product: 'poll', at: 100 });
    expect((await reader.status()).fill.run).toMatchObject({ runId: 'first', state: 'created' });
    await unchangedPoll();
    await advanceRun(database, { runId: 'first', event: { type: 'plan', at: 101, configuration: 'fixture' } });
    expect((await reader.status()).fill.run?.state).toBe('planning');
    notices.length = 0;
    await appendProgress(database, { runId: 'first', at: 102, stage: '', unitId: 'kind:note', generation: null, kind: 'unit-published', summary: 'published 3 facts' });
    await reader.status();
    expect(notices).toContainEqual(expect.objectContaining({ kinds: ['note'], facts: 3 }));
    await unchangedPoll();
    await advanceRun(database, { runId: 'first', event: { type: 'start', at: 103, stages: 1 } });
    await advanceRun(database, { runId: 'first', event: { type: 'complete', at: 104, evidence: { runnable: 0, inFlight: 0, waiting: 0, coverageMet: true } } });
    await writeFillEnd(database, { runId: 'first', state: 'succeeded' });
    expect((await reader.status()).filled).toBe(true);
    await unchangedPoll();
    await createRun(database, { runId: 'second', product: 'poll', at: 200 });
    expect(await reader.runView()).toMatchObject({ runId: 'second', state: 'created' });
    expect((await reader.status()).fill.run?.runId).toBe('second');
    await unchangedPoll();
  } finally { unsubscribe(); }
}, 60_000);

test('optional producer outcome read failure does not fail status or poison its next poll', async () => {
  const transaction = owner.transaction.bind(owner);
  const queryFault: DatabaseOwner = Object.create(owner) as DatabaseOwner;
  queryFault.transaction = (kind, work, options) => transaction(kind, tx => work({
    ...tx,
    query: (sql, values) => {
      if (values?.[0] === 'system.unit-run') throw new Error('fixture optional outcomes unavailable');
      return tx.query(sql, values);
    },
  }), options);
  const cached = reader as unknown as { reader: { owner: DatabaseOwner; seq: number }; fillStateMemo: unknown };
  const original = cached.reader;
  cached.reader = { ...original, owner: queryFault };
  cached.fillStateMemo = undefined;
  try {
    expect((await reader.status()).fill.run?.runId).toBe('second');
  } finally { cached.reader = original; cached.fillStateMemo = undefined; }
  expect((await reader.status()).fill.run?.runId).toBe('second');
}, 60_000);

for (const terminal of ['completed_partial', 'blocked'] as const) {
  test(`status follows another process's ${terminal} end`, async () => {
    await createRun(database, { runId: terminal, product: 'poll', at: terminal === 'completed_partial' ? 300 : 400 });
    await advanceRun(database, { runId: terminal, event: { type: 'plan', at: 401, configuration: 'fixture' } });
    await advanceRun(database, { runId: terminal, event: { type: 'start', at: 402, stages: 1 } });
    expect((await reader.status()).fill.state).toBe('running');
    await advanceRun(database, { runId: terminal, event: terminal === 'completed_partial'
      ? { type: 'complete-partial', at: 403, evidence: { runnable: 0, inFlight: 0, waiting: 0, coverageMet: false } }
      : { type: 'block', at: 403, starvationPath: 'consumer → capability → producer' } });
    await writeFillEnd(database, { runId: terminal, state: terminal });
    expect((await reader.status()).fill).toMatchObject({ state: 'failed', runPhase: terminal === 'completed_partial' ? 'partial' : 'failed' });
  }, 60_000);
}
