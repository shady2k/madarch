import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { CATALOG_KIND_FILES, CATALOG_RAW_KINDS } from '../src/knowledge/catalog-starter.js';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { parseCatalogYaml } from '../src/product/manifest/kinds.js';
import { byCodePoint } from '../src/model/order.js';

const entries = Object.entries(CATALOG_RAW_KINDS).sort(([a], [b]) => byCodePoint(a, b));
const dependencies = new Map(entries.map(([name, row]) => [name, row['derives-from'] as string[]]));
const location = (name: string): string => `${resolve('catalog', CATALOG_KIND_FILES[name]!)}:1`;

test('the catalogue has one root, no cycle, and every kind is reachable from product', () => {
  expect(entries.filter(([, row]) => !Array.isArray(row['derives-from'])).map(([name]) => location(name))).toEqual([]);
  expect(entries.filter(([name]) => dependencies.get(name)!.length === 0).map(([name]) => name)).toEqual(['product']);
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (name: string): void => {
    if (active.has(name)) throw new Error(`${location(name)}: dependency cycle through ${[...active, name].join(' -> ')}`);
    if (visited.has(name)) return;
    active.add(name);
    for (const parent of dependencies.get(name)!) {
      if (!dependencies.has(parent)) throw new Error(`${location(name)}: unknown prerequisite ${parent}`);
      visit(parent);
    }
    active.delete(name);
    visited.add(name);
  };
  for (const [name] of entries) visit(name);
  const reachable = new Set(['product']);
  while (true) {
    const before = reachable.size;
    for (const [name, parents] of dependencies) if (parents.some((parent) => reachable.has(parent))) reachable.add(name);
    if (reachable.size === before) break;
  }
  expect(entries.filter(([name]) => !reachable.has(name)).map(([name]) => location(name))).toEqual([]);
  expect(dependencies.get('c4.component')).toEqual(['code.service']);
  expect(dependencies.get('code.module')).toContain('c4.component');
  expect(CATALOG_RAW_KINDS['c4.component']!['labels']).toMatchObject({ ru: { one: 'Компонент' }, en: { one: 'Component' } });
});

test('intent can reach requirements before any repository exists and work can stand alone', () => {
  const ancestry = (name: string, found = new Set<string>()): Set<string> => {
    for (const parent of dependencies.get(name)!) if (!found.has(parent)) { found.add(parent); ancestry(parent, found); }
    return found;
  };
  for (const name of ['idea', 'vision', 'research-question', 'research-finding', 'design-system', 'doc.requirement']) {
    const parents = ancestry(name);
    expect([name, parents.has('code.repository')]).toEqual([name, false]);
    if (name !== 'idea') expect([name, parents.has('idea')]).toEqual([name, true]);
  }
  for (const name of ['task', 'defect', 'technical-debt']) expect(dependencies.get(name)).toEqual(['product']);
  expect(CATALOG_RAW_KINDS['backlog-item']).toBeUndefined();
  for (const name of ['epic', 'feature', 'task', 'defect', 'technical-debt']) {
    const fields = CATALOG_RAW_KINDS[name]!['fields'] as { name: string }[];
    expect([name, fields.some((field) => field.name === 'priority'), fields.some((field) => field.name === 'queue_position')]).toEqual([name, true, true]);
  }
});

test('profile gates technical branches and concept labels do not determine concept identity', () => {
  expect(dependencies.get('product-profile')).toEqual(['product']);
  for (const name of ['technology', 'kubernetes-cluster', 'code.dockerfile', 'code.database', 'screen', 'ml-model', 'code.broker']) expect(dependencies.get(name)).toContain('product-profile');
  expect(CATALOG_RAW_KINDS['doc.term']!['key']).toEqual(['identifier']);
  expect(CATALOG_RAW_KINDS['doc.term']!['key-edges']).toEqual([{ role: 'doc.term-subject', edge: 'term.in-domain', side: 'from' }]);
  const metadata = parseCatalogYaml(CATALOG_FILES['catalog.yaml']!) as { edges: { name: string; from: string[]; to: string[]; labels: unknown }[] };
  for (const name of ['domain', 'software-system', 'c4.component', 'token-group', 'organization']) {
    expect(metadata.edges.find((edge) => edge.name === `${name}.contains`)).toMatchObject({ from: [name], to: [name], labels: { ru: { out: 'содержит', in: 'входит в' } } });
  }
  expect(metadata.edges.find((edge) => edge.name === 'architecture.serves-domain')).toMatchObject({ from: ['software-system', 'c4.component'], to: ['domain'] });
  expect(metadata.edges.find((edge) => edge.name === 'idea.evolved-into')).toMatchObject({ from: ['idea'], to: ['idea'] });
});
