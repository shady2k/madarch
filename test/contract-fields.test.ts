import { describe, expect, test } from 'bun:test';
import { parseDocumentFields } from '../src/product/contract.js';

/**
 * The generic document fields' own shape, one check at a time: what reads
 * from a header block, and what is refused words and line included. The
 * cases carry the refusal's whole words where a mutant could move them.
 */

const HEADER = '# S-001 — Talk\n';

const fields = (body: string) => parseDocumentFields('docs/S-001.md', `${HEADER}${body}\n## Record\nthe cafe speaks.\n`);

describe('the generic document fields', () => {
  test('a field stands one per line above the first section, its name any case', () => {
    expect(fields('Id: S-001\nStatus: open\nKind: conversation\n')).toEqual({ ok: true, fields: { id: 'S-001', status: 'open', kind: 'conversation' } });
    expect(fields('id: S-001\nstatus: open\nkind: conversation\n')).toEqual({ ok: true, fields: { id: 'S-001', status: 'open', kind: 'conversation' } });
  });

  test('a field below the first section, an empty line and a heading line are not fields', () => {
    expect(parseDocumentFields('docs/S-001.md', `${HEADER}\n## Record\nStatus: open\n`)).toEqual({ ok: true, fields: {} });
    expect(parseDocumentFields('docs/S-001.md', `${HEADER}\n# A note\nStatus: open\n## Record\n`)).toEqual({ ok: true, fields: {} });
  });

  test('unknown names are ignored; a repeated generic name is refused once', () => {
    expect(fields('Owner: the cafe owner\nStatus: open\n')).toEqual({ ok: true, fields: { status: 'open' } });
    const read = fields('Status: open\nStatus: open\n');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors[0]).toMatchObject({ line: 3, path: 'status', file: 'docs/S-001.md' });
    if (!read.ok) expect(read.errors[0]!.message).toBe('"Status" is written twice: a field is given once');
  });

  test('links accumulate across lines, commas apart, and refuse a list naming nothing', () => {
    expect(fields('Links: S-001\nLinks: H-001,  \n')).toEqual({ ok: true, fields: { links: ['S-001', 'H-001'] } });
    const refused = fields('Links: , ,\n');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors[0]).toMatchObject({ line: 2, path: 'links', file: 'docs/S-001.md' });
    if (!refused.ok) expect(refused.errors[0]!.message).toBe('", ," names no link target: links is a list of ids, comma-separated');
  });

  test('a status and a kind are words; a date and a quoted value are not', () => {
    const bad = fields('Status: 2026-10-09\n');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toMatchObject({ line: 2, path: 'status' });
    if (!bad.ok) expect(bad.errors[0]!.message).toBe('"Status: 2026-10-09" is not a word: write a name the reader recognises');
    const badKind = fields('Kind: "two words"\n');
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.errors[0]).toMatchObject({ path: 'kind' });
  });

  test('a value with a pattern name: value inside it is not split: the value is read whole', () => {
    expect(fields('Status: open CRLF\n')).toEqual({ ok: true, fields: { status: 'open CRLF' } });
  });

  test('a field needs a colon right after its name, and a space after the colon is optional', () => {
    expect(fields('Status:  open\n')).toEqual({ ok: true, fields: { status: 'open' } });
    const glued = fields('Status:open\n');
    expect(glued).toEqual({ ok: true, fields: { status: 'open' } });
    const spaced = fields('Status : open\n');
    expect(spaced).toEqual({ ok: true, fields: {} });
  });

  test('an empty value is not a field; an indented field reads', () => {
    expect(fields('Status:\n')).toEqual({ ok: true, fields: {} });
    // An indented line is not a field line: fields stand at the margin.
    expect(fields('  Status: open\n')).toEqual({ ok: true, fields: {} });
  });

  test('a hash inside a value and a level-4 heading do not close or break the header block', () => {
    expect(fields('Id: S-#1\n')).toEqual({ ok: true, fields: { id: 'S-#1' } });
    expect(fields('#### Note\nStatus: open\n')).toEqual({ ok: true, fields: {} });
    expect(fields('##Record\nStatus: open\n')).toEqual({ ok: true, fields: {} });
  });

  test("the id carries the id's own shape: no word check on it", () => {
    expect(fields('Id: 2026-10-09\n')).toEqual({ ok: true, fields: { id: '2026-10-09' } });
  });

  test('a value that opens with a mark is refused where its tail is a word', () => {
    const refused = fields('Status: !open\n');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors[0]).toMatchObject({ line: 2, path: 'status' });
  });

  test('a status with a trailing mark is refused', () => {
    const refused = fields('Status: open!\n');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors[0]).toMatchObject({ line: 2, path: 'status' });
  });

  test('CRLF line endings land the same fields', () => {
    expect(parseDocumentFields('docs/S-001.md', `# S-001 — Talk\r\nStatus: open\r\n## Record\r\n`)).toEqual({ ok: true, fields: { status: 'open' } });
  });
});
