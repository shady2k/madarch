import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWikiPart } from '../src/server/wiki-app.js';
import { createDraft } from '../src/product/draft.js';
import { gitEnv } from './git-env.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { openChainIn, advanceChainIn, createRun, readRun, readRuns, advanceRun, readRunUnits, readRunUnitHistory, putFillVertexIn, readUnitGraphUidIn, fillEdge, replaceStaleGenerationIn } from '../src/graph/fill-state.js';
import { createUnit } from './fill-unit-fixture.js';
import { createRecordOwner, recordGraph } from './assertion-record-fixture.js';
import { newUid } from '../src/graph/uid.js';
import { readKindAssertions } from '../src/graph/records.js';
import { readFillRunDetail } from '../src/knowledge/fill-runs.js';
import { failRequestedFill } from '../src/knowledge/fill-run.js';
import { writeOrchestration, readFillEnd, writeFillEnd } from '../src/graph/fill-orchestration.js';
import { recordUnitPlanIn } from '../src/graph/fill-orchestration.js';
import type { KindDecl, PluginDecl, KindsManifest } from '../src/product/manifest/kinds.js';
import { pluginsFillingKind } from '../src/fill/plugin-turns.js';
import { parsePluginManifest } from '../src/plugin/closure.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { createKnowledgePart } from '../src/server/knowledge.js';
let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>;
beforeAll(async () => { owner = await createTestDatabaseOwner(); });
afterAll(async () => { await owner?.close(); });
test('a requested selection survives planning and is read by exact durable run id without a trace', async () => {
  await createRun(owner, { runId: 'requested', product: 'shop', at: 1000, selection: { selected: ['docs'], order: ['doc.term'] } });
  await advanceRun(owner, { runId: 'requested', event: { type: 'plan', at: 1100, configuration: 'fixture' } });
  expect((await readRun(owner, 'requested'))?.context.selection).toEqual({ selected: ['docs'], order: ['doc.term'], groups: [] });
  const detail = await readFillRunDetail(owner, 'requested', { now: 2000 });
  expect(detail).toMatchObject({ runId: 'requested', state: 'planning', selected: ['docs'], order: ['doc.term'], elapsedMs: 1000, remainingMs: null, records: 0, events: [], units: [] });
  expect(await readFillRunDetail(owner, 'missing', { now: 2000 })).toBeNull();
});
test('history orders canonical rows newest first and isolates the product', async () => {
  await createRun(owner, { runId: 'newer', product: 'shop', at: 3000 });
  await createRun(owner, { runId: 'other', product: 'elsewhere', at: 4000 });
  expect((await readRuns(owner, 'shop')).map((row) => row.runId)).toEqual(['newer', 'requested']);
});

test('named run keeps generations after replacement and derives real facts, groups and measured ETA', async () => {
  const selection = { selected: ['doc.term'], order: ['doc.term'], groups: [{ kind: 'doc.term', group: 'docs', plugin: 'terms', stageUnitId: 'terms:doc.term' }] };
  await createRun(owner, { runId: 'history', product: 'shop', at: 1000, selection });
  await advanceRun(owner, { runId: 'history', event: { type: 'plan', at: 1001, configuration: 'fixture' } });
  await advanceRun(owner, { runId: 'history', event: { type: 'start', at: 1002, stages: 2 } });
  for (const [unitId, stageUnitId, scopeKey] of [['terms-unit', 'terms:doc.term', 'doc.term'], ['remaining-unit', 'remaining', 'code.file']]) {
    await createUnit(owner, { unitId: unitId!, product: 'shop', runId: 'history', stageId: 'fixture-stage', scopeKey: scopeKey!, inputsDigest: 'fixture', retries: 0, at: 1003 });
    await writeOrchestration(owner, tx => recordUnitPlanIn(tx, { unitId: unitId!, generation: 1, runId: 'history', stageId: 'fixture-stage', stageUnitId: stageUnitId!, scope: scopeKey!, stagePosition: 0, planPosition: 0, at: 1003 }));
  }
  await owner.transaction('write', async (tx) => {
    const unitUid = await readUnitGraphUidIn(tx, 'terms-unit', 1);
    if (unitUid === undefined) throw new Error('fixture unit is absent');
    await putFillVertexIn(tx, 'system.unit', unitUid, { state: 'published', published_at: 1500, produced: 7 });
    const operationUid = newUid();
    await putFillVertexIn(tx, 'system.operation', operationUid, { key: 'complete', digest: 'fixture' }, [
      fillEdge('system.operation-unit', 'system.operation', operationUid, 'system.unit', unitUid),
    ]);
  });
  const detail = await readFillRunDetail(owner, 'history', { now: 2000 });
  expect(detail).toMatchObject({ records: 7, publishedUnits: 1, elapsedMs: 1000, remainingMs: 1000, phase: 'running', final: false, groups: [{ kind: 'doc.term', group: 'docs', plugin: 'terms', done: 1, total: 1, state: 'published', phase: 'done' }] });
  // A subsequent generation owns the unit's current pointer. History still reads this run's generation.
  await owner.transaction('write', async (tx) => {
    const unitUid = await readUnitGraphUidIn(tx, 'terms-unit', 1);
    if (unitUid === undefined) throw new Error('fixture unit is absent');
    await putFillVertexIn(tx, 'system.unit', unitUid, { state: 'stale', stale_at: 3000 });
  });
  expect((await writeOrchestration(owner, tx => replaceStaleGenerationIn(tx, { unitId: 'terms-unit', runId: 'newer', inputsDigest: 'fixture', retries: 0, at: 3000 }))).ok).toBe(true);
  expect((await readRunUnitHistory(owner, 'history')).map((unit) => unit.unitId)).toContain('terms-unit');
  expect((await readRunUnits(owner, 'history')).map((unit) => unit.unitId)).not.toContain('terms-unit');
  expect((await readFillRunDetail(owner, 'history', { now: 2000 }))?.selected).toEqual(['doc.term']);

});
test('a stale historical scoped control cannot pause or stop a newer run', async () => {
  await createRun(owner, { runId: 'old-finished', product: 'shop', at: 5000 });
  await advanceRun(owner, { runId: 'old-finished', event: { type: 'fail', at: 5001, cause: 'initialization-failed', detail: 'fixture' } });
  const product = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
  Object.assign(product, { listeners: new Set(), revision: 0, open: async () => owner, product: () => ({ name: 'shop' }) });
  for (const action of ['pause', 'stop'] as const) {
    expect(await product.controlFillRun('old-finished', action)).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/product\.ts:\d+:/) });
  }
  const rows = await owner.transaction('snapshot', async (tx) => readKindAssertions(tx, 'vertex', 'system.run', ['control_action'], { contract: owner.graphContract }));
  expect(rows.filter(row => row.values['control_action'] !== undefined)).toEqual([]);
  const foreignProduct = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
  Object.assign(foreignProduct, { listeners: new Set(), revision: 0, open: async () => owner, product: () => ({ name: 'not-shop' }) });
  expect(await foreignProduct.controlFillRun('history', 'stop')).toMatchObject({ ok: false, status: 404 });
});

test('native scoped stop requires confirmation before invoking control', async () => {
  let calls = 0;
  const product = { folder: '/tmp/scoped-fill-control-fixture', controlFillRun: async () => { calls += 1; return { ok: true, runId: 'named' }; } } as unknown as KnowledgeProduct;
  const part = createKnowledgePart({ json: (status, body) => Response.json(body, { status }), refused: (status, error) => ({ response: Response.json({ error }, { status }) }), errorLog: () => undefined }, product, () => []);
  const request = (confirm: boolean) => new Request('http://wiki.test/api/stop?run=named', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm }) });
  const refused = await part.stop(request(false));
  expect(refused.response.status).toBe(409);
  expect((await refused.response.json()).error.message).toMatch(/knowledge\.ts:[1-9][0-9]+:/);
  expect(calls).toBe(0);
  expect((await part.stop(request(true))).response.status).toBe(200);
  expect(calls).toBe(1);
});

test('paused Stop after worker exit uses canonical cancellation without loading product files or plugins', async () => {
  await createRun(owner, { runId: 'paused-run', product: 'shop', at: 7000, selection: { selected: ['doc.term'], order: ['doc.term'], groups: [{ kind: 'doc.term', group: null, plugin: 'fixture', stageUnitId: 'fixture-stage' }] } });
  await advanceRun(owner, { runId: 'paused-run', event: { type: 'plan', at: 7001, configuration: 'fixture' } });
  await advanceRun(owner, { runId: 'paused-run', event: { type: 'start', at: 7002, stages: 1 } });
  await createUnit(owner, { unitId: 'paused-unfinished', product: 'shop', runId: 'paused-run', stageId: 'fixture-stage', scopeKey: 'fixture', inputsDigest: 'fixture', retries: 0, at: 7003 });
  await writeOrchestration(owner, tx => recordUnitPlanIn(tx, { runId: 'paused-run', unitId: 'paused-unfinished', generation: 1, stageId: 'fixture-stage', stageUnitId: 'fixture-stage', scope: 'fixture', stagePosition: 0, planPosition: 0, at: 7003 }));
  await advanceRun(owner, { runId: 'paused-run', event: { type: 'pause', at: 7004 } });
  await advanceRun(owner, { runId: 'paused-run', event: { type: 'drain', at: 7005, evidence: { runnable: 1, inFlight: 0, waiting: 0, coverageMet: true } } });
  expect((await readRun(owner, 'paused-run'))?.state).toBe('paused');
  const product = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
  Object.assign(product, { listeners: new Set(), revision: 0, open: async () => owner, product: () => ({ name: 'shop' }) });
  let domainReads = 0;
  Object.assign(product, {
    fillDatabase: async () => { domainReads += 1; return owner; },
    manifestRead: async () => { throw new Error('paused Stop must not load product files'); },
  });
  expect(await product.controlFillRun('paused-run', 'stop')).toMatchObject({ ok: true, runId: 'paused-run' });
  expect(domainReads).toBe(1);
  expect((await readRun(owner, 'paused-run'))?.state).toBe('cancelled');
  expect((await readRunUnits(owner, 'paused-run'))[0]?.state).toBe('cancelled');
  const detail = await readFillRunDetail(owner, 'paused-run', { now: Date.now() });
  expect(detail?.events.map((event) => event.type)).toContain('run-cancelled');
  expect(detail?.remainingMs).toBeNull();
  expect(detail).toMatchObject({ phase: 'stopped', final: true, groups: [{ state: 'cancelled', phase: 'cancelled' }] });
});

test('initialization failure settles a precreated request and writes the end awaited by the API', async () => {
  await createRun(owner, { runId: 'init-failed', product: 'shop', at: 9000, selection: { selected: ['doc.term'], order: ['doc.term'] } });
  expect(await failRequestedFill(owner, 'init-failed', 'fixture failure')).toBe(true);
  expect((await readRun(owner, 'init-failed'))?.state).toBe('failed');
  expect((await readFillEnd(owner, 'init-failed'))?.state).toBe('failed');
  expect(await failRequestedFill(owner, 'history', 'must not replace running run')).toBe(false);
  expect((await readRun(owner, 'history'))?.state).toBe('running');
  const raced = await advanceRun(owner, { runId: 'history', expectedState: 'created', event: { type: 'fail', at: 9001, cause: 'initialization-failed', detail: 'late initialization error' } });
  expect(raced.ok).toBe(false);
  expect((await readRun(owner, 'history'))?.state).toBe('running');
});
test('global status follows canonical paused then stopped state rather than stale local failure', async () => {
  await createRun(owner, { runId: 'status-paused', product: 'status-shop', at: 10000 });
  await advanceRun(owner, { runId: 'status-paused', event: { type: 'plan', at: 10001, configuration: 'fixture' } });
  await advanceRun(owner, { runId: 'status-paused', event: { type: 'start', at: 10002, stages: 1 } });
  await advanceRun(owner, { runId: 'status-paused', event: { type: 'pause', at: 10003 } });
  await advanceRun(owner, { runId: 'status-paused', event: { type: 'drain', at: 10004, evidence: { runnable: 0, inFlight: 0, waiting: 0, coverageMet: true } } });
  const product = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
  Object.assign(product, { listeners: new Set(), revision: 0, reader: { owner, seq: 0 }, fill: { state: 'failed' }, fillRunId: 'status-paused', product: () => ({ name: 'status-shop' }), loadPins: async () => undefined, warmReader: async () => undefined, open: async () => owner });
  await (product as any).followStoreFill();
  expect((product as any).fill).toMatchObject({ runId: 'status-paused', state: 'paused' });
  Object.assign(product, {
    fillDatabase: async () => owner,
    manifestRead: async () => { throw new Error('paused Stop must not load product files'); },
  });
  await product.controlFillRun('status-paused', 'stop');
  await (product as any).followStoreFill();
  expect((product as any).fill).toMatchObject({ runId: 'status-paused', state: 'stopped' });
  await createRun(owner, { runId: 'status-newer', product: 'status-shop', at: 11000 });
  await advanceRun(owner, { runId: 'status-newer', event: { type: 'fail', at: 11001, cause: 'initialization-failed', detail: 'newer failed between polls' } });
  await writeFillEnd(owner, { runId: 'status-newer', state: 'failed', message: 'newer failed between polls' });
  Object.assign(product, { listeners: new Set(), revision: 0, options: {}, notify: () => undefined, published: async () => undefined, unreadOf: () => [] });
  await (product as any).followStoreFill();
  expect((product as any).fillRunId).toBe('status-newer');
  expect((product as any).fill).toMatchObject({ state: 'failed', message: 'newer failed between polls' });

});

test('held chain remains canonical global status when a later request is refused', async () => {
  await writeOrchestration(owner, tx => openChainIn(tx, { product: 'held-shop', at: 12000 }));
  await createRun(owner, { runId: 'held-paused', product: 'held-shop', at: 12000 });
  await writeOrchestration(owner, tx => advanceChainIn(tx, { product: 'held-shop', event: { type: 'start', runId: 'held-paused', at: 12001 } }));
  await advanceRun(owner, { runId: 'held-paused', event: { type: 'plan', at: 12002, configuration: 'fixture' } });
  await advanceRun(owner, { runId: 'held-paused', event: { type: 'start', at: 12003, stages: 1 } });
  await advanceRun(owner, { runId: 'held-paused', event: { type: 'pause', at: 12004 } });
  await advanceRun(owner, { runId: 'held-paused', event: { type: 'drain', at: 12005, evidence: { runnable: 0, inFlight: 0, waiting: 0, coverageMet: true } } });
  await writeOrchestration(owner, tx => advanceChainIn(tx, { product: 'held-shop', event: { type: 'settle', at: 12006, evidence: { runnable: 1, inFlight: 0, waiting: 0 } } }));
  await createRun(owner, { runId: 'held-refused', product: 'held-shop', at: 13000 });
  await failRequestedFill(owner, 'held-refused', 'chain held');
  const product = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
  Object.assign(product, { listeners: new Set(), revision: 0, reader: { owner, seq: 0 }, fill: { state: 'failed' }, fillRunId: 'held-refused', product: () => ({ name: 'held-shop' }), loadPins: async () => undefined, warmReader: async () => undefined });
  await (product as any).followStoreFill();
  expect((product as any).fill).toMatchObject({ runId: 'held-paused', state: 'paused' });
});

test('a locally queued request does not adopt the previous chain run before its worker claims it', async () => {
  await writeOrchestration(owner, tx => openChainIn(tx, { product: 'queued-status-shop', at: 14000 }));
  await createRun(owner, { runId: 'queued-previous', product: 'queued-status-shop', at: 14000 });
  await writeOrchestration(owner, tx => advanceChainIn(tx, { product: 'queued-status-shop', event: { type: 'start', runId: 'queued-previous', at: 14001 } }));
  await createRun(owner, { runId: 'queued-request', product: 'queued-status-shop', at: 15000 });
  const product = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
  Object.assign(product, {
    listeners: new Set(), revision: 0,
    reader: { owner, seq: 0 }, fill: { state: 'running', runId: 'queued-request' }, fillRunId: 'queued-request',
    running: new Promise<void>(() => {}), product: () => ({ name: 'queued-status-shop' }),
    loadPins: async () => undefined, warmReader: async () => undefined,
  });
  await (product as any).followStoreFill();
  expect((product as any).fillRunId).toBe('queued-request');
  expect((product as any).fill).toMatchObject({ state: 'running', runId: 'queued-request' });
});

test('starting a new request does not expose the previous run id while opening the store', async () => {
  const work = mkdtempSync(join(tmpdir(), 'fill-run-start-'));
  const draft = createDraft({ home: join(work, 'home'), name: 'starting-shop', gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error('fixture draft was not created');
  // The press starts deterministically: the repository producers alone fill the kinds the product keeps.
  useFixturePlugins(draft.folder, ['disk', 'git']);
  const product = new KnowledgeProduct({ productFolder: draft.folder, storeRoot: join(work, 'store'), fillQueued: true });
  let release: () => void = () => {};
  const opening = new Promise<void>((resolve) => { release = resolve; });
  let observe: () => void = () => {};
  const opened = new Promise<void>((resolve) => { observe = resolve; });
  Object.assign(product, {
    fill: { state: 'done' }, fillRunId: 'previous-start',
    open: async () => { observe(); await opening; return owner; },
    runQueuedFill: async () => undefined,
  });
  try {
    const starting = product.startFill();
    await opened;
    expect((product as any).fill).toMatchObject({ state: 'done' });
    release();
    const result = await starting;
    expect(result.started).toBe(true);
    if (result.started) expect(result.fill).toMatchObject({ state: 'running', runId: result.runId });
  } finally {
    release();
    await product.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test('run selection discovers declared agent producers rather than catalogue capability', () => {
  const kind = { name: 'probe.summary', fields: [{ name: 'id', type: 'text' }] } as unknown as KindDecl;
  const declaration = (name: string, output: string) => parsePluginManifest(JSON.stringify({
    name, version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version },
    agent: { prompt: 'Fill the declared output.', roots: ['product'], catalogue: true },
    produces: [{ kind: output, fields: ['id'], reads: [] }],
  }), `/product/plugins/${name}/plugin.json`);
  const capability = { vertices: [{ kind: kind.name }], agent: { catalogue: true } };
  const agent = { id: 'agent-fill', contract: capability, declaration: declaration('agent-fill', kind.name) } as unknown as PluginDecl;
  const unrelated = { id: 'unrelated', contract: capability, declaration: declaration('unrelated', 'other') } as unknown as PluginDecl;
  expect(pluginsFillingKind({ kinds: new Map([[kind.name, kind]]), plugins: new Map([[agent.id, agent], [unrelated.id, unrelated]]) } as unknown as KindsManifest, kind.name)).toEqual(['agent-fill']);
});

test('native app serves a fill run as a template page with its run in the address, and no page-layer path', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'fill-run-route-'));
  try {
    writeFileSync(join(folder, 'index.html'), '<!doctype html><title>fill run fixture</title>');
    const part = createWikiPart((status, body) => Response.json(body, { status }), (status, error) => ({ response: Response.json({ error }, { status }) }), { revision: () => '', subscribe: () => () => undefined }, folder);
    // A fill run is a template bound to no entity (decision 0036, section 7): `/p/run` with the run in a variable.
    const direct = part.app('/p/run?run=fill-20261112T175127529Z');
    expect(direct?.response.status).toBe(200);
    expect(direct?.response.headers.get('content-type')).toContain('text/html');
    expect(await direct?.response.text()).toContain('fill run fixture');
    expect(part.app('/fill/unrelated')?.response.status).toBe(404);
    expect(part.app('/fill/runs/id/unrelated')?.response.status).toBe(404);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('one run reads the agent exchanges madarch kept beside its trace', async () => {
  const store = mkdtempSync(join(tmpdir(), 'madarch-run-exchanges-'));
  try {
    await createRun(owner, { runId: 'agent-run', product: 'shop', at: 6100 });
    const { AgentExchangeRecorder } = await import('../src/fill/agent-exchange.js');
    const recorder = new AgentExchangeRecorder({ folder: join(store, 'traces', 'agent-run.agents'), run: 'agent-run', unit: 'agent-fill:doc.term', agent: 'fixture-agent' });
    recorder.setGiven({ prompt: 'Fill the term from its documents.', task: { kind: 'doc.term' }, files: ['repo/docs/a.md'] });
    recorder.answer('{"vertices":[],"end":{"state":"complete"}}', 'end_turn');
    recorder.finish();
    const product = Object.create(KnowledgeProduct.prototype) as KnowledgeProduct;
    Object.assign(product as unknown as Record<string, unknown>, {
      open: async () => owner, product: () => ({ name: 'shop' }), runViewOf: async () => undefined, storeFolder: () => store, options: {},
    });
    const runs = await product.fillRuns('agent-run');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe('agent-run');
    expect(runs[0]?.agentExchanges).toMatchObject([{ unit: 'agent-fill:doc.term', agent: 'fixture-agent', state: 'turned', given: { files: ['repo/docs/a.md'] } }]);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

/**
 * What a run wrote, in entities (madarch-64o5.106): a vertex the run's own assertions brought into the graph is created,
 * one that stood before the run and whose fields the run changed is updated, and one the run re-asserted unchanged is
 * neither. The fixture writes through a unit's own capability, the lineage the plugin host binds, so the read sees the
 * same `system.assertion-unit` edges a real fill leaves. A unit's own name is the stage's path and the plan's unit id
 * (`plugin-turns/disk:code.file`), and a plan's unit id may name a file (`...@docs/domains/one.md`), so the plugin is cut
 * at the stage's prefix and never at the last `/`. The boundary between created and updated is the run's own line in the
 * store, so a live run whose finished groups recorded after its last state change still reads them.
 */
test('entity counts name what a run created and what it changed, whatever the stage path and the host clock', async () => {
  const counted = await createRecordOwner();
  try {
    const { bindTestWriteCapability } = await import('./write-capability-fixture.js');
    const { bindWriteCapability, publishGraphDrafts } = await import('../src/graph/write.js');
    const { readRunEntityCounts } = await import('../src/graph/fill-orchestration.js');
    const at = Date.now() - 60_000;
    /** One file entity as a unit writes it: its fields, through the unit's own write capability. */
    const write = async (unitId: string, path: string, lines: number): Promise<void> => {
      const unitUid = await counted.transaction('snapshot', async (tx) => await readUnitGraphUidIn(tx, unitId, 1));
      if (unitUid === undefined) throw new Error(`the fixture unit ${unitId} is absent`);
      await counted.transaction('write', async (tx) => {
        const binding = await bindTestWriteCapability(tx, recordGraph);
        bindWriteCapability(tx, { ...binding, unitUid });
        await publishGraphDrafts(tx, recordGraph, { vertices: [{ kind: 'code.file', key: { path }, values: { lines }, producer: 'disk', producerVersion: '1' }], removals: [] });
      });
    };
    // A file that stood before the run: a run of its own wrote it, and the counted run opens afterwards.
    await createRun(counted, { runId: 'prior', product: 'shop', at });
    await advanceRun(counted, { runId: 'prior', event: { type: 'plan', at: at + 1, configuration: 'fixture' } });
    await createUnit(counted, { unitId: 'plugin-turns/disk:code.file', product: 'shop', runId: 'prior', stageId: 'plugin-turns', scopeKey: 'first', inputsDigest: 'fixture', retries: 0, at: at + 2 });
    await write('plugin-turns/disk:code.file', 'docs/domains/one.md', 1);
    expect(await readRunEntityCounts(counted, 'prior')).toEqual([{ plugin: 'disk', kind: 'code.file', created: 1, updated: 0 }]);
    // The counted run stays live: its own state last moved a minute ago, and everything it writes records after that.
    await createRun(counted, { runId: 'counted', product: 'shop', at });
    await advanceRun(counted, { runId: 'counted', event: { type: 'plan', at: at + 1, configuration: 'fixture' } });
    await advanceRun(counted, { runId: 'counted', event: { type: 'start', at: at + 2, stages: 1 } });
    await createUnit(counted, { unitId: 'plugin-turns/disk:code.file@docs/domains/two.md', product: 'shop', runId: 'counted', stageId: 'plugin-turns', scopeKey: 'second', inputsDigest: 'fixture', retries: 0, at: at + 3 });
    await writeOrchestration(counted, tx => recordUnitPlanIn(tx, { runId: 'counted', unitId: 'plugin-turns/disk:code.file@docs/domains/two.md', generation: 1, stageId: 'plugin-turns', stageUnitId: 'disk:code.file', scope: 'second', stagePosition: 0, planPosition: 0, at: at + 3 }));
    await write('plugin-turns/disk:code.file@docs/domains/two.md', 'docs/domains/two.md', 2);
    await write('plugin-turns/disk:code.file@docs/domains/two.md', 'docs/domains/one.md', 3);
    expect(await readRunEntityCounts(counted, 'counted')).toEqual([{ plugin: 'disk', kind: 'code.file', created: 1, updated: 1 }]);
    // The same values again are a repeat of what stands: the run changes nothing, and the counts say so.
    await write('plugin-turns/disk:code.file@docs/domains/two.md', 'docs/domains/two.md', 2);
    await write('plugin-turns/disk:code.file@docs/domains/two.md', 'docs/domains/one.md', 3);
    expect(await readRunEntityCounts(counted, 'counted')).toEqual([{ plugin: 'disk', kind: 'code.file', created: 1, updated: 1 }]);
    // The run's own detail carries the same read, and its list entry spends nothing on entities.
    const detail = await readFillRunDetail(counted, 'counted', { now: Date.now(), detail: true });
    expect(detail?.entities).toEqual([{ plugin: 'disk', kind: 'code.file', created: 1, updated: 1 }]);
    expect(detail?.outcomes).toEqual([]);
    expect((await readFillRunDetail(counted, 'counted', { now: Date.now() }))?.entities).toBeUndefined();
  } finally { await counted.close(); }
});

/**
 * A run that repeats values which already stand writes no assertion of its own: the writer reuses the standing one, and
 * each unit's `system.assertion-unit` lineage then names an assertion recorded before the run's line. That lineage is
 * not the run's work, so a repeat over unchanged entities says it wrote nothing, never «изменено 2»
 * (madarch-64o5.106).
 */
test('a run that repeats values that already stand counts nothing, because its units bound no fresh assertion', async () => {
  const counted = await createRecordOwner();
  try {
    const { bindTestWriteCapability } = await import('./write-capability-fixture.js');
    const { bindWriteCapability, publishGraphDrafts } = await import('../src/graph/write.js');
    const { readRunEntityCounts } = await import('../src/graph/fill-orchestration.js');
    const at = Date.now() - 60_000;
    /** The files one unit writes, through the unit's own write capability, as a plugin host binds it. */
    const write = async (unitId: string, files: readonly { path: string; lines: number }[]): Promise<void> => {
      const unitUid = await counted.transaction('snapshot', async (tx) => await readUnitGraphUidIn(tx, unitId, 1));
      if (unitUid === undefined) throw new Error(`the fixture unit ${unitId} is absent`);
      await counted.transaction('write', async (tx) => {
        const binding = await bindTestWriteCapability(tx, recordGraph);
        bindWriteCapability(tx, { ...binding, unitUid });
        await publishGraphDrafts(tx, recordGraph, { vertices: files.map((file) => ({ kind: 'code.file', key: { path: file.path }, values: { lines: file.lines }, producer: 'disk', producerVersion: '1' })), removals: [] });
      });
    };
    // Two files that stood before the repeat run: the first run wrote them.
    await createRun(counted, { runId: 'prior', product: 'shop', at });
    await advanceRun(counted, { runId: 'prior', event: { type: 'plan', at: at + 1, configuration: 'fixture' } });
    await advanceRun(counted, { runId: 'prior', event: { type: 'start', at: at + 2, stages: 1 } });
    await createUnit(counted, { unitId: 'plugin-turns/disk:code.file', product: 'shop', runId: 'prior', stageId: 'plugin-turns', scopeKey: 'first', inputsDigest: 'fixture', retries: 0, at: at + 3 });
    await write('plugin-turns/disk:code.file', [{ path: 'docs/domains/one.md', lines: 3 }, { path: 'docs/domains/two.md', lines: 2 }]);
    expect(await readRunEntityCounts(counted, 'prior')).toEqual([{ plugin: 'disk', kind: 'code.file', created: 2, updated: 0 }]);
    // The repeat run opens afterwards and asks for the same values: nothing it writes is its own work.
    await createRun(counted, { runId: 'repeat', product: 'shop', at: at + 10 });
    await advanceRun(counted, { runId: 'repeat', event: { type: 'plan', at: at + 11, configuration: 'fixture' } });
    await advanceRun(counted, { runId: 'repeat', event: { type: 'start', at: at + 12, stages: 1 } });
    await createUnit(counted, { unitId: 'plugin-turns/disk:code.file@repeat', product: 'shop', runId: 'repeat', stageId: 'plugin-turns', scopeKey: 'repeat', inputsDigest: 'fixture', retries: 0, at: at + 13 });
    await writeOrchestration(counted, (tx) => recordUnitPlanIn(tx, { runId: 'repeat', unitId: 'plugin-turns/disk:code.file@repeat', generation: 1, stageId: 'plugin-turns', stageUnitId: 'disk:code.file', scope: 'repeat', stagePosition: 0, planPosition: 0, at: at + 13 }));
    await write('plugin-turns/disk:code.file@repeat', [{ path: 'docs/domains/one.md', lines: 3 }, { path: 'docs/domains/two.md', lines: 2 }]);
    expect(await readRunEntityCounts(counted, 'repeat')).toEqual([]);
  } finally { await counted.close(); }
});
