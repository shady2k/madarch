import { describe, expect, test } from 'bun:test';
import { detectDocumentLanguage, localizedSourcePath, parseLocalizedSource, renderLocalizedSource, LOCALIZED_SOURCE_SCHEMA } from '../src/writer/localized-source.js';
import type { DocEntity } from '../src/knowledge/doc-entities.js';

const entity: DocEntity = { id: 'doc:docs/glossary.md#payment-token', kind: 'doc.term', title: 'Payment token', identifier: null, repo: null, path: 'docs/glossary.md', anchor: 'payment-token', line: 4, endLine: 6, text: 'The token returned after payment succeeds.', };

describe('localized document sources', () => {
  test('detects only clearly English or Russian text', () => {
    expect(detectDocumentLanguage(entity.text)).toBe('en');
    expect(detectDocumentLanguage('Токен, который возвращается после успешной оплаты.')).toBe('ru');
    expect(detectDocumentLanguage('Short')).toBeUndefined();
    expect(detectDocumentLanguage('Hello мир, this is смешанный text.')).toBeUndefined();
    expect(detectDocumentLanguage('Токен оплаты.\nIn code: PaymentToken, CardToken')).toBe('ru');
    expect(detectDocumentLanguage('Токен оплаты.\n\nIn code: PaymentToken, CardToken')).toBe('ru');
    expect(detectDocumentLanguage('Токен оплаты.\n- In code: PaymentToken, CardToken')).toBe('ru');
    expect(detectDocumentLanguage('Токен оплаты.\n- Also called: PaymentToken')).toBe('ru');
  });

  test('uses a reversible, path-safe entity identity and round-trips fixed provenance', () => {
    const path = localizedSourcePath(entity);
    expect(path).toMatch(/^docs\/sources\/doc\.term\/[a-f0-9]{64}\.md$/);
    expect(localizedSourcePath({ ...entity, id: `doc:docs/glossary.md#${'a'.repeat(180)}` }).split('/').at(-1)!.length).toBeLessThanOrEqual(255);
    const markdown = renderLocalizedSource({ schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind, wikiLanguage: 'ru', sourceLanguage: 'en', sourceDocument: entity.path, sourceLine: entity.line, sourceEndLine: entity.endLine, original: entity.text, statement: 'Токен, возвращаемый после успешной оплаты.' });
    expect(parseLocalizedSource(path, markdown, entity, 'ru')).toEqual({ ok: true, source: { schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind, wikiLanguage: 'ru', sourceLanguage: 'en', sourceDocument: entity.path, sourceLine: entity.line, sourceEndLine: entity.endLine, original: entity.text, statement: 'Токен, возвращаемый после успешной оплаты.' } });
  });

  test('rejects unresolved YAML aliases and a statement in the wrong wiki language', () => {
    const unresolved = parseLocalizedSource('entity.md', '---\nschema: *missing\n---\n', entity, 'ru');
    expect(unresolved.ok).toBe(false);
    if (!unresolved.ok) expect(unresolved.message).toContain('front matter cannot be read');
    const shortRussian = renderLocalizedSource({ schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind, wikiLanguage: 'ru', sourceLanguage: 'en', sourceDocument: entity.path, sourceLine: entity.line, sourceEndLine: entity.endLine, original: entity.text, statement: 'Не входи.' });
    expect(parseLocalizedSource('entity.md', shortRussian, entity, 'ru').ok).toBe(true);
    const shortEnglish = renderLocalizedSource({ schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind, wikiLanguage: 'en', sourceLanguage: 'ru', sourceDocument: entity.path, sourceLine: entity.line, sourceEndLine: entity.endLine, original: entity.text, statement: 'Stop.' });
    expect(parseLocalizedSource('entity.md', shortEnglish, entity, 'en').ok).toBe(true);
    const twoLetterRussian = renderLocalizedSource({ schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind, wikiLanguage: 'ru', sourceLanguage: 'en', sourceDocument: entity.path, sourceLine: entity.line, sourceEndLine: entity.endLine, original: entity.text, statement: 'Да.' });
    expect(parseLocalizedSource('entity.md', twoLetterRussian, entity, 'ru').ok).toBe(true);
    const twoLetterEnglish = renderLocalizedSource({ schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind, wikiLanguage: 'en', sourceLanguage: 'ru', sourceDocument: entity.path, sourceLine: entity.line, sourceEndLine: entity.endLine, original: entity.text, statement: 'Go.' });
    expect(parseLocalizedSource('entity.md', twoLetterEnglish, entity, 'en').ok).toBe(true);
    const wrong = renderLocalizedSource({ schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind, wikiLanguage: 'ru', sourceLanguage: 'en', sourceDocument: entity.path, sourceLine: entity.line, sourceEndLine: entity.endLine, original: entity.text, statement: 'This is still an English sentence.' });
    const rejected = parseLocalizedSource('entity.md', wrong, entity, 'ru');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).toContain('does not appear to be in ru');
    const mostlyWrong = renderLocalizedSource({ schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind, wikiLanguage: 'ru', sourceLanguage: 'en', sourceDocument: entity.path, sourceLine: entity.line, sourceEndLine: entity.endLine, original: entity.text, statement: 'This paragraph is still mostly English. тест' });
    const rejectedTail = parseLocalizedSource('entity.md', mostlyWrong, entity, 'ru');
    expect(rejectedTail.ok).toBe(false);
    if (!rejectedTail.ok) expect(rejectedTail.message).toContain('does not appear to be in ru');
    const mostlyRussian = renderLocalizedSource({ schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind, wikiLanguage: 'en', sourceLanguage: 'ru', sourceDocument: entity.path, sourceLine: entity.line, sourceEndLine: entity.endLine, original: entity.text, statement: 'Этот абзац по-прежнему в основном русском языке. token' });
    const rejectedRussianTail = parseLocalizedSource('entity.md', mostlyRussian, entity, 'en');
    expect(rejectedRussianTail.ok).toBe(false);
    if (!rejectedRussianTail.ok) expect(rejectedRussianTail.message).toContain('does not appear to be in en');
  });

  test('refuses stale identity, locale and source wording with a source line', () => {
    const markdown = renderLocalizedSource({ schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind, wikiLanguage: 'ru', sourceLanguage: 'en', sourceDocument: entity.path, sourceLine: entity.line, sourceEndLine: entity.endLine, original: entity.text, statement: 'Токен, возвращаемый после успешной оплаты.' });
    const wrongLocale = parseLocalizedSource('entity.md', markdown, entity, 'en');
    expect(wrongLocale.ok).toBe(false);
    if (!wrongLocale.ok) expect(wrongLocale.line).toBeGreaterThan(0);
    const changed = { ...entity, text: 'A different source sentence.' };
    const stale = parseLocalizedSource('entity.md', markdown, changed, 'ru');
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.message).toContain('In the source');
  });
});
