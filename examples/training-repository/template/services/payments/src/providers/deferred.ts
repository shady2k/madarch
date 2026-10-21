import { randomUUID } from 'node:crypto';
import { BaseProvider, ChargeRequest, ChargeResult, PaymentProvider } from './provider';

interface Accepted {
  charge: ChargeRequest;
  /** What is still owed to the merchant after refunds. */
  remainingCents: number;
}

/**
 * The deferred settlement provider: it accepts the charge at once and keeps it
 * in a batch, so a capture here means "accepted for settlement". The nightly
 * settlement itself is not implemented in this repository: nothing reads the
 * batch except pending(), and the batch lives in memory only.
 */
export class Deferred extends BaseProvider implements PaymentProvider {
  readonly name = 'deferred';
  private readonly batch = new Map<string, Accepted>();

  protected async submit(charge: ChargeRequest): Promise<ChargeResult> {
    const providerReference = `def_${randomUUID()}`;
    this.batch.set(providerReference, { charge, remainingCents: charge.amountCents });
    return { providerReference };
  }

  /** A partial refund keeps the remainder in the batch; refunding all of it removes the entry. */
  protected async submitRefund(providerReference: string, amountCents: number): Promise<void> {
    const accepted = this.batch.get(providerReference);
    if (!accepted) {
      return;
    }
    const remaining = accepted.remainingCents - amountCents;
    if (remaining <= 0) {
      this.batch.delete(providerReference);
    } else {
      this.batch.set(providerReference, { ...accepted, remainingCents: remaining });
    }
  }

  /** How many charges are in the batch. */
  pending(): number {
    return this.batch.size;
  }
}
