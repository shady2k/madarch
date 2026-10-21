import { PaymentService } from '../src/domain/payment-service';
import { Payment, PaymentStatus } from '../src/domain/payment';
import { Refund } from '../src/domain/refund';
import { EventSink } from '../src/events/publishers';
import { ChargeRequest, ChargeResult, PaymentProvider, ProviderDeclinedError, ProviderUnavailableError } from '../src/providers/provider';
import { PaymentRepository } from '../src/store/payment-repository';

class MemoryRepository implements PaymentRepository {
  payments = new Map<string, Payment>();
  refunds: Refund[] = [];

  async create(payment: Payment) {
    this.payments.set(payment.id, payment);
  }
  async save(payment: Payment) {
    this.payments.set(payment.id, payment);
  }
  async findById(id: string) {
    return this.payments.get(id);
  }
  async findByIdempotencyKey(key: string) {
    return [...this.payments.values()].find((p) => p.idempotencyKey === key);
  }
  async addRefund(refund: Refund) {
    this.refunds.push(refund);
  }
  async refundedTotal(paymentId: string) {
    return this.refunds.filter((r) => r.paymentId === paymentId).reduce((sum, r) => sum + r.amountCents, 0);
  }
}

class RecordingSink implements EventSink {
  events: Array<{ topic: string; key: string; body: Record<string, unknown> }> = [];
  async send(topic: string, key: string, value: string) {
    this.events.push({ topic, key, body: JSON.parse(value) });
  }
}

/** A provider that plays back a script: each call takes the next step. */
class ScriptedProvider implements PaymentProvider {
  readonly name = 'scripted';
  calls = 0;
  constructor(private readonly steps: Array<() => Promise<ChargeResult>>) {}
  async charge(_request: ChargeRequest): Promise<ChargeResult> {
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)];
    this.calls += 1;
    return step();
  }
  async refund(): Promise<void> {}
}

const ok = (reference: string) => async () => ({ providerReference: reference });
const unavailable = () => async (): Promise<ChargeResult> => {
  throw new ProviderUnavailableError('provider down');
};
const declined = () => async (): Promise<ChargeResult> => {
  throw new ProviderDeclinedError('insufficient funds');
};

function build(provider: PaymentProvider, timeoutMs = 50) {
  const repository = new MemoryRepository();
  const sink = new RecordingSink();
  const sleeps: number[] = [];
  const service = new PaymentService({
    provider,
    repository,
    sink,
    timeoutMs,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { service, repository, sink, sleeps };
}

const request = {
  orderId: 'ord_1',
  amountCents: 4200,
  currency: 'EUR',
  cardToken: { vaultReference: 'vault_1' },
  idempotencyKey: 'key-1',
};

describe('PaymentService.pay', () => {
  it('captures the payment and publishes payment.captured keyed by the order', async () => {
    const { service, sink } = build(new ScriptedProvider([ok('ref_1')]));
    const payment = await service.pay(request);
    expect(payment.status).toBe(PaymentStatus.Captured);
    expect(payment.providerReference).toBe('ref_1');
    expect(sink.events).toEqual([
      { topic: 'payments.events', key: 'ord_1', body: expect.objectContaining({ type: 'payment.captured', orderId: 'ord_1' }) },
    ]);
  });

  it('returns the first payment when the idempotency key repeats, without charging again', async () => {
    const provider = new ScriptedProvider([ok('ref_1')]);
    const { service } = build(provider);
    const first = await service.pay(request);
    const second = await service.pay({ ...request, amountCents: 9999 });
    expect(second.id).toBe(first.id);
    expect(provider.calls).toBe(1);
  });

  it('retries an unavailable provider with doubling waits and then captures', async () => {
    const provider = new ScriptedProvider([unavailable(), unavailable(), ok('ref_3')]);
    const { service, sleeps } = build(provider);
    const payment = await service.pay(request);
    expect(payment.status).toBe(PaymentStatus.Captured);
    expect(provider.calls).toBe(3);
    expect(sleeps).toEqual([200, 400]);
  });

  it('declines after three unavailable answers', async () => {
    const provider = new ScriptedProvider([unavailable()]);
    const { service, sink } = build(provider);
    const payment = await service.pay(request);
    expect(payment.status).toBe(PaymentStatus.Declined);
    expect(payment.declineReason).toBe('provider unavailable');
    expect(provider.calls).toBe(3);
    expect(sink.events[0].body).toEqual(expect.objectContaining({ type: 'payment.failed', reason: 'provider unavailable' }));
  });

  it('does not retry a refusal', async () => {
    const provider = new ScriptedProvider([declined()]);
    const { service } = build(provider);
    const payment = await service.pay(request);
    expect(payment.declineReason).toBe('insufficient funds');
    expect(provider.calls).toBe(1);
  });

  it('gives up on a provider that does not answer within the timeout', async () => {
    const hangs = async (): Promise<ChargeResult> => new Promise(() => undefined);
    const provider = new ScriptedProvider([hangs]);
    const { service } = build(provider, 20);
    const payment = await service.pay(request);
    expect(payment.status).toBe(PaymentStatus.Declined);
    expect(provider.calls).toBe(3);
  });
});

describe('PaymentService.refund', () => {
  it('refunds in two parts and publishes payment.refunded when the last part completes it', async () => {
    const { service, sink } = build(new ScriptedProvider([ok('ref_1')]));
    const payment = await service.pay(request);
    await service.refund(payment.id, 1000);
    expect(sink.events.map((e) => e.body.type)).toEqual(['payment.captured']);
    await service.refund(payment.id, 3200);
    expect(sink.events.map((e) => e.body.type)).toEqual(['payment.captured', 'payment.refunded']);
  });
});
