import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import { loadAndCompileModel } from '../src/index.js';
import { CompiledModel } from '../src/model/compiled-schema.js';

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/** The 1-based line of the first line in `relativeYamlPath` matching `predicate`. */
function lineOf(fixtureRoot: string, relativeYamlPath: string, predicate: (line: string) => boolean): number {
  const lines = readFileSync(`${fixtureRoot}/${relativeYamlPath}`, 'utf8').split('\n');
  const index = lines.findIndex(predicate);
  expect(index).toBeGreaterThan(-1);
  return index + 1;
}

describe('zones', () => {
  test('inherit-add-exclude: an element is in its parent\'s zones unless it adds, excludes or replaces them', () => {
    const { model, errors } = loadAndCompileModel(fixture('zones-inherit-add-exclude'));

    expect(errors).toEqual([]);
    const api = model?.elements.find((e) => e.id === 'payments-api');
    const ui = model?.elements.find((e) => e.id === 'payments-ui');
    expect(api?.zones.sort()).toEqual(['internal', 'pci']);
    expect(ui?.zones.sort()).toEqual(['dmz']);
  });

  test('replace: an element replacing its zones is in only the replacement', () => {
    const { model, errors } = loadAndCompileModel(fixture('zones-replace'));

    expect(errors).toEqual([]);
    const batch = model?.elements.find((e) => e.id === 'payments-batch');
    expect(batch?.zones).toEqual(['batch']);
  });

  test('refuses excluding a zone the element would not be in, naming both', () => {
    const fixtureRoot = fixture('zones-exclude-not-in');
    const excludeLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === 'exclude: [pci]');

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.file === 'madarch/model.yaml' && e.line === excludeLine);
    expect(error).toBeDefined();
    expect(error?.message).toContain('payments-api');
    expect(error?.message).toContain('pci');
  });

  test('refuses an unknown zone named by an element', () => {
    const fixtureRoot = fixture('zones-unknown');
    const addLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === 'add: [pci]');

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.file === 'madarch/model.yaml' && e.line === addLine);
    expect(error).toBeDefined();
    expect(error?.message).toContain('pci');
  });

  test('refuses "replace" combined with "add" or "exclude"', () => {
    const { model, errors } = loadAndCompileModel(fixture('zones-replace-with-add'));

    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('replace') && e.message.includes('payments'))).toBe(true);
  });
});

describe('environments', () => {
  test('two-environments: a relation resolves to a different address per environment, and a zone add applies in one environment only', () => {
    const { model, errors } = loadAndCompileModel(fixture('environments-two'));

    expect(errors).toEqual([]);
    const test = model?.environments.find((e) => e.id === 'test');
    const production = model?.environments.find((e) => e.id === 'production');
    expect(test?.bindings).toEqual({ PAYMENTS_URL: 'http://payments-stub.test.internal' });
    expect(production?.bindings).toEqual({ PAYMENTS_URL: 'https://payments.prod.internal' });

    const api = model?.elements.find((e) => e.id === 'payments-api');
    expect(api?.zonesByEnvironment.test).toEqual([]);
    expect(api?.zonesByEnvironment.production).toEqual(['dmz']);
  });

  test('element-in-one-environment: an element naming environments exists only in those', () => {
    const { model, errors } = loadAndCompileModel(fixture('environments-element-in-one'));

    expect(errors).toEqual([]);
    const stub = model?.elements.find((e) => e.id === 'payments-stub');
    expect(stub?.environments).toEqual(['test']);
  });

  test('refuses an element naming an unknown environment', () => {
    const { model, errors } = loadAndCompileModel(fixture('environments-unknown-environment'));

    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('test'))).toBe(true);
  });

  test('refuses an environment naming an unknown element in its zones', () => {
    const { model, errors } = loadAndCompileModel(fixture('environments-unknown-element'));

    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('payments-ui'))).toBe(true);
  });

  test('refuses an environment adding an unknown zone to an element', () => {
    const { model, errors } = loadAndCompileModel(fixture('environments-unknown-zone'));

    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('pci'))).toBe(true);
  });
});

describe('states', () => {
  test('as-is-and-to-be: an element until a state exists before it and not after; one since a state is the reverse', () => {
    const { model, errors } = loadAndCompileModel(fixture('states-as-is-and-to-be'));

    expect(errors).toEqual([]);
    const legacy = model?.elements.find((e) => e.id === 'legacy-billing');
    const billing = model?.elements.find((e) => e.id === 'billing-api');
    expect(legacy?.states).toEqual(['as-is']);
    expect(billing?.states).toEqual(['to-be']);
  });

  test('a model with no states has the single state as-is', () => {
    const { model, errors } = loadAndCompileModel(fixture('one-element'));

    expect(errors).toEqual([]);
    expect(model?.states).toEqual([{ id: 'as-is' }]);
    expect(model?.elements[0]?.states).toEqual(['as-is']);
  });

  test('refuses branching states, naming the two that follow the same one', () => {
    const { model, errors } = loadAndCompileModel(fixture('states-branching'));

    expect(model).toBeUndefined();
    const error = errors[0]!;
    expect(error.message).toContain('target-a');
    expect(error.message).toContain('target-b');
  });

  test('refuses a chain of states with no first state', () => {
    const { model, errors } = loadAndCompileModel(fixture('states-cycle'));

    expect(model).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain('state-a');
  });

  test('refuses since not coming before until in the chain of states', () => {
    const { model, errors } = loadAndCompileModel(fixture('since-until-order'));

    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('billing-api'))).toBe(true);
  });

  test('refuses a state naming an unknown "after"', () => {
    const { model, errors } = loadAndCompileModel(fixture('states-unknown-after'));

    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('unknown-state'))).toBe(true);
  });

  test('a relation may also exist since a state and until a state', () => {
    const { model, errors } = loadAndCompileModel(fixture('relation-since-until'));

    expect(errors).toEqual([]);
    const relation = model?.relations.find((r) => r.id === 'checkout-uses-payments');
    expect(relation?.states).toEqual(['to-be']);
  });
});

describe('compiled-model shape, determinism, effective zones and presence', () => {
  test('the reference example of design.md compiles and validates against the published compiled-model schema', () => {
    const { model, errors } = loadAndCompileModel(fixture('reference-example'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
    expect(Value.Check(CompiledModel, model)).toBe(true);

    expect(model?.elements.map((e) => e.id).sort()).toEqual(
      ['billing-api', 'checkout-cart', 'checkout-web', 'legacy-billing', 'payments', 'payments-api', 'payments-stub', 'shop'].sort(),
    );
    expect(model?.zones.map((z) => z.id).sort()).toEqual(['dmz', 'pci']);
    expect(model?.environments.map((e) => e.id).sort()).toEqual(['production', 'test']);
    expect(model?.states.map((s) => s.id).sort()).toEqual(['as-is', 'to-be']);
  });

  test('compiling the reference example twice gives byte-identical output', () => {
    const first = loadAndCompileModel(fixture('reference-example'));
    const second = loadAndCompileModel(fixture('reference-example'));

    expect(first.errors).toEqual([]);
    expect(JSON.stringify(first.model)).toBe(JSON.stringify(second.model));
  });

  test('per-environment-zones: an element inheriting a zone, adding another and gaining a third in one environment only', () => {
    const { model, errors } = loadAndCompileModel(fixture('reference-example'));

    expect(errors).toEqual([]);
    const api = model?.elements.find((e) => e.id === 'payments-api');
    expect(api?.zones).toEqual(['pci']);
    expect(api?.zonesByEnvironment.test).toEqual(['pci']);
    expect(api?.zonesByEnvironment.production?.sort()).toEqual(['dmz', 'pci']);
  });

  test('presence: an element in one environment only, and an element since one state only', () => {
    const { model, errors } = loadAndCompileModel(fixture('reference-example'));

    expect(errors).toEqual([]);
    const stub = model?.elements.find((e) => e.id === 'payments-stub');
    const billingApi = model?.elements.find((e) => e.id === 'billing-api');
    expect(stub?.environments).toEqual(['test']);
    expect(billingApi?.states).toEqual(['to-be']);
  });

  test('a relation exists only where both its ends exist', () => {
    const { model, errors } = loadAndCompileModel(fixture('reference-example'));

    expect(errors).toEqual([]);
    const refined = model?.relations.find((r) => r.id === 'checkout-charges-card');
    // Both ends exist in every environment and in both states, so the
    // relation does too.
    expect(refined?.environments.sort()).toEqual(['production', 'test']);
    expect(refined?.states.sort()).toEqual(['as-is', 'to-be']);
  });
});
