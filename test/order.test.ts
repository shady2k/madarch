import { describe, expect, test } from 'bun:test';
import { byCodePoint, sortedByCodePoint } from '../src/model/order.js';

describe('byCodePoint', () => {
  test('negative when the first is less', () => {
    expect(byCodePoint('a', 'b')).toBeLessThan(0);
  });

  test('positive when the first is greater', () => {
    expect(byCodePoint('b', 'a')).toBeGreaterThan(0);
  });

  test('zero when equal', () => {
    expect(byCodePoint('a', 'a')).toBe(0);
  });
});

describe('sortedByCodePoint', () => {
  test('sorts by code point, not by locale collation', () => {
    // A locale-aware sort could interleave case or diacritics differently;
    // code-point order is simple and always the same: digits, then
    // uppercase, then lowercase.
    expect(sortedByCodePoint(['b', 'A', 'a', '1'])).toEqual(['1', 'A', 'a', 'b']);
  });

  test('does not mutate its input', () => {
    const input = ['b', 'a'];
    sortedByCodePoint(input);
    expect(input).toEqual(['b', 'a']);
  });
});
