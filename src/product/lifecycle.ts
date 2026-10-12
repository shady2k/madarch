/**
 * The product lifecycle on the `madarch` command: rename, remote, repo add,
 * bootstrap and clone, with the operations that change a product folder
 * (decision 0021: the lifecycle commands are madarch's own code, revising the
 * clause of 0019 that gave them to the set and pinned its vendored program).
 * This module is the commands' one place: the operations themselves — the
 * manifest change, the folder move, the git steps, the clone — and the thin
 * wrapper the subcommands share decide what is madarch's own: which folder
 * the command names when run without `--product` (the where, walking up from
 * the working folder), the products home of `clone`, which facts each
 * outcome prints and to which stream, and the exit code.
 *
 * Every refusal and failure names what is wrong in the words a person acts
 * on, each at the file and line where it is known; the same words are the
 * contract's conformance cases (`examples/contract/manifest-cases.json`)
 * beside the guide (docs/guides/start-a-product.md).
 *
 * The exit codes follow the command's other subcommands: 0 done, 2 refused
 * (an argument, a folder, a manifest or a name that cannot be used), 1
 * failed (a git step refused, or a declared repository the clone could not
 * take). Facts go to standard output one per line; errors go to standard
 * error, one message per error, whole.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ownRepository, runGit, type GitEnv } from './git.js';
import {
  lineOf,
  lineOfIndex,
  manifestNamed,
  manifestWithRepo,
  MANIFEST_FILE,
  parseManifest,
  readProduct,
  type ProductIdentity,
} from './manifest.js';
import { productsHome, type DraftEnv } from './draft.js';

// ---- the operations: the product, named, given a remote, and bootstrapped --

/** A read whose refusal is the operation's refusal, whole, at the manifest's file and line. */
type ReadProduct = { ok: true; product: ProductIdentity } | { ok: false; message: string; file?: string; line?: number };

/** Turns the manifest reader's refusal into the operation outcome's refusal, keeping where it was found. */
function readFor(productFolder: string | undefined): ReadProduct {
  const read = readProduct(productFolder === undefined ? '.' : productFolder);
  if (read.ok) return read;
  return { ok: false, message: read.message, file: read.file, line: read.line };
}

/** A word quoted shell-safely is not a yaml word; see manifest.yamlWord for the manifest's own quoting. */

/** Why a product may not take a folder name, or null when it may. */
function whyNotAFolderName(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') return 'a product is named by a word, and this is empty';
  if (name !== name.trim()) return 'a folder name does not begin or end with a space';
  if (name === '.' || name === '..') return 'a folder name is not "." or ".."';
  if (/[/\\]/.test(name)) return 'a folder name is one path segment, and this holds a separator';
  if (/[\u0000-\u001f]/.test(name)) return 'a folder name holds no control character';
  return null;
}

/** Puts a failed rename back as it was; the failure, when there is one, is the caller's to report. */
function putRenameBack(from: string, to: string, manifest: string, gitEnv?: GitEnv): string | undefined {
  try {
    writeFileSync(join(from, MANIFEST_FILE), manifest);
    runGit(from, ['reset', '--quiet', '--', MANIFEST_FILE], gitEnv);
    renameSync(from, to);
    return undefined;
  } catch (error) {
    return `the failed rename left the product in ${from}: ${(error as Error).message}`;
  }
}

/** How renaming a product in place ended; `refused` is the command's exit 2, `failed` its exit 1. A refusal from the reader names its file and line. */
export type RenameResult =
  | { outcome: 'renamed'; folder: string; id: string; name: string }
  | { outcome: 'refused'; message: string; file?: string; line?: number }
  | { outcome: 'failed'; message: string };

/**
 * Names a draft in place: the folder is renamed within its parent, `name` is
 * written in the manifest, and that change is one commit. The `id` and every
 * other byte of the manifest are kept, and nothing written holds an absolute
 * path, so the links between the product's documents still reach each other.
 * Every refusal — a folder name a product cannot take, a name already taken in
 * the parent, a working tree with uncommitted changes, a manifest that cannot
 * be used — happens before anything moves.
 */
export function renameProduct(options: { folder?: string; name?: string; gitEnv?: GitEnv } = {}): RenameResult {
  const name = options.name;
  const read = readFor(options.folder);
  if (!read.ok) return { outcome: 'refused', message: read.message, file: read.file, line: read.line };
  const folder = read.product.folder;

  const why = whyNotAFolderName(name);
  if (why !== null) return { outcome: 'refused', message: `the name "${name}" cannot be a product's: ${why}` };
  const wanted = name as string;

  const target = join(dirname(folder), wanted);
  if (target === folder)
    return { outcome: 'refused', message: `the folder ${folder} is already named "${wanted}": naming a product to the name it has makes no commit` };
  if (existsSync(target))
    return { outcome: 'refused', message: `the folder ${target} is in the way: a product's name is the folder it lives in, and that name is taken` };
  if (!ownRepository(folder, options.gitEnv))
    return { outcome: 'refused', message: `the folder ${folder} is not a git repository of its own: naming a product in place is one commit of the product's history, and a commit made here would land in the repository around it` };

  const status = runGit(folder, ['status', '--porcelain'], options.gitEnv);
  if (!status.ok) return { outcome: 'failed', message: `git status failed in ${folder}: ${status.output}` };
  if (status.output !== '')
    return { outcome: 'refused', message: `the folder ${folder} holds changes that are not committed: commit them first, since naming the product is a commit of its own and would take them with it` };

  const manifest = readFileSync(join(folder, MANIFEST_FILE), 'utf8');
  // The move itself is a step like the commit that follows it: a folder that
  // cannot be renamed failed, and says so with the name and the reason.
  let moved = false;
  try {
    renameSync(folder, target);
    moved = true;
    writeFileSync(join(target, MANIFEST_FILE), manifestNamed(manifest, wanted));
    const add = runGit(target, ['add', '--', MANIFEST_FILE], options.gitEnv);
    if (!add.ok) throw new Error(`git add failed in ${target}: ${add.output}`);
    const commit = runGit(target, ['commit', '--quiet', '-m', `Name the product ${wanted}`], options.gitEnv);
    if (!commit.ok) throw new Error(`git commit failed in ${target}: ${commit.output}`);
  } catch (error) {
    if (!moved) return { outcome: 'failed', message: `the folder ${folder} could not be renamed to ${target}: ${(error as Error).message}` };
    const back = putRenameBack(target, folder, manifest, options.gitEnv);
    return { outcome: 'failed', message: back === undefined ? (error as Error).message : `${(error as Error).message}; ${back}` };
  }
  return { outcome: 'renamed', folder: target, id: read.product.id, name: wanted };
}

/** How adding a product's remote ended; `origin` is added and never pushed. */
export type RemoteResult =
  | { outcome: 'added'; folder: string; remote: 'origin'; url: string }
  | { outcome: 'refused'; message: string; file?: string; line?: number }
  | { outcome: 'failed'; message: string };

/**
 * Adds `origin` to a product. It never pushes: a product's remote is where its
 * own history is kept, and pushing is the person's decision, taken with the
 * command of their git. An `origin` already there is refused rather than
 * replaced, so a remote someone set is never silently repointed.
 */
export function addRemote(options: { folder?: string; url?: string; gitEnv?: GitEnv } = {}): RemoteResult {
  const read = readFor(options.folder);
  if (!read.ok) return { outcome: 'refused', message: read.message, file: read.file, line: read.line };
  const folder = read.product.folder;

  const wanted = typeof options.url === 'string' ? options.url.trim() : '';
  if (wanted === '')
    return { outcome: 'refused', message: 'no url was given: a remote is added with the url the code repository lives at' };
  if (wanted.startsWith('-'))
    return { outcome: 'refused', message: `the url "${wanted}" begins with "-", which a command line reads as an option: write the url itself` };

  // The remote belongs to the product's own repository: added from a folder
  // that has none of its own, git would add it to the repository around it.
  if (!ownRepository(folder, options.gitEnv))
    return { outcome: 'refused', message: `the folder ${folder} is not a git repository of its own: a product's remote is added to the product's repository, and a command run here would reach the one around it` };
  const remotes = runGit(folder, ['remote'], options.gitEnv);
  if (!remotes.ok) return { outcome: 'failed', message: `git remote failed in ${folder}: ${remotes.output}` };
  if (remotes.output.split('\n').map((line) => line.trim()).includes('origin'))
    return { outcome: 'refused', message: `the folder ${folder} already has the remote "origin": point it at another url deliberately, or remove it first` };

  const add = runGit(folder, ['remote', 'add', 'origin', wanted], options.gitEnv);
  if (!add.ok) return { outcome: 'failed', message: `git remote add failed in ${folder}: ${add.output}` };
  return { outcome: 'added', folder, remote: 'origin', url: wanted };
}

/** One code repository's bootstrap report: cloned now, present and left as it is, or failed with its message. */
export interface RepoReport {
  /** The repository the report is about, as the manifest declares it. */
  name: string;
  /** The url it is cloned from. */
  url: string;
  /** What the step did, or failed to do. */
  state: 'cloned' | 'present' | 'failed';
  /** Uncommitted changes in a checkout left standing: `null` where the state could not be read. */
  dirty: boolean | null;
  /** The failure's own words, set for `failed` and for a present checkout whose state was unreadable. */
  message?: string;
}

/** How cloning what the manifest declares ended; each declared repository carries its own report. */
export type BootstrapResult =
  | { outcome: 'bootstrapped'; folder: string; repos: RepoReport[] }
  | { outcome: 'refused'; message: string; file?: string; line?: number };

/**
 * Clones the code repositories the manifest declares into `repos/<name>`. A
 * checkout already there is never replaced: it is reported, as dirty when it
 * has uncommitted changes, and left as it is — a person's work in it is not
 * this command's to discard. One report per repository, and a repository that
 * could not be cloned is reported too, so the caller sees every outcome of
 * one run.
 */
export function bootstrapProduct(options: { folder?: string; gitEnv?: GitEnv } = {}): BootstrapResult {
  const read = readFor(options.folder);
  if (!read.ok) return { outcome: 'refused', message: read.message, file: read.file, line: read.line };
  const folder = read.product.folder;
  const reposFolder = join(folder, 'repos');
  const reports: RepoReport[] = [];

  for (const repo of read.product.repos) {
    const target = join(reposFolder, repo.name);
    if (existsSync(target)) {
      if (!statSync(target).isDirectory()) {
        reports.push({ name: repo.name, url: repo.url, state: 'failed', dirty: false, message: `${target} is not a folder: a checkout is a folder, and that name is taken by something else` });
        continue;
      }
      // A checkout of its own, or nothing this step can report on: a
      // folder that is no repository would answer `git status` with the
      // repository around it, and its report would be about someone else's
      // work. It is named for what it is and left alone.
      const top = runGit(target, ['rev-parse', '--show-toplevel'], options.gitEnv);
      if (!top.ok || resolve(top.output) !== resolve(target)) {
        reports.push({ name: repo.name, url: repo.url, state: 'failed', dirty: false, message: `${target} is not a git checkout of its own: something else of that name is there, and this program leaves it alone` });
        continue;
      }
      const status = runGit(target, ['status', '--porcelain'], options.gitEnv);
      reports.push({
        name: repo.name,
        url: repo.url,
        state: 'present',
        // Unknown is not clean: a checkout whose state could not be read is
        // reported as it is found, never as one that is up to date.
        dirty: status.ok ? status.output !== '' : null,
        message: status.ok ? undefined : `left alone, and its state could not be read: ${status.output}`,
      });
      continue;
    }
    try {
      mkdirSync(reposFolder, { recursive: true });
    } catch (error) {
      reports.push({ name: repo.name, url: repo.url, state: 'failed', dirty: false, message: `the folder ${reposFolder} could not be created: ${(error as Error).message}` });
      continue;
    }
    const args = ['clone', '--quiet'];
    if (repo.branch !== undefined) args.push('--branch', repo.branch);
    args.push(repo.url, target);
    const clone = runGit(folder, args, options.gitEnv);
    if (!clone.ok)
      reports.push({ name: repo.name, url: repo.url, state: 'failed', dirty: false, message: `git clone failed for ${repo.url} into ${target}: ${clone.output}` });
    else reports.push({ name: repo.name, url: repo.url, state: 'cloned', dirty: false });
  }
  return { outcome: 'bootstrapped', folder, repos: reports };
}

/** Why a code repository may not take a folder name, or null when it may. */
function whyNotARepositoryName(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') return 'a code repository is named by the folder it is cloned into, and this is empty';
  if (name !== name.trim()) return 'a folder name does not begin or end with a space';
  if (name === '.' || name === '..') return 'a folder name is not "." or ".."';
  if (/[/\\]/.test(name)) return 'a folder name is one path segment, and this holds a separator';
  if (/[\u0000-\u001f]/.test(name)) return 'a folder name holds no control character';
  return null;
}

/** How entering one code repository in the manifest ended; the entry is one commit and clones nothing. */
export type RepoEntryResult =
  | { outcome: 'entered'; folder: string; name: string; url: string; branch?: string }
  | { outcome: 'refused'; message: string; file?: string; line?: number }
  | { outcome: 'failed'; message: string };

/**
 * Enters one code repository in the manifest and commits it, as one commit of
 * the product's history: `name`, `url` and the optional `branch` are appended
 * to `repos` and every other byte of the manifest is kept. It never clones;
 * `bootstrapProduct` does. Every refusal — a name that is not a folder name, a name
 * the manifest already declares, a manifest that cannot be read, a folder
 * that is no git repository of its own, and a folder holding uncommitted
 * changes — happens before anything is written, and a step that fails
 * afterwards puts the manifest back byte for byte.
 */
export function addCodeRepository(options: { folder?: string; name?: string; url?: string; branch?: string; gitEnv?: GitEnv } = {}): RepoEntryResult {
  const name = options.name;
  const read = readFor(options.folder);
  if (!read.ok) return { outcome: 'refused', message: read.message, file: read.file, line: read.line };
  const folder = read.product.folder;
  const manifestFile = join(folder, MANIFEST_FILE);

  const why = whyNotARepositoryName(name);
  if (why !== null)
    return { outcome: 'refused', message: `the name "${name}" cannot be a code repository's: ${why}` };

  const wanted = typeof options.url === 'string' ? options.url.trim() : '';
  if (wanted === '')
    return { outcome: 'refused', message: 'no url was given: a code repository is entered with the url it is cloned from' };
  if (wanted.startsWith('-'))
    return { outcome: 'refused', message: `the url "${wanted}" begins with "-", which a command line reads as an option: write the url itself` };
  const wantedBranch = typeof options.branch === 'string' ? options.branch.trim() : undefined;
  if (wantedBranch === '')
    return { outcome: 'refused', message: "the branch was given empty: a clone is taken from the branch it names, and the option is left out where the repository's own is taken" };

  const repoName = name as string;
  const declared = read.product.repos.findIndex((repo) => repo.name === repoName);
  if (declared !== -1) {
    // The line the name stands on, read from the manifest the way the reader
    // reads it: a refusal about a manifest names the place in the manifest.
    const parsed = parseManifest(readFileSync(manifestFile, 'utf8'), manifestFile);
    const items = parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && Array.isArray((parsed.value as Record<string, unknown>).repos)
      ? ((parsed.value as Record<string, unknown>).repos as unknown[])
      : [];
    return {
      outcome: 'refused',
      message: `the manifest ${manifestFile} already declares the code repository "${repoName}": each repository is declared once, and clones into its own folder`,
      file: manifestFile,
      line: items[declared] === undefined ? lineOf(parsed.ok ? parsed.value : {}, 'repos') : lineOf(items[declared], 'name'),
    };
  }

  // The entry belongs to the product's own repository: committed from a
  // folder that has none of its own, it would land in the repository around
  // it, which is someone else's history.
  if (!ownRepository(folder, options.gitEnv))
    return { outcome: 'refused', message: `the folder ${folder} is not a git repository of its own: entering a code repository is one commit of the product's history, and a commit made here would land in the repository around it` };

  const status = runGit(folder, ['status', '--porcelain'], options.gitEnv);
  if (!status.ok) return { outcome: 'failed', message: `git status failed in ${folder}: ${status.output}` };
  if (status.output !== '')
    return { outcome: 'refused', message: `the folder ${folder} holds changes that are not committed: commit them first, since entering a code repository is a commit of its own and would take them with it` };

  const manifest = readFileSync(manifestFile, 'utf8');
  try {
    writeFileSync(manifestFile, manifestWithRepo(manifest, { name: repoName, url: wanted, branch: wantedBranch }));
    const add = runGit(folder, ['add', '--', MANIFEST_FILE], options.gitEnv);
    if (!add.ok) throw new Error(`git add failed in ${folder}: ${add.output}`);
    const commit = runGit(folder, ['commit', '--quiet', '-m', `Enter the code repository ${repoName}`], options.gitEnv);
    if (!commit.ok) throw new Error(`git commit failed in ${folder}: ${commit.output}`);
  } catch (error) {
    // The manifest goes back byte for byte, and out of the index: a step that
    // failed leaves the product exactly as this command found it.
    let left: string | undefined;
    try {
      writeFileSync(manifestFile, manifest);
      runGit(folder, ['reset', '--quiet', '--', MANIFEST_FILE], options.gitEnv);
    } catch (restore) {
      left = `the failed entry left the manifest written: ${(restore as Error).message}`;
    }
    return { outcome: 'failed', message: left === undefined ? (error as Error).message : `${(error as Error).message}; ${left}` };
  }
  return { outcome: 'entered', folder, name: repoName, url: wanted, branch: wantedBranch };
}

/**
 * What a folder is, walking up from it: a product repository, a code
 * repository of one, or neither.
 *
 * A product repository is a git repository of its own holding the manifest,
 * and a code repository is a git repository of its own whose parent is a
 * product's `repos/`: each answers for itself, never the repository around
 * it. The walk therefore ends where a git repository of its own begins, and a
 * folder that is another repository's working tree is neither — a manifest
 * lying inside one is not a product this command can answer for, and neither
 * is a checkout standing outside a product's `repos/`. A manifest the walk
 * meets that cannot be read is refused with its file and line, since the
 * folder it stands over is not one this command can answer for either.
 */
export type WhereResult =
  | { outcome: 'product'; product: string }
  | { outcome: 'code'; product: string; repo: string }
  | { outcome: 'none' }
  | { outcome: 'refused'; message: string; file?: string; line?: number };

export function whereAmI(options: { folder?: string; gitEnv?: GitEnv } = {}): WhereResult {
  const start = resolve(options.folder === undefined ? '.' : options.folder);
  let isFolder = false;
  try {
    isFolder = statSync(start).isDirectory();
  } catch {
    // Not there at all: said below, in the same words.
  }
  if (!isFolder)
    return { outcome: 'refused', message: `the folder ${start} is not a folder: where starts from a folder and walks up` };

  for (let folder = start; ; folder = dirname(folder)) {
    const owns = ownRepository(folder, options.gitEnv);
    if (existsSync(join(folder, MANIFEST_FILE))) {
      const read = readProduct(folder);
      if (!read.ok) return { outcome: 'refused', message: read.message, file: read.file, line: read.line };
      // A product repository is a repository of its own: a manifest standing
      // inside another repository's tree is not one, and the walk ends here.
      if (!owns) return { outcome: 'none' };
      return { outcome: 'product', product: read.product.folder };
    }
    if (owns) {
      if (basename(dirname(folder)) === 'repos') {
        const product = dirname(dirname(folder));
        if (existsSync(join(product, MANIFEST_FILE)) && ownRepository(product, options.gitEnv)) {
          const read = readProduct(product);
          if (!read.ok) return { outcome: 'refused', message: read.message, file: read.file, line: read.line };
          return { outcome: 'code', product: read.product.folder, repo: basename(folder) };
        }
      }
      // A repository of its own that is no product's and no product's code
      // repository: what stands above it belongs to another tree.
      return { outcome: 'none' };
    }
    if (dirname(folder) === folder) return { outcome: 'none' };
  }
}

// ---- the command surface: what each subcommand prints ----------------------

/** How one wrapper call ended: the facts, the errors, and the process's exit code. */
export interface LifecycleOutcome {
  /** The facts, one per line, in the order they are printed. */
  prints: readonly string[];
  /** The errors, one per message, printed whole on standard error. */
  errors: readonly string[];
  /** 0 done, 2 refused, 1 failed. */
  exit: 0 | 1 | 2;
}

const refused2 = (prints: string[], message: string): LifecycleOutcome => ({ prints, errors: [message], exit: 2 });
const failed1 = (prints: string[], message: string): LifecycleOutcome => ({ prints, errors: [message], exit: 1 });
const done = (prints: string[]): LifecycleOutcome => ({ prints, errors: [], exit: 0 });

/**
 * The product folder a command works on: the folder `--product` names, or
 * the where from the working folder — the product the stander is
 * in, their checkout's parent product when they stand in a checkout under
 * its `repos/`, nothing and a refusal otherwise.
 */
export function productFolder(
  given: string | undefined,
  cwd: string,
): { folder: string } | { refused: string } {
  if (given !== undefined && given !== '') return { folder: given };
  const found = whereAmI({ folder: cwd });
  if (found.outcome === 'product' || found.outcome === 'code') return { folder: found.product };
  if (found.outcome === 'refused') return { refused: found.message };
  return {
    refused:
      `no product was found above ${resolve(cwd)}: run the command in a product folder ` +
      'or in a checkout under its repos/, or name the product with --product <folder>',
  };
}

/** The state lines one bootstrap's reports print: what was cloned, what stood and was left as it is, what failed. */
export function reportLines(
  folder: string,
  repos: readonly RepoReport[],
  kind: 'clone' | 'bootstrap',
): { prints: string[]; failures: string[] } {
  void kind;
  const prints: string[] = [];
  const failures: string[] = [];
  for (const repo of repos) {
    const target = join(folder, 'repos', repo.name);
    if (repo.state === 'cloned') prints.push(`cloned: ${target}`);
    else if (repo.state === 'present') {
      // A checkout standing there is never replaced; its person's work shows in the line.
      prints.push(`present: ${target}${repo.dirty === true ? ' (holding uncommitted changes)' : ''}`);
      if (repo.message !== undefined) failures.push(`${repo.name}: ${repo.message}`);
    } else {
      failures.push(repo.message ?? `the repository ${repo.name} could not be cloned from ${repo.url}`);
    }
  }
  return { prints, failures };
}

/** Names a draft in place; the id and every other manifest byte are kept. */
export function renameLife(options: { name?: string; folder?: string; cwd: string }): LifecycleOutcome {
  const place = productFolder(options.folder, options.cwd);
  if ('refused' in place) return refused2([], place.refused);
  const result = renameProduct({ folder: place.folder, name: options.name });
  if (result.outcome === 'renamed') return done([`folder: ${result.folder}`, `id: ${result.id}`, `name: ${result.name}`]);
  if (result.outcome === 'refused') return refused2([], result.message);
  return failed1([], result.message);
}

/** Adds `origin` to the product; it never pushes, and an origin standing there is refused. */
export function remoteLife(options: { url?: string; folder?: string; cwd: string }): LifecycleOutcome {
  const place = productFolder(options.folder, options.cwd);
  if ('refused' in place) return refused2([], place.refused);
  const result = addRemote(options.url === undefined ? { folder: place.folder } : { folder: place.folder, url: options.url });
  if (result.outcome === 'added') {
    return done([
      `folder: ${result.folder}`,
      `remote: ${result.remote}`,
      `url: ${result.url}`,
    ]);
  }
  if (result.outcome === 'refused') return refused2([], result.message);
  return failed1([], result.message);
}

/** Enters one code repository in the manifest, then clones it with the bootstrap step. */
export function repoAddLife(options: {
  name?: string;
  url?: string;
  branch?: string;
  folder?: string;
  cwd: string;
}): LifecycleOutcome {
  const place = productFolder(options.folder, options.cwd);
  if ('refused' in place) return refused2([], place.refused);
  const urlGiven = options.url;
  if (urlGiven === undefined) return refused2([], 'no url was given: a code repository is entered with the url it is cloned from');
  const entered = addCodeRepository({
    folder: place.folder,
    ...(options.name === undefined ? {} : { name: options.name }),
    url: urlGiven,
    ...(options.branch === undefined ? {} : { branch: options.branch }),
  });
  if (entered.outcome === 'refused') return refused2([`folder: ${options.folder ?? resolve(options.cwd)}`], entered.message);
  if (entered.outcome === 'failed') return failed1([`folder: ${place.folder}`], entered.message);
  const prints = [`folder: ${entered.folder}`, `repo: ${entered.name}`, `url: ${entered.url}`];
  if (entered.branch !== undefined) prints.push(`branch: ${entered.branch}`);
  const bootstrapped = bootstrapProduct({ folder: place.folder });
  if (bootstrapped.outcome === 'refused') return refused2(prints, bootstrapped.message);
  const reported = reportLines(entered.folder, bootstrapped.repos, 'clone');
  return withFailures([...prints, ...reported.prints], reported.failures);
}

/** Clones what the manifest declares; a checkout standing there is left as it is and named. */
export function bootstrapLife(options: { folder?: string; cwd: string }): LifecycleOutcome {
  const place = productFolder(options.folder, options.cwd);
  if ('refused' in place) return refused2([], place.refused);
  const result = bootstrapProduct({ folder: place.folder });
  if (result.outcome === 'refused') return refused2([], result.message);
  const reported = reportLines(result.folder, result.repos, 'bootstrap');
  // Nothing declared is no facts at all: an empty home reads the same way.
  const prints = result.repos.length === 0 ? [] : [`folder: ${result.folder}`, ...reported.prints];
  return withFailures(prints, reported.failures);
}

/** 0 while nobody failed; a failed report is the step's failure, and its name was still given. */
export function withFailures(prints: string[], failures: readonly string[]): LifecycleOutcome {
  if (failures.length === 0) return done(prints);
  return { prints, errors: [...failures], exit: 1 };
}

/**
 * Clones a pushed product repository into the products home, bootstraps it,
 * and names the way to its wiki: how a second engineer joins. The folder
 * carries the url's name (the `.git` suffix off); the product's id and name
 * come from its manifest, and a url that is no product repository is
 * refused with the reader's words, its folder left behind nowhere: the
 * working copy the clone made is removed, the way a refused draft leaves
 * nothing behind.
 */
export function cloneLife(options: { url?: string; home?: string; env: DraftEnv }): LifecycleOutcome {
  const wanted = options.url?.trim() ?? '';
  if (wanted === '' ) return refused2([], 'no url was given: a product is cloned from the repository it is pushed to');
  if (wanted.startsWith('-')) return refused2([], `the url "${wanted}" begins with "-", which a command line reads as an option: write the url itself`);
  const home = productsHome(options.env, options.home);
  if (existsSync(home) && !statSync(home).isDirectory()) return refused2([], `the products home ${home} is a file, not a folder: the clone goes under the home`);
  const name = folderNameOf(wanted);
  if (name === '') return refused2([], `the url "${wanted}" names no folder: its last path segment is the product's folder`);
  const target = join(home, name);
  if (existsSync(target)) {
    return refused2([], `the folder ${target} is in the way: a product's name is the folder it lives in, and that name is taken`);
  }
  mkdirSync(home, { recursive: true });
  const clone = spawnSync('git', ['clone', '--quiet', wanted, target], { encoding: 'utf8' });
  if (clone.status !== 0) {
    // A refused clone leaves nothing: git's own partial copies are cleared.
    rmSync(target, { recursive: true, force: true });
    return failed1([], `git clone failed for ${wanted} into ${target}: ${(clone.stderr || clone.stdout || '').trim()}`);
  }
  const read = readProduct(target);
  if (!read.ok) {
    rmSync(target, { recursive: true, force: true });
    return refused2([], read.message);
  }
  const prints = [`folder: ${target}`, `id: ${read.product.id}`, `name: ${read.product.name}`];
  if (read.product.repos.length > 0) {
    const bootstrapped = bootstrapProduct({ folder: target });
    if (bootstrapped.outcome === 'refused') {
      // A refused clone leaves nothing behind, whoever refused: the folder was
      // this command's to make, so it is this command's to take away.
      rmSync(target, { recursive: true, force: true });
      return refused2([], bootstrapped.message);
    }
    const reported = reportLines(target, bootstrapped.repos, 'clone');
    const withReports = withFailures([...prints, ...reported.prints, `wiki: madarch serve --product ${target}`], reported.failures);
    return { ...withReports, exit: withReports.exit };
  }
  return { ...done([...prints, `wiki: madarch serve --product ${target}`]) };
}

/** The folder name a url stands for: its last segment, a trailing `.git` off, slashes trimmed. */
export function folderNameOf(url: string): string {
  const withoutFileScheme = url.replace(/\/+$/, '');
  const last = withoutFileScheme.slice(withoutFileScheme.lastIndexOf('/') + 1);
  return last.endsWith('.git') ? last.slice(0, -'.git'.length) : last;
}
