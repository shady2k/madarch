/**
 * The live reader of a repository's Git history: the default branch's first-parent
 * line with the effective times of decision 0028. It was the extract driver's
 * walker (`src/extract/driver/git.ts`) and stayed when that driver went, because
 * the history landmarks a product's pages offer are read from it (madarch-8bdc.1.3).
 * Everything runs through `execFileSync` with `TZ=UTC` and `LC_ALL=C`, so the
 * machine's settings cannot change what is read (0023: git is the truth).
 */
import { execFileSync } from 'node:child_process';
import { plusMicrosecond } from '../graph/index.js';

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
    throw new Error(`history walk: git ${args.join(' ')} failed in ${repository}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function runGitText(repository: string, args: readonly string[]): string {
  return runGit(repository, args).toString('utf8');
}

const GIT_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** Canonical UTC instant text (microseconds, `Z`) of git's ISO-8601 output. */
function canonicalInstant(text: string, where: string): string {
  const match = GIT_INSTANT.exec(text.trim());
  if (match === null || match[1] === undefined || match[3] === undefined) throw new Error(`history walk: ${where}: ${JSON.stringify(text)} is not an ISO-8601 instant git would print`);
  const fraction = (match[2] ?? '').padEnd(6, '0').slice(0, 6);
  const offset = match[3];
  if (offset === 'Z') return `${match[1]}.${fraction}Z`;
  const shifted = new Date(`${match[1]}.${fraction.slice(0, 3)}Z`);
  if (Number.isNaN(shifted.getTime())) throw new Error(`history walk: ${where}: ${JSON.stringify(text)} is not a calendar instant`);
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
    if (parts.length !== 8) throw new Error(`history walk: ${repository}: git log record ${index} has ${parts.length} fields, expected 8: ${JSON.stringify(record.slice(0, 200))}`);
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
  if (commits.length === 0) throw new Error(`history walk: ${repository}: the default branch (${ref}) holds no commit`);
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
    if (at + paths >= tokens.length) throw new Error(`history walk: ${repository}: git log of commit ${commit} ends inside the entry ${JSON.stringify(status)}`);
    if (status.startsWith('R')) renames.push({ from: tokens[at + 1]!, to: tokens[at + 2]! });
    at += 1 + paths;
  }
  return renames;
}

