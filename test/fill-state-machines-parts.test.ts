/**
 * The state-machines stage's own parts, read without a fill (madarch-8bdc.2.4):
 * the plan's four answers (a new file, a file read at the pinned blob, a
 * published path the commit lost, a file whose node the snapshot has not
 * published), a unit's four unread answers (a path the tree does not hold, a
 * file above the cap, bytes that are not UTF-8, a source the reader refuses),
 * and the row reader that turns the plan's read back into rows it refuses
 * field by field.
 *
 * The fixtures are the test's own: a throwaway git repository with the bytes
 * each case names, and a read reader that answers the two reads the plan makes.
 * No fill runs here; the acceptance of a run is the other file's.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageGraphReader, type StageUnit } from '../src/fill/stage.js';
import { staticGraphReaderOf, staticStageContext, staticStageSourceOf, type StaticGraphReader } from '../src/fill/stages/static-context.js';
import {
  createStateMachinesStage, publishedMachinesRead, publishedMachinesRows, STATE_MACHINES_STAGE_ID,
} from '../src/fill/stages/state-machines.js';
import { nodesOfKind } from './fill-static-drafts.js';

const REPOSITORY = 'shop';

/** One throwaway repository the test commits into, with the identity and date every commit of it carries. */
interface Fixture {
  readonly root: string;
  write(path: string, bytes: Uint8Array | string): void;
  commit(): string;
}

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'madarch-state-machines-'));
  folders.push(root);
  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: root, encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'State Fixture', GIT_AUTHOR_EMAIL: 'state@example.invalid',
      GIT_COMMITTER_NAME: 'State Fixture', GIT_COMMITTER_EMAIL: 'state@example.invalid',
      GIT_AUTHOR_DATE: '2024-04-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-04-01T00:00:00Z',
    },
  }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'State Fixture');
  git('config', 'user.email', 'state@example.invalid');
  return {
    root,
    write(path: string, bytes: Uint8Array | string): void {
      const at = join(root, path);
      mkdirSync(join(at, '..'), { recursive: true });
      writeFileSync(at, bytes);
    },
    commit(): string {
      git('add', '-A');
      git('commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD');
    },
  };
}

/** A read reader that answers the two reads the plan makes, and refuses any other. */
function planReader(answers: { readonly files: readonly { readonly path: string; readonly blob: string }[]; readonly coverage: readonly { readonly kind: 'coverage'; readonly file: string; readonly blob: string }[] }): StageGraphReader {
  return {
    async query(text: string): Promise<readonly unknown[]> {
      const read = JSON.parse(text) as { readonly read?: string };
      if (read.read === 'stage-1-published-tree') return answers.files.map((file) => ({ kind: 'file', repository: REPOSITORY, path: file.path, blob: file.blob }));
      if (read.read === 'stage-1-published-repository') return [];
      if (read.read === 'stage-4-published-resolution') return [];
      if (read.read === 'stage-3-published-coverage') return [];
      if (read.read === 'stage-3-published-gaps') return [];
      if (read.read === 'stage-3-published-imports') return [];
      if (read.read === 'stage-5-published-containment') return [];
      if (read.read === 'stage-state-machines-published') return [...answers.coverage];
      throw new Error(`the test's reader answers no read ${text}`);
    },
  };
}

/** The graph reader one unit's context holds, over a store this test does not use: the unit reads no graph. */
const noGraph: StaticGraphReader = {
  async byKey() { throw new Error('the state-machines unit reads no key'); },
  async byGlobalName() { throw new Error('the state-machines unit reads no global name'); },
  async neighbourhood() { throw new Error('the state-machines unit reads no neighbourhood'); },
};

/** One unit's context: the pinned repository's path-scoped answers, and no graph. */
async function unitContext(source: Awaited<ReturnType<typeof staticStageSourceOf>>, unit: StageUnit) {
  const writes: Parameters<StageContext['draft']['write']>[0][] = [];
  const context: StageContext = {
    unit,
    config: { id: STATE_MACHINES_STAGE_ID, version: 1, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
    graph: planReader({ files: [], coverage: [] }),
    static: staticStageContext(source, noGraph),
    draft: { write: (entry) => { writes.push(entry); }, writes: () => ({ writes }) },
    progress: () => undefined,
    signal: new AbortController().signal,
  };
  return { context, writes };
}

/** One coverage node's properties from a unit's writes, refused where the unit wrote none. */
function coverageOf(writes: readonly Parameters<StageContext['draft']['write']>[0][]): Record<string, unknown> {
  const nodes = nodesOfKind(writes as never, 'code.coverage');
  expect(nodes.length).toBe(1);
  return nodes[0]!.properties;
}

describe('the stage\'s declaration', () => {
  test('names itself, reads the file facts, and produces the six kinds it writes', () => {
    const stage = createStateMachinesStage(createGitSnapshotSource([]));
    expect(stage.id).toBe('state-machines');
    expect(stage.version).toBe(1);
    expect(stage.staticReading).toBe(true);
    expect(stage.consumes).toEqual({ required: [{ capability: 'file', scope: 'repository', freshness: 'current' }], optional: [] });
    expect(stage.produces).toEqual([
      { kind: 'contains', schemaVersion: 1, scope: 'file' },
      { kind: 'coverage', schemaVersion: 1, scope: 'file' },
      { kind: 'declares', schemaVersion: 1, scope: 'file' },
      { kind: 'state', schemaVersion: 1, scope: 'file' },
      { kind: 'state-machine', schemaVersion: 1, scope: 'file' },
      { kind: 'transition', schemaVersion: 1, scope: 'file' },
    ]);
    expect(stage.defaults).toEqual({ enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} });
  });
});

describe('the state-machines stage\'s plan', () => {
  test('plans a source file whose blob moved, and none whose blob the stage read', async () => {
    const f = fixture();
    f.write('src/state.ts', 'export const transitions = { idle: { go: "done" } };\n');
    f.write('README.md', '# Shop\n');
    const commit = f.commit();
    const source = createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root: f.root, commit }]);
    const stage = createStateMachinesStage(source);
    const blob = execFileSync('git', ['rev-parse', `${commit}:src/state.ts`], { cwd: f.root, encoding: 'utf8' }).trim();
    const files = [{ path: 'README.md', blob: blob }, { path: 'src/state.ts', blob }];
    const first = await stage.plan(planReader({ files, coverage: [] }));
    expect(first).toEqual({ units: [{ id: `file:${REPOSITORY}:src/state.ts`, scope: `${REPOSITORY}:src/state.ts` }], coverage: 'planned' });
    const second = await stage.plan(planReader({ files, coverage: [{ kind: 'coverage', file: 'src/state.ts', blob }] }));
    expect(second).toEqual({ units: [], coverage: 'planned' });
  }, 60_000);

  test('plans the retraction of a published path the commit no longer holds', async () => {
    const f = fixture();
    f.write('src/state.ts', 'export const transitions = { idle: { go: "done" } };\n');
    const commit = f.commit();
    const source = createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root: f.root, commit }]);
    const stage = createStateMachinesStage(source);
    const plan = await stage.plan(planReader({
      files: [{ path: 'src/state.ts', blob: 'a'.repeat(40) }],
      coverage: [{ kind: 'coverage', file: 'src/gone.ts', blob: 'b'.repeat(40) }],
    }));
    // The file the tree holds is planned again (its blob is not the one the coverage names), and the
    // published path the commit lost is planned as a unit that publishes nothing and so retracts.
    expect(plan.units.map((unit) => unit.id).sort()).toEqual([`file:${REPOSITORY}:src/gone.ts`, `file:${REPOSITORY}:src/state.ts`].sort());
  }, 60_000);

  test('plans nothing while a source file\'s node has not been published, and says so', async () => {
    const f = fixture();
    f.write('src/state.ts', 'export const transitions = { idle: { go: "done" } };\n');
    const commit = f.commit();
    const source = createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root: f.root, commit }]);
    const stage = createStateMachinesStage(source);
    expect(await stage.plan(planReader({ files: [], coverage: [] }))).toEqual({ units: [], coverage: 'nothing-found' });
  }, 60_000);
});

describe('the state-machines stage\'s unit', () => {
  test('publishes a coverage gap for a file above the static reading cap, and no machine', async () => {
    const f = fixture();
    f.write('src/huge.ts', `${'a'.repeat(1_100_000)}\n`);
    const commit = f.commit();
    const source = await staticStageSourceOf(createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root: f.root, commit }]), REPOSITORY);
    const unit = { id: `file:${REPOSITORY}:src/huge.ts`, scope: `${REPOSITORY}:src/huge.ts` };
    const { context, writes } = await unitContext(source, unit);
    const stage = createStateMachinesStage(createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root: f.root, commit }]));
    expect(await stage.execute(unit, context)).toEqual({ outcome: 'draft' });
    const coverage = coverageOf(writes);
    expect(coverage['complete']).toBe(false);
    expect(coverage['read']).toEqual([]);
    expect((coverage['unread'] as readonly { readonly what: string; readonly reason: string }[]).map((gap) => gap.reason)).toEqual(['too-large']);
    expect(nodesOfKind(writes as never, 'code.state-machine')).toEqual([]);
  }, 60_000);

  test('publishes a coverage gap for bytes that are not UTF-8, and none for a file the tree does not hold', async () => {
    const f = fixture();
    f.write('src/broken.ts', new Uint8Array([0xff, 0xfe, 0x00]));
    f.write('src/state.ts', 'export const transitions = { idle: { go: "done" } };\n');
    const commit = f.commit();
    const sources = createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root: f.root, commit }]);
    const source = await staticStageSourceOf(sources, REPOSITORY);
    const stage = createStateMachinesStage(sources);
    const broken = { id: `file:${REPOSITORY}:src/broken.ts`, scope: `${REPOSITORY}:src/broken.ts` };
    const read = await unitContext(source, broken);
    expect(await stage.execute(broken, read.context)).toEqual({ outcome: 'draft' });
    const coverage = coverageOf(read.writes);
    expect(coverage['complete']).toBe(false);
    expect(coverage['read']).toEqual([]);
    const gaps = coverage['unread'] as readonly { readonly what: string; readonly reason: string }[];
    expect(gaps.map((gap) => gap.reason)).toEqual(['unsupported']);
    expect(gaps[0]!.what).toContain('src/broken.ts');
    // A path the pinned commit does not hold publishes nothing at all: its publication retracts.
    const gone = { id: `file:${REPOSITORY}:src/gone.ts`, scope: `${REPOSITORY}:src/gone.ts` };
    const absent = await unitContext(source, gone);
    expect(await stage.execute(gone, absent.context)).toEqual({ outcome: 'draft' });
    expect(absent.writes).toEqual([]);
  }, 60_000);

  test('publishes the refusal of a table the reader cannot classify as a gap with its file and line', async () => {
    const f = fixture();
    f.write('src/state.ts', 'export const transitions = { idle: [choose()] };\n');
    const commit = f.commit();
    const sources = createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root: f.root, commit }]);
    const source = await staticStageSourceOf(sources, REPOSITORY);
    const stage = createStateMachinesStage(sources);
    const unit = { id: `file:${REPOSITORY}:src/state.ts`, scope: `${REPOSITORY}:src/state.ts` };
    const read = await unitContext(source, unit);
    expect(await stage.execute(unit, read.context)).toEqual({ outcome: 'draft' });
    const coverage = coverageOf(read.writes);
    const gaps = coverage['unread'] as readonly { readonly what: string; readonly reason: string }[];
    expect(gaps.map((gap) => gap.reason)).toEqual(['error']);
    expect(gaps[0]!.what.startsWith('src/state.ts:')).toBe(true);
    expect(nodesOfKind(read.writes as never, 'code.state-machine')).toEqual([]);
  }, 60_000);
});

describe('the plan\'s read, read back', () => {
  test('reads the rows it defines, and refuses every row that is not one', () => {
    const read = publishedMachinesRead(REPOSITORY);
    expect(JSON.parse(read)).toEqual({ read: 'stage-state-machines-published', repository: REPOSITORY });
    expect(publishedMachinesRows([{ kind: 'coverage', file: 'src/state.ts', blob: 'a'.repeat(40) }], REPOSITORY, read)).toEqual([
      { kind: 'coverage', file: 'src/state.ts', blob: 'a'.repeat(40) },
    ]);
    expect(() => publishedMachinesRows(['row'], REPOSITORY, read)).toThrow(/"row" is no row/);
    expect(() => publishedMachinesRows([{ kind: 'file', file: 'src/state.ts', blob: 'a'.repeat(40) }], REPOSITORY, read)).toThrow(/its kind is "file"/);
    expect(() => publishedMachinesRows([{ kind: 'coverage', file: '', blob: 'a'.repeat(40) }], REPOSITORY, read)).toThrow(/no repository path/);
    expect(() => publishedMachinesRows([{ kind: 'coverage', file: 'src/state.ts', blob: 'ABC' }], REPOSITORY, read)).toThrow(/no blob id/);
    expect(() => publishedMachinesRows([{ kind: 'coverage', file: 'src/state.ts', blob: 'a'.repeat(40), extra: 1 }], REPOSITORY, read)).toThrow(/it holds "extra"/);
  });
});
