/**
 * The fill role (madarch-8bdc.9): a process of the same binary that takes pressed fills from each product's store queue and
 * runs them, writing through the one storage module. It is started by `madarch serve` (one, at a lower scheduling priority,
 * so a fill never takes a core from the answers) or by hand (`madarch --role fill`), and several of them may run against
 * one store: the queue's claim hands each job to exactly one of them.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readProduct } from '../product/manifest.js';
import { startKnowledgeFill } from './fill-run.js';
import { claimFillRun, openFillRunQueue, settleFillRun } from '../fill/run-jobs.js';
import { readRunControl, writeFillEnd } from '../fill/orchestrator-store.js';

/** The owner one store is read through, as `startKnowledgeFill` takes it: derived, so this module holds no connection. */
type StoreOwner = NonNullable<Parameters<typeof startKnowledgeFill>[0]['database']>;

/** One store the role watches: its folder, the connection its queue runs on, and the queue of the fills it was asked. */
interface Watched {
  readonly storeFolder: string;
  readonly owner: StoreOwner;
  readonly queue: Awaited<ReturnType<typeof openFillRunQueue>>;
}

export interface FillRoleOptions {
  /** The knowledge root the products' stores stand in (`<madarch home>/madarch/knowledge`). */
  readonly knowledgeRoot: string;
  /** The products home, whose products name the folders a job's product stands in: `<home>/<name>`. */
  readonly productsHome: string;
  readonly log?: (line: string) => void;
  /** Opens one store's connection: the process that owns the binary hands this in, so the role holds no database of its own. */
  readonly openStore: (databaseFolder: string) => Promise<StoreOwner>;
  /** Ends the loop after this many actions a claim did not answer — a test drives the role by its own signals. */
  readonly idle?: () => boolean;
  /** The process that started this one: the role ends when it is gone, so a server's fill process never outlives it. */
  readonly parentPid?: number;
}

/**
 * Runs the role until the process ends: every watched store is asked for a job in turn, and a job is run at once and
 * settled — completed when the fill ended, failed (the queue retries it once) when it did not.
 */
export async function runFillRole(options: FillRoleOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const watched = new Map<string, Watched>();
  for (;;) {
    if (options.idle?.() === true) return 0;
    if (options.parentPid !== undefined) {
      try { process.kill(options.parentPid, 0); } catch { return 0; }
    }
    for (const storeFolder of storeFoldersOf(options.knowledgeRoot)) {
      let held = watched.get(storeFolder);
      if (held === undefined) {
        try {
          const owner = await options.openStore(join(storeFolder, 'graph'));
          await owner.ready;
          held = { storeFolder, owner, queue: await openFillRunQueue(owner) };
          watched.set(storeFolder, held);
        } catch (error) {
          log(`madarch fill: the store ${storeFolder} could not be opened: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }
      const job = await claimFillRun(held.queue).catch((error: unknown) => {
        log(`madarch fill: the queue of ${storeFolder} could not be claimed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (job === null) continue;
      await runOne(options, held, job, log);
    }
    await Bun.sleep(250);
  }
}

/** Runs one claimed fill: a fresh owner of the store (the run closes it with itself) and the pins the run's own end writes. */
async function runOne(options: FillRoleOptions, held: Watched, job: NonNullable<Awaited<ReturnType<typeof claimFillRun>>>, log: (line: string) => void): Promise<void> {
  const data = job.data;
  const productFolder = data.product;
  const read = readProduct(productFolder);
  if (!read.ok) {
    await settleFillRun(held.queue, job, { ok: false, message: `${read.file}:${read.line}: ${read.message}` });
    return;
  }
  let owner: StoreOwner;
  try {
    owner = await options.openStore(join(held.storeFolder, 'graph'));
    await owner.ready;
  } catch (error) {
    await settleFillRun(held.queue, job, { ok: false, message: `the store ${held.storeFolder} could not be opened: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  let run: Awaited<ReturnType<typeof startKnowledgeFill>> | undefined;
  try {
    void options.productsHome;
    run = await startKnowledgeFill({
      productFolder,
      storeFolder: held.storeFolder,
      runId: data.runId,
      database: owner,
      ...(data.language === undefined ? {} : {}),
    });
    // A person's pause or stop is written to the store by the api role and taken here, on the run's own state machine.
    const done = run.done;
    let finished = false;
    void done.then(() => { finished = true; }, () => { finished = true; });
    while (!finished) {
      await Bun.sleep(250);
      if (finished) break;
      const action = await readRunControl(owner, data.runId).catch(() => null);
      if (action !== null) await run.control(action).catch(() => undefined);
    }
    const result = await done;
    await run.close();
    run = undefined;
    await settleFillRun(held.queue, job, { ok: result.ok, ...(result.message === undefined ? {} : { message: result.message }) });
    log(`madarch fill: ${data.product} run ${data.runId} ${result.ok ? 'filled' : `failed: ${result.message ?? ''}`}`);
  } catch (error) {
    await run?.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
    await settleFillRun(held.queue, job, { ok: false, message: error instanceof Error ? error.message : String(error) });
  }
}

/** Every store folder under the knowledge root that holds a graph database. */
function storeFoldersOf(knowledgeRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(knowledgeRoot).sort();
  } catch {
    return [];
  }
  return names.map((name) => join(knowledgeRoot, name)).filter((folder) => existsSync(join(folder, 'graph')));
}
