/** The app's addresses (decision 0036, section 7): `/`, `/e/<kind>/<id>` and `/p/<template>`, under a products home too. */
import { expect, test } from 'bun:test';
import { entityHref } from './components/connection.js';
import { basePathOf } from './client.js';
import { entityAddress, parseAddress } from './address.js';

test('a products home keeps the base out of the page address', () => {
  expect(basePathOf('/products/shop/e/k/1')).toBe('/products/shop');
  expect(basePathOf('/e/k/1')).toBe('');
  expect(parseAddress('/products/shop/e/k/1', '', '/products/shop').page).toEqual({ kind: 'k', id: '1', params: {} });
  expect(parseAddress('/products/shop/', '', '/products/shop').home).toBe(true);
});

test('the root is the home, and a name with a slash in it stays one name', () => {
  expect(parseAddress('/', '', '').home).toBe(true);
  const one = parseAddress(`/e/${encodeURIComponent('a.b')}/${encodeURIComponent('x/y')}`, '', '');
  expect(one.page.kind).toBe('a.b');
  expect(one.page.id).toBe('x/y');
  expect(entityAddress('a.b', 'x/y')).toBe('/e/a.b/x%2Fy');
});

test('a template bound to no entity is its own address, and its query parameters bind variables', () => {
  const page = parseAddress('/p/run', '?run=7&lang=ru&role=analyst', '');
  expect(page.page.template).toBe('run');
  expect(page.page.params).toEqual({ run: '7' });
  expect(page.page.lang).toBe('ru');
  expect(page.page.role).toBe('analyst');
  expect(page.unknown).toBe(false);
});

test('the old fill address opens the catalogue in selection mode', () => {
  const section = parseAddress('/p/fill', '', '');
  expect(section.frame).toBeNull();
  expect(section.page.template).toBe('catalogue');
  expect(section.page.params).toEqual({ select: '1' });
  expect(section.unknown).toBe(false);
});

test('a product template answers at its own name, and the kit stays a frame page', () => {
  const catalogue = parseAddress('/p/catalogue', '', '');
  expect(catalogue.frame).toBeNull();
  expect(catalogue.page.template).toBe('catalogue');
  expect(parseAddress('/p/kit', '', '').frame).toBe('kit');
});

test('a path that is no page of the app says so', () => {
  expect(parseAddress('/nothing/here', '', '').unknown).toBe(true);
});

test('an entity the graph answered is addressed by its kind and id', () => {
  expect(entityHref({ kind: 'a.b', id: '1' })).toBe('/e/a.b/1');
  expect(entityHref({ label: 'no id' })).toBeUndefined();
});
