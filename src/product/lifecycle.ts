/**
 * The product lifecycle on the `madarch` command: rename, remote, repo add,
 * bootstrap and clone (feature madarch-525o; the lifecycle itself is the
 * skill set's product-repository program, decision 0019). This module is the
 * wrapper the other subcommands share: it decides only what is madarch's
 * own — which folder the command names when run without `--product` (the
 * program's where, walking up from the working folder), the products home
 * of `clone`, which facts each outcome prints and to which stream, and the
 * exit code — and hands every refusal, failure and repository layout
 * question to the pinned program, whose messages are printed whole.
 *
 * The exit codes follow the command's other subcommands: 0 done, 2 refused
 * (an argument, a folder, a manifest or a name that cannot be used), 1
 * failed (a git step refused, or a declared repository the program could
 * not clone). Facts go to standard output one per line; errors go to
 * standard error, one message per error, whole.
 */
import {
  addCodeRepository,
  addRemote,
  bootstrapProduct,
  renameProduct,
  whereAmI,
} from './program.js';
import type {
  ProgramRepoReport,
} from './program.js';
import { readProduct } from './manifest.js';
import { productsHome, type DraftEnv } from './draft.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
 * the program's where from the working folder — the product the stander is
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
  repos: readonly ProgramRepoReport[],
  kind: 'clone' | 'bootstrap',
): { prints: string[]; failures: string[] } {
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

/** Enters one code repository in the manifest, then clones it with the program's bootstrap. */
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
    if (bootstrapped.outcome === 'refused') return refused2(prints, bootstrapped.message);
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

