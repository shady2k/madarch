import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ModelFile } from '../src/model/schema.js';
import { CompiledModel } from '../src/model/compiled-schema.js';
import { renderSchema } from '../scripts/generate-schemas.js';
import { DiscussionMessage } from '../src/product/discussion-schema.js';
import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';

function schemaFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../schema/${name}`, import.meta.url)), 'utf8');
}

describe('schema freshness', () => {
  test('the published intended-model schema matches the TypeBox source', () => {
    expect(schemaFile('intended-model.schema.json')).toBe(renderSchema(ModelFile));
  });

  test('the published compiled-model schema matches the TypeBox source', () => {
    expect(schemaFile('compiled-model.schema.json')).toBe(renderSchema(CompiledModel));
  });

  test('the published discussion-message schema matches the TypeBox source', () => {
    expect(schemaFile('product-discussion-message.schema.json')).toBe(renderSchema(DiscussionMessage));
  });

  test('the published time pattern checks dates without format assertions', () => {
    const schema = JSON.parse(schemaFile('product-discussion-message.schema.json')) as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const { format: _format, ...timeWithoutFormat } = properties.time!;
    schema.properties = { ...properties, time: timeWithoutFormat };
    const message = {
      contract: 1, author: 'Ada', thread: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      anchor: { kind: 'page' }, document: 'docs/vision.md',
      sourceCommit: 'b985d519a3107d92edc3e6fa358d4834277e7021', status: 'open',
    };
    const checkTime = (time: string) => Value.Check(schema as TSchema, { ...message, time });

    expect(checkTime('2026-10-14T14:00:00+02:00')).toBe(true);
    expect(checkTime('2026-10-14t14:00:00z')).toBe(true);
    expect(checkTime('2024-02-29T12:00:00Z')).toBe(true);
    expect(checkTime('yesterday')).toBe(false);
    expect(checkTime('2016-12-31T23:59:60Z')).toBe(true);
    expect(Value.Check(DiscussionMessage, { ...message, time: '2026-10-14T12:00:60Z' })).toBe(false);
    expect(checkTime('2024-02-29T12:00:00Z\n')).toBe(false);
    expect(checkTime('2026-02-31T12:00:00Z')).toBe(false);
    expect(checkTime('2025-02-29T12:00:00Z')).toBe(false);
  });
});
