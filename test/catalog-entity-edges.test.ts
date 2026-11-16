/** Decision 0039 items 1, 2, 21, 28 and 29: starter entity relations are declared edges. */
import { expect, test } from 'bun:test';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { parse as parseCatalogYaml } from 'yaml';
import { SYSTEM_VERTEX_DEFINITIONS } from '../src/graph/system-contract.js';

type Field = { name: string; type: string; reference?: string; schema?: Record<string, unknown> };
type Kind = { fields?: Field[]; key?: string[]; 'key-edges'?: { role: string; edge: string; side: string }[]; 'reference-set-entry'?: { set: string } };
type Edge = { name: string; from: string[]; to: string[]; cardinality: { from: { min: number; max: number | null }; to: { min: number; max: number | null } }; "on-parent-delete"?: string; labels: Record<string, { out: string; in: string }> };
const kinds = new Map(Object.entries(CATALOG_FILES).filter(([path]) => path !== 'catalog.yaml' && !path.startsWith('templates/')).map(([path, text]) => [path.split('/').at(-1)!.slice(0, -5), parseCatalogYaml(text) as Kind]));
const { edges } = parseCatalogYaml(CATALOG_FILES['catalog.yaml']!) as { edges: Edge[] };
const edgeByName = new Map(edges.map((edge) => [edge.name, edge]));

test('every actual edge declares endpoints, cardinality and bilingual forward/inverse words', () => {
  expect(edgeByName.size).toBe(edges.length);
  for (const edge of edges) {
    expect(edge.from.length).toBeGreaterThan(0);
    expect(edge.to.length).toBeGreaterThan(0);
    for (const endpoint of [...edge.from, ...edge.to]) expect(kinds.has(endpoint) || SYSTEM_VERTEX_DEFINITIONS.some((kind) => kind.name === endpoint)).toBe(true);
    for (const side of ['from', 'to'] as const) {
      const bounds = edge.cardinality[side];
      expect(bounds.min).toBeGreaterThanOrEqual(0);
      expect(bounds.max === null || bounds.max >= bounds.min).toBe(true);
    }
    for (const language of ['en', 'ru']) for (const direction of ['out', 'in'] as const) expect(edge.labels[language]![direction].trim().length).toBeGreaterThan(0);
  }
});

test('parent identities use required edges and only own scalar key fields', () => {
  for (const [name, kind] of kinds) {
    const fields = new Set(kind.fields?.map((field) => field.name));
    for (const key of kind.key ?? []) expect(fields.has(key)).toBe(true);
    for (const parent of kind['key-edges'] ?? []) {
      const edge = edgeByName.get(parent.edge)!;
      expect(edge).toBeDefined();
      expect(parent.role.trim().length).toBeGreaterThan(0);
      expect(['from', 'to']).toContain(parent.side);
      const childSide = parent.side as 'from' | 'to';
      expect(edge[childSide]).toEqual([name]);
      expect(edge.cardinality[childSide]).toEqual({ min: 1, max: 1 });
      expect(['restrict', 'cascade']).toContain(edge['on-parent-delete']!);
    }
  }
  for (const name of ['code.file', 'code.directory', 'code.gitlink', 'code.database', 'code.test-quarantine']) {
    expect(kinds.get(name)?.fields?.some((field) => field.name === 'repository')).toBe(false);
    expect(kinds.get(name)?.['key-edges']?.some((edge) => edge.edge === `${name}-repository`)).toBe(true);
  }
  expect(kinds.get('value-set-entry')?.['reference-set-entry']?.set).toBe('value-set-entry-set');
});

test('entity references and nested model entities do not survive as scalar attributes', () => {
  const replaced: Record<string, string[]> = {
    'code.file': ['repository', 'directory', 'added_in', 'removed_in', 'state_machines'],
    'code.gitlink': ['other_repository'], 'code.table': ['database'], 'code.column': ['table'], 'code.index': ['table', 'columns'],
    'code.test-quarantine': ['test', 'task', 'since'], 'value-set-entry': ['set'],
    comment: ['author'], 'code.cycle': ['members'], 'code.route': ['middleware'], workflow: ['stages'],
  };
  for (const [name, fields] of Object.entries(replaced)) for (const field of fields) expect(kinds.get(name)?.fields?.some((held) => held.name === field)).toBe(false);
  for (const kind of kinds.values()) for (const field of kind.fields ?? []) expect(field.reference).toBeUndefined();
});

test('value-set assignments remain scalar values rather than edges to declaration entries', () => {
  for (const [name, kind] of kinds) for (const field of kind.fields ?? []) {
    if (!['status', 'priority', 'issue_type', 'executor_type', 'relation'].includes(field.name)) continue;
    expect(['text', 'value-set-value']).toContain(field.type);
    expect(edgeByName.has(`${name}-${field.name}`)).toBe(false);
  }
});

test('structured scalar metadata always declares its JSON Schema dialect', () => {
  for (const kind of kinds.values()) for (const field of kind.fields ?? []) {
    if (field.type !== 'json') continue;
    expect(field.schema?.['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(field.schema?.['type'] !== undefined || field.schema?.['oneOf'] !== undefined || field.schema?.['anyOf'] !== undefined || field.schema?.['$ref'] !== undefined).toBe(true);
  }
});
