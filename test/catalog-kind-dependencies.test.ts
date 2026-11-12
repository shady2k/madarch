/** Every repository kind states its discovery inputs, including an explicit [] for roots. */
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { CATALOG_KIND_FILES, CATALOG_KINDS } from '../src/knowledge/catalog-starter.js';
import { byCodePoint } from '../src/model/order.js';

const kinds = [...CATALOG_KINDS].sort((a, b) => byCodePoint(a.name, b.name));
const names = new Set(kinds.map((kind) => kind.name));

function location(name: string): string {
  const file = CATALOG_KIND_FILES[name]!;
  const line = CATALOG_FILES[file]!.split('\n').findIndex((text) => /^depends-on:/.test(text));
  return `${resolve(import.meta.dir, '../catalog', file)}:${line < 0 ? 1 : line + 1}`;
}

test('every catalogue kind explicitly names only distinct, other catalogue kinds as discovery inputs', () => {
  const errors: string[] = [];
  for (const kind of kinds) {
    const prefix = `${location(kind.name)}: kind "${kind.name}": depends-on`;
    if (!Array.isArray(kind.dependsOn)) {
      errors.push(`${prefix} must be an explicit array (use [] for a root)`);
      continue;
    }
    const seen = new Set<string>();
    for (const dependency of kind.dependsOn) {
      if (typeof dependency !== 'string' || !names.has(dependency)) errors.push(`${prefix} names unknown kind ${JSON.stringify(dependency)}`);
      if (dependency === kind.name) errors.push(`${prefix} names itself`);
      if (seen.has(dependency)) errors.push(`${prefix} repeats ${JSON.stringify(dependency)}`);
      seen.add(dependency);
    }
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the catalogue discovery dependency graph is acyclic', () => {
  const graph = new Map(kinds.map((kind) => [kind.name, Array.isArray(kind.dependsOn) ? kind.dependsOn : []]));
  const finished = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  function visit(name: string): void {
    if (active.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      throw new Error(`catalogue discovery dependency cycle: ${cycle.join(' -> ')}\n${cycle.map((member) => `${location(member)}: kind "${member}"`).join('\n')}`);
    }
    if (finished.has(name)) return;
    active.add(name);
    path.push(name);
    for (const dependency of graph.get(name) ?? []) {
      if (names.has(dependency)) visit(dependency);
    }
    path.pop();
    active.delete(name);
    finished.add(name);
  }
  for (const kind of kinds) visit(kind.name);
});
