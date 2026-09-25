import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import { CompiledModelSchema, loadAndCompileModel, loadModel, parseModel, type ModelWarning } from '../src/index.js';

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

describe('relation-names: every relation is named, or warned about', () => {
  test('unnamed-relation: the model loads, and the one warning names checkout-calls-orders with its file and line', () => {
    const { model, errors, warnings } = loadAndCompileModel(fixture('unnamed-relation'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning).toMatchObject({ file: 'madarch/model.yaml', line: 19, path: 'relations[1]' });
    expect(warning!.message).toContain('"checkout-calls-orders"');
    expect(warning!.message).toContain('no name');
  });

  test('the compiled model carries a relation\'s name, and leaves it out for an unnamed one', () => {
    const { model } = loadAndCompileModel(fixture('unnamed-relation'));

    const byId = new Map(model!.relations.map((relation) => [relation.id, relation]));
    expect(byId.get('orders-publishes-placed')?.name).toBe('publishes placed orders');
    expect(byId.get('checkout-calls-orders')).not.toHaveProperty('name');
    expect(Value.Check(CompiledModelSchema, model)).toBe(true);
  });

  test('each warning names its own file and the line of its relation, in file order', () => {
    const { model, errors, warnings } = loadAndCompileModel(fixture('unnamed-relations-two-files'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
    expect(warnings.map(({ file, line, path }) => ({ file, line, path }))).toEqual([
      { file: 'madarch/a-shop.yaml', line: 12, path: 'relations[0]' },
      { file: 'madarch/b-events.yaml', line: 16, path: 'relations[1].name' },
      { file: 'madarch/b-events.yaml', line: 20, path: 'relations[2].name' },
    ]);
    expect(warnings[0]!.message).toContain('"checkout-calls-orders"');
    expect(warnings[1]!.message).toContain('"checkout-reads-events"');
    expect(warnings[2]!.message).toContain('"orders-reads-events"');
  });

  test('an empty or whitespace-only name says nothing: it is warned about and left out of the compiled model', () => {
    const { model, warnings } = loadAndCompileModel(fixture('unnamed-relations-two-files'));

    expect(warnings[1]!.message).toContain('blank name');
    expect(warnings[2]!.message).toContain('blank name');
    const byId = new Map(model!.relations.map((relation) => [relation.id, relation]));
    expect(byId.get('checkout-reads-events')).not.toHaveProperty('name');
    expect(byId.get('orders-reads-events')).not.toHaveProperty('name');
    expect(byId.get('orders-publishes-placed')?.name).toBe('publishes placed orders');
  });

  test('a name with surrounding spaces is kept as written, and is not warned about', () => {
    const { model, errors, warnings } = parseModel([
      {
        path: 'm.yaml',
        text: `version: 1
elements:
  - id: a
    kind: service
  - id: b
    kind: service
relations:
  - id: a-to-b
    from: a
    to: b
    name: " calls b "
`,
      },
    ]);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(model?.relations[0]?.name).toBe(' calls b ');
  });

  test('a model whose relations are all named returns an empty list of warnings', () => {
    const { model, errors, warnings } = loadAndCompileModel(fixture('relation-names-all-named'));

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(model?.relations[0]?.name).toBe('places orders');
  });

  test('a model with no relations returns an empty list of warnings', () => {
    const { errors, warnings } = loadAndCompileModel(fixture('one-element'));

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('a model written before names existed still loads: no errors, one warning per relation', () => {
    const { model, errors, warnings } = loadAndCompileModel(fixture('valid-relation-full'));

    expect(errors).toEqual([]);
    expect(model?.relations.map((relation) => relation.id)).toEqual(['checkout-charges-card', 'checkout-uses-payments']);
    expect(warnings.map(({ file, line, path }) => ({ file, line, path }))).toEqual([
      { file: 'madarch/model.yaml', line: 29, path: 'relations[0]' },
      { file: 'madarch/model.yaml', line: 32, path: 'relations[1]' },
    ]);
  });

  test('loadModel returns the same warnings beside the validated model', () => {
    const { model, errors, warnings } = loadModel(fixture('unnamed-relation'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
    expect(warnings.map(({ file, line, path }) => ({ file, line, path }))).toEqual([
      { file: 'madarch/model.yaml', line: 19, path: 'relations[1]' },
    ]);
  });

  test('a refused model still reports the warnings of the relations it could read', () => {
    const { model, errors, warnings } = loadAndCompileModel(fixture('unknown-relation-to'));

    expect(model).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(warnings.map(({ file, line, path }) => ({ file, line, path }))).toEqual([
      { file: 'madarch/model.yaml', line: 9, path: 'relations[0]' },
    ]);
  });

  test('a model that cannot be read at all has no warnings', () => {
    expect(loadAndCompileModel(fixture('does-not-exist')).warnings).toEqual([]);
    const onlyYml = loadAndCompileModel(fixture('only-yml-file'));
    expect(onlyYml.errors.length).toBeGreaterThan(0);
    expect(onlyYml.warnings).toEqual([]);
    expect(parseModel([]).warnings).toEqual([]);
    expect(
      parseModel([
        { path: 'a.yaml', text: 'version: 1\nelements: []\n' },
        { path: 'a.yaml', text: 'version: 1\nelements: []\n' },
      ]).warnings,
    ).toEqual([]);
  });

  test('a file that does not match the schema contributes no warnings', () => {
    const { errors, warnings } = parseModel([
      {
        path: 'bad.yaml',
        text: `version: 1
elements:
  - id: a
    kind: service
    owner: someone
relations:
  - id: a-to-a
    from: a
    to: a
`,
      },
    ]);

    expect(errors.length).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  });

  test('a warning has the same shape as an error: file, line, path and message', () => {
    const { warnings } = loadAndCompileModel(fixture('unnamed-relation'));
    const warning: ModelWarning = warnings[0]!;

    expect(Object.keys(warning).sort()).toEqual(['file', 'line', 'message', 'path']);
  });
});
