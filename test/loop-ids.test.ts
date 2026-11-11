import { describe, expect, test } from 'bun:test';
import { questionFootnoteId } from './loop-ids-fixture.js';
import { correctionId, taskId } from './loop-ids-fixture.js';

const sides = [
  { claim: 'The README says every order gets ten percent.', grounds: ['doc:README.md#discounts', 'code.file:src/pricing.ts'] },
  { claim: 'The code applies the percentage its caller passes.', grounds: ['code.symbol:src/pricing.ts#discountFor'] },
];

describe('content-hash ids', () => {
  
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
