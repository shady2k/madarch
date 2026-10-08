import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import { compileModel, CompiledModelSchema, loadAndCompileModel, parseModel, serializeCompiledModel } from '../src/index.js';

/**
 * intended-model/scenarios, intended-model/ids and intended-model/references
 * as they name a scenario, and compiled-model/shape and deterministic as the
 * compiled model holds scenarios (docs/changes/
 * use-cases-data-entities/capabilities/…). Expected values come from those
 * requirements' scenarios, never from the implementation.
 */

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** The 1-based line of `needle` in one in-memory model file, as a reader counts it. */
function lineIn(file: { text: string }, needle: string): number {
  const at = file.text.split('\n').findIndex((line) => line.includes(needle));
  if (at < 0) throw new Error(`"${needle}" is not in the model`);
  return at + 1;
}

const ELEMENTS = `elements:
  - id: checkout-api
    kind: service
  - id: orders-api
    kind: service
`;

const RELATIONS = `relations:
  - id: checkout-places-order
    name: places the order
    from: checkout-api
    to: orders-api
  - id: orders-publishes-placed
    name: publishes order-placed
    from: orders-api
    to: checkout-api
`;

/** One model file: the shared parts, then what each case adds. */
function model(text: string): { path: string; text: string } {
  return { path: 'madarch/model.yaml', text: `version: 1\n${text}` };
}

describe('intended-model/scenarios: use cases are scenarios over the model\'s relations', () => {
  test('scenario-compiled: the compiled scenario holds its actor, its requirement, its steps in order and its alternative', () => {
    const { model: compiled, errors, warnings } = loadAndCompileModel(fixture('scenarios-example'));

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    const scenario = compiled?.scenarios!.find((s) => s.id === 'place-order');
    expect(scenario).toEqual({
      id: 'place-order',
      name: 'Place an order',
      description: "A signed-in customer orders the cart's contents.",
      actor: 'customer',
      requirements: ['ordering/place-order'],
      steps: [
        { id: 's1', relation: 'checkout-places-order' },
        { id: 's2', relation: 'orders-publishes-placed', name: 'the order is announced' },
      ],
      alternatives: [{ id: 'card-declined', at: 's2', when: 'the payment is declined', steps: [{ id: 'd1', relation: 'checkout-shows-error' }] }],
    });
  });

  test('a scenario with no actor, no requirements and no alternatives compiles with those keys left out', () => {
    const { model: compiled, errors } = loadAndCompileModel(fixture('scenarios-example'));

    expect(errors).toEqual([]);
    expect(compiled?.scenarios!.find((s) => s.id === 'order-fails')).toEqual({
      id: 'order-fails',
      name: 'The order fails',
      steps: [{ id: 's1', relation: 'checkout-shows-error' }],
    });
  });

  test('scenarios are ordered by id in the compiled model, and steps and alternatives stay as written', () => {
    const { model: compiled, errors } = loadAndCompileModel(fixture('scenarios-example-split'));

    expect(errors).toEqual([]);
    expect(compiled?.scenarios!.map((s) => s.id)).toEqual(['order-fails', 'place-order']);
    const placeOrder = compiled?.scenarios!.find((s) => s.id === 'place-order')!;
    expect(placeOrder.steps.map((step) => step.id)).toEqual(['s1', 's2']);
    expect(placeOrder.alternatives!.map((alternative) => alternative.id)).toEqual(['card-declined']);
  });

  test('alternative steps stay in written order, whatever their ids sort as', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
    alternatives:
      - id: card-declined
        at: s1
        when: the payment is declined
        steps:
          - { id: z-last, relation: orders-publishes-placed }
          - { id: a-first, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(compileModel(loaded!).scenarios![0]!.alternatives![0]!.steps.map((step) => step.id)).toEqual(['z-last', 'a-first']);
  });

  test('the same model split differently across files compiles to the same bytes', () => {
    const oneFile = loadAndCompileModel(fixture('scenarios-example'));
    const threeFiles = loadAndCompileModel(fixture('scenarios-example-split'));

    expect(oneFile.errors).toEqual([]);
    expect(threeFiles.errors).toEqual([]);
    expect(serializeCompiledModel(threeFiles.model!)).toBe(serializeCompiledModel(oneFile.model!));
  });

  test('a compiled scenario with none of its optional fields set carries none of their keys at all', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: bare
    steps:
      - { id: s1, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);
    expect(errors).toEqual([]);

    const scenario = compileModel(loaded!).scenarios![0]!;
    for (const key of ['name', 'description', 'actor', 'requirements', 'alternatives']) {
      expect(Object.hasOwn(scenario, key), `compiled scenario must not carry "${key}"`).toBe(false);
    }
    expect(Object.hasOwn(scenario.steps[0]!, 'name')).toBe(false);
  });

  test('the compiled model with scenarios validates against the published compiled-model schema', () => {
    const { model, errors } = loadAndCompileModel(fixture('scenarios-example'));

    expect(errors).toEqual([]);
    expect(Value.Check(CompiledModelSchema, model)).toBe(true);
  });

  test('a scenario may repeat the same relation in several steps, at any level', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: twice
    steps:
      - { id: a, relation: checkout-places-order }
      - { id: b, relation: orders-publishes-placed }
      - { id: c, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(compileModel(loaded!).scenarios![0]!.steps.map((step) => step.relation)).toEqual([
      'checkout-places-order',
      'orders-publishes-placed',
      'checkout-places-order',
    ]);
  });

  test('a scenario\'s steps may name a refined relation, not only a coarse one', () => {
    const file = model(`elements:
  - id: checkout-api
    kind: service
  - id: checkout-payment-step
    kind: module
    parent: checkout-api
  - id: orders-api
    kind: service
relations:
  - id: checkout-pays-through-payments
    name: takes payment
    from: checkout-api
    to: orders-api
  - id: payment-step-authorizes
    name: authorizes the payment
    refines: checkout-pays-through-payments
    from: checkout-payment-step
    to: orders-api
scenarios:
  - id: pay
    steps:
      - { id: s1, relation: payment-step-authorizes }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(compileModel(loaded!).scenarios![0]!.steps[0]).toEqual({ id: 's1', relation: 'payment-step-authorizes' });
  });
});

describe('intended-model/scenarios: refusals', () => {
  test('alternative-at-unknown-step: an alternative starting at a step the main flow does not have is refused, naming everything', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
      - { id: s2, relation: orders-publishes-placed }
    alternatives:
      - id: card-declined
        at: s9
        when: the payment is declined
        steps:
          - { id: d1, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, 'at: s9'),
        path: 'scenarios[0].alternatives[0].at',
        message: expect.stringContaining('s9'),
      }),
    );
    expect(errors[0]!.message).toContain('"place-order"');
    expect(errors[0]!.message).toContain('"card-declined"');
    expect(errors[0]!.message).toContain('main flow');
  });

  test('malformed-requirement-id: a requirement with no capability is refused, naming the scenario, its file and line', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    requirements: [place-order]
    steps:
      - { id: s1, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, 'requirements: [place-order]'),
        path: 'scenarios[0].requirements[0]',
        message: expect.stringContaining('capability/requirement'),
      }),
    );
    expect(errors[0]!.message).toContain('"place-order"');
  });

  test('the malformed-requirement error names the requirement id itself, not only the scenario', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: sign-in
    requirements: [no-slash]
    steps:
      - { id: s1, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('"no-slash"');
    expect(errors[0]!.message).toContain('"sign-in"');
  });

  test('a requirement id with an empty capability or requirement part is refused', () => {
    for (const malformed of ['/place-order', 'ordering/', 'ordering//x', 'ordering/place-order/extra']) {
      const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    requirements: [${JSON.stringify(malformed)}]
    steps:
      - { id: s1, relation: checkout-places-order }
`);
      const { model: loaded, errors } = parseModel([file]);

      expect(loaded, `"${malformed}" must be refused`).toBeUndefined();
      expect(errors.some((e) => e.path === 'scenarios[0].requirements[0]'), `"${malformed}" must be refused at its own entry`).toBe(true);
    }
  });

  test('a malformed requirement listed one to a line names that entry own line', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    requirements:
      - ordering/place-order
      - place-order
    steps:
      - { id: s1, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, '      - place-order'),
        path: 'scenarios[0].requirements[1]',
        message: expect.stringContaining('"place-order"'),
      }),
    );
    expect(errors).toHaveLength(1);
  });

  test('a requirement id of the right form with dots, dashes and underscores loads', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    requirements: [intended_model.1/scenario-steps_2]
    steps:
      - { id: s1, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(loaded).toBeDefined();
  });

  test('a scenario with no step is refused, naming the scenario, its file and line', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: empty
    steps: []
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, 'steps: []'),
        path: 'scenarios[0].steps',
        message: expect.stringContaining('"empty"'),
      }),
    );
  });

  test('an alternative with no step is refused, naming the scenario and the alternative', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
    alternatives:
      - id: card-declined
        at: s1
        when: the payment is declined
        steps: []
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, 'steps: []'),
        path: 'scenarios[0].alternatives[0].steps',
        message: expect.stringContaining('"card-declined"'),
      }),
    );
    expect(errors[0]!.message).toContain('"place-order"');
  });

  test('an alternative whose "when" is blank is refused, like a relation with a blank name', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
    alternatives:
      - id: card-declined
        at: s1
        when: ''
        steps:
          - { id: d1, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', line: lineIn(file, "when: ''"), path: 'scenarios[0].alternatives[0].when' }),
    );
  });

  test('a scenario with no steps field at all is refused like one with an empty list', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: empty
    name: Empty
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors.some((e) => e.path === 'scenarios[0].steps' && e.message.includes('"empty"'))).toBe(true);
  });

  test('an alternative with no steps field at all is refused like one with an empty list', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
    alternatives:
      - id: card-declined
        at: s1
        when: the payment is declined
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors.some((e) => e.path === 'scenarios[0].alternatives[0].steps')).toBe(true);
  });
});

describe('intended-model/ids, for scenarios', () => {
  test('refuses two scenarios with the same id, naming both places', () => {
    const first = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
`);
    const second = {
      path: 'madarch/b.yaml',
      text: `version: 1\nelements: []\nscenarios:\n  - id: place-order\n    steps:\n      - { id: s1, relation: checkout-places-order }\n`,
    };
    const { model: loaded, errors } = parseModel([first, second]);

    expect(loaded).toBeUndefined();
    const inFirst = errors.find((e) => e.file === 'madarch/model.yaml' && e.path === 'scenarios[0].id')!;
    const inSecond = errors.find((e) => e.file === 'madarch/b.yaml' && e.path === 'scenarios[0].id')!;
    expect(inFirst).toBeDefined();
    expect(inSecond).toBeDefined();
    expect(inFirst.message).toContain('scenario id "place-order"');
    expect(inFirst.message).toContain(`madarch/b.yaml:${lineIn(second, '- id: place-order')}`);
  });

  test('duplicate-step-id: two steps of one scenario with the same id are refused, naming the scenario, both lines and the id', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
      - { id: s2, relation: orders-publishes-placed }
      - { id: s2, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    const atBoth = errors.filter((e) => e.message.includes('step id "s2"'));
    expect(atBoth).toHaveLength(2);
    expect(atBoth.map((e) => e.path).sort()).toEqual(['scenarios[0].steps[1].id', 'scenarios[0].steps[2].id']);
    expect(atBoth.map((e) => e.line).sort()).toEqual([lineIn(file, '- { id: s2, relation: orders-publishes-placed'), lineIn(file, '- { id: s2, relation: checkout-places-order }')].sort());
    expect(atBoth[0]!.message).toContain('"place-order"');
    const otherLine = atBoth.map((e) => e.line).find((line) => line !== atBoth[0]!.line)!;
    expect(atBoth[0]!.message.endsWith(`; also written at madarch/model.yaml:${otherLine}`)).toBe(true);
  });

  test('the same step id in two scenarios is an answer, not a duplicate', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: first
    steps:
      - { id: s1, relation: checkout-places-order }
  - id: second
    steps:
      - { id: s1, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(loaded?.scenarios).toHaveLength(2);
  });

  test('a step id shared by a scenario\'s main flow and one of its alternatives is an answer', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
    alternatives:
      - id: card-declined
        at: s1
        when: the payment is declined
        steps:
          - { id: s1, relation: orders-publishes-placed }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(loaded?.scenarios[0]?.alternatives?.[0]?.steps?.map((step) => step.id)).toEqual(['s1']);
  });

  test('two steps of one alternative with the same id are refused, naming the scenario and the alternative', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
    alternatives:
      - id: card-declined
        at: s1
        when: the payment is declined
        steps:
          - { id: d1, relation: checkout-places-order }
          - { id: d2, relation: orders-publishes-placed }
          - { id: d1, relation: checkout-shows-error }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    const atAll = errors.filter((e) => e.message.includes('step id "d1"'));
    expect(atAll).toHaveLength(2);
    expect(atAll.map((e) => e.path).sort()).toEqual([
      'scenarios[0].alternatives[0].steps[0].id',
      'scenarios[0].alternatives[0].steps[2].id',
    ]);
    expect(atAll[0]!.message).toContain('"place-order"');
    const otherLines = atAll.map((e) => e.line).filter((line) => line !== atAll[0]!.line);
    for (const line of otherLines) expect(atAll[0]!.message).toContain(`madarch/model.yaml:${line}`);
  });

  test('an alternative id repeated within its scenario is refused', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
    alternatives:
      - id: card-declined
        at: s1
        when: the payment is declined
        steps:
          - { id: d1, relation: checkout-places-order }
      - id: card-declined
        at: s1
        when: the card is cancelled
        steps:
          - { id: d1, relation: orders-publishes-placed }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    const atBoth = errors.filter((e) => e.message.includes('alternative id "card-declined"'));
    expect(atBoth).toHaveLength(2);
    expect(atBoth.map((e) => e.path).sort()).toEqual(['scenarios[0].alternatives[0].id', 'scenarios[0].alternatives[1].id']);
    expect(atBoth[0]!.message).toContain('"place-order"');
  });

  test('an alternative id equal to a step id of its scenario is an answer: they are different namespaces', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
    alternatives:
      - id: s1
        at: s1
        when: the payment is declined
        steps:
          - { id: d1, relation: orders-publishes-placed }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(errors).toEqual([]);
    expect(loaded?.scenarios[0]?.alternatives?.[0]?.id).toBe('s1');
  });

  test('refuses a scenario id of invalid syntax, naming its file, line, path and kind', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: "bad id"
    steps:
      - { id: s1, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      file: 'madarch/model.yaml',
      line: lineIn(file, '- id: "bad id"'),
      path: 'scenarios[0].id',
    });
  });

  test('refuses a step id and an alternative id of invalid syntax, at their file, line and path', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: "bad step", relation: checkout-places-order }
    alternatives:
      - id: "bad alt"
        at: "bad step"
        when: the payment is declined
        steps:
          - { id: d1, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', line: lineIn(file, 'bad step'), path: 'scenarios[0].steps[0].id' }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', line: lineIn(file, '"bad alt"'), path: 'scenarios[0].alternatives[0].id' }),
    );
  });
});

describe('intended-model/references, for scenarios', () => {
  test('step-over-missing-relation: a step naming a relation that does not exist is refused, naming the scenario, the step and the relation', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
      - { id: s4, relation: inventory-reserves-stock }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: lineIn(file, 'inventory-reserves-stock'),
        path: 'scenarios[0].steps[1].relation',
        message: expect.stringContaining('"inventory-reserves-stock"'),
      }),
    );
    expect(errors[0]!.message).toContain('"place-order"');
    expect(errors[0]!.message).toContain('"s4"');
    expect(errors[0]!.message).toContain(`scenario "place-order"'s step "s4" names relation "inventory-reserves-stock", which does not exist`);
  });

  test('an alternative step naming an unknown relation is refused at its own line', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
    alternatives:
      - id: card-declined
        at: s1
        when: the payment is declined
        steps:
          - { id: d1, relation: nowhere }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        line: lineIn(file, 'relation: nowhere'),
        path: 'scenarios[0].alternatives[0].steps[0].relation',
        message: expect.stringContaining('"nowhere"'),
      }),
    );
    expect(errors[0]!.message).toContain('"card-declined"');
  });

  test('a scenario naming an unknown actor is refused, naming the scenario and the actor', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    actor: customer
    steps:
      - { id: s1, relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        line: lineIn(file, 'actor: customer'),
        path: 'scenarios[0].actor',
        message: expect.stringContaining('"customer"'),
      }),
    );
    expect(errors[0]!.message).toContain('"place-order"');
  });

  test('a step of an unknown relation listed block-style names that step\'s own line', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - id: s1
        relation: checkout-places-order
      - id: s2
        relation: inventory-reserves-stock
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        line: lineIn(file, 'relation: inventory-reserves-stock'),
        path: 'scenarios[0].steps[1].relation',
      }),
    );
  });

  test('a relation declared by a file that failed its own schema check still resolves from another file', () => {
    const broken = {
      path: 'madarch/a.yaml',
      text: `version: 1
elements:
  - id: checkout-api
    kind: service
relations:
  - id: checkout-places-order
    name: places the order
    from: checkout-api
    to: checkout-api
    owner: someone
`,
    };
    const referring = model(`elements: []
scenarios:
  - id: place-order
    steps:
      - { id: s1, relation: checkout-places-order }
`);
    const { errors } = parseModel([broken, referring]);

    const unknownField = errors.find((e) => e.path === 'relations[0].owner')!;
    expect(unknownField).toBeDefined();
    expect(errors.filter((e) => e.message.includes('does not exist'))).toEqual([]);
  });
});

describe('intended-model/schema, for scenarios', () => {
  test('refuses an unknown field on a scenario, a step and an alternative, naming the full path', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    owner: someone
    steps:
      - { id: s1, relation: checkout-places-order, bogus: yes }
    alternatives:
      - id: card-declined
        at: s1
        when: the payment is declined
        steps:
          - { id: d1, relation: checkout-places-order }
        unless: never
`);
    const { errors } = parseModel([file]);

    expect(errors).toContainEqual(expect.objectContaining({ path: 'scenarios[0].owner', line: lineIn(file, 'owner: someone') }));
    expect(errors).toContainEqual(expect.objectContaining({ path: 'scenarios[0].steps[0].bogus', line: lineIn(file, 'bogus: yes') }));
    expect(errors).toContainEqual(expect.objectContaining({ path: 'scenarios[0].alternatives[0].unless', line: lineIn(file, 'unless: never') }));
  });

  test('refuses a step without a relation and an alternative without an id or an at', () => {
    const file = model(`${ELEMENTS}${RELATIONS}scenarios:
  - id: place-order
    steps:
      - { id: s1 }
      - { relation: checkout-places-order }
`);
    const { model: loaded, errors } = parseModel([file]);

    expect(loaded).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', line: lineIn(file, '- { id: s1 }'), path: 'scenarios[0].steps[0]', message: expect.stringContaining('relation') }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', line: lineIn(file, '- { relation: checkout-places-order }'), path: 'scenarios[0].steps[1]', message: expect.stringContaining('id') }),
    );
  });

  test('every independent problem is reported together, and a refused model produces no model', () => {
    const first = model(`elements: []
scenarios:
  - id: one
    steps:
      - { id: s1, relation: nowhere }
`);
    const second = {
      path: 'madarch/b.yaml',
      text: `version: 1
elements: []
scenarios:
  - id: two
    requirements: [no-slash]
    steps: []
`,
    };
    const { model: loaded, errors } = parseModel([first, second]);

    expect(loaded).toBeUndefined();
    expect(errors.filter((e) => e.message.includes('"nowhere"'))).toHaveLength(1);
    expect(errors.filter((e) => e.message.includes('capability/requirement'))).toHaveLength(1);
    expect(errors.filter((e) => e.path === 'scenarios[0].steps' && e.file === 'madarch/b.yaml')).toHaveLength(1);
  });
});

describe('the published schemas', () => {
  test('the compiled-model schema refuses an unknown field on a compiled scenario, a step and an alternative', () => {
    const { model } = loadAndCompileModel(fixture('scenarios-example'));

    const withRogueScenario = structuredClone(model!) as { scenarios: Record<string, unknown>[] };
    withRogueScenario.scenarios[0]!.rogue = true;
    expect(Value.Check(CompiledModelSchema, withRogueScenario)).toBe(false);

    const withRogueStep = structuredClone(model!) as { scenarios: { steps: Record<string, unknown>[] }[] };
    withRogueStep.scenarios.find((scenario) => scenario.steps.length > 1)!.steps[1]!.rogue = true;
    expect(Value.Check(CompiledModelSchema, withRogueStep)).toBe(false);

    const withRogueAlternative = structuredClone(model!) as { scenarios: { alternatives?: { steps: Record<string, unknown>[] }[] }[] };
    const withAlternatives = withRogueAlternative.scenarios.find((scenario) => scenario.alternatives !== undefined)!;
    withAlternatives.alternatives![0]!.steps[0]!.rogue = true;
    expect(Value.Check(CompiledModelSchema, withRogueAlternative)).toBe(false);
  });

  test('an intended model with an unknown field under scenarios is refused by the loader\'s schema check', () => {
    const file = model(`elements: []
scenarios:
  - id: one
    steps: []
    colour: blue
`);
    const { errors } = parseModel([file]);

    expect(errors.some((e) => e.path === 'scenarios[0].colour')).toBe(true);
  });
});

describe('compatibility: a model written before this change', () => {
  test('a model with no scenarios loads and compiles, and its compiled form carries no scenarios array', () => {
    const { model: compiled, errors, warnings } = loadAndCompileModel(fixture('valid-relation-full'));

    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('"checkout-uses-payments"'),
      expect.stringContaining('"checkout-charges-card"'),
    ]);
    expect(compiled).not.toHaveProperty('scenarios');
    expect(Value.Check(CompiledModelSchema, compiled)).toBe(true);
  });
});

describe('the writers\' reference documents scenarios', () => {
  test('the Scenario section names every field the schema defines, and the model file section names scenarios', () => {
    const reference = readFileSync(fileURLToPath(new URL('../skills/write-intended-model/reference.md', import.meta.url)), 'utf8');
    const section = reference.slice(reference.indexOf('## Scenario'), reference.indexOf('## The review report'));
    for (const field of ['id', 'name', 'description', 'actor', 'requirements', 'steps', 'alternatives']) {
      expect(section.includes(`\`${field}\``), `the Scenario section does not document \`${field}\``).toBe(true);
    }
    for (const stepField of ['id', 'relation', 'name']) {
      expect(section.includes(`\`${stepField}\``), `the Scenario section does not document the step field \`${stepField}\``).toBe(true);
    }
    for (const alternativeField of ['id', 'at', 'when', 'steps']) {
      expect(section.includes(`\`${alternativeField}\``), `the Scenario section does not document the alternative field \`${alternativeField}\``).toBe(true);
    }
  });
});

describe('the glossary names the new terms', () => {
  test('the glossary holds Data entity and Scenario, one line each of its style', () => {
    const glossary = readFileSync(fileURLToPath(new URL('../docs/glossary.md', import.meta.url)), 'utf8');

    for (const term of ['**Data entity**', '**Scenario**']) {
      expect(glossary.includes(term), `the glossary has no entry for ${term}`).toBe(true);
    }
  });
});

describe('the loader positions scenarios for the model check (madarch-hnq.1.3)', () => {
  test('every scenario exposes the file, the index and the lines of its fields, steps and alternatives', () => {
    const fixtureRoot = fixture('scenarios-example');
    const { positions } = loadAndCompileModel(fixtureRoot);

    expect(positions?.scenarios).toHaveLength(2);
    const placeOrder = positions?.scenarios.find((p) => p.scenario.id === 'place-order')!;
    expect(placeOrder).toBeDefined();

    const modelText = readFileSync(`${fixtureRoot}/madarch/model.yaml`, 'utf8');
    const at = (needle: string): number => modelText.split('\n').findIndex((line) => line.includes(needle)) + 1;

    expect(placeOrder.file).toBe('madarch/model.yaml');
    expect(placeOrder.index).toBe(0);
    expect(placeOrder.line).toBe(at('- id: place-order'));
    expect(placeOrder.idLine).toBe(at('- id: place-order'));
    expect(placeOrder.actorLine).toBe(at('actor: customer'));
    expect(placeOrder.requirementsLines).toEqual([at('requirements: [ordering/place-order]')]);
    expect(placeOrder.stepsLines).toHaveLength(2);
    expect(placeOrder.stepsLines[0]!.line).toBe(at('{ id: s1, relation: checkout-places-order }'));
    expect(placeOrder.stepsLines[0]!.idLine).toBe(at('{ id: s1, relation: checkout-places-order }'));
    expect(placeOrder.stepsLines[0]!.relationLine).toBe(at('{ id: s1, relation: checkout-places-order }'));
    expect(placeOrder.stepsLines[1]!.line).toBe(at('{ id: s2, relation: orders-publishes-placed'));
    expect(placeOrder.stepsLines[1]!.idLine).toBe(at('{ id: s2, relation: orders-publishes-placed'));
    expect(placeOrder.stepsLines[1]!.relationLine).toBe(at('{ id: s2, relation: orders-publishes-placed'));
    expect(placeOrder.stepsLines[1]!.step.name).toBe('the order is announced');

    expect(placeOrder.alternativesLines).toHaveLength(1);
    const alternative = placeOrder.alternativesLines[0]!;
    expect(alternative.line).toBe(at('- id: card-declined'));
    expect(alternative.idLine).toBe(at('- id: card-declined'));
    expect(alternative.whenLine).toBe(at('when: the payment is declined'));
    expect(alternative.atLine).toBe(at('at: s2'));
    expect(alternative.stepsLine).toBe(at('        steps:'));
    expect(alternative.stepsLines[0]!.line).toBe(at('{ id: d1, relation: checkout-shows-error }'));
  });

  test('a scenario without an actor still exposes an actor line as its own line', () => {
    const { positions } = loadAndCompileModel(fixture('scenarios-example'));
    const orderFails = positions?.scenarios.find((p) => p.scenario.id === 'order-fails')!;

    expect(orderFails.actorLine).toBe(orderFails.line);
    expect(orderFails.requirementsLines).toEqual([]);
    expect(orderFails.alternativesLines).toEqual([]);
    expect(orderFails.alternativesLines).toEqual([]);
  });
});
