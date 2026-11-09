import { describe, expect, test } from 'bun:test';
import { byCodePoint } from '../src/model/order.js';

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
