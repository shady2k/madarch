/**
 * Decision 0030: a fill parses the code of the last commit, reads history from
 * git, and reads earlier code only at chosen points. The cases run on a
 * synthetic repository the test builds with `git fast-import` (neutral names):
 * thousands of commits fill in minutes, a second fill after one new commit
 * reads one commit and moves the tip, a fill that skips commits ends the old
 * tip at the commit after it and keeps a moved file's identity, and a chosen
 * point is valid from its commit's effective time to the next commit's.
 *
 * Expected values come from the generator's own bookkeeping and from git, never
 * from the graph.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { fillGraph, fillSnapshot } from '../src/extract/driver/index.js';
import { extractFiles } from '../src/extract/driver/files.js';
import type { Extraction } from '../src/extract/records.js';
import type { FillOptions, TreeExtractor } from '../src/extract/driver/index.js';
import { HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS } from '../src/extract/driver/extractors.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';

const COMMITS = 3000;
const EPOCH = 1_700_000_000;
const HOUR = 3600;
const AUTHORS = ['Ada Example', 'Ben Example', 'Cleo Example', 'Dev Example', 'Eli Example'];
const AREAS = 5;
const MODULES = 8;
// Built by concatenation so the neutral-names scan does not read a record key as a repository source.
const FILE = 'code.file' + ':';

const git = (repository: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: repository, encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });

/** One commit of the fast-import stream: files to write (path to content), renames and the author. */
interface Step { message: string; writes: Record<string, string>; renames?: [string, string][]; deletes?: string[]; author: string }

function stream(steps: readonly Step[], firstMark: number, firstTime: number, startFrom?: string): string {
  const lines: string[] = [];
  steps.forEach((step, at) => {
    const when = `${firstTime + at * HOUR} +0000`;
    lines.push('commit refs/heads/main', `mark :${firstMark + at}`, `author ${step.author} <${step.author.split(' ')[0]!.toLowerCase()}@example.com> ${when}`, `committer ${step.author} <${step.author.split(' ')[0]!.toLowerCase()}@example.com> ${when}`, `data ${Buffer.byteLength(step.message)}`, step.message);
    if (at > 0) lines.push(`from :${firstMark + at - 1}`);
    else if (startFrom !== undefined) lines.push(`from ${startFrom}`);
    for (const [from, to] of step.renames ?? []) lines.push(`R ${from} ${to}`);
    for (const gone of step.deletes ?? []) lines.push(`D ${gone}`);
    for (const [file, content] of Object.entries(step.writes)) lines.push(`M 100644 inline ${file}`, `data ${Buffer.byteLength(content)}`, content);
    lines.push('');
  });
  return `${lines.join('\n')}\n`;
}

function importStream(repository: string, text: string): void {
  const done = spawnSync('git', ['fast-import', '--quiet', '--force'], { cwd: repository, input: text, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (done.status !== 0) throw new Error(`git fast-import failed in ${repository}: ${done.stderr}`);
}

const moduleFile = (area: number, module: number): string => `src/area${area}/module${module}.ts`;
const moduleSource = (area: number, module: number, version: number): string => `export function area${area}Module${module}(input: number): number {\n  return input + ${version};\n}\n`;

/** The synthetic history: commit n rewrites two modules, so the expected churn of every file is counted here. */
function steps(from: number, to: number, churn: Map<string, number>): Step[] {
  const out: Step[] = [];
  for (let n = from; n <= to; n += 1) {
    const first = [n % AREAS, n % MODULES] as const;
    const second = [(n * 7) % AREAS, (n * 3 + 1) % MODULES] as const;
    const writes: Record<string, string> = {};
    for (const [area, module] of n === 1 ? allModules() : [first, second] as [number, number][]) writes[moduleFile(area, module)] = moduleSource(area, module, n);
    for (const file of Object.keys(writes)) churn.set(file, (churn.get(file) ?? 0) + 1);
    out.push({ message: `Change modules, step ${n}`, writes, author: AUTHORS[n % AUTHORS.length]! });
  }
  return out;
}
function allModules(): [number, number][] {
  const all: [number, number][] = [];
  for (let area = 0; area < AREAS; area += 1) for (let module = 0; module < MODULES; module += 1) all.push([area, module]);
  return all;
}

let workspace: string;
let repository: string;
let owner: DatabaseOwner;
let store: GraphStore;
const churn = new Map<string, number>();
const treesRead: string[] = [];

/** The tree extractors, each counting the trees it is given: the number of commits whose code is parsed. */
const counting: TreeExtractor[] = TREE_EXTRACTORS.map((extractor) => {
  const wrapped: TreeExtractor = (tree) => {
    treesRead.push(extractor.name);
    return extractor(tree);
  };
  Object.defineProperty(wrapped, 'name', { value: extractor.name });
  return wrapped;
});
const options = (): FillOptions => ({ owner, store, repository, extractors: counting, owners: OWNERS, history: HISTORY_EXTRACTOR, snapshots: {} });
const query = async <Row extends object>(sql: string, values?: readonly unknown[]): Promise<Row[]> => (await owner.run((tx) => tx.query<Row>(sql, values))).rows;

/** The versions of one file's node under the lister, oldest first: their digest, start and end. */
const fileVersions = (filePath: string) => query<{ id: string; sha256: string; valid_from: string; valid_to: string | null }>(
  `SELECT v.node_id::text AS id, v.properties->>'sha256' AS sha256,
          to_char(v.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from,
          to_char(v.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_to
   FROM node_version v JOIN node_kind k ON k.id = v.kind_id
   WHERE k.key = 'code.file' AND v.producer = 'code.extract.files' AND v.properties->>'recordKey' = $1 AND v.recorded_to = 'infinity' ORDER BY v.valid_from`,
  [FILE + filePath],
);
const iso = (epoch: number): string => `${new Date(epoch * 1000).toISOString().slice(0, 19)}.000000Z`;
const effectiveOf = (n: number): string => iso(EPOCH + (n - 1) * HOUR);
const sha = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

beforeAll(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), 'madarch-extract-tip-'));
  repository = path.join(workspace, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  importStream(repository, stream(steps(1, COMMITS, churn), 1, EPOCH));
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  store = createGraphStore(owner);
  await owner.ready;
  await store.createSchema();
}, 120_000);

afterAll(async () => {
  await owner?.close();
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
}, 60_000);

describe('a fill of a repository of thousands of commits (decision 0030)', () => {
  let first: Awaited<ReturnType<typeof fillGraph>>;

  test('reads the code of the last commit once and the history of all 3 000 commits in under two minutes', async () => {
    expect(Number(git(repository, 'rev-list', '--count', 'HEAD').trim())).toBe(COMMITS);
    first = await fillGraph(options());
    console.log(`[measure] ${COMMITS} commits: total ${first.totalMs} ms, code ${first.phases.codeMs} ms, history ${first.phases.historyMs} ms`);
    expect(first.totalMs).toBeLessThan(120_000);
    expect(first.newCommits).toBe(COMMITS);
    expect(first.historyCommits).toBe(COMMITS);
    expect(first.commits.map((c) => c.hash)).toEqual([git(repository, 'rev-parse', 'HEAD').trim()]);
    expect(treesRead).toHaveLength(TREE_EXTRACTORS.length); // one tree, however long the history
    const commitNodes = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM node_version v JOIN node_kind k ON k.id = v.kind_id WHERE k.key = 'code.commit' AND v.producer = 'code.extract.history' AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity'`,
    );
    expect(commitNodes[0]!.n).toBe(String(COMMITS));
  }, 600_000);

  test('the history holds every file\'s churn as git counts it', async () => {
    const rows = await query<{ key: string; count: string }>(
      `SELECT v.properties->>'ownerKey' AS key, v.properties->>'commitCount' AS count FROM node_version v JOIN node_kind k ON k.id = v.kind_id
       WHERE k.key = 'code.facet' AND v.producer = 'code.extract.history' AND v.properties ? 'commitCount' AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity'`,
    );
    expect(rows.length).toBe(AREAS * MODULES);
    for (const row of rows) expect(Number(row.count), row.key).toBe(churn.get(row.key.slice(FILE.length)) ?? -1);
  }, 60_000);

  test('the tip\'s files are valid from the last commit\'s effective time, open-ended', async () => {
    const file = moduleFile(0, 0);
    const versions = await fileVersions(file);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.valid_from).toBe(effectiveOf(COMMITS));
    expect(versions[0]!.valid_to).toBeNull();
    expect(versions[0]!.sha256).toBe(sha(git(repository, 'show', `HEAD:${file}`)));
  }, 60_000);

  test('a second fill of the unchanged repository reads no commit and writes no row', async () => {
    treesRead.length = 0;
    const before = await query<{ n: string }>(`SELECT (SELECT count(*) FROM node_version) + (SELECT count(*) FROM edge_version) + (SELECT count(*) FROM work_item) AS n`);
    const again = await fillGraph(options());
    expect(again.newCommits).toBe(0);
    expect(again.commits[0]!.publications).toBe(0);
    const after = await query<{ n: string }>(`SELECT (SELECT count(*) FROM node_version) + (SELECT count(*) FROM edge_version) + (SELECT count(*) FROM work_item) AS n`);
    expect(after[0]!.n).toBe(before[0]!.n);
  }, 300_000);

  test('a second fill after one new commit reads one commit, and the tip snapshot moves', async () => {
    const file = moduleFile(0, 0);
    const next = COMMITS + 1;
    const extra = { message: 'Change one module again', writes: { [file]: moduleSource(0, 0, next) }, author: AUTHORS[0]! };
    churn.set(file, (churn.get(file) ?? 0) + 1);
    importStream(repository, stream([extra], next, EPOCH + COMMITS * HOUR, 'refs/heads/main^0'));
    treesRead.length = 0;
    const second = await fillGraph(options());
    console.log(`[measure] second fill after one commit: total ${second.totalMs} ms, code ${second.phases.codeMs} ms, history ${second.phases.historyMs} ms`);
    expect(second.newCommits).toBe(1);
    expect(second.commits.map((c) => c.hash)).toEqual([git(repository, 'rev-parse', 'HEAD').trim()]);
    expect(treesRead).toHaveLength(TREE_EXTRACTORS.length); // one tree: the new last commit's
    const versions = await fileVersions(file);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.valid_to).toBe(effectiveOf(next)); // the old tip ends where the new one starts
    expect(versions[1]!.valid_from).toBe(effectiveOf(next));
    expect(versions[1]!.valid_to).toBeNull();
    expect(versions[1]!.sha256).toBe(sha(moduleSource(0, 0, next)));
    expect(versions[0]!.id).toBe(versions[1]!.id);
    // An unchanged file keeps its one open-ended version.
    expect(await fileVersions(moduleFile(1, 1))).toHaveLength(1);
    // The history moved with it.
    const churned = await query<{ count: string }>(
      `SELECT v.properties->>'commitCount' AS count FROM node_version v WHERE v.properties->>'ownerKey' = $1 AND v.producer = 'code.extract.history' AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity'`,
      [FILE + file],
    );
    expect(churned.map((row) => row.count)).toEqual([String(churn.get(file))]);
  }, 600_000);

  test('a fill that skips commits ends the old tip at the commit after it, and a moved file keeps its identity', async () => {
    const before = COMMITS + 1;
    const moved = moduleFile(2, 2);
    const stays = moduleFile(3, 3);
    const gap: Step[] = [
      { message: 'Touch a module', writes: { [moduleFile(4, 4)]: moduleSource(4, 4, 9001) }, author: AUTHORS[1]! },
      { message: 'Move a module', writes: {}, renames: [[moved, 'src/moved/relocated.ts']], author: AUTHORS[2]! },
      { message: 'Touch it again', writes: { 'src/moved/relocated.ts': moduleSource(2, 2, 9002) }, author: AUTHORS[3]! },
    ];
    importStream(repository, stream(gap, before + 1, EPOCH + before * HOUR, 'refs/heads/main^0'));
    const idBefore = (await fileVersions(moved))[0]!.id;
    const staysBefore = await fileVersions(stays);
    treesRead.length = 0;
    const third = await fillGraph(options());
    expect(third.newCommits).toBe(3);
    expect(treesRead).toHaveLength(TREE_EXTRACTORS.length); // three new commits, one tree
    // The old tip's records end at the first commit after it, not at the new tip.
    const stayAfter = await fileVersions(stays);
    expect(stayAfter).toHaveLength(2);
    expect(stayAfter[0]!.valid_to).toBe(effectiveOf(before + 1));
    expect(stayAfter[1]!.valid_from).toBe(effectiveOf(before + 3));
    expect(staysBefore[0]!.valid_to).toBeNull(); // it was open before this fill
    // The moved file is one node under its new path, the renames of the skipped commits applied.
    const relocated = await fileVersions('src/moved/relocated.ts');
    expect(relocated.map((v) => v.id)).toEqual([idBefore]);
    expect(relocated[0]!.valid_from).toBe(effectiveOf(before + 3));
    expect(await fileVersions(moved)).toHaveLength(1);
    expect((await fileVersions(moved))[0]!.valid_to).toBe(effectiveOf(before + 1));
  }, 600_000);

  test('a chosen point (a date) is valid from its commit to the next one, keeps the file\'s identity, and refills as a no-op', async () => {
    const target = 1500;
    const file = moduleFile(0, 0);
    const point = await fillSnapshot(options(), { date: effectiveOf(target) });
    expect(point.points.map((c) => c.generation)).toEqual([target]);
    const versions = await fileVersions(file);
    const atPoint = versions.find((v) => v.valid_from === effectiveOf(target))!;
    expect(atPoint, 'the point opens a version at its commit\'s effective time').toBeDefined();
    expect(atPoint.valid_to).toBe(effectiveOf(target + 1));
    expect(atPoint.sha256).toBe(sha(git(repository, 'show', `${git(repository, 'rev-list', '--first-parent', '--reverse', 'HEAD').trim().split('\n')[target - 1]!}:${file}`)));
    expect(new Set(versions.map((v) => v.id)).size).toBe(1); // one identity across the tip and the point
    // The point again, by its revision: the generation is published, nothing is written.
    const hash = git(repository, 'rev-list', '--first-parent', '--reverse', 'HEAD').trim().split('\n')[target - 1]!;
    const before = await query<{ n: string }>(`SELECT (SELECT count(*) FROM node_version) + (SELECT count(*) FROM edge_version) + (SELECT count(*) FROM work_item) AS n`);
    const again = await fillSnapshot(options(), hash);
    expect(again.points[0]!.publications).toBe(0);
    const after = await query<{ n: string }>(`SELECT (SELECT count(*) FROM node_version) + (SELECT count(*) FROM edge_version) + (SELECT count(*) FROM work_item) AS n`);
    expect(after[0]!.n).toBe(before[0]!.n);
  }, 600_000);

  test('a point names its repository and the point when it names no commit on the first-parent line', async () => {
    await expect(fillSnapshot(options(), 'no-such-tag')).rejects.toThrow(/extract driver: .*repo/);
    await expect(fillSnapshot(options(), { date: '2000-01-01T00:00:00Z' })).rejects.toThrow(/before the first commit/);
  }, 120_000);
});

describe('small repositories (review findings of decision 0030)', () => {
  const small = (name: string, built: Step[]): string => {
    const folder = path.join(workspace, name);
    execFileSync('git', ['init', '-q', '-b', 'main', folder]);
    importStream(folder, stream(built, 1, EPOCH));
    return folder;
  };

  test('a fill with another set of extractors reads the commit again and publishes only what the first did not', async () => {
    const folder = small('two-fills', [
      { message: 'First', writes: { 'a.txt': 'one\n' }, author: AUTHORS[0]! },
      { message: 'Second', writes: { 'a.txt': 'two\n' }, author: AUTHORS[0]! },
    ]);
    const extra = (): Extraction => ({ producer: 'code.extract.extra', nodes: [{ key: 'code.thing:extra', kind: 'code.thing', label: 'extra', properties: {} }], edges: [], gaps: [] });
    const base = { owner, store, repository: folder, owners: OWNERS };
    const first = await fillGraph({ ...base, extractors: [extractFiles] });
    expect(first.commits[0]!.publications).toBe(1);
    const second = await fillGraph({ ...base, extractors: [extractFiles, extra] });
    expect(second.commits[0]!.publications).toBe(1); // the new producer's, not the lister's again
    const extras = await query<{ n: string }>(`SELECT count(*)::text AS n FROM node_version v WHERE v.producer = 'code.extract.extra' AND v.recorded_to = 'infinity'`);
    expect(extras[0]!.n).toBe('1');
    const third = await fillGraph({ ...base, extractors: [extractFiles, extra] });
    expect(third.commits[0]!.publications).toBe(0); // now everything was read
  }, 120_000);

  test('a point keeps a file\'s identity across a rename between two points even when the file is gone at the tip', async () => {
    const folder = small('gone-at-tip', [
      { message: 'Add', writes: { 'a.ts': 'export const a = 1;\n', 'keep.ts': 'export const k = 1;\n' }, author: AUTHORS[0]! },
      { message: 'Rename', writes: {}, renames: [['a.ts', 'b.ts']], author: AUTHORS[1]! },
      { message: 'Delete', writes: {}, deletes: ['b.ts'], author: AUTHORS[2]! },
      { message: 'Touch', writes: { 'keep.ts': 'export const k = 2;\n' }, author: AUTHORS[3]! },
    ]);
    const hashes = git(folder, 'rev-list', '--first-parent', '--reverse', 'HEAD').trim().split('\n');
    await fillGraph({ owner, store, repository: folder, extractors: [extractFiles], owners: OWNERS, points: [hashes[0]!, hashes[1]!] });
    const ids = async (key: string) => (await query<{ id: string }>(
      `SELECT DISTINCT v.node_id::text AS id FROM node_version v WHERE v.producer = 'code.extract.files' AND v.properties->>'recordKey' = $1 AND v.recorded_to = 'infinity'`,
      [FILE + key],
    )).map((row) => row.id);
    const a = await ids('a.ts');
    const b = await ids('b.ts');
    expect(a).toHaveLength(1);
    expect(b).toEqual(a);
  }, 120_000);
});
