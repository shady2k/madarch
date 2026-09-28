// Posts each stored receipt to the accounting system's webhook.
import type { Receipt } from '../store';

const HOOK = 'http://accounting.internal/hooks/receipts';

export function postReceipt(receipt: Receipt): void {
  void fetch(HOOK, { method: 'POST', body: JSON.stringify(receipt) });
}
