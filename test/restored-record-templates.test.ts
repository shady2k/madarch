import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSchema, parse, validate, visit, type FieldNode, type InlineFragmentNode } from 'graphql';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { composePage, readTemplate, type Bootstrap } from '../src/page-contract/index.js';
import { starterSchema } from '../scripts/graphql-starter.js';
import { MAX_NODES, queryCost } from '../src/graph/graphql-execute.js';
import { kindTypeNameOf } from '../src/graphql/names.js';

const folder = join(import.meta.dir, '../catalog/templates/pages');
const bindings = [
  ['code-repository', 'code.repository'], ['code-directory', 'code.directory'],
  ['code-symbol', 'code.symbol'], ['code-route', 'code.route'],
  ['code-operation', 'code.operation'], ['code-contract', 'code.contract'],
  ['code-table', 'code.table'], ['code-database', 'code.database'], ['code-file', 'code.file'],
] as const;
const templates = ['entity', ...bindings.map(([name]) => name)].map((name) => ({ name, body: readFileSync(join(folder, `${name}.yaml`), 'utf8') }));
const bootstrap: Bootstrap = {
  structureRevision: 'fixture', home: null, catalogueTemplate: 'entity', templates,
  recordTemplates: bindings.map(([template, kind]) => ({ template, kind })), ownTemplates: [], roles: [], roleLeads: [],
};

function page(kind: string) {
  return composePage(bootstrap, { kind, id: '00000000-0000-0000-0000-000000000001' });
}

test('the restored record pages bind their actual kinds and compose against the complete starter schema', () => {
  const schema = buildSchema(starterSchema().sdl);
  for (const [name, kind] of bindings) {
    const path = join(folder, `${name}.yaml`);
    const read = readTemplate(readFileSync(path, 'utf8'), { name, file: path });
    expect({ path, findings: read.findings }).toEqual({ path, findings: [] });
    expect(read.template?.records).toEqual([kind]);
    const composed = page(kind);
    expect({ path, findings: composed.findings }).toEqual({ path, findings: [] });
    expect(composed.template).toBe(name);
    expect({ path, errors: validate(schema, parse(composed.operation)).map((error) => ({ message: error.message, locations: error.locations })) }).toEqual({ path, errors: [] });
  }
});

test('every restored entity list can reach the remainder and carries the real total', () => {
  for (const [, kind] of bindings.filter(([name]) => name !== 'code-file')) {
    for (const section of page(kind).sections.filter((one) => one.component === 'table' || one.component === 'treemap')) {
      expect(section.query).toBeDefined();
      expect(section.query).toContain(`$${section.id}_first`);
      expect(section.query).toContain(`$${section.id}_after`);
      expect(section.query).toContain('totalCount');
      expect(section.query).toContain('pageInfo');
      expect(section.query).toContain('hasNextPage');
      expect(section.query).toContain('endCursor');
      expect(section.params['pageSize']).toBeGreaterThan(0);
    }
  }
});

test('unsupported lists say unavailable instead of claiming no entities exist', () => {
  for (const [kind, ids] of [
    ['code.symbol', ['callers', 'callees', 'members', 'tests', 'implements', 'inherits']],
    ['code.route', ['handlers', 'routes']], ['code.operation', ['declared', 'served']],
    ['code.contract', ['operations']], ['code.database', ['tables', 'migrations']],
    ['code.repository', ['modules']], ['code.directory', ['modules']],
  ] as const) {
    for (const id of ids) {
      const section = page(kind).sections.find((one) => one.id === id);
      expect(section?.component).toBe('text');
      expect(section?.query).toBe('__typename\n');
      expect(section?.params['emptyText']).toEqual({
        en: 'Unavailable: the current catalogue does not declare a relation for this list.',
        ru: 'Недоступно: текущий каталог не объявляет связь для этого списка.',
      });
    }
  }
});

test('co-change keeps the denominator and percentage', () => {
  const cochange = page('code.file').sections.find((one) => one.id === 'cochange');
  const columns = cochange?.params['columns'] as { path: string }[];
  expect(columns.map((one) => one.path)).toEqual(['node.label', 'count', 'total', 'share']);
});

// String edge arguments must agree with the real graph contract, not merely GraphQL syntax.
test('every related query uses a declared edge with reachable source and target kinds', () => {
  const product = mkdtempSync(join(tmpdir(), 'madarch-template-contract-'));
  try {
    for (const file of STARTER_FILES) {
      const path = join(product, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.bytes ?? file.content);
    }
    const read = readKinds(product);
    if (!read.present) throw new Error(`${join(product, 'madarch/catalog.yaml')}:1: the starter manifest is missing`);
    const manifest = read.manifest;
    expect(manifest.findings).toEqual([]);
    const contract = graphContractOf(manifest);
    const kindOfType = new Map([...manifest.kinds.values()].map((declared) => [kindTypeNameOf(declared.name), declared.name]));
    const failures: string[] = [];
    const includes = (ends: readonly string[], kind: string): boolean => ends.includes(kind) || ends.includes('any');
    for (const [name, kind] of bindings) {
      const source = readFileSync(join(folder, `${name}.yaml`), 'utf8');
      for (const section of page(kind).sections) {
        if (section.query === undefined) continue;
        // A nested related inside `... on KindX` reads from X, not from the page's root kind.
        const fragments: string[] = [];
        visit(parse(`query Fixture { ${section.query} }`), {
          InlineFragment: {
            enter(node: InlineFragmentNode) { fragments.push(kindOfType.get(node.typeCondition?.name.value ?? '') ?? fragments.at(-1) ?? kind); },
            leave() { fragments.pop(); },
          },
          Field(node: FieldNode) {
            if (node.name.value !== 'related') return;
            const argument = (name: string) => node.arguments?.find((one) => one.name.value === name)?.value;
            const named = argument('edge');
            if (named?.kind !== 'StringValue') return;
            const inverse = argument('inverse');
            const reversed = inverse?.kind === 'BooleanValue' && inverse.value;
            const edge = contract.edge.find((one) => one.name === named.value);
            const line = source.slice(0, source.indexOf(`edge: "${named.value}"`)).split('\n').length;
            const at = `${join(folder, `${name}.yaml`)}:${line}: sections.${section.id}`;
            if (edge === undefined) { failures.push(`${at}: undeclared edge ${named.value}`); return; }
            const from = reversed ? edge.to : edge.from;
            const to = reversed ? edge.from : edge.to;
            const fromKind = fragments.at(-1) ?? kind;
            if (!includes(from, fromKind)) failures.push(`${at}: ${fromKind} is not a source of ${named.value}`);
            const kinds = argument('kinds');
            if (kinds?.kind === 'ListValue') for (const value of kinds.values) {
              if (value.kind === 'StringValue' && !includes(to, value.value)) failures.push(`${at}: ${value.value} is not a target of ${named.value}`);
            }
          },
        });
      }
    }
    expect(failures).toEqual([]);
  } finally { rmSync(product, { recursive: true, force: true }); }
});


test('every composed record page fits the unchanged native GraphQL node budget', () => {
  const schema = buildSchema(starterSchema().sdl);
  for (const [name, kind] of bindings) {
    const composed = page(kind);
    const cost = queryCost(parse(composed.operation), schema, composed.variables);
    expect({ path: join(folder, `${name}.yaml`), cost, limit: MAX_NODES }).toEqual({
      path: join(folder, `${name}.yaml`), cost: Math.min(cost, MAX_NODES), limit: MAX_NODES,
    });
  }
});
