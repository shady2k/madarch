import { Cardnet } from '../src/providers/cardnet';
// @@ since deferred
import { Deferred } from '../src/providers/deferred';
// @@ end
import { PaymentClientFactory } from '../src/providers/factory';

describe('PaymentClientFactory', () => {
  it('builds the cardnet adapter for "cardnet"', () => {
    const provider = PaymentClientFactory.create('cardnet');
    expect(provider).toBeInstanceOf(Cardnet);
    expect(provider.name).toBe('cardnet');
  });

// @@ since deferred
  it('builds the deferred adapter for "deferred"', () => {
    const provider = PaymentClientFactory.create('deferred');
    expect(provider).toBeInstanceOf(Deferred);
    expect(provider.name).toBe('deferred');
  });

// @@ end
  it('refuses a provider name it does not know', () => {
    expect(() => PaymentClientFactory.create('stripe')).toThrow('unknown payment provider "stripe"');
  });
});
