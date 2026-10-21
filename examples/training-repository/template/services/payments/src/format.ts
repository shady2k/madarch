/** Formats cents as "12.34 EUR"; used by the report and the logs. */
export function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/** The invoice amount format of the old billing system: "$12.34". */
export function formatInvoiceLegacy(total: number): string {
  return `$${total.toFixed(2)}`;
}
