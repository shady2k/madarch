import { describe, expect, test } from 'bun:test';
import { LineCounter, parseDocument } from 'yaml';
import { checkStrictYaml } from '../src/model/strict-yaml.js';

const FILE = '/product/example/model.yaml';

describe('strict YAML anchor CST positions', () => {
  const cases = [
    { name: 'mapping value with a later comment lookalike', source: 'value: &held\n  # &held is only a comment\n  child: actual\n', line: 1, path: 'value' },
    { name: 'sequence value with a later comment lookalike', source: 'values:\n  - &held\n    # &held is only a comment\n    child: actual\n', line: 2, path: 'values[0]' },
    { name: 'root collection with a quoted repeated marker', source: '&held\nquoted: "&held"\nchild: actual\n', line: 1, path: '' },
    { name: 'empty anchored value before a repeated comment', source: 'value: &held # &held is only a comment\nnext: actual\n', line: 1, path: 'value' },
    { name: 'empty sequence value', source: 'values:\n  - &held # &held is only a comment\n  - actual\n', line: 2, path: 'values[0]' },
    { name: 'anchored scalar key', source: '? &held key\n: value\n', line: 1, path: 'key' },
    { name: 'reused marker names on separate nodes', source: 'first: &held\n  # &held is only a comment\n  child: one\nsecond: &held\n  # &held is only a comment\n  child: two\n', anchors: [{ line: 1, path: 'first' }, { line: 4, path: 'second' }] },
    { name: 'marker names with punctuation', source: 'value: &held.name\n  # &held.name is only a comment\n  child: actual\n', line: 1, path: 'value' },
    { name: 'quoted marker and comment without an anchor', source: 'quoted: "&held"\n# &held is only a comment\n', anchors: [] },
  ];
  for (const keepSourceTokens of [false, true]) for (const fixture of cases) {
    test(`${fixture.name}; retained CST ${keepSourceTokens}`, () => {
      const counter = new LineCounter();
      const document = parseDocument(fixture.source, { lineCounter: counter, uniqueKeys: false, keepSourceTokens });
      expect(document.errors).toEqual([]);
      const errors = checkStrictYaml(document, counter, FILE, fixture.source);
      const anchors = errors.filter((error) => error.message.startsWith('anchor '));
      expect(anchors.map(({ line, path }) => ({ line, path }))).toEqual(fixture.anchors ?? [{ line: fixture.line, path: fixture.path }]);
      for (const error of anchors) {
        expect(error.file).toBe(FILE);
        expect(error.message).toContain('strict YAML forbids anchors');
      }
    });
  }

  test('CST anchor positioning retains aliases, explicit tags, merges and duplicate diagnostics', () => {
    const source = 'base: &held\n  x: one\nalias: *held\nmerge:\n  <<: *held\ntagged: !!str value\nduplicate: one\nduplicate: two\n';
    const counter = new LineCounter();
    const document = parseDocument(source, { lineCounter: counter, uniqueKeys: false });
    expect(document.errors).toEqual([]);
    const errors = checkStrictYaml(document, counter, FILE, source);
    expect(errors.some((error) => error.line === 1 && error.path === 'base' && error.message.startsWith('anchor '))).toBe(true);
    expect(errors.some((error) => error.line === 3 && error.path === 'alias' && error.message.startsWith('alias '))).toBe(true);
    expect(errors.some((error) => error.line === 5 && error.path === 'merge' && error.message.startsWith('merge key '))).toBe(true);
    expect(errors.some((error) => error.line === 5 && error.path === 'merge.<<' && error.message.startsWith('alias '))).toBe(true);
    expect(errors.some((error) => error.line === 6 && error.path === 'tagged' && error.message.startsWith('explicit tag '))).toBe(true);
    expect(errors.some((error) => error.line === 8 && error.path === 'duplicate' && error.message.startsWith('key "duplicate" is repeated'))).toBe(true);
  });
});
