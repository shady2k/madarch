import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndCompileModel, loadModel, parseModel } from '../src/index.js';

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

/** A throwaway repository root with a `madarch/` folder, for cases a committed fixture cannot express. */
function tempRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-test-'));
  const madarch = join(root, 'madarch');
  mkdirSync(madarch, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(madarch, name), content);
  }
  return root;
}

describe('B1: fixed-choice fields are checked, not silently accepted', () => {
  test('refuses an unknown version, naming the allowed value', () => {
    const { model, errors } = loadAndCompileModel(fixture('unknown-version'));

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', path: 'version' }),
    );
    const error = errors.find((e) => e.path === 'version')!;
    expect(error.message).toContain('2');
    expect(error.message).toContain('1');
  });

  test('refuses an unknown element kind, naming the allowed values', () => {
    const fixtureRoot = fixture('unknown-kind');
    const kindLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim().startsWith('kind: nonsense'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/model.yaml', line: kindLine, path: 'elements[0].kind' }),
    );
    const error = errors.find((e) => e.path === 'elements[0].kind')!;
    expect(error.message).toContain('nonsense');
    for (const kind of ['person', 'external', 'domain', 'system', 'service', 'module', 'store', 'broker']) {
      expect(error.message).toContain(kind);
    }
  });

  test('refuses an unknown transfer direction, naming the allowed values', () => {
    const { model, errors } = loadAndCompileModel(fixture('unknown-direction'));

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.path === 'relations[0].transfers[0].direction');
    expect(error).toBeDefined();
    expect(error?.message).toContain('sideways');
    expect(error?.message).toContain('forward');
    expect(error?.message).toContain('reverse');
  });

  test('loads normally once the kind is fixed', () => {
    const { model, errors } = loadAndCompileModel(fixture('one-element'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });
});

describe('S1: independent checks all run and report together', () => {
  test('a schema error in one file and a reference error in another are both reported', () => {
    const fixtureRoot = fixture('schema-error-plus-reference');
    const ownerLine = lineOf(fixtureRoot, 'madarch/first.yaml', (line) => line.trim().startsWith('owner:'));
    const parentLine = lineOf(fixtureRoot, 'madarch/second.yaml', (line) => line.trim().startsWith('parent:'));

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/first.yaml', line: ownerLine, path: 'elements[0].owner' }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ file: 'madarch/second.yaml', line: parentLine, path: 'parent' }),
    );
  });

  test('a duplicate id does not block the unrelated reference check from also being reported', () => {
    const fixtureRoot = fixture('duplicate-id-and-bad-reference');
    const lines = readFileSync(`${fixtureRoot}/madarch/model.yaml`, 'utf8').split('\n');
    const bLineNumbers = lines
      .map((line, index) => (line.trim() === '- id: b' ? index + 1 : -1))
      .filter((n) => n > 0);
    expect(bLineNumbers.length).toBe(2);
    const [firstBLine] = bLineNumbers;

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    const idErrors = errors.filter((e) => e.path === 'id');
    expect(idErrors.length).toBe(2);
    // Each duplicate's message names the *other* occurrence, not itself.
    const atFirstLine = idErrors.find((e) => e.line === firstBLine)!;
    const atSecondLine = idErrors.find((e) => e.line !== firstBLine)!;
    expect(atFirstLine.message).not.toContain(`madarch/model.yaml:${firstBLine}`);
    expect(atFirstLine.message).toContain(`madarch/model.yaml:${atSecondLine.line}`);
    expect(atSecondLine.message).not.toContain(`madarch/model.yaml:${atSecondLine.line}`);
    expect(atSecondLine.message).toContain(`madarch/model.yaml:${firstBLine}`);

    expect(errors).toContainEqual(
      expect.objectContaining({ path: 'parent', message: expect.stringContaining('nope') }),
    );
  });
});

describe('S5: every error names the full path from the model top, decoded', () => {
  test('a duplicate key names the key and its full path', () => {
    const fixtureRoot = fixture('duplicate-key');
    const secondParentLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === 'parent: b');

    const { errors } = loadAndCompileModel(fixtureRoot);

    const error = errors.find((e) => e.line === secondParentLine);
    expect(error).toBeDefined();
    expect(error?.path).toBe('elements[0].parent');
    expect(error?.message).toContain('parent');
  });

  test('a JSON-Pointer-escaped path segment (a map key containing "/") is decoded', () => {
    const root = tempRepo({
      'model.yaml': [
        'version: 1',
        'elements: []',
        'environments:',
        '  - id: t',
        '    zones:',
        '      "a/b":',
        '        add: 1',
        '',
      ].join('\n'),
    });

    const { errors } = loadModel(root);
    rmSync(root, { recursive: true });

    expect(errors).toContainEqual(expect.objectContaining({ path: 'environments[0].zones.a/b.add' }));
  });
});

describe('O3: explicit tags (custom and core-schema) are refused', () => {
  test('refuses a merge key', () => {
    const { model, errors } = loadAndCompileModel(fixture('merge-key'));

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(expect.objectContaining({ file: 'madarch/model.yaml' }));
    expect(errors[0]?.message).toContain('merge key');
  });

  test('refuses a custom tag, naming it as an explicit tag', () => {
    const { model, errors } = loadAndCompileModel(fixture('custom-tag'));

    expect(model).toBeUndefined();
    expect(errors[0]?.message).toContain('explicit tag');
    expect(errors[0]?.message).toContain('!custom');
  });
});

describe('S7: filesystem failures are returned as errors, never thrown', () => {
  test('a folder entry that is a directory, not a file, is reported and does not throw', () => {
    expect(() => loadModel(fixture('directory-named-yaml'))).not.toThrow();

    const { model, errors } = loadModel(fixture('directory-named-yaml'));

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(expect.objectContaining({ file: 'madarch/sub.yaml' }));
  });

  test('parseModel takes files in memory, with no filesystem access', () => {
    const { model, errors } = parseModel([{ path: 'madarch/model.yaml', text: 'version: 1\nelements:\n  - id: a\n    kind: service\n' }]);

    expect(errors).toEqual([]);
    expect(model?.elements[0]?.id).toBe('a');
  });
});

describe('S8: loading', () => {
  test('a missing madarch folder is refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-test-'));
    const { model, errors } = loadModel(root);
    rmSync(root, { recursive: true });

    expect(model).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  test('an empty madarch folder is refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-test-'));
    mkdirSync(join(root, 'madarch'));
    const { model, errors } = loadModel(root);
    rmSync(root, { recursive: true });

    expect(model).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  test('a *.yml file is refused, naming it', () => {
    const { model, errors } = loadModel(fixture('yml-extension'));

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(expect.objectContaining({ file: 'madarch/other.yml' }));
    expect(errors.find((e) => e.file === 'madarch/other.yml')?.message).toContain('.yaml');
  });

  test('an evidence line must be an integer of at least 1', () => {
    const { model, errors } = loadAndCompileModel(fixture('evidence-line-invalid'));

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(expect.objectContaining({ path: 'elements[0].evidence[0].line' }));
  });

  test('a zone kind must not be empty', () => {
    const { model, errors } = loadAndCompileModel(fixture('zone-kind-empty'));

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(expect.objectContaining({ path: 'zones[0].kind' }));
  });

  test('a transfer confidentiality must not be empty', () => {
    const { model, errors } = loadAndCompileModel(fixture('confidentiality-empty'));

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(expect.objectContaining({ path: 'relations[0].transfers[0].confidentiality' }));
  });

  test('an HTTP contract method must be a known HTTP method', () => {
    const { model, errors } = loadAndCompileModel(fixture('contract-bad-method'));

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(expect.objectContaining({ path: 'contract' }));
  });

  test('an HTTP contract path must start with "/"', () => {
    const { model, errors } = loadAndCompileModel(fixture('contract-path-no-slash'));

    expect(model).toBeUndefined();
    expect(errors).toContainEqual(expect.objectContaining({ path: 'contract' }));
  });

  test('an HTTP contract with a valid method and path still normalizes', () => {
    const { model, errors } = loadAndCompileModel(fixture('valid-interface'));

    expect(errors).toEqual([]);
    expect(model?.interfaces[0]?.contract).toBe('http::POST::/api/charges');
  });
});

describe('S9: compileModel requires a validated model', () => {
  test('loadAndCompileModel produces a compiled model from a validated one', () => {
    const { model, errors } = loadAndCompileModel(fixture('one-element'));

    expect(errors).toEqual([]);
    expect(model).toBeDefined();
  });

  // `compileModel` takes `ValidatedModel`, a type only `loadModel`/`parseModel`
  // produce; a plain `IntendedModel` (or anything else) is a type error at
  // the call site, which `bun run check` enforces. That is checked once, at
  // compile time, by `test/type-checks/compile-model-requires-validated.ts`
  // (excluded from the build, included only in `tsc --noEmit`).
});
