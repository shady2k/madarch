/**
 * A file's source, highlighted by its language (madarch-u3vw.16): the graph's language word names the grammar, and every
 * token's colour is a kit variable, so the same spans read in light and dark.
 */
import { expect, test } from 'bun:test';
import { grammarOf, highlightLines } from './file-highlight.js';

test('the graph\'s language names the grammar, and an unknown one falls back to the path', () => {
  expect(grammarOf('typescript', 'src/index.ts')).toBe('typescript');
  expect(grammarOf('yaml', 'config/cloud-resource.yaml')).toBe('yaml');
  expect(grammarOf(undefined, 'src/main.mjs')).toBe('javascript');
  expect(grammarOf('unknown-language', 'notes.txt')).toBeUndefined();
});

test('a TypeScript line becomes tokens coloured by the kit\'s variables', async () => {
  const lines = await highlightLines('// The answer\nexport const answer = 42;\n', 'typescript');
  expect(lines).toHaveLength(2);
  const comment = lines[0]!.map((token) => token.content).join('');
  expect(comment).toContain('// The answer');
  expect(lines[0]!.some((token) => token.color === 'var(--syntax-comment)')).toBe(true);
  expect(lines[1]!.some((token) => token.color === 'var(--syntax-keyword)')).toBe(true);
  expect(lines[1]!.some((token) => token.color === 'var(--syntax-number)')).toBe(true);
});

test('a text with no grammar is one plain token a line, still from the kit', async () => {
  const lines = await highlightLines('plain text\nsecond line', undefined);
  expect(lines.map((line) => line.map((token) => token.content).join(''))).toEqual(['plain text', 'second line']);
  expect(lines[0]![0]!.color).toBe('var(--text)');
});
