/**
 * The history stage (decision 0026's stage 7) through `plan` and `execute`: the
 * pinned commit's ancestry as `commit` facts, the task keys the commit messages
 * name as `task-key` edges, the depth bound, the shallow and missing-parent
 * gaps, and what one run leaves alone because an earlier run already wrote it.
 *
 * Every expectation here is written from the task's DONE WHEN and from decisions
 * 0026, 0027 and 0005, and every repository a test reads is one it makes itself
 * in a temporary folder and removes again: no test names this machine's
 * checkout, and no fixture is a repository outside the test.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Type } from 'typebox';
import { canonicalJsonDigest } from '../src/model/canonical.js';
import { byCodePoint } from '../src/model/order.js';
import {
  DEFAULT_STAGE_LIMITS,
  type FillStage,
  type ResolvedStageConfiguration,
  type StageContext,
  type StageDraftSet,
  type StageDraftWrite,
  type StageGraphReader,
  type StageUnit,
} from '../src/fill/stage.js';
import { deriveStageGraph, StageRegistry } from '../src/fill/registry.js';
import { FACT_KINDS, factId, type CoverageValue, type FactProvenance } from '../src/fill/facts.js';
import {
  DEFAULT_HISTORY_DEPTH,
  HISTORY_FACT_KINDS,
  HISTORY_LOG_FIELD,
  HISTORY_LOG_RECORD,
  HISTORY_STAGE_ID,
  HISTORY_STAGE_VERSION,
  PINNED_SNAPSHOTS_QUERY,
  commitsHeldQuery,
  coverageHeldQuery,
  createGitHistoryReader,
  createHistoryStage,
  historyDepth,
  historyScope,
  historyUnitId,
  parseHistoryScope,
  taskKeys,
  validateDraft,
  type HistoryReader,
} from '../src/fill/stages/history.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import type { SnapshotSource } from '../src/fill/snapshot.js';
import { gitEnv } from './git-env.js';

// ---- repositories the tests make ------------------------------------------

/** One commit a fixture is asked to make: the files it writes, and the message it carries. */
interface FixtureCommit {
  readonly message: string;
  readonly files: Readonly<Record<string, string>>;
  /** The author time and the committer time, ISO 8601 with an offset; the committer time is one hour later where it is left out. */
  readonly authoredAt?: string;
  readonly committedAt?: string;
}

/** A repository the test made, with the commits it holds oldest first. */
interface Fixture {
  /** The temporary folder the repository and everything made from it stand in. */
  readonly root: string;
  /** The repository's own folder: what the wiring would name as a checkout. */
  readonly folder: string;
  readonly commits: readonly string[];
  write(path: string, text: string): Promise<void>;
  /** Commits what was written, and answers the commit. */
  commit(commit: FixtureCommit): Promise<string>;
  merge(message: string, branch: string, at?: { authoredAt: string; committedAt: string }): Promise<string>;
  dispose(): Promise<void>;
}

/** A time a fixture's commits carry, so no test depends on the clock that ran it. */
function at(hour: number): string {
  return `2026-10-0${hour < 10 ? 1 : 2}T${String(hour % 24).padStart(2, '0')}:00:00+00:00`;
}

/** The instant one ISO 8601 offset time names, as the schema's `Z` form: the expected value of every time test. */
function instant(text: string): string {
  return new Date(text).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/** Makes one repository in a temporary folder of its own, committed with fixed identities and times. */
async function makeRepository(name: string, commits: readonly FixtureCommit[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `madarch-history-${name}-`));
  const folder = join(root, 'checkout');
  await mkdir(folder, { recursive: true });
  const make = (args: readonly string[], extra: Record<string, string> = {}): string =>
    execFileSync('git', [...args], { cwd: folder, encoding: 'utf8', env: gitEnv(extra) });
  make(['init', '-q', '-b', 'main']);
  make(['config', 'user.name', 'Fixture Author']);
  make(['config', 'user.email', 'fixture@example.invalid']);
  const made: string[] = [];
  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), text);
  };
  const commit = async (entry: FixtureCommit): Promise<string> => {
    for (const [path, text] of Object.entries(entry.files)) await write(path, text);
    make(['add', '-A']);
    const authored = entry.authoredAt ?? at(made.length + 1);
    const committed = entry.committedAt ?? at(made.length + 2);
    make(['commit', '-q', '--allow-empty', '-m', entry.message], {
      GIT_AUTHOR_DATE: authored, GIT_COMMITTER_DATE: committed,
      GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    });
    const sha = make(['rev-parse', 'HEAD']).trim();
    made.push(sha);
    return sha;
  };
  for (const entry of commits) await commit(entry);
  return {
    root,
    folder,
    commits: made,
    write,
    commit,
    merge: async (message, branch, time) => {
      make(['merge', '-q', '--no-ff', '-m', message, branch], {
        GIT_AUTHOR_DATE: time?.authoredAt ?? at(9), GIT_COMMITTER_DATE: time?.committedAt ?? at(10),
      });
      const sha = make(['rev-parse', 'HEAD']).trim();
      made.push(sha);
      return sha;
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** The branch a merge test makes beside `main`. */
async function makeBranch(fixture: Fixture, name: string, commit: FixtureCommit): Promise<void> {
  const make = (args: readonly string[], extra: Record<string, string> = {}): string =>
    execFileSync('git', args, { cwd: fixture.folder, encoding: 'utf8', env: gitEnv(extra) });
  make(['checkout', '-q', '-b', name, 'HEAD~1']);
  for (const [path, text] of Object.entries(commit.files)) await fixture.write(path, text);
  make(['add', '-A']);
  // A time of the fixture's own, never the clock the test ran on.
  make(['commit', '-q', '-m', commit.message], {
    GIT_AUTHOR_DATE: commit.authoredAt ?? at(5), GIT_COMMITTER_DATE: commit.committedAt ?? at(6),
  });
  make(['checkout', '-q', 'main']);
}

/** A shallow clone of a fixture: the boundary's parents are not in the checkout. One commit deep unless a test says otherwise. */
async function shallowClone(fixture: Fixture, depth = 1): Promise<{ readonly folder: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-history-shallow-'));
  const folder = join(root, 'checkout');
  execFileSync('git', ['clone', '-q', '--depth', String(depth), `file://${fixture.folder}`, folder], { encoding: 'utf8', env: gitEnv() });
  return { folder, dispose: () => rm(root, { recursive: true, force: true }) };
}

/**
 * A program standing in for git, for the answers git will not give: a record
 * whose message holds the record separator, a time that is no time, a walk that
 * failed. It answers the four calls a read makes and copies the log and the
 * standard error the test wrote; `PATH` carries it while the test runs.
 */
async function fakeGit(answers: { readonly log?: string; readonly status?: number; readonly stderr?: string; readonly pin?: string }): Promise<{ readonly folder: string; readonly reader: HistoryReader; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-history-fake-git-'));
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const log = join(root, 'log.txt');
  const errors = join(root, 'stderr.txt');
  await writeFile(log, answers.log ?? '');
  await writeFile(errors, answers.stderr ?? '');
  const script = [
    '#!/bin/sh',
    'case "$*" in',
    '  *--version*) echo "git version 9.9.9"; exit 0 ;;',
    '  *--is-shallow-repository*) echo false; exit 0 ;;',
    '  *rev-parse*) echo "' + (answers.pin ?? 'a'.repeat(40)) + '"; exit 0 ;;',
    'esac',
    `cat "${log}"`,
    `cat "${errors}" >&2`,
    `exit ${answers.status ?? 0}`,
    '',
  ].join('\n');
  await writeFile(join(bin, 'git'), script, { mode: 0o755 });
  const path = process.env['PATH'];
  process.env['PATH'] = `${bin}:${path ?? ''}`;
  return {
    folder: root,
    reader: createGitHistoryReader(() => root),
    dispose: async () => {
      if (path === undefined) delete process.env['PATH']; else process.env['PATH'] = path;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A copy of a fixture with one commit's own object removed: git cannot traverse that commit's parents any more. */
async function withoutObject(fixture: Fixture, commit: string): Promise<{ readonly folder: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-history-corrupt-'));
  const folder = join(root, 'checkout');
  await cp(fixture.folder, folder, { recursive: true });
  await unlink(join(folder, '.git', 'objects', commit.slice(0, 2), commit.slice(2)));
  return { folder, dispose: () => rm(root, { recursive: true, force: true }) };
}

// ---- the fake context a stage runs in --------------------------------------

/** What one test's fake context collected: the reads, the writes, the progress notes and the context itself. */
interface Recorder {
  readonly context: StageContext;
  readonly reads: string[];
  readonly writes: StageDraftWrite[];
  readonly notes: string[];
}

/** The fake context of one unit: a graph answering the rows the test put there, a draft set and progress. */
function recorder(unit: StageUnit, options: { readonly config?: unknown; readonly rows?: ReadonlyMap<string, readonly unknown[]>; readonly signal?: AbortSignal } = {}): Recorder {
  const reads: string[] = [];
  const writes: StageDraftWrite[] = [];
  const notes: string[] = [];
  const rows = options.rows ?? new Map<string, readonly unknown[]>();
  const graph: StageGraphReader = { query: async (text: string) => { reads.push(text); return rows.get(text) ?? []; } };
  const config: ResolvedStageConfiguration = {
    id: HISTORY_STAGE_ID,
    version: HISTORY_STAGE_VERSION,
    enabled: true,
    concurrency: 1,
    limits: DEFAULT_STAGE_LIMITS,
    config: options.config ?? { depth: DEFAULT_HISTORY_DEPTH },
  };
  return {
    reads,
    writes,
    notes,
    context: {
      unit,
      config,
      graph,
      draft: { write: (entry) => { writes.push(entry); }, writes: (): StageDraftSet => ({ writes }) },
      progress: (note) => { notes.push(note); },
      signal: options.signal ?? new AbortController().signal,
    },
  };
}

/** The value of every fact write of one kind, in the order they were written. */
function valuesOf(writes: readonly StageDraftWrite[], kind: string): Record<string, unknown>[] {
  return writes.flatMap((write) => {
    if (write.kind !== 'fact') return [];
    const fact = write.value as { kind?: unknown; value?: unknown };
    return fact.kind === kind ? [fact.value as Record<string, unknown>] : [];
  });
}

/** The rows a plan or an execute reads back: the pinned snapshots, the commits held and the coverage held. */
function rowsFor(entries: {
  readonly pins?: readonly unknown[];
  readonly held?: readonly (readonly [string, readonly { readonly commit: string; readonly value: unknown }[]])[];
  readonly coverage?: readonly (readonly [string, unknown])[];
}): Map<string, readonly unknown[]> {
  const rows = new Map<string, readonly unknown[]>();
  if (entries.pins !== undefined) rows.set(PINNED_SNAPSHOTS_QUERY, entries.pins);
  for (const [repository, held] of entries.held ?? []) rows.set(commitsHeldQuery(repository), held);
  for (const [key, value] of entries.coverage ?? []) rows.set(key, [{ value }]);
  return rows;
}

/** The snapshot source a history test never reads: the stage under test reads a repository's Git, not its tree. */
const NO_TREES: SnapshotSource = {
  pins: async () => [],
  open: () => { throw new Error('the history stage reads no tree'); },
};

/** The stage over a real Git reader reading the checkouts the test made: git itself is what a stage reads. */
function stageOver(checkouts: ReadonlyMap<string, string>, reader?: HistoryReader): FillStage {
  return createHistoryStage(reader ?? createGitHistoryReader((repository) => {
    const folder = checkouts.get(repository);
    if (folder === undefined) throw new Error(`the test named no checkout for ${repository}`);
    return folder;
  }));
}

/** The three commits every ancestry test reads: a root, a second, and a tip whose message names two tasks. */
const THREE: readonly FixtureCommit[] = [
  { message: 'First commit', files: { 'a.txt': 'one\n' } },
  { message: 'Second commit\n\nTask: madarch-abc.1', files: { 'src/b.ts': 'export const b = 1;\n' } },
  { message: 'Third commit\n\nTask: madarch-xyz.7, madarch-abc.1', files: { 'c.md': '# doc\n', 'src/b.ts': 'export const b = 2;\n' } },
];

describe('the ancestry one unit writes', () => {
  test('three commits become three commit facts in parent order, each with its own times, parents and files', async () => {
    const fixture = await makeRepository('three', THREE);
    try {
      const [first, second, third] = fixture.commits as [string, string, string];
      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const unit = { id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) };
      const planned = recorder({ id: 'plan', scope: 'plan' }, { rows: rowsFor({ pins: [{ repository: 'orders-api', commit: third }] }) });
      expect(await stage.plan(planned.context.graph)).toEqual({ units: [unit], coverage: 'planned' });

      const run = recorder(unit, { rows: rowsFor({ held: [['orders-api', []]] }) });
      const result = await stage.execute(unit, run.context);
      expect(result).toEqual({ outcome: 'draft' });

      // The commit facts, in the order they were written: parent order, the
      // root first (the task's DONE WHEN), and never one commit twice.
      const commits = valuesOf(run.writes, 'commit');
      expect(commits.map((value) => value['commit'])).toEqual([first, second, third]);
      expect(commits.map((value) => value['repository'])).toEqual(['orders-api', 'orders-api', 'orders-api']);
      expect(commits.map((value) => value['parents'])).toEqual([[], [first], [second]]);
      expect(commits.map((value) => value['files'])).toEqual([['a.txt'], ['src/b.ts'], ['c.md', 'src/b.ts']]);
      expect(commits.map((value) => value['subject'])).toEqual(['First commit', 'Second commit', 'Third commit']);
      expect(commits.map((value) => value['author'])).toEqual(['Fixture Author', 'Fixture Author', 'Fixture Author']);
      // Git's two times, read off the fixture's own dates: the first commit was
      // written at 01:00 and committed at 02:00, and the two are kept apart.
      expect(commits[0]?.['authoredAt']).toBe(instant(at(1)));
      expect(commits[0]?.['committedAt']).toBe(instant(at(2)));
      expect(commits[2]?.['authoredAt']).toBe(instant(at(3)));
      expect(commits[2]?.['committedAt']).toBe(instant(at(4)));

      // Every fact is the schema's: its id is the id of its own value and
      // provenance, and no id holds a machine path, a commit or a run.
      const firstFact = run.writes[0];
      if (firstFact === undefined || firstFact.kind !== 'fact') throw new Error('the first write is no fact write');
      const written = firstFact.value as { id: string; kind: string; provenance: FactProvenance; layer: string; status: string };
      expect(written.kind).toBe('commit');
      expect(written.layer).toBe('extracted');
      expect(written.status).toBe('proposed');
      expect(written.provenance.repository).toEqual({ id: 'orders-api', commit: first });
      expect(written.provenance.source.system).toBe('git');
      expect(written.provenance.source.version).toMatch(/^\d+\.\d+/u);
      expect(written.id).toBe(factId({ kind: 'commit', value: commits[0] as never, provenance: written.provenance }));
      expect(JSON.stringify(run.writes)).not.toContain(fixture.root);

      // And one coverage fact, complete: everything the unit read, and nothing
      // it could not.
      const coverage = valuesOf(run.writes, 'coverage') as unknown as CoverageValue[];
      expect(coverage).toEqual([{
        repository: 'orders-api',
        scope: historyScope('orders-api', third),
        complete: true,
        read: ['the pinned commit and its ancestry', 'the task keys the commit messages name'],
        unread: [],
      }]);
      expect(run.reads).toEqual([commitsHeldQuery('orders-api'), coverageHeldQuery('orders-api', historyScope('orders-api', third))]);
      expect(run.notes).toEqual([
        `read the ancestry of orders-api at ${third}: 3 commits`,
        `wrote 3 commits and 3 task keys of orders-api at ${third}`,
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  test('the task keys a commit message names become task-key edges, in code point order, each once', async () => {
    const fixture = await makeRepository('keys', [
      { message: 'Place an order\n\nTask: madarch-xyz.7, madarch-abc.1\nTask: madarch-abc.1\n\nbody\n', files: { 'order.md': '# an order\n' } },
    ]);
    try {
      const [only] = fixture.commits as [string];
      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const unit = { id: historyUnitId('orders-api', only), scope: historyScope('orders-api', only) };
      const run = recorder(unit);
      await stage.execute(unit, run.context);

      const edges = valuesOf(run.writes, 'task-key');
      expect(edges.map((value) => value['key'])).toEqual(['madarch-abc.1', 'madarch-xyz.7']);
      const commits = valuesOf(run.writes, 'commit');
      const commitId = factId({ kind: 'commit', value: commits[0] as never, provenance: { source: { system: 'git', version: '2' }, repository: { id: 'orders-api', commit: only } } });
      expect(edges.map((value) => value['from'])).toEqual([commitId, commitId]);
      const written = run.writes.filter((write) => write.kind === 'fact').map((write) => write.value as { kind: string; id: string; provenance: FactProvenance });
      for (const fact of written.filter((one) => one.kind === 'task-key')) {
        expect(fact.provenance.repository).toEqual({ id: 'orders-api', commit: only });
      }
      // The task keys are the tracker's own rule, read from the message.
      expect(taskKeys('Place an order\n\nTask: madarch-xyz.7, madarch-abc.1\nTask: madarch-abc.1\n')).toEqual(['madarch-abc.1', 'madarch-xyz.7']);
      expect(taskKeys('No task line here')).toEqual([]);
      expect(taskKeys('task: madarch-abc.1 madarch-def.2')).toEqual(['madarch-abc.1', 'madarch-def.2']);
      // The case of a key is the commit's own: the tracker's rule is read
      // case-insensitively, and the key is written as the message wrote it.
      expect(taskKeys('TASK: Madarch-ABC.1')).toEqual(['Madarch-ABC.1']);
    } finally {
      await fixture.dispose();
    }
  });

  test('a commit that changed no file writes a fact with no files and no edges', async () => {
    const fixture = await makeRepository('empty', [
      { message: 'First commit', files: { 'a.txt': 'one\n' } },
      { message: 'An empty commit\n\nTask: madarch-abc.1', files: {} },
    ]);
    try {
      const [first, second] = fixture.commits as [string, string];
      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const unit = { id: historyUnitId('orders-api', second), scope: historyScope('orders-api', second) };
      const run = recorder(unit);
      await stage.execute(unit, run.context);

      const commits = valuesOf(run.writes, 'commit');
      expect(commits.map((value) => value['commit'])).toEqual([first, second]);
      expect(commits[1]?.['files']).toEqual([]);
      expect(commits[1]?.['parents']).toEqual([first]);
      expect(valuesOf(run.writes, 'task-key').map((value) => value['key'])).toEqual(['madarch-abc.1']);
      expect(validateDraft({ writes: run.writes })).toEqual({ ok: true });
    } finally {
      await fixture.dispose();
    }
  });

  test('a merge names both its parents in git own order and the files it changed against its first parent', async () => {
    const fixture = await makeRepository('merge', [
      { message: 'First commit', files: { 'a.txt': 'one\n' } },
      { message: 'Second commit', files: { 'src/b.ts': 'export const b = 1;\n' } },
    ]);
    try {
      const [first, second] = fixture.commits as [string, string];
      await makeBranch(fixture, 'side', { message: 'Side commit', files: { 'side.txt': 's\n' } });
      const merge = await fixture.merge('Merge side into main', 'side');
      const side = execFileSync('git', ['rev-parse', 'side'], { cwd: fixture.folder, encoding: 'utf8', env: gitEnv() }).trim();

      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const unit = { id: historyUnitId('orders-api', merge), scope: historyScope('orders-api', merge) };
      const run = recorder(unit);
      await stage.execute(unit, run.context);

      const merged = valuesOf(run.writes, 'commit').find((value) => value['commit'] === merge);
      expect(merged?.['parents']).toEqual([second, side]);
      expect(merged?.['files']).toEqual(['side.txt']);
      expect(merged?.['subject']).toBe('Merge side into main');
      const root = valuesOf(run.writes, 'commit').find((value) => value['commit'] === first);
      expect(root?.['parents']).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('what one run leaves alone', () => {
  test('a second run after one new commit writes that commit facts alone', async () => {
    const fixture = await makeRepository('incremental', THREE);
    try {
      const [, , third] = fixture.commits as [string, string, string];
      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const firstUnit = { id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) };
      const firstRun = recorder(firstUnit);
      await stage.execute(firstUnit, firstRun.context);
      const heldValue = (kind: string): { readonly commit: string; readonly value: unknown }[] =>
        valuesOf(firstRun.writes, kind).map((value) => ({ commit: String(value['commit']), value }));

      const fourth = await fixture.commit({ message: 'Fourth commit\n\nTask: madarch-new.4', files: { 'd.txt': 'x\n' } });
      const unit = { id: historyUnitId('orders-api', fourth), scope: historyScope('orders-api', fourth) };
      const run = recorder(unit, {
        rows: rowsFor({ held: [['orders-api', heldValue('commit')]], coverage: [] }),
      });
      await stage.execute(unit, run.context);

      const commits = valuesOf(run.writes, 'commit');
      expect(commits.map((value) => value['commit'])).toEqual([fourth]);
      expect(commits[0]?.['parents']).toEqual([third]);
      expect(valuesOf(run.writes, 'task-key').map((value) => value['key'])).toEqual(['madarch-new.4']);
      // The new pin's own coverage is new work — its scope names the new
      // commit — and the commits of the old pin are not.
      const coverage = valuesOf(run.writes, 'coverage')[0] as unknown as CoverageValue;
      expect(coverage.scope).toBe(historyScope('orders-api', fourth));
      expect(coverage.unread).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('a rerun at the same pin, with the graph holding what the first run wrote, writes nothing at all', async () => {
    const fixture = await makeRepository('rerun', THREE);
    try {
      const [, , third] = fixture.commits as [string, string, string];
      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const unit = { id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) };
      const scope = historyScope('orders-api', third);
      const firstRun = recorder(unit);
      await stage.execute(unit, firstRun.context);

      const held = valuesOf(firstRun.writes, 'commit').map((value) => ({ commit: String(value['commit']), value }));
      const coverage = valuesOf(firstRun.writes, 'coverage')[0] as unknown;
      const secondRun = recorder(unit, {
        rows: rowsFor({ held: [['orders-api', held]], coverage: [[coverageHeldQuery('orders-api', scope), coverage]] }),
      });
      await stage.execute(unit, secondRun.context);
      expect(secondRun.writes).toEqual([]);
      expect(validateDraft({ writes: secondRun.writes })).toEqual({ ok: true });
      expect(secondRun.notes.at(-1)).toBe(`wrote 0 commits and 0 task keys of orders-api at ${third}`);
    } finally {
      await fixture.dispose();
    }
  });

  test('a commit read under a shallow boundary is written again once its parents are there', async () => {
    const fixture = await makeRepository('unshallow', THREE);
    const shallow = await shallowClone(fixture);
    try {
      const [, , third] = fixture.commits as [string, string, string];
      const stage = stageOver(new Map([['orders-api', shallow.folder]]));
      const unit = { id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) };
      const shallowRun = recorder(unit);
      await stage.execute(unit, shallowRun.context);
      const boundary = valuesOf(shallowRun.writes, 'commit')[0];
      expect(boundary?.['commit']).toBe(third);
      expect(boundary?.['parents']).toEqual([]);

      // The same pin, read where the parents are: the boundary commit's own
      // fact is written again, because the value the graph holds is not what
      // this read would write, and the two commits that were never readable
      // are written for the first time.
      const full = stageOver(new Map([['orders-api', fixture.folder]]));
      const run = recorder(unit, { rows: rowsFor({ held: [['orders-api', [{ commit: third, value: boundary }]]] }) });
      await full.execute(unit, run.context);
      const corrected = valuesOf(run.writes, 'commit');
      expect(corrected.map((value) => value['commit'])).toEqual([...fixture.commits]);
      expect(corrected[2]?.['parents']).toEqual([fixture.commits[1] as string]);
      expect(boundary?.['parents']).toEqual([]);
    } finally {
      await shallow.dispose();
      await fixture.dispose();
    }
  });
});

describe('the bound and what the read could not reach', () => {
  test('the configured depth cuts the ancestry and the bound is named in the coverage', async () => {
    const fixture = await makeRepository('depth', THREE);
    try {
      const [first, second, third] = fixture.commits as [string, string, string];
      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const unit = { id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) };
      const run = recorder(unit, { config: { depth: 2 } });
      await stage.execute(unit, run.context);

      // The two newest commits, still in parent order, and never the third.
      expect(valuesOf(run.writes, 'commit').map((value) => value['commit'])).toEqual([second, third]);
      const coverage = valuesOf(run.writes, 'coverage')[0] as unknown as CoverageValue;
      expect(coverage.complete).toBe(false);
      expect(coverage.unread).toEqual([{ what: `the ancestry before ${second}`, reason: 'budget' }]);
      expect(valuesOf(run.writes, 'commit').some((value) => value['commit'] === first)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test('a shallow clone is reported as coverage, never as a shorter history', async () => {
    const fixture = await makeRepository('shallow', THREE);
    const shallow = await shallowClone(fixture);
    try {
      const [, , third] = fixture.commits as [string, string, string];
      const stage = stageOver(new Map([['orders-api', shallow.folder]]));
      const unit = { id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) };
      const run = recorder(unit);
      await stage.execute(unit, run.context);

      expect(valuesOf(run.writes, 'commit').map((value) => value['commit'])).toEqual([third]);
      const coverage = valuesOf(run.writes, 'coverage')[0] as unknown as CoverageValue;
      expect(coverage.complete).toBe(false);
      // The gap names the boundary the clone stops at, and the commit git
      // answers for a commit with no parent in the checkout is the whole tree:
      // both are stated in the capability's coverage limits.
      expect(coverage.unread).toEqual([{ what: `the shallow boundary ${third}`, reason: 'inaccessible' }]);
      expect(valuesOf(run.writes, 'commit')[0]?.['files']).toEqual(['a.txt', 'c.md', 'src/b.ts']);
    } finally {
      await shallow.dispose();
      await fixture.dispose();
    }
  });

  test('a parent git cannot read is reported as coverage, never as a shorter history read whole', async () => {
    const fixture = await makeRepository('missing', THREE);
    const corrupt = await withoutObject(fixture, (fixture.commits as readonly string[])[0] as string);
    try {
      const [first, second, third] = fixture.commits as [string, string, string];
      const stage = stageOver(new Map([['orders-api', corrupt.folder]]));
      const unit = { id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) };
      const run = recorder(unit);
      const result = await stage.execute(unit, run.context);
      expect(result).toEqual({ outcome: 'draft' });

      // The walk stopped where the object was missing, and it named the object
      // it could not read: no commit fact is published for a history this read
      // could not walk, and the coverage says which object was unreadable.
      expect(valuesOf(run.writes, 'commit')).toEqual([]);
      expect(valuesOf(run.writes, 'task-key')).toEqual([]);
      const coverage = valuesOf(run.writes, 'coverage')[0] as unknown as CoverageValue;
      expect(coverage).toMatchObject({ repository: 'orders-api', scope: unit.scope, complete: false });
      // One gap, of the reason a parent that is not in the checkout leaves, and
      // it names the object that could not be read (git's own wording differs by
      // version, so the test asks for the object, not for the sentence).
      expect(coverage.unread).toHaveLength(1);
      expect(coverage.unread[0]?.reason).toBe('inaccessible');
      expect(coverage.unread[0]?.what).toContain(first);
      expect(second.length).toBe(40);
    } finally {
      await corrupt.dispose();
      await fixture.dispose();
    }
  });

  test('a git call that fails for another reason is thrown, naming the repository, the folder, the command and git own words', async () => {
    const fixture = await makeRepository('failure', [{ message: 'Only commit', files: { 'a.txt': 'one\n' } }]);
    try {
      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const unknown = '0'.repeat(40);
      const unit = { id: historyUnitId('orders-api', unknown), scope: historyScope('orders-api', unknown) };
      const run = recorder(unit);
      await expect(stage.execute(unit, run.context)).rejects.toThrow(new RegExp(`history: the read of orders-api at ${unknown}`));
      await expect(stage.execute(unit, run.context)).rejects.toThrow(new RegExp(fixture.folder.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
      await expect(stage.execute(unit, run.context)).rejects.toThrow(/rev-parse --verify/u);
      // Git's own exit status stands in the refusal, so a reader can tell a
      // refusal of git's (`128`) from a call that never ran.
      await expect(stage.execute(unit, run.context)).rejects.toThrow(/exited 128/u);
      expect(run.writes).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('a cancelled unit is refused rather than written', async () => {
    const fixture = await makeRepository('cancel', THREE);
    try {
      const [, , third] = fixture.commits as [string, string, string];
      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const unit = { id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) };
      const controller = new AbortController();
      controller.abort();
      const run = recorder(unit, { signal: controller.signal });
      await expect(stage.execute(unit, run.context)).rejects.toThrow(/was cancelled/u);
      expect(run.writes).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('the units a plan names', () => {
  test('one unit per pinned snapshot, in code point order of what it reads, each once', async () => {
    const stage = stageOver(new Map());
    const rows = [
      { repository: 'wiki', commit: 'b'.repeat(40) },
      { repository: 'orders-api', commit: 'a'.repeat(40) },
      { repository: 'orders-api', commit: 'a'.repeat(40) },
      { repository: 'orders-api', commit: 'c'.repeat(40) },
    ];
    const run = recorder({ id: 'plan', scope: 'plan' }, { rows: rowsFor({ pins: rows }) });
    const plan = await stage.plan(run.context.graph);
    expect(run.reads).toEqual([PINNED_SNAPSHOTS_QUERY]);
    // The unit names are written out here as the stage's own form states them:
    // the unit id is the repository and the commit, and the scope is
    // `repository:<name>@<commit>`, never a run's own id.
    expect(plan).toEqual({
      units: [
        { id: `orders-api@${'a'.repeat(40)}`, scope: `repository:orders-api@${'a'.repeat(40)}` },
        { id: `orders-api@${'c'.repeat(40)}`, scope: `repository:orders-api@${'c'.repeat(40)}` },
        { id: `wiki@${'b'.repeat(40)}`, scope: `repository:wiki@${'b'.repeat(40)}` },
      ],
      coverage: 'planned',
    });
    // And the plan read no Git: every checkout the wiring could name is absent.
    expect(historyUnitId('orders-api', 'a'.repeat(40))).toBe(`orders-api@${'a'.repeat(40)}`);
  });

  test('a graph holding no pinned snapshot plans nothing, as nothing-found', async () => {
    const stage = stageOver(new Map());
    expect(await stage.plan(recorder({ id: 'plan', scope: 'plan' }).context.graph)).toEqual({ units: [], coverage: 'nothing-found' });
  });

  test('a row this stage cannot read is refused with the query that answered it', async () => {
    const stage = stageOver(new Map());
    const run = recorder({ id: 'plan', scope: 'plan' }, { rows: rowsFor({ pins: [{ repository: 'orders-api', commit: 'HEAD' }] }) });
    await expect(stage.plan(run.context.graph)).rejects.toThrow(/row 0 of "SELECT repository, commit FROM fact WHERE kind = 'snapshot'"/u);
    const wrongName = recorder({ id: 'plan', scope: 'plan' }, { rows: rowsFor({ pins: [{ repository: '/opt/checkout', commit: 'a'.repeat(40) }] }) });
    await expect(stage.plan(wrongName.context.graph)).rejects.toThrow(/names the repository "\/opt\/checkout"/u);
    const notARecord = recorder({ id: 'plan', scope: 'plan' }, { rows: rowsFor({ pins: ['orders-api'] }) });
    await expect(stage.plan(notARecord.context.graph)).rejects.toThrow(/row 0 of/u);
  });

  test('a scope that names no repository at a commit is refused, saying the form', async () => {
    const stage = stageOver(new Map());
    const unit = { id: 'orders-api', scope: 'orders-api' };
    await expect(stage.execute(unit, recorder(unit).context)).rejects.toThrow(/no repository at a commit/u);
    expect(parseHistoryScope(historyScope('orders-api', 'a'.repeat(40)))).toEqual({ repository: 'orders-api', commit: 'a'.repeat(40) });
  });
});

describe('the stage declaration and the draft it judges', () => {
  test('the stage declares the decision own numbers: its kinds, their versions and the depth it reads', async () => {
    const stage = stageOver(new Map());
    expect(stage.id).toBe(HISTORY_STAGE_ID);
    expect(stage.version).toBe(HISTORY_STAGE_VERSION);
    expect(stage.produces).toEqual(HISTORY_FACT_KINDS.map((kind) => ({ kind, schemaVersion: FACT_KINDS[kind].version, scope: 'repository' })));
    expect(stage.consumes.required.map((one) => one.capability)).toEqual(['snapshot', 'commit']);
    expect(stage.defaults.config).toEqual({ depth: DEFAULT_HISTORY_DEPTH });
    expect((stage.defaults.config as { depth: number }).depth).toBe(1000);
    // The default a run falls back to is one the stage's own schema accepts, so
    // a product that says nothing still plans.
    const { Value } = await import('typebox/value');
    expect(Value.Errors(stage.configSchema, stage.defaults.config)).toEqual([]);
    expect(historyDepth({ depth: 2 })).toBe(2);
    expect(() => historyDepth({})).toThrow(/config\.depth/u);
    expect(() => historyDepth({ depth: 0 })).toThrow(/config\.depth/u);
    expect(() => historyDepth({ depth: 1.5 })).toThrow(/config\.depth/u);
  });

  test('the snapshot producer orders before the stage, and the stage own publication starves nothing', () => {
    const snapshotStage: FillStage = {
      id: 'snapshot',
      version: 1,
      consumes: { required: [], optional: [] },
      produces: [{ kind: 'snapshot', schemaVersion: FACT_KINDS['snapshot'].version, scope: 'product' }],
      configSchema: Type.Object({}),
      defaults: { enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
      plan: () => ({ units: [], coverage: 'planned' }),
      execute: () => ({ outcome: 'draft' }),
      validate: () => ({ ok: true }),
    };
    const stage = stageOver(new Map());
    const read = deriveStageGraph(new StageRegistry().register(snapshotStage).register(stage));
    if (!read.ok) throw new Error(`expected a clean graph, refused: ${JSON.stringify(read)}`);
    expect(read.graph.order).toEqual(['snapshot', HISTORY_STAGE_ID]);
    expect(read.graph.edges).toEqual([{ from: 'snapshot', to: HISTORY_STAGE_ID, via: 'snapshot' }]);

    // The stage's own capability is read from its earlier run: disabling the
    // only producer of the snapshot (and nothing else) is what starves it.
    const disabled = deriveStageGraph(new StageRegistry().register(snapshotStage).register(stage), {
      ok: true, file: 'workspace.yaml', stages: { snapshot: { enabled: false } }, lines: { snapshot: 5 },
    });
    expect(disabled.ok).toBe(false);
    if (disabled.ok) throw new Error('expected the derivation to refuse');
    expect(disabled.starvation.map((one) => one.path)).toEqual([`${HISTORY_STAGE_ID} → snapshot → snapshot (disabled)`]);
  });

  test('registering the stage over a wiring is what a run does, and the registered stage plans', async () => {
    const fixture = await makeRepository('registered', THREE);
    try {
      const [, , third] = fixture.commits as [string, string, string];
      // The history stage reads Git, never a tree: the wiring's snapshot source
      // is one this test never opens.
      const registry = createStageRegistry({ snapshots: NO_TREES, checkoutOf: () => fixture.folder });
      const stage = registry.get(HISTORY_STAGE_ID);
      expect(stage?.id).toBe(HISTORY_STAGE_ID);
      const run = recorder({ id: 'plan', scope: 'plan' }, { rows: rowsFor({ pins: [{ repository: 'orders-api', commit: third }] }) });
      expect(await stage?.plan(run.context.graph)).toEqual({ units: [{ id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) }], coverage: 'planned' });
    } finally {
      await fixture.dispose();
    }
  });

  test('validate refuses a fact the schema does not read and a task-key edge no commit of the draft writes', () => {
    const provenance: FactProvenance = { source: { system: 'git', version: '2' }, repository: { id: 'orders-api', commit: 'a'.repeat(40) } };
    const broken = { kind: 'commit', schemaVersion: FACT_KINDS['commit'].version, id: 'commit:' + '0'.repeat(64), provenance, layer: 'extracted', status: 'proposed', value: { repository: 'orders-api', commit: 'a'.repeat(40), committedAt: '2026-10-01T00:00:00Z', authoredAt: '2026-10-01T00:00:00Z', subject: 'x', parents: [], files: ['/opt/madarch-checkout/a.txt'] } };
    const judged = validateDraft({ writes: [{ kind: 'fact', evidence: 'orders-api@' + 'a'.repeat(40), value: broken }] });
    expect(judged.ok).toBe(false);
    if (judged.ok) throw new Error('expected the draft to be refused');
    expect(judged.errors.join(' ')).toMatch(/value\.files\[0\]/u);

    const edge = { kind: 'task-key', schemaVersion: 1, id: 'task-key:' + '0'.repeat(64), provenance, layer: 'extracted', status: 'proposed', value: { from: 'commit:' + '1'.repeat(64), key: 'madarch-abc.1' } };
    const alone = validateDraft({ writes: [{ kind: 'fact', evidence: 'orders-api@' + 'a'.repeat(40), value: edge }] });
    expect(alone.ok).toBe(false);
    if (alone.ok) throw new Error('expected the draft to be refused');
    expect(alone.errors.join(' ')).toMatch(/writes no commit fact of that id/u);

    // The draft write carries the fact it writes, so a link write carries its edge fact: the stage
    // refuses it because it writes "fact" writes and nothing else, not because the write is empty.
    const other = validateDraft({ writes: [{ kind: 'link', evidence: 'x', value: edge }] });
    expect(other.ok).toBe(false);
    if (other.ok) throw new Error('expected the draft to be refused');
    expect(other.errors.join(' ')).toMatch(/the history stage writes facts and nothing else/u);
  });

  test('what a unit writes is what the schema reads, whole', async () => {
    const fixture = await makeRepository('whole', THREE);
    try {
      const [, , third] = fixture.commits as [string, string, string];
      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const unit = { id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) };
      const run = recorder(unit);
      await stage.execute(unit, run.context);
      expect(validateDraft({ writes: run.writes })).toEqual({ ok: true });
      // Every fact's id is the digest of its own value and provenance, whatever
      // the read was: sorting the values another way never changes an id.
      for (const write of run.writes) {
        if (write.kind !== 'fact') continue;
        const fact = write.value as { kind: string; id: string; value: unknown; provenance: FactProvenance };
        expect(fact.id).toBe(factId({ kind: fact.kind, value: fact.value, provenance: fact.provenance } as never));
        expect(canonicalJsonDigest(fact.value)).toMatch(/^[0-9a-f]{64}$/u);
      }
      // The writes are in parent order of their commits, with each commit's
      // task keys directly after it.
      const order = run.writes.flatMap((write) => {
        if (write.kind !== 'fact') return [];
        const fact = write.value as { kind: string; value: Record<string, unknown> };
        return [fact.kind === 'commit' ? `commit ${String(fact.value['commit'])}` : `${fact.kind} ${String(fact.value['key'])}`];
      });
      expect(order).toEqual([
        `commit ${fixture.commits[0] as string}`,
        `commit ${fixture.commits[1] as string}`,
        'task-key madarch-abc.1',
        `commit ${fixture.commits[2] as string}`,
        'task-key madarch-abc.1',
        'task-key madarch-xyz.7',
        'coverage undefined',
      ]);
      // The commit facts alone, in the fixture's own order: parents before
      // children, whatever the order git lists the ancestry in.
      expect(order.filter((one) => one.startsWith('commit ')).map((one) => one.slice('commit '.length))).toEqual([...fixture.commits]);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('what the wiring, the clock and the graph own rows can do to a read', () => {
  test('a bound cutting where the clone is shallow leaves two gaps that each say their own thing', async () => {
    // The reviewer's case: a merge whose second parent is newer than its first
    // parent's tip, cloned two commits deep and read with depth 2. The depth
    // bound and the shallow boundary stop at one commit, so both causes are
    // there at once, and a coverage that named one `what` twice would be
    // refused by the schema and the unit would report no gap at all.
    const fixture = await makeRepository('cut-shallow', [
      { message: 'First commit', files: { 'a.txt': 'one\n' } },
      { message: 'Second commit', files: { 'src/b.ts': 'export const b = 1;\n' } },
    ]);
    try {
      await makeBranch(fixture, 'side', { message: 'Side commit', files: { 'side.txt': 's\n' } });
      const merge = await fixture.merge('Merge side into main', 'side');
      const shallow = await shallowClone(fixture, 2);
      try {
        const stage = stageOver(new Map([['orders-api', shallow.folder]]));
        const unit = { id: historyUnitId('orders-api', merge), scope: historyScope('orders-api', merge) };
        const run = recorder(unit, { config: { depth: 2 } });
        expect(await stage.execute(unit, run.context)).toEqual({ outcome: 'draft' });

        const coverage = valuesOf(run.writes, 'coverage')[0] as unknown as CoverageValue;
        expect(coverage.complete).toBe(false);
        const named = coverage.unread.map((gap) => gap.what);
        // The schema's own rule for the list: code point order, each `what` once.
        expect(named).toEqual([...named].sort(byCodePoint));
        expect(new Set(named).size).toBe(named.length);
        expect([...coverage.unread].map((gap) => gap.reason).sort(byCodePoint)).toEqual(['budget', 'inaccessible']);
        // And the whole draft is one the schema reads, the coverage included.
        expect(validateDraft({ writes: run.writes })).toEqual({ ok: true });
      } finally {
        await shallow.dispose();
      }
    } finally {
      await fixture.dispose();
    }
  });

  test('a unit pinned at an older commit writes that commit own ancestry alone', async () => {
    const fixture = await makeRepository('older', THREE);
    try {
      const [first, second, third] = fixture.commits as [string, string, string];
      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const unit = { id: historyUnitId('orders-api', second), scope: historyScope('orders-api', second) };
      const run = recorder(unit);
      await stage.execute(unit, run.context);

      // The pinned commit is what the ancestry is read at: its descendants are
      // not the history it stands on, so nothing of the tip is written.
      expect(valuesOf(run.writes, 'commit').map((value) => value['commit'])).toEqual([first, second]);
      expect(valuesOf(run.writes, 'commit').some((value) => value['commit'] === third)).toBe(false);
      expect(valuesOf(run.writes, 'coverage')[0]).toMatchObject({ scope: unit.scope, complete: true, unread: [] });
    } finally {
      await fixture.dispose();
    }
  });

  test('a log this read can only refuse is refused, naming the record it cannot read', async () => {
    const commit = 'a'.repeat(40);
    const unit = { id: historyUnitId('orders-api', commit), scope: historyScope('orders-api', commit) };
    // The record git would write, with one thing wrong at a time: a message
    // holding the record separator reaches the reader as a second record, an
    // author time that is no whole number of seconds is no time, and a call
    // that failed names its own status and words.
    const record = (message: string, committed = '1792346906', authored = '1792346806'): string =>
      `${HISTORY_LOG_RECORD}${commit}${HISTORY_LOG_FIELD}${HISTORY_LOG_FIELD}${committed}${HISTORY_LOG_FIELD}${authored}${HISTORY_LOG_FIELD}Fixture Author${HISTORY_LOG_FIELD}First commit${HISTORY_LOG_FIELD}${message}${HISTORY_LOG_FIELD}\x00\na.txt\x00`;
    const withMessage = await fakeGit({ log: record(`a message ${HISTORY_LOG_RECORD}and this is not a record`) });
    try {
      const stage = stageOver(new Map([['orders-api', withMessage.folder]]), withMessage.reader);
      const run = recorder(unit);
      await expect(stage.execute(unit, run.context)).rejects.toThrow(/holds a record for .* which is no path list/u);
      expect(run.writes).toEqual([]);
    } finally {
      await withMessage.dispose();
    }
    const withTime = await fakeGit({ log: record('First commit', 'yesterday') });
    try {
      const stage = stageOver(new Map([['orders-api', withTime.folder]]), withTime.reader);
      await expect(stage.execute(unit, recorder(unit).context)).rejects.toThrow(new RegExp(`reads the committer time of ${commit}`));
    } finally {
      await withTime.dispose();
    }
    // A time before 1970 is a time: git counts seconds from the epoch and its
    // count may be negative there, and the fact carries the instant.
    const before1970 = await fakeGit({ log: record('First commit', '-1000000000', '-1000000000') });
    try {
      const stage = stageOver(new Map([['orders-api', before1970.folder]]), before1970.reader);
      const run = recorder(unit);
      await stage.execute(unit, run.context);
      const written = valuesOf(run.writes, 'commit')[0];
      expect(written?.['committedAt']).toBe('1938-04-24T22:13:20Z');
      expect(written?.['authoredAt']).toBe('1938-04-24T22:13:20Z');
    } finally {
      await before1970.dispose();
    }
    // And a time ISO 8601 cannot hold is refused with the commit and what the
    // read made of it, never as a bare runtime error.
    const beyond = await fakeGit({ log: record('First commit', '90000000000000', '90000000000000') });
    try {
      const stage = stageOver(new Map([['orders-api', beyond.folder]]), beyond.reader);
      await expect(stage.execute(unit, recorder(unit).context)).rejects.toThrow(new RegExp(`reads the committer time of ${commit} as "90000000000000"`));
      await expect(stage.execute(unit, recorder(unit).context)).rejects.toThrow(/ISO 8601/u);
    } finally {
      await beyond.dispose();
    }
    const failed = await fakeGit({ log: '', status: 3, stderr: 'the repository is not here' });
    try {
      const stage = stageOver(new Map([['orders-api', failed.folder]]), failed.reader);
      await expect(stage.execute(unit, recorder(unit).context)).rejects.toThrow(/exited 3/u);
      await expect(stage.execute(unit, recorder(unit).context)).rejects.toThrow(/the repository is not here/u);
    } finally {
      await failed.dispose();
    }
  });

  test('a git that cannot be run at all is named by the runtime own error', async () => {
    const commit = 'a'.repeat(40);
    const unit = { id: historyUnitId('orders-api', commit), scope: historyScope('orders-api', commit) };
    const empty = await mkdtemp(join(tmpdir(), 'madarch-history-no-git-'));
    const path = process.env['PATH'];
    try {
      // A PATH with no git in it: the call never happens, and the refusal says
      // so with the runtime's own code rather than reading it as a git that
      // answered nothing.
      process.env['PATH'] = empty;
      const stage = stageOver(new Map([['orders-api', empty]]));
      await expect(stage.execute(unit, recorder(unit).context)).rejects.toThrow(/could not be run/u);
      await expect(stage.execute(unit, recorder(unit).context)).rejects.toThrow(/ENOENT/u);
    } finally {
      if (path === undefined) delete process.env['PATH']; else process.env['PATH'] = path;
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('a repository the wiring names no folder for is refused, naming the read', async () => {
    const unknown: HistoryReader = createGitHistoryReader(() => '');
    const stage = createHistoryStage(unknown);
    const unit = { id: historyUnitId('orders-api', 'a'.repeat(40)), scope: historyScope('orders-api', 'a'.repeat(40)) };
    await expect(stage.execute(unit, recorder(unit).context)).rejects.toThrow(/has no checkout folder/u);
    await expect(stage.execute(unit, recorder(unit).context)).rejects.toThrow(/orders-api/u);
  });

  // Git itself needs the shallow file to know where a checkout's history stops:
  // with it unreadable git fails over the object the boundary hid, and the read
  // reports that object as a gap instead of throwing. A process running as root
  // reads a file whatever its mode, so a root machine skips this test and says
  // so rather than passing it with nothing asserted.
  test.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('a shallow file the process cannot open is a gap, never a lost unit', async () => {
    const fixture = await makeRepository('shallow-file', THREE);
    const shallow = await shallowClone(fixture);
    try {
      const [, second, third] = fixture.commits as [string, string, string];
      await chmod(join(shallow.folder, '.git', 'shallow'), 0o000);
      const stage = stageOver(new Map([['orders-api', shallow.folder]]));
      const unit = { id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) };
      const run = recorder(unit);
      expect(await stage.execute(unit, run.context)).toEqual({ outcome: 'draft' });
      const coverage = valuesOf(run.writes, 'coverage')[0] as unknown as CoverageValue;
      expect(coverage.complete).toBe(false);
      expect(coverage.unread).toHaveLength(1);
      expect(coverage.unread[0]?.reason).toBe('inaccessible');
      expect(coverage.unread[0]?.what).toContain(second);
    } finally {
      await shallow.dispose();
      await fixture.dispose();
    }
  });

  test('a machine git configuration and git own loader variables change no fact', async () => {
    // The fixture renames a path on its third commit: with rename detection on
    // — git's own default, and what the configuration written below asks for —
    // git answers the one path the file took, and the read asks for both the
    // path it left and the path it took. So the assertion below fails if the
    // reader stops passing --no-renames.
    const fixture = await makeRepository('environment', [
      { message: 'First commit', files: { 'a.txt': 'one\n' } },
      { message: 'Second commit', files: { 'src/b.ts': 'export const b = 1;\n' } },
    ]);
    await rm(join(fixture.folder, 'a.txt'));
    const renamed = await fixture.commit({ message: 'Rename a.txt to b.txt', files: { 'b.txt': 'one\n' } });
    const elsewhere = await makeRepository('elsewhere', [{ message: 'Another repository', files: { 'x.txt': 'x\n' } }]);
    const config = join(fixture.root, 'gitconfig');
    await writeFile(config, '[log]\n\tshowSignature = true\n[diff]\n\trenames = true\n');
    const before = { GIT_DIR: process.env['GIT_DIR'], GIT_CONFIG_GLOBAL: process.env['GIT_CONFIG_GLOBAL'] };
    try {
      const third = renamed;
      const stage = stageOver(new Map([['orders-api', fixture.folder]]));
      const unit = { id: historyUnitId('orders-api', third), scope: historyScope('orders-api', third) };
      process.env['GIT_CONFIG_GLOBAL'] = config;
      // A loader variable pointing at another repository's git directory is
      // exactly what a read run inside a worktree inherits: the reader strips it
      // (the list `src/product/git.ts` exports), so it still reads this one.
      process.env['GIT_DIR'] = join(elsewhere.folder, '.git');
      const withThem = recorder(unit);
      await stage.execute(unit, withThem.context);
      delete process.env['GIT_DIR'];
      delete process.env['GIT_CONFIG_GLOBAL'];
      const without = recorder(unit);
      await stage.execute(unit, without.context);

      expect(valuesOf(withThem.writes, 'commit')).toEqual(valuesOf(without.writes, 'commit'));
      expect(valuesOf(withThem.writes, 'coverage')).toEqual(valuesOf(without.writes, 'coverage'));
      expect(valuesOf(withThem.writes, 'commit').map((value) => value['commit'])).toEqual([...fixture.commits]);
      // A rename, as --no-renames reads it: the path it left and the path it took.
      expect(valuesOf(withThem.writes, 'commit').find((value) => value['commit'] === renamed)?.['files']).toEqual(['a.txt', 'b.txt']);
    } finally {
      if (before.GIT_DIR === undefined) delete process.env['GIT_DIR']; else process.env['GIT_DIR'] = before.GIT_DIR;
      if (before.GIT_CONFIG_GLOBAL === undefined) delete process.env['GIT_CONFIG_GLOBAL']; else process.env['GIT_CONFIG_GLOBAL'] = before.GIT_CONFIG_GLOBAL;
      await elsewhere.dispose();
      await fixture.dispose();
    }
  });

  test('a held row the stage cannot read is refused with the query that answered it', async () => {
    const repository = 'orders-api';
    const commit = 'a'.repeat(40);
    const unit = { id: historyUnitId(repository, commit), scope: historyScope(repository, commit) };
    const stage = stageOver(new Map([[repository, '/nowhere']]));
    const held = commitsHeldQuery(repository);
    const coverage = coverageHeldQuery(repository, unit.scope);
    const refused = async (rows: ReadonlyMap<string, readonly unknown[]>, pattern: RegExp): Promise<void> => {
      const run = recorder(unit, { rows });
      await expect(stage.execute(unit, run.context)).rejects.toThrow(pattern);
      expect(run.writes).toEqual([]);
    };
    // A row that is no record, a commit that is no commit, a row holding no
    // value, one commit held twice, and two coverage facts for one scope: each
    // is refused where it stands, naming the read that answered it.
    await refused(new Map([[held, ['a row, not a record']]]), /row 0 of "SELECT commit, value FROM fact WHERE kind = 'commit'/u);
    await refused(new Map([[held, [{ commit: 'HEAD', value: {} }]]]), /names the commit "HEAD"/u);
    await refused(new Map([[held, [{ commit, value: undefined }]]]), /names .* with no value/u);
    await refused(new Map([[held, [{ commit, value: {} }, { commit, value: {} }]]]), /answered .* twice/u);
    await refused(new Map([[coverage, [{ value: {} }, { value: {} }]]]), /answered 2 coverage facts/u);
    await refused(new Map([[coverage, ['not a record']]]), /row 0 of "SELECT value FROM fact WHERE kind = 'coverage'/u);
    await refused(new Map([[coverage, [{}]]]), /holds no value/u);
  });
});
