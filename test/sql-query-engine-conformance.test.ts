import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPGliteQueryDatabase } from '../src/adapters/pglite-query-database.js';
import { createLadybugEngine } from '../src/adapters/ladybug-engine.js';
import type { AssertionRecord } from '../src/history/types.js';

const DAY = (day: number) => Date.UTC(2026, 8, day);
const AT = { valid: DAY(20), known: DAY(20), state: 'as-is' };

function record(source: string, kind: 'element' | 'relation' | 'state', content: string, options: Partial<AssertionRecord> = {}): AssertionRecord {
  return {
    source,
    kind,
    id: (JSON.parse(content) as { id: string }).id,
    content,
    validFrom: DAY(1),
    validTo: null,
    recordedFrom: DAY(1),
    recordedTo: null,
    ...options,
  };
}

function element(source: string, id: string, kind: string, ancestors: string[], extra: Record<string, unknown> = {}, options: Partial<AssertionRecord> = {}): AssertionRecord {
  return record(source, 'element', JSON.stringify({ id, kind, ancestors, states: ['as-is'], ...extra }), options);
}

function relation(source: string, id: string, from: string, to: string, extra: Record<string, unknown> = {}): AssertionRecord {
  return record(source, 'relation', JSON.stringify({ id, from, to, states: ['as-is'], ...extra }));
}

function state(source: string, id: string, after?: string): AssertionRecord {
  return record(source, 'state', JSON.stringify({ id, ...(after === undefined ? {} : { after }) }));
}

describe('SQL query engine compatibility with the retained graph semantics', () => {
  let database: Awaited<ReturnType<typeof createPGliteQueryDatabase>> | undefined;

  beforeAll(async () => {
    database = await createPGliteQueryDatabase();
  });

  afterAll(async () => {
    await database?.close();
  });

  test('children, unknown-element errors, and bitemporal update match the reference engine', async () => {
    const source = 'conformance-bitemporal';
    const sql = database!.forSources([source]);
    const reference = createLadybugEngine();
    const root = element(source, 'payments', 'domain', []);
    const oldChild = element(source, 'payments-api', 'service', ['payments'], { name: 'Old', parent: 'payments' }, { recordedFrom: DAY(1) });
    const initial = [root, oldChild];
    reference.rebuild(initial);
    await sql.rebuild(initial);
    try {
      expect(await sql.children('payments', { valid: DAY(2), known: DAY(2), state: 'as-is' })).toEqual(reference.children('payments', { valid: DAY(2), known: DAY(2), state: 'as-is' }));
      expect(await sql.children('missing', { valid: DAY(2), known: DAY(2), state: 'as-is' })).toEqual(reference.children('missing', { valid: DAY(2), known: DAY(2), state: 'as-is' }));

      const closed = { ...oldChild, recordedTo: DAY(10) };
      const opened = element(source, 'payments-api', 'service', ['payments'], { name: 'New', parent: 'payments' }, { recordedFrom: DAY(10) });
      await sql.update([opened], [closed]);
      reference.update([opened], [closed]);
      for (const known of [DAY(5), DAY(11)]) {
        const at = { valid: DAY(2), known, state: 'as-is' };
        expect(await sql.children('payments', at)).toEqual(reference.children('payments', at));
      }
      const updated = await sql.children('payments', { valid: DAY(2), known: DAY(11), state: 'as-is' });
      await sql.rebuild([root, closed, opened]);
      expect(await sql.children('payments', { valid: DAY(2), known: DAY(11), state: 'as-is' })).toEqual(updated);
      expect(await sql.children('payments', { valid: DAY(2), known: DAY(11), state: 'as-is' })).toEqual(reference.children('payments', { valid: DAY(2), known: DAY(11), state: 'as-is' }));
    } finally {
      reference.close();
      await sql.close();
    }
  }, 20_000);

  test('state-chain defaults, agreeing duplicate declarations, and disagreements match the reference engine', async () => {
    const sourceX = 'conformance-states-x';
    const sourceY = 'conformance-states-y';
    const records = [
      element(sourceX, 'root', 'service', [], { states: ['as-is', 'to-be'] }),
      element(sourceX, 'child', 'service', ['root'], { parent: 'root', states: ['to-be'] }),
      state(sourceX, 'as-is'),
      state(sourceX, 'to-be', 'as-is'),
      state(sourceY, 'as-is'),
      state(sourceY, 'other', 'as-is'),
    ];
    const sql = database!.forSources([sourceX, sourceY]);
    const reference = createLadybugEngine();
    reference.rebuild(records);
    await sql.rebuild(records);
    try {
      const defaulted = { valid: DAY(2), known: DAY(2) };
      expect(await sql.children('root', defaulted)).toEqual(reference.children('root', defaulted));
      expect((await sql.children('root', defaulted)).error?.states).toEqual(['as-is', 'other', 'to-be']);
      const explicit = { ...defaulted, state: 'to-be' };
      expect(await sql.children('root', explicit)).toEqual(reference.children('root', explicit));

      const duplicateSources = [
        element(sourceX, 'duplicate-root', 'service', []),
        state(sourceX, 'as-is'),
        state(sourceY, 'as-is'),
      ];
      const duplicateSql = database!.forSources([sourceX, sourceY]);
      const duplicateReference = createLadybugEngine();
      duplicateReference.rebuild(duplicateSources);
      await duplicateSql.rebuild(duplicateSources);
      try {
        expect(await duplicateSql.children('duplicate-root', defaulted)).toEqual(duplicateReference.children('duplicate-root', defaulted));
      } finally {
        duplicateReference.close();
        await duplicateSql.close();
      }
    } finally {
      reference.close();
      await sql.close();
    }
  }, 20_000);

  test('collapsed views and context neighbours match the reference engine', async () => {
    const source = 'conformance-view';
    const records = [
      element(source, 'checkout-web', 'service', []),
      element(source, 'checkout-cart', 'module', ['checkout-web'], { parent: 'checkout-web' }),
      element(source, 'checkout-ui', 'module', ['checkout-web'], { parent: 'checkout-web' }),
      element(source, 'payments', 'domain', []),
      element(source, 'payments-api', 'service', ['payments'], { parent: 'payments' }),
      relation(source, 'cart-calls-payments', 'checkout-cart', 'payments-api'),
      relation(source, 'ui-calls-payments', 'checkout-ui', 'payments-api'),
      relation(source, 'checkout-uses-payments', 'checkout-web', 'payments'),
      relation(source, 'checkout-charges-card', 'checkout-cart', 'payments-api', { refines: 'checkout-uses-payments' }),
    ];
    const sql = database!.forSources([source]);
    const reference = createLadybugEngine();
    reference.rebuild(records);
    await sql.rebuild(records);
    try {
      for (const input of [{ depth: 0 }, { scope: 'checkout-web', depth: 1 }, { scope: 'checkout-web', depth: 1, context: true }]) {
        expect(await sql.view(input, AT)).toEqual(reference.view(input, AT));
      }
    } finally {
      reference.close();
      await sql.close();
    }
  }, 20_000);

  test('view rejects raw model ids outside the id pattern like the reference engine', async () => {
    const source = 'conformance-invalid-id';
    const invalidId = "bad'id; DROP";
    const records = [element(source, invalidId, 'service', [])];
    const sql = database!.forSources([source]);
    const reference = createLadybugEngine();
    reference.rebuild(records);
    await sql.rebuild(records);
    try {
      const result = await sql.view({ depth: 0 }, AT);
      expect(result).toEqual(reference.view({ depth: 0 }, AT));
      expect(result.error).toBeDefined();
      expect(result.elements).toBeUndefined();
      expect(result.relations).toBeUndefined();
    } finally {
      reference.close();
      await sql.close();
    }
  }, 20_000);

  test('recursive dependencies and dependents match the reference engine through a cycle', async () => {
    const source = 'conformance-paths';
    const records = [
      ...['a', 'b', 'c', 'd', 'z'].map((id) => element(source, id, 'service', [])),
      relation(source, 'a-to-b', 'a', 'b'),
      relation(source, 'a-to-c', 'a', 'c'),
      relation(source, 'b-to-d', 'b', 'd'),
      relation(source, 'c-to-d', 'c', 'd'),
      relation(source, 'a-to-z', 'a', 'z'),
      relation(source, 'd-to-a', 'd', 'a'),
    ];
    const sql = database!.forSources([source]);
    const reference = createLadybugEngine();
    reference.rebuild(records);
    await sql.rebuild(records);
    try {
      const options = { transitive: true };
      const dependencies = await sql.dependencies('a', options, AT);
      expect(dependencies).toEqual(reference.dependencies('a', options, AT));
      expect(dependencies.elements).toEqual([
        { id: 'b', chain: ['a-to-b'] },
        { id: 'c', chain: ['a-to-c'] },
        { id: 'd', chain: ['a-to-b', 'b-to-d'] },
        { id: 'z', chain: ['a-to-z'] },
      ]);
      const dependents = await sql.dependents('a', options, AT);
      expect(dependents).toEqual(reference.dependents('a', options, AT));
      expect(dependencies.elements?.some(({ id }) => id === 'a')).toBe(false);
      expect(dependents.elements?.some(({ id }) => id === 'a')).toBe(false);
    } finally {
      reference.close();
      await sql.close();
    }
  }, 20_000);

  test('relation-chain ties use code-point order even when it differs from node order', async () => {
    const source = 'conformance-tie';
    const records = [
      ...['a', 'b', 'c', 'target'].map((id) => element(source, id, 'service', [])),
      relation(source, 'z-first', 'a', 'b'),
      relation(source, 'a-first', 'a', 'c'),
      relation(source, 'z-second', 'b', 'target'),
      relation(source, 'a-second', 'c', 'target'),
    ];
    const sql = database!.forSources([source]);
    await sql.rebuild(records);
    try {
      const result = await sql.dependencies('a', { transitive: true }, AT);
      expect(result.elements?.find(({ id }) => id === 'target')?.chain).toEqual(['a-first', 'a-second']);
    } finally {
      await sql.close();
    }
  }, 20_000);

  test('recursive CTE keeps cyclic reachability bounded at the 30-hop ceiling', async () => {
    const source = 'conformance-cycle-graph';
    const records: AssertionRecord[] = [];
    const count = 10;
    for (let i = 0; i < count; i++) records.push(element(source, `e${i}`, 'service', []));
    for (let i = 0; i < count; i++) records.push(relation(source, `ring${i}`, `e${i}`, `e${(i + 1) % count}`));
    for (let i = 0; i < count; i += 2) records.push(relation(source, `chord${i}`, `e${i}`, `e${(i + 5) % count}`));
    const sql = database!.forSources([source]);
    const reference = createLadybugEngine();
    reference.rebuild(records);
    await sql.rebuild(records);
    try {
      const options = { transitive: true, maxHops: 30 };
      const result = await sql.dependencies('e0', options, AT);
      const referenceResult = reference.dependencies('e0', options, AT);
      expect(result.error).toBeUndefined();
      expect(result.elements?.map(({ id }) => id)).toEqual(referenceResult.elements?.map(({ id }) => id));
      expect(result.elements?.map(({ id, chain }) => [id, chain.length])).toEqual(referenceResult.elements?.map(({ id, chain }) => [id, chain.length]));
      expect(result.elements?.map(({ id }) => id).sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
      expect(result.elements?.some(({ id }) => id === 'e0')).toBe(false);
    } finally {
      reference.close();
      await sql.close();
    }
  }, 20_000);

});
