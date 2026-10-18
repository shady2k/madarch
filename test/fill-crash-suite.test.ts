/**
 * The crash-injection suite on persistent PGlite (madarch-tzte.19.6, decision
 * 0027): the compiled binary of `test/fill-crash-driver.ts` drives the fill's
 * fixture chain — extractor → splitting unit → children → parent join → consumer
 * — on one PGlite data folder, and the test kills it around the claim, around the
 * split, inside the publication and around the acknowledgement, submits duplicate
 * and late results, turns an empty query non-empty, cancels a run while a unit
 * validates and disables a required producer.
 *
 * What each expectation is taken from: the task's own DONE WHEN (one publication
 * per generation, no lost children, barrier recovery, stale fences refused,
 * recovery, the starvation diagnostic) and decision 0027 (the queue's recovery
 * rules, the unit's own retries, one publication per generation, the publication
 * as one transaction of the owner). Nothing here is read from the modules under
 * test: the states, the counts and the paths are the decision's words.
 *
 * Time is a seam the suite moves by hand — the clock is a file every phase reads,
 * and nothing sleeps — and the fixture's graph and inputs are files beside it, so
 * a test moves the pinned snapshot or a unit's named inputs while a phase is
 * frozen in the middle of a unit. PGlite serves one process at a time, so the
 * phases run in sequence here; `test/fill-crash-postgres.test.ts` runs three
 * executors at once against a server, where the same scenarios are judged with
 * real concurrency beside them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byCodePoint } from '../src/model/order.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLANNED_UNITS, expectOnePublicationPerGeneration, expectSettled, resumeRun } from './fill-crash-expectations.js';
import {
  CrashFixture,
  buildCrashBinary,
  factsByGeneration,
  lineOf,
  publicationsByGeneration,
  reportOf,
  unitOf,
  stepsOf,
  type CrashReport,
} from './fill-crash-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** One build of the compiled binary for every test in this file. */
let binary = '';
const fixtures: CrashFixture[] = [];

beforeAll(() => {
  binary = buildCrashBinary(mkdtempSync(join(tmpdir(), 'madarch-fill-crash-build-')), REPO_ROOT);
}, 300_000);

afterAll(() => {
  for (const fixture of fixtures) rmSync(fixture.folder, { recursive: true, force: true });
});

/** One fixture of its own per test, so two tests never share a run. */
function fixture(): CrashFixture {
  const made = new CrashFixture(mkdtempSync(join(tmpdir(), 'madarch-fill-crash-run-')), binary);
  fixtures.push(made);
  return made;
}

/** Plans the fixture's run and holds what the plan gave. */
async function planFixture(world: CrashFixture): Promise<void> {
  const plan = lineOf(await world.phase({ kind: 'plan' }), 'plan');
  expect(plan).toMatchObject({
    outcome: 'planned',
    run: 'running',
    units: PLANNED_UNITS.map((unitId) => ({ unitId, state: 'planned', generation: 1, created: true })),
    reused: [],
    foundNothing: [],
  });
}

describe('the chain of the fixture', () => {
  test('plans the three stages in the derived order and drives every unit to one publication', async () => {
    const world = fixture();
    await planFixture(world);
    const driven = lineOf(await world.phase({ kind: 'run', workers: 1 }), 'run');
    expect(driven).toMatchObject({ run: 'succeeded', settled: true });
    const report = reportOf(await world.phase({ kind: 'report' }));

    // The chain the task drives: the extractor's units are the plan's first two
    // and are admitted before anything else, and the parent publishes only after
    // the children it sealed — which is what the join is for. Which of the
    // remaining units a worker claims first is the queue's own order, and the
    // decision promises no more than that.
    const published = report.progress.filter((event) => event.kind === 'unit-published').map((event) => event.unitId);
    expect(published.slice(0, 2)).toEqual(['extract/src', 'extract/docs']);
    expect(published.indexOf('modules/root')).toBeGreaterThan(published.indexOf('modules/left'));
    expect(published.indexOf('modules/root')).toBeGreaterThan(published.indexOf('modules/right'));
    expect([...published].sort(byCodePoint)).toEqual([...PLANNED_UNITS, 'modules/left', 'modules/right'].sort(byCodePoint));
    expect(report.sealed.map((child) => child.childUnitId)).toEqual(['modules/left', 'modules/right']);
    expect(report.childStates).toEqual([
      { unitId: 'modules/left', generation: 1, state: 'published' },
      { unitId: 'modules/right', generation: 1, state: 'published' },
    ]);
    // The parent joined after its children and drafted on the attempt after the
    // join: `wait-for-children` then `join` are the barrier's own steps.
    const parent = report.transitions.filter((step) => step.subject === 'modules/root').map((step) => step.transition);
    expect(parent).toContain('unit/running--wait-for-children-->waiting_children');
    expect(parent).toContain('unit/waiting_children--join-all-published-->ready');
    expect(report.queue.deadLetters).toBe(0);
    expectSettled(report);
  }, 120_000);
});

describe('killing the process', () => {
  test('around the claim: nothing is leased, and the run recovers and publishes once', async () => {
    const world = fixture();
    await planFixture(world);
    const killed = await world.phase({ kind: 'run', workers: 1 }, { interrupt: { point: 'claim', mode: 'crash', unitId: 'extract/src' } });
    // The kill is a SIGKILL: the process dies where it stands, with the job it
    // claimed still the queue's own to recover.
    expect(killed.code).toBe(137);
    const crash = lineOf(killed, 'crash');
    expect(crash).toMatchObject({ point: 'claim', unitId: 'extract/src', generation: 1 });

    const before = reportOf(await world.phase({ kind: 'report' }));
    // The kill stands between the claim and the lease: the unit was admitted and
    // holds no lease, no attempt was counted and nothing was published.
    expect(unitOf(before, 'extract/src')).toMatchObject({ state: 'ready', attempt: 0, fence: 0 });
    expect(before.publications).toEqual([]);
    expect(before.facts).toEqual([]);
    // Two jobs are unfinished: the claim the dead worker held, and the job of
    // the other unit the same pass admitted and no worker has claimed yet.
    expect(before.queue.unfinished).toBe(2);

    await resumeRun(world, {}, crash, 'failed');
    const report = reportOf(await world.phase({ kind: 'report' }));
    expectSettled(report);
    // The unit that lost its claim was worked again and published exactly once, and
    // the run reported the offer that recovered it as its own durable event.
    expect(unitOf(report, 'extract/src')).toMatchObject({ state: 'published', attempt: 1 });
    expect(report.progress.filter((event) => event.kind === 'unit-requeued').map((event) => event.unitId)).toEqual(['extract/src']);
  }, 120_000);

  test('around the split: the sealed children stand, and the parent joins them after the restart', async () => {
    const world = fixture();
    await planFixture(world);
    const killed = await world.phase({ kind: 'run', workers: 1 }, { interrupt: { point: 'split', mode: 'crash', unitId: 'modules/root' } });
    expect(killed.code).toBe(137);
    const crash = lineOf(killed, 'crash');
    expect(crash).toMatchObject({ point: 'split', unitId: 'modules/root', generation: 1 });

    const before = reportOf(await world.phase({ kind: 'report' }));
    // The split's own transaction committed before the kill: both children are
    // sealed against the parent's generation and stand planned, and the parent
    // waits for them with its lease revoked. Its job was never acknowledged.
    expect(before.sealed.map((child) => [child.parentUnitId, child.childGeneration, child.childUnitId])).toEqual([
      ['modules/root', 1, 'modules/left'],
      ['modules/root', 1, 'modules/right'],
    ]);
    expect(unitOf(before, 'modules/root').state).toBe('waiting_children');
    expect(before.generations.filter((generation) => generation.unitId === 'modules/root').map((generation) => [generation.generation, generation.state, generation.attempt, generation.fence])).toEqual([[1, 'waiting_children', 1, 1]]);
    expect(before.childStates.map((child) => child.state)).toEqual(['planned', 'planned']);
    // The two units the run published before the parent split, and nothing of the
    // splitting stage: the parent's own facts are not published yet.
    expect(before.publications.map((record) => record.unitId)).toEqual(['extract/docs', 'extract/src']);
    // The parent's job was never acknowledged, and the other admitted unit's job
    // waits for a worker: two unfinished jobs.
    expect(before.queue.unfinished).toBe(2);

    await resumeRun(world, {}, crash, 'failed');
    const report = reportOf(await world.phase({ kind: 'report' }));
    // No child was lost: both are published, and the parent resumed only after
    // them — the barrier is what "no lost children" is judged by.
    expect(report.sealed).toHaveLength(2);
    expect(report.childStates).toEqual([
      { unitId: 'modules/left', generation: 1, state: 'published' },
      { unitId: 'modules/right', generation: 1, state: 'published' },
    ]);
    const steps = stepsOf(report, 'modules/root');
    expect(steps).toContain('unit/running--wait-for-children-->waiting_children');
    expect(steps).toContain('unit/waiting_children--join-all-published-->ready');
    expectSettled(report);
  }, 120_000);

  test('inside the publication: the transaction rolls back and the retry publishes exactly once', async () => {
    const world = fixture();
    await planFixture(world);
    const killed = await world.phase({ kind: 'run', workers: 1 }, { interrupt: { point: 'publication', mode: 'crash', unitId: 'extract/src' } });
    expect(killed.code).toBe(137);
    const crash = lineOf(killed, 'crash');
    expect(crash).toMatchObject({ point: 'publication', unitId: 'extract/src', generation: 1 });

    const before = reportOf(await world.phase({ kind: 'report' }));
    // The publication is one transaction of the owner: the process died inside it,
    // so neither the publication record nor a fact of it was kept, and the unit
    // stands where the steps before the publication left it — validating, under
    // the lease of its attempt.
    expect(before.publications).toEqual([]);
    expect(before.facts).toEqual([]);
    expect(unitOf(before, 'extract/src')).toMatchObject({ state: 'validating', attempt: 1, fence: 1 });
    // The publication's own transaction rolled back with the process, so the job
    // this attempt claimed is still unfinished beside the other unit's.
    expect(before.queue.unfinished).toBe(2);
    expect(before.progress.some((event) => event.kind === 'unit-published')).toBe(false);

    await resumeRun(world, {}, crash, 'failed');
    const report = reportOf(await world.phase({ kind: 'report' }));
    expectSettled(report);
    expectOnePublicationPerGeneration(report);
    expect(publicationsByGeneration(report).get('extract/src/1')).toHaveLength(1);
    expect(factsByGeneration(report).get('extract/src/1')).toHaveLength(1);
    // The retry is the same generation's second attempt: nothing was replaced.
    expect(unitOf(report, 'extract/src')).toMatchObject({ generation: 1, attempt: 2, state: 'published' });
  }, 120_000);

  test('around the acknowledgement: the publication stands, and a repeated request answers it', async () => {
    const world = fixture();
    await planFixture(world);
    const killed = await world.phase({ kind: 'run', workers: 1 }, { interrupt: { point: 'acknowledgement', mode: 'crash', unitId: 'extract/src' } });
    expect(killed.code).toBe(137);
    const crash = lineOf(killed, 'crash');
    expect(crash).toMatchObject({ point: 'acknowledgement', unitId: 'extract/src', generation: 1 });

    const before = reportOf(await world.phase({ kind: 'report' }));
    // The publication and the settlement of its job are one transaction, so a
    // process killed the moment after it dies with both committed: the unit is
    // published and the queue holds no unfinished job of it.
    const published = unitOf(before, 'extract/src');
    expect(published).toMatchObject({ state: 'published', generation: 1, attempt: 1, fence: 1 });
    expect(before.publications.map((record) => [record.unitId, record.generation, record.facts])).toEqual([['extract/src', 1, 2]]);
    expect(before.facts.map((row) => [row.unitId, row.generation, row.facts])).toEqual([['extract/src', 1, 2]]);
    // The settlement of this unit's job landed with its publication; what is left
    // unfinished is the other unit the admission pass queued.
    expect(before.queue.unfinished).toBe(1);

    // A duplicate result: the same generation and the same identity, asked for
    // again — the existing publication is answered and nothing is written.
    const duplicate = lineOf(await world.phase({ kind: 'resubmit', unitId: 'extract/src', generation: 1, fence: published.fence, identity: 'same' }), 'resubmit');
    expect(duplicate).toMatchObject({ outcome: 'replayed' });
    // A late result from a newer stage module: the same generation, a different
    // identity, refused rather than replacing what was published.
    const different = lineOf(await world.phase({ kind: 'resubmit', unitId: 'extract/src', generation: 1, fence: published.fence, identity: 'different' }), 'resubmit');
    expect(different).toMatchObject({ outcome: 'refused', code: 'fill-publication/digest-mismatch' });

    const after = reportOf(await world.phase({ kind: 'report' }));
    expect(after.publications).toEqual(before.publications);
    expect(after.facts).toEqual(before.facts);

    // The claim this phase settles stands completed: the publication's own
    // transaction settled it, which is what makes the acknowledgement and the
    // publication one step.
    await resumeRun(world, {}, crash, 'completed');
    expectSettled(reportOf(await world.phase({ kind: 'report' })));
  }, 120_000);
});

describe('what the run does with a graph that moves', () => {
  test('an empty query that answers a row before publication refuses it, and the retry publishes', async () => {
    const world = fixture();
    // The consumer reads nothing at all: its read is an empty membership.
    world.setGraph('product-facts', []);
    await planFixture(world);
    const driver = world.start({ kind: 'run', workers: 1 }, { interrupt: { point: 'validation', mode: 'pause', unitId: 'overview/product' } });
    const paused = await driver.nextLine();
    expect(paused).toMatchObject({ event: 'pause', point: 'validation', unitId: 'overview/product' });
    // The pinned graph moves while the unit stands between its read and its
    // publication: the same query answers a row now.
    world.setGraph('product-facts', [{ product: 'the fixture' }]);
    driver.send();
    // The paused process is waited for before another one opens the same PGlite
    // folder: one database folder serves one process at a time.
    const pausedRun = await driver.wait();
    expect(pausedRun.code).toBe(0);
    expect(lineOf(pausedRun, 'run').settled).not.toBe(true);

    for (let round = 0; round < 4; round += 1) {
      world.advanceClock(2_000);
      const resumed = world.start({ kind: 'run', workers: 1 });
      const line = await resumed.wait();
      expect(line.code).toBe(0);
      if (lineOf(line, 'run').settled === true) break;
    }
    const report = reportOf(await world.phase({ kind: 'report' }));
    // The publication rechecked the read inside its own transaction and refused:
    // nothing was published for the generation from the empty read, and the
    // attempt that saw the row published exactly once.
    const refused = report.progress.filter((event) => event.unitId === 'overview/product' && event.summary.includes('which is now 1'));
    expect(refused).toHaveLength(1);
    expect(refused[0]?.kind).toBe('unit-retried');
    expect(refused[0]?.summary).toMatch(/read "product-facts" and it answered 0 rows/);
    expect(refused[0]?.summary).toMatch(/which is now 1/);
    expect(publicationsByGeneration(report).get('overview/product/1')).toHaveLength(1);
    expectSettled(report);
  }, 120_000);

  test('a named input that moves makes the published generation stale and its replacement is published', async () => {
    const world = fixture();
    await planFixture(world);
    const driven = lineOf(await world.phase({ kind: 'run', workers: 1 }), 'run');
    expect(driven).toMatchObject({ run: 'succeeded', settled: true });
    const first = reportOf(await world.phase({ kind: 'report' }));
    const published = unitOf(first, 'overview/product');
    expect(published.state).toBe('published');

    // What the unit's facts stand on moves: decision 0027 makes its published
    // generation stale and opens the replacement the next run works on.
    world.setInputs('overview/product', { commit: 'c2' });
    world.advanceClock(1_000);
    const replanned = lineOf(await world.phase({ kind: 'plan' }, { runId: 'crash-run-2' }), 'plan');
    expect(replanned).toMatchObject({ outcome: 'planned' });
    // A second run plans what the stages' plans name: the units already published
    // with their inputs unchanged stand, and the split's children — which only the
    // run that sealed them holds — are not part of this plan at all.
    expect(replanned.reused).toEqual(['extract/src', 'extract/docs', 'modules/root']);
    expect((replanned.units as readonly { unitId: string; generation: number }[]).find((unit) => unit.unitId === 'overview/product')).toMatchObject({ generation: 2 });
    const second = lineOf(await world.phase({ kind: 'run', workers: 1 }, { runId: 'crash-run-2' }), 'run');
    expect(second).toMatchObject({ settled: true });

    const report = reportOf(await world.phase({ kind: 'report' }, { runId: 'crash-run-2' }));
    // The published generation is an immutable record marked stale, and the
    // replacement generation carries the second publication.
    expect(report.generations.filter((generation) => generation.unitId === 'overview/product').map((generation) => [generation.generation, generation.state])).toEqual([[1, 'stale'], [2, 'published']]);
    expect(unitOf(report, 'overview/product')).toMatchObject({ generation: 2, state: 'published' });
    expect(publicationsByGeneration(report).get('overview/product/2')).toHaveLength(1);
  }, 120_000);
});

describe('cancelling and starving a run', () => {
  test('a run cancelled while a unit stands in validation cancels that generation', async () => {
    const world = fixture();
    await planFixture(world);
    const killed = await world.phase({ kind: 'run', workers: 1 }, { interrupt: { point: 'validation', mode: 'crash', unitId: 'extract/src' } });
    expect(killed.code).toBe(137);
    expect(lineOf(killed, 'crash')).toMatchObject({ point: 'validation', unitId: 'extract/src' });
    const validating = reportOf(await world.phase({ kind: 'report' }));
    expect(unitOf(validating, 'extract/src')).toMatchObject({ state: 'validating', attempt: 1 });

    const cancelled = lineOf(await world.phase({ kind: 'cancel', cause: 'the person stopped the run' }), 'cancel');
    // Decision 0027: a cancellation revokes the authority of everything the run
    // planned before it settles, and the run is cancelled once nothing is left.
    expect(cancelled).toMatchObject({ run: 'cancelled', settlement: 'cancelled' });
    expect(cancelled.cancelledUnits).toContain('extract/src');

    const report = reportOf(await world.phase({ kind: 'report' }));
    expect(report.run?.state).toBe('cancelled');
    expect(report.chain?.state).toBe('quiescent');
    expect(unitOf(report, 'extract/src').state).toBe('cancelled');
    expect(report.publications).toEqual([]);
  }, 120_000);

  test('a disabled producer blocks the run and names the path that starves the consumer', async () => {
    const world = fixture();
    // The product disables the extractor, the only stage that produces the
    // capability the splitting unit needs: decision 0027's `producer-disabled`.
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
    const plan = lineOf(await world.phase({ kind: 'plan' }), 'plan');
    expect(plan).toMatchObject({ outcome: 'blocked', run: 'blocked' });
    const starvation = plan.starvation as readonly { consumer: string; capability: string; producer: string; reason: string; path: string }[];
    expect(starvation.map((path) => [path.consumer, path.capability, path.producer, path.reason])).toEqual([['modules', 'file-facts', 'extract', 'producer-disabled']]);
    // The diagnostic names the exact path: the consumer, the capability it needs
    // and the producer that does not run.
    expect(plan.path).toContain('modules');
    expect(plan.path).toContain('file-facts');
    expect(plan.path).toContain('extract');

    const report = reportOf(await world.phase({ kind: 'report' }));
    expect(report.run?.state).toBe('blocked');
    expect(report.chain?.state).toBe('quiescent');
    expect(report.units).toEqual([]);
    expect(report.progress.map((event) => event.kind)).toEqual(['run-planned', 'run-blocked']);
  }, 120_000);

  test('a manifest that reads a stage the registry does not hold leaves the run alone', async () => {
    const world = fixture();
    // The manifest's own rule: a field this madarch does not know is ignored, and
    // an entry for a stage the registry holds no module for configures nothing.
    world.manifest([
      'schemaVersion: 1',
      'id: crash-fixture',
      'name: The crash suite fixture',
      'fill:',
      '  stages:',
      '    modules:',
      '      concurrency: 3',
      '    history:',
      '      enabled: false',
      '',
    ].join('\n'));
    await planFixture(world);
    expect(lineOf(await world.phase({ kind: 'run', workers: 1 }), 'run')).toMatchObject({ settled: true });
    expectSettled(reportOf(await world.phase({ kind: 'report' })));
  }, 120_000);
});

describe('the service the background server owns', () => {
  test('the packaged binary drives one run through the daemon service to its end', async () => {
    const world = fixture();
    const line = lineOf(await world.phase({ kind: 'service', workers: 2 }), 'service');
    const result = line.result as { ok: boolean; state: string; settled: boolean; units: readonly { unitId: string; state: string }[] };
    expect(result.ok).toBe(true);
    expect(result.state).toBe('succeeded');
    expect(result.settled).toBe(true);
    const report = reportOf(await world.phase({ kind: 'report' }));
    expectSettled(report);
  }, 120_000);
});
