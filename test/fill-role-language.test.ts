/**
 * The language a press names reaches the run the fill role starts (madarch-8bdc.12): the press's job carries it
 * (`FillRunJob.language`), and the role passed nothing — `...(data.language === undefined ? {} : {})`, an empty spread —
 * so the run recorded no language at all. The case asks for one, runs the role over the store, and reads the language off
 * the run's own root span.
 */
import { requestStorePreparation, withStorePreparationOwner } from '../src/product/store-preparation.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { askFillRun, openFillRunQueue } from '../src/fill/run-jobs.js';
import { runFillRole } from '../src/knowledge/fill-role.js';
import { knowledgeRootOf, productStoreFolder } from '../src/product/store.js';
import { readFillEnd, writeFillEnd } from '../src/fill/orchestrator-store.js';
import { createRun } from '../src/fill/state-store.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';
import { gitEnv } from './git-env.js';
import { execFileSync } from 'node:child_process';

const work = mkdtempSync(join(tmpdir(), 'madarch-fill-language-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The root span of one run's trace, as the run wrote it. */
function rootSpanOf(traceFile: string): { name: string; attributes: { key: string; value: { stringValue?: string } }[] } {
  for (const line of readFileSync(traceFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const span = JSON.parse(line) as { name: string; attributes: { key: string; value: { stringValue?: string } }[] };
    if (span.name === 'fill.run') return span;
  }
  throw new Error(`the trace ${traceFile} holds no fill.run span`);
}

test('the language a press names is the one the run records', async () => await withStorePreparationOwner(async () => {
  const env = gitEnv(SAMPLE_IDENTITY);
  const repository = join(work, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repository, env });
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const price = 10;\n');
  execFileSync('git', ['add', '-A'], { cwd: repository, env });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'one'], { cwd: repository, env });
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  const product = makeProduct(home, 'shop', repository, 'shop-code');
  const knowledgeRoot = knowledgeRootOf(home);
  // The store the role watches (the folder the product's own fill keeps), and the database folder inside it.
  const storeFolder = productStoreFolder(product, knowledgeRoot);
  const graphFolder = join(storeFolder, 'graph');
  await requestStorePreparation(graphFolder, await readPinnedGraphContract(product));
  const owner: DatabaseOwner = await createDatabaseOwner({ store: graphFolder, connectOnly: true });
  let queue: Awaited<ReturnType<typeof openFillRunQueue>> | undefined;
  try {
    queue = await openFillRunQueue(owner);
    await askFillRun(queue, { product, store: storeFolder, runId: 'language-run', language: 'ru' });
    // The role runs until the run it took has ended: the end row the run writes is what says so, and the role's next pass
    // then ends.
    let finished = false;
    const watching = setInterval(() => { void readFillEnd(owner, 'language-run').then((end) => { if (end !== null) finished = true; }, () => undefined); }, 50);
    let code: number;
    try {
      code = await runFillRole({
        knowledgeRoot,
        log: () => undefined,
        idle: () => finished,
        openStore: async (folder) => await createDatabaseOwner({ store: folder, connectOnly: true }),
      });
    } finally {
      clearInterval(watching);
    }
    expect(code).toBe(0);
    const trace = join(storeFolder, 'traces', 'language-run.jsonl');
    const span = rootSpanOf(trace);
    const language = span.attributes.find((entry) => entry.key === 'madarch.language');
    expect(language?.value.stringValue, `the run's root span records no language, and the press named ru: ${JSON.stringify(span.attributes)}`).toBe('ru');
  } finally {
    // The queue before the owner it runs on: pg-boss asks its owner for a statement on its own timer, and the owner of a
    // queue left running throws into whatever the process does then — in a test run, the next file's case
    // (`the database owner "…" is closed`, madarch-8bdc.13).
    await queue?.stop().catch(() => undefined);
    await owner.close();
  }
}), 180_000);

test('a redelivered fill keeps its published failure and acknowledges the job without reopening the product', async () => await withStorePreparationOwner(async () => {
  const knowledgeRoot = join(work, 'redelivery-knowledge');
  const storeFolder = join(knowledgeRoot, 'ended');
  const graphFolder = join(storeFolder, 'graph');
  await requestStorePreparation(graphFolder);
  const owner = await createDatabaseOwner({ store: graphFolder, connectOnly: true });
  const queue = await openFillRunQueue(owner);
  const job = { product: join(work, 'missing-redelivered-product'), store: storeFolder, runId: 'ended-run' };
  const original = { runId: job.runId, state: 'failed', message: 'The original failure must remain exact.' };
  try {
    await createRun(owner, { runId: job.runId, product: job.product, at: Date.now() });
    await writeFillEnd(owner, original);
    expect(await askFillRun(queue, job)).toBe(true);
    let passes = 0;
    expect(await runFillRole({
      knowledgeRoot,
      log: () => undefined,
      idle: () => passes++ > 0,
      openStore: async (folder) => await createDatabaseOwner({ store: folder, connectOnly: true }),
    })).toBe(0);
    expect(await readFillEnd(owner, job.runId)).toEqual(original);
    expect(existsSync(join(storeFolder, 'traces', `${job.runId}.jsonl`))).toBe(false);
    // Completion releases the product's singleton, unlike an unfinished retry.
    expect(await askFillRun(queue, { ...job, runId: 'next-run' })).toBe(true);
  } finally {
    await queue.stop();
    await owner.close();
  }
}), 180_000);
