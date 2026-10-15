import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteQueryDatabase } from '../src/adapters/pglite-query-database.js';
import type { AssertionRecord } from '../src/history/types.js';

const DAY = (day: number) => Date.UTC(2026, 8, day);
const AT = { valid: DAY(20), known: DAY(20), state: 'as-is' };

function element(source: string, id: string, kind: string, ancestors: string[], parent?: string): AssertionRecord {
  const content = JSON.stringify({ id, kind, ancestors, states: ['as-is'], ...(parent === undefined ? {} : { parent }) });
  return { source, kind: 'element', id, content, validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null };
}

function relation(source: string, id: string, from: string, to: string): AssertionRecord {
  const content = JSON.stringify({ id, from, to, states: ['as-is'] });
  return { source, kind: 'relation', id, content, validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null };
}

describe('the shared SQL query database', () => {
  let database: Awaited<ReturnType<typeof createPGliteQueryDatabase>> | undefined;
  let temporaryDirectory: string | undefined;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'madarch-query-projection-'));
    database = await createPGliteQueryDatabase({ path: join(temporaryDirectory, 'query-db') });
  });

  afterAll(async () => {
    await database?.close();
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
  });

  test('source-scoped facades share rows for cross-source traversal without exposing other sources', async () => {
    const sourceA = database!.forSources(['source-a']);
    const sourceB = database!.forSources(['source-b']);
    const union = database!.forSources(['source-a', 'source-b']);
    await sourceA.rebuild([
      element('source-a', 'orders', 'service', []),
      relation('source-a', 'orders-publishes', 'orders', 'event-bus'),
    ]);
    await sourceB.rebuild([
      element('source-b', 'event-bus', 'broker', []),
      element('source-b', 'worker', 'service', ['event-bus'], 'event-bus'),
      relation('source-b', 'bus-uses-worker', 'event-bus', 'worker'),
    ]);

    const hidden = await sourceA.children('event-bus', AT);
    expect(hidden.error).toMatchObject({ id: 'event-bus', time: DAY(20) });
    expect((await sourceB.children('orders', AT)).error).toMatchObject({ id: 'orders', time: DAY(20) });

    const traversal = await union.dependencies('orders', { transitive: true }, AT);
    expect(traversal.error).toBeUndefined();
    expect(traversal.elements).toEqual([
      { id: 'event-bus', chain: ['orders-publishes'] },
      { id: 'worker', chain: ['orders-publishes', 'bus-uses-worker'] },
    ]);

    await sourceA.rebuild([element('source-a', 'orders', 'service', [])]);
    const stillThere = await union.children('event-bus', AT);
    expect(stillThere.elements?.map(({ id }) => id)).toEqual(['worker']);

    await sourceB.update([element('source-b', 'worker-2', 'service', ['event-bus'], 'event-bus')], []);
    expect((await union.children('event-bus', AT)).elements?.map(({ id }) => id)).toEqual(['worker', 'worker-2']);
    expect(await sourceA.children('orders', AT)).toEqual({ elements: [] });
  }, 20_000);

  test('closing a borrowed facade leaves sibling facades usable', async () => {
    const sourceA = database!.forSources(['close-a']);
    const sourceB = database!.forSources(['close-b']);
    await sourceA.rebuild([element('close-a', 'a', 'service', [])]);
    await sourceB.rebuild([element('close-b', 'b', 'service', [])]);

    await sourceA.close();
    expect((await sourceB.children('b', AT)).elements).toEqual([]);
  }, 20_000);

  test('one owner rejects cross-facade reentry and keeps a queued write ahead of later snapshots', async () => {
    const sourceA = database!.forSources(['gate-a']);
    const sourceB = database!.forSources(['gate-b']);
    await sourceA.rebuild([element('gate-a', 'a', 'service', [])]);
    await sourceB.rebuild([element('gate-b', 'b', 'service', [])]);

    let signalEntered!: () => void;
    let releaseSnapshot!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const firstSnapshot = sourceA.withSnapshot(async (snapshot) => {
      await expect(sourceB.children('b', AT)).rejects.toThrow(/inside withSnapshot/i);
      signalEntered();
      await release;
      return snapshot.children('a', AT);
    });
    await entered;

    let updateSettled = false;
    const update = sourceB.update([element('gate-b', 'new-worker', 'service', ['b'], 'b')], [])
      .finally(() => { updateSettled = true; });
    const laterSnapshot = sourceB.withSnapshot((snapshot) => snapshot.children('b', AT));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(updateSettled).toBe(false);
    releaseSnapshot();

    expect((await firstSnapshot).elements?.map(({ id }) => id)).toEqual([]);
    await update;
    expect((await laterSnapshot).elements?.map(({ id }) => id)).toEqual(['new-worker']);

    await sourceA.close();
    expect((await sourceB.children('b', AT)).elements?.map(({ id }) => id)).toEqual(['new-worker']);
    await database!.close();
    await expect(sourceB.children('b', AT)).rejects.toThrow(/closed/i);
    expect(() => database!.forSources(['after-close'])).toThrow(/closed/i);

    database = await createPGliteQueryDatabase({ path: join(temporaryDirectory!, 'query-db') });
    const reopenedSource = database.forSources(['gate-b']);
    expect((await reopenedSource.children('b', AT)).elements?.map(({ id }) => id)).toEqual(['new-worker']);
    await reopenedSource.close();
  }, 20_000);
});
