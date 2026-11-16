import { describe, expect, test } from 'bun:test';
import { matchMentionNames, mentionStrings, MentionTextError, scanMentionText } from '../src/graph/mention-text';

const uid = '01234567-89ab-cdef-0123-456789abcdef';
const token = `[[uid:${uid}]]`;
const candidate = { uid, kind: 'domain', kindLabel: 'Domain', label: 'Payments' };
const dictionary = [{ name: 'Payments', candidates: [candidate] }];

describe('0039 items 5 and 29 mention token scanner', () => {
  test('repeated tokens have code-point, not UTF-16, occurrence offsets', () => {
    expect(scanMentionText(`😀${token} ${token}`)).toEqual({
      tokens: [{ uid, start: 1, end: 45 }, { uid, start: 46, end: 90 }],
      excludedSpans: [{ start: 1, end: 45 }, { start: 46, end: 90 }],
    });
  });
  test('escapes consume left to right and escape a complete token', () => {
    expect(scanMentionText(`\\${token}`)).toEqual({ tokens: [], excludedSpans: [{ start: 0, end: 45 }] });
    expect(scanMentionText(`\\\\${token}`).tokens).toEqual([{ uid, start: 2, end: 46 }]);
    expect(scanMentionText(`\\\\\\${token}`).tokens).toEqual([]);
    expect(scanMentionText(`\\[[uid:bad]] ${token}`).tokens).toEqual([{ uid, start: 13, end: 57 }]);
    expect(scanMentionText('\\\\')).toEqual({ tokens: [], excludedSpans: [] });
    expect(scanMentionText('\\x')).toEqual({ tokens: [], excludedSpans: [] });
  });
  test('ordinary brackets and nonreserved names remain plain text', () => {
    expect(scanMentionText('[[Payments]] [uid:x] [[UID:x]]')).toEqual({ tokens: [], excludedSpans: [] });
  });
  test('malformed reserved tokens refuse with path, line, span and offending value', () => {
    for (const value of ['[[uid:x]]', '[[uid]]', '[[uid=bad]]', `[[uid:${uid.toUpperCase()}]]`,
      `[[uid:${uid.replace('-', '_')}]]`, `[[uid:${uid}]`, `[[uid:${uid}`, `[[uid:${uid}x]]`]) {
      try {
        scanMentionText(`😀\n${value}`, '/values/body');
        throw new Error(`accepted malformed token ${value}`);
      } catch (error) {
        expect(error).toBeInstanceOf(MentionTextError);
        expect(error).toMatchObject({ code: 'SCHEMA_INVALID', path: '/values/body', line: 2,
          start: 2, end: 2 + Array.from(value).length, actual: value, retryable: false });
        expect((error as Error).message).toContain('/values/body:2');
      }
    }
  });
  test('line numbers advance over an escaped multiline token', () => {
    expect(() => scanMentionText('\\[[uid:\nignored]]\n[[uid:bad]]', '/body')).toThrow('/body:3');
  });
  test('each UUID hyphen and all hexadecimal positions are checked', () => {
    for (let index = 0; index < uid.length; index++) {
      const invalid = uid.slice(0, index) + (uid[index] === '-' ? '0' : 'g') + uid.slice(index + 1);
      expect(() => scanMentionText(`[[uid:${invalid}]]`)).toThrow(MentionTextError);
    }
  });
});

describe('0039 items 5 and 6 exact declared-name Aho–Corasick hints', () => {
  test('names are literal, with no normalization or guessed word boundary', () => {
    expect(matchMentionNames('payments Payments prePayments A+B', [
      ...dictionary, { name: 'A+B', candidates: [candidate] },
    ])).toEqual([
      { name: 'Payments', start: 9, end: 17, candidates: [candidate] },
      { name: 'Payments', start: 21, end: 29, candidates: [candidate] },
      { name: 'A+B', start: 30, end: 33, candidates: [candidate] },
    ]);
  });
  test('failure links retain overlapping patterns, suffixes and repeated occurrences', () => {
    const words = ['he', 'she', 'his', 'hers'];
    expect(matchMentionNames('ushers his he', words.map(name => ({ name, candidates: [candidate] })))
      .map(({ name, start, end }) => ({ name, start, end }))).toEqual([
        { name: 'she', start: 1, end: 4 }, { name: 'he', start: 2, end: 4 },
        { name: 'hers', start: 2, end: 6 }, { name: 'his', start: 7, end: 10 },
        { name: 'he', start: 11, end: 13 },
      ]);
  });
  test('excludes explicit and escaped tokens including a match crossing their boundary', () => {
    const text = `${token} \\[[Payments]] Payments`;
    const names = [...dictionary, { name: uid, candidates: [candidate] },
      { name: ']] Payments', candidates: [candidate] }];
    expect(matchMentionNames(text, names)).toEqual([
      { name: 'Payments', start: 59, end: 67, candidates: [candidate] },
    ]);
    expect(matchMentionNames(`\\[[uid:Payments`, dictionary)).toEqual([]);
  });
  test('homonyms retain every candidate, deduplicate exact copies and sort by code point', () => {
    const candidates = [
      { uid: '😀', kind: 'component', kindLabel: 'Component', label: 'Component', domain: 'Billing' },
      { uid: '\uE000', kind: 'domain', kindLabel: 'Domain', label: 'Domain' },
      candidate,
    ];
    const entries = [{ name: '😀', candidates }, { name: '😀', candidates: [candidate] }];
    expect(matchMentionNames('x😀😀', entries)).toEqual([1, 2].map(start => ({
      name: '😀', start, end: start + 1, candidates: [candidate, candidates[1]!, candidates[0]!],
    })));
  });
  test('refuses an invalid empty dictionary name instead of dropping it', () => {
    expect(() => matchMentionNames('', [{ name: '', candidates: [candidate] }])).toThrow('must not be empty');
    expect(matchMentionNames('x', [])).toEqual([]);
  });
});

test('0039 item 29 walks every decoded JSON string with RFC 6901 pointers and code-point order', () => {
  const value = { '/~': [token, null, 2, true, { '': 'Payments' }], '😀': 'last', '\uE000': 'before' };
  expect([...mentionStrings(value, '/values/json')]).toEqual([
    { text: token, path: '/values/json/~1~0/0' },
    { text: 'Payments', path: '/values/json/~1~0/4/' },
    { text: 'before', path: '/values/json/\uE000' },
    { text: 'last', path: '/values/json/😀' },
  ]);
  expect([...mentionStrings('root')]).toEqual([{ text: 'root', path: '' }]);
  expect([...mentionStrings(JSON.parse('"\\\\\\\\[[uid:bad]]"'))]).toEqual([{ text: '\\\\[[uid:bad]]', path: '' }]);
});
