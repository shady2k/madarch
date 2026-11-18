import { describe, expect, test } from 'bun:test';
import { MentionSyntaxError, scanMentionHints, scanMentions } from '../src/graph/mentions';

const uid = '12345678-1234-5678-9abc-123456789abc';
const token = `[[uid:${uid}]]`;
const occurrence = (path: string, start = 0) => ({ uid, path, start, end: start + token.length });

describe('decision 0039 items 5 and 29 mention grammar', () => {
  test('repeated occurrences use decoded Unicode code-point offsets', () => {
    expect(scanMentions(`😀 ${token} ${token}`, '/body')).toEqual([
      occurrence('/body', 2), occurrence('/body', 3 + token.length),
    ]);
    expect(scanMentions(JSON.parse(`"\\uD83D\\uDE00 ${token}"`), '/body')).toEqual([occurrence('/body', 2)]);
  });

  test('plain prefixes and incomplete prefixes preserve token spans', () => {
    const prefix = '😀 ordinary [ [[u [[ui '.repeat(100);
    expect(scanMentions(prefix + token, '/body')).toEqual([occurrence('/body', Array.from(prefix).length)]);
    expect(scanMentions('plain \\[[hidden]]', '/body')).toEqual([]);
  });

  test('nested JSON strings have RFC6901 pointers, not object keys as text', () => {
    expect(scanMentions({ 'a~/': [null, 3, false, { '': token }], [token]: 'plain' }, '/payload')).toEqual([
      occurrence('/payload/a~0~1/3/'),
    ]);
    expect(scanMentions(token, '')).toEqual([occurrence('')]);
  });

  test('escapes consume left to right and escape the whole token', () => {
    for (let count = 0; count <= 5; count++) {
      const escaped = '\\'.repeat(count) + token;
      expect(scanMentions(escaped, '/body')).toEqual(count % 2 ? [] : [occurrence('/body', count)]);
    }
    expect(scanMentions(`\\[[uid:bad ${token}]] ${token}`, '/body')).toEqual([occurrence('/body', token.length + 14)]);
    expect(scanMentions(`\\a${token}`, '/body')).toEqual([occurrence('/body', 2)]);
    expect(scanMentions(`\\[x${token}`, '/body')).toEqual([occurrence('/body', 3)]);
    expect(scanMentions(`\\[[ignore ] ${token}]] ${token}`, '/body')).toEqual([occurrence('/body', token.length + 15)]);
  });

  test('malformed reserved tokens refuse rather than becoming plain text', () => {
    const invalid = [
      '[[uid]]', '[[uid:]]', '[[uid:bad]]', '[[uid', '[[uidx:bad]]', `[[uid;${uid}]]`,
      `[[uid:${uid.toUpperCase()}]]`, `[[uid:${uid}]]]`.slice(0, -2),
      `[[uid:${uid.split('-').join('')}]]`, `[[uid: ${uid}]]`,
      '[[uid:12345678-1234-5678-9abc-123456789abg]]',
      '[[uid:12345678_1234-5678-9abc-123456789abc]]',
    ];
    for (const value of invalid) {
      try {
        scanMentions({ body: `😀${value}` }, '/data');
        throw new Error(`Expected refusal of ${value}`);
      } catch (error) {
        expect(error).toBeInstanceOf(MentionSyntaxError);
        const refusal = error as MentionSyntaxError;
        expect(refusal.code).toBe('SCHEMA_INVALID');
        expect(refusal.path).toBe('/data/body');
        expect(refusal.start).toBe(1);
        expect(refusal.end).toBe(1 + Array.from(value).length);
        expect(refusal.actual).toBe(value);
        expect(refusal.retryable).toBe(false);
      }
      expect(scanMentions(`\\${value}`, '/body')).toEqual([]);
    }
    expect(scanMentions('[[ordinary]] [uid:bad] [[UID:bad]]', '/body')).toEqual([]);
  });

  test('traversal sorts object properties by code point', () => {
    expect(scanMentions({ '😀': token, '\ue000': token }, '/json').map(item => item.path)).toEqual(['/json/\ue000', '/json/😀']);
  });

  test('plain names return only dictionary hints, preserving all candidates', () => {
    const candidates = [
      { uid, kind: 'domain', label: 'Payments', domain: 'Commerce' },
      { uid: '22345678-1234-5678-9abc-123456789abc', kind: 'component', label: 'Payments', domain: 'Operations' },
    ];
    const dictionary = new Map([['Payments', candidates], ['Pay', candidates], ['', candidates]]);
    const value = `😀 Payments PaymentsExtra ${token} \\[[Payments]]`;
    expect(scanMentions(value, '/body')).toEqual([occurrence('/body', 25)]);
    expect(scanMentionHints(value, '/body', dictionary)).toEqual([{path: '/body', start: 2, end: 10, candidates}]);
    expect(scanMentionHints(token, '/body', new Map([['uid', candidates]]))).toEqual([]);
    expect(scanMentionHints(`\\[[Payments ] Payments]] Payments`, '/body', dictionary)).toEqual([{path: '/body', start: 25, end: 33, candidates}]);
    expect(scanMentionHints(value, '/body', new Map())).toEqual([]);
    expect(scanMentionHints({ list: ['Payments'] }, '/payload', dictionary)).toEqual([{path: '/payload/list/0', start: 0, end: 8, candidates}]);
  });
});
