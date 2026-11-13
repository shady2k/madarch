/**
 * The contract as code, first (decision 0036, section 9): the schema generator reproduces the golden SDL byte for
 * byte, graphql-js accepts it, a reserved name and a name collision are refused naming both declarations, and a
 * fixture manifest covering every scalar, a reference, a repeated edge with attributes and the edges' and the
 * reference's inverses reaches the schema as section 1 to 4 describe it.
 */
import { describe, expect, test } from 'bun:test';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds, type KindsManifest } from '../src/product/manifest/kinds.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { SchemaRefusal } from '../src/graphql/names.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';

/** A product folder holding one manifest text and the template its kinds name, read the way a product's is. */
function manifestOf(text: string): KindsManifest {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-graphql-'));
  mkdirSync(join(folder, 'templates'), { recursive: true });
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFileSync(join(folder, 'templates/entity.yaml'), 'template: entity\n');
  const file = join(folder, 'madarch/catalog.yaml');
  writeFileSync(file, text);
  const read = parseKinds(text, file, folder);
  expect(read.findings).toEqual([]);
  return read;
}

function fixtureManifest(): KindsManifest {
  return manifestOf(readFileSync(join(import.meta.dir, 'graphql/fixture-manifest.yaml'), 'utf8'));
}

function refusalOf(text: string): SchemaRefusal {
  try {
    graphqlSchemaOf(publishedManifestOf(manifestOf(text)));
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaRefusal);
    return error as SchemaRefusal;
  }
  throw new Error('the manifest was accepted, and it should have been refused');
}

describe('the schema of a published manifest', () => {
  test('reproduces the golden SDL byte for byte', () => {
    const sdl = graphqlSchemaOf(publishedManifestOf(fixtureManifest()));
    expect(sdl).toBe(readFileSync(join(import.meta.dir, 'graphql/fixture.golden.graphql'), 'utf8'));
  });

  test('is accepted by graphql-js buildSchema, with the scalar, the reference and the edges it was given', () => {
    const schema = buildSchema(graphqlSchemaOf(publishedManifestOf(fixtureManifest())));
    expect(schema.getQueryType()?.name).toBe('Query');
    expect(schema.getType('BigInt')).toBeDefined();
    expect(schema.getType('DateTime')).toBeDefined();
    expect(schema.getType('JSON')).toBeDefined();
    const file = schema.getType('DemoFile') as GraphQLObjectType;
    const fields = file.getFields();
    expect(fields['repository']?.type.toString()).toBe('DemoRepository');
    expect(fields['demoTouchedOf']?.type.toString()).toBe('DemoTouchedConnection!');
    expect(fields['demoContainsOf']?.type.toString()).toBe('DemoContainsConnection!');
  });

  test('is one schema from one manifest: two derivations are identical', () => {
    const manifest = publishedManifestOf(fixtureManifest());
    expect(graphqlSchemaOf(manifest)).toBe(graphqlSchemaOf(manifest));
  });

  test('shows both ways of every edge and the inverse of a reference', () => {
    const sdl = graphqlSchemaOf(publishedManifestOf(fixtureManifest()));
    for (const field of [
      'demoContains(', 'demoContainsOf(', 'demoTouched(', 'demoTouchedOf(', 'demoAuthored(', 'demoAuthoredOf(', 'repositoryOfDemoFile(',
    ]) expect(sdl).toContain(field);
    expect(sdl).toContain('discriminator: String!');
    expect(sdl).toContain('contested: [String!]!');
    expect(sdl).toContain('pathOpinions: [Opinion!]!');
  });

  test('shows the catalogue as an entity type with its own roots', () => {
    const sdl = graphqlSchemaOf(publishedManifestOf(fixtureManifest()));
    expect(sdl).toContain('mentions(first: Int, after: String): MentionsConnection!');
    expect(sdl).toContain('mentionsOf(first: Int, after: String): MentionsConnection!');
    expect(sdl).toContain('type MentionsEdge {');
    expect(sdl).toContain('type CatalogueEntity implements Entity {');
    expect(sdl).toContain('catalogueEntity(name: String!, lang: String): CatalogueEntity');
    expect(sdl).toContain('allCatalogueEntity(where: CatalogueEntityWhere, orderBy: [CatalogueEntityOrder!], first: Int, after: String, lang: String): CatalogueEntityConnection!');
    expect(sdl).toContain('home(lang: String): Entity');
    expect(sdl).toContain('derivesFrom(where: CatalogueEntityWhere');
    expect(sdl).toContain('fields: [CatalogueField!]!');
  });

  test('keeps the mechanism\'s page template apart from a product kind named template', () => {
    const sdl = graphqlSchemaOf(publishedManifestOf(manifestOf(`
kinds:
  template:
    template: templates/entity.yaml
    source: graph
    title: name
`)));
    expect(sdl).toContain('type Template implements Entity');
    expect(sdl).toContain('templates: [PageTemplate!]!');
  });

  test('refuses a reserved type name, naming the declaration and the reserved name', () => {
    const error = refusalOf(`
kinds:
  demo.edge:
    template: templates/entity.yaml
    source: graph
    title: name
`);
    expect(error.message).toContain('the kind "demo.edge"');
    expect(error.message).toContain('"DemoEdge"');
    expect(error.message).toContain('reserved');
  });

  test('refuses a reserved field name, naming the field and the kind', () => {
    const error = refusalOf(`
kinds:
  demo.file:
    template: templates/entity.yaml
    source: graph
    title: path
    fields:
      - { name: backlinks, type: text, producers: [agent] }
`);
    expect(error.message).toContain('the field "backlinks" of the kind "demo.file"');
    expect(error.message).toContain('reserved');
  });

  test('refuses two kinds that encode to one type name, naming both declarations', () => {
    const error = refusalOf(`
kinds:
  demo.file:
    template: templates/entity.yaml
    source: graph
    title: path
  demo-file:
    template: templates/entity.yaml
    source: graph
    title: path
`);
    expect(error.message).toContain('the kind "demo.file"');
    expect(error.message).toContain('the kind "demo-file"');
    expect(error.message).toContain('"DemoFile"');
  });

  test('refuses a field and an edge that encode to one field name on a type, naming both', () => {
    const error = refusalOf(`
kinds:
  demo.repository:
    template: templates/entity.yaml
    source: graph
    title: name
    fields:
      - { name: links_to, type: text, producers: [agent] }
  demo.file:
    template: templates/entity.yaml
    source: graph
    title: path
edges:
  - name: links-to
    from: [demo.repository]
    to: [demo.file]
`);
    expect(error.message).toContain('the field "links_to" of the kind "demo.repository"');
    expect(error.message).toContain('the edge "links-to"');
    expect(error.message).toContain('"linksTo"');
  });

  test('refuses an edge that names a kind the manifest does not declare, naming both', () => {
    const error = refusalOf(`
kinds:
  demo.repository:
    template: templates/entity.yaml
    source: graph
    title: name
edges:
  - name: demo.contains
    from: [demo.repository]
    to: [demo.absent]
`);
    expect(error.message).toContain('the edge "demo.contains"');
    expect(error.message).toContain('"demo.absent"');
  });
});
