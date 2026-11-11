import { readPinnedGraphContract } from '../../../src/product/fill-stages.js';
import { prepareStore } from '../../../src/adapters/prepare-store.js';
/**
 * One measured run of the static fill, in a process of its own
 * (madarch-8bdc.2.2): the repository of `count` files the resolution's
 * acceptance generates, the stages fill over it, and the process's peak
 * resident set before and after the run.
 *
 * The measure is the process's own resident set (`/proc/self/status`'s `VmRSS`),
 * read once after the fill's tables and the queue are open and a collection, and
 * every 25 ms while the run works: the fill's peak is the largest reading minus
 * the first, which is the memory the run itself added. The kernel's high-water
 * mark cannot serve: it never falls, and the setup already reaches it, so a run
 * that grows the resident set by less than the setup did would show as nothing.
 * The database and the runtime a process pays once are in the baseline, and a
 * fresh process per size is what keeps one size's heap out of another's number.
 *
 * Usage: `bun static-fill-heap.ts <count> <root>`; it prints one JSON object:
 * `{count, state, units, baselineKb, peakKb, fillKb}`.
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFillOrchestratorService } from '../../../src/fill/orchestrator-host.js';
import { createStagesFill } from '../../../src/product/fill-stages.js';
import { writeProduct } from './repository.js';
import { createDatabaseOwner } from '../../../src/adapters/database-owner.js';

/** The process's resident set in KiB: the pages of this process the kernel holds now. */
function residentKb(): number {
  const status = readFileSync('/proc/self/status', 'utf8');
  const held = /VmRSS:\s+(\d+)\s+kB/u.exec(status);
  if (held === null) throw new Error('the process status names no VmRSS, and the fill\'s peak is read from it (test/fixtures/resolution-graph/static-fill-heap.ts)');
  return Number(held[1]);
}

/** How often the run's resident set is read while it runs: the peak between two readings is missed by less than this. */
const SAMPLE_MS = 25;

const count = Number(process.argv[2]);
if (!Number.isInteger(count) || count < 2) throw new Error(`the measured fill takes a whole number of files from 2, and ${JSON.stringify(process.argv[2])} is none (test/fixtures/resolution-graph/static-fill-heap.ts)`);
const root = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'madarch-static-heap-'));
const { product } = writeProduct(root, count);
const owner = await createDatabaseOwner({ store: join(root, 'store'), btreeGist: true });
try {
  await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
  const fill = await createStagesFill({ product, database: owner, prepareContract: async (contract) => { await prepareStore(owner, { contract }); } });
  let at = 1_700_000_000_000;
  const service = createFillOrchestratorService({
    owner,
    registry: fill.registry,
    wiring: () => fill.wiring,
    clock: () => (at += 1_000),
    limits: { leaseMs: 86_400_000 },
    maxPasses: 100_000,
  });
  // The fill's tables, the queue and the graph's schema are open: what a process pays once is
  // in the baseline. The kernel's high-water mark cannot say what the run adds (it never falls,
  // and the setup reaches it), so the resident set is read in the run instead: once after a
  // collection, then every SAMPLE_MS until the run settles, and the peak is the largest reading.
  Bun.gc(true);
  const baselineKb = residentKb();
  let peak = baselineKb;
  const sampler = setInterval(() => { peak = Math.max(peak, residentKb()); }, SAMPLE_MS);
  let result;
  try {
    result = await service.run({ product: fill.product, runId: `measured-${String(count)}` });
  } finally {
    clearInterval(sampler);
  }
  if (!result.ok) throw new Error(`the measured run of ${String(count)} files was refused: ${result.code}: ${result.reason}`);
  peak = Math.max(peak, residentKb());
  await service.stop();
  process.stdout.write(`${JSON.stringify({
    count,
    state: result.state,
    settled: result.settled,
    units: result.units.length,
    baselineKb,
    peakKb: peak,
    fillKb: Math.max(0, peak - baselineKb),
  })}\n`);
} finally {
  await owner.close();
  if (process.argv[3] === undefined) rmSync(root, { recursive: true, force: true });
}
