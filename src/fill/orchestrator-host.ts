/**
 * The orchestrator a host owns (decision 0027, "the background server owns the
 * orchestrator"): one service per process that opens the process's one database
 * when a fill is first asked for, creates the fill's tables in it, declares the
 * units' queue, builds the orchestrator over the wiring of the product being
 * filled and drives a run to its end.
 *
 * Nothing is opened before a run is asked for, so a server that serves wikis
 * pays nothing for a fill nobody started. The service is the server's: the
 * server holds it and stops it, and stopping it stops the queue and closes the
 * database the service opened. A second `run` for the same product reuses what
 * the first one opened.
 *
 * The wiring of one product is the caller's: how its pinned snapshot is read,
 * how its configuration resolves, which graph a unit's tracked reads answer
 * from, which named inputs a unit's facts stand on and where a published fact
 * set lands. A caller that has no wiring yet is refused with exactly what is
 * missing, never served a run that would publish nothing silently.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';
import { readProduct } from '../product/manifest.js';
import { runningVersion } from '../product/version.js';
import { createPgBossQueue } from '../adapters/pg-boss-queue.js';
import { consumeFillControl } from '../product/fill-runtime.js';
import { draftSetOf, factGraph, writeScope, type CheckedWriteDraft, type CheckedWriteGraph, type WriteSnapshots } from './checked-writes.js';
import type { FillStageConfigurationRead } from './config.js';
import type { SqlExecutor } from '../query/sql-driver.js';
import { FACT_APPLICATION, createFactStoreSchema } from './fact-store.js';
import { emptyPageSetMessage, readPageChanges, readPageModel, readPageSet, type GraphPagesSource } from './graph-pages.js';
import { readNodeDiagrams } from './graph-diagrams.js';
import { createPageReadCache } from './page-cache.js';
import type { FactLayer, FactSource } from './facts.js';
import { graphReadsOver, type DraftReading, type GraphReadLimits } from './graph-reads.js';
import {
  DEFAULT_ORCHESTRATOR_LIMITS,
  createOrchestrator,
  driveRun,
  planRun,
  resumeRun,
  runStatus,
  startRun,
  type FactApplication,
  type FillOrchestrator,
  type HumanEditGuard,
  type OrchestratorLimits,
  type ProgressSink,
  type RunControlReader,
  type RunStatus,
  type UnitGraphReader,
  type UnitRef,
  type UnitToolsOpening,
} from './orchestrator.js';
import { createOrchestratorSchema, readUnitPlan, recordUnitRead, type RunSnapshot } from './orchestrator-store.js';
import type { QueueService } from './queue.js';
import { createFillStateSchema } from './state-store.js';
import type { StageRegistry } from './registry.js';
import type { SnapshotSource } from './snapshot.js';
import {
  callUnitTool,
  createUnitToolsHost,
  type UnitToolAnswer,
  type UnitToolCall,
  type UnitToolSession,
  type UnitToolsHandle,
} from './unit-tools.js';

/** One product a fill runs for. */
export interface FillProduct {
  /** The product's name, as the manifest and the chain know it. */
  readonly name: string;
  /** The product's folder, where its state and its documents stand. */
  readonly folder: string;
}

/** How one product's fill reads and writes. Every field is the caller's; nothing here guesses. */
export interface ProductFillWiring {
  /** The pinned product snapshot the run stands on (fill-runtime's own shape, kept). */
  snapshot(): Promise<RunSnapshot> | RunSnapshot;
  /** The product's resolved fill configuration, read fresh when a run plans and when it admits. */
  configuration(): Promise<FillStageConfigurationRead | undefined> | FillStageConfigurationRead | undefined;
  /**
   * The pinned graph one unit's tracked reads answer from. A caller that hands a
   * transaction has already opened one on the process's owner, and every
   * statement the reads make must run inside it: the owner refuses a second
   * transaction on the same connection, and a publication's recheck reads
   * through its own (`graph(ref, transaction)`, `src/fill/orchestrator.ts`).
   */
  graph(ref: UnitRef, transaction?: SqlExecutor): Promise<UnitGraphReader> | UnitGraphReader;
  /**
   * The repositories this run pinned, as the reader of one commit each: where a
   * unit's evidence spans and the bytes its writes cite are read (`snapshot.ts`).
   * Left out, a unit's tools that read bytes refuse by name.
   */
  source?(): Promise<SnapshotSource> | SnapshotSource;
  /**
   * The graph a unit's writes stand on: which node stands at an id, and which
   * entities are like a proposed one. The fill's own fact store when it is left
   * out, which is where `facts` lands a published set unless a host keeps its
   * graph elsewhere — a host that does must name it here, and a unit's writes are
   * refused by name until it does.
   */
  writeGraph?(): Promise<CheckedWriteGraph> | CheckedWriteGraph;
  /** The named inputs a unit's facts stand on, hashed with fill-runtime's own hashing. */
  inputs(ref: UnitRef): Promise<Readonly<Record<string, string | Uint8Array>>> | Readonly<Record<string, string | Uint8Array>>;
  /**
   * Where a published fact set lands; the fill's own fact store in the process's
   * database (`FACT_APPLICATION`, `fact-store.ts`, madarch-tzte.20.2) when it is left out, which is
   * where a fill's facts belong unless a host keeps its graph elsewhere.
   */
  facts?: FactApplication;
  /** The human-edit guard, where the host has one. */
  guard?: HumanEditGuard;
}

/** What one fill run is asked for. */
export interface FillRunRequest {
  readonly product: FillProduct;
  /** The run's id; the caller names it, so a resume finds the run it means. */
  readonly runId: string;
  /** True to resume a paused run instead of planning a new one. */
  readonly resume?: boolean;
  readonly workers?: number;
  readonly maxPasses?: number;
}

/** What one fill run ended as. */
export interface FillRunResult {
  readonly ok: true;
  readonly runId: string;
  readonly state: string;
  readonly settled: boolean;
  readonly passes: number;
  readonly work: number;
  readonly stoppedBecause?: string;
  readonly units: readonly { readonly unitId: string; readonly stageId: string; readonly state: string; readonly generation: number; readonly attempts: number }[];
  /** The units the run inherited already published with their inputs unchanged: it planned nothing for them. */
  readonly reused: readonly string[];
  /** The enabled stages whose plan found a producer's inputs and nothing in them, so nobody reads it as a capability nothing produces. */
  readonly foundNothing: readonly string[];
}

/** What opening one unit's tools is asked for: the unit, and where its bytes, its drafts and its writes stand. */
export interface UnitToolsRequest {
  /** The product whose graph the unit reads and writes. */
  readonly product: FillProduct;
  /** The unit's identity in the store: the generation whose tracked reads and draft set its tools belong to (0027). */
  readonly unit: { readonly unitId: string; readonly generation: number };
  /** The address this process answers a unit's tool calls at (`POST /api/fill/unit/tool`, `src/server/http.ts`). */
  readonly url: string;
  /**
   * Where an accepted write lands: the attempt's own draft set
   * (`draftSetOf(context.draft)`, which the attempt then records), or the
   * machine's own rows (`recordedDraftSet`, which makes a write visible as draft
   * while the unit still runs).
   */
  readonly draft: CheckedWriteDraft;
  /** The system a fact the unit writes names as its reader (0004: `plugin@version`); `madarch-fill-agent` at this build's version by default. */
  readonly source?: FactSource;
  /** The layer the unit's writes stand in (0005); `inferred` for an agent unit by default. */
  readonly layer?: FactLayer;
  /** The caps the unit's tool answers are cut by (0026's numbers when they are left out). */
  readonly limits?: Partial<GraphReadLimits>;
}

/** A run the service refused before it started, with what is missing. */
export interface RefusedFillRun {
  readonly ok: false;
  readonly code: string;
  readonly reason: string;
}

/** The orchestrator the background server owns. */
export interface FillOrchestratorService {
  /** Drives one product's fill run to its end, opening the process's database on the first call. */
  run(request: FillRunRequest): Promise<FillRunResult | RefusedFillRun>;
  /** One run's status, or null when no such run is recorded. */
  status(request: { readonly product: FillProduct; readonly runId: string }): Promise<RunStatus | null>;
  /**
   * Opens one unit's tools: the MCP server its ACP session attaches
   * (`src/fill/acp.ts`, `newSession({ mcpServers })`), bound to the unit's run,
   * scope, snapshot, draft set and limits, and the token that names it
   * (`src/fill/unit-tools.ts`).
   */
  unitTools(request: UnitToolsRequest): Promise<UnitToolsHandle>;
  /**
   * Answers one call a unit's server forwarded (`POST /api/fill/unit/tool`):
   * `null` when no open session holds the call's token, which the route reports
   * as a refusal rather than as a tool's answer.
   */
  unitTool(request: UnitToolCall): Promise<UnitToolAnswer | null>;
  /**
   * One product's graph pages (madarch-tzte.23.1; decision 0026, "Pages"), read
   * from the fill's fact store over the product's folder: the page-worthy nodes the
   * product's units published, one node's page model, and the changes each
   * publication makes — which is what the server's `GET /api/graph/pages`,
   * `GET /api/graph/page` and `GET /api/graph/events` answer from.
   *
   * The pages are not opened with this service: a home whose fill never ran holds
   * no database, and its page set is the empty set with the message naming the fill
   * that would write it — an empty graph answers a message, never an error (0026).
   * The channel is woken by this service's own publications: a run this process
   * drives announces the pages its units' publications touched, in the same process
   * that reads them (decision 0027's one owner and one writer).
   */
  pages(folder: string): GraphPagesSource;
  /**
   * Stops the queue and closes the database this service opened; safe to call
   * twice and safe to call before anything was opened.
   */
  stop(): Promise<void>;
}

export interface FillOrchestratorServiceOptions {
  /** The products home the process's fill database lives under. */
  readonly home: string;
  /**
   * The address this process answers a unit's tool calls at — `${server.url}/api/fill/unit/tool`
   * (`src/server/http.ts`, `UNIT_TOOL_PATH`) — read when a unit's tools are opened,
   * because the server knows its own address only once it listens. A service that
   * names none opens no unit's tools, and a stage whose units run an agent refuses
   * by name rather than starting an agent that cannot read.
   */
  readonly toolUrl?: () => string | undefined;
  /** The declared stages (madarch-tzte.19.3). */
  readonly registry: StageRegistry;
  /** One product's wiring; a service without it refuses every run, naming what is missing. */
  readonly wiring?: (product: FillProduct) => Promise<ProductFillWiring> | ProductFillWiring;
  /**
   * The process's own database owner, when the host already holds one (decision
   * 0027's one owner per process, which is what lets a publication's facts and
   * the orchestrator's record share a transaction): the service borrows it for
   * the fill's tables and the queue and never closes it. Left out, the service
   * opens its own PGlite under the home on the first run asked for and closes it
   * with everything else it opened.
   */
  readonly owner?: DatabaseOwner;
  /** The process's database's data directory; `<home>/.madarch/fill/state.db` when it is left out. */
  readonly databasePath?: string;
  /** The units' queue's name; `fill-units` when it is left out. */
  readonly queueName?: string;
  readonly clock?: () => number;
  readonly limits?: Partial<OrchestratorLimits>;
  readonly sink?: ProgressSink;
  readonly log?: (line: string) => void;
  /** The workers one run drives at once; 1 when it is left out. */
  readonly workers?: number;
  readonly maxPasses?: number;
  /** How the queue is built over the owner; pg-boss when it is left out. */
  readonly queueFactory?: (owner: DatabaseOwner) => Promise<QueueService>;
  /** How the person's pause and stop reach a run; fill-runtime's control file under the product's own state folder when it is left out. */
  readonly control?: (product: FillProduct) => RunControlReader;
}

/** The units' queue's name in the process's database. */
export const DEFAULT_FILL_QUEUE = 'fill-units';

/** Where the process's fill database lives under a products home. */
export function fillDatabasePath(home: string): string {
  return join(home, '.madarch', 'fill', 'state.db');
}

/**
 * Builds the service the background server owns. Nothing is opened here: the
 * owner, the tables and the queue are created when a run is first asked for.
 */
export function createFillOrchestratorService(options: FillOrchestratorServiceOptions): FillOrchestratorService {
  const databasePath = options.databasePath ?? fillDatabasePath(options.home);
  const queueName = options.queueName ?? DEFAULT_FILL_QUEUE;
  const limits = { ...DEFAULT_ORCHESTRATOR_LIMITS, ...options.limits };
  let opening: Promise<{ owner: DatabaseOwner; queue: QueueService; opened: boolean }> | undefined;
  let stopped = false;

  async function open(): Promise<{ owner: DatabaseOwner; queue: QueueService; opened: boolean }> {
    if (opening !== undefined) return await opening;
    opening = (async () => {
      // PGlite opens a data directory, and the state folder it stands in may not be there yet: the
      // process's own folder under the products home is made on the first run asked for.
      const lent = options.owner;
      if (lent === undefined) await mkdir(dirname(databasePath), { recursive: true });
      const database = lent ?? createPGliteDatabaseOwner({ path: databasePath });
      await createFillStateSchema(database);
      await createOrchestratorSchema(database);
      // The store a published fact set lands in is the fill's own (`fact-store.ts`): its tables are
      // created with the rest of the fill's, so a wiring that lands facts there finds them.
      await createFactStoreSchema(database);
      const queue = options.queueFactory !== undefined
        ? await options.queueFactory(database)
        : await createPgBossQueue({ owner: database });
      // The unit's own accounting carries its retries, so the queue retries nothing itself: a settlement
      // here says the attempt is over, and a retry is the orchestrator's own enqueue at its own moment.
      await queue.declare({
        name: queueName,
        leaseSeconds: Math.max(1, Math.ceil(limits.leaseMs / 1000)),
        retries: 0,
        retryDelaySeconds: 0,
        retryBackoff: false,
        singletons: true,
      });
      return { owner: database, queue, opened: lent === undefined };
    })();
    return await opening;
  }

  /** One product's wiring, or the refusal the service answers a caller with where the host wired none. */
  async function wiringOf(product: FillProduct): Promise<ProductFillWiring | RefusedFillRun> {
    if (stopped) return { ok: false, code: 'fill-orchestrator/stopped', reason: 'fill-orchestrator: this service was stopped and opens nothing further' };
    if (options.wiring === undefined) {
      return {
        ok: false,
        code: 'fill-orchestrator/no-wiring',
        reason: `fill-orchestrator: nothing wires the fill of "${product.name}": give the service a wiring that reads the product's pinned snapshot, its configuration, the graph its units read, and the inputs their facts stand on`,
      };
    }
    return await options.wiring(product);
  }

  async function orchestratorFor(product: FillProduct): Promise<FillOrchestrator | RefusedFillRun> {
    const wired = await wiringOf(product);
    if ('ok' in wired) return wired;
    const wiring = wired;
    const { owner, queue } = await open();
    return createOrchestrator({
      database: owner,
      registry: options.registry,
      queue,
      queueName,
      product: product.name,
      configuration: () => wiring.configuration(),
      snapshot: () => wiring.snapshot(),
      graph: (ref, transaction) => wiring.graph(ref, transaction),
      inputs: (ref) => wiring.inputs(ref),
      facts: wiring.facts ?? FACT_APPLICATION,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      control: options.control !== undefined ? options.control(product) : async (runId: string) => await consumeFillControl(product.folder, runId),
      ...(wiring.guard === undefined ? {} : { guard: wiring.guard }),
      // A stage that declares `usesTools` reads and writes through the unit's own MCP server (0026, "Agents and
      // tools"): this process is where that server's calls are answered, so the orchestrator's seam opens one for
      // the unit generation it is about to run, with the attempt's own draft set behind it.
      ...(options.toolUrl === undefined ? {} : {
        unitTools: async (opening: UnitToolsOpening) => {
          const url = options.toolUrl!();
          if (url === undefined || url.trim() === '') {
            throw new Error(`fill-orchestrator: the fill of "${product.name}" runs a unit whose stage reads through its own MCP server, and this process names no address it answers a unit's calls at: give the service toolUrl() (src/fill/orchestrator-host.ts)`);
          }
          return await openUnitTools({
            product,
            unit: { unitId: opening.unit.unitId, generation: opening.unit.generation },
            url,
            draft: draftSetOf(opening.draft),
          });
        },
      }),
      // Every publication this process makes wakes the product's page channel (0026, "Pages"): the server's
      // subscribers ask the store which pages the publication touched (`fill_page_change`), and a publication
      // that touched no page wakes a stream that then writes nothing.
      sink: async (event) => {
        if (event.kind === 'unit-published') notifyPages();
        await options.sink?.(event);
      },
      limits,
      ...(options.log === undefined ? {} : { log: options.log }),
    });
  }

  /** The units' servers: the tokens they were minted, and the sessions those tokens answer for. */
  const units = createUnitToolsHost();

  /**
   * The pinned source a unit's bytes are read from. A host that wires none gets a
   * source whose every question is refused by name: a unit's evidence spans and
   * its writes then answer that the host wired no snapshot, which is what it is,
   * rather than an empty graph a reader could take for an absence.
   */
  async function sourceOf(wiring: ProductFillWiring, product: FillProduct): Promise<WriteSnapshots> {
    if (wiring.source !== undefined) return await wiring.source();
    const refuse = async (): Promise<never> => {
      throw new Error(`fill-orchestrator: the fill of "${product.name}" wires no snapshot source, so the unit's tools cannot read the bytes they cite: give the wiring a source() that opens the run's pinned repositories (src/fill/snapshot.ts)`);
    };
    return { pins: refuse, open: refuse };
  }

  /** The graph a unit's writes stand on: the host's own where it named one, else the fill's fact store when that is where its facts land. */
  async function writeGraphOf(wiring: ProductFillWiring, product: FillProduct, owner: DatabaseOwner): Promise<CheckedWriteGraph> {
    if (wiring.writeGraph !== undefined) return await wiring.writeGraph();
    if (wiring.facts !== undefined && wiring.facts !== FACT_APPLICATION) {
      throw new Error(`fill-orchestrator: the fill of "${product.name}" lands its published facts elsewhere than this process's fact store, and wires no writeGraph(): a unit's writes would ask a graph its facts are not in (src/fill/orchestrator-host.ts)`);
    }
    return factGraph(owner);
  }

  /**
   * One unit's tools, opened for it: the session the unit's scope, reader, pinned
   * bytes and draft set are bound to, published at the address this process answers
   * a unit's calls at.
   */
  async function openUnitTools(request: UnitToolsRequest): Promise<UnitToolsHandle> {
    return units.open({ session: await unitSessionFor(request), url: request.url });
  }

  /**
   * One unit's sessions, bound to it: the plan row that names the run it belongs
   * to and the scope it covers (0027), the reader its calls are recorded in, the
   * pinned bytes its spans and writes cite, the graph its writes stand on, and the
   * draft set the attempt hands over.
   */
  async function unitSessionFor(request: UnitToolsRequest): Promise<UnitToolSession> {
    const wired = await wiringOf(request.product);
    if ('ok' in wired) throw new Error(`${wired.code}: ${wired.reason}`);
    const wiring = wired;
    const { owner } = await open();
    const plan = await readUnitPlan(owner, request.unit.unitId, request.unit.generation);
    if (plan === null) {
      throw new Error(`fill-orchestrator: the unit ${JSON.stringify(request.unit.unitId)} generation ${request.unit.generation} of "${request.product.name}" holds no plan row, so nothing says which run its drafts belong to or what it covers: a unit's tools are opened after its plan was recorded (src/fill/orchestrator-host.ts)`);
    }
    const ref: UnitRef = { stageId: plan.stageId, stageUnitId: plan.stageUnitId, unitId: plan.unitId, scope: plan.scope, generation: plan.generation };
    // The reader is the wiring's own, which answers this module's reads and passes a stage's SQL through as
    // it asks (madarch-tzte.20.3), and every read a tool makes through it is recorded as this generation's
    // dependency — the orchestrator's own rule (`recordUnitRead`, which its `context.graph` applies to the
    // reads a stage makes itself). The tools then need no second way of recording what they read.
    const reader = await wiring.graph(ref);
    const reads = graphReadsOver({
      query: async (text: string) => {
        const rows = await reader.query(text);
        await recordUnitRead(owner, { unitId: plan.unitId, generation: plan.generation, query: text, rows, at: (options.clock ?? Date.now)() });
        return rows;
      },
    }, request.limits, { run: plan.runId, unit: { unitId: plan.unitId, generation: plan.generation } } satisfies DraftReading);
    const snapshot = await sourceOf(wiring, request.product);
    const scope = writeScope(plan.scope);
    return {
      unit: { unitId: plan.unitId, generation: plan.generation },
      reads,
      writes: {
        unit: { unitId: plan.unitId, generation: plan.generation },
        source: request.source ?? { system: 'madarch-fill-agent', version: runningVersion() },
        layer: request.layer ?? 'inferred',
        scope,
        snapshot,
        draft: request.draft,
        graph: await writeGraphOf(wiring, request.product, owner),
      },
    };
  }

  /** The page channels this process's server holds open: a publication wakes each of them, and each reads its own product's changes. */
  const pageListeners = new Set<() => void>();

  /**
   * The answers this process has already read of the graph (madarch-tzte.23.8): the
   * page set, a page model and a diagram answer per product and node, kept between
   * publications because a page of the current tree costs seconds of store reads
   * (`page-cache.ts`). The same publication that wakes the channels below drops them,
   * so a client is never handed a page older than the change it was told about.
   */
  const pageCache = createPageReadCache();

  /** Every open page channel hears that a publication landed, and nothing kept from before it stands; a listener that fails is its own stream's business. */
  function notifyPages(): void {
    pageCache.drop();
    for (const listener of [...pageListeners]) {
      try {
        listener();
      } catch {
        // A stream that ended between the publication and this call is dropping out of the set itself.
      }
    }
  }

  /**
   * The owner a product's pages are read through: the process's own when this
   * service opened it on the first run asked for, and nothing at all when the fill
   * never ran in this home — a server that serves wikis pays nothing for a graph
   * nobody filled, and its page set is the empty one with the message saying so.
   */
  async function pageDatabase(): Promise<DatabaseOwner | undefined> {
    // A stopped service reads nothing, and says so: answering the empty page set here would claim the product's
    // graph holds nothing, which is a statement about the store this service no longer reads.
    if (stopped) throw new Error('fill-orchestrator: the fill service was stopped, so it reads no graph: the pages are served while the service that owns the database runs');
    if (options.owner === undefined && existsSync(databasePath) === false) return undefined;
    return (await open()).owner;
  }

  /** The product's own name, as its manifest names it: the name a fill's runs name it, and the pages' scope (`fill_unit.product`). */
  function productNameOf(folder: string): string {
    const read = readProduct(folder);
    if (!read.ok) {
      throw new Error(`fill-orchestrator: the graph pages of ${folder} cannot name their product: ${read.message} (${read.file}, line ${read.line})`);
    }
    return read.product.name;
  }

  return {
    pages(folder: string): GraphPagesSource {
      return {
        async pageSet() {
          const database = await pageDatabase();
          if (database === undefined) {
            return {
              product: productNameOf(folder),
              pages: [],
              counts: [],
              total: 0,
              changeSeq: 0,
              readAt: (options.clock ?? Date.now)(),
              message: emptyPageSetMessage(productNameOf(folder)),
            };
          }
          const product = productNameOf(folder);
          // A set read before this process's last publication is the set the store still holds: the page set is a
          // function of the product's facts, and the publication that changed them dropped what this cache kept.
          const kept = pageCache.pageSet(product);
          if (kept !== undefined) return kept;
          // The generation is taken before the store is read, so an answer a publication overtakes while it is read is
          // never kept (`page-cache.ts`).
          const generation = pageCache.generation;
          return pageCache.keepPageSet(product, await readPageSet({ database, product, folder, at: (options.clock ?? Date.now)() }), generation);
        },
        async page(id: string) {
          const database = await pageDatabase();
          if (database === undefined) {
            return { ok: false, code: 'graph-pages/no-graph', message: `this home holds no fill's graph yet: the pages are drawn from the graph a fill run writes — run a fill, and the page ${id} appears as its units publish` };
          }
          const product = productNameOf(folder);
          const kept = pageCache.page(product, id);
          if (kept !== undefined) return { ok: true as const, page: kept };
          const generation = pageCache.generation;
          const read = await readPageModel({ database, product, id, at: (options.clock ?? Date.now)() });
          // A refusal is a cheap answer (an id's own kind, or one fact's absence) and is never kept: a page that
          // stands nowhere must stand as soon as its node is published. A page that shows drafts is not kept either:
          // a draft set is recorded before its unit publishes, so a page's drafts move without a publication, and the
          // cache is dropped by publications only.
          const keep = read.ok && read.page.drafts.length === 0;
          return read.ok ? { ok: true as const, page: keep ? pageCache.keepPage(product, id, read.page, generation) : read.page } : read;
        },
        async diagrams(id: string) {
          const database = await pageDatabase();
          if (database === undefined) {
            return { ok: false, code: 'graph-pages/no-graph', message: `this home holds no fill's graph yet: the diagrams are drawn from the graph a fill run writes — run a fill, and the diagrams of ${id} appear as its units publish` };
          }
          const product = productNameOf(folder);
          const kept = pageCache.diagrams(product, id);
          if (kept !== undefined) return kept;
          const generation = pageCache.generation;
          const read = await readNodeDiagrams({ database, product, id, at: (options.clock ?? Date.now)() });
          return read.ok ? pageCache.keepDiagrams(product, id, read, generation) : read;
        },
        async changes(after: number) {
          const database = await pageDatabase();
          if (database === undefined) return { changes: [], lastSeq: 0, truncated: false, marker: null };
          return await readPageChanges({ database, product: productNameOf(folder), after });
        },
        subscribe(listener: () => void): () => void {
          pageListeners.add(listener);
          return () => {
            pageListeners.delete(listener);
          };
        },
      };
    },
    async unitTools(request: UnitToolsRequest): Promise<UnitToolsHandle> {
      return await openUnitTools(request);
    },
    async unitTool(request: UnitToolCall): Promise<UnitToolAnswer | null> {
      return await units.call(request);
    },
    async run(request: FillRunRequest): Promise<FillRunResult | RefusedFillRun> {
      const built = await orchestratorFor(request.product);
      if ('ok' in built) return built;
      const orchestrator = built;
      if (request.resume === true) await resumeRun(orchestrator, { runId: request.runId });
      const started = await startRun(orchestrator, { runId: request.runId });
      if (!started.ok) return { ok: false, code: started.code, reason: started.reason };
      const planned = await planRun(orchestrator, { runId: request.runId });
      if (planned.outcome === 'refused') return { ok: false, code: planned.code, reason: planned.reason };
      const reused = planned.outcome === 'planned' ? planned.reused : [];
      const foundNothing = planned.outcome === 'planned' ? planned.foundNothing : [];
      const driven = await driveRun(orchestrator, {
        runId: request.runId,
        workers: request.workers ?? options.workers ?? 1,
        ...(request.maxPasses === undefined && options.maxPasses === undefined ? {} : { maxPasses: request.maxPasses ?? options.maxPasses }),
      });
      const status = await runStatus(orchestrator, request.runId);
      return {
        ok: true,
        runId: driven.run.runId,
        state: driven.run.state,
        settled: driven.settled,
        passes: driven.passes,
        work: driven.work,
        ...(driven.stoppedBecause === undefined ? {} : { stoppedBecause: driven.stoppedBecause }),
        units: (status?.units ?? []).map((unit) => ({ unitId: unit.unitId, stageId: unit.stageId, state: unit.state, generation: unit.generation, attempts: unit.attempts })),
        reused,
        foundNothing,
      };
    },
    async status(request: { readonly product: FillProduct; readonly runId: string }): Promise<RunStatus | null> {
      const built = await orchestratorFor(request.product);
      if ('ok' in built) return null;
      return await runStatus(built, request.runId);
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      // A channel's listeners are the server's streams, and this service hears nothing more: the streams end with
      // the server's own connections (its stop closes them), and a stream whose read fails now says so in the log.
      pageListeners.clear();
      // A unit's token is a capability: stopping the service ends every session it minted.
      units.closeAll();
      if (opening === undefined) return;
      const opened = await opening;
      let failure: unknown;
      try { await opened.queue.stop(); } catch (error) { failure ??= error; }
      // A lent owner is the host's: only an owner this service opened is closed here.
      if (opened.opened) {
        try { await opened.owner.close(); } catch (error) { failure ??= error; }
      }
      if (failure !== undefined) throw failure;
    },
  };
}
