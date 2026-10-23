/**
 * madarch's own wiki (decision 0031). madarch holds no product content: its
 * documentation is the madarch product repository, a product like any other.
 * The release binary carries a pinned revision of it (`own-wiki.lock` names the
 * revision, `scripts/build-binary.ts` embeds it as a git bundle), so a first run
 * needs no network. The first start installs it as a git checkout at
 * `<madarch home>/madarch-wiki` with the repository as its origin; later starts
 * fast-forward the checkout from the origin when it has no change of its own.
 * Nothing here blocks a start: an install that cannot be made says why, with the
 * repository and the folder, and the server runs without the entry.
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { embeddedOwnWiki } from '../product-wiki/release-assets.js';
import { madarchHome, type DraftEnv } from './home.js';
import { ownRepository, runGit } from './git.js';
import { readProduct } from './manifest.js';

/** The repository madarch's own wiki is. */
export const OWN_WIKI_REPOSITORY = 'https://github.com/shady2k/madarch-product.git';
/** The branch of that repository the wiki follows. */
export const OWN_WIKI_BRANCH = 'main';
/** The folder name under the madarch home. */
export const OWN_WIKI_FOLDER = 'madarch-wiki';

export interface OwnWikiOptions {
  env?: DraftEnv;
  /** The repository to install from and refresh from; `MADARCH_OWN_WIKI_REPOSITORY`, else madarch's own. */
  repository?: string;
  /** The embedded bundle, when the process carries one; the release binary's by default. */
  bundle?: string;
}

/** Whether the wiki is switched off (`MADARCH_OWN_WIKI=off`): a test, or a person who wants the products only. */
export const ownWikiOff = (env: DraftEnv = process.env): boolean => env.MADARCH_OWN_WIKI?.trim().toLowerCase() === 'off';

export const ownWikiFolder = (env: DraftEnv = process.env): string => join(madarchHome(env), OWN_WIKI_FOLDER);

const repositoryOf = (options: OwnWikiOptions): string => options.repository ?? (options.env ?? process.env).MADARCH_OWN_WIKI_REPOSITORY?.trim() ?? OWN_WIKI_REPOSITORY;

export type OwnWikiInstall = { ok: true; folder: string; installed: boolean } | { ok: false; folder: string; message: string };

/** Makes sure the checkout exists and is a product; installs the pinned copy (or clones the repository) when it does not. */
export function installOwnWiki(options: OwnWikiOptions = {}): OwnWikiInstall {
  const env = options.env ?? process.env;
  const folder = ownWikiFolder(env);
  const repository = repositoryOf(options);
  if (existsSync(folder)) {
    const checked = checkFolder(folder);
    return checked === undefined ? { ok: true, folder, installed: false } : { ok: false, folder, message: checked };
  }
  const home = madarchHome(env);
  let staging: string;
  try {
    mkdirSync(home, { recursive: true });
    staging = mkdtempSync(join(home, '.own-wiki-'));
  } catch (error) {
    return { ok: false, folder, message: `madarch's own wiki cannot be installed: the madarch home ${home} cannot be used: ${(error as Error).message}` };
  }
  const embedded = options.bundle !== undefined ? { bundle: options.bundle } : embeddedOwnWiki();
  const staged = join(staging, 'wiki');
  const from = embedded?.bundle ?? repository;
  const clone = runGit(staging, ['clone', '--quiet', '--branch', OWN_WIKI_BRANCH, from, staged]);
  if (!clone.ok) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, folder, message: `madarch's own wiki cannot be installed at ${folder}: git clone of ${from} failed: ${clone.output}${embedded === undefined ? '; this madarch carries no copy of it, so the first start needs the network (or a release binary)' : ''}` };
  }
  const origin = runGit(staged, ['remote', 'set-url', 'origin', repository]);
  const read = readProduct(staged);
  if (!origin.ok || !read.ok) {
    rmSync(staging, { recursive: true, force: true });
    if (!origin.ok) return { ok: false, folder, message: `madarch's own wiki cannot be installed at ${folder}: setting origin to ${repository} failed: ${origin.output}` };
    const why = read.ok ? '' : `${read.file}:${read.line}: ${read.message}`;
    return { ok: false, folder, message: `madarch's own wiki cannot be installed at ${folder}: ${from} is no product: ${why}` };
  }
  try {
    renameSync(staged, folder);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, folder, message: `madarch's own wiki cannot be installed: ${staged} could not be moved to ${folder}: ${(error as Error).message}` };
  }
  rmSync(staging, { recursive: true, force: true });
  return { ok: true, folder, installed: true };
}

/** Why an existing folder cannot serve as the wiki, or undefined when it can. */
function checkFolder(folder: string): string | undefined {
  try {
    if (!lstatSync(folder).isDirectory()) return `madarch's own wiki cannot be served: ${folder} is not a folder`;
  } catch (error) {
    return `madarch's own wiki cannot be served: ${folder} cannot be read: ${(error as Error).message}`;
  }
  if (!ownRepository(folder)) return `madarch's own wiki cannot be served: ${folder} is not a git repository of its own; move it away and the next start installs the wiki again`;
  const read = readProduct(folder);
  return read.ok ? undefined : `madarch's own wiki cannot be served: ${read.file}:${read.line}: ${read.message}`;
}

function git(folder: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: folder, timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      resolve({ ok: error === null, output: `${stderr}${stdout}`.trim() });
    });
  });
}

/**
 * Brings the checkout up to the repository: fetches the branch and fast-forwards, but only a checkout with no change of
 * its own (nothing uncommitted, nothing ahead of the repository). Answers one sentence for the server's log.
 */
export async function refreshOwnWiki(options: OwnWikiOptions = {}): Promise<string> {
  const folder = ownWikiFolder(options.env ?? process.env);
  const named = await git(folder, ['remote', 'get-url', 'origin'], 20_000);
  const repository = named.ok ? named.output : repositoryOf(options);
  const status = await git(folder, ['status', '--porcelain'], 20_000);
  if (!status.ok) return `madarch's own wiki at ${folder} was not refreshed from ${repository}: git status failed: ${status.output}`;
  if (status.output !== '') return `madarch's own wiki at ${folder} was not refreshed from ${repository}: the folder has changes of its own (${status.output.split('\n')[0]})`;
  const fetched = await git(folder, ['fetch', '--quiet', 'origin', OWN_WIKI_BRANCH], 60_000);
  if (!fetched.ok) return `madarch's own wiki at ${folder} was not refreshed: fetching ${OWN_WIKI_BRANCH} from ${repository} failed: ${fetched.output}`;
  const head = await git(folder, ['rev-parse', 'HEAD'], 20_000);
  const upstream = await git(folder, ['rev-parse', 'FETCH_HEAD'], 20_000);
  if (head.ok && upstream.ok && head.output === upstream.output) return `madarch's own wiki at ${folder} is up to date with ${repository}`;
  const ancestor = await git(folder, ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'], 20_000);
  if (!ancestor.ok) return `madarch's own wiki at ${folder} was not refreshed from ${repository}: it has commits of its own, so it is left as it is`;
  const merged = await git(folder, ['merge', '--ff-only', '--quiet', 'FETCH_HEAD'], 60_000);
  return merged.ok ? `madarch's own wiki at ${folder} was updated to ${upstream.output.slice(0, 12)} from ${repository}` : `madarch's own wiki at ${folder} was not refreshed from ${repository}: ${merged.output}`;
}
