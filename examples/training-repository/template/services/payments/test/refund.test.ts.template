import { Payment, PaymentStatus } from '../src/domain/payment';
import { checkRefund, RefundRejected } from '../src/domain/refund';

const capturedAt = new Date('2026-07-01T10:00:00Z');

function captured(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_1',
    orderId: 'ord_1',
    amountCents: 5000,
    currency: 'EUR',
    status: PaymentStatus.Captured,
    idempotencyKey: 'key-1',
    createdAt: capturedAt,
    capturedAt,
    ...overrides,
  };
}

function daysAfter(days: number): Date {
  return new Date(capturedAt.getTime() + days * 86_400_000);
}

describe('checkRefund', () => {
  it('accepts a partial refund inside the window', () => {
    expect(() => checkRefund(captured(), 2000, 0, daysAfter(3))).not.toThrow();
  });

  it('accepts the rest of the amount after an earlier partial refund', () => {
    expect(() => checkRefund(captured(), 3000, 2000, daysAfter(3))).not.toThrow();
  });

  it('rejects a payment that was not captured', () => {
    const declined = captured({ status: PaymentStatus.Declined });
    expect(() => checkRefund(declined, 100, 0, daysAfter(1))).toThrow(RefundRejected);
  });

  it.each([0, -100, 12.5])('rejects the amount %p', (amount) => {
    expect(() => checkRefund(captured(), amount, 0, daysAfter(1))).toThrow(expect.objectContaining({ code: 'invalid-amount' }));
  });

  it('rejects refunds that exceed what was captured in total', () => {
    expect(() => checkRefund(captured(), 3001, 2000, daysAfter(1))).toThrow(expect.objectContaining({ code: 'exceeds-captured' }));
  });

  it('rejects a refund after the 30-day window, counted from the capture', () => {
    expect(() => checkRefund(captured(), 100, 0, daysAfter(31))).toThrow(expect.objectContaining({ code: 'window-closed' }));
    expect(() => checkRefund(captured(), 100, 0, daysAfter(30))).not.toThrow();
  });

  it.skip('refunds through the vault sandbox', () => {
    // Needs the provider sandbox credentials, which the vault does not hand out to CI yet.
  });
});
