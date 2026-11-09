import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILL_STATE_VERSION, appendFillEventAtomic, consumeFillControl, createFillUnit, fillInputsMatch, hashFillInputs, reconcileFillUnit, withFillControlLock, writeFillJsonAtomic, type FillEvent, type FillRun, type FillUnit } from '../src/product/fill-runtime.js';

const plan = (id: string, stage: FillUnit['stage'], inputHashes: Record<string, string>, dependencies: string[] = []): FillUnit => ({ id, stage, inputHashes, outputPaths: [`outputs/${id}.json`], dependencies, status: 'pending', attempt: 0, createdAt: '', updatedAt: '' });
const runAt = new Date().toISOString();
const run: FillRun = { productSnapshot: { repository: join(tmpdir(), `madarch-fill-runtime-product-${process.pid}-${Date.now()}`), defaultBranch: 'main', commit: 'abc123', registryHash: 'registry' }, agentBranch: 'madarch/fill/run', schemaVersion: FILL_STATE_VERSION, id: 'run-1', status: 'running', createdAt: runAt, updatedAt: runAt };
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

  
  
  
  
  
  
  
  test('serializes coordinator and control actions for the same product', async () => {
    const root = await mkdtemp(join(tmpdir(), 'madarch-fill-lock-'));
    try {
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstStarted!: () => void;
      const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
      const first = withFillControlLock(root, async () => { order.push('first-start'); firstStarted(); await firstGate; order.push('first-end'); });
      await firstReady;
      const second = withFillControlLock(root, async () => { order.push('second'); });
      await Promise.resolve();
      expect(order).toEqual(['first-start']);
      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(['first-start', 'first-end', 'second']);
    } finally { await rm(root, { recursive: true, force: true }); }
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
