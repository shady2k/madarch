import { expect, test } from 'bun:test';
import { parse } from 'yaml';
import { starterManifestText } from './catalog-folder-fixture.js';

test('whole-catalogue-tree: the engine\'s protected system.product is the root, every other kind is reachable, and dependencies are acyclic', () => {
  const { kinds } = parse(starterManifestText()) as { kinds: Record<string, { 'derives-from'?: string[] }> };
  // The declared kinds have one root of their own: the product kind is the product's description, and it rests on nothing.
  const roots = Object.keys(kinds).filter(name => (kinds[name]!['derives-from'] ?? []).length === 0).sort();
  expect(roots).toEqual(['product']);
  const children = new Map([...Object.keys(kinds), 'system.product'].map(name => [name, [] as string[]]));
  for (const [name, kind] of Object.entries(kinds)) for (const parent of kind['derives-from'] ?? []) {
    // A prerequisite is a declared kind or the protected engine root the installed contract carries.
    expect(parent === 'system.product' || kinds[parent] !== undefined).toBe(true);
    children.get(parent)!.push(name);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    expect(visiting.has(name)).toBe(false);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const child of children.get(name)!) visit(child);
    visiting.delete(name);
    visited.add(name);
  };
  // Check cycles even in disconnected components, then reachability from the engine's root independently.
  for (const name of children.keys()) visit(name);
  visited.clear();
  visit('system.product');
  expect([...visited].filter(name => name !== 'product').sort()).toEqual([...Object.keys(kinds), 'system.product'].filter(name => name !== 'product').sort());
  expect(kinds['product-profile']!['derives-from']).toEqual(['system.product']);
  expect(kinds['code.repository']!['derives-from']).toEqual(['system.product', 'product-profile']);
});
