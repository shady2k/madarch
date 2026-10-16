import { describe, expect, test } from 'bun:test';
import { insertDiscussionMarkers, mapParagraphSelection } from './discussion-selection.js';
const marker = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('discussion selection source mapping', () => {
  test('maps ordinary text and gives Unicode-code-point context', () => {
    const markdown = 'Before 😀 alpha beta after';
    const result = mapParagraphSelection(markdown, 'Before 😀 '.length, 'Before 😀 alpha'.length);
    expect(result).toEqual({ ok: true, range: { start: 10, end: 15, quote: 'alpha', before: 'Before 😀 ', after: ' beta after' } });
  });

  test('expands a selection at a word edge to the whole word', () => {
    const markdown = 'A *marked* sentence';
    const result = mapParagraphSelection(markdown, 3, 6);
    expect(result).toEqual({ ok: true, range: { start: 2, end: 10, quote: 'marked', before: 'A ', after: ' sentence' } });
  });

  test('maps a backslash before ordinary text as literal Markdown', () => {
    const result = mapParagraphSelection('\\alpha', 0, 1);
    expect(result).toEqual({ ok: true, range: { start: 0, end: 6, quote: '\\alpha', before: '', after: '' } });
  });

  test('rejects an entity boundary that has no unique source offset', () => {
    const result = mapParagraphSelection('A &NotEqualTilde; B', 3, 4);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('uniquely');
  });

  test('expands text inside a link to the whole inline element', () => {
    const result = mapParagraphSelection('Read [the guide](docs/guide.md) now', 6, 9);
    expect(result).toEqual({ ok: true, range: { start: 5, end: 31, quote: 'the guide', before: 'Read ', after: ' now' } });
  });

  test('maps code text inside inline-code delimiters', () => {
    const result = mapParagraphSelection('Use `npm test` now', 4, 12);
    expect(result).toEqual({ ok: true, range: { start: 4, end: 14, quote: 'npm test', before: 'Use ', after: ' now' } });
  });

  test('rejects malformed numeric entities without throwing', () => {
    expect(() => mapParagraphSelection('x &#x110000; y', 2, 3)).not.toThrow();
    expect(mapParagraphSelection('x &#x110000; y', 2, 3).ok).toBe(true);
  });

  test('maps text after a soft line break to its source offsets', () => {
    const result = mapParagraphSelection('first\nsecond', 6, 12);
    expect(result).toEqual({ ok: true, range: { start: 6, end: 12, quote: 'second', before: 'first\n', after: '' } });
  });

  test('maps text after hard breaks in both Markdown forms', () => {
    for (const [markdown, sourceStart] of [['first  \nsecond', 8], ['first\\\nsecond', 7]] as const) {
      const result = mapParagraphSelection(markdown, 6, 12);
      expect(result).toEqual({ ok: true, range: { start: sourceStart, end: sourceStart + 6, quote: 'second', before: 'first\n', after: '' } });
    }
  });

  test('maps nested blockquote and list paragraphs in rendered document order', () => {
    const markdown = '> quoted text\n\n- list words\n\nlast paragraph';
    expect(mapParagraphSelection(markdown, 0, 6, 0)).toMatchObject({ ok: true, range: { quote: 'quoted' } });
    expect(mapParagraphSelection(markdown, 0, 4, 1)).toMatchObject({ ok: true, range: { quote: 'list' } });
    expect(mapParagraphSelection(markdown, 0, 4, 2)).toMatchObject({ ok: true, range: { quote: 'last' } });
  });

  test('rejects boundaries inside combining and joined emoji graphemes', () => {
    expect(mapParagraphSelection('e\u0301 text', 1, 2).ok).toBe(false);
    expect(mapParagraphSelection('👍🏽 text', 2, 4).ok).toBe(false);
    expect(mapParagraphSelection('👩‍💻 text', 2, 5).ok).toBe(false);
  });

  test('rejects offsets inside a surrogate pair', () => {
    const result = mapParagraphSelection('A 😀 B', 3, 4);
    expect(result.ok).toBe(false);
  });

  test('supports nested distinct-id markers for overlapping ranges', () => {
    const inner = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const outer = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
    const once = insertDiscussionMarkers('alpha beta gamma', { start: 6, end: 10 }, inner);
    expect(insertDiscussionMarkers(once, { start: 0, end: once.length }, outer))
      .toBe(`<!--c:${outer}-->alpha <!--c:${inner}-->beta<!--/c:${inner}--> gamma<!--/c:${outer}-->`);
  });

  test('inserts only a valid ULID pair and preserves other source bytes', () => {
    const source = 'left selected right';
    expect(insertDiscussionMarkers(source, { start: 5, end: 13 }, marker))
      .toBe(`left <!--c:${marker}-->selected<!--/c:${marker}--> right`);
    expect(() => insertDiscussionMarkers(source, { start: 5, end: 13 }, 'bad')).toThrow('ULID');
  });

  test('range edits inside a marker retain the range, while edits through one marker are refused', () => {
    const opening = `<!--c:${marker}-->`; const closing = `<!--/c:${marker}-->`;
    const inside = `${opening}selected edited${closing}`;
    expect(inside).toContain(opening); expect(inside).toContain(closing);
    const through = `${opening}selected`;
    expect(mapParagraphSelection(through, 0, 8).ok).toBe(false);
  });

});
