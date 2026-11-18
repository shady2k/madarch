/**
 * The measurement helper's own unit test (plan ALX-340, slice T4). Every case
 * drives a fake clock and injects its baselines, so the test is deterministic:
 * no assertion reads the wall clock or waits for it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BASELINE_FACTOR, BASELINES_PATH, DEFAULT_RUNS, median, measure, parseBaselines, readBaselines, type Baselines,
} from '../support/measure.js';

const THE_CASE = 'a case';

/** Baselines holding one entry, so a case never reads the recorded (empty) file. */
const recorded = (medianMs: number): Baselines => ({ schema: 1, baselines: { [THE_CASE]: { medianMs, runs: DEFAULT_RUNS } } });

/** A clock the case drives: readings are handed out in order, and none is the wall's. */
function readings(...values: number[]): { now: () => number; calls: () => number } {
  let at = 0;
  return {
    now: () => {
      const value = values[at];
      if (value === undefined) throw new Error(`the fake clock was read ${String(at + 1)} times and holds ${String(values.length)} readings`);
      at += 1;
      return value;
    },
    calls: () => at,
  };
}

describe('median', () => {
  test('is the middle sample of an odd count and the mean of the two middles of an even one', () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
  });

  test('names its own file and refuses an empty measurement', () => {
    expect(() => median([])).toThrow(/test\/support\/measure\.ts: .*at least one sample/u);
  });
});

describe('measure', () => {
  test('runs the case the stated number of times and takes the median of the clock readings', async () => {
    let calls = 0;
    const clock = readings(0, 10, 100, 130, 200, 290);
    const measured = await measure(THE_CASE, () => { calls += 1; }, { runs: 3, clock, baselines: recorded(20) });
    expect(calls).toBe(3);
    expect(measured.samples).toEqual([10, 30, 90]);
    expect(measured.medianMs).toBe(30);
    expect(measured.baselineMs).toBe(20);
    expect(measured.factor).toBe(BASELINE_FACTOR);
    expect(clock.calls()).toBe(6);
  });

  test('accepts a median at twice the baseline and refuses one above it, naming the baselines file', async () => {
    const atFactor = await measure(THE_CASE, () => undefined, { runs: 3, clock: readings(0, 20, 0, 20, 0, 20), baselines: recorded(10) });
    expect(atFactor.medianMs).toBe(20);
    await expect(measure(THE_CASE, () => undefined, { runs: 3, clock: readings(0, 21, 0, 21, 0, 21), baselines: recorded(10) }))
      .rejects.toThrow(/test\/measure\/baselines\.json: `a case` took 21 ms as its median of 3 runs, above 2 × 10 ms = 20 ms/u);
  });

  test('holds an absolute limit the owner named and quotes the owner\'s words when the median passes it', async () => {
    const owner = 'owner-review/2026-11-18#timing | «Ну до 15 минут я бы еще понял.»';
    const within = await measure(THE_CASE, () => undefined, { runs: 3, clock: readings(0, 400, 0, 400, 0, 400), baselines: recorded(1000), absolute: { ms: 500, source: owner } });
    expect(within.medianMs).toBe(400);
    await expect(measure(THE_CASE, () => undefined, { runs: 3, clock: readings(0, 600, 0, 600, 0, 600), baselines: recorded(1000), absolute: { ms: 500, source: owner } }))
      .rejects.toThrow(/absolute limit 500 ms.*owner-review\/2026-11-18#timing \|.*Ну до 15 минут я бы еще понял/u);
    await expect(measure(THE_CASE, () => undefined, { runs: 3, clock: readings(0, 600, 0, 600, 0, 600), baselines: recorded(100), absolute: { ms: 500, source: owner } }))
      .rejects.toThrow(/absolute limit 500 ms.*owner-review/u);
  });

  test('refuses an absolute limit that carries no owner words', async () => {
    await expect(measure(THE_CASE, () => undefined, { runs: 3, clock: readings(0, 1, 0, 1, 0, 1), baselines: recorded(10), absolute: { ms: 500, source: '  ' } }))
      .rejects.toThrow(/test\/support\/measure\.ts: .*review-reference \| verbatim-owner-quote/u);
  });

  test('refuses a case whose baseline was never recorded, naming the file and the case', async () => {
    await expect(measure('a new case', () => undefined, { runs: 3, clock: readings(0, 1, 0, 1, 0, 1), baselines: recorded(10) }))
      .rejects.toThrow(/test\/measure\/baselines\.json: no baseline for `a new case`/u);
  });

  test('refuses fewer than three runs', async () => {
    await expect(measure(THE_CASE, () => undefined, { runs: 2, clock: readings(0, 1, 0, 1), baselines: recorded(10) }))
      .rejects.toThrow(/test\/support\/measure\.ts: .*at least 3/u);
  });
});

describe('the recorded baselines', () => {
  test('follow the shipped JSON schema', () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, 'baselines.schema.json'), 'utf8')) as { properties: Record<string, { type?: string; const?: number }> };
    const baselines = readBaselines();
    expect(schema.properties.schema.const).toBe(baselines.schema);
    expect(schema.properties.baselines.type).toBe('object');
    expect(schema.properties.environment.type).toBe('string');
    expect(typeof baselines.environment).toBe('string');
    expect(typeof baselines.baselines).toBe('object');
    expect(Object.getPrototypeOf(baselines.baselines)).toBeNull();
  });

  test('an empty dictionary is valid on a separate fixture', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-measure-'));
    try {
      const path = join(folder, 'empty.json');
      writeFileSync(path, JSON.stringify({ schema: 1, baselines: {} }));
      expect(readBaselines(path).baselines).toEqual(Object.create(null));
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  test('checks schema type, preserves special names, and rejects inherited baseline names', async () => {
    expect(() => parseBaselines({ '$schema': 42, schema: 1, baselines: {} })).toThrow(/\$schema/u);
    const special = parseBaselines(JSON.parse('{"schema":1,"baselines":{"__proto__":{"medianMs":1,"runs":3}}}'));
    expect(Object.hasOwn(special.baselines, '__proto__')).toBe(true);
    const empty = parseBaselines({ schema: 1, baselines: {} });
    await expect(measure('toString', () => undefined, { runs: 3, clock: readings(0, 1, 0, 1, 0, 1), baselines: empty }))
      .rejects.toThrow(/no baseline for `toString`/u);
  });

  test('a malformed file names the file, the baseline and the field', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-measure-'));
    try {
      const path = join(folder, 'baselines.json');
      writeFileSync(path, JSON.stringify({ schema: 1, baselines: { [THE_CASE]: { medianMs: 0, runs: 3 } } }));
      expect(() => readBaselines(path)).toThrow(/baselines\.json: baseline `a case`: `medianMs` must be a positive number/u);
      writeFileSync(path, JSON.stringify({ schema: 2, baselines: {} }));
      expect(() => readBaselines(path)).toThrow(/baselines\.json: `schema` must be 1/u);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
