/** Store and fill services held by the products-home daemon. */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { requestStorePreparation } from './store-preparation.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from './store.js';
import { readProduct } from './manifest.js';
import { openFillDatabase, fillProgressOf, type FillActivity, type FillOrchestratorService, type FillProduct, type FillProgressAnswer, type FillRunControl, type FillRunControlAnswer, type FillRunRequest, type FillRunResult, type RefusedFillRun } from '../fill/orchestrator-host.js';
import type { RunStatus } from '../fill/orchestrator.js';
import type { ValidatedManifests } from '../graph/manifest-publication.js';

export interface DaemonFills {
  /** Publishes validated metadata without starting a fill. */
  publishManifests(validated: ValidatedManifests): Promise<void>;
  /** Runs one product's fill through `runFill` and answers what the host answered. */
  run(request: FillRunRequest): Promise<FillRunResult | RefusedFillRun>;
  /** One run's status, or null when the store holds no such run. */
  status(request: { readonly product: FillProduct; readonly runId: string }): Promise<RunStatus | null>;
  /** The product's newest run as the fill progress reads it, or null when it never ran. */
  progress(folder: string): Promise<FillProgressAnswer | null>;
  /** Whether this product completed a successful fill; catalogue publication is not a fill. */
  filled(folder: string): Promise<boolean>;
  /** Whether a product fills now, read from its store's chain (asked before an update is started). */
  activity(request: { readonly product: FillProduct }): Promise<FillActivity>;
  /** A person's pause or stop of one run, or null when the store holds no such run. */
  control(request: { readonly productFolder: string; readonly runId: string; readonly action: FillRunControl; readonly product?: string }): Promise<FillRunControlAnswer | null>;
  /** Stops the kept services and closes the stores; safe to call twice. */
  stop(): Promise<void>;
}

/** One store the daemon holds: its owner, the service of the newest run of it, and whether a run is working it. */
interface HeldStore {
  readonly storeFolder: string;
  readonly owner: Awaited<ReturnType<typeof openFillDatabase>>;
  service?: FillOrchestratorService;
  /** True while one of this store's runs is in flight: the store's fill is one run at a time. */
  running?: boolean;
}

/**
 * The fills the background server owns: one store per product, and every run through `runFill`
 * over that store's owner (decision 0027's one owner per store, one writer). Nothing is opened
 * before a run is asked for or a run record is read, so a server that serves wikis pays nothing
 * for a fill nobody started.
 */
export function daemonFills(home: string, options: { readonly log?: (line: string) => void } = {}): DaemonFills {
  const knowledgeRoot = knowledgeRootOf(home);
  const stores = new Map<string, HeldStore>();
  /**
   * The one opening of each store. Two simultaneous first requests for one product — a person's press and the
   * update watch, say — must open one owner of the store, not two: one promise per store answers both, and the
   * second request waits for it rather than opening a second connection (madarch-8bdc.2.5, item 4c).
   */
  const opening = new Map<string, Promise<HeldStore>>();
  let stopped = false;
  /** The store of one product, by the one function every caller resolves it with. */
  const storeFolderOfProduct = (productFolder: string): string => productStoreFolder(productFolder, knowledgeRoot);
  /** Opens one store's owner, or answers the opening already under way for it: one owner per store, whichever asks. */
  const openStore = async (storeFolder: string): Promise<HeldStore> => {
    const held = stores.get(storeFolder);
    if (held !== undefined) return held;
    const pending = opening.get(storeFolder);
    if (pending !== undefined) return await pending;
    const made = (async (): Promise<HeldStore> => {
      mkdirSync(dirname(storeDatabasePath(storeFolder)), { recursive: true });
      await requestStorePreparation(storeDatabasePath(storeFolder));
      const owner = await openFillDatabase(storeDatabasePath(storeFolder));
      await owner.ready;
      const one: HeldStore = { storeFolder, owner };
      stores.set(storeFolder, one);
      return one;
    })();
    opening.set(storeFolder, made);
    try {
      return await made;
    } finally {
      if (opening.get(storeFolder) === made) opening.delete(storeFolder);
    }
  };
  /** The store, when it stands or is being opened: a read never creates one, so a never-filled product reads empty. */
  const opened = async (productFolder: string): Promise<HeldStore | undefined> => {
    if (stopped) throw new Error("the daemon's fills were stopped, so they read no store (src/product/daemon.ts)");
    const storeFolder = storeFolderOfProduct(productFolder);
    if (!existsSync(storeDatabasePath(storeFolder)) && !opening.has(storeFolder)) return undefined;
    return await openStore(storeFolder);
  };
  /** The store a run writes: opened here, because a run writes what a read may not create. */
  const store = async (productFolder: string): Promise<HeldStore> => {
    if (stopped) throw new Error("the daemon's fills were stopped, so a run opens no store (src/product/daemon.ts)");
    return await openStore(storeFolderOfProduct(productFolder));
  };
  const withService = async <T>(productFolder: string, work: (service: FillOrchestratorService) => Promise<T>): Promise<T | undefined> => {
    const held = await opened(productFolder);
    if (held?.service === undefined) return undefined;
    return await work(held.service);
  };
  /** One run of one held store: the previous run's service stops, the fill runs, and a success finishes the store. */
  const runInStore = async (held: HeldStore, request: FillRunRequest): Promise<FillRunResult | RefusedFillRun> => {
    // The next run of this store replaces the service the last one left: one service over the store's one owner.
    if (held.service !== undefined) {
      const previous = held.service;
      held.service = undefined;
      await previous.stop();
    }
    const { runFill } = await import('../fill/run.js');
    const result = await runFill({
      product: request.product.folder,
      database: held.owner,
      prepareContract: async (contract) => await requestStorePreparation(storeDatabasePath(held.storeFolder), contract),
      runId: request.runId,
      home: held.storeFolder,
      store: held.storeFolder,
      keepService: true,
      ...(request.workers === undefined ? {} : { workers: request.workers }),
      ...(request.maxPasses === undefined ? {} : { maxPasses: request.maxPasses }),
      ...(options.log === undefined ? {} : { log: options.log }),
      onService: (service: FillOrchestratorService) => { held.service = service; },
    });
    // A run that succeeded finishes its store the way the button does: the wiki's reader and `madarch mcp` read the
    // store this update wrote.
    if (result.ok && result.settled && result.state === 'succeeded') {
      // The daemon's update runs finish beside a service it keeps open: the pins come first, and the statistics are
      // written beside the answer, never inside it, so the update's answer is not held behind an analyze.
      const { finishKnowledgeStore } = await import('../knowledge/fill-run.js');
      await finishKnowledgeStore(held.owner, undefined, false);
      void held.owner.run((tx: { query: (text: string, params?: readonly unknown[]) => Promise<unknown> }) => tx.query('ANALYZE')).catch(() => undefined);
    }
    return result;
  };
  return {
    async publishManifests(validated: ValidatedManifests): Promise<void> {
      const { graphContractOf } = await import('../fill/stages/plugin-contract.js');
      const { createFillStateSchema } = await import('../fill/state-store.js');
      const { createOrchestratorSchema } = await import('../fill/orchestrator-store.js');
      const { createRecordSchema } = await import('../graph/records.js');
      const { publishValidatedManifests } = await import('../graph/manifest-publication.js');
      const folder = storeFolderOfProduct(validated.folder);
      await requestStorePreparation(storeDatabasePath(folder), graphContractOf(validated.manifest));
      const held = await store(validated.folder);
      await createFillStateSchema(held.owner);
      await createOrchestratorSchema(held.owner);
      await createRecordSchema(held.owner, graphContractOf(validated.manifest));
      const started = performance.now();
      try { await publishValidatedManifests(held.owner, validated); }
      finally { if (process.env.MADARCH_STARTUP_TIMING === '1') console.error(`startup catalogue.transaction ${(performance.now() - started).toFixed(1)} ms ${validated.folder} (${validated.vertices.length} declarations)`); }
    },
    async run(request: FillRunRequest): Promise<FillRunResult | RefusedFillRun> {
      const held = await store(request.product.folder);
      // One run of a store at a time: a second start while the first is in flight is the chain's own refusal, and it
      // must not stop the first run's service or open a second connection (madarch-8bdc.2.5, item 4c).
      if (held.running === true) {
        return { ok: false, code: 'fill-orchestrator/chain-active', reason: `fill-orchestrator: the store ${held.storeFolder} is filling, and the run ${JSON.stringify(request.runId)} waits for that fill to end` };
      }
      held.running = true;
      try {
        return await runInStore(held, request);
      } finally {
        held.running = false;
      }
    },
    async status(request: { readonly product: FillProduct; readonly runId: string }): Promise<RunStatus | null> {
      const status = await withService(request.product.folder, async (service) => await service.status({ product: request.product, runId: request.runId })).catch(() => undefined);
      return status ?? null;
    },
    async progress(folder: string): Promise<FillProgressAnswer | null> {
      const held = await opened(folder);
      if (held === undefined) return null;
      if (held.service !== undefined) return await held.service.progress(folder);
      const read = readProduct(resolve(folder));
      if (!read.ok) throw new Error(`the fill progress of ${folder} cannot name its product: ${read.file}:${String(read.line)}: ${read.message}`);
      return await fillProgressOf(held.owner, read.product.name);
    },
    async filled(folder: string): Promise<boolean> {
      const held = await opened(folder);
      if (held === undefined) return false;
      const { hasSuccessfulFill } = await import('../fill/state-store.js');
      return await hasSuccessfulFill(held.owner);
    },
    async activity(request: { readonly product: FillProduct }): Promise<FillActivity> {
      const held = await opened(request.product.folder);
      if (held === undefined) return { state: 'idle', activeRunId: null, activeRunState: null };
      if (held.service !== undefined) return await held.service.activity({ product: request.product });
      const { readChain, readRun } = await import('../fill/state-store.js');
      const chain = await readChain(held.owner, request.product.name);
      if (chain === null) return { state: 'idle', activeRunId: null, activeRunState: null };
      const activeRunId = chain.context.activeRunId ?? null;
      const active = activeRunId === null ? null : await readRun(held.owner, activeRunId);
      return { state: chain.state, activeRunId, activeRunState: active?.state ?? null };
    },
    async control(request: { readonly productFolder: string; readonly runId: string; readonly action: FillRunControl; readonly product?: string }): Promise<FillRunControlAnswer | null> {
      const answer = await withService(request.productFolder, async (service) => await service.control(request)).catch(() => undefined);
      return answer ?? null;
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      let failure: unknown;
      for (const held of stores.values()) {
        if (held.service !== undefined) {
          const service = held.service;
          held.service = undefined;
          try { await service.stop(); } catch (error) { failure ??= error; }
        }
        try { await held.owner.close(); } catch (error) { failure ??= error; }
      }
      stores.clear();
      opening.clear();
      if (failure !== undefined) throw failure;
    },
  };
}

