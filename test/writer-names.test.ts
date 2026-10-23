/** Statement names (madarch-m38l.8): readable, unique within the page, and kept while the sentence stands. */
import { describe, expect, test } from 'bun:test';
import { nameStatements, slugOf } from '../src/writer/names.js';

describe('slugOf', () => {
  test('a readable slug of the first content words', () => {
    expect(slugOf('A refund is allowed within 14 days.')).toBe('refund-allowed-within-days');
    expect(slugOf('Payments are charged through one of two providers chosen by configuration.')).toBe('payments-charged-through-two');
  });
  test('accents fold, camel case splits, non-Latin text falls back to the ground', () => {
    expect(slugOf('Crème brûlée is served.')).toBe('creme-brulee-served');
    expect(slugOf('Платёж проходит через сервис.', 'PaymentClientFactory')).toBe('payment-client-factory');
  });
  test('nothing usable gives "statement", and a name is never only digits', () => {
    expect(slugOf('Платёж.', '')).toBe('statement');
    expect(slugOf('12 34.', '')).toBe('statement');
  });
  test('a long slug stops at a word boundary under the bound', () => {
    expect(slugOf('Internationalization configuration infrastructure documentation everywhere.').length).toBeLessThanOrEqual(40);
  });
});

describe('nameStatements', () => {
  const item = (sentence: string, ...labels: string[]) => ({ sentence, labels, hint: '' });

  test('numbered labels get slugs; a name the agent chose stays', () => {
    expect(nameStatements([item('Orders are paid in full.', '1'), item('Refunds go back to the card.', 'refund-path')], new Map())).toEqual(['orders-paid-full', 'refund-path']);
  });
  test('the name a sentence had in the page it replaces is kept while the sentence stands', () => {
    const previous = new Map([['Orders are paid in full.', 'full-payment']]);
    expect(nameStatements([item('Orders are paid in full.', '1'), item('Orders are paid in full or in part.', '2')], previous)).toEqual(['full-payment', 'orders-paid-full-part']);
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
});
