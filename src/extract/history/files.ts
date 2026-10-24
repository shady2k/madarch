/**
 * The file records of the history extractor: `code.file` nodes with the
 * commits that changed them (a rename keeping one identity, so the history of
 * the path a file left belongs to the path it took), the `code.touched` edges
 * of every non-merge commit, the `code.renamed-to` identity-keeping edges, the
 * `code.changed-with` pairs with their support, and what every pinned snapshot
 * holds, blob by blob, with the line counts of the default branch's tip.
 */
import {byCodePoint} from '../../model/order.js';
import type {ExtractedEdge, ExtractedNode, ExtractionGap} from '../records.js';
import type {LogEntry, TreeEntry} from './git.js';
import {listTree, readBlob, readNumstat, resolveCommit} from './git.js';
import {commitKey, edgeOrder, type CommitRecord} from './commits.js';

/** A file's node key: `code.file:<path>`. */
export function fileKey(path: string): string {
  return `code.file:${path}`;
}

/** A snapshot's node key: `code.snapshot:<name>`. */
export function snapshotKey(name: string): string {
  return `code.snapshot:${name}`;
}

/** A union-find over paths: one find per call, with the smaller root kept, so a run's identities are run-independent. */
class Identities {
  private readonly parent = new Map<string, string>();

  add(path: string): void {
    if (!this.parent.has(path)) this.parent.set(path, path);
  }

  join(one: string, other: string): void {
    this.add(one);
    this.add(other);
    const left = this.find(one);
    const right = this.find(other);
    if (left === right) return;
    const [kept, gone] = byCodePoint(left, right) <= 0 ? [left, right] : [right, left];
    this.parent.set(gone, kept);
  }

  find(path: string): string {
    let root = path;
    for (;;) {
      const parent = this.parent.get(root);
      if (parent === undefined) throw new Error(`the history extractor joins no identity of ${JSON.stringify(path)}: the path was never added`);
      if (parent === root) break;
      root = parent;
    }
    while (true) {
      const parent = this.parent.get(path);
      if (parent === undefined || parent === path) break;
      const next = parent;
      this.parent.set(path, root);
      if (next === root) break;
    }
    return root;
  }
}

/** Every non-merge commit's touched paths: a rename touches the path it left and the path it took. */
function touchedPaths(entry: LogEntry): readonly string[] {
  return entry.changes.flatMap((change) => change.paths);
}

/**
 * The file records of one walk, read against the repository itself for the
 * trees of the pinned snapshots and the bytes of the tip. Commits that a merge
 * brought in count like any other commit; a merge commit counts nowhere (it
 * changes no path of its own). A blob whose bytes cannot be read is said as a
 * gap of its path, never dropped silently.
 */
export function fileRecords(repository: string, branch: string, all: readonly LogEntry[], commits: ReadonlyMap<string, CommitRecord>, snapshots: Readonly<Record<string, string>>): {
  readonly nodes: ExtractedNode[];
  readonly edges: ExtractedEdge[];
  readonly gaps: ExtractionGap[];
} {
  const what = 'the history extractor reads the files';
  const renames: {from: string; to: string; similarity: number}[] = [];
  const identities = new Identities();
  const touched = new Map<string, Set<string>>();
  const paths = new Set<string>();

  for (const entry of all) {
    for (const path of touchedPaths(entry)) {
      paths.add(path);
      identities.add(path);
      const record = touched.get(path);
      if (record === undefined) touched.set(path, new Set([entry.commit]));
      else record.add(entry.commit);
    }
    for (const change of entry.changes) {
      if (!/^[RC]/u.test(change.status)) continue;
      const [from, to] = change.paths;
      if (from === undefined || to === undefined) continue;
      renames.push({from, to, similarity: change.similarity ?? 1});
      // One identity: the path a move left and the path it took are one file,
      // whose commits count each once, wherever the diff names them.
      identities.join(from, to);
    }
  }

  // The trees of the pinned snapshots and the tip. An entry that is no blob (a
  // submodule's gitlink, say) is a path this extractor cannot read, and is
  // said as a gap of that path, once wherever it stands.
  const tip = resolveCommit(what, repository, branch);
  const tipTree = listTree(what, repository, tip);
  const unreadPaths = new Set<string>();
  const unread = (entry: TreeEntry): string | undefined => {
    if (entry.blob !== undefined) return undefined;
    unreadPaths.add(entry.path);
    return `the tree holds ${entry.path} as a ${entry.type}, not as a blob of bytes`;
  };
  const tipPaths = new Set(tipTree.flatMap((entry) => (unread(entry) === undefined ? [entry.path] : [])));
  for (const path of tipPaths) {
    paths.add(path);
    identities.add(path);
  }
  const snapshotTrees = new Map<string, {commit: string; entries: readonly TreeEntry[]}>();
  for (const name of Object.keys(snapshots).sort(byCodePoint)) {
    const pinned = snapshots[name];
    if (typeof pinned !== 'string') {
      throw new Error(`${what}: the snapshot ${JSON.stringify(name)} is pinned at ${JSON.stringify(pinned)}, not a revision`);
    }
    const commit = resolveCommit(what, repository, pinned);
    snapshotTrees.set(name, {commit, entries: listTree(what, repository, commit)});
  }

  // What each identity changed and who changed it: the commits of every path
  // of the identity, each once, and their authors.
  const identityCommits = new Map<string, Set<string>>();
  const identityAuthors = new Map<string, Set<string>>();
  for (const path of paths) {
    const root = identities.find(path);
    let commitsOfPath = identityCommits.get(root);
    let authorsOfPath = identityAuthors.get(root);
    if (commitsOfPath === undefined) {
      commitsOfPath = new Set();
      identityCommits.set(root, commitsOfPath);
    }
    if (authorsOfPath === undefined) {
      authorsOfPath = new Set();
      identityAuthors.set(root, authorsOfPath);
    }
    for (const commit of touched.get(path) ?? []) {
      commitsOfPath.add(commit);
      const record = commits.get(commit);
      if (record === undefined) throw new Error(`${what}: the commit ${commit} touched ${path} and stands in no record`);
      authorsOfPath.add(record.entry.author);
    }
  }

  // Each identity's representative path: the smallest path it holds at the
  // branch's tip, and where it holds none there, the smallest path it ever
  // held. Pair counts and coupling edges name the representative, so a renamed
  // file is one node of one history.
  const representative = new Map<string, string>();
  for (const root of new Set([...paths].map((path) => identities.find(path)))) {
    const held: string[] = [];
    const ever: string[] = [];
    for (const path of paths) {
      if (identities.find(path) !== root) continue;
      ever.push(path);
      if (tipPaths.has(path)) held.push(path);
    }
    const chosen = (held.length > 0 ? held : ever).sort(byCodePoint)[0];
    if (chosen === undefined) throw new Error(`${what}: the identity of ${root} holds no path`);
    representative.set(root, chosen);
  }

  const nodes: ExtractedNode[] = [];
  const edges: ExtractedEdge[] = [];
  const gaps: ExtractionGap[] = [];

  // The file nodes: every path ever seen, with its identity's commit count and
  // authors, and the line count of its bytes at the branch's tip where it
  // stands there.
  const linesOf = new Map<string, number>();
  for (const entry of tipTree) {
    if (entry.blob === undefined) continue;
    try {
      linesOf.set(entry.path, countLines(readBlob(what, repository, entry.blob)));
    } catch (error) {
      gaps.push({path: entry.path, reason: `the bytes of blob ${entry.blob} could not be read: ${(error as Error).message}`});
    }
  }
  for (const path of unreadPaths) {
    const reason = `the tree holds ${path} as an entry that is no blob, so its bytes are not read`;
    if (!gaps.some((gap) => gap.path === path && gap.reason === reason)) gaps.push({path, reason});
  }
  for (const path of paths) {
    const root = identities.find(path);
    const commitCount = identityCommits.get(root)?.size ?? 0;
    const authors = [...(identityAuthors.get(root) ?? new Set<string>())].sort(byCodePoint);
    const lines = linesOf.get(path);
    nodes.push({
      key: fileKey(path),
      kind: 'code.file',
      label: path,
      properties: {...(lines === undefined ? {} : {lines}), commitCount, authors},
      // A path the tree no longer holds (a file a later commit renamed away) has no owner node at the tip: this node
      // carries its place, and the driver's reference node for it inherits none, so the history speaks for it.
      span: {path, byteStart: 0, byteEnd: 0, lineStart: 1, lineEnd: 1},
    });
  }

  // The snapshot nodes, each naming the commit it is pinned at, and what each
  // holds.
  for (const [name, snapshot] of snapshotTrees) {
    nodes.push({key: snapshotKey(name), kind: 'code.snapshot', label: name, properties: {commit: snapshot.commit}});
    for (const entry of snapshot.entries) {
      if (entry.blob === undefined) continue;
      edges.push({type: 'code.held', from: snapshotKey(name), to: fileKey(entry.path), discriminator: '', properties: {blob: entry.blob}});
    }
  }

  // The touched edges and the renames. A touched edge carries what the commit did to the path: the lines it added and
  // removed, as `git log --numstat` counts them (madarch-m38l.16, the commit page's "what it changed"). A path whose
  // count the walk does not report (a binary file reports `-`) gets no counts, and the page says so.
  const counts = readNumstat(what, repository, branch);
  for (const entry of all) {
    const record = commits.get(entry.commit);
    if (record === undefined) throw new Error(`${what}: the commit ${entry.commit} stands in no record`);
    if (record.merge) continue;
    const ofCommit = counts.get(entry.commit);
    for (const path of new Set(touchedPaths(entry))) {
      const lines = ofCommit?.get(path);
      edges.push({type: 'code.touched', from: commitKey(entry.commit), to: fileKey(path), discriminator: '', properties: lines === undefined ? {} : {additions: lines.additions, deletions: lines.deletions}});
    }
  }
  for (const rename of renames) {
    edges.push({type: 'code.renamed-to', from: fileKey(rename.from), to: fileKey(rename.to), discriminator: '', properties: {similarity: rename.similarity}});
  }

  // The change coupling: every pair of identities one non-merge commit changed
  // together, named by its representatives, with the number of commits that
  // changed both. A pair that met once is no coupling and writes no edge.
  const support = new Map<string, number>();
  for (const entry of all) {
    const record = commits.get(entry.commit);
    if (record === undefined) throw new Error(`${what}: the commit ${entry.commit} stands in no record`);
    if (record.merge) continue;
    const together = [...new Set(touchedPaths(entry).map((path) => representative.get(identities.find(path)) ?? path))].sort(byCodePoint);
    for (let left = 0; left < together.length; left += 1) {
      for (let right = left + 1; right < together.length; right += 1) {
        const pair = `${together[left]}\u0000${together[right]}`;
        support.set(pair, (support.get(pair) ?? 0) + 1);
      }
    }
  }
  for (const [pair, count] of support) {
    if (count < 2) continue;
    const [from, to] = pair.split('\u0000');
    if (from === undefined || to === undefined) throw new Error(`${what}: the coupling pair ${JSON.stringify(pair)} does not name two files`);
    edges.push({type: 'code.changed-with', from: fileKey(from), to: fileKey(to), discriminator: '', properties: {support: count}});
  }

  nodes.sort((left, right) => byCodePoint(left.key, right.key));
  edges.sort(edgeOrder);
  gaps.sort((left, right) => byCodePoint(left.path, right.path) || byCodePoint(left.reason, right.reason));
  return {nodes, edges, gaps};
}

/** The newline-terminated lines of a blob's bytes. */
function countLines(bytes: Buffer): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return lines;
}

