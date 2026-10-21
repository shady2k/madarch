import { Cardnet } from './cardnet';
// @@ since deferred
import { Deferred } from './deferred';
// @@ end
import { PaymentProvider } from './provider';

/** Chooses the provider adapter named by PAYMENT_PROVIDER. */
export class PaymentClientFactory {
  static create(name: string): PaymentProvider {
    switch (name) {
      case 'cardnet':
        return new Cardnet();
// @@ since deferred
      case 'deferred':
        return new Deferred();
// @@ end
      default:
        throw new Error(`unknown payment provider "${name}" (expected cardnet or deferred)`);
    }
  }
}
