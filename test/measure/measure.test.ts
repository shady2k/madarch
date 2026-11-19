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

  test('holds the quoted first-answer limit and names its source on failure', async () => {
    const source = { ref: 'docs/changes/madarch-64o5.32/capabilities/fill-orchestrator.md:339', quote: 'first answer arrives within 5 seconds and the unchanged second answer within 50 milliseconds' };
    const within = await measure(THE_CASE, () => undefined, { runs: 3, clock: readings(0, 4000, 0, 4000, 0, 4000), baselines: recorded(10_000), absolute: { ms: 5000, source } });
    expect(within.medianMs).toBe(4000);
    await expect(measure(THE_CASE, () => undefined, { runs: 3, clock: readings(0, 6000, 0, 6000, 0, 6000), baselines: recorded(10_000), absolute: { ms: 5000, source } }))
      .rejects.toThrow(`absolute limit 5000 ms — source ${source.ref}: “${source.quote}”`);
  });

  test('reports the absolute limit first when both bounds are exceeded', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-measure-priority-'));
    try {
      const path = join(folder, 'limit.md');
      const quote = 'The fixture case must finish within 500 milliseconds.';
      writeFileSync(path, quote);
      await expect(measure(THE_CASE, () => undefined, {
        runs: 3, clock: readings(0, 600, 0, 600, 0, 600), baselines: recorded(100),
        absolute: { ms: 500, source: { ref: `${path}:1`, quote } },
      })).rejects.toThrow(`absolute limit 500 ms — source ${path}:1: “${quote}”`);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  test('rejects malformed, zero, placeholder and unresolved source references with their origin', async () => {
    const refs = ['docs/x.md', ':339', 'docs/x.md:', 'docs/x.md:abc', 'docs/x.md:0'];
    for (const ref of refs) {
      try {
        await measure(THE_CASE, () => undefined, { runs: 3, clock: readings(0, 1, 0, 1, 0, 1), baselines: recorded(10), absolute: { ms: 500, source: { ref, quote: 'quote' } } });
        throw new Error('expected invalid reference');
      } catch (error) { expect((error as Error).message).toContain(`invalid absolute source reference \`${ref}\``); }
    }
    await expect(measure(THE_CASE, () => undefined, { runs: 3, clock: readings(0, 1, 0, 1, 0, 1), baselines: recorded(10), absolute: { ms: 500, source: { ref: 'docs/x.md:339', quote: 'TODO' } } }))
      .rejects.toThrow(/invalid absolute source reference `docs\/x\.md:339`/u);
    await expect(measure(THE_CASE, () => undefined, { runs: 3, clock: readings(0, 1, 0, 1, 0, 1), baselines: recorded(10), absolute: { ms: 500, source: { ref: 'docs/x.md:339', quote: 'not present' } } }))
      .rejects.toThrow(/docs\/x\.md:339: reference `docs\/x\.md:339` from .*measure\.ts/u);
  });

  test('rejects blank quotes and padded placeholders before reading the source', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-measure-quotes-'));
    try {
      const path = join(folder, 'source.md');
      writeFileSync(path, 'limit 500 ms; TODO TBD …   ');
      for (const quote of [' ', '\t', ' TODO ', ' TBD ', ' … ']) {
        await expect(measure(THE_CASE, () => undefined, {
          clock: readings(0, 1, 0, 1, 0, 1), runs: 3, baselines: recorded(10),
          absolute: { ms: 500, source: { ref: `${path}:1`, quote } },
        })).rejects.toThrow(`invalid absolute source reference \`${path}:1\``);
      }
    } finally { rmSync(folder, { recursive: true, force: true }); }
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
    const schema = JSON.parse(readFileSync(join(import.meta.dir, 'baselines.schema.json'), 'utf8')) as { properties: Record<string, { type?: string; const?: number }>; $defs: { baseline: { properties: { runs: { minimum: number } } } } };
    const baselines = readBaselines();
    expect(BASELINES_PATH.endsWith(join('test', 'measure', 'baselines.json'))).toBe(true);
    expect(schema.properties.schema!.const).toBe(baselines.schema);
    expect(schema.properties.baselines!.type).toBe('object');
    expect(schema.properties.environment!.type).toBe('string');
    expect(typeof baselines.environment).toBe('string');
    expect(typeof baselines.baselines).toBe('object');
    expect(Object.getPrototypeOf(baselines.baselines)).toBeNull();
    const minimum = schema.$defs.baseline.properties.runs.minimum;
    const fixture = (runs: number) => ({ schema: 1, baselines: { sample: { medianMs: 12, runs } } });
    for (const runs of [2, 3, 4, minimum - 1, minimum]) {
      if (runs < minimum) expect(() => parseBaselines(fixture(runs))).toThrow('must be an integer of at least');
      else expect(parseBaselines(fixture(runs)).baselines['sample']?.runs).toBe(runs);
    }
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
    const folder = mkdtempSync(join(tmpdir(), 'madarch-measure-special-'));
    try {
      const path = join(folder, 'special.json');
      writeFileSync(path, '{\n  "schema": 1,\n  "baselines": {\n    "__proto__": { "medianMs": 1, "runs": 3 },\n    "toString": { "medianMs": 2, "runs": 3 }\n  }\n}');
      const fromFile = readBaselines(path);
      expect(Object.hasOwn(fromFile.baselines, '__proto__')).toBe(true);
      expect(Object.hasOwn(fromFile.baselines, 'toString')).toBe(true);
      expect(fromFile.baselines['toString']?.medianMs).toBe(2);
    } finally { rmSync(folder, { recursive: true, force: true }); }
    const empty = parseBaselines({ schema: 1, baselines: {} });
    await expect(measure('toString', () => undefined, { runs: 3, clock: readings(0, 1, 0, 1, 0, 1), baselines: empty }))
      .rejects.toThrow(/no baseline for `toString`/u);
  });

  test('locates invalid JSON and malformed fields by absolute file, line, column, and pointer', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-measure-locations-'));
    try {
      const path = resolve(join(folder, 'bad.json'));
      const cases: { text: string; location: string; pointer: string }[] = [
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": 1e2, "runs": 3 }\n  }', location: `${path}:5:4`, pointer: '/' },
        { text: '{\n  "schema": 1,\n  "baselines": {', location: `${path}:3:17`, pointer: '/' },
        { text: '{\n  "schema": 1,\n  "a/b": 2,\n  "baselines": {}\n}', location: `${path}:3:3`, pointer: '/a~1b' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": {\n      "a/b": 2\n    }\n  }\n}', location: `${path}:5:7`, pointer: '/baselines/x/a~1b' },
        { text: '[\n  1\n]', location: `${path}:1:1`, pointer: '/' },
        { text: '{\n  "schema": 1,\n  "oops": 2,\n  "baselines": {}\n}', location: `${path}:3:3`, pointer: '/oops' },
        { text: '{\n  "$schema": 42,\n  "schema": 1,\n  "baselines": {}\n}', location: `${path}:2:3`, pointer: '/$schema' },
        { text: '{\n  "baselines": {}\n}', location: `${path}:1:1`, pointer: '/schema' },
        { text: '{\n  "schema": 1,\n  "environment": 4,\n  "baselines": {}\n}', location: `${path}:3:3`, pointer: '/environment' },
        { text: '{\n  "schema": 1\n}', location: `${path}:1:1`, pointer: '/baselines' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": 2\n  }\n}', location: `${path}:4:5`, pointer: '/baselines/x' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "extra": 1 }\n  }\n}', location: `${path}:4:12`, pointer: '/baselines/x/extra' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": 0, "runs": 3 }\n  }\n}', location: `${path}:4:12`, pointer: '/baselines/x/medianMs' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": 1, "runs": 2.5 }\n  }\n}', location: `${path}:4:27`, pointer: '/baselines/x/runs' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": 1, "runs": 3, "note": 4 }\n  }\n}', location: `${path}:4:38`, pointer: '/baselines/x/note' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "runs": 3 }\n  }\n}', location: `${path}:4:5`, pointer: '/baselines/x/medianMs' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": -1, "runs": 3 }\n  }\n}', location: `${path}:4:12`, pointer: '/baselines/x/medianMs' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": "bad", "runs": 3 }\n  }\n}', location: `${path}:4:12`, pointer: '/baselines/x/medianMs' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": 1e999, "runs": 3 }\n  }\n}', location: `${path}:4:12`, pointer: '/baselines/x/medianMs' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": 1 }\n  }\n}', location: `${path}:4:5`, pointer: '/baselines/x/runs' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": 1, "runs": 2 }\n  }\n}', location: `${path}:4:27`, pointer: '/baselines/x/runs' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": 1, "runs": 3, "measuredAt": 4 }\n  }\n}', location: `${path}:4:38`, pointer: '/baselines/x/measuredAt' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": 1, "runs": 3, "commit": 4 }\n  }\n}', location: `${path}:4:38`, pointer: '/baselines/x/commit' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "x": { "medianMs": 1, "runs": 3, "wat": 4 }\n  }\n}', location: `${path}:4:38`, pointer: '/baselines/x/wat' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "__proto__": 5\n  }\n}', location: `${path}:4:5`, pointer: '/baselines/__proto__' },
        { text: '{\n  "schema": 1,\n  "baselines": {\n    "toString": 5\n  }\n}', location: `${path}:4:5`, pointer: '/baselines/toString' },
        { text: '{\n  "schema": 1,\n  "baselines": []\n}', location: `${path}:3:3`, pointer: '/baselines' },
        { text: '{\n  "schema": 1,\n  "extra": 1,\n  "baselines": {}\n}', location: `${path}:3:3`, pointer: '/extra' },
      ];
      for (const item of cases) {
        writeFileSync(path, item.text);
        try { readBaselines(path); throw new Error('expected invalid baseline'); }
        catch (error) {
          const message = (error as Error).message;
          const [file, line] = item.location.split(':');
          if (!message.startsWith(`${file}:${line}:`)) throw new Error(`expected ${item.location}; got ${message}`);
          const actualColumn = Number(message.slice(`${file}:${line}:`.length).split(' ')[0]);
          expect(actualColumn).toBe(Number(item.location.split(':').at(-1)));
          expect(message).toContain(` ${item.pointer}:`);
        }
      }
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  test('read failure includes the resolved full path', () => {
    const path = resolve(join(tmpdir(), 'absent-baselines-file.json'));
    expect(() => readBaselines(path)).toThrow(path);
  });

  test('locates distinct JSON syntax failures rather than reporting a fixed parser location', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-measure-syntax-'));
    try {
      const path = resolve(join(folder, 'broken.json'));
      const cases = [
        { text: '{\n  "schema": 1,', line: 2 },
        { text: '{\n  "schema": 1,\n}', line: 3 },
        { text: '{\n  "schema": 1,\n  "baselines": {}\n}x', line: 4 },
        { text: '{\n  "schema": 1,\n  "baselines": { "x": bare }\n}', line: 3 },
      ];
      for (const item of cases) {
        writeFileSync(path, item.text);
        try { readBaselines(path); throw new Error('expected invalid JSON'); }
        catch (error) {
          const message = (error as Error).message;
          if (!message.startsWith(`${path}:${item.line}:`)) throw new Error(`wanted line ${item.line}; received ${message}`);
          expect(message).toContain(' /: the baselines are not valid JSON');
        }
      }
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  test('a malformed file names the file, the baseline and the field', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-measure-'));
    try {
      const path = join(folder, 'baselines.json');
      writeFileSync(path, JSON.stringify({ schema: 1, baselines: { [THE_CASE]: { medianMs: 0, runs: 3 } } }));
      expect(() => readBaselines(path)).toThrow(new RegExp(`${path}:1:\\d+ /baselines/a case/medianMs: must be a positive number`));
      writeFileSync(path, JSON.stringify({ schema: 2, baselines: {} }));
      expect(() => readBaselines(path)).toThrow(new RegExp(`${path}:1:\\d+ /schema: must be 1`));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
