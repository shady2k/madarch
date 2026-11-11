/**
 * The fill role (madarch-8bdc.9): a process of the same binary that takes pressed fills from each product's store queue and
 * runs them, writing through the one storage module. It is started by `madarch serve` (one, at a lower scheduling priority,
 * so a fill never takes a core from the answers) or by hand (`madarch --role fill`), and several of them may run against
 * one store: the queue's claim hands each job to exactly one of them.
 */
import { requestStorePreparation } from '../product/store-preparation.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readProduct } from '../product/manifest.js';
import { startKnowledgeFill } from './fill-run.js';
import { claimFillRun, openFillRunQueue, settleFillRun } from '../fill/run-jobs.js';
import { withSpan } from '../obs/trace.js';
import { readRunControl, writeFillEnd } from '../fill/orchestrator-store.js';
import { refuseStarts, stopStoreForExit } from '../adapters/postgres-cluster.js';

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
  readonly log?: (line: string) => void;
  /** Opens one store's connection: the process that owns the binary hands this in, so the role holds no database of its own. */
  readonly openStore: (databaseFolder: string) => Promise<StoreOwner>;
  /** Ends the loop after this many actions a claim did not answer — a test drives the role by its own signals. */
  readonly idle?: () => boolean;
  /** The process that started this one: the role ends when it is gone, so a server's fill process never outlives it. */
  readonly parentPid?: number;
}

/** How long the role has to give its stores up once the process that started it is gone: within this, its servers stop. */
const ENDING_MS = 1_600;

/** How often the process that started the role is looked for: often enough to end inside a second, cheap enough to keep. */
const PARENT_CHECK_MS = 50;

/** Whether a process is still there: one this process may not signal counts as there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What one run of the role holds: every store it opened, and the fill under way, so the end can give them up. */
interface RoleState {
  readonly owners: Set<StoreOwner>;
  /** The queues this role opened, by store: each is stopped before the owner under it closes (madarch-8bdc.13's crash). */
  readonly queues: Map<string, Awaited<ReturnType<typeof openFillRunQueue>>>;
  /** The database folders this role opened (`<store>/graph`), so the end stops each store's server even unopened. */
  readonly databaseFolders: Set<string>;
  running?: Awaited<ReturnType<typeof startKnowledgeFill>>;
  ending: boolean;
}

/**
 * Stops the queues one role opened, each before the owner under it closes: a live queue asks its owner for a statement on
 * its own timer (pg-boss's registration pass), and an owner that closed under it throws into whatever the process is doing
 * then — in a test run, another file's case (`the database owner "…" is closed`), and in a server, an unhandled error.
 */
async function stopQueues(state: RoleState): Promise<void> {
  for (const [storeFolder, queue] of [...state.queues]) {
    state.queues.delete(storeFolder);
    await queue.stop().catch(() => undefined);
  }
}

/**
 * Runs the role until the process ends: every watched store is asked for a job in turn, and a job is run at once and
 * settled — completed when the fill ended, failed (the queue retries it once) when it did not.
 *
 * A role a server started ends with it (madarch-8bdc.12): the parent is looked for every `PARENT_CHECK_MS`, never only
 * between passes, because a pass can stand in a store's open or a claim for as long as the store takes — a role left
 * alive then keeps the store's PostgreSQL server up for a server nothing serves.
 */
export async function runFillRole(options: FillRoleOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const watched = new Map<string, Watched>();
  const state: RoleState = { owners: new Set(), queues: new Map(), databaseFolders: new Set(), ending: false };
  /** Ends the role now: what it opened is given up, so the last close of a store stops its server. */
  const end = async (exitCode = 0): Promise<void> => {
    if (state.ending) return;
    state.ending = true;
    // Nothing is started from here on: the start of a server is synchronous, and the stop below may not wait for one.
    refuseStarts();
    withoutSignals();
    log('madarch fill: the process that started this role is gone, so the role ends and gives its stores up');
    const deadline = Date.now() + ENDING_MS;
    // The queues are asked to stop without holding the end on them — a role that is ending will not be here for their next
    // beat, and a queue's stop can wait for its own work — and what may not wait is the stores: the fill under way and
    // every store this role opened are closed with a short bound (a close that waits for a client inside a transaction is
    // not what the server's death may be held by), and then the servers are stopped. A killed server's stores are gone
    // inside the two seconds the rule allows even on a loaded machine.
    void stopQueues(state);
    // The stores first and forced: the process is ending, so its own holds go with it and the server stops here — a close
    // that waits for a client inside a transaction must not hold the stores up (madarch-8bdc.12).
    void (state.running?.close() ?? Promise.resolve()).catch(() => undefined);
    void Promise.allSettled([...state.owners].map(async (owner) => await owner.close().catch(() => undefined)));
    state.running = undefined;
    // Whatever a close is still waiting for, the stores' servers are stopped here: this process was their last user, and a
    // server nothing serves must not outlive it (madarch-8bdc.12 — a killed server left one up 30 s).
    await Promise.race([
      (async () => {
        // The database folder the role opened for each store — `<store>/graph` — and the ones it had not opened yet: a
        // role killed before its first pass found the store still has a server to stop, and the server's own use of it
        // died with the server.
        const databases = new Set<string>([...state.databaseFolders, ...storeFoldersOf(options.knowledgeRoot).map((folder) => join(folder, 'graph'))]);
        for (const database of databases) await stopStoreForExit(database, { force: true });
      })(),
      Bun.sleep(Math.max(0, deadline - Date.now())),
    ]);
    process.exit(exitCode);
  };
  const watcher = options.parentPid === undefined ? undefined : setInterval(() => {
    if (!alive(options.parentPid!)) void end();
  }, PARENT_CHECK_MS);
  watcher?.unref?.();
  // A role asked to stop (the server that started it stops it with SIGTERM, the way `madarch serve` does) gives its stores
  // up as it does when its parent is gone: a killed role must not leave a store's PostgreSQL server running either.
  const signals: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  const onSignal = (signal: NodeJS.Signals): void => { void end(signal === 'SIGINT' ? 130 : 143); };
  for (const signal of signals) process.on(signal, onSignal);
  const withoutSignals = (): void => { for (const signal of signals) process.off(signal, onSignal); };
  /**
   * Gives the stores up when the role ends by saying so (`idle`, or a signal of the caller's): a role that ends must not
   * leave a store's PostgreSQL server running with nothing to serve it, which is what the parent's death must not either
   * (madarch-8bdc.12).
   */
  const giveUp = async (): Promise<void> => {
    if (watcher !== undefined) clearInterval(watcher);
    withoutSignals();
    await stopQueues(state);
    for (const owner of [...state.owners]) {
      await Promise.race([owner.close().catch(() => undefined), Bun.sleep(ENDING_MS / 2)]);
      state.owners.delete(owner);
    }
    // Every store this role opened, and the ones it had not opened yet: the last close of a server is the one that stops it,
    // and a store the role never reached still has one (madarch-8bdc.12).
    for (const folder of new Set([...state.databaseFolders, ...storeFoldersOf(options.knowledgeRoot).map((store) => join(store, 'graph'))])) {
      await Promise.race([stopStoreForExit(folder), Bun.sleep(ENDING_MS / 2)]);
    }
  };
  try {
    for (;;) {
      if (state.ending) return 0;
      if (options.idle?.() === true) {
        await giveUp();
        return 0;
      }
      for (const storeFolder of storeFoldersOf(options.knowledgeRoot)) {
        let held = watched.get(storeFolder);
        if (held === undefined) {
          try {
            const owner = await options.openStore(join(storeFolder, 'graph'));
            state.owners.add(owner);
            state.databaseFolders.add(join(storeFolder, 'graph'));
            await owner.ready;
            held = { storeFolder, owner, queue: await openFillRunQueue(owner) };
            state.queues.set(storeFolder, held.queue);
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
        await withSpan('fill.role.run', { 'madarch.product': job.data.product, 'madarch.run': job.data.runId }, async () => { await runOne(options, state, held, job, log); });
      }
      await Bun.sleep(250);
    }
  } finally {
    // A role that ends, however it ends, leaves no signal handler behind for the process it shares.
    withoutSignals();
  }
}

/** Runs one claimed fill: a fresh owner of the store (the run closes it with itself) and the pins the run's own end writes. */
async function runOne(options: FillRoleOptions, state: RoleState, held: Watched, job: NonNullable<Awaited<ReturnType<typeof claimFillRun>>>, log: (line: string) => void): Promise<void> {
  const data = job.data;
  const productFolder = data.product;
  const read = readProduct(productFolder);
  if (!read.ok) {
    // The run's end is written even when no run started (madarch-8bdc.9): the api role that pressed the fill answers
    // `failed` with this message, where a missing end would leave it saying `running` for ever.
    const message = `${read.file}:${read.line}: ${read.message}`;
    await writeFillEnd(held.owner, { runId: data.runId, state: 'failed', message }).catch(() => undefined);
    await settleFillRun(held.queue, job, { ok: false, message });
    return;
  }
  let owner: StoreOwner;
  try {
    owner = await options.openStore(join(held.storeFolder, 'graph'));
    state.owners.add(owner);
    state.databaseFolders.add(join(held.storeFolder, 'graph'));
    await owner.ready;
  } catch (error) {
    await settleFillRun(held.queue, job, { ok: false, message: `the store ${held.storeFolder} could not be opened: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  let run: Awaited<ReturnType<typeof startKnowledgeFill>> | undefined;
  try {
    run = await startKnowledgeFill({
      productFolder,
      storeFolder: held.storeFolder,
      runId: data.runId,
      database: owner,
      prepareContract: async (contract) => await requestStorePreparation(join(held.storeFolder, 'graph'), contract),
      // The language the press named, as `madarch fill --language` names it: a run that asks for another language
      // translates the pages it writes (madarch-8bdc.12).
      ...(data.language === undefined ? {} : { language: data.language }),
      // The entities the press asked for (madarch-stm0.6): the catalogue's selection, its dependencies added, in order.
      ...(data.targets === undefined ? {} : { targets: data.targets }),
    });
    state.running = run;
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
    state.running = undefined;
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
