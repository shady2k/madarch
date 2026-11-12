/** Test command owner: prepare stores before publishing HTTP readers, never inside a request. */
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { withStorePreparationOwner, requestStorePreparation } from '../src/product/store-preparation.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { listProducts } from '../src/product/list.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';

/** Explicit activation for a fixture product created after its HTTP server started. */
export async function activateTestProduct(folder: string, home: string, knowledgeRoot = knowledgeRootOf(home)): Promise<void> {
  const kinds = readKinds(folder);
  const contract = existsSync(resolve(folder, '.git'))
    ? await readPinnedGraphContract(folder)
    : kinds.present ? graphContractOf(kinds.manifest) : EMPTY_CONTRACT;
  await requestStorePreparation(storeDatabasePath(productStoreFolder(folder, knowledgeRoot)), contract);
}

/** Prepare a direct product fixture before clients open, retaining its owner until they close. */
export async function prepareTestProduct(folder: string, home: string, knowledgeRoot = knowledgeRootOf(home)): Promise<() => Promise<void>> {
  const closeOwner = await retainTestStorePreparationOwner();
  try {
    await activateTestProduct(folder, home, knowledgeRoot);
    return closeOwner;
  } catch (error) {
    await closeOwner();
    throw error;
  }
}

/** Keep the production owner service alive until all server readers and fills close. */
export async function startPreparedServer(options: Parameters<typeof startServer>[0]): Promise<StartedServer> {
  const home = options.productHome ?? (options.productFolder === undefined ? undefined : dirname(options.productFolder));
  if (home === undefined) throw new Error(`${import.meta.filename}:21: a prepared fixture server requires productHome or productFolder`);
  const closeOwner = await retainTestStorePreparationOwner();
  try {
    const listed = listProducts({ home });
    if (listed.outcome !== 'listed') throw new Error(`${import.meta.filename}:32: cannot list fixture products: ${listed.message}`);
    const folders = new Set(options.productFolder === undefined ? listed.products.map((product) => product.folder) : [options.productFolder]);
    if (options.ownWiki !== undefined) folders.add(options.ownWiki.folder);
    for (const folder of folders) await activateTestProduct(folder, home, options.knowledgeRoot);
    const server = await startServer(options);
    return { ...server, stop: async () => { try { await server.stop(); } finally { await closeOwner(); } } };
  } catch (error) {
    await closeOwner();
    throw error;
  }
}

// Several fixture servers may coexist (for example, two products homes sharing the own wiki).
let sharedOwner: { users: number; ready: Promise<void>; done: Promise<void>; release: () => void; url: string; token: string } | undefined;
export async function retainTestStorePreparationOwner(): Promise<() => Promise<void>> {
  if (sharedOwner === undefined) {
    let opened!: () => void;
    let refused!: (error: unknown) => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve, reject) => { opened = resolve; refused = reject; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let descriptor!: { url: string; token: string };
    const done = withStorePreparationOwner(async () => {
      descriptor = { url: process.env['MADARCH_STORE_OWNER_URL']!, token: process.env['MADARCH_STORE_OWNER_TOKEN']! };
      opened();
      await held;
    });
    void done.catch(refused);
    sharedOwner = { users: 0, ready, done, release, get url() { return descriptor.url; }, get token() { return descriptor.token; } };
  }
  const owner = sharedOwner;
  owner.users += 1;
  try { await owner.ready; }
  catch (error) { sharedOwner = undefined; throw error; }
  // Bun restores process.env between test files, while imported helper modules stay cached.
  try {
    const response = await fetch(owner.url, { method: 'GET', headers: { authorization: `Bearer ${owner.token}` } });
    if (response.status !== 403) throw new Error(`expected owner method refusal 403, received ${response.status}`);
  } catch (error) {
    owner.users -= 1;
    if (sharedOwner === owner) sharedOwner = undefined;
    owner.release();
    throw new Error(`${import.meta.filename}:77: the retained fixture preparation owner is no longer reachable: ${(error as Error).message}`);
  }
  process.env['MADARCH_STORE_OWNER_URL'] = owner.url;
  process.env['MADARCH_STORE_OWNER_TOKEN'] = owner.token;
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    owner.users -= 1;
    if (owner.users !== 0) return;
    if (sharedOwner === owner) sharedOwner = undefined;
    owner.release();
    await owner.done;
  };
}
