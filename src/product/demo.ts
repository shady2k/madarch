/** The built-in demo product: keep the upstream repository as its authority. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readProduct } from './manifest.js';
import { productsHome, type DraftEnv } from './draft.js';
import { ownRepository, runGit } from './git.js';

/** The product repository shown by `madarch demo`; no product content ships in madarch. */
export const DEMO_REPOSITORY = 'https://github.com/shady2k/madarch-product.git';
export interface DemoOptions {
  url?: string;
  home?: string;
  env?: DraftEnv;
}
export type DemoResult = { ok: true; folder: string; updated: boolean } | { ok: false; message: string };

/** Clone the upstream demo when absent, or fast-forward its existing clone. */
export function prepareDemo(options: DemoOptions = {}): DemoResult {
  const url = options.url ?? DEMO_REPOSITORY;
  const env = options.env ?? process.env;
  const home = resolve(productsHome(env, options.home));
  const folder = join(home, 'madarch-product');
  try {
    if (existsSync(home) && !statSync(home).isDirectory())
      return { ok: false, message: `the products home ${home} is not a folder` };
    mkdirSync(home, { recursive: true });
  } catch (error) {
    return { ok: false, message: `the products home ${home} cannot be used: ${(error as Error).message}` };
  }
  if (existsSync(folder)) {
    let isPlainDirectory = false;
    try { isPlainDirectory = lstatSync(folder).isDirectory() && !lstatSync(folder).isSymbolicLink(); } catch { /* the folder disappeared */ }
    if (!isPlainDirectory || !ownRepository(folder))
      return { ok: false, message: `the folder ${folder} is not a product clone of its own; it was left unchanged` };
    const remote = runGit(folder, ['remote', 'get-url', 'origin']);
    if (!remote.ok || remote.output !== url)
      return { ok: false, message: `the folder ${folder} is not the Madarch demo clone from ${url}; it was left unchanged` };
    const update = runGit(folder, ['pull', '--ff-only']);
    if (!update.ok)
      return { ok: false, message: `the demo update from ${url} failed: ${update.output}; the product working tree remains unchanged. Check the network or the clone state; if you are offline, try madarch new` };
    const read = readProduct(folder);
    if (!read.ok) return { ok: false, message: `${read.file}:${read.line}: ${read.message}` };
    return { ok: true, folder, updated: true };
  }
  // Clone in a private per-run directory so concurrent attempts never share
  // a Git working tree and can only remove their own failed staging folder.
  let staging: string;
  try {
    staging = mkdtempSync(join(home, '.madarch-demo-clone-'));
  } catch (error) {
    return { ok: false, message: `a temporary demo clone folder cannot be created under ${home}: ${(error as Error).message}` };
  }
  const stagedProduct = join(staging, 'product');
  const clone = runGit(home, ['clone', '--quiet', url, stagedProduct]);
  if (!clone.ok) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, message: `git clone failed for ${url}: ${clone.output}; if the network is unavailable, check your connection; if you are offline, try madarch new` };
  }
  const stagedRead = readProduct(stagedProduct);
  if (!stagedRead.ok) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, message: `${stagedRead.file}:${stagedRead.line}: ${stagedRead.message}` };
  }
  // mkdir is exclusive: a destination that appeared during the clone is not
  // ours, so leave it intact and discard only this invocation's staging.
  try {
    mkdirSync(folder);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return { ok: false, message: `the demo folder ${folder} appeared while the clone was running; it was left unchanged` };
    return { ok: false, message: `the demo folder ${folder} cannot be reserved: ${(error as Error).message}` };
  }
  try {
    renameSync(stagedProduct, folder);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, message: `the cloned demo could not be installed at ${folder}: ${(error as Error).message}; the empty reserved folder remains at that path` };
  }
  rmSync(staging, { recursive: true, force: true });
  return { ok: true, folder, updated: false };
}
