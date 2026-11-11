/**
 * A task closes when a commit closes it (madarch-m38l.14; the owner, 2026-10-23:
 * "у всех документов и кода которого это касается это должны быть видно, что
 * планируются изменения"). Two things close a task: a person, or a commit on the
 * repository's default branch that both names the task and changes its declared
 * scope. A commit that names another task, or that changes only outside the
 * scope, closes nothing.
 *
 * The closure is read from git whenever the tasks are read, so a task file never
 * goes stale against the history it describes. A git read that fails is an error
 * naming the repository, never a task silently left open or closed.
 */
import { changedLineRanges } from '../plugin/git-bytes.js';
import { execFileSync } from 'node:child_process';
import { byCodePoint } from '../model/order.js';
import { documentSections } from '../knowledge/anchors.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import type { LoopGraph } from './graph.js';
import { scopePath, type PlannedTask, type TaskScope } from './tasks.js';

export interface RepositoryRef {
  readonly name: string;
  /** The folder the repository is checked out in. */
  readonly path: string;
}

/** The commit that closed a task. */
export interface TaskClosure {
  readonly repository: string;
  readonly commit: string;
  readonly at: string;
  readonly subject: string;
}

const git = (repository: string, args: string[]): string =>
  execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** The branch a repository's commits are read on: `origin/HEAD` when it names one, else the branch checked out. */
export function defaultBranch(repository: string): string {
  try {
    const remote = git(repository, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
    if (remote !== '' && remote.includes('/')) return remote.slice(remote.indexOf('/') + 1);
  } catch {
    // a repository with no origin: its own branch is the default one
  }
  try {
    const current = git(repository, ['symbolic-ref', '--short', 'HEAD']).trim();
    if (current !== '') return current;
  } catch {
    // a detached head: the commits are read from HEAD itself
  }
  return 'HEAD';
}

/** Whether a commit's message names the task: its id, or a `Task:` line listing the task's name. */
function namesTask(message: string, slug: string): boolean {
  // Whole ids only: `task:discount` must not be named by a commit that names `task:discount-rate`.
  const whole = new RegExp(`(^|[^\\w:.-])task:${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w:.-]|$)`);
  if (whole.test(message)) return true;
  return message.split('\n').some((line) => {
    const match = /^task:\s*(.+)$/i.exec(line.trim());
    return match !== null && match[1]!.split(/[,\s]+/).map((id) => id.trim()).filter((id) => id !== '').includes(slug);
  });
}

/** Exact section extents, qualified by repository and revision before they can prove a historical closure. */
export type ScopeLines = ReadonlyMap<string, { readonly start: number; readonly end: number }>;

export function scopeLineKey(repository: string | null, commit: string, path: string, anchor: string): string {
  return JSON.stringify([repository, commit, path, anchor]);
}

/** Section extents come from opinions, never from reopening a product document at a commit. */
export async function graphScopeLines(graph: LoopGraph, manifest: Pick<KindsManifest, 'kinds'>): Promise<ScopeLines> {
  const ranges = new Map<string, { start: number; end: number }>();
  for (const kind of manifest.kinds.values()) {
    if (!kind.fields?.some((field) => field.name === 'markdown')) continue;
    let after: string | undefined;
    do {
    const page = await graph.list(kind.name, { limit: 500, ...(after === undefined ? {} : { after }) });
    for (const entity of page.rows) {
      const path = entity.properties['path'];
      if (typeof path !== 'string') throw new Error(`${entity.key}: document opinion path must be text`);
      const repository = entity.properties['repository'];
      if (repository !== null && typeof repository !== 'string') throw new Error(`${entity.key}:1: document opinion repository must be text or null`);
      const sections = documentSections(entity);
      const evidence = entity.opinions === undefined ? entity.evidence : entity.opinions.filter((opinion) => opinion.field === 'anchors' && JSON.stringify(opinion.value) === JSON.stringify(entity.properties['anchors'])).flatMap((opinion) => opinion.evidence);
      const commits = new Set(evidence?.filter((evidence) => evidence.field === 'anchors' && evidence.repository === repository && evidence.path === path && evidence.commit !== null).map((evidence) => evidence.commit!) ?? []);
      const declaredCommit = entity.properties['commit'];
      if (typeof declaredCommit === 'string' && declaredCommit !== '') { commits.clear(); commits.add(declaredCommit); }
      for (const commit of commits) for (const section of sections) {
        ranges.set(scopeLineKey(repository, commit, path, section.anchor), { start: section.start, end: section.end });
      }
    }
    after = page.next ?? undefined;
    } while (after !== undefined);
  }
  return ranges;
}


const overlaps = (ranges: readonly { start: number; end: number }[], scope: { start: number; end: number }): boolean =>
  ranges.some((range) => range.start <= scope.end && range.end >= scope.start);

/**
 * Whether a commit's change of the file touches the task's scope there. A section scope is
 * the section's own lines, not the whole file (the owner, 2026-10-23: "Зачем помечать весь
 * файл, если исправить нужно одну строчку?"); a file scope is the whole file.
 */
function touches(repository: RepositoryRef, commit: string, changed: readonly string[], scope: TaskScope, pageFiles: ReadonlyMap<string, string>, scopeLines: ScopeLines, notes: string[]): boolean {
  // A statement stands on a page of the product: its file is the page's own.
  if (scope.type === 'statement') {
    const file = pageFiles.get(scope.key.slice(0, scope.key.indexOf('#')));
    return file !== undefined && changed.includes(file);
  }
  const path = scopePath(scope);
  if (path === undefined || !changed.includes(path)) return false;
  if (scope.type === 'file' || scope.type === 'symbol') return true;
  const ranges = changedLineRanges(repository.path, commit, path);
  // A change of the file with no readable patch is not the scope's change: a task closes on what this reader can see.
  if (ranges.length === 0) return false;
  if (scope.type === 'lines') return overlaps(ranges, { start: scope.start, end: scope.end });
  const section = scopeLines.get(scopeLineKey(repository.name === '' ? null : repository.name, commit, path, scope.anchor));
  if (section === undefined) {
    const note = `${repository.path}/${path}:1: ${commit} names a task but no section extent opinion for repository ${JSON.stringify(repository.name || null)} at that revision proves its change of #${scope.anchor}; the task remains open`;
    if (!notes.includes(note)) notes.push(note);
    return false;
  }
  return overlaps(ranges, section);
}

interface Commit {
  readonly commit: string;
  readonly at: string;
  readonly subject: string;
  readonly message: string;
  readonly changed: readonly string[];
}

/** The commits of a repository's default branch since a time, newest first, each with the files it changed. */
function commitsSince(repository: string, since: string, most: number): Commit[] {
  let listing: string;
  try {
    // One read for the messages and the changed files of every commit: a record starts with 0x1e, its fields are 0x1f apart.
    listing = git(repository, ['log', '--name-only', '--format=%x1e%H%x1f%cI%x1f%s%x1f%B', `--since=${since}`, '-n', String(most), defaultBranch(repository)]);
  } catch (error) {
    throw new Error(`${repository}: the commits of the default branch cannot be read to see which tasks a commit closes: ${(error as Error).message.split('\n')[0]}`);
  }
  const commits: Commit[] = [];
  for (const record of listing.split('\x1e')) {
    if (record.trim() === '') continue;
    const [commit, at, subject, ...rest] = record.split('\x1f');
    if (commit === undefined || at === undefined) continue;
    const body = rest.join('\x1f');
    const changed = body.split('\n').map((name) => name.trim()).filter((name) => name !== '' && !name.startsWith('Task:'));
    commits.push({ commit: commit.trim(), at, subject: subject ?? '', message: `${subject ?? ''}\n${body}`, changed });
  }
  return commits;
}

/** The commit that closes a task, when its repositories' default branches hold one since the task was written. */
export function closingCommit(task: PlannedTask, repositories: readonly RepositoryRef[], options: { readonly most?: number; readonly pageFiles?: ReadonlyMap<string, string>; readonly scopeLines?: ScopeLines; readonly notes?: string[] } = {}): TaskClosure | undefined {
  if (task.closedBy !== null) return undefined;
  const since = task.at === '' || Number.isNaN(new Date(task.at).getTime()) ? '1970-01-01T00:00:00Z' : task.at;
  const found: TaskClosure[] = [];
  for (const repository of repositories) {
    for (const commit of commitsSince(repository.path, since, options.most ?? 2_000)) {
      if (!namesTask(commit.message, task.slug)) continue;
      if (!task.scope.some((scope) => touches(repository, commit.commit, commit.changed, scope, options.pageFiles ?? new Map(), options.scopeLines ?? new Map(), options.notes ?? []))) continue;
      found.push({ repository: repository.name, commit: commit.commit, at: commit.at, subject: commit.subject });
      break;
    }
  }
  return found.sort((a, b) => byCodePoint(b.at, a.at))[0];
}
