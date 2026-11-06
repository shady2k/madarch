/**
 * The one name a record is presented by (decision 0033, item 7): the extract driver names a file
 * `code.file:<path>` and a symbol `code.symbol:<path>#<name>`; the static stages carry the same names in
 * `path` and `globalName`. The reader answers both shapes the same, and a place is read from either
 * shape of provenance.
 */
import { describe, expect, test } from 'bun:test';
import { presentedKey, spanFromProvenance } from '../src/knowledge/graph-read.js';

describe('the key a record is presented by', () => {
  test('a file is named by its path, whichever producer wrote it', () => {
    expect(presentedKey('code.file', { recordKey: 'code.file:src/a.ts', path: 'src/a.ts' })).toBe('code.file:src/a.ts');
    expect(presentedKey('code.file', { recordKey: 'file:9f2c', path: 'src/a.ts' })).toBe('code.file:src/a.ts');
  });

  test('a symbol is named by its global name without the repository prefix', () => {
    expect(presentedKey('code.symbol', { recordKey: 'code.symbol:src/a.ts#g', globalName: 'shop:src/a.ts#g' })).toBe('code.symbol:src/a.ts#g');
    expect(presentedKey('code.symbol', { recordKey: 'symbol:77aa', globalName: 'shop:src/a.ts#g' })).toBe('code.symbol:src/a.ts#g');
    // A global name that names no repository is the whole name.
    expect(presentedKey('code.symbol', { recordKey: 'symbol:77aa', globalName: 'src/a.ts#g' })).toBe('code.symbol:src/a.ts#g');
  });

  test('every other kind is named by its record key, unchanged', () => {
    expect(presentedKey('code.table', { recordKey: 'code.table:shop/public.items', path: 'db/x.sql' })).toBe('code.table:shop/public.items');
    expect(presentedKey('code.file', { recordKey: 'file:9f2c' })).toBe('file:9f2c');
    // A path that is no text, and a global name that is no text, name the record by its own key.
    expect(presentedKey('code.file', { recordKey: 'file:9f2c', path: 3 })).toBe('file:9f2c');
    expect(presentedKey('code.symbol', { recordKey: 'symbol:77aa', globalName: 3 })).toBe('symbol:77aa');
    expect(presentedKey('code.symbol', { recordKey: 'symbol:77aa', globalName: '' })).toBe('code.symbol:');
  });
});

describe('the place a record was read at', () => {
  test('the static stages state it as their fact\'s place, in the provenance', () => {
    expect(spanFromProvenance({
      provenance: { place: { file: 'db/migrations/0001.sql', range: { startLine: 2, endLine: 4, startByte: 10, endByte: 40 } }, source: { system: 'x', version: '1' } },
    })).toEqual({ path: 'db/migrations/0001.sql', lineStart: 2, lineEnd: 4, byteStart: 10, byteEnd: 40 });
  });

  test('a record that names no place, or a place without a range, names none', () => {
    expect(spanFromProvenance({})).toBeUndefined();
    expect(spanFromProvenance({ provenance: { source: {} } })).toBeUndefined();
    expect(spanFromProvenance({ provenance: { place: { file: 'a.ts' } } })).toBeUndefined();
    expect(spanFromProvenance({ provenance: { place: { file: 'a.ts', range: { startLine: 1 } } } })).toBeUndefined();
    // A field of the wrong shape is no place either: an array is no provenance and no place, a file that is no text
    // and a line that is no number are each refused.
    expect(spanFromProvenance({ provenance: [] })).toBeUndefined();
    expect(spanFromProvenance({ provenance: { place: [] } })).toBeUndefined();
    expect(spanFromProvenance({ provenance: { place: { file: 7, range: { startLine: 1, endLine: 1, startByte: 0, endByte: 1 } } } })).toBeUndefined();
    expect(spanFromProvenance({ provenance: { place: { file: 'a.ts', range: { startLine: '1', endLine: 1, startByte: 0, endByte: 1 } } } })).toBeUndefined();
    expect(spanFromProvenance({ provenance: { place: { file: 'a.ts', range: { startLine: 1, endLine: null, startByte: 0, endByte: 1 } } } })).toBeUndefined();
    expect(spanFromProvenance({ provenance: { place: { file: 'a.ts', range: { startLine: 1, endLine: 1, startByte: 0, endByte: null } } } })).toBeUndefined();
    expect(spanFromProvenance({ provenance: { place: { file: 'a.ts', range: [] } } })).toBeUndefined();
  });
});
