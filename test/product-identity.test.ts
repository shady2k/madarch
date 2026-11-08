/**
 * The id a product's own repository is pinned under (madarch-8bdc.2.5 review, item 4): one function
 * gives it, the fill and the MCP server both read it, and it is never a name a declared repository
 * carries. No store is opened: the function reads the manifest's declared names and nothing else.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { fillFolderIdentity, productRepositoryId } from '../src/product/identity.js';

const ROOT = mkdtempSync(join(tmpdir(), 'madarch-product-id-'));

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A manifest in a folder of its own, with the repositories it declares. */
function manifest(name: string, declared: readonly string[]): string {
  const folder = join(ROOT, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 5f4e3d2c-1b0a-4c9d-8e7f-6a5b4c3d2e1f',
    `name: ${name}`,
    ...(declared.length === 0 ? [] : ['repos:', ...declared.flatMap((repo) => [`  - name: ${repo}`, `    url: https://example.invalid/${repo}.git`])]),
    '',
  ].join('\n'));
  return folder;
}

describe("the id of a product's own repository", () => {
  test("is the product's name where no declared repository carries it", () => {
    const folder = manifest('quiet-shop', ['api']);
    expect(productRepositoryId(fillFolderIdentity(folder).identity)).toBe('quiet-shop');
  });

  test('is `-product` where a declared repository carries the product name', () => {
    const folder = manifest('loud-shop', ['loud-shop']);
    expect(productRepositoryId(fillFolderIdentity(folder).identity)).toBe('loud-shop-product');
  });

  test('takes the next free id where the declared repositories carry `-product` too', () => {
    const folder = manifest('busy-shop', ['busy-shop', 'busy-shop-product']);
    expect(productRepositoryId(fillFolderIdentity(folder).identity)).toBe('busy-shop-product-2');
    const more = manifest('busier-shop', ['busier-shop', 'busier-shop-product', 'busier-shop-product-2']);
    expect(productRepositoryId(fillFolderIdentity(more).identity)).toBe('busier-shop-product-3');
    // The answer is the manifest's alone: the same folder answers the same id every time.
    expect(productRepositoryId(fillFolderIdentity(folder).identity)).toBe('busy-shop-product-2');
    // The last candidate is used where it is free: `-2` through `-98` are declared, `-99` is the answer.
    const last = manifest('last-shop', ['last-shop', 'last-shop-product', ...Array.from({ length: 97 }, (_, index) => `last-shop-product-${index + 2}`)]);
    expect(productRepositoryId(fillFolderIdentity(last).identity)).toBe('last-shop-product-99');
  });

  test('is refused by name where every candidate is a declared repository, naming the ones it holds', () => {
    const declared = ['full-shop', 'full-shop-product', ...Array.from({ length: 98 }, (_, index) => `full-shop-product-${index + 2}`)];
    const folder = manifest('full-shop', declared);
    expect(() => productRepositoryId(fillFolderIdentity(folder).identity)).toThrow(/full-shop-product-99/);
    expect(() => productRepositoryId(fillFolderIdentity(folder).identity)).toThrow(/has no id of its own/);
  });
});
