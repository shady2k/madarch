import { describe, expect, test } from 'bun:test';
import { adaptSynchronousQueryEngine } from '../src/query/async-compatibility.js';
import { createAsyncLadybugEngine } from '../src/adapters/async-ladybug-engine.js';
import type { QueryEngine } from '../src/query/types.js';

function legacyEngine(options: { revision?: () => number; events?: string[] } = {}): QueryEngine {
  const revision = options.revision ?? (() => 0);
  const events = options.events ?? [];
  return {
    children: () => ({ error: { message: 'missing', id: 'missing', time: 10 } }),
    view: () => ({ elements: [{ id: `revision-${revision()}`, kind: 'service' }] }),
    dependents: () => ({ elements: [{ id: 'dependent', chain: ['calls'] }] }),
    dependencies: () => ({ elements: [{ id: 'dependency', chain: ['uses'] }] }),
    rebuild: () => { events.push('rebuild'); },
    update: () => { events.push('update'); },
    close: () => { events.push('close'); },
  };
}

describe('the asynchronous query-engine compatibility adapter', () => {
  test('returns promises and preserves the synchronous engine answers and lifecycle', async () => {
    const events: string[] = [];
    const engine = adaptSynchronousQueryEngine(legacyEngine({ events }));

    expect(engine.children('missing')).toBeInstanceOf(Promise);
    await expect(engine.children('missing')).resolves.toEqual({
      error: { message: 'missing', id: 'missing', time: 10 },
    });
    await expect(engine.view({ depth: 0 })).resolves.toEqual({
      elements: [{ id: 'revision-0', kind: 'service' }],
    });
    await expect(engine.dependents('target', {})).resolves.toEqual({
      elements: [{ id: 'dependent', chain: ['calls'] }],
    });
    await expect(engine.dependencies('source', {})).resolves.toEqual({
      elements: [{ id: 'dependency', chain: ['uses'] }],
    });

    await engine.rebuild([]);
    await engine.update([], []);
    await engine.close();
    expect(events).toEqual(['rebuild', 'update', 'close']);
  });

  test('the Ladybug factory exposes the asynchronous port', async () => {
    const engine = createAsyncLadybugEngine();
    try {
      await engine.rebuild([]);
      const result = await engine.children('missing', { valid: 10, known: 10, state: 'as-is' });
      expect(result.error?.id).toBe('missing');
    } finally {
      await engine.close();
    }
  });

  test('keeps a multi-query snapshot stable and does not let a later snapshot overtake an update', async () => {
    const events: string[] = [];
    let revision = 0;
    const legacy = legacyEngine({ revision: () => revision, events });
    legacy.update = () => { revision += 1; events.push('update'); };
    const engine = adaptSynchronousQueryEngine(legacy);

    let firstSnapshotStarted!: () => void;
    let releaseFirstSnapshot!: () => void;
    const started = new Promise<void>((resolve) => { firstSnapshotStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseFirstSnapshot = resolve; });

    const first = engine.withSnapshot(async (snapshot) => {
      const before = await snapshot.view({ depth: 0 });
      firstSnapshotStarted();
      await held;
      const after = await snapshot.view({ depth: 0 });
      events.push('first-snapshot-finished');
      return [before, after];
    });
    await started;

    const update = engine.update([], []);
    const laterSnapshot = engine.withSnapshot(async (snapshot) => {
      events.push('later-snapshot-started');
      return snapshot.view({ depth: 0 });
    });
    releaseFirstSnapshot();

    const [firstAnswers, , laterAnswer] = await Promise.all([first, update, laterSnapshot]);
    expect(firstAnswers.map((answer) => answer.elements?.[0]?.id)).toEqual(['revision-0', 'revision-0']);
    expect(laterAnswer.elements?.[0]?.id).toBe('revision-1');
    expect(events).toEqual(['first-snapshot-finished', 'update', 'later-snapshot-started']);
  });

  test('rejects reentrant engine operations instead of deadlocking', async () => {
    const events: string[] = [];
    const engine = adaptSynchronousQueryEngine(legacyEngine({ events }));
    const reentryMessage = /inside withSnapshot.*supplied snapshot reader/;

    await expect(engine.withSnapshot(async () => engine.update([], []))).rejects.toThrow(reentryMessage);

    let snapshotStarted!: () => void;
    let releaseSnapshot!: () => void;
    const started = new Promise<void>((resolve) => { snapshotStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const activeSnapshot = engine.withSnapshot(async () => {
      snapshotStarted();
      await held;
      await expect(engine.view({ depth: 0 })).rejects.toThrow(reentryMessage);
    });
    await started;
    const queuedUpdate = engine.update([], []);
    releaseSnapshot();

    await Promise.all([activeSnapshot, queuedUpdate]);
    expect(events).toEqual(['update']);
    await engine.close();
  });

  test('close waits for an active snapshot and rejects new queries immediately', async () => {
    const engine = adaptSynchronousQueryEngine(legacyEngine());
    let snapshotStarted!: () => void;
    let releaseSnapshot!: () => void;
    const started = new Promise<void>((resolve) => { snapshotStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const snapshot = engine.withSnapshot(async (reader) => {
      snapshotStarted();
      await held;
      return reader.view({ depth: 0 });
    });
    await started;

    const closing = engine.close();
    await expect(engine.view({ depth: 0 })).rejects.toThrow(/closed/);
    releaseSnapshot();
    await expect(snapshot).resolves.toEqual({ elements: [{ id: 'revision-0', kind: 'service' }] });
    await expect(closing).resolves.toBeUndefined();
    await expect(engine.update([], [])).rejects.toThrow(/closed/);
  });
});
