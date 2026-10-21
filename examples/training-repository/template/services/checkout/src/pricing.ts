export interface CartLine {
  sku: string;
  quantity: number;
  priceCents: number;
  zeroRated?: boolean;
}

/** The sales tax rate the preview shows: 8% (BR-2 in docs/requirements.md). */
export const taxRate = 0.08;

/** The discount on an amount for a percentage: the amount times the percent, cut off at the cent (BR-1). */
export function discountFor(amountCents: number, percent: number): number {
  return Math.floor((amountCents * percent) / 100);
}

export interface Preview {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * What the cart will cost, shown before the order is placed. The orders
 * service prices the real order; this preview only has to agree with it.
 */
export function previewTotal(lines: CartLine[], percent: number): Preview {
  let subtotalCents = 0;
  let discountCents = 0;
  let taxCents = 0;
  for (const line of lines) {
    const gross = line.priceCents * line.quantity;
    const discount = discountFor(gross, percent);
    subtotalCents += gross;
    discountCents += discount;
    taxCents += line.zeroRated ? 0 : Math.round((gross - discount) * taxRate);
  }
  return { subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents };
}
