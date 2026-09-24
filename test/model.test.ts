import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAndCompileModel } from '../src/index.js';

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

describe('loadAndCompileModel', () => {
  test('compiles a model folder with one element', () => {
    const { model, errors } = loadAndCompileModel(fixture('one-element'));

    expect(errors).toEqual([]);
    expect(model?.schemaVersion).toBe(1);
    expect(model?.elements).toEqual([{ id: 'shop', kind: 'domain', name: 'Shop' }]);
  });

  test('reports an unknown field with its file, line and path', () => {
    const fixtureRoot = fixture('unknown-field');
    const ownerLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim().startsWith('owner:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: ownerLine,
        path: 'elements[0].owner',
      }),
    );
  });

  test('loads normally once the unknown field is removed', () => {
    const { model, errors } = loadAndCompileModel(fixture('one-element'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });
});

describe('strict YAML', () => {
  test('refuses a duplicate key, naming the file and line', () => {
    const fixtureRoot = fixture('duplicate-key');
    const secondParentLine = lineOf(
      fixtureRoot,
      'madarch/model.yaml',
      (line) => line.trim() === 'parent: b',
    );

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    const error = errors.find((e) => e.file === 'madarch/model.yaml' && e.line === secondParentLine);
    expect(error).toBeDefined();
    expect(error?.message).toContain('parent');
  });

  test('refuses an anchor and its alias, naming the anchor line', () => {
    const fixtureRoot = fixture('anchor-alias');
    const anchorLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.includes('&shop'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: anchorLine,
      }),
    );
  });

  test('loads normally once the anchor and alias are removed', () => {
    const { model, errors } = loadAndCompileModel(fixture('two-elements'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });
});

describe('schema', () => {
  test('refuses a missing required field, naming the file, line and path', () => {
    const fixtureRoot = fixture('missing-required-field');
    const elementLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim().startsWith('- id: shop'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: elementLine,
        path: 'elements[0]',
      }),
    );
  });

  test('refuses a value of the wrong kind, naming the file, line and path', () => {
    const fixtureRoot = fixture('wrong-kind-of-value');
    const parentLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim().startsWith('parent:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: parentLine,
        path: 'elements[0].parent',
      }),
    );
  });

  test('reports three independent schema errors from two files at once', () => {
    const fixtureRoot = fixture('all-errors');
    const ownerLine = lineOf(fixtureRoot, 'madarch/first.yaml', (line) => line.trim().startsWith('owner:'));
    const checkoutLine = lineOf(fixtureRoot, 'madarch/first.yaml', (line) => line.trim().startsWith('- id: checkout'));
    const parentLine = lineOf(fixtureRoot, 'madarch/second.yaml', (line) => line.trim().startsWith('parent:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/first.yaml', line: ownerLine, path: 'elements[0].owner' }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/first.yaml', line: checkoutLine, path: 'elements[1]' }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/second.yaml', line: parentLine, path: 'elements[0].parent' }),
    );
  });

  test('loads normally once the schema errors are fixed', () => {
    const { model, errors } = loadAndCompileModel(fixture('two-elements'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });
});

describe('files', () => {
  test('a model split across three files compiles to the same output as one file', () => {
    const oneFile = loadAndCompileModel(fixture('split-model-one-file'));
    const threeFiles = loadAndCompileModel(fixture('split-model-three-files'));

    expect(oneFile.errors).toEqual([]);
    expect(threeFiles.errors).toEqual([]);
    expect(JSON.stringify(threeFiles.model)).toBe(JSON.stringify(oneFile.model));
  });
});

describe('ids', () => {
  test('refuses an id with invalid syntax', () => {
    const fixtureRoot = fixture('invalid-id-syntax');
    const idLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim().startsWith('- id:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', line: idLine }),
    );
  });

  test('loads normally once the id has valid syntax', () => {
    const { model, errors } = loadAndCompileModel(fixture('two-elements'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });

  test('refuses two elements with the same id, naming both files and lines', () => {
    const fixtureRoot = fixture('duplicate-element-id');
    const lineA = lineOf(fixtureRoot, 'madarch/a.yaml', (line) => line.trim().startsWith('- id:'));
    const lineB = lineOf(fixtureRoot, 'madarch/b.yaml', (line) => line.trim().startsWith('- id:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(expect.objectContaining({ file: 'madarch/a.yaml', line: lineA }));
    expect(errors).toContainEqual(expect.objectContaining({ file: 'madarch/b.yaml', line: lineB }));
  });
});

describe('references', () => {
  test('refuses an element whose parent does not exist', () => {
    const fixtureRoot = fixture('unknown-parent');
    const parentLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim().startsWith('parent:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.file === 'madarch/model.yaml' && e.line === parentLine);
    expect(error).toBeDefined();
    expect(error?.message).toContain('checkout-web');
    expect(error?.message).toContain('billing');
  });

  test('loads normally once the parent exists', () => {
    const { model, errors } = loadAndCompileModel(fixture('valid-parent'));

    expect(errors).toEqual([]);
    expect(model?.elements).toEqual([
      { id: 'checkout-web', kind: 'service', name: 'Checkout web', parent: 'shop' },
      { id: 'shop', kind: 'domain', name: 'Shop' },
    ]);
  });
});

describe('nesting', () => {
  test('refuses a cycle of parents, naming the elements in it', () => {
    const fixtureRoot = fixture('parent-cycle');

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    const error = errors[0]!;
    expect(error.message).toContain('"a"');
    expect(error.message).toContain('"b"');
  });

  test('loads normally once the cycle is broken', () => {
    const { model, errors } = loadAndCompileModel(fixture('valid-parent'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });
});

describe('compiled model', () => {
  test('compiling the same model twice gives byte-identical output', () => {
    const first = loadAndCompileModel(fixture('split-model-one-file'));
    const second = loadAndCompileModel(fixture('split-model-one-file'));

    expect(first.errors).toEqual([]);
    expect(JSON.stringify(first.model)).toBe(JSON.stringify(second.model));
  });
});
