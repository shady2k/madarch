import { describe, expect, test } from 'bun:test';
import { blockIdentity, escapeMarkdown, foldLanguageParams, templatePartsOf, type TemplatePart } from '../src/knowledge/template.js';

describe('structured template opinions', () => {
  test('text stays literal, attributes and blocks are explicit nodes', () => {
    const parts: TemplatePart[] = [
      { type: 'text', text: '{% body %} {{ label }} :::body', line: 1 },
      { type: 'attribute', name: 'label', line: 2 },
      { type: 'block', name: 'related', params: { title: 'Files' }, line: 3 },
      { type: 'problem', message: 'producer refused a section', line: 4 },
    ];
    expect(templatePartsOf(parts)).toEqual(parts);
    expect(templatePartsOf('{% body %}')).toBeUndefined();
  });

  test('malformed structured opinions are refused instead of silently skipping nodes', () => {
    for (const node of [
      { type: 'text', text: 'x', line: 0 },
      { type: 'block', name: 'unknown', params: {}, line: 1 },
      { type: 'block', name: 'body', params: { count: 3 }, line: 1 },
      { type: 'attribute', name: 2, line: 1 },
      { type: 'other', line: 1 },
    ]) expect(templatePartsOf([node])).toBeUndefined();
  });

  test('language parameters and deferred identities use structured values', () => {
    expect(foldLanguageParams({ title: 'Files', 'title-ru': 'Файлы' }, 'ru')).toEqual({ title: 'Файлы' });
    expect(blockIdentity('related', { title: 'Files', kind: 'file' })).toBe(blockIdentity('related', { kind: 'file', title: 'Files' }));
    expect(blockIdentity('related', { title: 'Other' })).not.toBe(blockIdentity('related', { title: 'Files' }));
    expect(escapeMarkdown('a_b [x]')).toBe('a\\_b \\[x\\]');
  });
});
