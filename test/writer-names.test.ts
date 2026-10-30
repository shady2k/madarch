/** Statement names (madarch-m38l.8): readable, unique within the page, and kept while the sentence stands. */
import { describe, expect, test } from 'bun:test';
import { idSlugOf, nameStatements, sentenceKey, slugOf } from '../src/writer/names.js';

describe('slugOf', () => {
  test('a readable slug of the first content words', () => {
    expect(slugOf('A refund is allowed within 14 days.')).toBe('refund-is-allowed-within');
    expect(slugOf('Payments are charged through one of two providers chosen by configuration.')).toBe('payments-are-charged-through');
  });
  test('accents fold, camel case splits, Cyrillic is transliterated, other scripts fall back to the ground', () => {
    expect(slugOf('Crème brûlée is served.')).toBe('creme-brulee-is-served');
    expect(slugOf('Платёж проходит через сервис.', 'PaymentClientFactory')).toBe('platezh-prokhodit-cherez-servis');
    expect(slugOf('日本語の文。', 'PaymentClientFactory')).toBe('payment-client-factory');
  });
  test('nothing usable gives "statement", and a name is never only digits', () => {
    expect(slugOf('日本語。', '')).toBe('statement');
    expect(slugOf('12 34.', '')).toBe('statement');
  });
  test('a long slug stops at a word boundary under the bound', () => {
    expect(slugOf('Internationalization configuration infrastructure documentation everywhere.').length).toBeLessThanOrEqual(40);
  });

  test('a word is what the language segmenter calls a word, with no stop list', () => {
    expect(slugOf("Don't stop the build.")).toBe('dont-stop-the-build');
    expect(slugOf('A refund is allowed within 14 days.')).toBe('refund-is-allowed-within');
  });
});

describe('idSlugOf', () => {
  test('question, correction, task and footnote ids keep the spelling main gave them', () => {
    expect(idSlugOf('ten-percent-discount The discount is applied.')).toBe('ten-percent-discount-discount');
    expect(idSlugOf('Update the documents: Is tax added to the price?')).toBe('update-documents-tax-added');
    expect(idSlugOf('Update the documents: Is the refund allowed after ninety days?')).toBe('update-documents-refund-allowed');
    expect(idSlugOf('Fix DocumentContradiction in docs')).toBe('fix-document-contradiction-docs');
    expect(idSlugOf('Question about alpha')).toBe('question-about-alpha');
  });

  test('the old stop words still keep an id short, in both languages', () => {
    expect(idSlugOf('Платёж от сервиса')).toBe('platezh-servisa');
    expect(idSlugOf('a an the is are')).toBe('statement');
  });
});

describe('nameStatements', () => {
  const item = (sentence: string, ...labels: string[]) => ({ sentence, labels, hint: '' });

  test('numbered labels get slugs; a name the agent chose stays', () => {
    expect(nameStatements([item('Orders are paid in full.', '1'), item('Refunds go back to the card.', 'refund-path')], new Map())).toEqual(['orders-are-paid-in', 'refund-path']);
  });
  test('the name a sentence had in the page it replaces is kept while the sentence stands', () => {
    const previous = new Map([['Orders are paid in full.', 'full-payment']]);
    expect(nameStatements([item('Orders are paid in full.', '1'), item('Orders are paid in full or in part.', '2')], previous)).toEqual(['full-payment', 'orders-are-paid-in']);
  });
  test('a kept name wins over the name the agent chose for the same sentence', () => {
    expect(nameStatements([item('Orders are paid.', 'fresh')], new Map([['Orders are paid.', 'old-name']]))).toEqual(['old-name']);
  });
  test('names are unique within a page', () => {
    expect(nameStatements([item('Orders ship fast.', '1'), item('Orders ship fast!', '2'), item('Orders ship slow.', 'orders-ship-fast')], new Map())).toEqual(['orders-ship-fast-2', 'orders-ship-fast-3', 'orders-ship-fast']);
  });
  test('the same input gives the same names', () => {
    const items = [item('One fact stands here.', '1'), item('Another fact stands here.', '2')];
    expect(nameStatements(items, new Map())).toEqual(nameStatements(items, new Map()));
  });

  test('unchanged text keeps its stored name and only a new sentence gets the new name', () => {
    const previous = new Map([['A refund is allowed within 14 days.', 'refund-allowed-within-days']]);
    expect(nameStatements([
      item('A refund is allowed within 14 days.', '1'),
      item('A refund is allowed within 30 days.', '2'),
    ], previous)).toEqual(['refund-allowed-within-days', 'refund-is-allowed-within']);
  });

  test('the sentence key still collapses blanks over unchanged text', () => {
    expect(sentenceKey('A  refund\n is allowed.')).toBe('A refund is allowed.');
  });
});
