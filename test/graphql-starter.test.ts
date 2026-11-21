/**
 * The starter SDL the frontend builds against (decision 0036, section 9): src/graphql/starter.graphql is what the
 * starter catalogue derives now, graphql-js accepts it, and every catalogue kind is in it — a kind's types carry the
 * `Kind` prefix that keeps them apart from the engine's own names (src/graphql/names.ts). The system kind
 * `manifest.kind` uses the engine's single `CatalogueEntity` type instead of a duplicate product type.
 */
import { describe, expect, test } from 'bun:test';
import { buildSchema } from 'graphql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { starterSchema } from '../scripts/graphql-starter.js';

describe('the starter catalogue schema', () => {
  test('is src/graphql/starter.graphql, byte for byte', () => {
    expect(starterSchema().sdl).toBe(readFileSync(join(import.meta.dir, '..', 'src/graphql/starter.graphql'), 'utf8'));
  });

  test('is accepted by graphql-js buildSchema', () => {
    const schema = buildSchema(starterSchema().sdl);
    expect(schema.getQueryType()?.name).toBe('Query');
    expect(schema.getType('KindCodeFile')).toBeDefined();
    expect(schema.getType('KindCodeRepository')).toBeDefined();
    // The structured page template went with the page layer: no product kind is named `Template`.
    expect(schema.getType('KindTemplate')).toBeUndefined();
  });

  test('holds every starter kind, with manifest.kind represented by CatalogueEntity', () => {
    const starter = starterSchema();
    const schema = buildSchema(starter.sdl);
    for (const kind of starter.kinds) {
      const type = kind === 'manifest.kind'
        ? 'CatalogueEntity'
        : `Kind${kind.split(/[._-]/u).filter((part) => part !== '').map((part) => part[0]!.toUpperCase() + part.slice(1)).join('')}`;
      expect(schema.getType(type), kind).toBeDefined();
    }
    expect(starter.kinds).toContain('manifest.kind');
    expect(schema.getType('KindManifestKind')).toBeUndefined();
    expect(schema.getQueryType()!.getFields()['allManifestKind']).toBeUndefined();
    // The page-template kind the decision of 2026-11-15 names sits beside the engine's own `PageTemplate`.
    expect(schema.getType('KindPageTemplate')).toBeDefined();
    expect(schema.getType('PageTemplate')).toBeDefined();
  });
});
