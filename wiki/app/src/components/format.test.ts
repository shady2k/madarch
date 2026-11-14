/** The formatting helpers a page uses to write a value for a reader (madarch-64o5.83). */
import { expect, test } from 'bun:test';
import { durationWords } from './format.js';

test('a span of work reads in the reader\'s language, with the unit a person says', () => {
  expect(durationWords(12_000, 'en')).toBe('12 sec');
  expect(durationWords(214_000, 'en')).toBe('3 min 34 sec');
  expect(durationWords(3_725_000, 'en')).toBe('1 hr 02 min');
  expect(durationWords(214_000, 'ru')).toBe('3 мин 34 с');
  expect(durationWords(0, 'en')).toBe('0 sec');
});
