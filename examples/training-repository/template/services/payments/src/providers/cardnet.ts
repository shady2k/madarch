import { request } from '../http-client';
import { BaseProvider, ChargeRequest, ChargeResult, PaymentProvider, ProviderDeclinedError, ProviderUnavailableError } from './provider';

/** Cardnet: the default provider, a JSON API over HTTPS that captures at once. */
export class Cardnet extends BaseProvider implements PaymentProvider {
  readonly name = 'cardnet';

  constructor(private readonly baseUrl = 'https://api.cardnet.example/v2') {
    super();
  }

  protected async submit(charge: ChargeRequest): Promise<ChargeResult> {
    const response = await this.post('/charges', {
      reference: charge.paymentId,
      amount: charge.amountCents,
      currency: charge.currency,
      card: charge.cardToken,
    });
    if (response.status === 402) {
      const body = (await response.json()) as { reason?: string };
      throw new ProviderDeclinedError(body.reason ?? 'card refused');
    }
    if (response.status >= 500) {
      throw new ProviderUnavailableError(`cardnet answered ${response.status}`);
    }
    const body = (await response.json()) as { id: string };
    return { providerReference: body.id };
  }

  protected async submitRefund(providerReference: string, amountCents: number): Promise<void> {
    const response = await this.post(`/charges/${providerReference}/refunds`, { amount: amountCents });
    if (response.status >= 400) {
      throw new ProviderUnavailableError(`cardnet refused the refund with ${response.status}`);
    }
  }

  private async post(path: string, body: unknown) {
    try {
      return await request(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ProviderUnavailableError(`cardnet is unreachable: ${(error as Error).message}`);
    }
  }
}
