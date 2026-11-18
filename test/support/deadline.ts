/**
 * `bound()` — the one way a test case names how long it may run (decision 0039,
 * section 2, rule `test-case-bound`): the bound, together with the measurement it is
 * three times and the place and day that measurement was taken.
 *
 *   test('a fill of two passes', async () => { ... }, bound(30_000, {
 *     measured: 4_200,
 *     on: 'github ubuntu-24.04, 4 vCPU',
 *     at: '2026-11-18',
 *   }));
 *
 * The check `check:tests` reads the same arguments from the syntax tree and refuses a
 * bound that is under three times its measurement or under ten seconds, a bound above
 * its layer (30 000 ms in integration, 120 000 ms end-to-end), and a bound in the unit
 * layer at all. This helper refuses the same bounds at run time, so a case that slips
 * past the check (a computed bound, a run without the check) still says why it is
 * wrong instead of timing a case out in silence.
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
