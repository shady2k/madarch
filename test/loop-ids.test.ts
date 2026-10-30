import { describe, expect, test } from 'bun:test';
import { correctionId, questionFootnoteId, questionId, taskId } from '../src/loop/ids.js';

const sides = [
  { claim: 'The README says every order gets ten percent.', grounds: ['doc:README.md#discounts', 'code.file:src/pricing.ts'] },
  { claim: 'The code applies the percentage its caller passes.', grounds: ['code.symbol:src/pricing.ts#discountFor'] },
];

describe('content-hash ids', () => {
  test('a question id is the first 12 hex characters of its normalized content and grounds', () => {
    const first = questionId({ type: 'contradiction', title: 'Which discount?', question: '  Which\n discount does an order get?  ', why: 'A shopper sees two numbers.', sides });
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(questionId({ type: 'contradiction', title: 'Which discount?', question: 'Which discount does an order get?', why: 'A shopper sees two numbers.', sides: [...sides].reverse() })).not.toBe(first);
    expect(questionId({ type: 'contradiction', title: 'Which discount?', question: 'Which discount does an order get?', why: 'A shopper sees two numbers.', sides: [{ ...sides[0]!, grounds: [...sides[0]!.grounds].reverse() }, sides[1]!] })).toBe(first);
    expect(questionId({ type: 'gap', title: 'Which discount?', question: 'Which discount does an order get?', why: 'A shopper sees two numbers.', sides })).not.toBe(first);
    expect(questionId({ type: 'contradiction', title: 'Which discount?', question: 'Which discount does an order get?', why: 'A shopper sees two numbers.', sides: [sides[0]!, { ...sides[1]!, claim: 'The code applies whatever it is given.' }] })).not.toBe(first);
  });

  test('a correction id names its statement, its reason and the statement key', () => {
    const first = correctionId('Orders get a ten percent discount.', 'The caller chooses it.', 'domain:orders#ten-percent-discount');
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(correctionId('Orders get a ten percent discount.', 'The caller chooses it.', 'domain:orders#ten-percent-discount')).toBe(first);
    expect(correctionId('Orders get ten percent.', 'The caller chooses it.', 'domain:orders#ten-percent-discount')).not.toBe(first);
    expect(correctionId('Orders get a ten percent discount.', 'The caller passes it.', 'domain:orders#ten-percent-discount')).not.toBe(first);
    expect(correctionId('Orders get a ten percent discount.', 'The caller chooses it.', 'domain:orders#tax-at-checkout')).not.toBe(first);
  });

  test('a task id names its title and its scope keys, in code-point order', () => {
    const first = taskId('Update the discount', ['README.md#discounts', 'src/pricing.ts']);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(taskId('Update the discount', ['src/pricing.ts', 'README.md#discounts'])).toBe(first);
    expect(taskId('Update the tax', ['README.md#discounts', 'src/pricing.ts'])).not.toBe(first);
    expect(taskId('Update the discount', ['README.md#tax'])).not.toBe(first);
  });

  test('a question footnote id names its own claim and grounds', () => {
    const first = questionFootnoteId(sides[0]!.claim, sides[0]!.grounds);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(questionFootnoteId(sides[0]!.claim, [...sides[0]!.grounds].reverse())).toBe(first);
    expect(questionFootnoteId('A different claim.', sides[0]!.grounds)).not.toBe(first);
  });
});
