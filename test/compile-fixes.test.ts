import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAndCompileModel, parseModel, compileModel, serializeCompiledModel, type ValidatedModel } from '../src/index.js';

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

describe('B2: an environment\'s zone change is checked like an element\'s', () => {
  test('refuses an environment excluding a zone the element is not in there, naming both', () => {
    const fixtureRoot = fixture('zones-exclude-not-in-environment');
    const excludeLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === 'exclude: [pci]');

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.file === 'madarch/model.yaml' && e.line === excludeLine);
    expect(error).toBeDefined();
    expect(error?.message).toContain('production');
    expect(error?.message).toContain('pci');
  });

  test('refuses an environment changing zones of an element absent from it, naming both', () => {
    const { model, errors } = loadAndCompileModel(fixture('environment-zones-absent-element'));

    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('production') && e.message.includes('"a"'))).toBe(true);
  });
});

describe('S2: presence is inherited', () => {
  test('an element exists in an environment only where its parent does', () => {
    const { model, errors } = loadAndCompileModel(fixture('presence-inherited-empty'));

    // c inherits p's restriction to "test"; x is restricted to "production";
    // the relation from c to x therefore exists nowhere.
    expect(model).toBeUndefined();
    const error = errors.find((e) => e.message.includes('relation "r"'));
    expect(error).toBeDefined();
    expect(error?.message).toContain('exists nowhere');
  });

  test('refuses "environments: []" naming at least one is required', () => {
    const { model, errors } = loadAndCompileModel(fixture('environments-empty-list'));

    expect(model).toBeUndefined();
    expect(errors.some((e) => e.message.includes('"a"') && e.message.includes('environments'))).toBe(true);
  });

  test('with no environments declared, the compiled presence says so explicitly', () => {
    const { model, errors } = loadAndCompileModel(fixture('one-element'));

    expect(errors).toEqual([]);
    expect(model?.elements[0]?.environments).toEqual(['*']);
  });
});

describe('S3: zonesByEnvironment lists only the environments the element exists in', () => {
  test('an element restricted to production has no "test" key in zonesByEnvironment', () => {
    const { model, errors } = loadAndCompileModel(fixture('zones-by-environment-restricted'));

    expect(errors).toEqual([]);
    const a = model?.elements.find((e) => e.id === 'a');
    expect(a?.environments).toEqual(['production']);
    expect(Object.keys(a?.zonesByEnvironment ?? {})).toEqual(['production']);
    expect(a?.zonesByEnvironment.production).toEqual(['dmz']);
  });
});

describe('S4: same model, same bytes', () => {
  function modelWith(evidenceOrder: string, transferOrder: string, bindingOrder: string): ValidatedModel {
    const text = `version: 1
environments:
  - id: test
    bindings:
${bindingOrder}
elements:
  - id: a
    kind: service
    evidence:
${evidenceOrder}
relations:
  - id: r
    from: a
    to: a
    transfers:
${transferOrder}
`;
    const { model, errors } = parseModel([{ path: 'm.yaml', text }]);
    expect(errors).toEqual([]);
    return model!;
  }

  test('reordering an object\'s keys in the source never changes the compiled bytes', () => {
    const first = modelWith(
      '      - file: f\n        line: 1',
      '      - direction: forward\n        confidentiality: c\n        categories: []',
      '      A: 1x\n      B: 2x',
    );
    const second = modelWith(
      '      - line: 1\n        file: f',
      '      - categories: []\n        direction: forward\n        confidentiality: c',
      '      B: 2x\n      A: 1x',
    );

    const firstBytes = serializeCompiledModel(compileModel(first));
    const secondBytes = serializeCompiledModel(compileModel(second));

    expect(firstBytes).toBe(secondBytes);
    expect(firstBytes.endsWith('\n')).toBe(true);
    expect(firstBytes.startsWith('{\n  ')).toBe(true);
  });

  test('serializeCompiledModel reproduces the reference example byte for byte across two loads', () => {
    const first = loadAndCompileModel(fixture('reference-example'));
    const second = loadAndCompileModel(fixture('reference-example'));

    expect(first.errors).toEqual([]);
    expect(serializeCompiledModel(first.model!)).toBe(serializeCompiledModel(second.model!));
  });
});

describe('S6: relations carry bindingByEnvironment', () => {
  test('an environment that leaves the binding variable unset has no key there, not an error', () => {
    const { model, errors } = loadAndCompileModel(fixture('binding-by-environment-partial'));

    expect(errors).toEqual([]);
    const relation = model?.relations.find((r) => r.id === 'r');
    expect(relation?.bindingByEnvironment).toEqual({ test: 'http://payments-stub.test.internal' });
    expect(relation?.bindingByEnvironment).not.toHaveProperty('production');
  });
});

describe('compiled shape, exhaustively (kills sort and optional-field mutants)', () => {
  test('an item with none of its optional fields set carries none of their keys at all (not even set to undefined)', () => {
    const { model, errors } = loadAndCompileModel(fixture('mutation-coverage'));

    expect(errors).toEqual([]);
    const elemB = model?.elements.find((e) => e.id === 'elem-b')!;
    for (const key of ['name', 'parent', 'technology', 'evidence']) expect(Object.hasOwn(elemB, key)).toBe(false);

    const relB = model?.relations.find((r) => r.id === 'rel-b')!;
    for (const key of ['refines', 'interface', 'binding', 'bindingByEnvironment', 'transfers', 'evidence']) {
      expect(Object.hasOwn(relB, key)).toBe(false);
    }

    const ifaceB = model?.interfaces.find((i) => i.id === 'iface-b')!;
    expect(Object.hasOwn(ifaceB, 'evidence')).toBe(false);
    const ifaceAEvidenceEntry = model?.interfaces.find((i) => i.id === 'iface-a')?.evidence?.[0]!;
    expect(Object.hasOwn(ifaceAEvidenceEntry, 'line')).toBe(false);

    const catB = model?.categories.find((c) => c.id === 'cat-b')!;
    expect(Object.hasOwn(catB, 'name')).toBe(false);
    const zoneB = model?.zones.find((z) => z.id === 'zone-b')!;
    expect(Object.hasOwn(zoneB, 'name')).toBe(false);
    const envB = model?.environments.find((e) => e.id === 'env-b')!;
    expect(Object.hasOwn(envB, 'name')).toBe(false);
    expect(Object.hasOwn(envB, 'bindings')).toBe(false);
    const asIs = model?.states.find((s) => s.id === 'as-is')!;
    expect(Object.hasOwn(asIs, 'name')).toBe(false);
    expect(Object.hasOwn(asIs, 'after')).toBe(false);
  });

  test('interaction is true for an interface alone, true for non-empty transfers alone, and false for empty transfers with no interface', () => {
    const { model, errors } = loadAndCompileModel(fixture('relation-interaction-cases'));

    expect(errors).toEqual([]);
    const byId = new Map(model?.relations.map((r) => [r.id, r]));
    expect(byId.get('interface-only')?.interaction).toBe(true);
    expect(byId.get('transfers-only')?.interaction).toBe(true);
    expect(byId.get('empty-transfers')?.interaction).toBe(false);
    expect(byId.get('neither')?.interaction).toBe(false);
  });

  test('every kind of item, out of id order and with every optional field exercised, compiles to the exact expected shape', () => {
    const { model, errors } = loadAndCompileModel(fixture('mutation-coverage'));

    expect(errors).toEqual([]);
    expect(model).toEqual({
      schemaVersion: 1,
      elements: [
        {
          id: 'elem-a',
          kind: 'service',
          ancestors: [],
          zones: ['zone-b'],
          zonesByEnvironment: { 'env-a': ['zone-b'], 'env-b': ['zone-b'] },
          environments: ['env-a', 'env-b'],
          states: ['as-is', 'to-be'],
          name: 'Element A',
          technology: 'TypeScript',
          evidence: [{ file: 'a.ts', line: 3 }],
        },
        {
          id: 'elem-b',
          kind: 'service',
          ancestors: [],
          zones: [],
          zonesByEnvironment: { 'env-a': ['zone-b'], 'env-b': [] },
          environments: ['env-a', 'env-b'],
          states: ['as-is', 'to-be'],
        },
      ],
      interfaces: [
        { id: 'iface-a', provider: 'elem-a', contract: 'data::a', evidence: [{ file: 'a.ts' }] },
        { id: 'iface-b', provider: 'elem-a', contract: 'data::b' },
      ],
      relations: [
        {
          id: 'rel-a',
          from: 'elem-a',
          to: 'elem-b',
          interaction: true,
          environments: ['env-a', 'env-b'],
          states: ['as-is', 'to-be'],
          interface: 'iface-a',
          binding: { env: 'URL' },
          bindingByEnvironment: { 'env-a': 'http://a.internal' },
          transfers: [{ direction: 'forward', confidentiality: 'internal', categories: ['cat-a'] }],
          evidence: [{ file: 'a.ts' }],
        },
        {
          id: 'rel-b',
          from: 'elem-a',
          to: 'elem-b',
          interaction: false,
          environments: ['env-a', 'env-b'],
          states: ['as-is', 'to-be'],
        },
      ],
      categories: [
        { id: 'cat-a', name: 'Category A' },
        { id: 'cat-b' },
      ],
      zones: [
        { id: 'zone-a', kind: 'regulatory', name: 'Zone A' },
        { id: 'zone-b', kind: 'network' },
      ],
      environments: [
        { id: 'env-a', name: 'Env A', bindings: { URL: 'http://a.internal' } },
        { id: 'env-b' },
      ],
      states: [{ id: 'as-is' }, { id: 'to-be', name: 'To be', after: 'as-is' }],
    });
  });

  test('adding a zone the element already inherits from its parent does not duplicate it', () => {
    const { model, errors } = loadAndCompileModel(fixture('zones-duplicate-add'));

    expect(errors).toEqual([]);
    const child = model?.elements.find((e) => e.id === 'child');
    expect(child?.zones).toEqual(['internal']);
  });
});

describe('O3: compiled states are listed in chain order', () => {
  test('the chain\'s order is kept even when it disagrees with alphabetical id order', () => {
    const { model, errors } = loadAndCompileModel(fixture('states-chain-order'));

    expect(errors).toEqual([]);
    expect(model?.states.map((s) => s.id)).toEqual(['z-first', 'a-second']);
  });
});
