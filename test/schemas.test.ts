import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ModelFile } from '../src/model/schema.js';
import { CompiledModel } from '../src/model/compiled-schema.js';
import { renderSchema } from '../scripts/generate-schemas.js';

function schemaFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../schema/${name}`, import.meta.url)), 'utf8');
}

describe('schema freshness', () => {
  test('the published model file schema matches the TypeBox source', () => {
    expect(schemaFile('madarch-model.schema.json')).toBe(renderSchema(ModelFile));
  });

  test('the published compiled model schema matches the TypeBox source', () => {
    expect(schemaFile('model.schema.json')).toBe(renderSchema(CompiledModel));
  });
});
