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
 * commit's effective time. The walk is a pure reading of the repository: the
 * same history gives the same facts in every run, and a generation number is
 * a commit's place on the line, so a refill plans the same generations.
 */
export function walkDefaultBranch(repository: string, ref = 'HEAD'): CommitFact[] {
  const out = runGitText(repository, ['log', ref, '--first-parent', '--reverse', '--format=%H%x00%P%x00%T%x00%cI%x00%aI%x00%an%x00%s']);
  const commits: CommitFact[] = [];
  let previousEffective: string | undefined;
  for (const [index, line] of out.split('\n').entries()) {
    if (line === '') continue;
    const parts = line.split('\0');
    if (parts.length !== 7) throw new Error(`extract driver: ${repository}: git log line ${index + 1} has ${parts.length} fields, expected 7: ${JSON.stringify(line)}`);
    const [hash, parents, tree, committer, author, authorName, subject] = parts as [string, string, string, string, string, string, string];
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
      renames: firstParent === '' ? [] : renamesOf(repository, firstParent, hash),
    });
    previousEffective = effective;
  }
  if (commits.length === 0) throw new Error(`extract driver: ${repository}: the default branch (${ref}) holds no commit`);
  return commits;
}

/** The renames git detects between a commit and its first parent, `-M`, any score. */
function renamesOf(repository: string, parent: string, commit: string): { from: string; to: string }[] {
  const out = runGitText(repository, ['diff-tree', '-M', '-r', '--no-commit-id', '--name-status', parent, commit]);
  const renames: { from: string; to: string }[] = [];
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const fields = line.split('\t');
    if (fields.length === 3 && fields[0]!.startsWith('R')) renames.push({ from: fields[1]!, to: fields[2]! });
  }
  return renames;
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
