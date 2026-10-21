import { Payment, PaymentStatus } from './payment';

/** A refund is only accepted this many days after the capture (BR-4 in docs/requirements.md). */
export const REFUND_WINDOW_DAYS = 30;

export interface Refund {
  id: string;
  paymentId: string;
  amountCents: number;
  reason?: string;
  createdAt: Date;
}

/** Thrown when the refund rule says no; code is stable, message is for people. */
export class RefundRejected extends Error {
  constructor(
    readonly code: 'not-captured' | 'invalid-amount' | 'exceeds-captured' | 'window-closed',
    message: string,
  ) {
    super(message);
    this.name = 'RefundRejected';
  }
}

/**
 * The refund rule (BR-4): only a captured payment can be refunded, for a
 * positive amount, within the window after the capture, and never for more
 * than was captured in total.
 */
// @@ until refund-cap
export function checkRefund(payment: Payment, amountCents: number, now: Date): void {
// @@ end
// @@ since refund-cap
export function checkRefund(payment: Payment, amountCents: number, alreadyRefundedCents: number, now: Date): void {
// @@ end
  if (payment.status !== PaymentStatus.Captured) {
    throw new RefundRejected('not-captured', `payment ${payment.id} is ${payment.status}, only captured payments can be refunded`);
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new RefundRejected('invalid-amount', 'the refund amount must be a positive number of cents');
  }
// @@ since refund-cap
  if (alreadyRefundedCents + amountCents > payment.amountCents) {
    throw new RefundRejected(
      'exceeds-captured',
      `refunding ${amountCents} on top of ${alreadyRefundedCents} exceeds the ${payment.amountCents} captured`,
    );
  }
// @@ end
// @@ until refund-window
  const startedAt = payment.createdAt;
// @@ end
// @@ since refund-window
  const startedAt = payment.capturedAt ?? payment.createdAt;
// @@ end
  const ageDays = (now.getTime() - startedAt.getTime()) / 86_400_000;
  if (ageDays > REFUND_WINDOW_DAYS) {
    throw new RefundRejected('window-closed', `payment ${payment.id} is ${Math.floor(ageDays)} days old`);
  }
}
