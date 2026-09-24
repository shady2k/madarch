import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAndCompileModel } from '../src/index.js';

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
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
    const yamlPath = `${fixtureRoot}/madarch/model.yaml`;
    const lines = readFileSync(yamlPath, 'utf8').split('\n');
    const ownerLine = lines.findIndex((line) => line.trim().startsWith('owner:')) + 1;
    expect(ownerLine).toBeGreaterThan(0);

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
