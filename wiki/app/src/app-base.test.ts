import { describe, expect, test } from 'bun:test';
import { appBase, appPath, appRoute } from './app-base.js';

describe('product-mounted wiki base', () => {
  test('uses an existing product route prefix for navigation and API requests', () => {
    expect(appBase('/products/example/docs/page')).toBe('/products/example');
    expect(appPath('/api/fill', '/products/example/')).toBe('/products/example/api/fill');
    expect(appRoute('/products/example/p/docs/a.md')).toBe('/p/docs/a.md');
    expect(appPath('/api/product', '/')).toBe('/api/product');
  });
});
