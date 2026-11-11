/**
 * The few fact-vocabulary values the fill still uses (decision 0034): a
 * repository path, which never carries the machine checkout.
 */
import { describe, expect, test } from 'bun:test';
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
