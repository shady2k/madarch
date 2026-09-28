// Writes every stored receipt to a JSON Lines file for the accountant.
import { appendFileSync } from 'node:fs';
import type { Receipt } from '../store';

export function exportReceipt(receipt: Receipt, to: string): void {
  appendFileSync(to, `${JSON.stringify(receipt)}\n`);
}
