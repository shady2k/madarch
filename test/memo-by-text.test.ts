import { describe, expect, test } from 'bun:test';
import { memoByText } from '../src/model/memo.js';

describe('a pure answer kept by the exact text it was computed from', () => {
  test('computes one text once and another text of its own', () => {
    let calls = 0;
    const measure = memoByText((text: string) => { calls += 1; return text.length; });
    expect(measure('alpha')).toBe(5);
    expect(measure('alpha')).toBe(5);
    expect(calls).toBe(1);
    expect(measure('beta')).toBe(4);
    expect(calls).toBe(2);
  });

  test('keeps an undefined answer without computing it again', () => {
    let calls = 0;
    const measure = memoByText((_text: string): undefined => { calls += 1; return undefined; });
    expect(measure('short')).toBeUndefined();
    expect(measure('short')).toBeUndefined();
    expect(calls).toBe(1);
  });

  test('drops the least recently used text, not the text read most recently', () => {
    let calls = 0;
    const measure = memoByText((text: string) => { calls += 1; return `${text}!`; }, 2);
    expect(measure('one')).toBe('one!');
    expect(measure('two')).toBe('two!');
    // Reading `one` again makes `two` the least recently used revision.
    expect(measure('one')).toBe('one!');
    expect(calls).toBe(2);
    expect(measure('three')).toBe('three!');
    expect(calls).toBe(3);
    expect(measure('one')).toBe('one!');
    expect(calls).toBe(3);
    expect(measure('two')).toBe('two!');
    expect(calls).toBe(4);
  });

  test('refuses a limit that cannot hold one text', () => {
    expect(() => memoByText((text: string) => text, 0)).toThrow('a text cache needs a positive whole limit');
    expect(() => memoByText((text: string) => text, 1.5)).toThrow('a text cache needs a positive whole limit');
  });
});
