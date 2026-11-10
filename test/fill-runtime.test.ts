import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeFillControl, hashFillInputs, withFillControlLock } from '../src/product/fill-runtime.js';

/** Writes a control file the way a serving process asks a run to pause or stop. */
async function writeControl(root: string, request: { readonly runId: string; readonly action: string }): Promise<void> {
  const folder = join(root, '.madarch', 'fill');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'control.json'), JSON.stringify(request), 'utf8');
}

describe('fill runtime contract', () => {
  test('hashes named inputs deterministically', () => {
    expect(hashFillInputs({ registry: 'registry bytes', tree: 'tree bytes' })).toEqual(hashFillInputs({ tree: 'tree bytes', registry: 'registry bytes' }));
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
      await writeControl(root, { runId: 'other', action: 'stop' });
      expect(await consumeFillControl(root, 'run-1')).toBeUndefined();
      await writeControl(root, { runId: 'run-1', action: 'pause' });
      expect(await consumeFillControl(root, 'run-1')).toBe('paused');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
