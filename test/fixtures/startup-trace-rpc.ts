import { startupEntry, startupBegin, withStartupContext } from '../../src/obs/log.js';
import { startupIdentifiers, startupChildEnv } from '../../src/obs/startup-context.js';
import { withStorePreparationOwner, requestHistoryPreparation } from '../../src/product/store-preparation.js';
import { randomUUID } from 'node:crypto';
startupEntry('fixture');
const store = process.argv[2]!;
if (process.argv[3] === 'client') {
 const op = randomUUID();
 await withStartupContext(op, async () => { const end = startupBegin('client.prepare', `${store}/pgdata`); await requestHistoryPreparation(store, 'history'); end('ok'); });
 console.log(JSON.stringify({ operation: op }));
} else {
 await withStorePreparationOwner(async () => {
  for (let i = 0; i < 2; i++) {
   const child = Bun.spawn([process.execPath, import.meta.path, store, 'client'], { env: startupChildEnv(), stdout: 'pipe', stderr: 'inherit' });
   const output = await new Response(child.stdout).text(); if (await child.exited !== 0) throw new Error('client failed'); process.stdout.write(output);
  }
  const mismatch = randomUUID();
  const response = await fetch(process.env.MADARCH_STORE_OWNER_URL!, { method: 'POST', headers: { authorization: `Bearer ${process.env.MADARCH_STORE_OWNER_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ store, database: 'history', startup: { operation: mismatch, collection: startupIdentifiers()?.collection, keyId: 'different' } }) });
  console.log(JSON.stringify({ mismatch, status: response.status }));
 });
}
