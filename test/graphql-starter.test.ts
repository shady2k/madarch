/**
 * The starter SDL the frontend builds against (decision 0036, section 9): src/graphql/starter.graphql is what the
 * starter catalogue derives now, graphql-js accepts it, and the kinds a reserved name leaves out are the ones the
 * generator names — a catalogue change that adds or removes one fails here instead of passing unseen.
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
    expect(schema.getType('CodeFile')).toBeDefined();
    expect(schema.getType('CodeRepository')).toBeDefined();
    // The structured page template went with the page layer: no product kind is named `Template`.
    expect(schema.getType('Template')).toBeUndefined();
  });

  test('leaves out no kind: every starter kind encodes to a name the schema holds', () => {
    expect(starterSchema().refused).toEqual([]);
  });
});
