// @@ since payment-events
import { EventSink, publishPaymentEvent } from '../events/publishers';

// @@ end
/** A reference to a card kept in the card vault. The payments service never sees the card number. */
export type CardToken = { vaultReference: string };

/** What a provider hands back when it captured the money: the proof of the capture. */
export type PaymentToken = { value: string };

export const PaymentStatus = {
  Pending: 'pending',
  Captured: 'captured',
  Declined: 'declined',
  Refunded: 'refunded',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export interface Payment {
  id: string;
  /**
   * The order this payment is for. A logical reference: orders lives in another
   * service and another database, so there is no foreign key to follow.
   */
  orderId: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  /** The client's key for this payment; the same key always yields the same payment. */
  idempotencyKey: string;
  /** The provider's reference once the money was captured. */
  providerReference?: string;
  /** Why the payment was declined, when it was. */
  declineReason?: string;
  createdAt: Date;
  capturedAt?: Date;
}

// @@ until payment-events
/** Marks the payment captured with the provider's proof. */
export function capture(payment: Payment, token: PaymentToken, now: Date): Payment {
  return { ...payment, status: PaymentStatus.Captured, providerReference: token.value, capturedAt: now };
}

/** Marks the payment declined; reason says why (card refused, timeout...). */
export function decline(payment: Payment, reason: string): Payment {
  return { ...payment, status: PaymentStatus.Declined, declineReason: reason };
}
// @@ end
// @@ since payment-events
/** Marks the payment captured with the provider's proof and announces it. */
export async function capture(payment: Payment, token: PaymentToken, now: Date, sink: EventSink): Promise<Payment> {
  // Keep the order identifier stable across retries so the payment callback is idempotent.
  const captured: Payment = {
    ...payment,
    status: PaymentStatus.Captured,
    providerReference: token.value,
    capturedAt: now,
  };
  await publishPaymentEvent(sink, 'payment.captured', captured);
  return captured;
}

/** Marks the payment declined and announces it; reason says why (card refused, timeout...). */
export async function decline(payment: Payment, reason: string, sink: EventSink): Promise<Payment> {
  const declined: Payment = { ...payment, status: PaymentStatus.Declined, declineReason: reason };
  await publishPaymentEvent(sink, 'payment.failed', declined);
  return declined;
}
// @@ end
