import assert from 'node:assert/strict';
import { createLadybugEngine, preparedStatementCacheSizeForTests, type AssertionChange, type AssertionRecord, type Clock } from '../src/index.js';

const DAY = (day: number) => Date.UTC(2026, 8, day);

function element(id: string, kind: string, ancestors: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, kind, ancestors, states: ['as-is'], ...extra });
}

function relation(id: string, from: string, to: string): string {
  return JSON.stringify({ id, from, to, states: ['as-is'] });
}

function row(kind: 'element' | 'relation', content: string): AssertionRecord {
  const parsed: { id: string } = JSON.parse(content);
  return { source: 's', kind, id: parsed.id, content, validFrom: DAY(1), validTo: null, recordedFrom: DAY(1), recordedTo: null };
}

async function yieldToFinalizers(): Promise<void> {
  Bun.gc();
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

function leastSquaresSlope(ys: number[]): number {
  const xMean = (ys.length - 1) / 2;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let x = 0; x < ys.length; x++) {
    numerator += (x - xMean) * (ys[x]! - yMean);
    denominator += (x - xMean) ** 2;
  }
  return numerator / denominator;
}

const rssMb = () => Math.round(process.memoryUsage().rss / 1e6);

async function runQueries(): Promise<void> {
  const chain = Array.from({ length: 50 }, (_, i) => i + 1);
  let now = DAY(30);
  const clock: Clock = { now: () => now };
  const startupRss = rssMb();
  const engine = createLadybugEngine({ clock });
  try {
    engine.rebuild([
      ...chain.map((n) => row('element', element(`e${n}`, 'service', []))),
      ...chain.slice(0, -1).map((n) => row('relation', relation(`r${n}`, `e${n}`, `e${n + 1}`))),
    ]);

    const iterations = 12_000;
    const batchSize = 500;
    const curve: number[] = [];
    const observations = [rssMb()]; // include the engine's rebuilt graph in the absolute bound
    let maxCacheSize = 0;

    for (let i = 0; i < iterations; i++) {
      now += 1;
      const dependents = engine.dependents('e50', { transitive: true });
      assert.equal(dependents.error, undefined, 'transitive dependents query should succeed');
      assert.equal(dependents.elements?.length, 30, 'the 30-hop ceiling should reach e20..e49');
      const seen = engine.view({ depth: 0 });
      assert.equal(seen.error, undefined, 'view query should succeed');
      assert.equal(seen.elements?.length, 50, 'view should include the full chain');
      maxCacheSize = Math.max(maxCacheSize, preparedStatementCacheSizeForTests(engine));

      if ((i + 1) % batchSize === 0) {
        await yieldToFinalizers();
        const current = rssMb();
        curve.push(current);
        observations.push(current);
      }
    }

    const peakRss = Math.max(...observations);
    console.log(`ti6.2 long run: ${iterations * 2} calls, RSS after rebuild and each ${batchSize}-call batch (MB): ${observations.join(' ')}`);
    console.log(`ti6.2 long run: startup RSS ${startupRss} MB, peak RSS ${peakRss} MB, final RSS ${rssMb()} MB, max prepared-statement cache ${maxCacheSize}`);

    const slopePerBatch = leastSquaresSlope(curve.slice(curve.length / 2));
    console.log(`ti6.2 long run: last-half slope ${slopePerBatch.toFixed(2)} MB/batch`);
    assert.ok(slopePerBatch < 1, `last-half RSS slope ${slopePerBatch.toFixed(2)} MB/batch must be under 1`);

    const middle = curve.slice(curve.length / 3, (2 * curve.length) / 3);
    const last = curve.slice((2 * curve.length) / 3);
    const thirdsGap = Math.max(...last) - Math.max(...middle);
    console.log(`ti6.2 long run: middle-third max ${Math.max(...middle)} MB, last-third max ${Math.max(...last)} MB, gap ${thirdsGap} MB`);
    assert.ok(thirdsGap < 100, `last-third peak rose ${thirdsGap} MB over the middle-third peak`);
    assert.ok(peakRss < 400, `peak RSS ${peakRss} MB must stay under 400 MB`);
    assert.ok(maxCacheSize <= 5, `prepared-statement cache grew to ${maxCacheSize}`);
  } finally {
    engine.close();
  }
}

async function runUpdates(): Promise<void> {
  const chain = Array.from({ length: 10 }, (_, i) => i + 1);
  const model: AssertionRecord[] = [
    ...chain.map((n) => row('element', element(`e${n}`, 'service', []))),
    ...chain.slice(0, -1).map((n) => row('relation', relation(`r${n}`, `e${n}`, `e${n + 1}`))),
  ];
  const startupRss = rssMb();
  const engine = createLadybugEngine();
  try {
    engine.rebuild(model);

    const iterations = 300;
    const batchSize = 100;
    const curve: number[] = [];
    const observations = [rssMb()]; // include the rebuilt graph in the absolute bound
    let currentRecordedFrom = DAY(1);
    let currentTo = 'e2';
    let recordedFrom = DAY(1);

    for (let i = 0; i < iterations; i++) {
      recordedFrom += 1;
      const to = i % 2 === 0 ? 'e3' : 'e2';
      const opened: AssertionChange = { source: 's', kind: 'relation', id: 'r1', content: relation('r1', 'e1', to), validFrom: DAY(1), validTo: null, recordedFrom, recordedTo: null };
      const closed: AssertionChange = { source: 's', kind: 'relation', id: 'r1', content: relation('r1', 'e1', currentTo), validFrom: DAY(1), validTo: null, recordedFrom: currentRecordedFrom, recordedTo: recordedFrom };
      engine.update([opened], [closed]);
      currentRecordedFrom = recordedFrom;
      currentTo = to;

      if ((i + 1) % batchSize === 0) {
        engine.rebuild(model);
        currentRecordedFrom = DAY(1);
        currentTo = 'e2';
        await yieldToFinalizers();
        const current = rssMb();
        curve.push(current);
        observations.push(current);
      }
    }

    const peakRss = Math.max(...observations);
    console.log(`ti6.2 rebuild/update stream: ${iterations} updates + ${curve.length} rebuilds, RSS after rebuild and each ${batchSize}-update batch (MB): ${observations.join(' ')}`);
    console.log(`ti6.2 rebuild/update stream: startup RSS ${startupRss} MB, peak RSS ${peakRss} MB`);
    assert.ok(peakRss < 400, `peak RSS ${peakRss} MB must stay under 400 MB`);
    assert.deepEqual(engine.dependents('e2', {}).elements?.map((e) => e.id), ['e1'], 'the final rebuild should restore the model');
  } finally {
    engine.close();
  }
}

const scenario = process.argv[2];
if (scenario === 'queries') await runQueries();
else if (scenario === 'updates') await runUpdates();
else throw new Error(`expected probe scenario 'queries' or 'updates', got ${String(scenario)}`);
