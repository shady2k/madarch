import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { CompiledModelSchema, compileModel, parseModel } from '../src/index.js';

/**
 * intended-model/messaging: a relation through a topic or queue says whether
 * its initiator sends or receives; `action` anywhere else is refused, a
 * missing one warned about. compiled-model/shape: the action is kept.
 */

const ELEMENTS = `elements:
  - id: orders-api
    kind: service
  - id: inventory-api
    kind: service
  - id: checkout-web
    kind: service
  - id: event-bus
    kind: broker
  - id: jobs
    kind: broker
`;

const INTERFACES = `interfaces:
  - id: topic-order-placed
    provider: event-bus
    contract: topic::order-placed
  - id: queue-restock
    provider: jobs
    contract: queue::restock
  - id: orders-http
    provider: orders-api
    contract: http::POST::/api/orders
`;

/** One model file: the shared elements and interfaces, then the relations given. */
function model(relations: string): { path: string; text: string } {
  return { path: 'madarch/model.yaml', text: `version: 1\n${ELEMENTS}${INTERFACES}relations:\n${relations}` };
}

const SUBSCRIBER = `  - id: inventory-reserves-stock
    name: reserves stock for placed orders
    from: inventory-api
    to: event-bus
    interface: topic-order-placed
    action: receive
`;

const PUBLISHER = `  - id: orders-publishes-placed
    name: publishes order-placed
    from: orders-api
    to: event-bus
    interface: topic-order-placed
    action: send
`;

/** The line of `needle` in the model file, 1-based, as a reader counts it. */
function lineOf(file: { text: string }, needle: string, after = 0): number {
  const lines = file.text.split('\n');
  const at = lines.findIndex((line, index) => index >= after && line.includes(needle));
  if (at < 0) throw new Error(`"${needle}" is not in the fixture`);
  return at + 1;
}

describe('intended-model/messaging: publishers and subscribers are marked', () => {
  test('subscriber-marked: a receiving relation loads with no warning, its ends as written', () => {
    const { model: loaded, errors, warnings } = parseModel([model(SUBSCRIBER + PUBLISHER)]);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    const relation = loaded!.relations.find((r) => r.id === 'inventory-reserves-stock')!;
    expect(relation.from).toBe('inventory-api');
    expect(relation.to).toBe('event-bus');
    expect(relation.action).toBe('receive');
  });

  test('a queue relation takes an action too', () => {
    const file = model(`  - id: inventory-asks-restock
    name: asks for restock
    from: inventory-api
    to: jobs
    interface: queue-restock
    action: send
`);
    const { errors, warnings } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('action-without-messaging: action on an http relation is refused at its own line', () => {
    const file = model(`${PUBLISHER}  - id: checkout-calls-orders
    name: places orders
    from: checkout-web
    to: orders-api
    interface: orders-http
    action: send
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      file: 'madarch/model.yaml',
      line: lineOf(file, 'action: send', lineOf(file, 'checkout-calls-orders')),
      path: 'relations[1].action',
    });
    expect(errors[0]!.message).toContain('"checkout-calls-orders"');
    expect(errors[0]!.message).toContain('topic or queue');
    expect(errors[0]!.message).toContain('http::POST::/api/orders');
  });

  test('action on a relation that names no interface is refused', () => {
    const file = model(`  - id: checkout-calls-orders
    name: places orders
    from: checkout-web
    to: orders-api
    action: receive
`);
    const { errors } = parseModel([file]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: lineOf(file, 'action: receive'), path: 'relations[0].action' });
    expect(errors[0]!.message).toContain('"checkout-calls-orders"');
    expect(errors[0]!.message).toContain('names no interface');
  });

  test('an action other than send or receive does not match the schema, reported at its own line', () => {
    const file = model(SUBSCRIBER.replace('action: receive', 'action: subscribe'));
    const { errors } = parseModel([file]);

    expect(errors.map(({ file: at, line, path }) => ({ file: at, line, path }))).toContainEqual({
      file: 'madarch/model.yaml',
      line: lineOf(file, 'action: subscribe'),
      path: 'relations[0].action',
    });
  });

  test('a misplaced action is reported beside an unrelated reference error, not hidden by it', () => {
    const file = model(`  - id: checkout-calls-orders
    name: places orders
    from: checkout-web
    to: orders-api
    interface: orders-http
    action: send
  - id: broken
    name: points nowhere
    from: orders-api
    to: nowhere
  - id: loose
    name: marks nothing
    from: checkout-web
    to: orders-api
    action: receive
`);
    const { errors } = parseModel([file]);

    expect(errors.filter((error) => error.path.endsWith('.action')).map(({ line, path }) => ({ line, path }))).toEqual([
      { line: lineOf(file, 'action: send'), path: 'relations[0].action' },
      { line: lineOf(file, 'action: receive'), path: 'relations[2].action' },
    ]);
    expect(errors.some((error) => error.message.includes('"nowhere"'))).toBe(true);
  });

  test('messaging-without-action: a topic relation with no action loads, with one warning at the relation', () => {
    const file = model(PUBLISHER.replace('    action: send\n', ''));
    const { model: loaded, errors, warnings } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(loaded).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ file: 'madarch/model.yaml', line: lineOf(file, '- id: orders-publishes-placed'), path: 'relations[0]' });
    expect(warnings[0]!.message).toContain('"orders-publishes-placed"');
    expect(warnings[0]!.message).toContain('action: send');
    expect(warnings[0]!.message).toContain('action: receive');
  });

  test('the interface may be declared in another file; warnings stay in file order, then in the order written', () => {
    const iface = { path: 'madarch/a-bus.yaml', text: `version: 1\n${ELEMENTS}${INTERFACES}` };
    const relations = {
      path: 'madarch/b-events.yaml',
      text: `version: 1
elements: []
relations:
  - id: checkout-calls-orders
    from: checkout-web
    to: orders-api
    interface: orders-http
  - id: orders-publishes-placed
    name: publishes order-placed
    from: orders-api
    to: event-bus
    interface: topic-order-placed
  - id: inventory-asks-restock
    from: inventory-api
    to: jobs
    interface: queue-restock
`,
    };
    const { errors, warnings } = parseModel([iface, relations]);

    expect(errors).toEqual([]);
    expect(warnings.map(({ file, line, path }) => ({ file, line, path }))).toEqual([
      { file: 'madarch/b-events.yaml', line: 4, path: 'relations[0]' },
      { file: 'madarch/b-events.yaml', line: 8, path: 'relations[1]' },
      { file: 'madarch/b-events.yaml', line: 13, path: 'relations[2]' },
      { file: 'madarch/b-events.yaml', line: 13, path: 'relations[2]' },
    ]);
    expect(warnings[0]!.message).toContain('no name');
    expect(warnings[1]!.message).toContain('topic');
    expect(warnings[2]!.message).toContain('no name');
    expect(warnings[3]!.message).toContain('queue');
  });

  test('a refused model still reports the missing actions it could read', () => {
    const { model: loaded, errors, warnings } = parseModel([
      model(`${PUBLISHER.replace('    action: send\n', '')}  - id: broken
    name: points nowhere
    from: orders-api
    to: nowhere
`),
    ]);

    expect(loaded).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(warnings.map((w) => w.path)).toEqual(['relations[0]']);
  });

  test('a contract that does not name a topic or queue, even a "topic::"-shaped one, is no messaging: an action on it is refused naming the relation', () => {
    const file = {
      path: 'madarch/model.yaml',
      text: `version: 1
${ELEMENTS}
interfaces:
  - id: nameless-topic
    provider: event-bus
    contract: "topic::"
  - id: not-a-contract
    provider: event-bus
    contract: topicx
relations:
  - id: publishes-through-nameless
    name: publishes order-placed
    from: orders-api
    to: event-bus
    interface: nameless-topic
    action: send
  - id: publishes-through-broken
    name: publishes order-placed
    from: inventory-api
    to: event-bus
    interface: not-a-contract
    action: send
`,
    };
    const { model: loaded, errors, warnings } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(errors.filter((error) => error.path.endsWith('.action')).map(({ file: at, line, path }) => ({ file: at, line, path }))).toEqual([
      { file: 'madarch/model.yaml', line: lineOf(file, 'action: send'), path: 'relations[0].action' },
      { file: 'madarch/model.yaml', line: lineOf(file, 'action: send', lineOf(file, 'publishes-through-broken')), path: 'relations[1].action' },
    ]);
    expect(errors.filter((error) => error.path.endsWith('.action')).every((error) => error.message.includes('topic or queue'))).toBe(true);
  });

  test('an action on a relation naming an unknown interface is refused naming the relation, not lost', () => {
    const file = model(`  - id: checkout-calls-orders
    name: places orders
    from: checkout-web
    to: orders-api
    interface: nowhere
    action: send
`);
    const { model: loaded, errors, warnings } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: 'madarch/model.yaml', path: 'relations[0].interface' });
    expect(errors[0]!.message).toContain('"nowhere"');
  });

  test('a relation without an action naming an unknown interface gets no messaging warning', () => {
    const file = model(`  - id: checkout-calls-orders
    name: places orders
    from: checkout-web
    to: orders-api
    interface: nowhere
`);
    const { model: loaded, errors, warnings } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: 'madarch/model.yaml', path: 'relations[0].interface' });
  });
});

describe('compiled-model/shape: the compiled relation keeps its action', () => {
  test('action-kept: receive is kept, and a relation with none has none', () => {
    const { model: loaded, errors } = parseModel([
      model(`${SUBSCRIBER}  - id: checkout-calls-orders
    name: places orders
    from: checkout-web
    to: orders-api
    interface: orders-http
`),
    ]);
    expect(errors).toEqual([]);

    const compiled = compileModel(loaded!);
    const byId = new Map(compiled.relations.map((relation) => [relation.id, relation]));
    expect(byId.get('inventory-reserves-stock')?.action).toBe('receive');
    expect(byId.get('checkout-calls-orders')).not.toHaveProperty('action');
    expect(Value.Check(CompiledModelSchema, compiled)).toBe(true);
  });
});
