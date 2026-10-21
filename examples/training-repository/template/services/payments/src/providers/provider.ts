import { logger } from '../logging/logger';

/** What the service asks a provider to charge. */
export interface ChargeRequest {
  /** The payment's id; providers use it as their own idempotency key. */
  paymentId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  /** The vault reference of the card; never a card number. */
  cardToken: string;
}

export interface ChargeResult {
  /** The provider's reference for the captured money. */
  providerReference: string;
}

/** The provider said no: a final answer, retrying will not change it. */
export class ProviderDeclinedError extends Error {
  constructor(readonly reason: string) {
    super(`declined: ${reason}`);
    this.name = 'ProviderDeclinedError';
  }
}

/** The provider could not be reached or answered with a server error: worth retrying. */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/** The port the payment service talks to; one adapter per provider implements it. */
export interface PaymentProvider {
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(providerReference: string, amountCents: number): Promise<void>;
}

/** Shared behaviour of the adapters: validate, log, then let the subclass talk to its provider. */
export abstract class BaseProvider implements PaymentProvider {
  abstract readonly name: string;

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    if (request.amountCents <= 0) {
      throw new ProviderDeclinedError('amount must be positive');
    }
    logger.info({ provider: this.name, paymentId: request.paymentId }, 'charging');
    return this.submit(request);
  }

  async refund(providerReference: string, amountCents: number): Promise<void> {
    logger.info({ provider: this.name, providerReference, amountCents }, 'refunding');
    await this.submitRefund(providerReference, amountCents);
  }

  protected abstract submit(request: ChargeRequest): Promise<ChargeResult>;
  protected abstract submitRefund(providerReference: string, amountCents: number): Promise<void>;
}
