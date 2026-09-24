import { describe, expect, test } from 'bun:test';
import { parseModel } from '../src/index.js';

const valid = 'version: 1\nelements:\n  - id: shop\n    kind: domain\n';

describe('a file that is not valid YAML', () => {
  test('is refused with its file and line, and the model is not built from the other files', () => {
    const broken = 'version: 1\nelements:\n  - id: web\n    kind: service\n   parent: shop\n';
    const result = parseModel([
      { path: 'madarch/a.yaml', text: valid },
      { path: 'madarch/b.yaml', text: broken },
    ]);
    expect(result.model).toBeUndefined();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((error) => error.file === 'madarch/b.yaml')).toBe(true);
    expect(result.errors.some((error) => error.line === 5)).toBe(true);
  });

  test('normally, both files well formed, the model is built from both', () => {
    const second = 'version: 1\nelements:\n  - id: web\n    kind: service\n    parent: shop\n';
    const result = parseModel([
      { path: 'madarch/a.yaml', text: valid },
      { path: 'madarch/b.yaml', text: second },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.model?.elements.map((element) => element.id).sort()).toEqual(['shop', 'web']);
  });
});
