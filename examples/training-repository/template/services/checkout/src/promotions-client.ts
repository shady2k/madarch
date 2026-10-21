export interface AppliedPromotion {
  code: string;
  discountCents: number;
  /** The same discount as a percentage of the subtotal: orders accepts only percentages. */
  percent: number;
}

/** HTTP client of the promotions service (POST /internal/apply). */
export class PromotionsClient {
  constructor(private readonly baseUrl: string) {}

  /** Returns the discount the code gives on the subtotal, or undefined when the code does not apply. */
  async apply(code: string, subtotalCents: number): Promise<AppliedPromotion | undefined> {
    const response = await fetch(`${this.baseUrl}/internal/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, subtotalCents }),
    });
    if (response.status === 404 || response.status === 422) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`promotions answered ${response.status}`);
    }
    return (await response.json()) as AppliedPromotion;
  }
}
