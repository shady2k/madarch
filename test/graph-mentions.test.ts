import { describe, expect, test } from 'bun:test';
import { MentionSyntaxError, scanMentionHints, scanMentions } from '../src/graph/mentions';
import { fieldScansMentions } from '../src/graph/write';

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

  test('near-prefix strings before a real token remain plain text', () => {
    for (const plain of ['x[uid', '[xuid', '[[xid', '[[uxd', '[[uix', 'xxuid', 'x[xid', '[xxid']) {
      const prefix = `${plain}]] `;
      expect(scanMentions(prefix + token, '/body')).toEqual([occurrence('/body', prefix.length)]);
    }
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

describe('decision 0039 items 5, 29 and 31: which payloads a write scans for mentions', () => {
  const kind = (overrides: Record<string, unknown>) => ({
    name: 'fixture', table: 'k_fixture', key: [], capability: 'fixture',
    fields: [{ name: 'title', type: 'text' as const }, { name: 'content', type: 'text' as const }, { name: 'summary', type: 'text' as const, mentions: false as const }],
    ...overrides,
  });

  test('authored fields are scanned and engine fields are not', () => {
    const declared = kind({});
    expect(fieldScansMentions(declared, 'title')).toBe(true);
    expect(fieldScansMentions(declared, 'summary')).toBe(false);
    // A property the kind does not declare is read as prose: the write refuses it by name, never by silence.
    expect(fieldScansMentions(declared, 'undeclared')).toBe(true);
    expect(fieldScansMentions(undefined, 'title')).toBe(true);
  });

  test('an immutable evidence kind scans nothing in its content field', () => {
    const declared = kind({ evidence: { immutable: true as const, digestField: 'digest', contentField: 'content', digestAlgorithm: 'sha256' as const } });
    expect(fieldScansMentions(declared, 'content')).toBe(false);
    // The exemption is the content field alone: the kind's other payloads are still authored prose.
    expect(fieldScansMentions(declared, 'title')).toBe(true);
  });

  test('an edge kind keeps its authored fields and takes no evidence exemption', () => {
    const edge = { name: 'fixture-edge', from: ['fixture'], to: ['fixture'], fields: [{ name: 'words', type: 'text' as const }], repeats: false, capability: 'fixture', cardinality: { from: 'many' as const, to: 'many' as const }, labels: { en: { out: 'a', in: 'a' }, ru: { out: 'а', in: 'а' } } };
    expect(fieldScansMentions(edge, 'words')).toBe(true);
    expect(fieldScansMentions({ ...edge, fields: [{ name: 'words', type: 'text' as const, mentions: false as const }] }, 'words')).toBe(false);
  });
});
