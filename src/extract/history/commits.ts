/**
 * The commit records of the history extractor: `code.commit` nodes with their
 * raw times and decision 0028's effective time, the first-parent line they
 * stand on, the merge and the branch commits it makes valid at the merge, the
 * authors, the parent edges and the task keys the subjects carry.
 */
import {byCodePoint} from '../../model/order.js';
import type {ExtractedEdge, ExtractedNode} from '../records.js';
import type {LogEntry} from './git.js';
import {isoMicros, isoSeconds} from './time.js';

/** A commit's node key: `code.commit:<id>`. */
export function commitKey(commit: string): string {
  return `code.commit:${commit}`;
}

/** An author's node key: `code.author:<name>`, its spaces read as dashes, no key holds a space. */
export function authorKey(name: string): string {
  return `code.author:${name.replace(/\s+/gu, '-')}`;
}

/** A task key's node key: `code.task:<key>`. */
export function taskKeyNode(key: string): string {
  return `code.task:${key}`;
}

/** One commit of the walk with the computed facts the records carry. */
export interface CommitRecord {
  readonly entry: LogEntry;
  readonly key: string;
  /** True when the commit stands on the default branch's first-parent line. */
  readonly onFirstParent: boolean;
  /** True when the commit has two or more parents. */
  readonly merge: boolean;
  /** The branch a merge commit brought in, read from its subject (`Merge branch 'x'` or `Merge x: ...`). */
  readonly mergedBranch?: string;
  /** Decision 0028's effective time of the commit, ISO 8601 with `Z`. */
  readonly effectiveAt: string;
}

/** A merge subject's own branch name, where the subject carries one. */
const MERGED_BRANCH = /\bMerge (?:branch '([^']+)'|([^\s:]+):)/u;

/** The task key a subject carries at its head (`OPS-171 ...`), where it carries one. */
const TASK_KEY = /^([A-Z][A-Z0-9]*-[0-9]+)\b/u;

/** Reads a merge subject's branch name; `undefined` where the subject names none. */
function mergedBranchOf(subject: string): string | undefined {
  const match = MERGED_BRANCH.exec(subject);
  const branch = match?.[1] ?? match?.[2];
  return branch === undefined || branch === '' ? undefined : branch;
}

/** The task keys of one subject, each once, in code point order. */
export function taskKeysOf(subject: string): string[] {
  const match = TASK_KEY.exec(subject);
  return match?.[1] === undefined ? [] : [match[1]];
}

/**
 * The subject a reader sees: the task key a message carries at its head
 * (`OPS-171 Run every service's checks in CI`) is a record of its own, and the
 * subject the commit node carries is the words behind it.
 */
export function subjectWithoutTaskKey(subject: string): string {
  return subject.replace(/^[A-Z][A-Z0-9]*-[0-9]+\s+/u, '');
}

/**
 * The commits of the two walks as records. The first-parent line is walked
 * oldest first: each commit's effective time is its committer time where that
 * is later than its parent's effective time, and its parent's effective time
 * plus one microsecond where it is not (decision 0028), so two commits of the
 * line never share an instant. A commit off the line is valid at the merge
 * that brought its branch in, and keeps its own raw times.
 *
 * Every commit of the whole walk must be either on the line or inside a
 * merged branch: a commit the records could not place is thrown, never
 * dropped.
 */
export function commitRecords(line: readonly LogEntry[], all: readonly LogEntry[]): {
  readonly nodes: ExtractedNode[];
  readonly edges: ExtractedEdge[];
  readonly commits: ReadonlyMap<string, CommitRecord>;
} {
  const where = 'the history extractor reads the commits';
  const lineSet = new Set(line.map((entry) => entry.commit));
  const ofAll = new Map(all.map((entry) => [entry.commit, entry]));
  for (const entry of line) {
    if (!ofAll.has(entry.commit)) throw new Error(`${where}: the first-parent line holds ${entry.commit}, which the walk of the whole branch does not reach`);
  }

  // The first-parent line itself, chained from the branch's tip through each
  // commit's first parent: git's own listing order is the order of commit
  // dates, and a commit whose committer date stands before its parent's (the
  // anomaly decision 0028 names) would break the chain were it trusted.
  const byCommit = new Map(line.map((entry) => [entry.commit, entry]));
  const tip = line[0];
  if (tip === undefined) throw new Error(`${where}: the first-parent walk lists no commit`);
  const chain: LogEntry[] = [];
  const chained = new Set<string>();
  for (let cursor: string | undefined = tip.commit; cursor !== undefined;) {
    const entry = byCommit.get(cursor);
    if (entry === undefined) throw new Error(`${where}: the first-parent walk lists no ${cursor}, which the chain from the tip reaches`);
    if (chained.has(cursor)) throw new Error(`${where}: the first-parent chain of ${tip.commit} reaches ${cursor} twice`);
    chained.add(cursor);
    chain.push(entry);
    cursor = entry.parents[0];
  }
  if (chained.size !== line.length) {
    throw new Error(`${where}: the first-parent walk lists ${line.length} commits, of which ${line.length - chained.size} stand off the chain from the tip ${tip.commit}`);
  }

  // The effective times of the line, oldest first.
  const effective = new Map<string, string>();
  let previous = Number.NEGATIVE_INFINITY;
  const oldestFirst = [...chain].reverse();
  for (const entry of oldestFirst) {
    const raw = entry.committedAt * 1_000_000;
    const at = raw > previous ? raw : previous + 1;
    previous = at;
    effective.set(entry.commit, isoMicros(at));
  }

  // The parents of every commit, for walking a merged branch's ancestry.
  const parentsOf = new Map(all.map((entry) => [entry.commit, entry.parents]));
  const mergedInto = new Map<string, string>();
  for (const entry of oldestFirst) {
    if (entry.parents.length < 2) continue;
    const mergeEffective = effective.get(entry.commit);
    if (mergeEffective === undefined) throw new Error(`${where}: the merge ${entry.commit} stands nowhere on the first-parent line`);
    for (const branchParent of entry.parents.slice(1)) {
      const stack = [branchParent];
      while (stack.length > 0) {
        const sha = stack.pop();
        if (sha === undefined || lineSet.has(sha) || mergedInto.has(sha)) continue;
        mergedInto.set(sha, entry.commit);
        const parents = parentsOf.get(sha);
        if (parents === undefined) {
          throw new Error(`${where}: the commit ${sha} is a parent of a merge the walk of the whole branch does not reach`);
        }
        stack.push(...parents);
      }
    }
  }
  for (const entry of all) {
    if (lineSet.has(entry.commit) || mergedInto.has(entry.commit)) continue;
    throw new Error(`${where}: the commit ${entry.commit} (${entry.subject}) is reachable from the default branch but stands neither on its first-parent line nor in a branch a merge brought in`);
  }

  const nodes: ExtractedNode[] = [];
  const edges: ExtractedEdge[] = [];
  const commits = new Map<string, CommitRecord>();
  for (const entry of all) {
    const onLine = lineSet.has(entry.commit);
    const merge = entry.parents.length >= 2;
    const at = onLine ? effective.get(entry.commit) : undefined;
    const mergeOf = mergedInto.get(entry.commit);
    if (at === undefined && mergeOf === undefined) {
      throw new Error(`${where}: the commit ${entry.commit} (${entry.subject}) has no effective time`);
    }
    const effectiveAt = at ?? effective.get(mergeOf ?? '');
    if (effectiveAt === undefined) {
      throw new Error(`${where}: the merge that brought in ${entry.commit} has no effective time`);
    }
    const mergedBranch = merge ? mergedBranchOf(entry.subject) : undefined;
    commits.set(entry.commit, {
      entry,
      key: commitKey(entry.commit),
      onFirstParent: onLine,
      merge,
      ...(mergedBranch === undefined ? {} : {mergedBranch}),
      effectiveAt,
    });

    nodes.push({
      key: commitKey(entry.commit),
      kind: 'code.commit',
      label: subjectWithoutTaskKey(entry.subject),
      properties: {
        subject: subjectWithoutTaskKey(entry.subject),
        committedAt: isoSeconds(entry.committedAt),
        authoredAt: isoSeconds(entry.authoredAt),
        effectiveAt,
        onFirstParent: onLine,
        merge,
        ...(mergedBranch === undefined ? {} : {mergedBranch}),
      },
    });
    for (const [position, parent] of entry.parents.entries()) {
      if (!ofAll.has(parent)) {
        throw new Error(`${where}: the parent ${parent} of ${entry.commit} is not one of the commits the walk of the whole branch reached`);
      }
      edges.push({type: 'code.parent', from: commitKey(entry.commit), to: commitKey(parent), discriminator: '', properties: {position: position + 1}});
    }
    edges.push({type: 'code.authored', from: authorKey(entry.author), to: commitKey(entry.commit), discriminator: '', properties: {}});
    for (const task of taskKeysOf(entry.subject)) {
      edges.push({type: 'code.tasks', from: commitKey(entry.commit), to: taskKeyNode(task), discriminator: '', properties: {}});
    }
  }

  // The authors and the task keys, each once.
  for (const name of new Set(all.map((entry) => entry.author))) {
    nodes.push({key: authorKey(name), kind: 'code.author', label: name, properties: {}});
  }
  for (const key of new Set(all.flatMap((entry) => taskKeysOf(entry.subject)))) {
    nodes.push({key: taskKeyNode(key), kind: 'code.task', label: key, properties: {}});
  }

  nodes.sort((left, right) => byCodePoint(left.key, right.key));
  edges.sort(edgeOrder);
  return {nodes, edges, commits};
}

/** The order of the records' edges: type, both ends, then the discriminator. */
function edgeOrder(left: ExtractedEdge, right: ExtractedEdge): number {
  return byCodePoint(left.type, right.type) || byCodePoint(left.from, right.from) || byCodePoint(left.to, right.to) || byCodePoint(left.discriminator, right.discriminator);
}
