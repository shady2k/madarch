import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { compileModel, createLadybugEngine, createSqliteHistory, loadModel, type AssertionRecord, type Clock, type HistoryStore, type QueryEngine } from '../src/index.js';

/**
 * graph-queries/view, the `refinement-in-own-view` scenario and the sentence
 * before it in docs/changes/readable-views-2/capabilities/graph-queries.md:
 * in a view with its context, a refinement whose own end inside the scope is
 * shown below the scope is drawn instead of the relation it refines when that
 * relation's end inside is the scope itself. Every expected value below is
 * worked out by hand from the fixture.
 */
function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function fakeClock(initial: number): Clock & { set(t: number): void } {
  let current = initial;
  return { now: () => current, set: (t: number) => (current = t) };
}

const DAY = (day: number) => Date.UTC(2026, 8, day);
const AT = { valid: DAY(2), known: DAY(2), state: 'as-is' };

/** Loads and compiles each fixture in turn as one source's next commit, and builds a query engine from the history they produced. */
function engineFor(...versions: { name: string; committedAt: number; storedAt: number }[]): { engine: QueryEngine; history: HistoryStore } {
  const clock = fakeClock(versions[0]!.storedAt);
  const history = createSqliteHistory({ clock });
  for (const version of versions) {
    const { model, errors } = loadModel(fixture(version.name));
    expect(errors).toEqual([]);
    clock.set(version.storedAt);
    expect(history.store({ source: 's', commit: version.name, committedAt: version.committedAt, model: compileModel(model!) }).errors).toEqual([]);
  }
  const engine = createLadybugEngine();
  engine.rebuild(history.assertions());
  return { engine, history };
}

function oneVersion(name: string): { engine: QueryEngine; history: HistoryStore } {
  return engineFor({ name, committedAt: DAY(1), storedAt: DAY(2) });
}

const OWN_VIEW = {
  elements: [
    { id: 'checkout-api', kind: 'service', parent: 'shop' },
    { id: 'checkout-payment-step', kind: 'module', parent: 'checkout-api' },
  ],
  neighbours: [{ id: 'payments', kind: 'domain' }],
  relations: [{ from: 'checkout-payment-step', to: 'payments', relationIds: ['payment-step-authorizes'] }],
};

describe('graph-queries/view: a refinement in its element\'s own view', () => {
  test('refinement-in-own-view: the payment step is drawn to the neighbour payments, and nothing from checkout-api itself', () => {
    const { engine, history } = oneVersion('gq-refinement-own-view');

    expect(engine.view({ scope: 'checkout-api', depth: 1, context: true }, AT)).toEqual(OWN_VIEW);

    engine.close();
    history.close();
  });

  test('at depth zero nothing below the scope is shown, so the relation it refines is drawn from the scope, standing for the refinement', () => {
    const { engine, history } = oneVersion('gq-refinement-own-view');

    expect(engine.view({ scope: 'checkout-api', depth: 0, context: true }, AT)).toEqual({
      elements: [{ id: 'checkout-api', kind: 'service', parent: 'shop' }],
      neighbours: [{ id: 'payments', kind: 'domain' }],
      relations: [{ from: 'checkout-api', to: 'payments', relationIds: ['checkout-pays-through-payments'] }],
    });

    engine.close();
    history.close();
  });

  test('a domain view, where the refined relation\'s end inside is a service below the scope and not the scope itself, keeps counting the refinement once under it', () => {
    const { engine, history } = oneVersion('gq-refinement-own-view');

    for (const depth of [1, 2]) {
      const result = engine.view({ scope: 'shop', depth, context: true }, AT);
      expect(result.error).toBeUndefined();
      expect(result.neighbours).toEqual([{ id: 'payments', kind: 'domain' }]);
      expect(result.relations).toEqual([{ from: 'checkout-api', to: 'payments', relationIds: ['checkout-pays-through-payments'] }]);
    }

    engine.close();
    history.close();
  });

  test('without context nothing changes: the element\'s own view draws no crossing relation, and a whole-graph view draws the refinement beside the relation it refines once its own ends are shown', () => {
    const { engine, history } = oneVersion('gq-refinement-own-view');

    expect(engine.view({ scope: 'checkout-api', depth: 1 }, AT)).toEqual({
      elements: [
        { id: 'checkout-api', kind: 'service', parent: 'shop' },
        { id: 'checkout-payment-step', kind: 'module', parent: 'checkout-api' },
      ],
      relations: [],
    });
    expect(engine.view({ depth: 2 }, AT).relations).toEqual([
      { from: 'checkout-api', to: 'payments', relationIds: ['checkout-pays-through-payments'] },
      { from: 'checkout-payment-step', to: 'payments-api', relationIds: ['payment-step-authorizes'] },
    ]);

    engine.close();
    history.close();
  });

  test('as-of: before the refinement exists the relation it refines is drawn from the scope; after, the payment step is', () => {
    const { engine, history } = engineFor(
      { name: 'gq-refinement-own-view-asof-v1', committedAt: DAY(1), storedAt: DAY(2) },
      { name: 'gq-refinement-own-view', committedAt: DAY(10), storedAt: DAY(12) },
    );
    const input = { scope: 'checkout-api', depth: 1, context: true };

    const before = engine.view(input, { valid: DAY(5), known: DAY(20), state: 'as-is' });
    expect(before).toEqual({
      ...OWN_VIEW,
      relations: [{ from: 'checkout-api', to: 'payments', relationIds: ['checkout-pays-through-payments'] }],
    });
    expect(engine.view(input, { valid: DAY(15), known: DAY(20), state: 'as-is' })).toEqual(OWN_VIEW);
    // Valid after the second commit, but known before it was stored.
    expect(engine.view(input, { valid: DAY(15), known: DAY(5), state: 'as-is' })).toEqual(before);

    engine.close();
    history.close();
  });

  test('two modules refining one relation are both drawn and the relation they refine is not; an incoming relation is replaced the same way; a refinement from the scope itself changes nothing', () => {
    const { engine, history } = oneVersion('gq-refinement-own-view-cases');

    expect(engine.view({ scope: 'checkout-api', depth: 1, context: true }, AT)).toEqual({
      elements: [
        { id: 'checkout-api', kind: 'service', parent: 'shop' },
        { id: 'checkout-cart', kind: 'module', parent: 'checkout-api' },
        { id: 'checkout-payment-step', kind: 'module', parent: 'checkout-api' },
        { id: 'checkout-refund-step', kind: 'module', parent: 'checkout-api' },
      ],
      neighbours: [
        { id: 'orders', kind: 'domain' },
        { id: 'payments', kind: 'domain' },
      ],
      relations: [
        { from: 'checkout-api', to: 'orders', relationIds: ['checkout-places-orders'] },
        { from: 'checkout-cart', to: 'payments', relationIds: ['cart-releases-authorization'] },
        { from: 'checkout-refund-step', to: 'payments', relationIds: ['refund-step-refunds'] },
        { from: 'payments', to: 'checkout-payment-step', relationIds: ['webhook-confirms-payment-step'] },
      ],
    });

    engine.close();
    history.close();
  });

  test('once the relation is replaced, another refinement of it from the scope itself stands for itself, since the relation it refines is no longer drawn', () => {
    const DAY1 = { validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null };
    const element = (id: string, kind: string, ancestors: string[]): AssertionRecord => ({
      source: 's',
      kind: 'element',
      id,
      content: JSON.stringify({ id, kind, ancestors, states: ['as-is'], ...(ancestors.length > 0 ? { parent: ancestors[ancestors.length - 1] } : {}) }),
      ...DAY1,
    });
    const relation = (id: string, from: string, to: string, refines?: string): AssertionRecord => ({
      source: 's',
      kind: 'relation',
      id,
      content: JSON.stringify({ id, from, to, states: ['as-is'], ...(refines !== undefined ? { refines } : {}) }),
      ...DAY1,
    });
    const engine = createLadybugEngine();
    engine.rebuild([
      element('checkout-api', 'service', []),
      element('checkout-payment-step', 'module', ['checkout-api']),
      element('payments', 'domain', []),
      element('payments-api', 'service', ['payments']),
      relation('checkout-pays', 'checkout-api', 'payments'),
      relation('api-authorizes', 'checkout-api', 'payments-api', 'checkout-pays'),
      relation('step-authorizes', 'checkout-payment-step', 'payments-api', 'checkout-pays'),
    ]);

    expect(engine.view({ scope: 'checkout-api', depth: 1, context: true }, AT).relations).toEqual([
      { from: 'checkout-api', to: 'payments', relationIds: ['api-authorizes'] },
      { from: 'checkout-payment-step', to: 'payments', relationIds: ['step-authorizes'] },
    ]);

    engine.close();
  });
});
