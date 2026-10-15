// Posts each stored receipt to the example webhook.
import type { Receipt } from '../store';

const HOOK = 'https://example.com/hooks/receipts';

export function postReceipt(receipt: Receipt): void {
  void fetch(HOOK, { method: 'POST', body: JSON.stringify(receipt) });
}
