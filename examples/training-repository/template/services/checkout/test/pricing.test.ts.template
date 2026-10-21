import { discountFor, previewTotal } from '../src/pricing';

describe('discountFor', () => {
  it('takes the percentage off, cut off at the cent', () => {
    expect(discountFor(1000, 10)).toBe(100);
    expect(discountFor(999, 10)).toBe(99);
  });
});

describe('previewTotal', () => {
  it('prices every line: discount first, then 8% tax, none on zero-rated lines', () => {
    const preview = previewTotal(
      [
        { sku: 'A-1', quantity: 2, priceCents: 1000 },
        { sku: 'BOOK', quantity: 1, priceCents: 2000, zeroRated: true },
      ],
      10,
    );
    expect(preview).toEqual({ subtotalCents: 4000, discountCents: 400, taxCents: 144, totalCents: 3744 });
  });
});
