import { expect, test } from 'bun:test';
import { decodeCitation } from '../src/page-contract/citation.js';

test('citations validate the wire coordinates without guessing aliases', () => {
  const citation = { repository: 'code', path: 'src/a.ts', lineStart: 2, lineEnd: 4 };
  expect(decodeCitation({ ...citation, field: 'title' }, '/wire:1')).toEqual(citation);
  expect(decodeCitation({ repository: null, path: null, lineStart: null, lineEnd: null }, '/wire:1').path).toBeNull();
  for (const invalid of [null, [], {}, { ...citation, repository: 7 }, { ...citation, path: 7 }, { ...citation, lineStart: 0 }, { ...citation, lineStart: 1.5 }, { ...citation, lineStart: null }, { ...citation, lineEnd: 1 }, { repo: 'code', file: 'a.ts', start: 2, end: 4 }]) {
    expect(() => decodeCitation(invalid, '/wire:1')).toThrow('/wire:1: citation');
  }
});
