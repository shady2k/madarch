/** The status bar's word count: whitespace-separated words of the document. */
import { describe, expect, test } from 'bun:test';
import { wordCount } from './text.js';

describe('the status bar word count', () => {
  test('counts whitespace-separated words over the document text', () => {
    expect(wordCount('one two three')).toBe(3);
    expect(wordCount('# Title\n\nA paragraph with words.')).toBe(6);
    expect(wordCount('  spaced\twords\nhere  ')).toBe(3);
  });

  test('an empty document counts nothing', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   \n\t ')).toBe(0);
  });
});
