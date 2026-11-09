/**
 * The few fact-vocabulary values the fill still uses (decision 0034): a
 * repository path, which never carries the machine checkout, and the storage
 * forms the product schema declares for a registry kind (0021's amendment).
 */
import { describe, expect, test } from 'bun:test';
import { StorageForm } from '../src/product/schema.js';
import { isRepositoryPath, repositoryPath } from '../src/fill/facts.js';

describe('repository paths: the machine checkout never reaches a fact', () => {
  test('a relative path reads as itself, with a machine separator folded and a leading ./ dropped', () => {
    // `String(...)` because a repository path's type is branded: the brand is
    // the point (a plain string is not one), and the bytes are what is read.
    expect(String(repositoryPath('src/order.ts'))).toBe('src/order.ts');
    expect(String(repositoryPath('src\\order.ts'))).toBe('src/order.ts');
    expect(String(repositoryPath('./src/order.ts'))).toBe('src/order.ts');
    expect(isRepositoryPath('src/order.ts')).toBe(true);
  });

  test('an absolute path, a climbed path, a drive path, a trailing separator, an empty leg and a dotted leg are refused', () => {
    const refused = ['/opt/madarch-checkout/src/order.ts', '../secret.ts', 'C:\\checkout\\src\\order.ts', 'src/', 'src//order.ts', 'src/./order.ts', ''];
    for (const value of refused) {
      expect(isRepositoryPath(value)).toBe(false);
      expect(() => repositoryPath(value)).toThrow(/repository path/);
    }
  });
});

describe('the storage forms of the product schema', () => {
  test('the storage forms are the product schema own five: one declaration', () => {
    // 0021's amendment names the forms a registry kind may be kept in; the
    // product schema is their one declaration, so a form added there reaches
    // every reader of it instead of leaving a copy behind.
    const union = (StorageForm as unknown as { anyOf: readonly { const: string }[] }).anyOf.map((member) => member.const);
    expect([...union].sort()).toEqual(['component', 'document', 'fact', 'model-element', 'task']);
  });
});
