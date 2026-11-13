/**
 * The private copy a plugin runs from (decision 0035, item 4): the closure's
 * files are copied into a folder of the run's own, the copy is hashed again,
 * and a copy whose bytes moved is refused before anything executes. The plugin
 * therefore never sees the product's working tree, and a change made to it
 * between the hash and the run fails the run instead of reaching the plugin.
 *
 * Only a closure a madarch release carries runs without approval; any other
 * waits for a person to approve its hash. Until then it may run as validation
 * — the conformance kit — and publishes nothing.
 */
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { byCodePoint } from '../model/order.js';
import { closureHashOf, ClosureRefusal, type Closure, type ClosureFile } from './closure.js';
import { RELEASE_CLOSURE_HASHES } from './release-closures.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Where a refusal stands. */
const WHERE = 'src/plugin/snapshot.ts';

/** The folders a snapshot lives in, and the hash it was made for. */
export interface ClosureSnapshot {
  /** The private copy the plugin executes from. */
  readonly folder: string;
  /** The hash the closure was read at, and the copy is held to. */
  readonly hash: string;
}

/** Every file of a folder, by the same rule the closure reads: relative path, code point order, no links. */
function filesUnder(folder: string): ClosureFile[] {
  const files: ClosureFile[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort(byCodePoint)) {
      const file = join(dir, name);
      const stat = statSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) {
        files.push({ path: relative(folder, file).split(sep).join('/'), sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), bytes: stat.size, mode: stat.mode & 0o777 });
      }
    }
  };
  visit(folder);
  return files.sort((left, right) => byCodePoint(left.path, right.path));
}

/** The first difference between a closure and its copy, as the sentence a refusal carries. */
function differenceBetween(expected: readonly ClosureFile[], found: readonly ClosureFile[]): string | undefined {
  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  for (const file of found) {
    const declared = expectedByPath.get(file.path);
    if (declared === undefined) return `${file.path} stands in the copy and not in the closure that was hashed`;
    if (declared.sha256 !== file.sha256) return `${file.path} holds other bytes than the closure that was hashed (${declared.sha256} became ${file.sha256})`;
    expectedByPath.delete(file.path);
  }
  const missing = [...expectedByPath.keys()].sort(byCodePoint)[0];
  return missing === undefined ? undefined : `${missing} stands in the closure that was hashed and not in the copy`;
}

/**
 * Copies a closure into a fresh private folder and proves the copy is the
 * closure: every file, its bytes and its mode, and the one hash over them.
 * A copy that differs — a file changed between the two readings, added or
 * removed — is refused with the first difference named, and the copy removed.
 */
export async function snapshotClosure(closure: Closure, parent: string, name?: string): Promise<ClosureSnapshot> {
  mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(join(parent, name === undefined ? 'closure-' : `${name}-`));
  try {
    const directories = new Set<string>();
    for (const file of closure.files) {
      const target = join(folder, file.path);
      const directory = dirname(target);
      if (!directories.has(directory)) {
        mkdirSync(directory, { recursive: true });
        directories.add(directory);
      }
      if (file.content === undefined) copyFileSync(join(closure.folder, file.path), target);
      else writeFileSync(target, file.content);
      chmodSync(target, file.mode);
    }
    const copied = filesUnder(folder);
    const difference = differenceBetween(closure.files, copied);
    if (difference !== undefined) {
      throw new ClosureRefusal('closure-changed', `${WHERE}:1: the closure ${closure.folder} changed after it was hashed: ${difference}. A run executes only the snapshot of the closure it hashed; hash the plugin folder again once its files are settled`, join(closure.folder, difference.split(' ')[0]!));
    }
    const hash = closureHashOf(copied);
    if (hash !== closure.hash) {
      throw new ClosureRefusal('closure-changed', `${WHERE}:1: the copy of the closure hashes to ${hash}, and the closure was hashed as ${closure.hash}: a run executes only the snapshot of the closure it hashed`, folder);
    }
    return { folder, hash };
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

/** Whether a closure is one a release carries, by its hash. */
export function isReleaseClosure(hash: string, releaseHashes: readonly string[] = RELEASE_CLOSURE_HASHES): boolean {
  return releaseHashes.includes(hash);
}

/** Whether a closure may run here: a release closure, or any closure as validation that publishes nothing. */
export type ClosureTrust = 'production' | 'validation';

/** The refusal of a closure nothing may run yet, or undefined when it may run. */
export function closureTrustProblem(closure: Closure, trust: ClosureTrust, file: string, releaseHashes: readonly string[] = RELEASE_CLOSURE_HASHES): ClosureRefusal | undefined {
  if (trust === 'validation' || isReleaseClosure(closure.hash, releaseHashes)) return undefined;
  return new ClosureRefusal('needs-approval', `${file}:1: the plugin closure ${closure.hash} is not one a madarch release carries: it needs approval. Until a person approves this hash the plugin runs only as validation (madarch plugin check), publishing nothing`, file);
}
