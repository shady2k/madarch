import { randomUUID } from 'node:crypto';
// @@ since persist-pay
import { logger } from '../logging/logger';
// @@ end
// @@ since payment-events
import { EventSink, publishPaymentEvent } from '../events/publishers';
// @@ end
// @@ since cardnet
import { PaymentProvider, ProviderDeclinedError, ProviderUnavailableError } from '../providers/provider';
// @@ end
// @@ since retries
import { withRetry, withTimeout } from '../resilience';
// @@ end
// @@ since persist-pay
import { PaymentRepository } from '../store/payment-repository';
// @@ end
// @@ until payment-events
import { capture, CardToken, Payment, PaymentStatus } from './payment';
// @@ end
// @@ since payment-events
import { capture, CardToken, decline, Payment, PaymentStatus } from './payment';
// @@ end
// @@ since refunds
import { checkRefund, Refund } from './refund';
// @@ end

export interface PayRequest {
  orderId: string;
  amountCents: number;
  currency: string;
  cardToken: CardToken;
  /** Required: paying twice with the same key returns the first payment. */
  idempotencyKey: string;
}

export interface PaymentServiceDeps {
// @@ since cardnet
  provider: PaymentProvider;
// @@ end
// @@ since persist-pay
  repository: PaymentRepository;
// @@ end
// @@ since payment-events
  sink: EventSink;
// @@ end
// @@ since retries
  /** The budget of one provider call, from PAYMENT_TIMEOUT_MS. */
  timeoutMs: number;
// @@ end
  now?: () => Date;
// @@ since retries
  /** Waits between retries; tests replace it so they do not sleep. */
  sleep?: (ms: number) => Promise<void>;
// @@ end
}

// @@ since retries
/** How many times a provider call is tried before the payment is declined as unavailable. */
const ATTEMPTS = 3;
const BASE_DELAY_MS = 200;

// @@ end
/** The use cases of the payments service: pay and refund. */
export class PaymentService {
  private readonly now: () => Date;
// @@ until persist-pay
  private readonly payments = new Map<string, Payment>();
// @@ end

  constructor(private readonly deps: PaymentServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

// @@ since payment-events
  /**
   * Charges the card once per idempotency key (BR-3). A provider that is slow
   * or unreachable is retried with backoff inside the timeout; a refusal is final.
   */
// @@ end
// @@ until payment-events
  /** Takes the payment. The provider and the storage are not connected yet. */
// @@ end
  async pay(request: PayRequest): Promise<Payment> {
// @@ since persist-pay
    const existing = await this.deps.repository.findByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      logger.info({ paymentId: existing.id, idempotencyKey: request.idempotencyKey }, 'pay repeated with a known idempotency key');
      return existing;
    }

// @@ end
// @@ since pay-log
    logger.info({ orderId: request.orderId, idempotencyKey: request.idempotencyKey }, 'pay requested');
// @@ end
    const pending: Payment = {
      id: randomUUID(),
      orderId: request.orderId,
      amountCents: request.amountCents,
      currency: request.currency,
      status: PaymentStatus.Pending,
      idempotencyKey: request.idempotencyKey,
      createdAt: this.now(),
    };
// @@ since persist-pay
    await this.deps.repository.create(pending);

// @@ end
// @@ until cardnet
    const stub = capture(pending, { value: 'stub' }, this.now());
    this.payments.set(stub.id, stub);
    return stub;
// @@ end
// @@ since cardnet until persist-pay
    const result = await this.deps.provider.charge({
      paymentId: pending.id,
      orderId: pending.orderId,
      amountCents: pending.amountCents,
      currency: pending.currency,
      cardToken: request.cardToken.vaultReference,
    });
    const captured = capture(pending, { value: result.providerReference }, this.now());
    this.payments.set(captured.id, captured);
    return captured;
// @@ end
// @@ since persist-pay until payment-events
    const result = await this.deps.provider.charge({
      paymentId: pending.id,
      orderId: pending.orderId,
      amountCents: pending.amountCents,
      currency: pending.currency,
      cardToken: request.cardToken.vaultReference,
    });
    const captured = capture(pending, { value: result.providerReference }, this.now());
    await this.deps.repository.save(captured);
    return captured;
// @@ end
// @@ since payment-events until retries
    let outcome: Payment;
    try {
      const result = await this.deps.provider.charge({
        paymentId: pending.id,
        orderId: pending.orderId,
        amountCents: pending.amountCents,
        currency: pending.currency,
        cardToken: request.cardToken.vaultReference,
      });
      outcome = await capture(pending, { value: result.providerReference }, this.now(), this.deps.sink);
    } catch (error) {
      const reason = error instanceof ProviderDeclinedError ? error.reason : 'provider unavailable';
      outcome = await decline(pending, reason, this.deps.sink);
    }
    await this.deps.repository.save(outcome);
    return outcome;
// @@ end
// @@ since retries
    let outcome: Payment;
    try {
      const result = await withRetry(
        () =>
          withTimeout(
            this.deps.provider.charge({
              paymentId: pending.id,
              orderId: pending.orderId,
              amountCents: pending.amountCents,
              currency: pending.currency,
              cardToken: request.cardToken.vaultReference,
            }),
            this.deps.timeoutMs,
          ),
        { attempts: ATTEMPTS, baseDelayMs: BASE_DELAY_MS, isTransient, sleep: this.deps.sleep },
      );
      outcome = await capture(pending, { value: result.providerReference }, this.now(), this.deps.sink);
    } catch (error) {
      const reason = error instanceof ProviderDeclinedError ? error.reason : 'provider unavailable';
      logger.warn({ paymentId: pending.id, orderId: pending.orderId, reason }, 'payment not captured');
      outcome = await decline(pending, reason, this.deps.sink);
    }
    await this.deps.repository.save(outcome);
    return outcome;
// @@ end
  }

// @@ since refunds
  /** Refunds part or all of a captured payment, if the refund rule allows it. */
  async refund(paymentId: string, amountCents: number, reason?: string): Promise<Refund> {
    const payment = await this.deps.repository.findById(paymentId);
    if (!payment) {
      throw new PaymentNotFound(paymentId);
    }
// @@ end
// @@ since refunds until refund-cap
    checkRefund(payment, amountCents, this.now());

    await this.deps.provider.refund(payment.providerReference ?? '', amountCents);
    const refund: Refund = { id: randomUUID(), paymentId, amountCents, reason, createdAt: this.now() };
    await this.deps.repository.addRefund(refund);
    await this.deps.repository.save({ ...payment, status: PaymentStatus.Refunded });
    await publishPaymentEvent(this.deps.sink, 'payment.refunded', { ...payment, status: PaymentStatus.Refunded });
    return refund;
  }

// @@ end
// @@ since refund-cap
    const already = await this.deps.repository.refundedTotal(paymentId);
    checkRefund(payment, amountCents, already, this.now());

    await this.deps.provider.refund(payment.providerReference ?? '', amountCents);
    const refund: Refund = { id: randomUUID(), paymentId, amountCents, reason, createdAt: this.now() };
    await this.deps.repository.addRefund(refund);
    if (already + amountCents === payment.amountCents) {
      await this.deps.repository.save({ ...payment, status: PaymentStatus.Refunded });
      await publishPaymentEvent(this.deps.sink, 'payment.refunded', { ...payment, status: PaymentStatus.Refunded });
    }
    return refund;
  }

// @@ end
// @@ until persist-pay
  async get(paymentId: string): Promise<Payment> {
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new PaymentNotFound(paymentId);
    }
    return payment;
  }
// @@ end
// @@ since persist-pay
  async get(paymentId: string): Promise<Payment> {
    const payment = await this.deps.repository.findById(paymentId);
    if (!payment) {
      throw new PaymentNotFound(paymentId);
    }
    return payment;
  }
// @@ end
}

export class PaymentNotFound extends Error {
  constructor(readonly paymentId: string) {
    super(`no payment ${paymentId}`);
    this.name = 'PaymentNotFound';
  }
}
// @@ since retries

/** Timeouts and unreachable providers are worth another try; a decline is not. */
function isTransient(error: unknown): boolean {
  return error instanceof ProviderUnavailableError || (error instanceof Error && error.name === 'TimeoutError');
}
// @@ end
