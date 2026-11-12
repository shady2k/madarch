/** The owner process's authenticated preparation service; connections stay in the storage layer. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabaseOwner, leaseStoreCluster, clusterDatabases, renameClusterDatabase, type DatabaseOwner } from './database-owner.js';
import { prepareStore } from './prepare-store.js';
import { graphSchemaStamp } from './schemas/graph-definition.js';
import { withManifestContract } from '../graph/manifest-contract.js';
import type { PreparationRequest } from '../product/store-preparation.js';
const ADDRESS = 'MADARCH_STORE_OWNER_URL';
const TOKEN = 'MADARCH_STORE_OWNER_TOKEN';
/** Run an owner scope. Only a command without an API/fill role may enter it. */
export async function withStorePreparationOwner<T>(work: () => Promise<T>): Promise<T> {
  if (process.env['MADARCH_ROLE'] === 'api' || process.env['MADARCH_ROLE'] === 'fill') throw new Error('an API or fill role cannot own schema preparation (src/product/store-preparation.ts)');
  if (process.env[ADDRESS] !== undefined) return await work();
  const owners = new Map<string, DatabaseOwner>();
  const prepared = new Map<string, Map<string, string>>();
  let tail: Promise<unknown> = Promise.resolve();
  const ownerOf = async (store: string, database?: string): Promise<DatabaseOwner> => {
    const key = JSON.stringify([resolve(store), database ?? 'madarch']);
    let owner = owners.get(key);
    if (owner === undefined) {
      owner = await createDatabaseOwner({ store: resolve(store), ...(database === undefined ? {} : { database }) });
      owners.set(key, owner);
    }
    return owner;
  };
  const prepare = async (body: PreparationRequest): Promise<void> => {
    const store = resolve(body.store);
    if (body.histories === true || body.rename !== undefined) {
      prepared.delete(store);
      const lease = await leaseStoreCluster(resolve(body.store));
      try {
        if (body.rename !== undefined) {
          const key = JSON.stringify([resolve(body.store), body.rename.from]);
          await owners.get(key)?.close();
          owners.delete(key);
          await renameClusterDatabase(lease.ref, body.rename.from, body.rename.to);
        } else {
          for (const database of await clusterDatabases(lease.ref)) {
            if (database.startsWith('h_')) await prepareStore(await ownerOf(body.store, database), { historyOnly: true });
          }
        }
      } finally { await lease.close(); }
      return;
    }
    const database = body.database ?? 'madarch';
    const contract = body.contract === undefined ? undefined : withManifestContract(body.contract);
    const stamp = body.database !== undefined ? 'history' : contract === undefined ? undefined : graphSchemaStamp(contract);
    const previous = prepared.get(store)?.get(database);
    // Only this owner's last successful preparation stands; a different contract may change its schema.
    if (body.reset !== true && previous !== undefined && (stamp === undefined || previous === stamp)) return;
    prepared.get(store)?.delete(database);
    const owner = await ownerOf(store, body.database);
    const started = performance.now();
    try {
      await prepareStore(owner, { ...(body.reset === true ? { reset: true } : {}), ...(body.database === undefined ? {} : { historyOnly: true }), ...(contract === undefined ? {} : { contract }) });
    } finally {
      if (process.env.MADARCH_STARTUP_TIMING === '1') console.error(`startup schema.prepare ${(performance.now() - started).toFixed(1)} ms ${store}`);
    }
    const databases = prepared.get(store) ?? new Map<string, string>();
    databases.set(database, stamp ?? 'prepared');
    prepared.set(store, databases);
  };
  const token = randomUUID();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (req.method !== 'POST' || req.headers.get('authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 403 });
    try {
      const body = await req.json() as PreparationRequest;
      if (typeof body.store !== 'string' || body.store === '') return new Response('store is required', { status: 400 });
      const pending = tail.then(async () => await prepare(body));
      tail = pending.catch(() => undefined);
      await pending;
      return new Response(null, { status: 204 });
    } catch (error) { return new Response(error instanceof Error ? error.stack ?? error.message : String(error), { status: 500 }); }
  } });
  process.env[ADDRESS] = server.url.origin;
  process.env[TOKEN] = token;
  try { return await work(); }
  finally {
    if (process.env[TOKEN] === token && process.env[ADDRESS] === server.url.origin) {
      delete process.env[ADDRESS]; delete process.env[TOKEN];
    }
    server.stop(true);
    await tail;
    for (const owner of owners.values()) await owner.close();
  }
}
