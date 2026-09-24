import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import { loadAndCompileModel, parseModel, compileModel, serializeCompiledModel } from '../src/index.js';
import { CompiledModel } from '../src/model/compiled-schema.js';

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function schemaFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../schema/${name}`, import.meta.url)), 'utf8');
}

describe('S5/line accuracy: every error names the full path from the model top, at the right line', () => {
  test('an element referencing an unknown zone, environment, since and until each carries its full path', () => {
    const { model, errors } = loadAndCompileModel(fixture('all-errors'));
    expect(model).toBeUndefined();
    // Sanity: at least the paths this suite cares about are full paths from
    // the model's top, never bare field names.
    for (const error of errors) {
      if (error.path === '') continue;
      expect(error.path).toMatch(/^(elements|interfaces|relations|categories|zones|environments|states)\[\d+\]/);
    }
  });

  test('a relation\'s "refines", an interface\'s "provider" and a state\'s "after" all carry their section and index', () => {
    const { errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
states:
  - id: as-is
  - id: to-be
    after: nope
elements:
  - id: a
    kind: service
interfaces:
  - id: i
    provider: nope
    contract: http::GET::/x
relations:
  - id: r
    from: a
    to: a
    refines: nope
`,
      },
    ]);

    expect(errors).toContainEqual(expect.objectContaining({ path: 'states[1].after' }));
    expect(errors).toContainEqual(expect.objectContaining({ path: 'interfaces[0].provider' }));
    expect(errors).toContainEqual(expect.objectContaining({ path: 'relations[0].refines' }));
  });

  test('an environment\'s zone change on an element names the full path, including the element id', () => {
    const { errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
zones:
  - id: pci
    kind: regulatory
elements:
  - id: payments-api
    kind: service
environments:
  - id: production
    zones:
      payments-api:
        exclude: [pci]
`,
      },
    ]);

    expect(errors).toContainEqual(expect.objectContaining({ path: 'environments[0].zones.payments-api.exclude[0]' }));
  });

  test('a contract that does not parse points at its "contract:" line, with the full path', () => {
    const fixtureRoot = fixture('invalid-contract');
    const lines = readFileSync(`${fixtureRoot}/madarch/model.yaml`, 'utf8').split('\n');
    const contractLine = lines.findIndex((l) => l.trim().startsWith('contract:')) + 1;
    expect(contractLine).toBeGreaterThan(0);

    const { errors } = loadAndCompileModel(fixtureRoot);

    const error = errors.find((e) => e.path === 'interfaces[0].contract');
    expect(error).toBeDefined();
    expect(error?.line).toBe(contractLine);
  });

  test('anchor, alias, merge-key and tag errors carry their path too', () => {
    const { errors: anchorErrors } = parseModel([
      { path: 'm.yaml', text: 'version: 1\nelements:\n  - &shop\n    id: shop\n    kind: domain\n  - <<: *shop\n    id: shop2\n    kind: domain\n' },
    ]);
    expect(anchorErrors.find((e) => e.message.includes('anchor'))?.path).toBe('elements[0]');
    expect(anchorErrors.find((e) => e.message.includes('merge key'))?.path).toBe('elements[1]');
    expect(anchorErrors.find((e) => e.message.includes('alias'))?.path).toBe('elements[1].<<');

    const { errors: tagErrors } = parseModel([{ path: 'm.yaml', text: 'version: 1\nelements:\n  - id: !!str a\n    kind: !custom service\n' }]);
    expect(tagErrors.find((e) => e.message.includes('tag:yaml.org'))?.path).toBe('elements[0].id');
    expect(tagErrors.find((e) => e.message.includes('!custom'))?.path).toBe('elements[0].kind');
  });

  test('a duplicate id and an unrelated reference error each carry their exact "id"/"parent" line', () => {
    const { errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
elements:
  - id: a
    kind: service
    parent: nope
  - kind: service
    id: b
  - id: b
    kind: module
`,
      },
    ]);

    const idErrors = errors.filter((e) => e.path.endsWith('.id'));
    expect(idErrors.length).toBe(2);
    // The second element's "id" is not its first key: the id-specific line
    // must still be found, not the item's own (first-key) line.
    const secondElementIdError = idErrors.find((e) => e.path === 'elements[1].id')!;
    expect(secondElementIdError.line).toBe(7); // the "id: b" line, not line 6 ("kind: service")

    expect(errors).toContainEqual(expect.objectContaining({ path: 'elements[0].parent' }));
  });
});

describe('S1/O5: a file that fails its own schema still contributes its declared ids', () => {
  test('a correct reference from one file into another file\'s element is not reported as missing, even though that file also has an unrelated schema mistake', () => {
    const { model, errors } = parseModel([
      { path: 'a.yaml', text: 'version: 1\nelements:\n  - id: shop\n    kind: domain\n    owner: bob\n' },
      { path: 'b.yaml', text: 'version: 1\nelements:\n  - id: web\n    kind: service\n    parent: shop\n' },
    ]);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(expect.objectContaining({ file: 'a.yaml', message: expect.stringContaining('owner') }));
    // The crucial assertion: no error says "shop" does not exist.
    expect(errors.some((e) => e.message.includes('"shop"') && e.message.includes('does not exist'))).toBe(false);
  });

  test('does not throw even when the only definition of a referenced id lives in the broken file', () => {
    expect(() =>
      parseModel([
        { path: 'a.yaml', text: 'version: 1\nelements:\n  - id: shop\n    kind: domain\n    owner: bob\n' },
        { path: 'b.yaml', text: 'version: 1\nelements:\n  - id: web\n    kind: service\n    parent: shop\n' },
      ]),
    ).not.toThrow();
  });
});

describe('parseModel: no files, and a repeated file path, are both refused', () => {
  test('parseModel([]) is refused, like the empty folder', () => {
    const { model, errors } = parseModel([]);
    expect(model).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain('no model');
  });

  test('parseModel with the same file path twice is refused, naming the path', () => {
    const file = { path: 'x.yaml', text: 'version: 1\nelements:\n  - id: a\n    kind: service\n' };
    const { model, errors } = parseModel([file, file]);
    expect(model).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes('x.yaml'))).toBe(true);
  });
});

describe('B1: "version: 1" as a string gives one error, not two', () => {
  test('a string version reports exactly one error', () => {
    const { errors } = parseModel([{ path: 'm.yaml', text: 'version: "1"\nelements: []\n' }]);
    const versionErrors = errors.filter((e) => e.path === 'version');
    expect(versionErrors.length).toBe(1);
    expect(versionErrors[0]?.message).toContain('1');
  });
});

describe('presence and zones: inheritance, narrowing and the fixed own-exclude-in-environment bug', () => {
  test("an element's states are inherited from its parent (narrowed by the parent's until)", () => {
    const { model, errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
states:
  - id: as-is
  - id: to-be
    after: as-is
elements:
  - id: p
    kind: domain
    until: to-be
  - id: c
    kind: service
    parent: p
`,
      },
    ]);
    expect(errors).toEqual([]);
    const compiled = compileModel(model!);
    expect(compiled.elements.find((e) => e.id === 'c')?.states).toEqual(['as-is']);
  });

  test("a refinement's states and environments are narrowed by the relation it refines", () => {
    const { model, errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
states:
  - id: as-is
  - id: to-be
    after: as-is
elements:
  - id: a
    kind: service
  - id: b
    kind: service
relations:
  - id: g
    from: a
    to: b
    until: to-be
  - id: r
    refines: g
    from: a
    to: b
`,
      },
    ]);
    expect(errors).toEqual([]);
    const compiled = compileModel(model!);
    // "r" inherits "g"'s presence through "refines", narrowed to as-is only.
    expect(compiled.relations.find((r) => r.id === 'r')?.states).toEqual(['as-is']);
  });

  test("a relation's states are intersected with its \"to\" end, not just its \"from\" end", () => {
    const { model, errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
states:
  - id: as-is
  - id: to-be
    after: as-is
elements:
  - id: a
    kind: service
  - id: b
    kind: service
    since: to-be
relations:
  - id: r
    from: a
    to: b
`,
      },
    ]);
    expect(errors).toEqual([]);
    const compiled = compileModel(model!);
    // "b" only exists from to-be on; the relation must follow, even though
    // "a" (the "from" end) exists in every state.
    expect(compiled.relations.find((r) => r.id === 'r')?.states).toEqual(['to-be']);
  });

  test("an environment's zone change to an element is inherited by that element's descendants", () => {
    const { model, errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
zones:
  - id: dmz
    kind: network
elements:
  - id: p
    kind: domain
  - id: c
    kind: service
    parent: p
environments:
  - id: production
    zones:
      p:
        add: [dmz]
`,
      },
    ]);
    expect(errors).toEqual([]);
    const compiled = compileModel(model!);
    expect(compiled.elements.find((e) => e.id === 'c')?.zonesByEnvironment.production).toEqual(['dmz']);
  });

  test("a child excluding a zone its parent already lost, in one environment, is refused there (zones.ts own-exclude)", () => {
    const { model, errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
zones:
  - id: pci
    kind: regulatory
environments:
  - id: production
    zones:
      p:
        exclude: [pci]
elements:
  - id: p
    kind: domain
    zones:
      add: [pci]
  - id: c
    kind: service
    parent: p
    zones:
      exclude: [pci]
`,
      },
    ]);

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.path === 'elements[1].zones.exclude[0]');
    expect(error).toBeDefined();
    expect(error?.message).toContain('production');
    expect(error?.message).toContain('pci');

    // The same exclude is perfectly valid in general (no environment
    // involved): it must not also be reported as a general mistake.
    expect(errors.some((e) => e.message.includes('excludes zone "pci", which it would not be in"'))).toBe(false);
  });
});

describe("an element naming an environment its parent is absent from is refused, naming both", () => {
  test('refuses, instead of silently narrowing', () => {
    const { model, errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
environments:
  - id: test
  - id: production
elements:
  - id: p
    kind: domain
    environments: [test]
  - id: c
    kind: service
    parent: p
    environments: [test, production]
`,
      },
    ]);

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.path === 'elements[1].environments[1]');
    expect(error).toBeDefined();
    expect(error?.message).toContain('"c"');
    expect(error?.message).toContain('"p"');
    expect(error?.message).toContain('production');
  });
});

describe('S9/O4: bindings survive a variable literally named "__proto__" or "constructor"', () => {
  test('"__proto__" and "constructor" binding variables both survive into the compiled model', () => {
    const { model, errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
environments:
  - id: test
    bindings:
      __proto__: http://one
      constructor: http://two
      URL: http://three
elements:
  - id: a
    kind: service
relations:
  - id: r1
    from: a
    to: a
    binding:
      env: __proto__
  - id: r2
    from: a
    to: a
    binding:
      env: constructor
`,
      },
    ]);

    expect(errors).toEqual([]);
    const compiled = compileModel(model!);
    const env = compiled.environments.find((e) => e.id === 'test')!;
    expect(Object.prototype.hasOwnProperty.call(env.bindings, '__proto__')).toBe(true);
    expect(env.bindings?.__proto__).toBe('http://one');
    expect(Object.prototype.hasOwnProperty.call(env.bindings, 'constructor')).toBe(true);
    expect(env.bindings?.['constructor']).toBe('http://two');

    const r1 = compiled.relations.find((r) => r.id === 'r1')!;
    const r2 = compiled.relations.find((r) => r.id === 'r2')!;
    expect(r1.bindingByEnvironment?.test).toBe('http://one');
    expect(r2.bindingByEnvironment?.test).toBe('http://two');

    // Round-tripping through JSON (what actually gets written to model.json)
    // must not lose either variable either.
    const roundTripped = JSON.parse(serializeCompiledModel(compiled));
    expect(roundTripped.environments[0].bindings.__proto__).toBe('http://one');
    expect(roundTripped.environments[0].bindings.constructor).toBe('http://two');
  });
});

describe('S6: bindingByEnvironment across two environments', () => {
  test('the reference example\'s relation carries a different bound address in each environment', () => {
    const { model, errors } = loadAndCompileModel(fixture('environments-two'));

    expect(errors).toEqual([]);
    const relation = model?.relations.find((r) => r.id === 'checkout-charges-card');
    expect(relation?.bindingByEnvironment).toEqual({
      test: 'http://payments-stub.test.internal',
      production: 'https://payments.prod.internal',
    });
  });
});

describe('the reference example validates against the committed compiled-model schema file', () => {
  test('compiles and matches schema/compiled-model.schema.json, with every interface, relation and category present', () => {
    const { model, errors } = loadAndCompileModel(fixture('reference-example'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();

    // The committed file, not the TypeBox source: read as plain JSON and
    // checked against as a schema in its own right, so this test would
    // catch the schema file going stale even if `renderSchema` itself had
    // a bug that both produced and re-validated with the same mistake.
    const schema: unknown = JSON.parse(schemaFile('compiled-model.schema.json'));
    const checkAgainstFile = Value.Check as (type: unknown, value: unknown) => boolean;
    expect(checkAgainstFile(schema, model)).toBe(true);
    // Also against the TypeBox value directly (the schema file is only
    // ever a rendering of it).
    expect(Value.Check(CompiledModel, model)).toBe(true);

    expect(model?.interfaces.map((i) => i.id).sort()).toEqual(['payments-charge']);
    expect(model?.relations.map((r) => r.id).sort()).toEqual(['checkout-charges-card', 'checkout-uses-payments']);
    expect(model?.categories.map((c) => c.id).sort()).toEqual(['payment-card', 'personal']);
  });
});

describe('performance: a 10 000-element model loads and compiles in reasonable time', () => {
  test.skipIf(process.env['MADARCH_SKIP_PERF'] !== undefined)('a flat, 10 000-element model compiles quickly', () => {
    let text = 'version: 1\nelements:\n';
    for (let i = 0; i < 10000; i++) text += `  - id: e${i}\n    kind: service\n`;
    text += 'relations:\n';
    for (let i = 1; i < 10000; i++) text += `  - id: r${i}\n    from: e${i}\n    to: e${(i * 7) % 10000}\n`;

    const started = performance.now();
    const { model, errors } = parseModel([{ path: 'm.yaml', text }]);
    const elapsed = performance.now() - started;

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
    if (process.env['CI']) {
      // eslint-disable-next-line no-console
      console.log(`10 000-element model: ${Math.round(elapsed)}ms`);
    } else {
      expect(elapsed).toBeLessThan(5000);
    }
  });
});

describe('state chain and since/until errors: exact path and line', () => {
  test('two states both naming the same "after" are each reported at their own "after" line and path', () => {
    const { errors } = parseModel([
      { path: 'm.yaml', text: 'version: 1\nelements: []\nstates:\n  - id: s0\n  - id: s1\n    after: s0\n  - id: s2\n    after: s0\n' },
    ]);
    expect(errors).toContainEqual(expect.objectContaining({ path: 'states[1].after', line: 6, message: expect.stringContaining('cannot branch') }));
    expect(errors).toContainEqual(expect.objectContaining({ path: 'states[2].after', line: 8, message: expect.stringContaining('cannot branch') }));
  });

  test('every state naming "after" (no first state) is reported at the first state\'s own line', () => {
    const { errors } = parseModel([{ path: 'm.yaml', text: 'version: 1\nelements: []\nstates:\n  - id: s0\n    after: s0\n' }]);
    expect(errors).toContainEqual(expect.objectContaining({ path: 'states[0].after', line: 4, message: expect.stringContaining('no first state') }));
  });

  test('two roots (all first states) are each reported at their own line', () => {
    const { errors } = parseModel([{ path: 'm.yaml', text: 'version: 1\nelements: []\nstates:\n  - id: s0\n  - id: s1\n' }]);
    expect(errors).toContainEqual(expect.objectContaining({ path: 'states[0].after', line: 4, message: expect.stringContaining('all first states') }));
    expect(errors).toContainEqual(expect.objectContaining({ path: 'states[1].after', line: 5, message: expect.stringContaining('all first states') }));
  });

  test('a leftover state outside the chain (a separate cycle) is reported at its own "after" line', () => {
    const { errors } = parseModel([
      {
        path: 'm.yaml',
        text: 'version: 1\nelements: []\nstates:\n  - id: root\n  - id: x\n    after: y\n  - id: y\n    after: x\n',
      },
    ]);
    const cycleErrors = errors.filter((e) => e.message.includes('cycle of "after"'));
    expect(cycleErrors).toContainEqual(expect.objectContaining({ path: 'states[1].after', line: 6 }));
    expect(cycleErrors).toContainEqual(expect.objectContaining({ path: 'states[2].after', line: 8 }));
  });

  test('an element\'s since/until out of order is reported at "elements[i].since"', () => {
    const { errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
states:
  - id: as-is
  - id: to-be
    after: as-is
elements:
  - id: a
    kind: service
    since: to-be
    until: as-is
`,
      },
    ]);
    const error = errors.find((e) => e.message.includes('does not come before'));
    expect(error).toBeDefined();
    expect(error?.path).toBe('elements[0].since');
    expect(error?.line).toBe(9);
  });

  test('a relation\'s since/until out of order is reported at "relations[i].since"', () => {
    const { errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
states:
  - id: as-is
  - id: to-be
    after: as-is
elements:
  - id: a
    kind: service
relations:
  - id: r
    from: a
    to: a
    since: to-be
    until: as-is
`,
      },
    ]);
    const error = errors.find((e) => e.message.includes('does not come before'));
    expect(error).toBeDefined();
    expect(error?.path).toBe('relations[0].since');
    expect(error?.line).toBe(13);
  });

  test('"zones" combining "replace" with "add" is reported at "elements[i].zones"', () => {
    const { errors } = parseModel([
      {
        path: 'm.yaml',
        text: 'version: 1\nzones:\n  - id: z\n    kind: k\nelements:\n  - id: a\n    kind: service\n    zones:\n      replace: [z]\n      add: [z]\n',
      },
    ]);
    const error = errors.find((e) => e.message.includes('combines'));
    expect(error).toBeDefined();
    expect(error?.path).toBe('elements[0].zones');
    expect(error?.line).toBe(8);
  });
});

describe('parseModel: exact messages for no files and a repeated file path', () => {
  test('parseModel([]) message names "no model" exactly, at line 1 with an empty path', () => {
    const { errors } = parseModel([]);
    expect(errors).toEqual([{ file: '', line: 1, path: '', message: 'no model: parseModel was given no files; a model needs at least one' }]);
  });

  test('every path repeated more than once is reported, not just the first', () => {
    const files = [
      { path: 'a.yaml', text: 'version: 1\nelements: []\n' },
      { path: 'a.yaml', text: 'version: 1\nelements: []\n' },
      { path: 'b.yaml', text: 'version: 1\nelements: []\n' },
      { path: 'c.yaml', text: 'version: 1\nelements: []\n' },
      { path: 'c.yaml', text: 'version: 1\nelements: []\n' },
    ];
    const { errors } = parseModel(files);
    expect(errors.map((e) => e.message).sort()).toEqual([
      'the file path "a.yaml" is given more than once',
      'the file path "c.yaml" is given more than once',
    ]);
    for (const error of errors) {
      expect(error.line).toBe(1);
      expect(error.path).toBe('');
    }
  });

  test('a path given exactly once, alongside one given twice, is not reported', () => {
    const { errors } = parseModel([
      { path: 'a.yaml', text: 'version: 1\nelements: []\n' },
      { path: 'a.yaml', text: 'version: 1\nelements: []\n' },
      { path: 'b.yaml', text: 'version: 1\nelements: []\n' },
    ]);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toContain('a.yaml');
    expect(errors[0]?.message).not.toContain('b.yaml');
  });
});

describe('a schema-failing file\'s declared ids are collected from every section, tolerantly', () => {
  test('interfaces, relations, categories, zones, environments and states each contribute their declared ids too', () => {
    const { errors } = parseModel([
      {
        path: 'a.yaml',
        text: `version: 1
elements:
  - id: a
    kind: service
    owner: bob
interfaces:
  - id: iface1
    provider: a
    contract: http::GET::/x
relations:
  - id: rel1
    from: a
    to: a
categories:
  - id: cat1
zones:
  - id: zone1
    kind: k
environments:
  - id: env1
states:
  - id: as-is
`,
      },
      {
        path: 'b.yaml',
        text: `version: 1
elements:
  - id: b
    kind: service
interfaces:
  - id: iface2
    provider: b
    contract: http::GET::/y
relations:
  - id: rel2
    from: b
    to: b
    interface: iface1
    refines: rel1
    since: as-is
categories:
  - id: cat2
zones:
  - id: zone2
    kind: k
    add-does-not-exist: true
environments:
  - id: env2
    zones:
      b:
        add: [zone1]
`,
      },
    ]);

    // b.yaml itself has a schema mistake ("add-does-not-exist" is not a
    // field of a zone), so nothing about it compiles — but every reference
    // it makes into a.yaml's declared ids (iface1, rel1, cat... not used
    // here, zone1, as-is) must not be reported as missing.
    expect(errors.some((e) => e.message.includes('unknown field "add-does-not-exist"'))).toBe(true);
    expect(errors.some((e) => e.message.includes('does not exist'))).toBe(false);
  });

  test('a non-array section, and an array item that is not an object or has no string id, contribute nothing and do not throw', () => {
    expect(() =>
      parseModel([
        { path: 'a.yaml', text: 'version: 1\nelements:\n  - id: a\n    kind: service\n    owner: bob\nzones: "not an array"\n' },
        { path: 'b.yaml', text: 'version: 1\nelements:\n  - id: b\n    kind: service\n    parent: a\n' },
      ]),
    ).not.toThrow();
  });
});

describe('checkZones: exact path and line for the general and per-environment exclude/absent errors', () => {
  test('a general invalid exclude is reported at "elements[i].zones.exclude[j]"', () => {
    const { errors } = parseModel([
      { path: 'm.yaml', text: 'version: 1\nzones:\n  - id: z\n    kind: k\nelements:\n  - id: a\n    kind: service\n    zones:\n      exclude: [z]\n' },
    ]);
    const error = errors.find((e) => e.message.includes('would not be in') && !e.message.includes('environment'));
    expect(error).toBeDefined();
    expect(error?.path).toBe('elements[0].zones.exclude[0]');
    expect(error?.line).toBe(9);
  });

  test('an environment changing zones of an absent element is reported at "environments[i].zones.<id>"', () => {
    const { errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
zones:
  - id: z
    kind: k
environments:
  - id: test
  - id: production
elements:
  - id: a
    kind: service
    environments: [test]
    zones:
      add: [z]
`,
      },
    ]);
    const withEnvZones = `version: 1
zones:
  - id: z
    kind: k
environments:
  - id: test
  - id: production
    zones:
      a:
        add: [z]
elements:
  - id: a
    kind: service
    environments: [test]
`;
    const { errors: errors2 } = parseModel([{ path: 'm.yaml', text: withEnvZones }]);
    const error = errors2.find((e) => e.message.includes('does not exist in it'));
    expect(error).toBeDefined();
    expect(error?.path).toBe('environments[1].zones.a');
  });

  test('an environment\'s own invalid exclude is reported at "environments[i].zones.<id>.exclude[j]"', () => {
    const { errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
zones:
  - id: z
    kind: k
environments:
  - id: production
    zones:
      a:
        exclude: [z]
elements:
  - id: a
    kind: service
`,
      },
    ]);
    const error = errors.find((e) => e.message.includes('would not be in there'));
    expect(error).toBeDefined();
    expect(error?.path).toBe('environments[0].zones.a.exclude[0]');
    expect(error?.line).toBe(9);
  });
});

describe('environments.zones with several element keys: each key\'s add/exclude lines are its own', () => {
  test('two different elements named in one environment\'s "zones" each get their own reference-error line', () => {
    const { errors } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
zones:
  - id: pci
    kind: regulatory
elements:
  - id: a
    kind: service
  - id: b
    kind: service
environments:
  - id: production
  - id: staging
    zones:
      a:
        add: [nope-a]
      b:
        add: [nope-b]
`,
      },
    ]);

    const errorA = errors.find((e) => e.path === 'environments[1].zones.a.add[0]');
    const errorB = errors.find((e) => e.path === 'environments[1].zones.b.add[0]');
    expect(errorA).toBeDefined();
    expect(errorB).toBeDefined();
    expect(errorA?.line).not.toBe(errorB?.line);
    expect(errorA?.message).toContain('nope-a');
    expect(errorB?.message).toContain('nope-b');
  });
});

