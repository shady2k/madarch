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

const CART_FILE = 'services/checkout/src/cart/index.ts';
const CART_COMMIT = '9f2d1b0a4c8e7f3a6d5c2b1e0f9a8d7c6b5e4f31';
const CART_BLOB = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';

describe('evidence names a file at a revision', () => {
  test('evidence-kept: the compiled model carries the file, the lines, the commit and the blob as given', () => {
    const { model, errors } = loadAndCompileModel(fixture('evidence-revision-kept'));

    expect(errors).toEqual([]);
    const cart = model?.elements.find((e) => e.id === 'checkout-cart');
    expect(cart?.evidence).toEqual([{ file: CART_FILE, line: 1, endLine: 12, commit: CART_COMMIT, blob: CART_BLOB }]);
    const ui = model?.elements.find((e) => e.id === 'checkout-ui');
    expect(ui?.evidence).toEqual([
      { file: 'services/checkout/src/ui/index.ts' },
      { file: 'services/checkout/src/ui/Widget.tsx', line: 7, endLine: 7 },
    ]);
    const relation = model?.relations.find((r) => r.id === 'checkout-ui-reads-cart');
    expect(relation?.evidence).toEqual([{ file: 'services/checkout/src/ui/CartView.tsx', line: 3, endLine: 9 }]);
    // The compiled item carries exactly the keys that were given, in the
    // fixed rebuild order the compiled model's byte identity relies on.
    expect(cart?.evidence?.map((item) => Object.keys(item))).toEqual([['file', 'line', 'endLine', 'commit', 'blob']]);
    expect(ui?.evidence?.map((item) => Object.keys(item))).toEqual([['file'], ['file', 'line', 'endLine']]);
    expect(relation?.evidence?.map((item) => Object.keys(item))).toEqual([['file', 'line', 'endLine']]);
  });

  test('commit-without-blob: a commit without a blob is refused, naming the element, the item and its place', () => {
    const fixtureRoot = fixture('evidence-revision-commit-without-blob');
    const itemLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === `- file: ${CART_FILE}`);

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.file === 'madarch/model.yaml' && e.line === itemLine);
    expect(error).toBeDefined();
    expect(error?.path).toBe('elements[0].evidence[0]');
    expect(error?.message).toContain('element "checkout-cart"');
    expect(error?.message).toContain(CART_FILE);
    expect(error?.message).toContain('a commit but no blob');
    expect(error?.message).toContain('a commit and a blob are given together');
  });

  test('range-reversed: an endLine before line is refused, naming the element, the item and its place', () => {
    const fixtureRoot = fixture('evidence-revision-range-reversed');
    const itemLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === `- file: ${CART_FILE}`);

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.file === 'madarch/model.yaml' && e.line === itemLine);
    expect(error).toBeDefined();
    expect(error?.path).toBe('elements[0].evidence[0].endLine');
    expect(error?.message).toContain('element "checkout-cart"');
    expect(error?.message).toContain(CART_FILE);
    expect(error?.message).toContain('endLine may not come before line');
  });

  test('a blob without a commit is refused, naming the element, the item and its place', () => {
    const fixtureRoot = fixture('evidence-revision-blob-without-commit');
    const itemLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === `- file: ${CART_FILE}`);

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    const error = errors.find((e) => e.file === 'madarch/model.yaml' && e.line === itemLine);
    expect(error).toBeDefined();
    expect(error?.path).toBe('elements[0].evidence[0]');
    expect(error?.message).toContain('element "checkout-cart"');
    expect(error?.message).toContain(CART_FILE);
    expect(error?.message).toContain('a blob but no commit');
    expect(error?.message).toContain('a commit and a blob are given together');
  });

  test('a commit of the wrong length is refused even when every digit is hexadecimal', () => {
    const fixtureRoot = fixture('evidence-revision-commit-too-long');

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('elements[0].evidence[0].commit');
    expect(errors[0]?.message).toContain('element "checkout-cart"');
    expect(errors[0]?.message).toContain(CART_FILE);
    expect(errors[0]?.message).toContain('is not 40 hexadecimal digits');
  });

  test('every evidence problem is reported at once, naming the element, interface or relation it belongs to', () => {
    const fixtureRoot = fixture('evidence-revision-malformed');
    const shortCommitLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === `- file: ${CART_FILE}`);
    const nonHexBlobLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === '- file: services/checkout/src/cart/store.ts');
    const endOnlyLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === '- file: services/checkout/src/cart/api.ts');
    const upperCommitLine = lineOf(fixtureRoot, 'madarch/model.yaml', (line) => line.trim() === '- file: services/checkout/README.md');

    const { model, errors } = loadAndCompileModel(fixtureRoot);

    expect(model).toBeUndefined();
    expect(errors).toHaveLength(6);
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: shortCommitLine,
        path: 'elements[1].evidence[0].commit',
        message: expect.stringContaining('is not 40 hexadecimal digits'),
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: shortCommitLine,
        path: 'elements[1].evidence[0]',
        message: expect.stringContaining('a commit and a blob are given together'),
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: nonHexBlobLine,
        path: 'elements[1].evidence[1].blob',
        message: expect.stringContaining('is not 40 hexadecimal digits'),
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: nonHexBlobLine,
        path: 'elements[1].evidence[1]',
        message: expect.stringContaining('a commit and a blob are given together'),
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: endOnlyLine,
        path: 'interfaces[0].evidence[0].endLine',
        message: expect.stringContaining('interface "checkout-list"'),
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        file: 'madarch/model.yaml',
        line: upperCommitLine,
        path: 'relations[0].evidence[0].commit',
        message: expect.stringContaining('relation "checkout-web-uses-cart"'),
      }),
    );
  });
});
