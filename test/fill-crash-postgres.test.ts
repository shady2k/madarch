/**
 * The crash-injection suite against PostgreSQL (madarch-tzte.19.6, decision
 * 0027): the same compiled binary and the same fixture chain as
 * `test/fill-crash-suite.test.ts`, on the server a deployment runs — a `pg` pool
 * instead of PGlite's one connection, pg-boss's `postgres` profile in a schema of
 * its own, and, what only a server can show, three executor processes working one
 * run at the same time.
 *
 * What the server is asked for is what the task's DONE WHEN names for it: one
 * publication per generation, no lost children, barrier recovery, stale fences
 * refused, the run's own concurrency enforced, recovery, and the starvation
 * diagnostic. The expectations are the PGlite leg's, taken from the task and from
 * decision 0027; the phases still move time by hand and never sleep.
 *
 * The server is the one `MADARCH_TEST_POSTGRES_URL` names, which CI's checks job
 * sets for the service it starts; without it every test here is skipped, and the
 * skip names that variable as its reason. Each test takes a schema pair of its
 * own — one for the fill's tables, one for the queue's — and drops both before and
 * after, so a shared server does not accumulate runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { fileURLToPath } from 'node:url';
import { PLANNED_UNITS, expectNoLostChildren, expectSettled, resumeRun } from './fill-crash-expectations.js';
import {
  CrashFixture,
  buildCrashBinary,
  lineOf,
  publicationsByGeneration,
  reportOf,
  unitOf,
  type CrashDriver,
  type PhaseOptions,
} from './fill-crash-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const connectionString = process.env['MADARCH_TEST_POSTGRES_URL'];
const SKIP = 'skipped: MADARCH_TEST_POSTGRES_URL names no PostgreSQL server in this environment';

/** One build of the compiled binary for every test in this file. */
let binary = '';
const fixtures: CrashFixture[] = [];
const running: CrashDriver[] = [];

beforeAll(() => {
  if (connectionString === undefined) return;
  binary = buildCrashBinary(mkdtempSync(join(tmpdir(), 'madarch-fill-crash-build-')), REPO_ROOT);
}, 300_000);

afterAll(async () => {
  for (const driver of running) driver.kill();
  for (const fixture of fixtures) rmSync(fixture.folder, { recursive: true, force: true });
});

/** One fixture of its own per test, so two tests never share a run or a schema. */
function fixture(): CrashFixture {
  const made = new CrashFixture(mkdtempSync(join(tmpdir(), 'madarch-fill-crash-pg-')), binary);
  fixtures.push(made);
  return made;
}

/** A driver the test must not leave behind: a paused phase is killed when the file ends. */
function starting(world: CrashFixture, phase: Parameters<CrashFixture['start']>[0], options: PhaseOptions): CrashDriver {
  const driver = world.start(phase, options);
  running.push(driver);
  return driver;
}

let schemas = 0;

/**
 * One test's own pair of schemas on the server: the fill's tables live in the
 * first (the connection carries it first on its search path), the queue's in the
 * second, so two tests of one server never share a run or a queue.
 */
function postgres(): PhaseOptions & { readonly postgres: { connectionString: string; schema: string; queueSchema: string } } {
  schemas += 1;
  const schema = `madarch_crash_fill_${String(schemas)}`;
  const queueSchema = `madarch_crash_queue_${String(schemas)}`;
  const url = connectionString as string;
  const separator = url.includes('?') ? '&' : '?';
  return { postgres: { connectionString: `${url}${separator}options=-csearch_path%3D${schema}`, schema, queueSchema } };
}

/** Drops one test's schemas, before and after it: a killed run leaves its rows behind. */
async function dropSchemas(options: PhaseOptions): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const schema of [options.postgres?.schema, options.postgres?.queueSchema]) {
      if (schema !== undefined) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  } finally {
    await client.end();
  }
}

/** Plans the fixture's run on the server and holds what the plan gave. */
async function planFixture(world: CrashFixture, options: PhaseOptions, units: readonly string[] = PLANNED_UNITS): Promise<void> {
  const plan = lineOf(await world.phase({ kind: 'plan' }, options), 'plan');
  expect(plan).toMatchObject({
    outcome: 'planned',
    run: 'running',
    units: units.map((unitId) => ({ unitId, state: 'planned', generation: 1, created: true })),
    reused: [],
    foundNothing: [],
  });
}

/** A run driven to its end on the server, holding the line it printed. */
async function drive(world: CrashFixture, options: PhaseOptions, workers = 1): Promise<Record<string, unknown>> {
  const driven = await world.phase({ kind: 'run', workers }, options);
  if (driven.code !== 0) throw new Error(`the run failed (exit ${String(driven.code)}): ${driven.stderr}`);
  return lineOf(driven, 'run');
}

describe('one run, three executor processes', () => {
  test.skipIf(connectionString === undefined)(`three executors drive the chain and every generation is published once (${SKIP})`, async () => {
    const options = postgres();
    const world = fixture();
    try {
      await dropSchemas(options);
      // Four extractor units, so three executors each have work to claim.
      world.setGraph('files', [{ id: 'a', scope: 'a' }, { id: 'b', scope: 'b' }, { id: 'c', scope: 'c' }, { id: 'd', scope: 'd' }]);
      for (const file of ['a', 'b', 'c', 'd']) world.setGraph(`symbols:${file}`, [{ symbol: file }]);
      const units = ['extract/a', 'extract/b', 'extract/c', 'extract/d', 'modules/root', 'overview/product'];
      await planFixture(world, options, units);

      const executors = [0, 1, 2].map(() => starting(world, { kind: 'run', workers: 1 }, options));
      const finished = await Promise.all(executors.map((driver) => driver.wait()));
      for (const run of finished) expect(run.code).toBe(0);
      // The three of them claimed between them at least one job per unit of the
      // run: no executor was handed a run nobody worked.
      const claims = finished.map((run) => lineOf(run, 'run').work as number);
      expect(claims.reduce((total, one) => total + one, 0)).toBeGreaterThanOrEqual(8);

      // Whatever they left standing, one more pass drives it to the run's end.
      await drive(world, options);
      const report = reportOf(await world.phase({ kind: 'report' }, options));
      expectNoLostChildren(report);
      expectSettled(report, [...units, 'modules/left', 'modules/right']);
    } finally {
      await dropSchemas(options);
    }
  }, 300_000);

  test.skipIf(connectionString === undefined)(`the run's own slots hold across three executors (${SKIP})`, async () => {
    const options = postgres();
    const world = fixture();
    const drivers: CrashDriver[] = [];
    try {
      await dropSchemas(options);
      await planFixture(world, options);
      // Two executors of two different processes stand inside a unit of their own:
      // both units are `running` at the same time, which is the run's own
      // maxInFlight of two — and no third unit may join them.
      const first = starting(world, { kind: 'run', workers: 1 }, { ...options, interrupt: { point: 'execute', mode: 'pause', unitId: 'extract/src' } });
      const second = starting(world, { kind: 'run', workers: 1 }, { ...options, interrupt: { point: 'execute', mode: 'pause', unitId: 'extract/docs' } });
      drivers.push(first, second);
      expect(await first.nextLine()).toMatchObject({ event: 'pause', point: 'execute', unitId: 'extract/src' });
      expect(await second.nextLine()).toMatchObject({ event: 'pause', point: 'execute', unitId: 'extract/docs' });

      // A third process admits as it likes: the slots are counted in a transaction
      // of the run's own row, so it takes none.
      const pass = lineOf(await world.phase({ kind: 'sweep' }, options), 'sweep');
      expect(pass).toMatchObject({ run: 'running', admitted: 0, moved: false });
      const held = reportOf(await world.phase({ kind: 'report' }, options));
      expect(held.units.filter((unit) => ['running', 'leased', 'draft', 'validating'].includes(unit.state)).map((unit) => unit.unitId).sort()).toEqual(['extract/docs', 'extract/src']);
      expect(held.units.filter((unit) => ['planned', 'ready'].includes(unit.state)).map((unit) => unit.unitId).sort()).toEqual(['modules/root', 'overview/product']);

      first.send();
      second.send();
      const released = await Promise.all([first.wait(), second.wait()]);
      for (const run of released) expect(run.code).toBe(0);
      await drive(world, options);
      expectSettled(reportOf(await world.phase({ kind: 'report' }, options)));
    } finally {
      for (const driver of drivers) driver.kill();
      await dropSchemas(options);
    }
  }, 300_000);

  test.skipIf(connectionString === undefined)(`a claim a killed worker held is recovered, and the unit is published once (${SKIP})`, async () => {
    const options = postgres();
    const world = fixture();
    try {
      await dropSchemas(options);
      await planFixture(world, options);
      const killed = await world.phase({ kind: 'run', workers: 1 }, { ...options, interrupt: { point: 'claim', mode: 'crash', unitId: 'extract/src' } });
      expect(killed.code).toBe(137);
      const crash = lineOf(killed, 'crash');
      expect(crash).toMatchObject({ point: 'claim', unitId: 'extract/src', generation: 1 });
      expect(unitOf(reportOf(await world.phase({ kind: 'report' }, options)), 'extract/src')).toMatchObject({ state: 'ready', attempt: 0 });

      await resumeRun(world, options, crash, 'failed');
      const report = reportOf(await world.phase({ kind: 'report' }, options));
      expect(unitOf(report, 'extract/src')).toMatchObject({ state: 'published', generation: 1, attempt: 1 });
      expectSettled(report);
    } finally {
      await dropSchemas(options);
    }
  }, 300_000);

  test.skipIf(connectionString === undefined)(`a split killed before its acknowledgement loses no child and the parent joins them (${SKIP})`, async () => {
    const options = postgres();
    const world = fixture();
    try {
      await dropSchemas(options);
      await planFixture(world, options);
      const killed = await world.phase({ kind: 'run', workers: 1 }, { ...options, interrupt: { point: 'split', mode: 'crash', unitId: 'modules/root' } });
      expect(killed.code).toBe(137);
      const crash = lineOf(killed, 'crash');
      expect(crash).toMatchObject({ point: 'split', unitId: 'modules/root', generation: 1 });
      const before = reportOf(await world.phase({ kind: 'report' }, options));
      expect(before.sealed.map((child) => child.childUnitId)).toEqual(['modules/left', 'modules/right']);
      expect(before.childStates.map((child) => child.state)).toEqual(['planned', 'planned']);
      expect(unitOf(before, 'modules/root').state).toBe('waiting_children');

      // Two other executors work the children the dead process sealed while the
      // run's own clock moves past the parent's lease: the barrier is the run's,
      // not one process's.
      const helpers = [starting(world, { kind: 'run', workers: 1 }, options), starting(world, { kind: 'run', workers: 1 }, options)];
      const recovered = await resumeRun(world, options, crash, 'failed');
      expect(recovered.code).toBe(0);
      for (const helper of helpers) expect((await helper.wait()).code).toBe(0);

      await drive(world, options);
      const report = reportOf(await world.phase({ kind: 'report' }, options));
      expectNoLostChildren(report);
      expectSettled(report);
    } finally {
      await dropSchemas(options);
    }
  }, 300_000);

  test.skipIf(connectionString === undefined)(`a worker that lost its fence publishes nothing (${SKIP})`, async () => {
    const options = postgres();
    const world = fixture();
    const drivers: CrashDriver[] = [];
    try {
      await dropSchemas(options);
      await planFixture(world, options);
      // The first attempt stands in validation and holds the generation's first
      // fencing token.
      const late = starting(world, { kind: 'run', workers: 1 }, { ...options, interrupt: { point: 'validation', mode: 'pause', unitId: 'extract/src' } });
      drivers.push(late);
      const paused = await late.nextLine();
      expect(paused).toMatchObject({ event: 'pause', point: 'validation', unitId: 'extract/src' });

      // The claim that worker held is settled, as the queue's own maintenance
      // settles a claim whose worker went quiet, and the run's clock moves past
      // the lease the attempt took: the run retries its generation.
      expect(lineOf(await world.phase({ kind: 'recover', job: paused.job as never }, options), 'recover')).toMatchObject({ settled: 'failed' });
      world.advanceClock(2_000);
      const pass = lineOf(await world.phase({ kind: 'sweep' }, options), 'sweep');
      expect(pass).toMatchObject({ run: 'running' });
      expect(pass.swept).toBe(1);
      world.advanceClock(2_000);

      // A second executor takes the next fencing token, drafts and stands in
      // validation: the generation is the same one, the token is not.
      const second = starting(world, { kind: 'run', workers: 1 }, { ...options, interrupt: { point: 'validation', mode: 'pause', unitId: 'extract/src' } });
      drivers.push(second);
      expect(await second.nextLine()).toMatchObject({ event: 'pause', point: 'validation', unitId: 'extract/src' });
      expect(unitOf(reportOf(await world.phase({ kind: 'report' }, options)), 'extract/src')).toMatchObject({ state: 'validating', attempt: 2, fence: 2 });

      // The worker that lost its turn comes back: what it publishes carries the
      // token it lost, and the machine refuses it.
      late.send();
      expect((await late.wait()).code).toBe(0);
      second.send();
      expect((await second.wait()).code).toBe(0);
      await drive(world, options);

      const report = reportOf(await world.phase({ kind: 'report' }, options));
      const refusals = report.progress.filter((event) => event.summary.includes('fence-current'));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({ unitId: 'extract/src', kind: 'unit-blocked' });
      expect(publicationsByGeneration(report).get('extract/src/1')).toHaveLength(1);
      expectSettled(report);
    } finally {
      for (const driver of drivers) driver.kill();
      await dropSchemas(options);
    }
  }, 300_000);

  test.skipIf(connectionString === undefined)(`a disabled producer blocks the run with its starvation path (${SKIP})`, async () => {
    const options = postgres();
    const world = fixture();
    try {
      await dropSchemas(options);
      world.manifest([
        'schemaVersion: 1',
        'id: crash-fixture',
        'name: The crash suite fixture',
        'fill:',
        '  stages:',
        '    extract:',
        '      enabled: false',
        '',
      ].join('\n'));
      const plan = lineOf(await world.phase({ kind: 'plan' }, options), 'plan');
      expect(plan).toMatchObject({ outcome: 'blocked', run: 'blocked' });
      const starvation = plan.starvation as readonly { consumer: string; capability: string; producer: string; reason: string; path: string }[];
      expect(starvation.map((path) => [path.consumer, path.capability, path.producer, path.reason])).toEqual([['modules', 'file-facts', 'extract', 'producer-disabled']]);
      const report = reportOf(await world.phase({ kind: 'report' }, options));
      expect(report.run?.state).toBe('blocked');
      expect(report.chain?.state).toBe('quiescent');
      expect(report.units).toEqual([]);
    } finally {
      await dropSchemas(options);
    }
  }, 300_000);
});
