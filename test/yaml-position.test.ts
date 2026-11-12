import { expect, test } from 'bun:test';
import { LineCounter, parseDocument } from 'yaml';
import { lineForPath, lineLocator } from '../src/model/yaml-position.js';

test('indexed locations retain first duplicate, aliases, sequences and missing paths', () => {
  const lines = new LineCounter();
  const doc = parseDocument('root:\n  key: first\n  key: second\n  list: [one, two]\n  anchor: &a {child: value}\n  alias: *a\n', { lineCounter: lines, uniqueKeys: true });
  const locate = lineLocator(doc, lines);
  for (const path of [['root', 'key'], ['root', 'list', 1], ['root', 'alias', 'child'], ['root', 'missing']] as (string | number)[][]) {
    expect(locate(path)).toBe(lineForPath(doc, lines, path));
  }
  expect(locate(['root', 'key'])).toBe(2);
  expect(doc.errors.length).toBeGreaterThan(0);
  expect(locate(['root', 'alias', 'child'])).toBe(6);
});

test('a fresh locator sees mutations and direct lookups never cache them', () => {
  const lines = new LineCounter();
  const doc = parseDocument('first: 1\nsecond: 2\n', { lineCounter: lines });
  const before = lineLocator(doc, lines);
  expect(before(['second'])).toBe(2);
  doc.delete('second');
  expect(lineForPath(doc, lines, ['second'])).toBe(1);
  expect(lineLocator(doc, lines)(['second'])).toBe(1);
});
