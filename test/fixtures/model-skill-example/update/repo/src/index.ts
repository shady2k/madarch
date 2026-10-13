// The entry point: import every PDF in the inbox, then stop.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { exportReceipt } from './export/writer';
import { importReceipt } from './importer';
import { postReceipt } from './notify/webhook';
import { storeReceipt } from './store';

const inbox = 'inbox';
const exportTo = 'receipts.jsonl';

for (const name of readdirSync(inbox)) {
  if (!name.endsWith('.pdf')) continue;
  const receipt = importReceipt(join(inbox, name));
  storeReceipt(receipt);
  exportReceipt(receipt, exportTo);
  postReceipt(receipt);
}
