import { randomUUID } from 'node:crypto';
import { BaseProvider, ChargeRequest, ChargeResult, PaymentProvider } from './provider';

/**
 * The deferred settlement provider: it accepts the charge at once and settles
 * the batch at the end of the day, so a capture here means "accepted for
 * settlement". Used by merchants that invoice monthly.
 */
export class Deferred extends BaseProvider implements PaymentProvider {
  readonly name = 'deferred';
  private readonly batch = new Map<string, ChargeRequest>();

  protected async submit(charge: ChargeRequest): Promise<ChargeResult> {
    const providerReference = `def_${randomUUID()}`;
    this.batch.set(providerReference, charge);
    return { providerReference };
  }

  protected async submitRefund(providerReference: string): Promise<void> {
    this.batch.delete(providerReference);
  }

  /** How many charges wait for tonight's settlement. */
  pending(): number {
    return this.batch.size;
  }
}
