/**
 * `bound()` names a case's run-time limit with its measurement, place and day.
 * See docs/decisions/0041-test-layers-and-suites.md, rule `test-case-bound`.
 *
 *   test('a fill of two passes', async () => { ... }, bound(30_000, {
 *     measured: 4_200,
 *     on: 'github ubuntu-24.04, 4 vCPU',
 *     at: '2026-11-18',
 *   }));
 *
 * At runtime this helper requires at least 10 000 ms, at least three times the
 * measured time, and nonempty `on` and `at` fields. It also checks finite bounds
 * and finite, nonnegative measurements. It has no knowledge of the test layer.
 *
 * Statically, `check:tests` checks those literal arguments and also enforces the
 * layer rules: no bound in unit, at most 30 000 ms in integration and at most
 * 120 000 ms in e2e. Only the static check enforces those layer restrictions.
 */
export interface CaseMeasurement {
  /** How long the case took when it was measured, in milliseconds. */
  readonly measured: number;
  /** Where the measurement was taken: the runner's shape or the machine's name. */
  readonly on: string;
  /** When it was taken, as an ISO 8601 date (`2026-11-18`). */
  readonly at: string;
}

/** The bound a case names, refused when it is under three times its measurement or under ten seconds. */
export function bound(ms: number, measurement: CaseMeasurement): number {
  for (const [field, value] of [['on', measurement.on], ['at', measurement.at]] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`bound(${group(ms)}): the measurement names no ${field}; a bound records where and when it was measured, so a reader can check it`);
    }
  }
  if (!Number.isFinite(measurement.measured) || measurement.measured < 0) {
    throw new Error(`bound(${group(ms)}): the measurement is ${String(measurement.measured)}, and a measured time is a count of milliseconds from 0`);
  }
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new Error(`bound: the bound is ${String(ms)}, and a bound is a count of milliseconds`);
  }
  if (ms < 10_000) {
    throw new Error(`bound(${group(ms)}, measured ${group(measurement.measured)} on ${measurement.on} at ${measurement.at}): a case bound is at least 10 000 ms`);
  }
  if (ms < 3 * measurement.measured) {
    throw new Error(`bound(${group(ms)}, measured ${group(measurement.measured)} on ${measurement.on} at ${measurement.at}): a case bound is at least three times its measurement, which is ${group(3 * measurement.measured)} ms`);
  }
  return ms;
}

/** A count with its thousands spaced, as a reader says it: `30 000`. */
function group(value: number): string {
  const text = String(value);
  let grouped = '';
  for (let index = 0; index < text.length; index += 1) {
    if (index > 0 && (text.length - index) % 3 === 0) grouped += ' ';
    grouped += text[index];
  }
  return grouped;
}
