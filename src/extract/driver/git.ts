/**
 * The driver's view of a git repository: the default branch's first-parent
 * history with the effective times of decision 0028, and one tree as a
 * `TreeReader` (src/extract/records.ts), read with `git ls-tree -r` and
 * `git cat-file --batch` and no checkout. Everything runs through
 * `execFileSync` with `TZ=UTC` and `LC_ALL=C`, so the machine's settings
 * cannot change what is read (0023: git is the truth).
 */
import { execFileSync } from 'node:child_process';
import type { TreeReader } from '../records.js';
import { plusMicrosecond } from '../../graph/index.js';

/** One commit of the default branch's first-parent line, oldest first. */
export interface CommitFact {
  readonly hash: string;
  /** The first parent's hash; empty for the root commit. */
  readonly firstParent: string;
  /** The commit's tree object. */
  readonly tree: string;
  /** The raw committer time, canonical UTC text: what the graph keeps on the commit node. */
  readonly committerTime: string;
  /** The raw author time, canonical UTC text. */
  readonly authorTime: string;
  readonly authorName: string;
  readonly subject: string;
  /**
   * The commit's effective time (0028, "Time"): its committer time, or its
   * parent's effective time plus one microsecond when that is not later, so
   * effective time is strictly increasing along the first-parent line.
   */
  readonly effectiveTime: string;
  /** The commit's place on the first-parent line, 1 for the root. */
  readonly generation: number;
  /** The renames git detects against the first parent (`-M`, any score): old path first. */
  readonly renames: readonly { readonly from: string; readonly to: string }[];
}

/** Runs git once, with the environment the readings depend on; a failure names the repository and what was asked. */
function runGit(repository: string, args: readonly string[], input?: Buffer, maxBuffer = 1 << 28): Buffer {
  try {
    return execFileSync('git', args, { cwd: repository, input, maxBuffer, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
  } catch (error) {
    throw new Error(`extract driver: git ${args.join(' ')} failed in ${repository}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function runGitText(repository: string, args: readonly string[]): string {
  return runGit(repository, args).toString('utf8');
}

const GIT_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** Canonical UTC instant text (microseconds, `Z`) of git's ISO-8601 output. */
export function canonicalInstant(text: string, where: string): string {
  const match = GIT_INSTANT.exec(text.trim());
  if (match === null || match[1] === undefined || match[3] === undefined) throw new Error(`extract driver: ${where}: ${JSON.stringify(text)} is not an ISO-8601 instant git would print`);
  const fraction = (match[2] ?? '').padEnd(6, '0').slice(0, 6);
  const offset = match[3];
  if (offset === 'Z') return `${match[1]}.${fraction}Z`;
  const shifted = new Date(`${match[1]}.${fraction.slice(0, 3)}Z`);
  if (Number.isNaN(shifted.getTime())) throw new Error(`extract driver: ${where}: ${JSON.stringify(text)} is not a calendar instant`);
  const sign = offset[0] === '-' ? -1 : 1;
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  shifted.setUTCMinutes(shifted.getUTCMinutes() + minutes);
  return `${shifted.toISOString().slice(0, 19)}.${fraction}Z`;
}

/**
 * The default branch's first-parent history, oldest first, with each
 * commit's effective time. One `git log` answers the whole line, its renames
 * included (`-M --name-status -z`, a merge shown against its first parent), so
 * thousands of commits cost one process, not one per commit. The walk is a
 * pure reading of the repository: the same history gives the same facts in
 * every run, and a generation number is a commit's place on the line, so a
 * refill plans the same generations.
 */
export function walkDefaultBranch(repository: string, ref = 'HEAD'): CommitFact[] {
  const out = runGit(repository, ['log', ref, '--first-parent', '--reverse', '-M', '--name-status', '-z', '--format=%x1e%H%x1f%P%x1f%T%x1f%cI%x1f%aI%x1f%an%x1f%s%x1f']).toString('utf8');
  const commits: CommitFact[] = [];
  let previousEffective: string | undefined;
  for (const [index, record] of out.split('\x1e').entries()) {
    if (record === '') continue;
    const parts = record.split('\x1f');
    if (parts.length !== 8) throw new Error(`extract driver: ${repository}: git log record ${index} has ${parts.length} fields, expected 8: ${JSON.stringify(record.slice(0, 200))}`);
    const [hash, parents, tree, committer, author, authorName, subject, changes] = parts as [string, string, string, string, string, string, string, string];
    const raw = canonicalInstant(committer, `commit ${hash} of ${repository}`);
    const firstParent = parents.split(' ')[0] ?? '';
    const effective = previousEffective === undefined || previousEffective < raw ? raw : plusMicrosecond(previousEffective);
    commits.push({
      hash,
      firstParent,
      tree,
      committerTime: raw,
      authorTime: canonicalInstant(author, `commit ${hash} of ${repository}`),
      authorName,
      subject,
      effectiveTime: effective,
      generation: commits.length + 1,
      renames: firstParent === '' ? [] : renamesOf(changes, repository, hash),
    });
    previousEffective = effective;
  }
  if (commits.length === 0) throw new Error(`extract driver: ${repository}: the default branch (${ref}) holds no commit`);
  return commits;
}

/** The renames in one commit's `--name-status -z` entries: a status token, then one path (two for a rename or copy), each ended by a NUL. */
function renamesOf(entries: string, repository: string, commit: string): { from: string; to: string }[] {
  const tokens = entries.split('\0');
  const renames: { from: string; to: string }[] = [];
  for (let at = 0; at < tokens.length; ) {
    const status = tokens[at]!.replace(/^\n/, '');
    if (status === '') {
      at += 1;
      continue;
    }
    const paths = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    if (at + paths >= tokens.length) throw new Error(`extract driver: ${repository}: git log of commit ${commit} ends inside the entry ${JSON.stringify(status)}`);
    if (status.startsWith('R')) renames.push({ from: tokens[at + 1]!, to: tokens[at + 2]! });
    at += 1 + paths;
  }
  return renames;
}

/** A point the caller chose: a revision (a tag, a commit, a branch) or the latest commit at or before a date. */
export type FillPoint = string | { readonly date: string };

/**
 * The commit of the first-parent walk a chosen point names. A revision must
 * resolve in the repository and stand on the walk's first-parent line; a date
 * is read as an instant and names the last commit whose effective time is not
 * later. A point that names no commit is an error naming the repository and
 * the point, never a smaller fill.
 */
export function resolvePoint(repository: string, walk: readonly CommitFact[], point: FillPoint): CommitFact {
  if (typeof point !== 'string') {
    const instant = canonicalInstant(point.date, `the point ${JSON.stringify(point)} of ${repository}`);
    let found: CommitFact | undefined;
    for (const commit of walk) if (commit.effectiveTime <= instant) found = commit;
    if (found === undefined) throw new Error(`extract driver: ${repository}: the point date ${point.date} is before the first commit (${walk[0]!.effectiveTime}), so no snapshot can be read at it`);
    return found;
  }
  if (point === '' || point.startsWith('-') || /\s/.test(point)) throw new Error(`extract driver: ${repository}: ${JSON.stringify(point)} is no revision to read a snapshot at`);
  const hash = runGitText(repository, ['rev-parse', '--verify', `${point}^{commit}`]).trim();
  const found = walk.find((commit) => commit.hash === hash);
  if (found === undefined) throw new Error(`extract driver: ${repository}: the point ${JSON.stringify(point)} is commit ${hash}, which does not stand on the first-parent line of the walk, so it has no effective time to read a snapshot at`);
  return found;
}

/** One tree of a commit as a `TreeReader`: paths in code point order, bytes on demand, no checkout. */
export function commitTree(repository: string, commit: string): TreeReader {
  const out = runGitText(repository, ['ls-tree', '-r', '-z', commit]);
  const paths: string[] = [];
  const blobOf = new Map<string, string>();
  for (const entry of out.split('\0')) {
    if (entry === '') continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new Error(`extract driver: ${repository}: git ls-tree of ${commit} printed a line without a path: ${JSON.stringify(entry)}`);
    const [mode, type, sha] = entry.slice(0, tab).split(' ');
    const filePath = entry.slice(tab + 1);
    if (type !== 'blob') continue; // a gitlink names a commit of another repository; it has no bytes here
    if (mode === undefined || sha === undefined) throw new Error(`extract driver: ${repository}: git ls-tree of ${commit} printed a line without a blob: ${JSON.stringify(entry)}`);
    paths.push(filePath);
    blobOf.set(filePath, sha);
  }
  paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  let bytes: Map<string, Uint8Array> | undefined;
  const readAll = (): Map<string, Uint8Array> => {
    const shas = [...new Set([...blobOf.values()])];
    if (shas.length === 0) return new Map();
    const asked = runGit(repository, ['cat-file', '--batch'], Buffer.from(`${shas.join('\n')}\n`, 'utf8'));
    const read = new Map<string, Uint8Array>();
    let at = 0;
    for (const sha of shas) {
      const headerEnd = asked.indexOf(0x0a, at);
      if (headerEnd < 0) throw new Error(`extract driver: ${repository}: git cat-file --batch of ${commit} ended before the header of ${sha}`);
      const header = asked.subarray(at, headerEnd).toString('utf8');
      const [echoed, type, sizeText] = header.split(' ');
      if (echoed !== sha || type === undefined || sizeText === undefined || Number.isNaN(Number(sizeText))) {
        throw new Error(`extract driver: ${repository}: git cat-file --batch of ${commit} answered ${JSON.stringify(header)} where ${sha}'s header was expected`);
      }
      const size = Number(sizeText);
      at = headerEnd + 1;
      if (at + size + 1 > asked.length) throw new Error(`extract driver: ${repository}: git cat-file --batch of ${commit} ended inside the bytes of ${sha}`);
      read.set(sha, new Uint8Array(asked.subarray(at, at + size)));
      at += size + 1;
    }
    return read;
  };
  return {
    paths,
    read(filePath: string): Uint8Array {
      if (bytes === undefined) bytes = readAll();
      const sha = blobOf.get(filePath);
      if (sha === undefined) throw new Error(`extract driver: ${repository}: the tree of ${commit} holds no ${JSON.stringify(filePath)}`);
      const held = bytes.get(sha);
      if (held === undefined) throw new Error(`extract driver: ${repository}: the tree of ${commit} holds ${JSON.stringify(filePath)} but its bytes were not read`);
      return held;
    },
  };
}
