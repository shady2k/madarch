/**
 * The page contract (decision 0036, section 9): the starter's base templates compose against the real schema — every
 * type the entity template can open on, the catalogue's type and a type that holds a body — and every composed
 * operation is accepted by graphql-js `validate`. The component and parameter schemas refuse a template that names
 * what the app does not draw, with the file and the line, and inheritance orders a page's sections as section 6 says.
 */
import { describe, expect, test } from 'bun:test';
import { buildSchema, parse, validate, type GraphQLNamedType, type GraphQLObjectType } from 'graphql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPONENT_NAMES, composePage, parametersSchema, readTemplate, resolveTemplate, splitResponse, titleIn,
  type Bootstrap, type TemplateFile,
} from '../src/page-contract/index.js';
import { validateNode } from '../src/page-contract/validate.js';
import { kindTypeNameOf } from '../src/graphql/names.js';
import { starterSchema } from '../scripts/graphql-starter.js';
import { parseDocument } from 'yaml';

const ROOT = join(import.meta.dir, '..');
const STARTER = join(ROOT, 'src/graphql/starter.graphql');
const PAGES = join(ROOT, 'catalog/templates/pages');

const schema = buildSchema(readFileSync(STARTER, 'utf8'));
const templateNames = ['home', 'entity', 'text', 'catalogue-entity'];

function body(name: string): string {
  return readFileSync(join(PAGES, `${name}.yaml`), 'utf8');
}

const bootstrap: Bootstrap = {
  structureRevision: 'r1',
  home: { id: '00000000-0000-0000-0000-000000000001', kind: 'product', template: 'home' },
  catalogueTemplate: 'catalogue-entity',
  templates: templateNames.map((name) => ({ name, body: body(name) })),
  recordTemplates: [],
  ownTemplates: [],
  roles: ['analyst', 'engineer'],
  roleLeads: [],
};

/** Every object type of the starter schema that implements `Entity`. */
function entityTypes(): string[] {
  return Object.values(schema.getTypeMap())
    .filter((type: GraphQLNamedType): type is GraphQLObjectType => 'getInterfaces' in type && (type as GraphQLObjectType).getInterfaces().some((one) => one.name === 'Entity'))
    .map((type) => type.name)
    .sort();
}

/** The starter catalogue's kinds, and the type each one opens on (src/graphql/names.ts). */
const starter = starterSchema();
const kindTypes = starter.kinds.map((kind) => kindTypeNameOf(kind));

/** One address's operation, and the errors the real schema finds in it. */
function composed(address: Parameters<typeof composePage>[1]): { operation: string; errors: readonly string[] } {
  const page = composePage(bootstrap, address);
  if (page.findings.length > 0) return { operation: '', errors: page.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`) };
  return { operation: page.operation, errors: validate(schema, parse(page.operation)).map((error) => error.message) };
}

describe('the starter templates', () => {
  test('every file reads with no finding', () => {
    for (const name of templateNames) {
      const read = readTemplate(body(name), { name });
      expect({ name, findings: read.findings }).toEqual({ name, findings: [] });
      expect(read.template?.name).toBe(name);
    }
  });

  test('every template of the bootstrap resolves, and the catalogue template extends the base page', () => {
    const templates = new Map<string, TemplateFile>();
    for (const name of templateNames) {
      const read = readTemplate(body(name), { name });
      if (read.template !== undefined) templates.set(name, read.template);
    }
    for (const name of templateNames) expect(resolveTemplate(name, templates).findings).toEqual([]);
    expect(resolveTemplate('catalogue-entity', templates).resolved?.sections.map((one) => one.id)).toEqual(['header', 'fillKind', 'facts', 'dependencies', 'records', 'details', 'diagram', 'outgoing', 'backlinks']);
    expect(resolveTemplate('text', templates).resolved?.sections.map((one) => one.id)).toEqual(['header', 'details', 'body', 'diagram', 'outgoing', 'backlinks']);
  });

  test('the home page composes against the real schema', () => {
    expect(composed({ home: true })).toEqual({ operation: composed({ home: true }).operation, errors: [] });
  });

  test('the entity page composes against every type the schema opens it on', () => {
    // Every kind of the catalogue is a type the entity page opens on, and the schema opens it on no other.
    expect(entityTypes().filter((one) => one !== 'CatalogueEntity')).toEqual([...kindTypes].sort());
    const failures: string[] = [];
    for (const kind of starter.kinds) {
      const page = composed({ kind, id: '00000000-0000-0000-0000-000000000002' });
      if (page.errors.length > 0) failures.push(`${kind}: ${page.errors.join('; ')}`);
    }
    expect(failures).toEqual([]);
  });

  test('the text page composes on a type that holds a body', () => {
    const product = schema.getType('KindProduct') as GraphQLObjectType | undefined;
    expect(product?.getFields()['body']).toBeDefined();
    expect(composed({ template: 'text', kind: 'product', id: '00000000-0000-0000-0000-000000000003' }).errors).toEqual([]);
  });

  test('the catalogue page composes against the catalogue type', () => {
    expect(composed({ kind: 'catalogue', id: '00000000-0000-0000-0000-000000000004' }).errors).toEqual([]);
  });

  test('one operation aliases every section, and its variables are the ones the page uses', () => {
    const page = composePage(bootstrap, { kind: 'code.file', id: '00000000-0000-0000-0000-000000000005' });
    expect(page.findings).toEqual([]);
    for (const section of page.sections) expect(page.operation).toContain(`${section.alias}:`);
    expect(page.operation).toStartWith('query Page(');
    const declared = [...page.operation.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*):/gu)].map((match) => match[1]).sort();
    // The relations are paged: each asks its size and its cursor, so a page past the fiftieth row is reachable.
    expect(declared).toEqual(['backlinks_after', 'backlinks_first', 'id', 'lang', 'outgoing_after', 'outgoing_first']);
    expect(page.variables['id']).toBe('00000000-0000-0000-0000-000000000005');
    // One operation asks every section: a page view is one request.
    expect(page.operation.match(/^query /gmu)).toHaveLength(1);
  });

  test('the split hands each section the value under its alias', () => {
    const page = composePage(bootstrap, { kind: 'code.file', id: '00000000-0000-0000-0000-000000000006' });
    const data = { s_header: { label: 'a' }, s_diagram: { id: 'x' } };
    expect(splitResponse(page, data)['header']).toEqual({ label: 'a' });
    expect(splitResponse(page, data)['diagram']).toEqual({ id: 'x' });
    expect(splitResponse(page, data)['backlinks']).toBeNull();
  });

  test('a section that asks the graph nothing is drawn by the page and holds no part in the operation', () => {
    // A section that names no query (the file page's tabs) is drawn by the page alone: the operation asks only its data.
    const quiet = body('entity').replace('  - id: header\n', '  - id: tabs\n    component: tabs\n    params:\n      sections: [header]\n  - id: header\n');
    const held: Bootstrap = { ...bootstrap, templates: [{ name: 'entity', body: quiet }] };
    const page = composePage(held, { kind: 'code.file', id: '00000000-0000-0000-0000-000000000009' });
    expect(page.findings).toEqual([]);
    expect(page.sections.map((one) => one.id)).toContain('tabs');
    expect(page.operation).not.toContain('s_tabs');
    expect(validate(schema, parse(page.operation))).toEqual([]);
  });

  test('a section is shown to the role its template names, and to every role without one', () => {
    const withRoles = body('entity').replace('    component: header\n', '    component: header\n    roles: { show: [engineer] }\n');
    const held: Bootstrap = { ...bootstrap, templates: [{ name: 'entity', body: withRoles }], roles: ['engineer', 'analyst'] };
    const engineer = composePage(held, { kind: 'code.file', id: '00000000-0000-0000-0000-000000000007', role: 'engineer' });
    const analyst = composePage(held, { kind: 'code.file', id: '00000000-0000-0000-0000-000000000007', role: 'analyst' });
    expect(engineer.sections.map((one) => one.id)).toContain('header');
    expect(analyst.sections.map((one) => one.id)).not.toContain('header');
    // The reader who reads as everything is every role at once, as `/api/settings` names that reader (madarch-64o5.133).
    const everything = composePage(held, { kind: 'code.file', id: '00000000-0000-0000-0000-000000000007', role: 'everything' });
    expect(everything.sections.map((one) => one.id)).toContain('header');
    // A page composed with no role opens as that reader, never as a role no product declares.
    const unnamed = composePage(held, { kind: 'code.file', id: '00000000-0000-0000-0000-000000000007' });
    expect(unnamed.sections.map((one) => one.id)).toContain('header');
  });

  test('a template an address names is composed, and one it cannot bind is refused', () => {
    const declared = body('entity').replace('template: entity\n', 'template: entity\nvariables:\n  wanted:\n    type: String\n    required: true\n');
    const held: Bootstrap = { ...bootstrap, templates: [{ name: 'entity', body: declared.replace('      id\n      kind\n      label\n', '      id\n      kind\n      label\n      wanted: $wanted\n') }] };
    const missing = composePage(held, { kind: 'code.file', id: '00000000-0000-0000-0000-000000000008' });
    expect(missing.findings[0]?.message).toContain('$wanted is required');
    const bound = composePage(held, { kind: 'code.file', id: '00000000-0000-0000-0000-000000000008', params: { wanted: 'x' } });
    expect(bound.findings).toEqual([]);
    expect(bound.variables['wanted']).toBe('x');
    expect(bound.operation).toContain('$wanted: String');
  });

  test('a template states the text of a title per language', () => {
    expect(titleIn({ en: 'Facts', ru: 'Факты' }, 'ru')).toBe('Факты');
    expect(titleIn({ en: 'Facts', ru: 'Факты' }, 'de')).toBe('Facts');
  });
});

describe('the template schema', () => {
  const components = (COMPONENT_NAMES as readonly string[]).join(', ');

  test('a section naming an unknown component is refused at its line', () => {
    const text = 'template: probe\nsections:\n  - id: header\n    component: header\n    query: id\n    params: { titlePath: id }\n  - id: carousel\n    component: carousel\n    query: id\n';
    const read = readTemplate(text, { name: 'probe' });
    expect(read.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`)).toContain(
      `templates/probe.yaml:8: "sections.1.component" is "carousel"; the schema takes one of ${[...COMPONENT_NAMES].map((one) => JSON.stringify(one)).join(', ')}`,
    );
    expect(components).toContain('header');
  });

  test('a parameter the component does not take is refused at the key it stands on', () => {
    const text = 'template: probe\nsections:\n  - id: header\n    component: header\n    query: id\n    params:\n      titlePath: id\n      carousel: true\n';
    const read = readTemplate(text, { name: 'probe' });
    expect(read.findings[0]?.line).toBe(8);
    expect(read.findings[0]?.message).toContain('"sections.header.params" names "carousel"');
  });

  test('a component\'s required parameter is refused when it is missing', () => {
    const read = readTemplate('template: probe\nsections:\n  - id: t\n    component: table\n    query: id\n    params:\n      path: rows\n', { name: 'probe' });
    expect(read.findings.some((one) => one.message.includes('names no "columns"'))).toBe(true);
  });

  test('a template is its file\'s name, and a page needs at least one section of data', () => {
    const renamed = readTemplate('template: other\nsections: []\n', { name: 'probe' });
    expect(renamed.findings[0]?.message).toContain('a template is its file\'s name');
    const noQuery = readTemplate('template: probe\nsections:\n  - id: t\n    component: facts\n    params:\n      rows: [{ label: { en: A }, path: a }]\n', { name: 'probe' });
    expect(noQuery.findings.some((one) => one.message.includes('states no query'))).toBe(true);
  });

  test('every component has a parameter schema a template body is judged by', () => {
    for (const component of COMPONENT_NAMES) {
      const held = parametersSchema(component);
      expect(held['type']).toBe('object');
      const document = parseDocument('rows: []\n');
      expect(validateNode('rows: []\n', document.contents as never, held, 'templates/x.yaml')).toBeArray();
    }
  });
});
