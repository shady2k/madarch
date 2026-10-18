/**
 * What the crash suite holds every run to (madarch-tzte.19.6), shared by the
 * PGlite and the PostgreSQL legs so both judge a run the same way and neither
 * judges it by the module under test.
 *
 * Every expectation here is the task's DONE WHEN or decision 0027's own words:
 * one publication per unit generation, no lost children, a run that finishes
 * with its chain quiescent, and nothing left unfinished in the queue.
 */
import { expect } from 'bun:test';
import { byCodePoint } from '../src/model/order.js';
import { lineOf, unitOf, type CrashFixture, type CrashReport, type PhaseLine, type PhaseOptions, type PhaseRun } from './fill-crash-fixture.js';

/** The units the fixture's plan names, in the derived stage order. */
export const PLANNED_UNITS = ['extract/src', 'extract/docs', 'modules/root', 'overview/product'];

/** The units a split seals, which only the run that sealed them holds. */
export const SEALED_UNITS = ['modules/left', 'modules/right'];

/**
 * One publication per generation, and one fact application per publication: a
 * generation published twice would be two rows here, and a publication whose
 * facts never landed would be a record without its row.
 */
export function expectOnePublicationPerGeneration(report: CrashReport): void {
  const published = report.publications.map((record) => `${record.unitId}/${String(record.generation)}`);
  // Code point order is this project's order, and the report's own list is that order.
  expect(published).toEqual([...published].sort(byCodePoint));
  expect(new Set(published).size).toBe(published.length);
  const asRecord = (rows: readonly { unitId: string; generation: number; digest: string; facts: number }[]): string[] =>
    rows.map((row) => `${row.unitId}/${String(row.generation)}/${row.digest}/${String(row.facts)}`).sort(byCodePoint);
  expect(asRecord(report.facts)).toEqual(asRecord(report.publications));
}

/** Every unit named published, the run succeeded, its chain quiescent and the queue empty. */
export function expectSettled(report: CrashReport, unitIds: readonly string[] = [...PLANNED_UNITS, ...SEALED_UNITS]): void {
  expect(report.run?.state).toBe('succeeded');
  expect(report.chain?.state).toBe('quiescent');
  expect(report.queue.unfinished).toBe(0);
  expect(report.queue.deadLetters).toBe(0);
  for (const unitId of unitIds) expect(unitOf(report, unitId).state).toBe('published');
  expectOnePublicationPerGeneration(report);
}

/** Both children of the split published, each sealed against the parent's own generation. */
export function expectNoLostChildren(report: CrashReport): void {
  expect(report.sealed.map((child) => [child.parentUnitId, child.parentGeneration, child.childUnitId, child.childGeneration])).toEqual([
    ['modules/root', 1, 'modules/left', 1],
    ['modules/root', 1, 'modules/right', 1],
  ]);
  expect(report.childStates).toEqual([
    { unitId: 'modules/left', generation: 1, state: 'published' },
    { unitId: 'modules/right', generation: 1, state: 'published' },
  ]);
}


/**
 * Recovers what a killed process left and drives the run again, the way the suite
 * does it: the queue's own maintenance pass, the claim that worker held settled
 * for good (unless a publication's own transaction already settled it, which the
 * state the phase reports says), the suite's clock moved past the lease and the
 * retry the run's own machine recorded, and the run driven on. Nothing here waits
 * on a timer: a retry the run recorded is due because the test moved the clock,
 * not because time passed.
 */
export async function resumeRun(fixture: CrashFixture, options: PhaseOptions, crash: PhaseLine, settled: string, rounds = 4): Promise<PhaseRun> {
  const recovered = await fixture.phase({ kind: 'recover', job: crash.job as never }, options);
  if (recovered.code !== 0) {
    throw new Error(`the recovery phase failed (exit ${String(recovered.code)}): ${recovered.stderr} ${recovered.lines.map((line) => JSON.stringify(line)).join(' ')}`);
  }
  expect(lineOf(recovered, 'recover')).toMatchObject({ settled });
  for (let round = 0; round < rounds; round += 1) {
    fixture.advanceClock(2_000);
    const driven = await fixture.phase({ kind: 'run', workers: 1 }, options);
    if (driven.code !== 0) {
      throw new Error(`the run after the recovery failed (exit ${String(driven.code)}): ${driven.stderr}`);
    }
    if (lineOf(driven, 'run').settled === true) return driven;
  }
  // A run that does not settle is reported where it stands, so a reader sees the
  // unit the recovery left rather than only that it ran out of rounds.
  const report = await fixture.phase({ kind: 'report' }, options);
  throw new Error(`the run never settled after the clock moved ${String(rounds)} times: ${report.lines.map((line) => JSON.stringify(line)).join(' ')}`);
}
