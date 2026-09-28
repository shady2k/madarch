// Reads one receipt PDF and parses it into a receipt.
import { readFileSync } from 'node:fs';
import type { Receipt } from './store';

export function importReceipt(path: string): Receipt {
  const text = readFileSync(path, 'utf8');
  const vendor = text.match(/^Vendor: (.+)$/m)![1]!;
  const date = text.match(/^Date: (.+)$/m)![1]!;
  const total = Number(text.match(/^Total: (.+)$/m)![1]!);
  return { id: `receipt-${date}-${vendor}`, vendor, date, total };
}
