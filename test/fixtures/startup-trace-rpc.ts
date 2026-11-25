import { startupEntry, startupBegin, withStartupContext } from '../../src/obs/log.js';
import { startupIdentifiers, startupChildEnv } from '../../src/obs/startup-context.js';
import { withStorePreparationOwner, requestHistoryPreparation } from '../../src/product/store-preparation.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
// The extended mode the RPC suite drives adds a capturing proxy and two operations held at a
// barrier. Invoked without the flag the fixture keeps the plain sequence the S1 suite drives.
const extended = process.argv[3] === 's3';
const contextPath = process.env.MADARCH_STARTUP_CONTEXT;
const contextKey = contextPath === undefined ? undefined : (JSON.parse(readFileSync(contextPath, 'utf8')) as { key: string }).key;
startupEntry(process.argv[3] === 'client' ? 'api' : 'fixture');
const store = process.argv[2]!;
if (process.argv[3] === 'client') {
 const queued = process.argv[4] === 'queued';
 const prepare = async (database: string) => {
  const op = randomUUID();
  await withStartupContext(op, async () => { const end = startupBegin('client.prepare', `${store}/pgdata`); await requestHistoryPreparation(store, database); end('ok'); });
  console.log(JSON.stringify(queued ? { queuedOperation: op } : { operation: op }));
 };
 if (queued) await Promise.all([prepare('queued_a'), prepare('queued_b')]);
 else await prepare('history');
} else {
 await withStorePreparationOwner(async () => {
  const ownerUrl = process.env.MADARCH_STORE_OWNER_URL!;
  const ownerToken = process.env.MADARCH_STORE_OWNER_TOKEN!;
  let queuedMode = false;
  let queuedReceipts = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const proxy = extended ? Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
   const raw = await req.text();
   const body = JSON.parse(raw) as { startup?: Record<string, unknown> };
   const identifiers = startupIdentifiers();
   console.log(JSON.stringify({ capturedRequest: true, fields: Object.keys(body).sort(), startupFields: Object.keys(body.startup ?? {}).sort(),
    operation: undefined, capturedOperation: body.startup?.operation,
    identifiersMatch: body.startup?.collection === identifiers?.collection && body.startup?.keyId === identifiers?.keyId,
    contextPathAbsent: contextPath === undefined || !raw.includes(contextPath), keyAbsent: contextKey === undefined || !raw.includes(contextKey),
    credentialAbsent: !raw.includes(ownerToken), authenticated: req.headers.get('authorization') === `Bearer ${ownerToken}` }));
   if (queuedMode) { queuedReceipts++; if (queuedReceipts === 2) release(); await barrier; }
   return await fetch(ownerUrl, { method: 'POST', headers: { authorization: req.headers.get('authorization')!, 'content-type': 'application/json' }, body: raw });
  } }) : undefined;
  const client = async (queued = false) => {
   const child = Bun.spawn([process.execPath, import.meta.path, store, 'client', ...(queued ? ['queued'] : [])], {
    env: proxy === undefined ? startupChildEnv() : startupChildEnv({ ...process.env, MADARCH_STORE_OWNER_URL: proxy.url.origin }), stdout: 'pipe', stderr: 'inherit' });
   const output = await new Response(child.stdout).text();
   if (await child.exited !== 0) throw new Error('client failed');
   process.stdout.write(output);
  };
  try {
   await client(); await client();
   if (proxy !== undefined) { queuedMode = true; await client(true); console.log(JSON.stringify({ queuedReceipts })); }
   const mismatch = randomUUID();
   const response = await fetch(ownerUrl, { method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ store, database: 'history', startup: { operation: mismatch, collection: startupIdentifiers()?.collection, keyId: 'different' } }) });
   console.log(JSON.stringify({ mismatch, status: response.status }));
  } finally { proxy?.stop(true); }
 });
}
