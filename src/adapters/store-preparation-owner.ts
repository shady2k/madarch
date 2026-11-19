/** The owner process's authenticated preparation service; connections stay in the storage layer. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabaseOwner, leaseStoreCluster, clusterDatabases, renameClusterDatabase, type DatabaseOwner } from './database-owner.js';
import { prepareStore } from './prepare-store.js';
import { graphSchemaStamp } from './schemas/graph-definition.js';
import { withManifestContract } from '../graph/manifest-contract.js';
import { registerSystemSource } from '../graph/system-installation.js';
import type { PreparationRequest } from '../product/store-preparation.js';
const ADDRESS = 'MADARCH_STORE_OWNER_URL';
const TOKEN = 'MADARCH_STORE_OWNER_TOKEN';
/** Run an owner scope. Only a command without an API/fill role may enter it. */
export async function withStorePreparationOwner<T>(work: () => Promise<T>): Promise<T> {
  if (process.env['MADARCH_ROLE'] === 'api' || process.env['MADARCH_ROLE'] === 'fill') throw new Error('an API or fill role cannot own schema preparation (src/product/store-preparation.ts)');
  if (process.env[ADDRESS] !== undefined) return await work();
  // The scope's lifetime ends when its work returns, never at the signal itself: a command that owns stores answers
  // SIGTERM by draining what it was doing (the daemon's startup catalogue publication among it), and aborting here at
  // the signal would refuse the preparation that drain waits for. The finally below aborts whatever is still in
  // flight once the work has ended, so a preparation blocked on a schema lock cannot hold the scope open.
  const lifetime = new AbortController();
  const stop = (): void => { lifetime.abort(new Error(`${import.meta.path}:17: the store preparation owner is stopping`)); };
  const { signal } = lifetime;
  // The scope keeps the pool; preparation only borrows its shutdown lifetime.
  const preparing = (owner: DatabaseOwner): DatabaseOwner => ({
    location: owner.location, ready: owner.ready, allowConcurrentSnapshots: owner.allowConcurrentSnapshots, hasVector: owner.hasVector,
    transaction: (kind, work, options) => owner.transaction(kind, work, { signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]) }),
    // pg-boss owns its transaction batches; only normal transactions borrow cancellation.
    run: owner.run.bind(owner),
    exec: owner.exec.bind(owner),
    close: owner.close.bind(owner),
  });
  const owners = new Map<string, DatabaseOwner>();
  const prepared = new Map<string, Map<string, string>>();
  let tail: Promise<unknown> = Promise.resolve();
  const ownerOf = async (store: string, database?: string): Promise<DatabaseOwner> => {
    signal.throwIfAborted();
    const key = JSON.stringify([resolve(store), database ?? 'madarch']);
    let owner = owners.get(key);
    if (owner === undefined) {
      owner = await createDatabaseOwner({ store: resolve(store), ...(database === undefined ? {} : { database }) });
      owners.set(key, owner);
    }
    signal.throwIfAborted();
    return preparing(owner);
  };
  const prepare = async (body: PreparationRequest): Promise<void> => {
    signal.throwIfAborted();
    const store = resolve(body.store);
    if (body.histories === true || body.rename !== undefined) {
      prepared.delete(store);
      const lease = await leaseStoreCluster(resolve(body.store));
      try {
        signal.throwIfAborted();
        if (body.rename !== undefined) {
          const key = JSON.stringify([resolve(body.store), body.rename.from]);
          await owners.get(key)?.close();
          owners.delete(key);
          signal.throwIfAborted();
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
    const stamp = body.database !== undefined ? 'history' : contract === undefined ? undefined : `${graphSchemaStamp(contract)}:${JSON.stringify(body.installedPlugins ?? [])}`;
    const previous = prepared.get(store)?.get(database);
    // Only this owner's last successful preparation stands; a different contract may change its schema.
    if (body.reset !== true && previous !== undefined && (stamp === undefined || previous === stamp)) return;
    prepared.get(store)?.delete(database);
    const owner = await ownerOf(store, body.database);
    const started = performance.now();
    try {
      await prepareStore(owner, { ...(body.reset === true ? { reset: true } : {}), ...(body.database === undefined ? {} : { historyOnly: true }), ...(contract === undefined ? {} : { contract }) });
      if (contract !== undefined && body.database === undefined) {
        for (const plugin of body.installedPlugins ?? []) {
          await registerSystemSource(owner, contract, { type: 'plugin', installationKey: plugin.id, scope: owner.location, version: plugin.version });
        }
      }
    } finally {
      if (process.env.MADARCH_STARTUP_TIMING === '1') console.error(`startup schema.prepare ${(performance.now() - started).toFixed(1)} ms ${store}`);
    }
    signal.throwIfAborted();
    const databases = prepared.get(store) ?? new Map<string, string>();
    databases.set(database, stamp ?? 'prepared');
    prepared.set(store, databases);
  };
  const token = randomUUID();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (req.method !== 'POST' || req.headers.get('authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 403 });
    try {
      signal.throwIfAborted();
      const body = await req.json() as PreparationRequest;
      if (typeof body.store !== 'string' || body.store === '') return new Response('store is required', { status: 400 });
      signal.throwIfAborted();
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
    stop();
    if (process.env[TOKEN] === token && process.env[ADDRESS] === server.url.origin) {
      delete process.env[ADDRESS]; delete process.env[TOKEN];
    }
    server.stop(true);
    await tail;
    const results = await Promise.allSettled([...owners.values()].map((owner) => owner.close()));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
