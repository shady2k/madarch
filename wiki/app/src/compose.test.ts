/**
 * The app's composition against the real schema (decision 0036, section 9): every starter base template composes for a
 * type `src/graphql/starter.graphql` holds, and graphql-js accepts the operation. The schema is read here, so the app
 * test names no kind: a type and a kind name are derived from the SDL itself.
 */
import { expect, test } from 'bun:test';
import { buildSchema, parse, validate, type GraphQLNamedType, type GraphQLObjectType } from 'graphql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composePage, readTemplate, splitResponse, type Bootstrap, type TemplateFile } from '../../../src/page-contract/index.js';

const ROOT = join(import.meta.dir, '../../..');
const schema = buildSchema(readFileSync(join(ROOT, 'src/graphql/starter.graphql'), 'utf8'));
const names = ['home', 'entity', 'text', 'catalogue-entity'];

const bootstrap: Bootstrap = {
  structureRevision: 'r',
  home: { id: '00000000-0000-0000-0000-0000000000aa', kind: 'product', template: 'home' },
  catalogueTemplate: 'catalogue-entity',
  templates: names.map((name) => ({ name, body: readFileSync(join(ROOT, 'catalog/templates/pages', `${name}.yaml`), 'utf8') })),
  recordTemplates: [],
  ownTemplates: [],
  roles: [],
};

/** The kinds the schema holds as entity types, read from the SDL's own names (a type name split into words). */
function entityKinds(): string[] {
  return Object.values(schema.getTypeMap())
    .filter((type: GraphQLNamedType): type is GraphQLObjectType => 'getInterfaces' in type && (type as GraphQLObjectType).getInterfaces().some((one) => one.name === 'Entity'))
    .map((type) => type.name.replace(/([a-z0-9])([A-Z])/gu, '$1.$2').toLowerCase())
    .sort();
}

function errorsOf(address: Parameters<typeof composePage>[1]): string[] {
  const page = composePage(bootstrap, address);
  if (page.findings.length > 0) return page.findings.map((one) => one.message);
  return validate(schema, parse(page.operation)).map((error) => error.message);
}

test('every base template composes and is valid against the real schema', () => {
  const failures: string[] = [];
  for (const kind of entityKinds()) {
    const page = composePage(bootstrap, { kind, id: '00000000-0000-0000-0000-000000000001' });
    // The text template names a field only a body-holding type answers: it is composed where it is bound, not everywhere.
    if (page.findings.length > 0) failures.push(`${kind}: ${page.findings.map((one) => one.message).join('; ')}`);
  }
  expect(failures).toEqual([]);
  const entityErrors = entityKinds().flatMap((kind) => errorsOf({ kind, id: '00000000-0000-0000-0000-000000000001' }).map((message) => `${kind}: ${message}`));
  expect(entityErrors).toEqual([]);
  expect(errorsOf({ home: true })).toEqual([]);
  expect(errorsOf({ kind: 'catalogue', id: '00000000-0000-0000-0000-000000000002' })).toEqual([]);
});

test('the text template composes on the type whose body it draws', () => {
  const product = schema.getType('Product') as GraphQLObjectType | undefined;
  expect(product?.getFields()['body']).toBeDefined();
  expect(errorsOf({ template: 'text', kind: 'product', id: '00000000-0000-0000-0000-000000000003' })).toEqual([]);
});

test('a page composes to one operation, and the split hands back each section', () => {
  const kind = entityKinds()[0]!;
  const page = composePage(bootstrap, { kind, id: '00000000-0000-0000-0000-000000000004', lang: 'ru', role: 'all' });
  expect(page.findings).toEqual([]);
  expect(page.operation.match(/^query /gu)).toHaveLength(1);
  expect(page.variables['lang']).toBe('ru');
  expect(splitResponse(page, {})['header']).toBeNull();
});

test('the starter templates read with no finding, and the catalogue template extends the base page', () => {
  const templates = new Map<string, TemplateFile>();
  for (const name of names) {
    const read = readTemplate(readFileSync(join(ROOT, 'catalog/templates/pages', `${name}.yaml`), 'utf8'), { name });
    expect(read.findings).toEqual([]);
    if (read.template !== undefined) templates.set(name, read.template);
  }
  expect(templates.get('catalogue-entity')?.extends).toBe('entity');
  expect(templates.get('text')?.extends).toBe('entity');
});
