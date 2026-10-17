import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFillEventAtomic, consumeFillControl, countFillUnits, createFillFileStore, createFillRun, createFillUnit, fillInputsMatch, hashFillInputs, orchestrateFillUnits, reconcileFillUnit, writeFillJsonAtomic, type FillEvent, type FillUnit, type FillUnitPlan } from '../src/product/fill-runtime.js';

const plan = (id: string, stage: FillUnitPlan['stage'], inputHashes: Record<string, string>, dependencies: string[] = []): FillUnitPlan => ({ id, stage, inputHashes, outputPaths: [`outputs/${id}.json`], dependencies });
const run = createFillRun({ productSnapshot: { repository: '/product', defaultBranch: 'main', commit: 'abc123', registryHash: 'registry' }, agentBranch: 'madarch/fill/run' }, 'run-1');
const hooks = (extra: Partial<import('../src/product/fill-runtime.js').FillOrchestrationHooks> = {}) => ({ lastEventSequence: async () => 0, persistRun: async () => undefined, refreshInputs: async () => ({}), commitStage: async () => 'clean' as const, ...extra });

describe('fill runtime contract', () => {
  test('pins stage order and hashes named inputs deterministically', () => {
    expect(hashFillInputs({ registry: 'registry bytes', tree: 'tree bytes' })).toEqual(hashFillInputs({ tree: 'tree bytes', registry: 'registry bytes' }));
    expect(fillInputsMatch({ tree: 'a', registry: 'b' }, { registry: 'b', tree: 'a' })).toBe(true);
    expect(fillInputsMatch({ tree: 'a' }, { tree: 'changed' })).toBe(false);
  });

  test('requeues interrupted work and marks only changed completed inputs stale', () => {
    const base = createFillUnit(plan('inventory', 'inventory', { tree: 'old', registry: 'same' }));
    const complete: FillUnit = { ...base, status: 'complete', attempt: 1 };
    const interrupted: FillUnit = { ...base, status: 'running', attempt: 2 };
    expect(reconcileFillUnit(complete, { tree: 'old', registry: 'same' }).status).toBe('complete');
    expect(reconcileFillUnit(complete, { tree: 'new', registry: 'same' }).status).toBe('stale');
    expect(reconcileFillUnit(interrupted, { tree: 'old', registry: 'same' }).status).toBe('pending');
    expect(reconcileFillUnit(complete, { tree: 'old', registry: 'changed' }).status).toBe('stale');
  });

  test('writes complete JSON atomically and reads a valid record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'madarch-fill-'));
    try {
      const file = join(dir, '.madarch', 'fill', 'run.json');
      await writeFillJsonAtomic(file, run);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(run);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('persists a run manifest and stable-id unit records under .madarch/fill', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'madarch-fill-records-'));
    try {
      const unit = createFillUnit(plan('unit-01', 'inventory', { tree: 'hash' }));
      await writeFillJsonAtomic(join(dir, '.madarch', 'fill', 'run.json'), run);
      await writeFillJsonAtomic(join(dir, '.madarch', 'fill', 'units', `${unit.id}.json`), unit);
      expect(JSON.parse(await readFile(join(dir, '.madarch', 'fill', 'run.json'), 'utf8')).productSnapshot.commit).toBe('abc123');
      expect(JSON.parse(await readFile(join(dir, '.madarch', 'fill', 'units', `${unit.id}.json`), 'utf8')).status).toBe('pending');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('dispatches only after dependencies complete and reports per-stage counts', async () => {
    const plans = [plan('inventory', 'inventory', { tree: 'tree' }), plan('index', 'index', { inventory: 'inventory-out' }, ['inventory']), plan('claims', 'claims', { index: 'index-out' }, ['index']), plan('synthesis', 'synthesis', { claims: 'claims-out' }, ['claims'])];
    const persisted: FillUnit[] = [];
    const order: string[] = [];
    const persistedRuns: string[] = [];
    const result = await orchestrateFillUnits(run, plans, [], { execute: async (unit, _signal, progress) => { order.push(unit.id); await progress('working'); return { outputPaths: [`${unit.id}.json`] }; } }, async (unit) => { persisted.push(unit); }, async () => undefined, () => 'running', hooks({ persistRun: async (next) => { persistedRuns.push(next.status); } }));
    expect(order).toEqual(['inventory', 'index', 'claims', 'synthesis']);
    expect(result.every((unit) => unit.status === 'complete')).toBe(true);
    expect(countFillUnits(result).stages.synthesis.complete).toBe(1);
    expect(persisted.some((unit) => unit.status === 'running')).toBe(true);
    expect(persisted.every((unit) => unit.attempt === 1)).toBe(true);
    expect(persistedRuns).toEqual(['complete']);
  });

  test('file store resumes event sequence and reloads units', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'madarch-fill-store-'));
    try {
      const store = createFillFileStore(dir);
      await store.saveUnit(createFillUnit(plan('inventory', 'inventory', { tree: 'hash' })));
      await store.appendEvent({ runId: run.id, stage: 'inventory', unitId: 'inventory', seq: 4, at: new Date().toISOString(), type: 'unit-progress', summary: 'four' });
      await store.appendEvent({ runId: run.id, stage: 'inventory', unitId: 'inventory', seq: 5, at: new Date().toISOString(), type: 'unit-progress', summary: 'five' });
      expect(await store.lastEventSequence(run.id)).toBe(5);
      expect((await store.loadUnits()).map((unit) => unit.id)).toEqual(['inventory']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('writes ordered event journal records and stage-boundary changes stale declared inputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'madarch-fill-events-'));
    try {
      const file = join(dir, 'events.jsonl');
      const event = (seq: number): FillEvent => ({ runId: run.id, stage: 'inventory', unitId: 'inventory', seq, at: new Date().toISOString(), type: 'unit-progress', summary: `step ${seq}` });
      await appendFillEventAtomic(file, event(1));
      await appendFillEventAtomic(file, event(2));
      expect((await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).seq)).toEqual([1, 2]);
    } finally { await rm(dir, { recursive: true, force: true }); }

    const plans = [plan('inventory', 'inventory', { tree: 'old' }), plan('index', 'index', { tree: 'index' }, ['inventory'])];
    const messages: FillEvent[] = [];
    const result = await orchestrateFillUnits(run, plans, [], { execute: async (_unit, _signal, progress) => { await progress('active'); return {}; } }, async () => undefined, async (event) => { messages.push(event); }, () => 'running', hooks({ lastEventSequence: async () => 20, refreshInputs: async (stage) => stage === 'inventory' ? { inventory: { tree: 'new' } } : ({} as Record<string, Record<string, string>>) }));
    expect(messages[0]?.seq).toBe(21);
    expect(messages.some((event) => event.type === 'unit-progress' && event.summary === 'active')).toBe(true);
    expect(result.find((unit) => unit.id === 'inventory')?.status).toBe('complete');
    expect(result.find((unit) => unit.id === 'index')?.status).toBe('complete');
    expect(messages.some((event) => event.type === 'unit-stale')).toBe(true);
    expect(messages.every((event, index) => index === 0 || event.seq > messages[index - 1]!.seq)).toBe(true);
  });

  test('pause drains active work and stop aborts without dispatching pending work', async () => {
    const plans = [plan('inventory', 'inventory', { tree: 'tree' }), plan('index', 'index', { inventory: 'x' }, ['inventory'])];
    let control: 'running' | 'paused' = 'running';
    const runStatuses: string[] = [];
    const result = await orchestrateFillUnits(run, plans, [], { execute: async (unit) => { if (unit.id === 'inventory') control = 'paused'; return {}; } }, async () => undefined, async () => undefined, () => control, hooks({ persistRun: async (next) => { runStatuses.push(next.status); } }));
    expect(runStatuses).toEqual(['paused']);
    expect(result.find((unit) => unit.id === 'inventory')?.status).toBe('complete');
    expect(result.find((unit) => unit.id === 'index')?.status).toBe('pending');
  });

  test('preserves a human edit and blocks the affected stage for review', async () => {
    const plans = [plan('inventory', 'inventory', { tree: 'tree' })];
    const result = await orchestrateFillUnits(run, plans, [], { execute: async (_unit, _signal, progress) => { await progress('active'); return {}; } }, async () => undefined, async () => undefined, () => 'running', hooks({ commitStage: async () => 'conflict' }));
    expect(result[0]?.status).toBe('blocked');
    expect(result[0]?.error).toBe('human-edit-wins');
  });

  test('reuses matching completed work and blocks dependents of failed units', async () => {
    const plans = [plan('inventory', 'inventory', { tree: 'tree' }), plan('index', 'index', { inventory: 'x' }, ['inventory'])];
    const finished = { ...createFillUnit(plans[0]!), status: 'complete' as const, attempt: 1, outputPaths: ['inventory.json'] };
    let called = 0;
    const result = await orchestrateFillUnits(run, plans, [finished], { execute: async () => { called++; throw new Error('expected failure'); } }, async () => undefined, async () => undefined, () => 'running', hooks());
    expect(called).toBe(1);
    expect(result.find((unit) => unit.id === 'inventory')?.status).toBe('complete');
    expect(result.find((unit) => unit.id === 'index')?.status).toBe('blocked');
    expect(countFillUnits(result, [finished]).reused).toBe(1);
    expect(countFillUnits(result, [finished]).run).toBe(1);
  });

  test('consumes only a matching persisted pause or stop request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'madarch-fill-control-'));
    try {
      expect(await consumeFillControl(root, 'run-1')).toBeUndefined();
      const file = join(root, '.madarch', 'fill', 'control.json');
      await writeFillJsonAtomic(file, { runId: 'other', action: 'stop' });
      expect(await consumeFillControl(root, 'run-1')).toBeUndefined();
      await writeFillJsonAtomic(file, { runId: 'run-1', action: 'pause' });
      expect(await consumeFillControl(root, 'run-1')).toBe('paused');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
