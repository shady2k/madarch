/**
 * One product's knowledge wiki (decision 0029): the product's own graph store,
 * the fill that writes it, and the reads that draw its pages.
 *
 * The store is a PostgreSQL database on a server of its own under the machine's
 * state (outside the product repository: 0023, a derived index is rebuilt, never transferred),
 * named by the product's id, which survives a rename of its folder. A fill
 * runs the extract driver over each repository the manifest declares, into
 * that store, one commit at a time; after each commit the pages that are open
 * are told to read again (`subscribe`). What each repository was filled to is
 * the graph's own repository entity and its as-is edge, so a source view shows
 * the bytes the graph's spans were read from, and a restarted server still knows.
 */
import { GUIDE_OUTPUTS, type GuideKind, type GuideLocale } from './guide-outputs.js';
import { createRecordSchema } from '../graph/index.js';
import { hasGeneratedTable } from '../graph/tables.js';
import { EMPTY_CONTRACT } from '../graph/contract.js';
import { declaredEdgeReads, declaredKindReads, graphContractOf } from '../fill/stages/plugin-contract.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createDatabaseOwner, type DatabaseOwner, type OuterTransaction } from '../adapters/database-owner.js';
import { SCHEMA_LOCK_SQL, storeSchemaLockKey } from '../adapters/schema-stamp.js';
import { byCodePoint } from '../model/order.js';
import { readProduct, type ProductIdentity } from '../product/manifest.js';
import { productRepositoryId } from '../product/identity.js';
import { headCommitOf } from '../product/fill-updates.js';
import { homeKind, KINDS_FILE, readKinds, readKindsFrom, setKindsLanguage, type Finding, type KindsManifest } from './kinds.js';
import { applyReset, planReset, type ResetPlan } from './reset.js';
import type { KnowledgeFillResult, KnowledgeFillRun } from './fill-run.js';
import { askFillRun, openFillRunQueue } from '../fill/run-jobs.js';
import { startKnowledgeFill } from './fill-run.js';
import { askRunControl, readFillEnd } from '../fill/orchestrator-store.js';
import { readLiveRun, readStoreStamp } from '../fill/state-store.js';
import { fillWritesPages } from '../fill/steps.js';
import { locationOf, type RenderContext } from './blocks.js';
import { GraphReader, type GeneratedEdgeRead, type GeneratedKindRead, type GraphEntity } from './graph-read.js';
import { withHistoryLinks, type HistoryContext, type HistorySelection } from './temporal.js';
import { readMarkdownEntitiesFrom, type MarkdownEntity } from './markdown.js';
import type { AgentOffer, Block, CatalogView, ChangedPage, DocumentListing, DocumentPage, DocumentRef, FillErrorView, FillRunView, FillSelectionView, FillState, Neighborhood, PageModel, PlannedMarkView, PlannedSectionView, RepositoryFactsView, SearchView, WikiStatus, WriterState, WriterUnit } from './model.js';
import { readFillProgressOf } from '../obs/progress.js';
import { readTraceRun } from '../obs/trace-report.js';
import { traceFiles } from '../obs/trace.js';
import { withSpan } from '../obs/trace.js';
import { neighborhoodOf } from './diagrams.js';
import { anchorLines, documentAnchors, titleOfAnchor } from './anchors.js';
import { adapterOf, installAdapter, offers, queryAgentChoices, WRITER_AGENTS, WRITER_BOUNDS } from './agents.js';
import { DEFAULT_EDITORIAL_REQUESTS_PER_PAGE, MAX_EDITORIAL_REQUESTS } from '../writer/editorial.js';
import type { WriterBounds } from './model.js';
import { isModelRole, modelPair, resolveModelRoles, type ModelAssignments, type ModelPair, type ModelRole, type ModelRoleView } from './model-roles.js';
import type { AgentChoices } from '../fill/acp-choices.js';
import { journalFolder, journalOfUnit, NO_COUNTERS, readJournalFile, type Journal, type PageJournal } from '../writer/journal.js';
import { PRODUCT_PATH, type UnitAgent } from '../writer/units.js';
import { CONTENT_LANGUAGES } from '../writer/units.js';
import type { DraftEnv } from '../product/home.js';
import type { KindSummary } from './model.js';
import { findSubject, kindSummaries, productTitleOf, renderPage, listEntities, searchWiki, type PageResult } from './render.js';
import { catalogKinds, groupViews } from './catalog-view.js';
import { indexCounts, statementsRelyingOn } from './index/queries.js';
import { ACTIVE_FILL_FILE, CHANGED_PAGES_FILE, invalidateInterruptedRun, readChangedPages } from './changed-pages.js';
import { webLink } from './index/web-link.js';
import { acpGraphJudge } from './graph-verdict-acp-judge.js';
import { graphVerdictFile, loadGraphSnapshot, readGraphVerdictState, writeGraphVerdictBudgets, writeGraphVerdictState } from './graph-verdict-store.js';
import { GRAPH_VERDICT_VALIDATOR_VERSION, graphVerdictFingerprint, graphVerdictReport, graphVerdictRows, graphVerdictsRunnable, runGraphVerdicts, type GraphEvidenceContent, type GraphJudge, type GraphJudgeFactory, type GraphVerdictBudgets, type GraphVerdictMetrics, type GraphVerdictReport, type GraphVerdictRow } from './graph-verdicts.js';

import { archifyFrame, likec4Model } from './view-frames.js';
import { buildViews, chosenRenderer, parseSpec, payloadOf, RENDERERS_OF, ViewRefusal, type GraphView, type ViewPayload } from './views.js';
import { buildStatement, type StatementResult } from './statement.js';
import { documentAddress, entityAddress } from './addresses.js';
import { noEntityMessage, Resolver, type Resolution } from './resolve.js';
import { DOCUMENT_LIMIT, DOCUMENT_PATH, HARNESS_FILES, documentTitle, listedDocument } from './doc-sources.js';
import { readCorrectionsIn } from '../loop/entities.js';
import { answerQuestion, commitFiles, localIdentity, LoopRefusal, recordCorrection, type Answered, type Corrected } from '../loop/answer.js';
import { readScope, readTasks, renderTask, scopeWords, TASKS_FOLDER, taskSlug, writeTask, type PlaceView, type PlannedTask, type TaskScope } from '../loop/tasks.js';
import { impactOf, type TaskImpact } from '../loop/impact.js';
import { impactGroundsOf } from '../loop/planned.js';
import { closingCommit, type RepositoryRef } from '../loop/closure.js';
import { groundsOfScope, NO_MARKS, markForEntity, marksForDocument, marksForPage, plannedMarks, type PlannedMarks } from '../loop/planned.js';
import { proposeTask, type TaskChoice, type TaskProposal } from '../loop/propose.js';
import { readKnowledgePagesFrom, type IndexedPage } from './index/index.js';
import { StoredProductFiles } from './product-source.js';
import { warmRenderWorker } from './liquid.js';
import { planRefresh, type RefreshPlan } from '../loop/plan.js';
import { listQuestions, listTasks, openTasks, questionDetail, taskDetail, type Problem, type ProblemCategories, type ProblemItems, type ProblemListing, type ProblemSources, type QuestionDetail, type QuestionListing, type TaskDetail, type TaskListing, type TaskRow } from '../loop/views.js';
import { collectProblems, openProblemsOf } from '../problems/index.js';
import { defaultSettings, type ProblemSection, type ProblemSeverity } from '../problems/types.js';
import { WikiReadError } from './read-error.js';
import { productStoreFolder, storeDatabasePath } from '../product/store.js';
import { readProblemDismissalsIn, writeProblemDismissal } from '../loop/problem-files.js';
import { readFillSelection, writeFillSelection } from '../adapters/fill-selection.js';
import { readUnitStates } from '../fill/state-store.js';
import { PLUGIN_TURN_STAGE_ID } from '../fill/plugin-turns.js';
import { readPublishedDependencies, readPublishedManifest } from '../graph/manifest-publication.js';

/**
 * What a manifest declares for the graph reader: the graph kinds its contract names, and the tables its own field
 * bindings build. No kind's name stands here: the manifest is the product's data and the reader reads it.
 */
function graphKindsOf(manifest: KindsManifest): { declared: ReadonlySet<string>; generated: ReadonlyMap<string, GeneratedKindRead>; edges: ReadonlyMap<string, GeneratedEdgeRead> } {
  const contract = graphContractOf(manifest);
  // Vertices and edges both: a read asks whether the product declares an edge kind too (history, touched).
  return { declared: new Set([...contract.vertex.map((kind) => kind.name), ...contract.edge.map((kind) => kind.name)]), generated: declaredKindReads(manifest), edges: declaredEdgeReads(manifest) };
}

/** The most terms one listing of a glossary kind reads; a larger glossary is cut rather than read whole. */
const GLOSSARY_TERM_LIMIT = 5000;

/** One term as the glossary page states it: what it is, its other names, and the file and lines it is stated at. */
export interface GlossaryTermView {
  readonly id: string;
  readonly title: string;
  readonly definition: string;
  readonly synonyms: readonly string[];
  readonly code: readonly string[];
  readonly usedIn: string | null;
  readonly ambiguous: string | null;
  readonly repo: string | null;
  readonly path: string;
  readonly line: number;
  readonly endLine: number;
  readonly anchor: string | null;
  readonly single: boolean;
  readonly href: string;
}

const execFileAsync = promisify(execFile);

/** The writer's id for the unit that writes one document's localized source, whose page is the document entity's own id. */
const LOCALIZED_SOURCE_UNIT = 'localized-source:';

/** The scopes of a confirmed task, each once, in the order the reader sent them. */
const dedupeScopes = (scopes: readonly TaskScope[]): TaskScope[] => {
  const byKey = new Map<string, TaskScope>();
  for (const scope of scopes) byKey.set(JSON.stringify(scope), scope);
  return [...byKey.values()];
};



/**
 * The page an archify frame answers when the renderer could not draw: one sentence in the reader's language, and a
 * message to the app, which then shows the same view under a renderer that did draw.
 */
export { WikiReadError } from './read-error.js';

/** A reader nobody has asked for this long is closed, and its memory given back; the next page opens it again. */
const READER_IDLE_MS = 10 * 60_000;

/** Starts the agent that writes the pages; the error names why it cannot. */
export type AgentFactory = (agentId: string, journal: Journal) => (UnitAgent & { close(): Promise<void> }) | { error: string };

export interface KnowledgeProductOptions {
  productFolder: string;
  /** The folder the product's store lives under: `<root>/<product id>/graph`. */
  storeRoot: string;
  /** A fill that is told to stop and the clock for it; tests inject. */
  now?: () => Date;
  /** The environment the agents' adapters are found and installed by (HOME, PATH). */
  env?: DraftEnv;
  /** Starts the chosen agent for the writer; the production one starts the agent's ACP adapter. Tests inject a scripted agent. */
  agentFactory?: AgentFactory;
  /** Where the knowledge wiki says what it could not do; the host's error log. */
  errorLog?: (line: string) => void;
  /** The least time between two snapshots of the store the fill writes, in milliseconds (default 8000). */
  snapshotMs?: number;
  /**
   * Whether a press of this product asks a fill process for the run instead of running it here (madarch-8bdc.9): the
   * server's products do (the api role never fills), a `madarch fill` or a test that drives this class alone does not.
   */
  fillQueued?: boolean;
  /** Asks an agent which models it offers; the production one starts its ACP adapter. Tests inject. */
  choicesQuery?: (agentId: string, env: DraftEnv) => Promise<{ ok: true; choices: AgentChoices } | { ok: false; message: string }>;
  /** Starts a graph verdict judge for a resolved pair; tests inject a scripted one, production starts its ACP agent. */
  graphJudgeFor?: GraphJudgeFactory;
  /** A judge the host already built (jev, madarch-mwhd.1 finding 6); it reads a batch before the role judges. */
  graphJev?: GraphJudge;
  /** The host's version name for `graphJev`, part of every cache key while it is in use. */
  graphJevVersion?: string;
}

/** What the graph verdicts page and its API ask for (madarch-mwhd.1). */
export interface GraphVerdictProductView {
  readonly file: string;
  readonly budgets: GraphVerdictBudgets;
  readonly rows: readonly GraphVerdictRow[];
  readonly report: GraphVerdictReport;
  readonly metrics: GraphVerdictMetrics;
  /** True when no snapshot had changed and the previous result was read as it stood. */
  readonly cached: boolean;
}

interface PageSnapshot {
  owner: DatabaseOwner;
  transaction: OuterTransaction;
  validAt: string;
  pins: ReadonlyMap<string, RepositoryPin>;
}

/** Owner-based index readers may run statements, but cannot open a nested snapshot on the same pipe. */
export function pageSnapshotOwner(owner: DatabaseOwner, transaction: OuterTransaction): DatabaseOwner {
  return new Proxy(owner, {
    get(target, key) {
      if (key === 'transaction') return () => { throw new Error('a page snapshot cannot open a nested transaction; use its shared transaction'); };
      if (key === 'run') return async (work: (tx: OuterTransaction) => Promise<unknown>) => await work(transaction);
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The writer's units as a reader knows them (madarch-m38l.23): the page each one writes, and that page's kind and title as
 * the wiki knows them now — from the Markdown for a page that stands, from the product page's own declaration for a
 * domain still waiting. Nothing is invented: a unit whose page neither stands nor is declared keeps only what the run
 * said about it, and no field is filled from the unit's id.
 */
function namedUnits(ctx: RenderContext, units: readonly WriterUnit[]): WriterUnit[] {
  return units.map((unit) => {
    const page = ctx.markdown.get(unit.unit);
    const family = unit.unit.slice(0, unit.unit.indexOf(':'));
    // The unit's own id names the page kind it writes (`product`, `domain`, `administrator-guide`): a name only where
    // the manifest declares that kind, so the reader never reads a kind this product does not have.
    const declared = unit.kind ?? family;
    const kind = page?.kind ?? (ctx.manifest.kinds.has(declared) ? declared : undefined);
    const title = page?.title ?? unit.title;
    return { ...unit, page: unit.unit, ...(kind === undefined ? {} : { kind }), ...(title === undefined ? {} : { title }) };
  });
}

/** What a paused run needs to be taken up, kept beside the store with the pause (madarch-m38l.17). */
interface PausedRun {
  readonly language: string;
  readonly languageChanged: boolean;
  readonly languageFrom: string;
  readonly plan?: RefreshPlan;
  /** The pages this run published before the pause: resume never asks the agent for them again. */
  readonly completedPages: readonly string[];
  readonly task?: string;
  readonly taskPages?: readonly string[];
  readonly resumed?: boolean;
}

/** The largest document the wiki reads: a document over it is titled by its path and not read. */
const DOCUMENT_READ_BYTES = 1024 * 1024;

/** The documents one page of the graph's document query answers: the listing reads every page to count them all. */
const DOCUMENT_PAGE = 500;

/** One read of the status and the render context its writer units were named against. */
type StatusRead = { body: WikiStatus; ctx: RenderContext | undefined };

/** What the source view answers for one file: its text at the commit read, or why the graph holds none of that version. */
export type SourceRead = { readonly text: string; readonly commit: string | null; readonly history?: HistoryContext } | { readonly absent: string };

export class KnowledgeProduct {
  /** The store the reads are made on: a snapshot of the primary store, or an empty one before any fill (see `fill-protocol.ts`). */
  /**
   * The store's owner, read directly (madarch-8bdc.9): one owner of `<store>/graph` in this process, no reader copy and no
   * numbered snapshot. A page's consistency is its own read's transaction, and a publication moves the generation the
   * store's numbers are cached under — `seq`, which no file names.
   */
  private reader: { owner: DatabaseOwner; seq: number } | undefined;
  /** The generation of the store this process has read: raised once per publication a fill announces. */
  private generation = 0;
  /** The store's own stamp when this process last read it: a publication moves it, whoever ran the fill. */
  private storeStamp: string | undefined;
  private opening: Promise<void> | undefined;
  /** The store's fill-run queue, opened with the store and closed with it (madarch-8bdc.9). */
  private fillQueue: Awaited<ReturnType<typeof openFillRunQueue>> | undefined;
  private fill: FillState = { state: 'idle' };
  private running: Promise<void> | undefined;
  /** The fill the store is running now, as its host controls it; undefined between runs. */
  private fillRun: KnowledgeFillRun | undefined;
  /** The run id of the fill under way: the trace it writes is read by that id, never as "the newest file". */
  private fillRunId: string | undefined;
  /** What the last finished run's trace and the store's counts say: the end state's numbers. */
  private fillExtras: { counts?: FillState['counts']; run?: FillRunView; error?: FillErrorView } = {};
  /** A person asked for a stop: the run ends now, and the page in progress stays as it was before the run. */
  private stopAsked = false;
  /** The pause kept beside the store was read into this product's state; one read is enough for the life of the process. */
  private pauseRestored = false;
  /** The paused run a next fill takes up, if this product has one. */
  private pausedRun: PausedRun | undefined;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly pins = new Map<string, RepositoryPin>();
  private revision = 0;
  private writer: WriterState = { state: 'idle', agent: null, units: [] };
  private writerAgent: { close(): Promise<void> } | undefined;
  private installing: Promise<unknown> | undefined;
  private choosing: Promise<unknown> = Promise.resolve();
  private choiceWrites = 0;
  private swapping: Promise<void> = Promise.resolve();
  /** A reset is under way: no fill starts meanwhile, and no second reset. */
  private resetting = false;
  private verdictRun: Promise<GraphVerdictProductView> | undefined;
  private lastUse = Date.now();
  /**
   * The Problems listing, kept until the inputs the Problems page reads change (madarch-m38l.19). A status poll reads
   * it; a page's badge reads it; the Problems page, the first reader of a product and a background refresh collect it.
   */
  private problemsCache: { key: string; sequence: number; listing: ProblemListing } | undefined;
  /** The listing being collected for a key: a reader that asks while it runs waits for the same work, never a second walk. */
  private problemsFlight: { key: string; promise: Promise<ProblemListing> } | undefined;
  /** Orders collections, so a listing for older inputs that lands late never replaces a newer one. */
  private problemsSequence = 0;
  /** The key whose background collection failed: the menu does not walk it again on every poll. */
  private problemsFailed: string | undefined;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  /** The pages the last fill changed, as told and as kept beside the store (madarch-u3vw2). */
  private changedPages: ChangedPage[] | undefined;
  private changedLoaded = false;

  constructor(private readonly options: KnowledgeProductOptions) {
    this.invalidateInterruptedRun();
  }

  get folder(): string {
    return this.options.productFolder;
  }

  /** The product as its manifest reads; refused when it cannot be. */
  product(): ProductIdentity | { message: string } {
    const read = readProduct(this.options.productFolder);
    if (!read.ok) return { message: `${read.file}:${read.line}: ${read.message}` };
    return read.product;
  }

  private storeFolder(): string {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    return productStoreFolder(this.options.productFolder, this.options.storeRoot);
  }


  /**
   * Opens the store once, in this process (madarch-8bdc.9): the wiki reads the database the fill writes, directly. A store
   * with no tables at all (an empty folder the home made, or an earlier madarch's) is given them here, as the fill's own
   * schema does, so a first read is an empty page and never a missing relation; a store that has them is read and not
   * touched — a write here would lock the tables a running fill publishes into.
   */
  private async open(): Promise<DatabaseOwner> {
    if (this.closed) throw new Error('the wiki is shutting down');
    this.lastUse = Date.now();
    this.idleTimer ??= setInterval(() => { void this.closeIfIdle(); }, 60_000).unref();
    this.opening ??= (async () => {
      const owner = await createDatabaseOwner({ store: storeDatabasePath(this.storeFolder()), btreeGist: true });
      try {
        await owner.ready;
        await this.ensureStoreTables(owner);
        await this.loadPins(owner);
        // The publication the pins were read at: the first answer does not read them again (followStoreFill).
        this.storeStamp = await readStoreStamp(owner).catch(() => undefined);
      } catch (error) {
        // An owner that failed to open is given back: a retry must not leave a connection behind per request.
        await owner.close().catch(() => undefined);
        throw error;
      }
      this.reader = { owner, seq: this.generation };
    })();
    try {
      await this.opening;
    } catch (error) {
      this.opening = undefined;
      throw error;
    }
    return this.reader!.owner;
  }

  /**
   * Gives a store that has no tables the graph's and the record tables, once. A fill creating the same tables at the same
   * instant holds the locks in its own order and one of the two is chosen as the deadlock victim: that answer is
   * PostgreSQL telling this side to try again, and the second attempt finds the tables the other committed.
   */
  private async ensureStoreTables(owner: DatabaseOwner): Promise<void> {
    const there = async (): Promise<boolean> => (await owner.run(async (tx) => await tx.query<{ there: boolean }>("SELECT to_regclass('public.node') IS NOT NULL AS there"))).rows[0]?.there === true;
    if (await there()) return;
    for (let attempt = 1; ; attempt += 1) {
      try {
        // This store's record tables too (madarch-8bdc.2.5): a store the fill has not run on is read for its repository
        // and its files, and a missing relation would be a failed page, not an empty one. The contract is the empty one:
        // this read holds no manifest yet (the graph it would be read from is what this call creates), and the fill that
        // reads the product repository adds the kinds' tables from the manifest it read.
        await createRecordSchema(owner, EMPTY_CONTRACT);
        // Serialized with every other schema of this store (`src/adapters/schema-stamp.ts`).
        await owner.transaction('write', async (tx) => {
          await tx.query(SCHEMA_LOCK_SQL, [storeSchemaLockKey()]);
        });
        return;
      } catch (error) {
        const retryable = /deadlock detected/i.test(String(error)) || /could not serialize access/i.test(String(error));
        if (!retryable || attempt >= 5) throw error;
        await Bun.sleep(100 * attempt);
        if (await there()) return;
      }
    }
  }

  /** The product's own files as one graph revision holds them, and the revision they were read at. */
  private filesMemo: { seq: number; repository: string; files: StoredProductFiles } | undefined;

  /**
   * The product repository's own files as the graph holds them, once per graph revision: the manifest and the declaration
   * files beside it, the Markdown entities, the templates and the files of the loop are read here. A reader of a page
   * never opens the checkout: the files producer read it into the graph, and this is the graph's answer (stage C).
   */
  private async productFiles(snapshot?: PageSnapshot): Promise<StoredProductFiles> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const repository = productRepositoryId(product);
    const owner = snapshot?.owner ?? await this.open();
    const reader = new GraphReader(owner, snapshot === undefined ? this.validAt : () => snapshot.validAt, undefined, snapshot?.transaction);
    const seq = this.reader?.seq ?? 0;
    const held = this.filesMemo;
    // A page's transaction reads the text in that transaction; the index is the revision's and is reused.
    if (held !== undefined && held.seq === seq && held.repository === repository) return snapshot === undefined ? held.files : held.files.withReader(reader);
    const files = await StoredProductFiles.load(reader, repository, product.folder);
    this.filesMemo = { seq, repository, files };
    return files;
  }

  /** The manifest one graph revision was read as: the whole parse stands for the revision, not for a page. */
  private manifestMemo: { seq: number; folder: string; read: ReturnType<typeof readKindsFrom> } | undefined;

  /** The product's kinds manifest and the declaration files beside it, read from the graph: absent when the graph holds none. */
  private async manifestRead(folder: string, snapshot?: PageSnapshot): Promise<ReturnType<typeof readKindsFrom>> {
    const seq = this.reader?.seq ?? 0;
    const held = this.manifestMemo;
    if (held !== undefined && held.seq === seq && held.folder === folder) return held.read;
    return await this.manifestFrom(folder, snapshot);
  }

  /** The validated manifest metadata published at this graph revision. */
  private async manifestFrom(folder: string, snapshot?: PageSnapshot): Promise<ReturnType<typeof readKindsFrom>> {
    const seq = this.reader?.seq ?? 0;
    const held = this.manifestMemo;
    if (held !== undefined && held.seq === seq && held.folder === folder) return held.read;
    const manifest = snapshot === undefined
      ? await (await this.open()).run(async (tx) => await readPublishedManifest(tx))
      : await readPublishedManifest(snapshot.transaction);
    const read: ReturnType<typeof readKindsFrom> = manifest === undefined
      ? { present: false, file: join(folder, KINDS_FILE) }
      : { present: true, manifest };
    this.manifestMemo = { seq, folder, read };
    return read;
  }

  /**
   * The roles this product's manifest declares, in its order (decision 0031, "the roles are the product's"): the
   * reader's settings accept these and "everything" alone, and the engine keeps no role of its own.
   */
  async declaredRoles(): Promise<string[]> {
    const product = this.product();
    if ('message' in product) return [];
    const read = await this.manifestRead(product.folder);
    return read.present ? [...read.manifest.roles.keys()] : [];
  }

  /**
   * Opens the reader and waits for it: a server starts its products before the first request. The init is not run here:
   * seeding or upgrading a product writes and commits its files, and a server start is not the place a product's repository
   * changes; the first page (or the first status) does that, before it reads.
   */
  async warmNow(): Promise<void> {
    try {
      if (this.closed || process.env['MADARCH_SKIP_WARM'] === '1') return;
      // A product with no store yet is not warmed: opening it would create the store at server start.
      if (!existsSync(storeDatabasePath(this.storeFolder()))) return;
      await this.open().catch(() => undefined);
      // The render worker too: a server that warms before its first answer must not make the first page pay the
      // worker's process start (measured on the own wiki: 450 ms of a 1 030 ms cold page).
      await this.warmReader();
      // And the repository pages' aggregates: their first read is what a repository page spends most of its time on,
      // and a page read from cold shared buffers paid it twice (madarch-64o5.3's own wiki, 2 554 commits).
      const product = this.product();
      if ('message' in product) return;
      const read = await this.manifestRead(product.folder);
      if (!read.present || this.reader === undefined) return;
      const kinds = graphKindsOf(read.manifest);
      const reader = new GraphReader(this.reader.owner, () => this.validAt(), undefined, undefined, kinds.declared, kinds.generated);
      for (const repository of await reader.repositoryFactsAll().catch(() => [])) {
        await reader.repositoryHistory(repository.nodeId, 100).catch(() => undefined);
        await reader.fileIndex(repository.name).catch(() => undefined);
      }
    } catch {
      // A product with no store yet has no context to warm; the first page opens it.
    }
  }

  /** Starts the reader in the background, so the first page a person opens does not wait for it to start. */
  warm(): void {
    if (this.closed || this.opening !== undefined) return;
    void this.warmReader();
  }

  /**
   * The reader's warm-up: the manifest as the graph holds it, and the templates. Every page is drawn in a worker of the
   * product's own (madarch-u3vw.1; madarch-64o5.3: the engine holds no template of its own to draw a page with), started
   * here, so the first page a reader opens does not pay the process's start.
   */
  private async warmReader(): Promise<void> {
    const product = this.product();
    if ('message' in product) return;
    await this.open().catch(() => undefined);
    try {
      const read = await this.manifestRead(product.folder);
      if (!read.present) return;
      const files = await this.productFiles();
      await files.ensureBelow('templates');
      await warmRenderWorker(files, product.folder);
    } catch {
      // The first page says what could not be read; nothing is warmed from a store that cannot answer.
    }
  }

  /** Gives back the reader of a product nobody is reading, unless a fill is under way. */
  private async closeIfIdle(): Promise<void> {
    if (this.closed || this.running !== undefined || this.reader === undefined || Date.now() - this.lastUse < READER_IDLE_MS) return;
    const held = this.reader;
    await this.swapping.catch(() => undefined);
    if (this.reader !== held) return;
    this.reader = undefined;
    this.opening = undefined;
    // The store's fill-run queue is opened on this reader's owner and asks it for statements on pg-boss's own
    // timer: it stops before the owner it borrows closes (madarch-8bdc.12), or the timer throws into the process.
    const queue = this.fillQueue;
    this.fillQueue = undefined;
    if (queue !== undefined) await queue.stop().catch(() => undefined);
    await held.owner.close().catch(() => undefined);
  }

  /**
   * The repositories the graph holds, and the commit each is as-is at: the graph's own answer, never a pin table of the
   * fill's. The fill's operational counts are not product data; what a page states of a repository is read from the
   * repository entity and its as-is edge (madarch-hsqs stage A).
   */
  private async loadPins(owner: DatabaseOwner): Promise<void> {
    const reader = new GraphReader(owner, this.validAt);
    const held = await reader.repositoryFactsAll().catch((error: unknown) => {
      // A store that cannot answer is said, never read as "this product has no repository".
      this.options.errorLog?.(`the knowledge wiki could not read the repositories of ${this.options.productFolder}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    const next: RepositoryPin[] = [];
    for (const facts of held) {
      const commit = facts.asIsCommit ?? '';
      const at = commit === '' ? undefined : await reader.commit(facts.name, commit).catch(() => null);
      // The history pass's own opinion of the repository: a shallow clone is not the whole history.
      const shallow = facts.historyShallow === true;
      next.push({
        name: facts.name, url: facts.url, scope: facts.nodeId, head: commit, commit,
        effectiveTime: at?.commitDate ?? new Date().toISOString(),
        commits: facts.counts.commits,
        filledCommits: shallow ? 0 : facts.counts.commits,
      });
    }
    this.replacePins(next);
  }

  private replacePins(pins:readonly RepositoryPin[]):void {
    this.pins.clear();
    for(const pin of pins) this.pins.set(pin.name,pin);
  }

  /**
   * A fill announced a publication (madarch-8bdc.9): the store is read again — its pins, and the numbers the next answer
   * states — and the generation the numbers are cached under moves, so the answer after the notice carries what the run
   * published. The reads of a request already under way stand: each of them is a transaction of its own.
   */
  private published(pins: readonly RepositoryPin[] | undefined): Promise<void> {
    const work = this.swapping.then(async () => {
      if (this.closed) return;
      const owner = await this.open();
      this.generation += 1;
      this.reader = { owner, seq: this.generation };
      this.storeOf = undefined;
      // The new generation's numbers are read here, beside the answers in flight, so the first page asked after the
      // publish is not the one that pays for them.
      const seq = this.generation;
      void this.repositoryView().then((repository) => {
        if (this.reader?.seq === seq && this.storeOf === undefined) this.storeOf = { key: '', seq, ...(repository === undefined ? {} : { repository }) };
      }).catch(() => undefined);
      // What the repositories were filled to is read with the graph: a source is read at the commit the graph it is
      // shown beside was filled from.
      if (pins === undefined) await this.loadPins(owner);
      else this.replacePins(pins);
    });
    this.swapping = work.catch(() => undefined);
    return work;
  }

  /** The valid time reads are made at: now, or the last commit read when a repository's dates stand after the clock. */
  private validAt = (): string => {
    const now = (this.options.now?.() ?? new Date()).toISOString();
    const latest = [...this.pins.values()].map((pin) => pin.effectiveTime).sort(byCodePoint).pop();
    return latest !== undefined && latest > now ? latest : now;
  };

  /**
   * What the wiki's change stream (`/api/events`) is told: a revision that moves
   * after each commit the fill reads and with each change of the fill's state, and
   * a notice for the stream to ask at once.
   */
  readonly changes: { revision(): string; subscribe(listener: () => void): () => void } = {
    revision: () => (this.revision === 0 ? '' : String(this.revision)),
    subscribe: (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };

  private notify(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // a listener that fails is its own stream's problem
      }
    }
  }

  fillState(): FillState {
    return this.fill;
  }

  /** The names and checkouts of the repositories the manifest declares. */
  repositories(): { name: string; path: string; present: boolean }[] {
    const product = this.product();
    if ('message' in product) return [];
    return product.repos.map((repo) => {
      const path = join(product.folder, 'repos', repo.name);
      return { name: repo.name, path, present: existsSync(join(path, '.git')) || existsSync(join(path, 'HEAD')) };
    });
  }

  // ---- pausing and stopping a run (madarch-m38l.17) --------------------------------------

  /**
   * A person's «Пауза»: the page being written and the commit being read are finished, and the run ends before the next
   * one. Pausing a run that is already paused changes nothing, so the press is safe to repeat. The pause is kept beside
   * the store, so a server that starts again shows the same paused run.
   */
  async pauseRun(): Promise<{ ok: true; fill: FillState; writer: WriterState } | { ok: false; status: 409; message: string }> {
    if (this.fill.state === 'paused' || this.writer.state === 'paused') return { ok: true, fill: this.fill, writer: this.writer };
    // A run that is being stopped is on its way out: it stands at no page boundary to be taken up from.
    if (this.stopAsked) return { ok: false, status: 409, message: 'this run is being stopped: there is nothing to pause' };
    if (this.running === undefined) return { ok: false, status: 409, message: 'no fill of this product is running: there is nothing to pause' };
    const paused = await this.controlRun('pause');
    if (paused === undefined || !paused.ok) return { ok: false, status: 409, message: paused?.message ?? 'no fill of this product is running: there is nothing to pause' };
    this.fill = { ...this.fill, state: 'paused' };
    this.notify();
    return { ok: true, fill: this.fill, writer: this.writer };
  }

  /**
   * A person's «Остановить»: the run ends now. Without `confirm` the press is refused, and the refusal counts the pages
   * this run already rewrote and says that they stay. A paused run ends at once, since no worker is writing for it; a
   * running one is told to stop and is killed if it does not end within the grace a closing store is given.
   */
  async stopRun(options: { confirm?: boolean } = {}): Promise<{ ok: true; fill: FillState; writer: WriterState } | { ok: false; status: 409; message: string }> {
    const paused = this.fill.state === 'paused' || this.writer.state === 'paused';
    if (!paused && this.running === undefined) return { ok: false, status: 409, message: 'no fill of this product is running: there is nothing to stop' };
    const written = this.writer.units.filter((unit) => unit.state === 'written').length;
    if (options.confirm !== true) {
      return {
        ok: false,
        status: 409,
        message: `stopping ends the run now: ${written} page${written === 1 ? '' : 's'} ${written === 1 ? 'has' : 'have'} already been rewritten by this run and ${written === 1 ? 'stays as it is' : 'stay as they are'}; the page being written now stays as it was before the run`,
      };
    }
    const at = (this.options.now?.() ?? new Date()).toISOString();
    if (paused) {
      // No worker is writing for a paused run: the run ends here, and the pages it rewrote stand. The stop is marked
      // before the state changes, so a pause message still in the pipe is read as the stop it was ended by.
      this.stopAsked = true;
      this.fill = { ...this.fill, state: 'stopped', ...(this.fill.finishedAt === undefined ? { finishedAt: at } : {}) };
      this.writer = { ...this.writer, state: 'stopped', current: undefined, ...(this.writer.finishedAt === undefined ? { finishedAt: at } : {}) };
      this.pausedRun = undefined;
      this.clearPause();
      this.notify();
      return { ok: true, fill: this.fill, writer: this.writer };
    }
    this.stopAsked = true;
    this.pausedRun = undefined;
    const stopped = await this.controlRun('stop');
    if (stopped === undefined || !stopped.ok) return { ok: false, status: 409, message: stopped?.message ?? 'no fill of this product is running: there is nothing to stop' };
    this.notify();
    return { ok: true, fill: this.fill, writer: this.writer };
  }

  /**
   * A person's pause or stop, taken by the run's own state machine: in this process when the fill runs here (`madarch
   * fill`), and through the store's control row when another process runs it (`--role fill`, madarch-8bdc.9).
   */
  private async controlRun(action: 'pause' | 'stop'): Promise<{ readonly ok: boolean; readonly message?: string }> {
    const held = await this.fillRun?.control(action);
    if (held !== undefined) return held;
    if (this.fillRunId === undefined) return { ok: false, message: 'no fill of this product is running: there is nothing to do' };
    try {
      const owner = await this.open();
      await askRunControl(owner, { runId: this.fillRunId, action, at: Date.now() });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `the run ${this.fillRunId} could not be told to ${action}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** The declared repositories whose checkout holds no commit yet: what a fill says it could not read. */
  private unreadOf(): { repository: string; path: string; reason: string }[] {
    return this.repositories()
      .filter((repo) => repo.present)
      .filter((repo) => headCommitOf(repo.path) === undefined)
      .map((repo) => ({ repository: repo.name, path: repo.path, reason: 'the checkout holds no commit yet' }));
  }

  /** The file a paused run is kept in, beside the store whose pages it was writing. */
  private pauseFile(): string {
    return join(this.storeFolder(), 'pause.json');
  }



  /** Takes the pause off the store: the run it described was taken up or ended. A failure is logged. */
  private clearPause(): void {
    try {
      rmSync(this.pauseFile(), { force: true });
    } catch (error) {
      this.options.errorLog?.(`the knowledge wiki could not take the pause off ${this.storeFolder()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Reads the pause a previous server left beside the store: the run stands at the page it stopped before, with the pages
   * this run already wrote, so «Продолжить» takes up the next page and not the page that stands. Read once, and only
   * while neither the fill nor the writer has a run of its own; a pause file that cannot be read is no pause.
   */
  private restorePause(): void {
    if (this.pauseRestored) return;
    this.pauseRestored = true;
    if (this.fill.state !== 'idle' || this.writer.state !== 'idle' || this.running !== undefined) return;
    let kept: { fill?: unknown; writer?: unknown; run?: unknown };
    try {
      kept = JSON.parse(readFileSync(this.pauseFile(), 'utf8')) as { fill?: unknown; writer?: unknown; run?: unknown };
    } catch {
      return;
    }
    const fill = kept.fill as FillState | undefined;
    const writer = kept.writer as WriterState | undefined;
    if (fill?.state !== 'paused' && writer?.state !== 'paused') return;
    if (writer === undefined || !Array.isArray(writer.units)) return;
    if (fill?.state === 'paused') this.fill = fill;
    this.writer = writer;
    const run = kept.run as PausedRun | undefined;
    if (run !== undefined && typeof run.language === 'string' && typeof run.languageChanged === 'boolean' && typeof run.languageFrom === 'string' && Array.isArray(run.completedPages)) {
      this.pausedRun = run;
    }
  }

  // ---- the fill --------------------------------------------------------------------------

  /** Starts the fill if none is running; the answer says whether it started and why not. */
  async startFill(options: { expectAgent?: string | null; language?: string; task?: string; taskPages?: readonly string[]; targets?: { readonly kinds: readonly string[]; readonly vertex?: string } } = {}): Promise<{ started: true; fill: FillState } | { started: false; message: string; fill: FillState }> {
    if (this.running !== undefined) {
      const busy = this.fill.state === 'running' || this.writer.state === 'running' || this.writer.state === 'waiting';
      if (busy) return { started: false, message: 'a fill of this product is already running', fill: this.fill };
      // The fill and the agent stage are over; the worker is closing its store and ending. A press now waits for that.
      await Promise.race([this.running, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
      if (this.running !== undefined) return { started: false, message: 'the previous fill of this product is still closing its store; press again in a moment', fill: this.fill };
    }
    const product = this.product();
    if ('message' in product) return { started: false, message: product.message, fill: this.fill };
    // Starting a fill is a write path: its own reading of the product is the working tree the files producer is about to
    // read, never the graph it is about to write (madarch-hsqs stage C).
    const read = readKinds(product.folder);
    if (!read.present) return { started: false, message: `the product has no ${read.file}: the wiki shows the kinds that file declares`, fill: this.fill };
    const repositories = this.repositories();
    // A product with no code repository still has its own repository: the files producer reads it, so a product that is
    // documentation alone fills its documents and its own tree. A folder that is no Git checkout has nothing to read.
    if (repositories.length === 0 && headCommitOf(product.folder) === undefined) {
      return { started: false, message: 'the product declares no code repository and its own folder is no Git checkout: connect one with "madarch repo add <name> <url>", then start the fill', fill: this.fill };
    }
    const missing = repositories.filter((repo) => !repo.present);
    if (missing.length > 0) {
      return { started: false, message: `the repositories ${missing.map((repo) => repo.name).join(', ')} are not checked out under repos/: run "madarch bootstrap" first`, fill: this.fill };
    }
    if (this.closed) return { started: false, message: 'the wiki is shutting down', fill: this.fill };
    if (this.resetting) return { started: false, message: 'this product is being started over: press again when it is done', fill: this.fill };
    // The press consented to one agent: a choice saved meanwhile from another tab is not the one this press was for.
    if (options.expectAgent !== undefined) {
      const saved = this.chosenAgent()?.id ?? null;
      if (saved !== options.expectAgent) {
        return { started: false, message: `the agent saved for this product is ${saved === null ? 'none' : saved}, not ${options.expectAgent === null ? 'none' : options.expectAgent} which this press was made for: read the choice again and press once more`, fill: this.fill };
      }
    }
    // The content language: the manifest's, changed by this press when it names another (the pages are then written again).
    // A paused run is taken up as it was: its language and the pages it already published are the pause's, not a fresh
    // reading of `pages-language.json`, which still names the language before the run (madarch-m38l.17).
    const current = read.manifest.language ?? 'en';
    const paused = this.pausedRun;
    const resuming = paused !== undefined && options.task === undefined && (options.language === undefined || options.language === paused.language);
    const wanted = resuming ? paused.language : options.language ?? current;
    if (!Object.keys(CONTENT_LANGUAGES).includes(wanted)) {
      return { started: false, message: `"language" is ${JSON.stringify(wanted)}: the pages are written in ${Object.keys(CONTENT_LANGUAGES).join(' or ')}`, fill: this.fill };
    }
    // The pages are in the language they were last written whole in: a run that failed half way leaves the old one on
    // record, so the next press writes them again. Pages from before the record are judged by what this press asks.
    if (!resuming && options.language !== undefined && options.language !== read.manifest.language) {
      const set = setKindsLanguage(product.folder, options.language);
      if (set !== undefined) return { started: false, message: set, fill: this.fill };
      this.notify();
    }
    // The per-page editorial bound is a product setting (madarch-ztyq.9, review 199): read and validated before
    // the fill claims its slot, and carried to the worker so the writer enforces the same number the page shows.
    try {
    } catch (error) {
      return { started: false, message: error instanceof Error ? error.message : String(error), fill: this.fill };
    }
    this.stopAsked = false;
    // A resumed run takes the pause off the store: what stands there now is the run that starts, not the one it ended.
    this.clearPause();
    const asked = resuming ? paused : undefined;
    // A run limited to a task keeps the task it was pressed for; a resumed task carries the one it paused on.
    const task = asked?.task ?? options.task;
    const startedAt = (this.options.now?.() ?? new Date()).toISOString();
    // A run under way is marked before it starts: a server that restarts during it must not restore the list of the run
    // before. The old list is removed as the same act, so a failed or interrupted run leaves it unknown, not stale.
    let folder: string;
    try {
      folder = this.storeFolder();
    } catch (error) {
      return { started: false, message: `the run could not find the store it belongs to, so it did not start: ${error instanceof Error ? error.message : String(error)}`, fill: this.fill };
    }
    try {
      mkdirSync(folder, { recursive: true });
      writeFileSync(this.activeFillFile(), `${JSON.stringify({ startedAt })}\n`, 'utf8');
      rmSync(join(folder, CHANGED_PAGES_FILE), { force: true });
    } catch (error) {
      try { rmSync(this.activeFillFile(), { force: true }); } catch { /* the launched run has not begun; its mark is only a file */ }
      return { started: false, message: `the run of ${folder} could not be marked as active, so it did not start: ${error instanceof Error ? error.message : String(error)}`, fill: this.fill };
    }
    this.changedPages = undefined;
    this.changedLoaded = true;
    // The repository the run reads, as the product declares it: the card says what it is reading
    // before the run's own trace has a unit to count.
    this.fill = { state: 'running', startedAt, commit: 0, commits: 0, gaps: 0, ...(repositories[0] === undefined ? {} : { repository: repositories[0].name }) };
    this.fillExtras = {};
    const chosen = this.chosenAgent();
    const seeded = resuming && this.writer.units.length > 0 ? this.writer : undefined;
    const agent = seeded?.agent ?? chosen;
    // A writer waits for the agent stage's units, and only a stage with tools writes a page: a fill
    // whose steps hold none of them starts no writer, so a person is not told "the agent is writing"
    // for a run that could never write (madarch-8bdc.2.5; the chosen agent is kept for that step).
    const writes = agent !== null && fillWritesPages();
    this.writer = seeded === undefined
      ? { state: writes ? 'waiting' : 'idle', agent, units: [] }
      : { ...seeded, state: writes ? 'waiting' : 'idle', current: undefined };
    this.pausedRun = undefined;
    // The store opens before the press answers (madarch-8bdc.2.5): a page asked while the fill starts is answered from a
    // store that stands, never pays its own open on a page's thread (measured: the first answers after a press waited
    // 1.9 s for it on two cores, one of them busy).
    await this.open().catch(() => undefined);
    this.notify();
    const press = { ...(wanted === undefined ? {} : { language: wanted }), ...(task === undefined ? {} : { task }), ...(options.targets === undefined ? {} : { targets: options.targets }) };
    // The run's id names its trace, which the answer's progress is read from: it is the press's own moment, as every
    // reader of a run's trace finds it.
    const runId = `fill-${startedAt.replace(/[-:.]/gu, '').replace(/Z$/u, 'Z')}`;
    this.running = (this.options.fillQueued === true ? this.runQueuedFill(product, runId, press) : this.runInlineFill(product, runId, press)).finally(() => {
      // The mark goes only when the run is over, after its result is recorded: a restart before this point has no list.
      this.clearActiveFill();
      this.running = undefined;
      this.fillRun = undefined;
    });
    return { started: true, fill: this.fill };
  }

  /**
   * Fills the store in this process (madarch-8bdc.9): what `madarch fill`, a test that drives this class alone and every
   * caller that is not the api role does. The server's products ask a fill process instead (`runQueuedFill`).
   */
  private async runInlineFill(product: ProductIdentity, runId: string, asked: { readonly language?: string; readonly task?: string; readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string } } = {}): Promise<void> {
    const storeFolder = this.storeFolder();
    this.fillRunId = runId;
    let result: KnowledgeFillResult | undefined;
    try {
      const owner = await createDatabaseOwner({ store: storeDatabasePath(storeFolder), btreeGist: true });
      const run = await startKnowledgeFill({
        productFolder: product.folder,
        storeFolder,
        runId,
        database: owner,
        ...(asked.targets === undefined ? {} : { targets: asked.targets }),
        onPublish: () => { void this.published(undefined).catch(() => undefined); },
      });
      try {
        result = await run.done;
      } finally {
        await run.close().catch(() => undefined);
      }
    } catch (error) {
      this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message: error instanceof Error ? error.message : String(error), code: 'store' };
      this.notify();
      return;
    }
    if (result === undefined || !result.ok) {
      this.fill = {
        state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(),
        ...(result?.message === undefined ? {} : { message: result.message }), code: 'fill',
      };
      this.notify();
      return;
    }
    await this.published(undefined).catch(() => undefined);
    this.changedLoaded = false;
    if (this.writer.state === 'waiting' && this.writer.units.length === 0) this.writer = { ...this.writer, state: 'idle' };
    this.fill = {
      state: 'done', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), gaps: 0,
      changed: this.lastChangedPages() ?? [],
      ...(result.unread === undefined || result.unread.length === 0 ? {} : { unread: [...result.unread] }),
    };
    this.notify();
    this.lastUse = Date.now();
    void this.graphVerdicts({ force: true }).catch((error: unknown) => {
      this.options.errorLog?.(`the knowledge wiki could not validate the graph after the fill: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Asks for the fill through the store's own queue and follows it where its own state is written (madarch-8bdc.9): the
   * api role never fills in the process that answers pages — a fill process of the same binary claims the job, reads git
   * and publishes into the store, and the pages read what it published. The two talk only through PostgreSQL.
   */
  private async runQueuedFill(product: ProductIdentity, runId: string, asked: { readonly language?: string; readonly task?: string; readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string } }): Promise<void> {
    void product;
    const storeFolder = this.storeFolder();
    this.fillRunId = runId;
    let state: string | undefined;
    let end: Awaited<ReturnType<typeof readFillEnd>> = null;
    try {
      const owner = await this.open();
      // One queue per product, opened with its store and closed with it: starting and stopping the queue's own scheduler
      // around every press cost more than the fill it asked for.
      this.fillQueue ??= await openFillRunQueue(owner);
      await askFillRun(this.fillQueue, { product: product.folder, store: storeFolder, runId, ...(asked.language === undefined ? {} : { language: asked.language }), ...(asked.task === undefined ? {} : { task: asked.task }), ...(asked.targets === undefined ? {} : { targets: asked.targets }) });
      // The run's end is the row the process that ran it writes once the store is finished (madarch-8bdc.9): its
      // terminal run row alone is not the store's publication, because the pins a page reads land after it. What the run
      // answered — the reason it did not finish, the repositories it could not read — is written there too.
      for (;;) {
        if (this.closed) return;
        end = await readFillEnd(owner, runId).catch(() => null);
        if (end !== null) {
          state = end.state;
          break;
        }
        await Bun.sleep(250);
      }
    } catch (error) {
      this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message: error instanceof Error ? error.message : String(error), code: 'store' };
      this.notify();
      return;
    }
    if (state !== 'succeeded') {
      this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message: end?.message ?? `the fill ended ${state ?? 'without a run'}`, code: 'fill' };
      this.notify();
      return;
    }
    // The run's end read its pins into the store: the answers after it state what it published.
    await this.published(undefined).catch((error: unknown) => {
      this.options.errorLog?.(`the knowledge wiki could not read the store ${storeFolder} after the run: ${error instanceof Error ? error.message : String(error)}`);
    });
    // A run that ended says which pages it changed: this fill writes no page, so the answer is the empty list unless the
    // store kept a record of pages the run changed — never an absent field a reader would take for "unknown".
    this.changedLoaded = false;
    if (this.writer.state === 'waiting' && this.writer.units.length === 0) this.writer = { ...this.writer, state: 'idle' };
    // The repositories the run could not read are the checkouts with no commit: the answer names them from the files,
    // where the process that pressed the fill and the one that ran it agree without a second record.
    const unread: { repository: string; path: string; reason: string }[] = end?.unread === undefined ? this.unreadOf() : [...end.unread];
    this.fill = {
      state: 'done', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), gaps: 0,
      changed: this.lastChangedPages() ?? [],
      ...(unread.length === 0 ? {} : { unread }),
    };
    this.notify();
    this.lastUse = Date.now();
    // The rules and the judge read the store as soon as the fill ends (madarch-mwhd.1 finding 6): a reader who opens the
    // settings page afterwards sees what was decided, not a page that has to start the work itself.
    void this.graphVerdicts({ force: true }).catch((error: unknown) => {
      this.options.errorLog?.(`the knowledge wiki could not validate the graph after the fill: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // ---- what a run changed -------------------------------------------------------------------

  /** The file marking a run between its start and the end of its run job. */
  private activeFillFile(): string {
    return join(this.storeFolder(), ACTIVE_FILL_FILE);
  }


  /**
   * A run that was under way when the server stopped cannot be restored: its result was never written, and the list
   * beside the store belongs to the run before. The mark is what tells the two apart; this removes both the stale list
   * and the mark, at the launch of the product.
   */
  private invalidateInterruptedRun(): void {
    let folder: string;
    try {
      const product = this.product();
      if ('message' in product) return;
      folder = this.storeFolder();
    } catch {
      return; // a product that cannot be read has no store and no list to restore
    }
    try {
      if (!invalidateInterruptedRun(folder)) return;
      this.changedPages = undefined;
      this.changedLoaded = true;
    } catch (error) {
      this.options.errorLog?.(`the knowledge wiki could not invalidate the changed pages of the interrupted fill of ${folder}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The mark is removed once the run is over, whether it completed or failed. */
  private clearActiveFill(): void {
    try {
      rmSync(this.activeFillFile(), { force: true });
    } catch (error) {
      this.options.errorLog?.(`the knowledge wiki could not clear the mark of the fill of ${this.storeFolder()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }




  /** The pages the last fill changed, as kept beside the store; absent when none was recorded or it is not that run's. */
  private lastChangedPages(): ChangedPage[] | undefined {
    if (this.changedLoaded) return this.changedPages;
    this.changedLoaded = true;
    this.changedPages = readChangedPages(this.storeFolder(), this.lastFill());
    return this.changedPages;
  }

  // ---- the agent stage ---------------------------------------------------------------------

  /**
   * What the agent did to write one page: the records of the newest run that wrote it, or of the run asked for. A page no
   * run of this machine wrote has an empty journal, which the reader is told in words, rather than a refusal: the journal
   * is the store's, and which pages it holds is answered by its own files (madarch-m38l.23).
   */
  journalOf(pageId: string, run?: string): PageJournal {
    const unit = this.journalUnitOf(pageId);
    if (unit === undefined) return { run: null, runs: [], records: [], totals: NO_COUNTERS, problems: [] };
    return journalOfUnit(journalFolder(this.storeFolder()), unit, run);
  }

  /** The unit whose journal holds the page: the page's own id, or the localized source of a document's page. */
  private journalUnitOf(pageId: string): string | undefined {
    const index = this.journalIndex();
    return [pageId, `${LOCALIZED_SOURCE_UNIT}${pageId}`].find((candidate) => index.has(candidate));
  }

  /** The runs whose journal holds the page, oldest first; absent when no run of this machine wrote it. */
  private pageJournal(pageId: string, index = this.journalIndex()): string[] | undefined {
    for (const candidate of [pageId, `${LOCALIZED_SOURCE_UNIT}${pageId}`]) {
      const runs = index.get(candidate);
      if (runs !== undefined) return [...runs];
    }
    return undefined;
  }

  /** What each unit of the journal wrote, by the runs that hold it; each run file is read again only when it has changed. */
  private readonly journalFiles = new Map<string, { stamp: string; units: Map<string, string[]> }>();
  private journalIndex(): Map<string, string[]> {
    // A product whose folder names no store (no manifest beside it, as a reader built for one page may be) holds no
    // journal: the page is read all the same and says nothing of a journal, rather than refusing to be read.
    let folder: string;
    try { folder = journalFolder(this.storeFolder()); } catch { return new Map(); }
    let names: string[] = [];
    try { names = readdirSync(folder).filter((name) => name.startsWith('run-') && name.endsWith('.jsonl')).sort(byCodePoint); }
    catch { names = []; }
    const index = new Map<string, string[]>();
    for (const name of names) {
      const file = join(folder, name);
      const run = name.slice(0, -'.jsonl'.length);
      let stamp: string;
      try { const stat = statSync(file); stamp = `${stat.size}:${stat.mtimeMs}`; }
      catch { continue; }
      let entry = this.journalFiles.get(file);
      if (entry === undefined || entry.stamp !== stamp) {
        const units = new Map<string, string[]>();
        for (const record of readJournalFile(file).records) units.set(record.unit, [run]);
        entry = { stamp, units };
        this.journalFiles.set(file, entry);
      }
      for (const unit of entry.units.keys()) {
        const runs = index.get(unit);
        if (runs === undefined) index.set(unit, [run]);
        else runs.push(run);
      }
    }
    for (const runs of index.values()) runs.sort(byCodePoint);
    return index;
  }

  private get env(): DraftEnv {
    return this.options.env ?? process.env;
  }

  private choiceFile(): string {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    return join(this.options.storeRoot, product.id, 'writer.json');
  }

  /** The product's writer settings as stored, before they are read into roles and bounds (madarch-ztyq.9). */
  private settingsRecord(): Record<string, unknown> {
    const file = this.choiceFile();
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`${file}: the product settings cannot be read: ${(error as Error).message}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new Error(`${file}:1: the product settings are not JSON: ${(error as Error).message}; delete the file to choose again`);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(`${file}:1: the product settings are a JSON object with agent, roles and the writer's bounds`);
    }
    return body as Record<string, unknown>;
  }

  /** The most revision requests one page may receive in a pass: the stored setting, or the default when none is set. */
  private editorialRequestsPerPage(): number {
    const file = this.choiceFile();
    const value = this.settingsRecord()['editorialRequestsPerPage'];
    if (value === undefined) return DEFAULT_EDITORIAL_REQUESTS_PER_PAGE;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_EDITORIAL_REQUESTS) {
      throw new Error(`${file}:1: editorialRequestsPerPage is the most revision requests one page may receive, an integer from 0 to ${MAX_EDITORIAL_REQUESTS}; got ${JSON.stringify(value)}`);
    }
    return value;
  }

  /**
   * Saves the per-page editorial bound (madarch-ztyq.9, review 199). It is the product's setting, so it lives
   * beside the roles and survives a role being removed; the next fill carries it to the writer.
   */
  async setEditorialRequestsPerPage(value: number): Promise<{ ok: true; value: number } | { ok: false; status: number; message: string }> {
    const file = this.choiceFile();
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_EDITORIAL_REQUESTS) {
      return { ok: false, status: 400, message: `${file}:1: editorialRequestsPerPage is the most revision requests one page may receive, an integer from 0 to ${MAX_EDITORIAL_REQUESTS}; got ${JSON.stringify(value)}` };
    }
    const body = this.settingsRecord();
    body.editorialRequestsPerPage = value;
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${(this.choiceWrites += 1)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(body)}\n`, 'utf8');
    await rename(temporary, file);
    this.notify();
    return { ok: true, value };
  }

  /**
   * What the choice file holds (madarch-j6ho.2): the writer's pair at the top level, as the earlier releases wrote it,
   * and the other roles under `roles`. A role that is absent is unassigned, never guessed.
   */
  private modelAssignments(): ModelAssignments {
    const file = this.choiceFile();
    const body = this.settingsRecord() as { agent?: unknown; model?: unknown; reasoning?: unknown; roles?: unknown };
    const pair = (value: unknown, where: string): ModelPair => {
      if (typeof value !== 'object' || value === null) throw new Error(`${file}:1: ${where} is not an object with an agent`);
      const held = value as { agent?: unknown; model?: unknown; reasoning?: unknown };
      if (typeof held.agent !== 'string') throw new Error(`${file}:1: ${where} has no agent id`);
      const entry = adapterOf(held.agent);
      if (entry === undefined) throw new Error(`${file}:1: ${where} names ${JSON.stringify(held.agent)}, which is not an agent madarch offers`);
      if (held.model !== undefined && typeof held.model !== 'string') throw new Error(`${file}:1: ${where}.model is not a string`);
      if (held.reasoning !== undefined && typeof held.reasoning !== 'string') throw new Error(`${file}:1: ${where}.reasoning is not a string`);
      return modelPair({ agent: entry.id, ...(typeof held.model === 'string' ? { model: held.model } : {}), ...(typeof held.reasoning === 'string' ? { reasoning: held.reasoning } : {}) });
    };
    if (body.agent !== undefined && typeof body.agent !== 'string') throw new Error(`${file}:1: the writer choice has no agent id`);
    const roles = body.roles;
    if (roles !== undefined && (typeof roles !== 'object' || roles === null || Array.isArray(roles))) throw new Error(`${file}:1: roles is not an object`);
    const heldRoles = (roles ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(heldRoles)) if (!isModelRole(key)) throw new Error(`${file}:1: roles.${key} is not a role madarch knows (${['writing', 'classification', 'analysis', 'editing'].join(', ')})`);
    const writing = typeof body.agent === 'string'
      ? pair(body, 'the writer choice')
      : heldRoles.writing === undefined
        ? null
        : pair(heldRoles.writing, 'roles.writing');
    const other = (role: 'classification' | 'analysis' | 'editing'): ModelPair | null => heldRoles[role] === undefined ? null : pair(heldRoles[role], `roles.${role}`);
    return { writing, classification: other('classification'), analysis: other('analysis'), editing: other('editing') };
  }

  /** The writer's pair, read as the writing role; compatibility for the callers that ask for one agent. */
  private choiceRecord(): ModelPair | null {
    return this.modelAssignments().writing;
  }

  private async writeAssignments(assignments: ModelAssignments): Promise<void> {
    const file = this.choiceFile();
    const any = assignments.writing !== null || assignments.classification !== null || assignments.analysis !== null || assignments.editing !== null;
    // The roles are one part of the product's writer settings: read the stored object and keep every setting this
    // method does not own, so removing the last role never deletes the editorial bound beside it (madarch-ztyq.9).
    const body = this.settingsRecord();
    delete body.agent;
    delete body.model;
    delete body.reasoning;
    delete body.roles;
    if (assignments.writing !== null) {
      body.agent = assignments.writing.agent;
      if (assignments.writing.model !== undefined) body.model = assignments.writing.model;
      if (assignments.writing.reasoning !== undefined) body.reasoning = assignments.writing.reasoning;
    }
    const roles: Record<string, ModelPair> = {};
    if (assignments.classification !== null) roles.classification = assignments.classification;
    if (assignments.analysis !== null) roles.analysis = assignments.analysis;
    if (assignments.editing !== null) roles.editing = assignments.editing;
    if (Object.keys(roles).length > 0) body.roles = roles;
    if (!any && Object.keys(body).length === 0) {
      await rm(file, { force: true });
      return;
    }
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${(this.choiceWrites += 1)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(body)}\n`, 'utf8');
    await rename(temporary, file);
  }

  /** The agent the reader chose for this product, or null; a file that names an agent madarch does not offer is an error naming it. */
  chosenAgent(): { id: string; label: string; model?: string; reasoning?: string } | null {
    const record = this.choiceRecord();
    if (record === null) return null;
    const entry = adapterOf(record.agent)!;
    return { id: entry.id, label: entry.label, ...(record.model === undefined ? {} : { model: record.model }), ...(record.reasoning === undefined ? {} : { reasoning: record.reasoning }) };
  }

  private readonly choices = new Map<string, { at: number; answer: { ok: true; choices: AgentChoices } | { ok: false; message: string } }>();
  private readonly asking = new Map<string, Promise<{ ok: true; choices: AgentChoices } | { ok: false; message: string }>>();

  /** The roles and the pair each resolves to; unassigned roles carry their fallback note. */
  modelRoles(): ModelRoleView {
    return resolveModelRoles(this.modelAssignments());
  }

  /**
   * Every current node and edge with its verdict, reason and the rule or judge
   * that decided it (madarch-mwhd.1). The first run reuses every unchanged
   * cached entry; a run whose snapshot, roles and budgets all match is read
   * from the cache without touching the graph or starting a judge.
   */
  graphVerdicts(options: { force?: boolean } = {}): Promise<GraphVerdictProductView> {
    if (this.verdictRun !== undefined) return this.verdictRun;
    const run = this.graphVerdictsOne(options.force === true).finally(() => { this.verdictRun = undefined; });
    this.verdictRun = run;
    return run;
  }

  private async graphVerdictsOne(force: boolean): Promise<GraphVerdictProductView> {
    const file = graphVerdictFile(this.storeFolder());
    const state = readGraphVerdictState(file);
    const roles = this.modelRoles();
    // The validation owns its connection for the snapshot: the reader's owner may be closed as idle after the fill,
    // while this validation is still starting (the fill role and the api role have different lifetimes).
    const owner = await createDatabaseOwner({ store: storeDatabasePath(this.storeFolder()), btreeGist: true });
    let snapshot: Awaited<ReturnType<typeof loadGraphSnapshot>>;
    try { snapshot = await loadGraphSnapshot(owner); } finally { await owner.close().catch(() => undefined); }
    const jev = this.options.graphJev ?? null;
    const judgeFor = this.options.graphJudgeFor ?? ((pair, role) => acpGraphJudge(pair, role, {
      env: this.env,
      ...(this.options.errorLog === undefined ? {} : { progress: (line: string) => this.options.errorLog?.(`the graph ${role} judge: ${line}`) }),
    }));
    const fingerprint = graphVerdictFingerprint({
      snapshot,
      roles,
      budgets: state.budgets,
      validatorVersion: GRAPH_VERDICT_VALIDATOR_VERSION,
      hasJev: jev !== null,
      hasJudge: true,
      ...(this.options.graphJevVersion === undefined ? {} : { jevVersion: this.options.graphJevVersion }),
    });
    // The whole-result shortcut is only safe when nothing is waiting: a budget deferral or a failed judge is work the
    // next run must take up, even when the snapshot has not changed (madarch-mwhd.1 finding 3).
    if (!force && state.cache !== undefined && state.cache.fingerprint === fingerprint && state.cache.validatorVersion === GRAPH_VERDICT_VALIDATOR_VERSION && !graphVerdictsRunnable(state.cache)) {
      const rows = graphVerdictRows(state.cache);
      return {
        file,
        budgets: state.budgets,
        rows,
        report: graphVerdictReport(rows, state.budgets, GRAPH_VERDICT_VALIDATOR_VERSION, state.cache.generatedAt),
        metrics: { checked: 0, reused: rows.length, judgeItems: 0, modelCalls: 0 },
        cached: true,
      };
    }
    // The evidence reader reads the graph's paths at the commits the fill pinned. Paths are repository-relative; the
    // first present repository holding the path answers, and a path no pinned repository holds stays unresolved.
    const read = new Map<string, GraphEvidenceContent | undefined>();
    const readEvidence = async (path: string): Promise<GraphEvidenceContent | undefined> => {
      if (read.has(path)) return read.get(path);
      let content: GraphEvidenceContent | undefined;
      const reader = new GraphReader(await this.open(), this.validAt);
      for (const repository of this.repositories()) {
        if (!repository.present) continue;
        const pin = this.pins.get(repository.name);
        if (pin === undefined || pin.commit === '') continue;
        const text = await reader.content(repository.name, path);
        if (text === null) continue;
        content = { text, repository: repository.name, commit: pin.commit };
        break;
      }
      read.set(path, content);
      return content;
    };
    const result = await runGraphVerdicts({
      snapshot,
      roles,
      budgets: state.budgets,
      readEvidence,
      ...(state.cache === undefined ? {} : { previous: state.cache }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(jev === null ? {} : { jev }),
      ...(this.options.graphJevVersion === undefined ? {} : { jevVersion: this.options.graphJevVersion }),
      judgeFor,
    });
    writeGraphVerdictState(file, result.cache);
    return { file, budgets: state.budgets, rows: result.rows, report: result.report, metrics: result.metrics, cached: false };
  }

  /** The budgets and, when they exist, the counts from the last run; reading this starts no judge. */
  graphVerdictSettings(): { file: string; budgets: GraphVerdictBudgets; report?: GraphVerdictReport } {
    const file = graphVerdictFile(this.storeFolder());
    const state = readGraphVerdictState(file);
    if (state.cache === undefined) return { file, budgets: state.budgets };
    const rows = graphVerdictRows(state.cache);
    return { file, budgets: state.budgets, report: graphVerdictReport(rows, state.budgets, state.cache.validatorVersion, state.cache.generatedAt) };
  }

  /** Saves what one run may judge. Both are whole numbers, 0 or more; no verdict is thrown away. */
  setGraphVerdictBudgets(itemsPerRun: number, modelCallsPerRun: number): { ok: true; budgets: GraphVerdictBudgets } | { ok: false; status: number; message: string } {
    if (!Number.isInteger(itemsPerRun) || itemsPerRun < 0) return { ok: false, status: 400, message: `"itemsPerRun" is ${JSON.stringify(itemsPerRun)}: a whole number of items, 0 or more` };
    if (!Number.isInteger(modelCallsPerRun) || modelCallsPerRun < 0) return { ok: false, status: 400, message: `"modelCallsPerRun" is ${JSON.stringify(modelCallsPerRun)}: a whole number of judge calls, 0 or more` };
    if (this.running !== undefined && (this.writer.state === 'running' || this.writer.state === 'waiting')) return { ok: false, status: 409, message: 'a fill with an agent is running; the graph verdict budgets change after it ends' };
    const budgets = { itemsPerRun, modelCallsPerRun };
    writeGraphVerdictBudgets(graphVerdictFile(this.storeFolder()), budgets);
    this.notify();
    return { ok: true, budgets };
  }

  /**
   * The models and reasoning levels one agent reports over ACP (never a list madarch holds), kept for five minutes.
   * `fresh` asks again. The writing role's caller uses `agentChoices`; a role assignment asks its own agent.
   */
  private async agentChoicesFor(id: string, fresh = false): Promise<{ ok: true; agent: { id: string; label: string }; choices: AgentChoices } | { ok: false; message: string }> {
    const entry = adapterOf(id);
    if (entry === undefined) return { ok: false, message: `src/knowledge/product.ts: ${JSON.stringify(id)} is not an agent madarch offers` };
    const kept = this.choices.get(id);
    let answer = kept !== undefined && !fresh && Date.now() - kept.at < 5 * 60_000 ? kept.answer : undefined;
    if (answer === undefined) {
      // One question at a time per agent: asks that arrive meanwhile share its answer, so a page opened twice starts one process.
      let asking = this.asking.get(id);
      if (asking === undefined) {
        asking = (this.options.choicesQuery ?? queryAgentChoices)(id, this.env).finally(() => this.asking.delete(id));
        this.asking.set(id, asking);
      }
      answer = await asking;
      if (answer.ok) this.choices.set(id, { at: Date.now(), answer });
    }
    return answer.ok ? { ok: true, agent: { id: entry.id, label: entry.label }, choices: answer.choices } : { ok: false, message: answer.message };
  }

  async agentChoices(fresh = false): Promise<{ ok: true; agent: { id: string; label: string }; choices: AgentChoices } | { ok: false; message: string }> {
    const chosen = this.chosenAgent();
    if (chosen === null) return { ok: false, message: 'no agent is chosen for this product: choose one to see the models it offers' };
    return await this.agentChoicesFor(chosen.id, fresh);
  }

  /** The models one named agent reports, for assigning a role to that agent (madarch-j6ho.2). */
  async agentChoicesForRole(id: string, fresh = false): Promise<{ ok: true; agent: { id: string; label: string }; choices: AgentChoices } | { ok: false; message: string }> {
    return await this.agentChoicesFor(id, fresh);
  }

  /**
   * Saves the model and reasoning level the reader chose, beside the agent. A value the agent does not report is refused:
   * the agent's own list is asked now and is the only one there is. `null` returns to the agent's own.
   */
  async chooseModel(model: string | null | undefined, reasoning: string | null | undefined): Promise<{ ok: true; chosen: { id: string; label: string; model?: string; reasoning?: string } } | { ok: false; status: number; message: string }> {
    const turn = this.choosing.then(() => this.chooseModelOne(model, reasoning), () => this.chooseModelOne(model, reasoning));
    this.choosing = turn;
    return turn;
  }

  private async chooseModelOne(model: string | null | undefined, reasoning: string | null | undefined): Promise<{ ok: true; chosen: { id: string; label: string; model?: string; reasoning?: string } } | { ok: false; status: number; message: string }> {
    if (this.running !== undefined && (this.writer.state === 'running' || this.writer.state === 'waiting')) return { ok: false, status: 409, message: 'a fill with an agent is running; the choice changes after it ends' };
    const record = this.choiceRecord();
    if (record === null) return { ok: false, status: 409, message: 'no agent is chosen for this product: choose one first' };
    let next: ModelPair = modelPair(record);
    const asked = model !== undefined && model !== null || reasoning !== undefined && reasoning !== null;
    const offered = asked ? await this.agentChoices(true) : undefined;
    if (offered !== undefined && !offered.ok) return { ok: false, status: 502, message: offered.message };
    // The query took time: a fill may have started meanwhile, and its agent must not meet a choice written under it.
    if (this.running !== undefined && (this.writer.state === 'running' || this.writer.state === 'waiting')) return { ok: false, status: 409, message: 'a fill with an agent started while the agent was asked; the choice changes after it ends' };
    for (const [field, value, choice] of [['model', model, offered?.ok ? offered.choices.model : null], ['reasoning', reasoning, offered?.ok ? offered.choices.reasoning : null]] as const) {
      if (value === undefined) continue;
      if (value === null) { const { [field]: _gone, ...rest } = next; next = rest as typeof next; continue; }
      if (choice === null || choice === undefined) return { ok: false, status: 409, message: `the agent reports no ${field === 'model' ? 'model' : 'reasoning level'} to choose` };
      if (!choice.values.some((entry) => entry.value === value)) return { ok: false, status: 400, message: `"${field}" is ${JSON.stringify(value)}, which the agent does not report; it reports ${choice.values.map((entry) => entry.value).join(', ')}` };
      next = { ...next, [field]: value };
    }
    await this.writeAssignments({ ...this.modelAssignments(), writing: next });
    this.notify();
    return { ok: true, chosen: this.chosenAgent()! };
  }

  agentOffers(): AgentOffer[] {
    return offers(this.env);
  }

  /**
   * The reader's choice of the agent that writes the pages. `install` is the reader's yes to fetching the agent's
   * adapter when it is not here; without it an agent that is not installed is refused, in words. Nothing runs.
   */
  chooseAgent(id: string | null, install: boolean): Promise<{ ok: true; agent: { id: string; label: string } | null } | { ok: false; status: number; message: string }> {
    // One change of the choice at a time: two asks never write the one file together.
    const turn = this.choosing.then(() => this.chooseOne(id, install), () => this.chooseOne(id, install));
    this.choosing = turn;
    return turn;
  }

  private async chooseOne(id: string | null, install: boolean): Promise<{ ok: true; agent: { id: string; label: string } | null } | { ok: false; status: number; message: string }> {
    if (this.running !== undefined && (this.writer.state === 'running' || this.writer.state === 'waiting')) return { ok: false, status: 409, message: 'a fill with an agent is running; the choice changes after it ends' };
    if (id === null) {
      await this.writeAssignments({ ...this.modelAssignments(), writing: null });
      this.notify();
      return { ok: true, agent: null };
    }
    const entry = adapterOf(id);
    if (entry === undefined) return { ok: false, status: 400, message: `"agent" is ${JSON.stringify(id)}: madarch offers claude-code and codex` };
    const offer = this.agentOffers().find((candidate) => candidate.id === id)!;
    if (!offer.installed) {
      if (!install) return { ok: false, status: 409, message: `the ${entry.label} adapter is not installed: say yes to install it into ${offer.install?.kind === 'npm' ? offer.install.folder : 'madarch\'s agents folder'}` };
      if (this.installing !== undefined) return { ok: false, status: 409, message: 'an adapter is being installed; wait for it to end' };
      const work = installAdapter(id, this.env);
      this.installing = work;
      let result: Awaited<typeof work>;
      try {
        result = await work;
      } finally {
        this.installing = undefined;
      }
      if (!result.ok) return { ok: false, status: 502, message: result.message };
    }
    // The model and the reasoning level belong to the agent they were chosen for: the same agent keeps them, another starts clean.
    const before = this.choiceRecord();
    const writing = modelPair(before !== null && before.agent === id ? before : { agent: id });
    await this.writeAssignments({ ...this.modelAssignments(), writing });
    this.notify();
    return { ok: true, agent: { id: entry.id, label: entry.label } };
  }

  /**
   * Assigns one role to an (agent, model) pair, or removes the assignment with `null` (madarch-j6ho.2). The role is
   * asked for by name; the pair is stored under it, never chosen by a feature. An agent that is not installed is
   * refused unless the reader said yes to fetching its adapter. A model the agent does not report is refused.
   */
  chooseRole(role: string, id: string | null, model?: string | null, reasoning?: string | null, install = false): Promise<{ ok: true; role: ModelRole; pair: ModelPair | null } | { ok: false; status: number; message: string }> {
    const turn = this.choosing.then(() => this.chooseRoleOne(role, id, model, reasoning, install), () => this.chooseRoleOne(role, id, model, reasoning, install));
    this.choosing = turn;
    return turn;
  }

  private async chooseRoleOne(role: string, id: string | null, model: string | null | undefined, reasoning: string | null | undefined, install: boolean): Promise<{ ok: true; role: ModelRole; pair: ModelPair | null } | { ok: false; status: number; message: string }> {
    if (!isModelRole(role)) return { ok: false, status: 400, message: `"role" is ${JSON.stringify(role)}: the roles are writing, classification and analysis` };
    if (this.running !== undefined && (this.writer.state === 'running' || this.writer.state === 'waiting')) return { ok: false, status: 409, message: 'a fill with an agent is running; the role changes after it ends' };
    if (id === null) {
      await this.writeAssignments({ ...this.modelAssignments(), [role]: null });
      this.notify();
      return { ok: true, role, pair: null };
    }
    const entry = adapterOf(id);
    if (entry === undefined) return { ok: false, status: 400, message: `"agent" is ${JSON.stringify(id)}: madarch offers claude-code, codex, opencode and omp` };
    const offer = this.agentOffers().find((candidate) => candidate.id === id)!;
    if (!offer.installed) {
      if (!install) return { ok: false, status: 409, message: `the ${entry.label} adapter is not installed: say yes to install it into ${offer.install?.kind === 'npm' ? offer.install.folder : 'madarch\'s agents folder'}` };
      if (this.installing !== undefined) return { ok: false, status: 409, message: 'an adapter is being installed; wait for it to end' };
      const work = installAdapter(id, this.env);
      this.installing = work;
      let result: Awaited<typeof work>;
      try { result = await work; } finally { this.installing = undefined; }
      if (!result.ok) return { ok: false, status: 502, message: result.message };
    }
    const assignments = this.modelAssignments();
    const previous = assignments[role];
    let next = modelPair(previous !== null && previous.agent === id ? previous : { agent: id });
    const asked = model !== undefined && model !== null || reasoning !== undefined && reasoning !== null;
    const offered = asked ? await this.agentChoicesFor(id, true) : undefined;
    if (offered !== undefined && !offered.ok) return { ok: false, status: 502, message: offered.message };
    for (const [field, value, choice] of [['model', model, offered?.ok ? offered.choices.model : null], ['reasoning', reasoning, offered?.ok ? offered.choices.reasoning : null]] as const) {
      if (value === undefined) continue;
      if (value === null) { const { [field]: _gone, ...rest } = next; next = rest as typeof next; continue; }
      if (choice === null || choice === undefined) return { ok: false, status: 409, message: `the agent reports no ${field === 'model' ? 'model' : 'reasoning level'} to choose` };
      if (!choice.values.some((candidate) => candidate.value === value)) return { ok: false, status: 400, message: `"${field}" is ${JSON.stringify(value)}, which the agent does not report; it reports ${choice.values.map((candidate) => candidate.value).join(', ')}` };
      next = { ...next, [field]: value };
    }
    await this.writeAssignments({ ...assignments, [role]: next });
    this.notify();
    return { ok: true, role, pair: next };
  }

  writerState(): WriterState {
    return this.writer;
  }

  /** What a reset would remove and keep, for the confirmation; nothing is changed. */
  resetPlan(): ResetPlan {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    try {
      return planReset(product.folder, this.storeFolder(), this.options.storeRoot);
    } catch (error) {
      if (error instanceof WikiReadError) throw error;
      throw new WikiReadError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Starts the product's knowledge over: the reader and the graph store go, and the pages the writer produced (see
   * `reset.ts`). Refused while a fill runs. The wiki then reads as an empty product.
   */
  async reset(expected?: ResetPlan): Promise<{ ok: true; plan: ResetPlan } | { ok: false; message: string }> {
    if (this.running !== undefined) return { ok: false, message: 'a fill of this product is running; start over after it ends' };
    if (this.resetting) return { ok: false, message: 'this product is already being started over' };
    const product = this.product();
    if ('message' in product) return { ok: false, message: product.message };
    let plan: ResetPlan;
    try {
      plan = planReset(product.folder, this.storeFolder(), this.options.storeRoot);
      if (expected !== undefined && (['store', 'agentPages', 'keptPages', 'unansweredQuestions', 'keptAnswers'] as const).some((key) => JSON.stringify(expected[key]) !== JSON.stringify(plan[key]))) return { ok: false, message: `${product.folder}:1: reset inputs changed since the preview; request a new preview: nothing was removed` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    this.resetting = true;
    try {
      await this.swapping.catch(() => undefined);
      await this.opening?.catch(() => undefined);
      const held = this.fillQueue;
      this.fillQueue = undefined;
      if (held !== undefined) await held.stop().catch(() => undefined);
      if (this.reader !== undefined) await this.reader.owner.close().catch(() => undefined);
      this.reader = undefined;
      this.opening = undefined;
      this.pins.clear();
      this.fill = { state: 'idle' };
      this.writer = { state: 'idle', agent: null, units: [] };
      applyReset(product.folder, plan);
      this.notify();
      return { ok: true, plan };
    } finally {
      this.resetting = false;
    }
  }

  /**
   * What the two local resets of the settings page would do, for the confirmation: the pages the agent wrote, the pages
   * kept because a person wrote them, the graph store and the questions left unanswered. The resets touch no file the
   * product's own repository holds: the engine holds no copy of the starter set to put back (madarch-64o5.3).
   */
  dangerPlan(): { rewrite: { agentPages: string[]; keptPages: string[] }; fresh: ResetPlan } {
    const plan = this.resetPlan();
    return { rewrite: { agentPages: plan.agentPages, keptPages: plan.keptPages }, fresh: plan };
  }

  /**
   * «Rewrite the pages»: removes the pages the agent wrote and keeps the graph, then runs a fill so the agent writes them
   * again. Nothing a person wrote is touched. Refused while a fill runs and when no agent is chosen (nothing could write them).
   */
  async rewritePages(): Promise<{ ok: true; plan: ResetPlan; fill: FillState } | { ok: false; message: string }> {
    if (this.running !== undefined) return { ok: false, message: 'a fill of this product is running; rewrite the pages after it ends' };
    if (this.resetting) return { ok: false, message: 'this product is being started over' };
    const product = this.product();
    if ('message' in product) return { ok: false, message: product.message };
    const chosen = this.chosenAgent();
    if (chosen === null) return { ok: false, message: 'no agent is chosen for this product, so nothing could write the pages again: choose an agent first, nothing was removed' };
    let plan: ResetPlan;
    try {
      plan = planReset(product.folder, this.storeFolder(), this.options.storeRoot);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    this.resetting = true;
    try {
      applyReset(product.folder, plan, { keepQuestions: true, keepStore: true });
      this.writer = { state: 'idle', agent: null, units: [] };
      this.notify();
    } finally {
      this.resetting = false;
    }
    const started = await this.startFill({ expectAgent: chosen.id });
    if (!started.started) return { ok: false, message: `the pages were removed (${plan.agentPages.join(', ') || 'there were none'}) but the fill did not start: ${started.message}` };
    return { ok: true, plan: { ...plan, store: [], unansweredQuestions: [] }, fill: started.fill };
  }

  /**
   * «Start from scratch»: the pages the agent wrote, the graph and the reader go, and a fresh fill starts. The product's
   * own files — its manifest and templates — stay as the repository holds them: the engine keeps no copy of them.
   */
  async startFresh(expected?: ResetPlan): Promise<{ ok: true; plan: ResetPlan; fill: FillState; fillRefused?: string } | { ok: false; message: string }> {
    const done = await this.reset(expected);
    if (!done.ok) return done;
    const chosen = this.chosenAgent();
    const started = await this.startFill(chosen === null ? {} : { expectAgent: chosen.id });
    return started.started ? { ok: true, plan: done.plan, fill: started.fill } : { ok: true, plan: done.plan, fill: this.fill, fillRefused: started.message };
  }

  /**
   * What the product settings page shows: the agent and the model chosen for it, the page language, the writer's bounds,
   * where the product's files and its derived store are on this machine, and what the two local resets would do.
   */
  async settingsView(): Promise<{
    product: { name: string; id: string };
    folder: string;
    store: string;
    language: string;
    chosenAgent: { id: string; label: string; model?: string; reasoning?: string } | null;
    /** Every role, its resolved pair and a visible note when it falls back (madarch-j6ho.2). */
    roles: ModelRoleView;
    /** The name every agent madarch offers is known by, so a page names an agent before it has read the agents (madarch-j6ho.2). */
    agentNames: Record<string, string>;
    bounds: WriterBounds;
    danger: ReturnType<KnowledgeProduct['dangerPlan']>;
    /** Why the two resets cannot say what they would do (a `docs` folder that is a link out of the product, say); both are then refused. */
    dangerError?: string;
    busy: boolean;
  }> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const read = await this.manifestRead(product.folder);
    let danger: ReturnType<KnowledgeProduct['dangerPlan']>;
    let dangerError: string | undefined;
    try {
      danger = this.dangerPlan();
    } catch (error) {
      dangerError = error instanceof Error ? error.message : String(error);
      danger = { rewrite: { agentPages: [], keptPages: [] }, fresh: { store: [], agentPages: [], keptPages: [], unansweredQuestions: [], keptAnswers: [] } };
    }
    return {
      product: { name: product.name, id: product.id },
      folder: product.folder,
      store: this.storeFolder(),
      language: read.present ? read.manifest.language ?? 'en' : 'en',
      chosenAgent: this.chosenAgent(),
      roles: this.modelRoles(),
      agentNames: Object.fromEntries(WRITER_AGENTS.map((id) => [id, adapterOf(id)?.label ?? id])),
      bounds: { ...WRITER_BOUNDS, editorialRequestsPerPage: this.editorialRequestsPerPage() },
      danger,
      ...(dangerError === undefined ? {} : { dangerError }),
      busy: this.running !== undefined,
    };
  }

  /** Saves the language the pages are written in (the manifest's `language:`); the next refresh writes the pages again in it. */
  async setLanguage(language: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const product = this.product();
    if ('message' in product) return { ok: false, message: product.message };
    if (!Object.keys(CONTENT_LANGUAGES).includes(language)) return { ok: false, message: `"language" is ${JSON.stringify(language)}: the pages are written in ${Object.keys(CONTENT_LANGUAGES).join(' or ')}` };
    // Pages written before the language of the pages was recorded are in the language the manifest names now: say so before
    // it changes, or the next refresh compares the new language with itself and rewrites nothing.
    const read = await this.manifestRead(product.folder);
    const current = read.present ? read.manifest.language ?? 'en' : 'en';
    if (current !== language && this.pagesLanguage() === undefined && existsSync(join(product.folder, PRODUCT_PATH))) {
      const file = join(this.storeFolder(), 'pages-language.json');
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify({ language: current })}\n`, 'utf8');
      } catch (error) {
        return { ok: false, message: `${file}: the language the pages are in now could not be recorded, so the language was not changed: ${(error as Error).message}` };
      }
    }
    const failure = setKindsLanguage(product.folder, language);
    if (failure !== undefined) return { ok: false, message: failure };
    this.notify();
    return { ok: true };
  }

  /** Resolves when the running fill has ended; for tests and for a clean stop. */
  async settled(): Promise<void> {
    await this.running;
  }

  // ---- reads -----------------------------------------------------------------------------

  /** The inputs of one page: the manifest and Markdown as the graph holds them at this revision, and the graph. */
  async context(history?: HistoryContext, snapshot?: PageSnapshot, after?: string): Promise<{ ctx: RenderContext; manifest: KindsManifest; findings: Finding[] } | { absent: true; file: string }> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    // A fill another process ran moves the store before this answer reads the graph: without this, an api instance that
    // did not press the fill kept the manifest it had cached before it (the two api instances of madarch-8bdc.9).
    await this.followStoreFill();
    // The manifest, the Markdown and the templates are the product repository's files as the files producer stored them:
    // read once per graph revision (madarch-hsqs stage C), and never from the checkout.
    const files = await this.productFiles(snapshot);
    const read = await this.manifestFrom(product.folder, snapshot);
    if (!read.present) return { absent: true, file: read.file };
    const owner = snapshot?.owner ?? await this.open();
    const kinds = graphKindsOf(read.manifest);
    const currentGraph = new GraphReader(owner, snapshot === undefined ? this.validAt : () => snapshot.validAt, undefined, snapshot?.transaction, kinds.declared, kinds.generated, kinds.edges);
    const scope = history === undefined ? undefined : (snapshot?.pins ?? this.pins).get(history.repo)?.scope ?? undefined;
    const indexOwner = snapshot === undefined ? owner : pageSnapshotOwner(owner, snapshot.transaction);
    const pins = snapshot?.pins ?? this.pins;
    if (history !== undefined && (history.coverage !== 'covered' || history.effectiveAt === null || scope === undefined)) throw new WikiReadError(`${product.folder}/${KINDS_FILE}:1: historical structure is not covered for ${history.repo} at ${history.at}`);
    const graph = history === undefined ? currentGraph : currentGraph.at(history.effectiveAt!, scope!);
    // Guide payloads enter their strict host verifier, never the generic YAML materializer.
    const ordinaryKinds = new Map([...read.manifest.kinds].filter(([kind]) => !Object.hasOwn(GUIDE_OUTPUTS, kind)));
    const markdownKinds = { ...read.manifest, kinds: ordinaryKinds };
    // The files the Markdown kinds stand in, and every template a kind names, are fetched in one statement each: the
    // parse below is synchronous, and a file this read forgot is refused by name, never answered absent.
    if (history === undefined) {
      const paths: string[] = [];
      for (const kind of ordinaryKinds.values()) {
        if (kind.source !== 'markdown') continue;
        if (kind.file !== undefined) paths.push(kind.file);
        else if (kind.folder !== undefined) paths.push(...files.filesBelow(kind.folder).filter((path) => path.endsWith('.md')));
      }
      for (const kind of read.manifest.kinds.values()) paths.push(kind.template);
      await files.ensure(paths);
      await files.ensureBelow('templates');
    }
    const markdownRead = history === undefined ? readMarkdownEntitiesFrom(files, markdownKinds) : { entities: [], findings: [] };
    if (history === undefined) for (const [kind, output] of Object.entries(GUIDE_OUTPUTS)) {
      const declaration = read.manifest.kinds.get(kind);
      if (declaration?.source !== 'markdown' || declaration.file === undefined) continue;
      if (!files.has(declaration.file)) continue;
      const title = declaration.labels?.[read.manifest.language === 'ru' ? 'ru' : 'en']?.one ?? kind;
      markdownRead.entities.push({ id: output.id, kind, title, relates: [], producer: 'agent', sources: [], body: '', bodyLine: 1, file: declaration.file, source: '', front: {} });
    }
    const markdown = new Map<string, MarkdownEntity>(markdownRead.entities.map((entity) => [entity.id, entity]));
    const language = read.manifest.language ?? 'en';
    const repoOfScope = (scope: string): string | undefined => [...pins.values()].find((pin) => pin.scope !== null && pin.scope === scope)?.name;
    // The source filesystem is the files producer's alone (decision 0035, item 24): a reader of a file's text reads the
    // content the producer stored in the graph, once per blob, and the product repository is the repository named after
    // the product. A file no fill read is absent, never a second read from the checkout.
    const productRepository = productRepositoryId(product);
    const readSource = async (repo: string | null, path: string): Promise<string | undefined> => {
      if (history === undefined) {
        const content = await graph.content(repo ?? productRepository, path);
        return content === null ? undefined : content;
      }
      // A page at a past commit reads the text that commit held: the graph's history says whether the path's blob is
      // still that version, and an absent answer is never today's text under the commit's name.
      if (repo === null || repo !== history.repo || history.commit === null) return undefined;
      const at = await graph.contentAt(repo, path, history.commit);
      return 'absent' in at ? undefined : at.text;
    };
    const webOf = (repo: string | null, path: string, lineStart: number, lineEnd: number): { host: string; url: string } | undefined => {
      if (repo === null) return undefined;
      if (history !== undefined && repo !== history.repo) return undefined;
      const pin = pins.get(repo);
      if (pin === undefined || pin.url === '' || pin.commit === '') return undefined;
      return webLink({ origin: pin.url, commit: history?.commit ?? pin.commit, path, lineStart, lineEnd });
    };
    // A declared checkout that holds no commit is named with its path: the wiki says what it leaves unread rather than
    // failing, and the fill says the same of it. This reads a ref, never a document.
    const emptyRepositories: Finding[] = [];
    if (history === undefined) for (const repo of this.repositories().filter((candidate) => candidate.present)) {
      const commit = pins.get(repo.name)?.commit;
      if ((commit === undefined || commit === '') && headCommitOf(repo.path) === undefined) emptyRepositories.push({ file: repo.path, line: 1, message: `the repository ${JSON.stringify(repo.name)} holds no commit yet: nothing is read from it until it does`, source: repo.path });
    }
    const resolver = new Resolver({
      graph,
      markdown,
      declared: (kind) => read.manifest.kinds.has(kind),
      readDocument: readSource,
      repositories: () => history === undefined ? [...pins.keys()].sort(byCodePoint) : [history.repo],
      locate: (entity) => (entity.span === undefined ? undefined : locationOf({ repoOfScope, webOf }, entity.scope, entity.span)),
    });
    return {
      ctx: { productFolder: product.folder, files, productName: product.name, manifest: read.manifest, graph, markdown, language, ...((this.fill.run ?? this.fillExtras.run) === undefined ? {} : { fillRun: { finishedAt: (this.fill.run ?? this.fillExtras.run)!.finishedAt, wallMs: (this.fill.run ?? this.fillExtras.run)!.wallMs } }), ...(this.fill.unread === undefined ? {} : { unreadRepositories: this.fill.unread }), repositories: history === undefined ? [...pins.keys()].sort(byCodePoint) : [history.repo], ownRepository: productRepositoryId(product), webOf, historyEvidence: (scope) => graph.historyEvidence(scope), ...(after === undefined || after === '' ? {} : { pageAfter: after }), ...(history === undefined ? { index: { relyingOn: (key: string) => statementsRelyingOn(indexOwner, key), counts: () => indexCounts(indexOwner) } } : {}), commitOf: (repo) => history === undefined ? pins.get(repo)?.commit ?? null : repo === history.repo ? history.commit : null, problemCount: () => this.problemsCache?.listing.open, resolver, repoOfScope, readSource },
      manifest: read.manifest,
      findings: [...read.manifest.findings, ...markdownRead.findings, ...emptyRepositories],
    };
  }

  /** The planned-change marks, read once per graph revision: a fill that stores the tasks again makes them read again. */
  private marksMemo: { key: string; marks: PlannedMarks } | undefined;

  /**
   * What the planned-change marks depend on: the graph revision, the writer's plan and this process's own revision, all of
   * them counts rather than files — a read of a page never stamps the checkout (madarch-hsqs stage C).
   */
  private async marksKey(): Promise<string> {
    const plan = this.writer.plan === undefined ? '' : this.writer.plan.unplaced.map((entry) => `${entry.kind}:${entry.slug}`).join(',');
    return `${await this.graphRevision()}|${String(this.revision)}|${plan}`;
  }

  /** The graph revision the answers stand on: the store's publication stamp, or '' before the store is open. */
  private async graphRevision(): Promise<string> {
    const owner = this.reader?.owner;
    if (owner === undefined) return '';
    try {
      return await readStoreStamp(owner);
    } catch {
      return '';
    }
  }

  /** The language the writer last wrote the pages in whole, as kept beside the store; absent when none was recorded. */
  private pagesLanguage(): string | undefined {
    try {
      const language = (JSON.parse(readFileSync(join(this.storeFolder(), 'pages-language.json'), 'utf8')) as { language?: unknown }).language;
      return typeof language === 'string' ? language : undefined;
    } catch {
      return undefined;
    }
  }

  /** The run last recorded as finished, with the start that tells it from an earlier one; absent when none was recorded. */
  private lastFill(): { startedAt: string | null; finishedAt: string } | undefined {
    try {
      const kept = JSON.parse(readFileSync(join(this.storeFolder(), 'last-fill.json'), 'utf8')) as { startedAt?: unknown; finishedAt?: unknown };
      if (typeof kept.finishedAt !== 'string') return undefined;
      if (kept.startedAt !== undefined && kept.startedAt !== null && typeof kept.startedAt !== 'string') return undefined;
      return { startedAt: typeof kept.startedAt === 'string' ? kept.startedAt : null, finishedAt: kept.finishedAt };
    } catch {
      return undefined;
    }
  }

  /** The writer's units as a reader knows them, each saying whether a journal holds its page (madarch-m38l.23). */
  private unitRows(ctx: RenderContext): WriterUnit[] {
    const index = this.journalIndex();
    return namedUnits(ctx, this.writer.units).map((unit) => ({ ...unit, journal: this.pageJournal(unit.page ?? unit.unit, index) !== undefined }));
  }

  /**
   * What the menu asks on every poll (madarch-u3vw.1, the second review). The answer is a pure read of the manifest,
   * the Markdown and document sources, the graph snapshot and the loop's files, and those are read once per
   * `statusKey()`, not once per answer: the fill and the writer, which move without touching a file, are taken live
   * from this process. `statusKey()` is the same key the Problems page keeps its listing under, with the tasks folder
   * and the store's last finish added — the two files the answer reads that the listing does not.
   */
  async status(): Promise<WikiStatus> {
    // A folder that is no product is answered with the file it lacks, and nothing is written into it to stamp a key.
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    let key = '';
    try {
      key = await this.statusKey();
    } catch {
      // A product whose inputs cannot be stamped is answered afresh: a key that cannot be computed caches nothing.
      key = '';
    }
    if (key === '') {
      const made = await this.statusNow();
      return await this.statusLive(made.body, made.ctx);
    }
    const held = this.statusMemo;
    if (held !== undefined && held.key === key) return await this.statusLive(held.body, held.ctx);
    // Eight polls of one reader, or three readers polling together, wait for one read of the same files.
    const flight = this.statusFlight;
    if (flight !== undefined && flight.key === key) {
      const made = await flight.promise;
      return await this.statusLive(made.body, made.ctx);
    }
    const promise = this.statusNow();
    this.statusFlight = { key, promise };
    try {
      const made = await promise;
      this.statusMemo = { key, body: made.body, ctx: made.ctx };
      return await this.statusLive(made.body, made.ctx);
    } finally {
      if (this.statusFlight?.promise === promise) this.statusFlight = undefined;
    }
  }

  /**
   * The entity catalogue's own answer (madarch-8bdc.2.5): every kind the manifest declares, with its plane in the
   * catalog, its words in each interface language, the entities that stand of it and what produces it today. It is a
   * request of its own, not part of the status the navigation polls: the catalogue is the product's full map, and the
   * status keeps the kinds the wiki shows. Its counts are read over the store's newest snapshot, as the status's are.
   */
  /**
   * The wiki's search (madarch-o0d): the Markdown pages and the graph's entities whose title or text holds the words,
   * grouped by kind, read from the same store the pages are read from. An empty query answers nothing.
   */
  async search(query: string, lang?: string): Promise<SearchView> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const common = { product: { name: product.name, id: product.id }, query: query.trim() };
    const context = await this.context();
    if ('absent' in context) return { ...common, language: 'en', groups: [], total: 0 };
    const found = await searchWiki(context.ctx, common.query, lang);
    return { ...common, language: context.manifest.language ?? 'en', ...found };
  }

  async catalog(): Promise<CatalogView> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const common = { product: { name: product.name, id: product.id } };
    const context = await this.context();
    if ('absent' in context) return { ...common, language: 'en', groups: [], kinds: [], findings: [] };
    const owner = await this.open();
    const kinds = graphKindsOf(context.manifest);
    const generated = kinds.generated;
    const dependencies = await owner.run(async (tx) => await readPublishedDependencies(tx));
    const declarations = new Map([...context.manifest.kinds].map(([name, kind]) => [name, {
      ...kind, dependsOn: dependencies.filter((edge) => edge.workflow === undefined && edge.to === name).map((edge) => edge.from).sort(byCodePoint),
    }]));
    const ctx = { ...context.ctx, manifest: { ...context.manifest, kinds: declarations }, graph: new GraphReader(owner, this.validAt, undefined, undefined, kinds.declared, kinds.generated, kinds.edges) };
    // The state of each kind's newest turn: what the catalogue says is filled, partial, or never filled (madarch-stm0.6).
    const turns = await this.fillUnitStates();
    return {
      ...common,
      language: context.manifest.language ?? 'en',
      groups: groupViews(context.manifest),
      kinds: await catalogKinds(ctx, {
        turnOf: (kind) => turns.get(kind),
        // A kind whose table stands is measured by the graph; one with no table has no measured volume (madarch-stm0.6).
        generatedOf: (kind) => generated !== undefined && generated.has(kind),
      }),
      findings: context.manifest.catalog === undefined ? [] : [...context.manifest.catalog.findings],
    };
  }

  /**
   * The state of each kind's plugin turn, by kind, as the store holds it: the newest generation of the unit
   * `plugin-turns/<plugin>:<kind>`. A vertex fill's unit (`<plugin>:<kind>@<entity id>`) is not the kind's turn and is
   * left out, and a store with no fill tables answers no turn at all.
   */
  private async fillUnitStates(): Promise<Map<string, string>> {
    const states = new Map<string, string>();
    let owner;
    try {
      owner = await this.open();
    } catch {
      return states;
    }
    let units: Map<string, string>;
    try {
      units = await readUnitStates(owner);
    } catch {
      // A store a fill never wrote has no unit tables yet: every kind is judged by what the graph holds alone.
      return states;
    }
    for (const [unitId, state] of units) {
      const slash = unitId.indexOf('/');
      if (slash < 0 || unitId.slice(0, slash) !== PLUGIN_TURN_STAGE_ID) continue;
      const rest = unitId.slice(slash + 1);
      if (rest.includes('@')) continue;
      const colon = rest.indexOf(':');
      if (colon < 0) continue;
      states.set(rest.slice(colon + 1), state);
    }
    return states;
  }

  /** The catalogue's fill selection as the store keeps it (madarch-stm0.6): checked kinds, the agent and the cap. */
  async fillSelection(): Promise<FillSelectionView> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    return await readFillSelection(await this.open(), product.id);
  }

  /** Writes the selection the catalogue page made; the checked kinds are the given ones, in code point order. */
  async saveFillSelection(selection: { readonly selected: readonly string[]; readonly agent: string | null; readonly tokenCap: number | null }): Promise<FillSelectionView> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    return await writeFillSelection(await this.open(), product.id, selection);
  }

  /**
   * What moves without a file: the fill, the writer and the agent, taken from this process on every answer. The units
   * are named against the context of the cached read, so a unit that starts while the files stay unchanged keeps the
   * reader-facing kind, title and page the read's Markdown gave it (madarch-m38l.23). The Problems count
   * is the one collected for exactly these inputs, else absent: an answer never keeps a count collected for inputs the
   * cache has replaced — while a fill holds the collection back, the answer is pending (madarch-u3vw.8).
   */
  private async statusLive(body: WikiStatus, ctx: RenderContext | undefined): Promise<WikiStatus> {
    try {
      return await this.statusLiveNow(body, ctx);
    } catch {
      // The store could not be read for this answer: the fill state is this process's own and is answered regardless.
      return { ...body, fill: this.statusFill(), chosenAgent: this.chosenAgent() };
    }
  }

  /**
   * The store's own fill state (madarch-8bdc.9): a fill another process runs is answered here as running, and its end is
   * answered as done — two api instances of one server agree about the same fill, and neither has to have pressed it.
   */
  private async followStoreFill(): Promise<void> {
    if (this.reader === undefined) return;
    // A publication of a fill this process did not run moves the numbers an answer states (madarch-8bdc.9): the store's
    // stamp is read before the answer, and a moved stamp reads its pins and its numbers again.
    try {
      const stamp = await readStoreStamp(this.reader.owner);
      if (this.storeStamp !== stamp) {
        this.storeStamp = stamp;
        this.generation += 1;
        this.reader = { owner: this.reader.owner, seq: this.generation };
        this.storeOf = undefined;
        await this.loadPins(this.reader.owner).catch(() => undefined);
        // The graph a fill just published has a manifest and templates the worker has not opened yet: warm them beside
        // the answer, never inside it — a status during a fill answers within its own bound (madarch-64o5.3).
        void this.warmReader().catch(() => undefined);
      }
    } catch {
      // The store cannot be read: the answer is what this process last knew.
    }
    let live: Awaited<ReturnType<typeof readLiveRun>>;
    try {
      live = await readLiveRun(this.reader.owner);
    } catch {
      return;
    }
    if (live !== null) {
      if (this.fill.state === 'idle') {
        this.fillRunId = live.runId;
        this.fill = { state: 'running', startedAt: new Date(live.createdAt).toISOString(), commit: 0, commits: 0, gaps: 0 };
      }
      return;
    }
    if (this.fill.state === 'running' && this.fillRunId !== undefined) {
      // The end of the run is the row the process that ran it writes after the store is finished (madarch-8bdc.9): the
      // run row's terminal state alone is not the store's publication, because the pins a page reads land after it. A run
      // the process has not ended here yet keeps this answer `running`.
      const end = await readFillEnd(this.reader.owner, this.fillRunId).catch(() => null);
      if (end === null) return;
      await this.published(undefined).catch(() => undefined);
      // The answer that reads the settled run warms the worker and the repository aggregates: the page a person opens
      // next does not pay the template set's first open (madarch-64o5.3).
      await this.warmReader().catch(() => undefined);
      this.changedLoaded = false;
      const unread = end.unread === undefined ? this.unreadOf() : [...end.unread];
      const finishedAt = (this.options.now?.() ?? new Date()).toISOString();
      this.fill = end.state === 'succeeded'
        ? {
          state: 'done', startedAt: this.fill.startedAt, finishedAt, gaps: 0,
          changed: this.lastChangedPages() ?? [], ...(unread.length === 0 ? {} : { unread }),
        }
        : { state: 'failed', startedAt: this.fill.startedAt, finishedAt, message: end.message ?? `the fill ended ${end.state}`, code: 'fill' };
      this.notify();
    }
  }

  private async statusLiveNow(body: WikiStatus, ctx: RenderContext | undefined): Promise<WikiStatus> {
    await this.followStoreFill();
    const problems = await this.problemsKeySafe();
    const collected = this.problemsCache;
    let loop = body.loop;
    if (problems === '' || collected === undefined || collected.key !== problems) {
      // No listing for these inputs yet: the count is pending (the collection runs beside the answer, and the next poll
      // carries it), and a reader shows the corrections it counts from their files.
      await this.openProblems();
      const { problemsOpen: _pending, ...rest } = loop;
      loop = rest;
    } else {
      loop = { ...loop, problemsOpen: collected.listing.open };
    }
    // A snapshot the fill published moves the store's numbers, not the files the body was made from: they are read for
    // every answer, in the reader's process, over the snapshot the pages show.
    const numbers = ctx === undefined ? undefined : await this.numbersOf(ctx, problems);
    // The count the front shows is the Problems page's own total while its listing stands for these inputs; a listing
    // still being collected leaves the reading's finding count, never a count of other inputs (madarch-8bdc.2.5).
    const findingCount = problems !== '' && collected !== undefined && collected.key === problems
      ? collected.listing.open + collected.listing.closed
      : body.findingCount;
    return { ...body, ...(numbers ?? {}), findingCount, loop, fill: this.statusFill(), writer: ctx === undefined ? this.writer : { ...this.writer, units: this.unitsOf(ctx) }, chosenAgent: this.chosenAgent() };
  }

  /**
   * What a status answer states of the store: the kinds' counts, the repository the pages show and what the pins hold.
   * The context's own read of the manifest and the product's documents is not made again — only the two fields that read
   * the store are bound to the reader this answer uses, so a snapshot the fill published is stated at once.
   */
  /**
   * The writer's units for an answer: a store read that fails (a fill holds a lock, a connection went) leaves the units as
   * they were last answered, because a status answer is read for how the fill is and must not fail on its store.
   */
  private unitsOf(ctx: RenderContext): WriterUnit[] {
    try {
      return this.unitRows(ctx);
    } catch {
      return this.statusMemo?.body.writer.units ?? [];
    }
  }

  /**
   * What the store states of one generation (madarch-8bdc.2.5): the kind counts and the repository the pages show are read
   * once per snapshot and reused by every answer until the next one. A fill publishes a snapshot rarely, and a poll asks
   * several times a second: reading them on every answer put five or six round trips of one read worker behind each page,
   * and under a loaded runner (CI run 42505805264: 266-338 ms across unrelated endpoints at the first publication) the
   * answers of that moment queued behind them.
   */
  private storeOf: { key: string; seq: number; repository?: RepositoryFactsView; kinds?: KindSummary[] } | undefined;

  private async numbersOf(ctx: RenderContext, key: string): Promise<Partial<WikiStatus>> {
    let bound = ctx;
    try {
      const owner = await this.open();
      const kinds = graphKindsOf(ctx.manifest);
      bound = { ...ctx, graph: new GraphReader(owner, this.validAt, undefined, undefined, kinds.declared, kinds.generated, kinds.edges) };

    } catch {
      // The store cannot be opened: the counts stand as the body read them and the answer still says how the fill is.
    }
    // A store read of a status answer is a read of a store a fill may be finishing in: a failure is tried once more, a
    // moment later, and only then stands as unanswered.
    const once = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await read();
      } catch {
        await Bun.sleep(150);
        return await read().catch(() => undefined);
      }
    };
    const seq = this.reader?.seq;
    const held = this.storeOf;
    // A generation's numbers stand while the files stand: a page written beside the product moves them (`status-work`).
    const same = held !== undefined && held.seq === seq && held.key === key;
    const kinds = same && held.kinds !== undefined ? held.kinds : await once(async () => await kindSummaries(bound));
    const repository = same && 'repository' in held ? held.repository : await once(async () => await this.repositoryView());
    if (seq !== undefined) this.storeOf = { key, seq, ...(repository === undefined ? {} : { repository }), ...(kinds === undefined ? {} : { kinds }) };
    const run = await withSpan('knowledge.status.run', { 'run.id': this.fillRunId ?? '' }, async () => this.runViewOf());
    this.fillExtras = {
      ...(repository === undefined ? {} : { counts: repository.counts }),
      ...(run === null ? {} : { run }),
      ...(this.fill.state === 'failed' && this.fill.message !== undefined ? { error: this.errorOf(this.fill.message) } : {}),
    };
    return {
      ...(kinds === undefined ? {} : { kinds }),
      ...(repository === undefined ? {} : { repository }),
      repositories: this.repositories().map((repo) => ({ name: repo.name, filled: (this.pins.get(repo.name)?.filledCommits ?? 0) > 0 })),
      // Manifest publication does not fill repository content.
      filled: this.pins.size > 0,
      incomplete: [...this.pins.values()].some((pin) => pin.filledCommits < pin.commits || pin.commits === 0),
    };
  }

  private statusMemo: { key: string; body: WikiStatus; ctx: RenderContext | undefined } | undefined;
  private statusFlight: { key: string; promise: Promise<StatusRead> } | undefined;

  /**
   * Every file and store state the answer reads besides the fill and the writer, as one key: the Problems listing's
   * own key (the snapshot, the pins, the plan, the manifest, the templates and every file the page reads) and the three the listing
   * leaves out — the task files, whose closures the menu counts, the store's last finish, which the menu shows, and the
   * commit each repository's default branch stands at, which is what a task closure reads (madarch-u3vw.8).
   *
   * A file's own content is the stamp: an edit that keeps its size and restores its mtime is still an edit, and the
   * content hash is kept beside the metadata so an unchanged file is not read again on every poll.
   */
  private async statusKey(): Promise<string> {
    let finished = '-';
    try {
      finished = this.contentStamp(join(this.storeFolder(), 'last-fill.json'));
    } catch {
      // No fill has finished yet, or the store is not open: nothing to stamp.
    }
    // The graph revision is the key of every product file the body reads; the store's own last finish is madarch's
    // operational state, kept beside the store, and its content stamp is what moves the menu when a run ends.
    return `${await this.problemInputsKey()}|finished:${finished}`;
  }

  /**
   * The fill the menu shows: live while it runs, and the store's last finish once it is idle. The pages that finish
   * changed belong to the same record and are read with it (madarch-u3vw.2).
   */
  private statusFill(): WikiStatus['fill'] {
    // A running fill says what its own trace says it has done (madarch-8bdc.2.5, item 2): the
    // counts are read from the run's file as it is written, never kept as a second count here.
    if (this.fill.state === 'running') {
      const progress = this.fillRunId === undefined ? undefined : readFillProgressOf(this.storeFolder(), this.fillRunId);
      return progress === undefined ? this.fill : { ...this.fill, progress };
    }
    const incomplete = [...this.pins.values()].some((pin) => pin.filledCommits < pin.commits || pin.commits === 0);
    const ended: WikiStatus['fill'] = { ...this.fill, ...this.fillExtras };
    if (this.fill.state !== 'idle' || this.pins.size === 0 || incomplete) return ended;
    const last = this.lastFill();
    const changed = this.lastChangedPages();
    return {
      state: 'done',
      ...(last?.finishedAt === undefined ? {} : { finishedAt: last.finishedAt }),
      ...(changed === undefined ? {} : { changed }),
      ...this.fillExtras,
    };
  }

  /** The newest run's trace as the run page states it, or null when the store holds no trace. */
  private runViewMemo: { key: string; view: FillRunView | null } | undefined;

  private runViewOf(runId?: string): FillRunView | null {
    // A server trace is the api role's own request log, not the fill the status states: read the newest fill/update
    // trace unless a caller names a run.
    const candidates = traceFiles(this.storeFolder()).filter((one) => !one.runId.startsWith('server-'));
    const chosenEntry = runId === undefined
      ? candidates.sort((left, right) => {
        const leftSize = (() => { try { return statSync(left.file).size; } catch { return 0; } })();
        const rightSize = (() => { try { return statSync(right.file).size; } catch { return 0; } })();
        return rightSize - leftSize || right.modifiedAt - left.modifiedAt;
      })[0]
      : candidates.find((one) => one.runId === runId);
    const chosen = chosenEntry?.runId;
    // The trace's size is its generation while a fill is still writing: a status answer made from a partial trace is
    // not kept once the trace has grown.
    const traceSize = (() => { try { return chosenEntry === undefined ? 0 : statSync(chosenEntry.file).size; } catch { return 0; } })();
    const key = `${chosen ?? ''}|${this.fillRunId ?? ''}|${traceSize}`;
    if (this.runViewMemo?.key === key) return this.runViewMemo.view;
    if (chosen === undefined) return null;
    try {
      const run = readTraceRun({ store: this.storeFolder(), runId: chosen });
      const view: FillRunView = {
        runId: run.runId,
        startedAt: new Date(run.startedAtMs).toISOString(),
        finishedAt: new Date(run.endedAtMs).toISOString(),
        wallMs: run.report.wallMs,
        spans: run.report.spanCount,
        slowest: run.report.names.slice(0, 5).map((name) => ({ name: name.name, count: name.count, selfMs: name.selfMs })),
        steps: run.steps.map((step) => ({
          step: step.step, wallMs: step.wallMs, peakRssBytes: step.peakRssBytes, startRssBytes: step.startRssBytes,
          slowest: step.slowest,
        })),
      };
      this.runViewMemo = { key, view };
      return view;
    } catch {
      // A store whose fill never ran holds no trace: nothing is made up for it.
      return null;
    }
  }

  /**
   * What a failed run's message names: the file and line the error was raised at, and the path
   * the run was about. The message is the engine's own (`<file>:<line>:<column>: <words>`), so
   * the three are read from it rather than guessed.
   */
  private errorOf(message: string): FillErrorView {
    let at = message.indexOf(':');
    while (at > 0) {
      const line = message.slice(at + 1).split(':');
      if (line.length >= 2 && /^\d+$/u.test(line[0]!) && /^\d+$/u.test(line[1]!)) {
        return { message, file: message.slice(0, at), line: Number(line[0]), path: this.options.productFolder };
      }
      at = message.indexOf(':', at + 1);
    }
    return { message, path: this.options.productFolder };
  }

  /**
   * The repository the graph holds, as a page states it: the one the caller named when the graph holds it, else the
   * product's first declared repository the graph holds, else the first the graph holds. Everything is the graph's
   * answer; there is no second store of repository pages.
   */
  async repositoryView(named: string | null = null): Promise<RepositoryFactsView | undefined> {
    const owner = await this.open();
    let declared: string[] = [];
    try { declared = this.repositories().map((repository) => repository.name); } catch { declared = []; }
    const reader = new GraphReader(owner, this.validAt);
    const held = await reader.repositoryFactsAll().catch(() => []);
    const chosen = (named === null ? undefined : held.find((one) => one.name === named))
      ?? held.find((one) => one.name === declared[0])
      ?? held[0];
    if (chosen === undefined) return undefined;
    return { id: chosen.id, name: chosen.name, url: chosen.url, defaultBranch: chosen.defaultBranch, asIsCommit: chosen.asIsCommit, counts: chosen.counts, historyShallow: chosen.historyShallow, steps: chosen.steps };
  }

  /** The newest run of the store's trace, or the named one. */
  async runView(runId?: string): Promise<FillRunView | null> {
    return this.runViewOf(runId);
  }

  private async statusNow(): Promise<StatusRead> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const declared = this.repositories();
    // A publication of a fill this process did not run is taken before the body is made: the body reads the product's
    // files at the graph revision the store states, and a revision followed only after it would answer the last one.
    await this.followStoreFill();
    // A run a person paused before the server stopped stands as it was: its pages are named from the store it left.
    this.restorePause();
    const common = { product: { name: product.name, id: product.id } };
    const context = await this.context();
    if ('absent' in context) {
      // Three states, never mixed: the file is absent (`no-manifest`), it stands in the repository but no fill has read
      // it into the graph yet (`not-filled`), or the graph holds it (`ok`). The presence is read from the folder and
      // nothing is written: the graph changes only when the person presses Fill.
      const stands = existsSync(context.file);
      return { body: { ...common, manifest: stands ? 'not-filled' : 'no-manifest', manifestFile: context.file, language: 'en', findingCount: 0, kinds: [], groups: [], repositories: declared.map((repo) => ({ name: repo.name, filled: false })), filled: false, incomplete: false, fill: this.fill, writer: this.writer, bounds: { ...WRITER_BOUNDS, editorialRequestsPerPage: this.editorialRequestsPerPage() }, chosenAgent: this.chosenAgent(), home: null, roles: {}, loop: await this.loopCounts() }, ctx: undefined };
    }
    const home = homeKind(context.manifest);
    const homeEntity = home === undefined ? undefined : [...context.ctx.markdown.values()].find((entity) => entity.kind === home.name);
    // The body is the files' reading: the kinds' counts and the repository's numbers are read for every answer
    // (`numbersOf`), because a snapshot moves them without moving a file.
    const loop = await this.loopCounts();
    const incomplete = [...this.pins.values()].some((pin) => pin.filledCommits < pin.commits || pin.commits === 0);
    const body: WikiStatus = {
      ...common,
      manifest: this.pins.size > 0 ? 'ok' : 'not-filled',
      manifestFile: context.manifest.file,
      language: context.manifest.language ?? 'en',
      findingCount: context.findings.length,
      kinds: await kindSummaries(context.ctx),
      groups: [...context.manifest.groups.values()].map((group) => ({ group: group.name, labels: { ...group.labels }, ...(group.short === undefined ? {} : { short: { ...group.short } }), ...(group.parent === undefined ? {} : { parent: group.parent }), ...(group.open === undefined ? {} : { open: group.open }) })),
      repositories: declared.map((repo) => ({ name: repo.name, filled: (this.pins.get(repo.name)?.filledCommits ?? 0) > 0 })),
      filled: this.pins.size > 0,
      incomplete,
      fill: this.statusFill(),
      writer: { ...this.writer, units: this.unitsOf(context.ctx) },
      bounds: { ...WRITER_BOUNDS, editorialRequestsPerPage: this.editorialRequestsPerPage() },
      chosenAgent: this.chosenAgent(),
      home: homeEntity?.id ?? null,
      roles: Object.fromEntries([...context.manifest.roles.values()].map((role) => [role.name, { ...(role.open === undefined ? {} : { open: [...role.open] }), lead: [...role.lead] }])),
      loop,
    };
    return { body, ctx: context.ctx };
  }

  /** A file's content hash, kept beside the metadata that says whether it can have changed since the last poll. */
  private readonly contentStamps = new Map<string, { mtimeMs: number; ctimeMs: number; size: number; ino: number; hash: string }>();

  /**
   * A file's identity by its content. The hash is remembered with the stat fields that change when a file does: an
   * unchanged file costs one stat and no read, while an edit that keeps the size and restores the mtime still changes
   * the ctime and is hashed again (madarch-u3vw.8).
   */
  private contentStamp(path: string): string {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(path);
    } catch {
      return `${path}:absent`;
    }
    if (!stats.isFile()) return `${path}:not-a-file`;
    const held = this.contentStamps.get(path);
    if (held !== undefined && held.mtimeMs === stats.mtimeMs && held.ctimeMs === stats.ctimeMs && held.size === stats.size && held.ino === stats.ino) return `${path}:${held.hash}`;
    let hash: string;
    try {
      hash = String(Bun.hash(readFileSync(path)));
    } catch {
      return `${path}:unreadable:${stats.size}`;
    }
    this.contentStamps.set(path, { mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, size: stats.size, ino: stats.ino, hash });
    return `${path}:${hash}`;
  }

  /**
   * The open problems of the Problems page. Status is polled, so the count is read once per graph revision and the
   * unplaced units; a product whose page cannot be read falls back to the corrections, which are read from the graph.
   */
  private async openProblems(): Promise<{ count: number; key: string } | undefined> {
    const key = await this.problemsKeySafe();
    if (key === '') return undefined;
    const cached = this.problemsCache;
    // The listing already collected for exactly these inputs: no walk.
    if (cached !== undefined && cached.key === key) return { count: cached.listing.open, key };
    // The listing walks the store, and an answer never waits for a walk (madarch-m38l.19): the collection runs beside
    // it and the next poll carries the count. A change of the store's own key — a snapshot the fill published — is what
    // schedules it, and the answer states its count as pending until it lands (madarch-u3vw.8).
    this.refreshProblems(key);
    return undefined;
  }

  /**
   * How many questions wait for an answer or for a refresh, and how many corrections wait for one, as the graph holds
   * them at this revision: the same files the Questions and Tasks pages draw from (madarch-hsqs stage C).
   */
  private async loopCounts(): Promise<WikiStatus['loop']> {
    const files = await this.productFiles();
    const questions = await listQuestions(files);
    const correctionsOpen = (await readCorrectionsIn(files)).items.filter((correction) => correction.status === 'open').length;
    // The menu says what the Tasks page says: the closure of each task, not the status its file still carries.
    const tasksOpen = await openTasks(files, this.taskRepositories(), await this.pageFiles());
    // Until the Problems page can be read, an open correction is the count that is known from the graph alone; the
    // status replaces it with the page's own open count once that page can be built (openProblems).
    return { questionsOpen: questions.open, questionsAnswered: questions.answered, correctionsOpen, tasksOpen, problemsOpen: correctionsOpen };
  }

  /**
   * The facts of one file the store holds, by the page id the kind `code.file` names it with (`code.file:<path>`), or
   * `undefined` when the id names no file of the repository the wiki's repository pages show. The record tables are
   * read on the reader's own snapshot, the way the repository pages read them.
   */
  async historyAt(selection: HistorySelection): Promise<HistoryContext> {
    // The one graph carries no valid time: a dated read is not covered, and the page says so rather than
    // answering the current facts under another date.
    return { ...selection, coverage: 'unknown', commit: null, effectiveAt: null, until: null, points: [] };
  }

  async page(id: string, lang?: string, options: { defer?: boolean; only?: string; after?: string; history?: HistorySelection } = {}): Promise<PageResult> {
    const history = options.history === undefined ? undefined : await this.historyAt(options.history);
    // A gap is a visible result, not an empty current page or a reason to fall back to the tip.
    if (history !== undefined && history.coverage !== 'covered') return { ok: true, page: { id, kind: id.slice(0, id.indexOf(':')), title: id, trail: [], blocks: [], resolutions: {}, findings: [], notes: [], history } };
    const guideKind = (Object.keys(GUIDE_OUTPUTS) as GuideKind[]).find((kind) => GUIDE_OUTPUTS[kind].id === id);
    if (guideKind !== undefined) {
      // Guide authority can open its own transactions. It never enters the page batch.
      const context = await this.context(history, undefined, options.after);
      if ('absent' in context) return { ok: false, status: 404, message: `the product has no ${context.file}: the wiki shows the kinds that file declares` };
      return await this.guidePage(guideKind, lang === 'ru' ? 'ru' : lang === 'en' ? 'en' : context.ctx.language === 'ru' ? 'ru' : 'en', context.ctx, history);
    }
    // These operations can open their own snapshots; finish them before holding the reader pipe.
    const historyNavigation = history === undefined && id.startsWith('code.') ? await Promise.all([...this.pins.keys()].sort(byCodePoint).map(async (repo) => { const indexed = await this.historyAt({ repo, at: '?' }); return { repo, points: indexed.points, ...(indexed.landmarks === undefined ? {} : { landmarks: indexed.landmarks }) }; })) : undefined;
    const planned = history === undefined ? await this.plannedForPage(id) : undefined;
    // The store's open and the page's two halves have spans of their own: a slow page says which of them it is (the
    // trace is the answer to slowness, decision 0033).
    const owner = await withSpan('wiki.store.open', {}, async () => await this.open());
    // A newer snapshot may replace this one while the page is being rendered (a fill swaps readers under open reads).
    // The rendered owner is still a store, so its page keeps its Problems badge.
    const ownerWasReader = this.reader?.owner === owner;
    const validAt = this.validAt();
    const pins = new Map(this.pins);
    const rendered: PageResult = await owner.transaction('snapshot', async (transaction) => {
      const context = await withSpan('wiki.context', {}, async () => await this.context(history, { owner, transaction, validAt, pins }, options.after));
      if ('absent' in context) return { ok: false, status: 404, message: `the product has no ${context.file}: the wiki shows the kinds that file declares` };
      if (history !== undefined && await findSubject(context.ctx, id) === undefined) return { ok: true, page: { id, kind: id.slice(0, id.indexOf(':')), title: id, trail: [], blocks: [], resolutions: {}, findings: [], notes: [], history, historicalAbsent: true } };
      const result: PageResult = await withSpan('wiki.render', {}, async () => await renderPage(context.ctx, id, lang, history === undefined ? options : { ...options, defer: false }));
      if (!result.ok) return result;
      const page = history === undefined ? result.page : withHistoryLinks(result.page, history);
      // Which runs of the journal hold this page, so the page says «Как агент писал эту страницу» only where it can be read.
      const journal = history === undefined ? this.pageJournal(id) : undefined;
      return { ok: true, page: { ...page, ...(history === undefined ? { planned, ...(journal === undefined ? {} : { journal }), ...(historyNavigation === undefined ? {} : { historyNavigation }) } : { history, blocks: page.blocks.filter((block) => block.type !== 'history') }) } };
    });
    // The badge is counted after the page's transaction closes: the Problems listing opens a transaction of its own, and a
    // nested one would wait on the pipe the page holds. A listing that cannot be made is said on the page, never shown as 0.
    if (!rendered.ok || rendered.page.historicalAbsent === true || history !== undefined) return rendered;
    // The caller may hold a renderer whose owner has no store behind it (a snapshot fixture, or a page rendered from an
    // injected transaction). There is no problems database to ask, so the page shows no count and no failure note.
    // An owner that was the reader when the page opened has a store even if a newer snapshot has since replaced it.
    if (!ownerWasReader && this.reader?.owner !== owner) return rendered;
    // The badge reads the listing last collected, never a walk of its own: a page answers while a fill runs
    // (madarch-m38l.19). A listing older than the page's inputs is a count from the previous revision; the next poll of
    // the status collects the current one.
    if (!rendered.ok) return rendered;
    const cached = this.problemsCache;
    if (cached === undefined) {
      // The first reader of a product pays for the one collection; during a fill no page waits for the graph.
      if (this.fill.state === 'running') return rendered;
      try {
        const owner = await this.open();
        const listing = await this.problemsFor(await this.problemsKey(), owner);
        return { ok: true, page: { ...rendered.page, problems: openProblemsOf(listing.problems, id) } };
      } catch (error) {
        return { ok: true, page: { ...rendered.page, notes: [...rendered.page.notes, `the problems of this entity could not be counted: ${(error as Error).message}`] } };
      }
    }
    return { ok: true, page: { ...rendered.page, problems: openProblemsOf(cached.listing.problems, id) } };
  }

  /** Strict guide data and fresh walk evidence are assembled once for every read format. */
  private async guidePage(kind: GuideKind, locale: GuideLocale, ctx: RenderContext, history?: HistoryContext): Promise<PageResult> {
    const declaration = ctx.manifest.kinds.get(kind);
    const output = { id: GUIDE_OUTPUTS[kind].id, path: declaration?.file ?? 'madarch/kinds.yaml' };
    const file = resolve(ctx.productFolder, output.path);
    const title = ctx.manifest.kinds.get(kind)?.labels?.[locale]?.one ?? kind;
    const base: PageModel = { id: output.id, kind, language: locale, title, trail: [], blocks: [], resolutions: {}, findings: [], notes: [], ...(history === undefined ? { planned: await this.plannedForPage(output.id) } : { history }) };
    const message = `${file}:1: $.guide: ${locale === 'ru' ? 'Руководство ещё не в графе: его пишет отдельный шаг, которого пока нет' : 'the guide is not in the graph yet: a later stage writes it'}`;
    return { ok: true, page: { ...base, blocks: [{ type: 'problem', block: 'guide', file, line: 1, message }], findings: [{ file, line: 1, message }] } };
  }

  /** The planned changes one page stands in: its own entity, and the statements of it a task's grounds reach. */
  private async plannedForPage(id: string): Promise<PageModel['planned']> {
    try {
      const marks = await this.marks();
      const entity = markForEntity(marks, id);
      const byStatement = marksForPage(marks, id);
      const statements: (PlannedMarkView & { sentence: string })[] = [];
      if (byStatement.size > 0) {
        for (const statement of (await this.indexPages()).find((candidate) => candidate.id === id)?.statements ?? []) {
          const mark = byStatement.get(statement.id);
          if (mark !== undefined) statements.push({ task: mark.task, how: mark.how, sentence: statement.text });
        }
      }
      return { entity: entity === undefined ? null : { task: entity.task, how: entity.how }, statements };
    } catch (error) {
      // A mark that cannot be read is said on the page: an empty list would read as "nothing is planned".
      return { entity: null, statements: [], note: (error as Error).message };
    }
  }

  /** The planned change one statement stands in, by the statement's name on its page. */
  private async plannedForStatement(pageId: string, name: string | null): Promise<{ planned: PlannedMarkView | null; plannedNote?: string }> {
    try {
      const marks = await this.marks();
      const mark = name === null ? undefined : marksForPage(marks, pageId).get(name);
      return { planned: mark === undefined ? null : { task: mark.task, how: mark.how } };
    } catch (error) {
      return { planned: null, plannedNote: (error as Error).message };
    }
  }

  /** The planned changes on one document's sections, by the anchor or the line range the task's scope names. */
  private async plannedForDocument(repo: string | null, path: string): Promise<{ sections: PlannedSectionView[]; note?: string }> {
    try {
      const marks = await this.marks();
      // A task whose closure or impact could not be read marks nothing, and the page says so rather than showing none.
      const note = marks.notes.join(' · ');
      return { sections: marksForDocument(marks, repo, path).map((section) => ({ anchor: section.anchor, lines: section.lines, task: section.task, how: section.how })), ...(note === '' ? {} : { note }) };
    } catch (error) {
      return { sections: [], note: (error as Error).message };
    }
  }

  /**
   * The product's Markdown pages as the graph holds them, read from the product repository's stored files: the page
   * index reads the same entities the pages draw, and never a second copy of the checkout (madarch-hsqs stage C).
   */
  private async indexPages(): Promise<IndexedPage[]> {
    const product = this.product();
    if ('message' in product) return [];
    const files = await this.productFiles();
    const read = await this.manifestFrom(product.folder);
    if (!read.present) return [];
    const ordinaryKinds = new Map([...read.manifest.kinds].filter(([, decl]) => decl.source === 'markdown'));
    const paths: string[] = [];
    for (const kind of ordinaryKinds.values()) {
      if (kind.file !== undefined) paths.push(kind.file);
      else if (kind.folder !== undefined) paths.push(...files.filesBelow(kind.folder).filter((path) => path.endsWith('.md')));
    }
    await files.ensure(paths);
    return readKnowledgePagesFrom(files, read.manifest).pages;
  }

  /** The file each page of the product is written in: what a task's statement scope names when a commit closes it. */
  private async pageFiles(): Promise<Map<string, string>> {
    return new Map((await this.indexPages()).map((page) => [page.id, page.file] as const));
  }

  /** One block of a page, by the line of its template: what a deferred diagram reads to draw itself. */
  async block(id: string, held: string, lang?: string, history?: HistorySelection): Promise<{ ok: true; block: Block } | { ok: false; status: 404; message: string }> {
    const result = await this.page(id, lang, { only: held, ...(history === undefined ? {} : { history }) });
    if (!result.ok) return { ok: false, status: 404, message: result.message };
    const [block] = result.page.blocks;
    return block === undefined ? { ok: false, status: 404, message: `the template of ${id} has no block known as ${held}` } : { ok: true, block };
  }

  /** The statement view of one sentence of an agent's page. */
  async statement(id: string, sentence: string, turn = 0): Promise<StatementResult> {
    const context = await this.context();
    if ('absent' in context) return { ok: false, status: 404, message: `the product has no ${context.file}: the wiki shows the kinds that file declares` };
    const result = await buildStatement(context.ctx, id, sentence, turn);
    if (!result.ok) return result;
    return { ok: true, statement: { ...result.statement, ...(await this.plannedForStatement(id, result.statement.name)) } };
  }

  /**
   * The terms of the product's glossaries, read from the graph and from nothing else: every entity of every kind whose
   * manifest declaration names the glossary listing (`listing: glossary`), with its definition, its other names and the
   * file and lines its evidence states it at. The old reading of the documents at request time is gone; a term exists
   * because the fill's plugins published it. The answer carries a count of the manifest's findings, never their list.
   */
  async glossary(): Promise<{ terms: GlossaryTermView[]; resolutions: Record<string, Resolution>; findingCount: number }> {
    const context = await this.context();
    if ('absent' in context) return { terms: [], resolutions: {}, findingCount: 0 };
    const terms: GlossaryTermView[] = [];
    const kinds = [...context.manifest.kinds.values()].filter((decl) => decl.listing === 'glossary').sort((left, right) => byCodePoint(left.name, right.name));
    for (const decl of kinds) {
      const page = await context.ctx.graph.list(decl.name, { limit: GLOSSARY_TERM_LIMIT });
      for (const entity of page.rows) terms.push(this.glossaryTermOf(entity));
    }
    terms.sort((left, right) => byCodePoint(left.title.toLowerCase(), right.title.toLowerCase()) || byCodePoint(left.id, right.id));
    return { terms, resolutions: {}, findingCount: context.manifest.findings.length };
  }

  /** Whether the store holds the generated table of one kind: what a manifest change is checked by. */
  async hasGraphTable(kind: string): Promise<boolean> {
    const owner = await this.open();
    return await hasGeneratedTable(owner, kind);
  }

  /** One graph entity as the glossary states a term: its definition and names from its claims, and where its evidence is. */
  private glossaryTermOf(entity: GraphEntity): GlossaryTermView {
    const evidence = (entity.evidence ?? []).find((one) => one.field === 'definition') ?? (entity.evidence ?? [])[0];
    const repository = evidence?.repository ?? null;
    // The product's own repository is addressed as the product's documents are; a code repository keeps its name.
    const identity = this.product();
    const own = 'message' in identity ? undefined : productRepositoryId(identity);
    const productRepository = repository !== null && repository === own;
    const path = evidence?.path ?? '';
    const line = evidence?.lineStart ?? 1;
    const endLine = evidence?.lineEnd ?? line;
    const names = entity.properties['synonyms'];
    const codeNames = entity.properties['code'];
    return {
      id: entity.key,
      title: entity.label,
      definition: typeof entity.properties['definition'] === 'string' ? entity.properties['definition'] : '',
      synonyms: Array.isArray(names) ? names.filter((one): one is string => typeof one === 'string') : [],
      code: Array.isArray(codeNames) ? codeNames.filter((one): one is string => typeof one === 'string') : [],
      // The listing's place column already states where the definition stands; the term's own place is not said twice.
      usedIn: null,
      ambiguous: null,
      repo: productRepository ? null : repository,
      path,
      line,
      endLine,
      anchor: null,
      single: this.repositories().length <= 1,
      href: entityAddress(entity.key),
    };
  }

  /**
   * The neighbours of one entity, for a diagram that opens a node: one hop, optionally one relation and direction, the
   * graph's own cut counted in `more`. A refusal names why (no entity, or no manifest).
   */
  async neighborhood(id: string, options: { relation?: string; direction?: 'out' | 'in'; limit: number; history?: HistorySelection }): Promise<{ ok: true; neighborhood: Neighborhood } | { ok: false; status: 404; message: string }> {
    const history = options.history === undefined ? undefined : await this.historyAt(options.history);
    if (history !== undefined && history.coverage !== 'covered') return { ok: false, status: 404, message: `historical structure is ${history.coverage} for ${history.repo} at ${history.at}; no current structure is substituted` };
    const context = await this.context(history);
    if ('absent' in context) return { ok: false, status: 404, message: `the product has no ${context.file}: the wiki shows the kinds that file declares` };
    const located = await findSubject(context.ctx, id);
    if (located === undefined) return { ok: false, status: 404, message: noEntityMessage(id, context.ctx.language) };
    const { hood } = await neighborhoodOf(context.ctx, located.subject, { depth: 1, ...(options.relation === undefined ? {} : { relations: [options.relation] }), ...(options.direction === undefined ? {} : { direction: options.direction }), limit: options.limit, maxNodes: options.limit * 4 + 1 });
    return { ok: true, neighborhood: history === undefined ? hood : withHistoryLinks(hood, history) };
  }

  /**
   * The view a specification asks for (decision 0026: a page chooses what to show and madarch checks it against the
   * graph): the views as the page receives them, so a drill-down replaces a diagram in place. A refusal names why.
   */
  async view(query: URLSearchParams, lang?: string): Promise<{ ok: true; renderer: string; views: ViewPayload[] } | { ok: false; status: 400 | 404; message: string }> {
    const built = await this.buildView(query, lang);
    if (!built.ok) return built;
    const chosen = chosenRenderer(built.ctx.manifest.diagram, process.env);
    if (!chosen.ok) return { ok: false, status: 400, message: chosen.message };
    return { ok: true, renderer: chosen.renderer, views: built.views.map((view) => payloadOf(view, chosen.renderer)) };
  }

  /** The LikeC4 page or the archify page of a view, or the bundle the LikeC4 page defines its element from. */
  async viewFrame(query: URLSearchParams, renderer: string, lang?: string): Promise<{ ok: true; body: string; type: 'html' | 'json' } | { ok: false; status: 400 | 404 | 500; message: string }> {
    const built = await this.buildView(query, lang);
    if (!built.ok) return built;
    const [view] = built.views;
    if (view === undefined || view.empty !== null) return { ok: false, status: 404, message: view?.empty ?? 'the specification names no view' };
    if (!(RENDERERS_OF[view.spec.type] as readonly string[]).includes(renderer)) return { ok: false, status: 400, message: `the ${view.spec.type} view is not drawn by ${renderer}: it is drawn by ${RENDERERS_OF[view.spec.type].join(', ')}` };
    const env = { ...process.env, ...(this.options.env ?? {}) } as Record<string, string | undefined>;
    if (renderer === 'likec4') {
      const model = await likec4Model(view);
      return model.ok ? { ok: true, body: JSON.stringify(model), type: 'json' } : { ok: false, status: 500, message: model.message };
    }
    if (renderer === 'archify') {
      const frame = await archifyFrame(view, env);
      if (!frame.ok) return { ok: false, status: 500, message: frame.message };
      return { ok: true, body: frame.html, type: 'html' };
    }
    return { ok: false, status: 400, message: `"renderer" is ${JSON.stringify(renderer)}: the renderers with a frame are likec4 and archify` };
  }

  private async buildView(query: URLSearchParams, lang?: string): Promise<{ ok: true; views: GraphView[]; ctx: RenderContext } | { ok: false; status: 400 | 404; message: string }> {
    const context = await this.context();
    if ('absent' in context) return { ok: false, status: 404, message: `the product has no ${context.file}: the wiki shows the kinds that file declares` };
    try {
      const spec = parseSpec(query);
      // A domain map is scoped by the manifest kind name, not by an entity id. All other non-empty subjects
      // must resolve to a page or graph entity before the view builder can read them.
      const kindScope = spec.type === 'domain-map';
      const located = spec.subject === '' || kindScope ? undefined : await findSubject(context.ctx, spec.subject);
      if (spec.subject !== '' && !kindScope && located === undefined) return { ok: false, status: 404, message: noEntityMessage(spec.subject) };
      const views = await buildViews({ ctx: context.ctx, lang, productTitle: productTitleOf(context.ctx) }, spec, located?.subject);
      return { ok: true, views, ctx: context.ctx };
    } catch (error) {
      if (error instanceof ViewRefusal) return { ok: false, status: error.status, message: error.message };
      throw error;
    }
  }

  async list(kind: string, options: { q?: string; after?: string; limit: number }) {
    const context = await this.context();
    if ('absent' in context) return undefined;
    return await listEntities(context.ctx, kind, options);
  }

  /**
   * The Markdown documents the wiki shows as pages: the product repository's own and each connected repository's, as
   * the graph holds them at the commit the fill read.
   */
  async documents(): Promise<DocumentListing> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    // The manifest is the graph's, at this revision: a product the graph holds no kinds file of has no pages of kinds and
    // no excluded files, and the read never writes the starter set (madarch-hsqs stage C).
    const read = await this.manifestFrom(product.folder);
    const manifest: KindsManifest = read.present ? read.manifest : { file: read.file, roles: new Map(), properties: new Map(), kinds: new Map(), declaredTemplates: [], groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] };
    const context = await this.context();
    if ('absent' in context) return { documents: [], truncated: [] };
    const graph = context.ctx.graph;
    const documents: DocumentRef[] = [];
    const truncated: DocumentListing['truncated'] = [];
    // The product's own pages (the files of its Markdown kinds) are entity pages, and the manifest names the harness files that are no product document.
    const shown = (path: string): boolean => !HARNESS_FILES.has(path.split('/').pop()!);
    // The documents are the graph's, read page by page with the Markdown rule in the statement: a repository of more
    // files than one page holds still answers its documents, and the total a truncation names is every document listed.
    const listedIn = async (repo: string | null, repository: string): Promise<{ paths: string[]; sizes: Map<string, number | null>; total: number }> => {
      const paths: string[] = [];
      const sizes = new Map<string, number | null>();
      let after: string | undefined;
      for (;;) {
        const page = await graph.documents(repository, { limit: DOCUMENT_PAGE, ...(after === undefined ? {} : { after }) });
        for (const file of page.rows) {
          if (!shown(file.path) || !listedDocument(manifest, repo, file.path)) continue;
          paths.push(file.path);
          sizes.set(file.path, file.bytes);
        }
        if (page.next === null) break;
        after = page.next;
      }
      return { paths, sizes, total: paths.length };
    };
    const productRepository = productRepositoryId(product);
    const own = await listedIn(null, productRepository);
    if (own.total > DOCUMENT_LIMIT) truncated.push({ repo: null, total: own.total, shown: DOCUMENT_LIMIT });
    const ownPaths = own.paths.slice(0, DOCUMENT_LIMIT);
    const ownTexts = await graph.contentsOf(productRepository, ownPaths.filter((path) => (own.sizes.get(path) ?? 0) <= DOCUMENT_READ_BYTES));
    for (const path of ownPaths) documents.push({ repo: null, path, title: documentTitle(ownTexts.get(path) ?? '', path) });
    for (const repo of this.repositories().filter((candidate) => candidate.present)) {
      const found = await listedIn(repo.name, repo.name);
      if (found.total > DOCUMENT_LIMIT) truncated.push({ repo: repo.name, total: found.total, shown: DOCUMENT_LIMIT });
      const names = found.paths.slice(0, DOCUMENT_LIMIT);
      // One statement reads the lot; a document too large to read is titled by its file name.
      const texts = await graph.contentsOf(repo.name, names.filter((name) => (found.sizes.get(name) ?? 0) <= DOCUMENT_READ_BYTES));
      for (const name of names) documents.push({ repo: repo.name, path: name, title: documentTitle(texts.get(name) ?? '', name) });
    }
    for (const kind of Object.keys(GUIDE_OUTPUTS)) {
      const declared = manifest.kinds.get(kind);
      if (declared?.source !== 'markdown' || declared.file === undefined) continue;
      if (await graph.content(productRepository, declared.file) === null) continue;
      if (!documents.some((document) => document.repo === null && document.path === declared.file)) documents.push({ repo: null, path: declared.file, title: declared.labels?.[manifest.language === 'ru' ? 'ru' : 'en']?.one ?? kind });
    }
    return { documents, truncated };
  }

  /** One document as a page; `undefined` when the repository has no such document. */
  async document(repo: string | null, path: string): Promise<DocumentPage | undefined> {
    const identity = this.product();
    if ('message' in identity) throw new WikiReadError(identity.message);
    const registry = await this.manifestRead(this.options.productFolder);
    const guideKind = repo === null && registry.present ? (Object.keys(GUIDE_OUTPUTS) as GuideKind[]).find((kind) => registry.manifest.kinds.get(kind)?.source === 'markdown' && registry.manifest.kinds.get(kind)?.file === path) : undefined;
    if (guideKind !== undefined) {
      const assembled = await this.page(GUIDE_OUTPUTS[guideKind].id);
      if (!assembled.ok) return undefined;
      const only = assembled.page.blocks.length === 1 ? assembled.page.blocks[0] : undefined;
      if (only?.type !== 'guide') return { repo: null, path, title: assembled.page.title, markdown: assembled.page.findings.map((finding) => finding.message).join('\n'), resolutions: {}, anchors: {}, commit: null, planned: [] };
      const guideText = (only.data as { markdown?: unknown }).markdown;
      return { repo: null, path, title: assembled.page.title, markdown: typeof guideText === 'string' ? guideText : '', resolutions: assembled.page.resolutions, anchors: {}, commit: null, planned: [] };
    }
    if (!DOCUMENT_PATH.test(path)) return undefined;
    const context = await this.context();
    if ('absent' in context) return undefined;
    // A document's text is the content the files producer stored, at the commit the graph was filled from: the product
    // repository is the one named after the product, and no checkout is read.
    const markdown = await context.ctx.graph.content(repo ?? productRepositoryId(identity), path);
    if (markdown === null || Buffer.byteLength(markdown) > DOCUMENT_READ_BYTES) return undefined;
    const resolutions: Record<string, Resolution> = {};
    for (const match of markdown.matchAll(/madarch:[^\s)\]>"']+/g)) {
      const target = match[0].replace(/[.,;:]+$/, '');
      if (!(target in resolutions)) resolutions[target] = await context.ctx.resolver.resolve(target);
    }
    const planned = await this.plannedForDocument(repo, path);
    return {
      repo,
      path,
      title: documentTitle(markdown, path),
      markdown,
      resolutions,
      anchors: Object.fromEntries(documentAnchors(markdown).map((anchor) => [anchor, anchorLines(markdown).get(anchor)!])),
      commit: repo === null ? null : this.pins.get(repo)?.commit ?? null,
      planned: planned.sections,
      ...(planned.note === undefined ? {} : { plannedNote: planned.note }),
    };
  }

  /**
   * A file of a repository as the graph was filled from it, for the source view. At a past commit it answers the text
   * that commit held, and why the graph holds none of it where it holds none; never the current tree's text.
   */
  async source(repo: string | null, path: string, selection?: HistorySelection): Promise<SourceRead | undefined> {
    const history = selection === undefined ? undefined : await this.historyAt(selection);
    if (history !== undefined && (history.coverage !== 'covered' || repo !== history.repo)) return undefined;
    const context = await this.context(history);
    if ('absent' in context) return undefined;
    if (history !== undefined) {
      if (repo === null || history.commit === null) return { absent: `the store holds no text of ${JSON.stringify(path)} at the commit the history names: no code repository is named for it (src/knowledge/product.ts)` };
      const at = await context.ctx.graph.contentAt(repo, path, history.commit);
      return 'absent' in at ? { absent: at.absent } : { text: at.text, commit: history.commit, history };
    }
    const text = await context.ctx.readSource(repo, path);
    if (text === undefined) return undefined;
    return { text, commit: repo === null ? null : this.pins.get(repo)?.commit ?? null };
  }

  // ---- the loop of questions and corrections (madarch-m38l.7) ---------------------------------

  /** The questions of the product as the graph holds them; a question's file is read once per graph revision. */
  async questions(): Promise<QuestionListing> {
    return await listQuestions(await this.productFiles());
  }

  async question(slug: string): Promise<QuestionDetail | undefined> {
    const context = await this.context();
    const resolve = 'absent' in context
      ? async (url: string) => ({ state: 'broken' as const, target: url, reason: `the product has no ${context.file}` })
      : (url: string) => context.ctx.resolver.resolve(url);
    return await questionDetail(await this.productFiles(), slug, resolve);
  }

  /** A person's answer: written into the question's file and committed with the person as author. */
  async answer(slug: string, text: string): Promise<Answered> {
    const done = await answerQuestion({ productFolder: this.options.productFolder, slug, text, ...(this.options.now === undefined ? {} : { now: this.options.now }), env: { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv });
    this.notify();
    return done;
  }

  // ---- the scoped tasks of answers (madarch-m38l.14) ------------------------------------------

  /** The repositories a commit may close a task in: the product's own, then each code repository checked out. */
  private taskRepositories(): RepositoryRef[] {
    const product = this.product();
    if ('message' in product) return [];
    return [{ name: '', path: product.folder }, ...this.repositories().filter((repo) => repo.present).map((repo) => ({ name: repo.name, path: repo.path }))];
  }

  /** Where planned changes show now, read once per revision of the product's files and its graph. */
  private async marks(): Promise<PlannedMarks> {
    const key = await this.marksKey();
    const held = this.marksMemo;
    if (held !== undefined && held.key === key) return held.marks;
    const product = this.product();
    if ('message' in product) return NO_MARKS;
    const owner = await this.open();
    const repositories = this.repositories().filter((repo) => repo.present).map((repo) => ({ name: repo.name, path: repo.path }));
    const files = await this.productFiles();
    const read = await this.manifestFrom(product.folder);
    if (!read.present) return NO_MARKS;
    const marks = await plannedMarks({
      owner, productFolder: this.options.productFolder, files, manifest: read.manifest,
      // The product's own repository closes a task as a code repository does: its documents are in it.
      repositories: [{ name: '', path: product.folder }, ...repositories],
      // The product repository's own Markdown, as the graph holds it: a path here belongs to the product, not to a code repository.
      productFiles: files.paths().filter((path) => path.endsWith('.md')),
      pageFiles: await this.pageFiles(),
    });
    this.marksMemo = { key, marks };
    return marks;
  }

  /** The task reading's inputs: the product's own files as the graph holds them, and the manifest they declare. */
  private async taskRead(): Promise<{ owner: DatabaseOwner; files: StoredProductFiles; manifest: KindsManifest }> {
    const owner = await this.open();
    const files = await this.productFiles();
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const read = await this.manifestFrom(product.folder);
    if (!read.present) throw new WikiReadError(`the product has no ${read.file}: the wiki shows the kinds that file declares`);
    return { owner, files, manifest: read.manifest };
  }

  /** The product's tasks, open first, each with what its change reaches through the graph. */
  async tasks(): Promise<TaskListing> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    // A product the graph holds no kinds manifest of holds no task it can read: the page says so by answering none.
    if (!(await this.manifestRead(product.folder)).present) return { tasks: [], open: 0, closed: 0, problems: [], notes: [] };
    const { owner, files, manifest } = await this.taskRead();
    return await listTasks({ productFolder: this.options.productFolder, owner, files, manifest, repositories: this.taskRepositories(), pageFiles: await this.pageFiles(), placeOf: (scope) => this.placeOf(scope) });
  }

  /** One task with its complete impact: the pages a run would rewrite and the marks it stands on. */
  async task(id: string): Promise<TaskDetail | undefined> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    if (!(await this.manifestRead(product.folder)).present) return undefined;
    const { owner, files, manifest } = await this.taskRead();
    return await taskDetail({ productFolder: this.options.productFolder, owner, files, manifest, repositories: this.taskRepositories(), pageFiles: await this.pageFiles(), placeOf: (scope) => this.placeOf(scope) }, id, await this.marks());
  }

  /** The task an answer proposes: the scope its grounds name and its impact through the graph, before anything is written. */
  async proposeTask(question: string, choice: TaskChoice, asked?: 'en' | 'ru'): Promise<TaskProposal> {
    const owner = await this.open();
    const read = await this.manifestRead(this.options.productFolder);
    // The reader's interface language when it says one, else the language the product's pages are written in.
    const language = asked ?? (read.present && read.manifest.language === 'ru' ? 'ru' : 'en');
    const proposal = await proposeTask({ owner, productFolder: this.options.productFolder, question, choice, language });
    // The places as a reader says them: a section's heading and its document's title, never a `doc:` key.
    return { ...proposal, places: await Promise.all(proposal.scope.map((scope) => this.placeOf(scope))) };
  }

  /**
   * A place as the wiki names it: a section's heading and the document's title, a document's title, a symbol's or a
   * statement's words. Each with the address that opens it, and the path only as small secondary text.
   */
  async placeOf(scope: TaskScope): Promise<PlaceView> {
    const words = scopeWords(scope);
    // The product's own documents belong to no code repository; every other path belongs to the one repository the pages
    // are written from (asked of the declared checkouts, not of a fill: a place is shown before anything was read).
    const own = (await this.productFiles()).paths();
    const repoOf = (path: string): string | null => {
      if (own.includes(path)) return null;
      const present = this.repositories().filter((repo) => repo.present);
      return present.length === 1 ? present[0]!.name : null;
    };
    if (scope.type === 'section') {
      const repo = repoOf(scope.path);
      const page = await this.document(repo, scope.path);
      // The label is the name the document gives the part, read from the tree: a heading's text or a bold item's phrase.
      const heading = page === undefined ? undefined : titleOfAnchor(page.markdown, scope.anchor);
      return { kind: 'section', label: heading === undefined || heading === '' ? scope.anchor : heading, where: page?.title ?? scope.path, href: documentAddress(repo, scope.path, scope.anchor), path: scope.path, words };
    }
    if (scope.type === 'file' || scope.type === 'lines') {
      const repo = repoOf(scope.path);
      const page = await this.document(repo, scope.path);
      const title = page?.title ?? scope.path.split('/').pop() ?? scope.path;
      const label = scope.type === 'lines' ? `${title} · ${scope.start}–${scope.end}` : title;
      return { kind: scope.type, label, where: null, href: documentAddress(repo, scope.path), path: scope.path, words };
    }
    if (scope.type === 'symbol') {
      const key = scope.key.startsWith('code.symbol:') ? scope.key : `code.symbol:${scope.key}`;
      const rest = key.slice('code.symbol:'.length);
      const hash = rest.indexOf('#');
      return { kind: 'symbol', label: hash < 0 ? rest : rest.slice(hash + 1), where: hash < 0 ? null : rest.slice(0, hash), href: entityAddress(key), path: hash < 0 ? rest : rest.slice(0, hash), words };
    }
    const page = scope.key.slice(0, scope.key.indexOf('#'));
    const title = (await this.indexPages()).find((candidate) => candidate.id === page)?.title ?? page;
    return { kind: 'statement', label: title, where: null, href: entityAddress(page), path: null, words };
  }

  /** Create a task only after the reader confirms its proposed scope: a product file, committed as the reader. */
  async createTask(input: { question: string; title: string; grounds: string[]; scope: TaskScope[] }): Promise<{ task: PlannedTask; state: 'created'; committed: boolean; note?: string; commit?: string }> {
    const question = (await this.questions()).rows.find((row) => row.slug === input.question);
    if (question === undefined || question.state === 'open') throw new LoopRefusal(409, `docs/questions/${input.question}.md:1: a task needs a saved answer to an existing question`);
    const detail = await this.question(input.question);
    if (detail?.answer === null || detail?.answer === undefined) throw new LoopRefusal(409, `docs/questions/${input.question}.md:1: the saved answer cannot be read`);
    if (input.title.trim() === '') throw new LoopRefusal(400, 'docs/tasks:1: a confirmed task needs a title');
    if (input.scope.length === 0) throw new LoopRefusal(400, 'docs/tasks:1: a confirmed task needs a scope: the section, lines, symbol or statement it changes');
    if (input.grounds.length === 0) throw new LoopRefusal(400, 'docs/tasks:1: a confirmed task needs its grounds: what the change stands on');
    const by = await localIdentity(this.options.productFolder, { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv);
    // A scope the wiki cannot read back is refused now: a task file it cannot parse would vanish into findings.
    const scopes = dedupeScopes(input.scope);
    const bad = scopes.findIndex((scope) => readScope(JSON.parse(JSON.stringify(scope))) === undefined);
    if (bad >= 0) throw new LoopRefusal(400, `docs/tasks:1: scope[${bad}] is ${JSON.stringify(scopes[bad])}, and a scope is a section { path, anchor }, lines { path, start, end }, file { path }, symbol or statement { key }`);
    const title = input.title.trim();
    const existing = readTasks(this.options.productFolder);
    if (existing.findings.length > 0) throw new LoopRefusal(409, `docs/tasks:1: cannot safely check existing tasks: ${existing.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`).join('; ')}`);
    const wanted = taskSlug(title, scopes);
    const collided = existing.tasks.find((candidate) => candidate.slug === wanted);
    let slug = wanted;
    if (collided !== undefined && taskSlug(collided.title, collided.scope) !== wanted) {
      for (let n = 2; ; n += 1) {
        const candidate = `${wanted}-${n}`;
        if (!existing.tasks.some((task) => task.slug === candidate)) { slug = candidate; break; }
      }
    }
    const file = `docs/tasks/${slug}.md`;
    if (existing.tasks.some((task) => task.slug === slug)) throw new LoopRefusal(409, `${file}:1: a task with this id already exists`);
    const task = { slug, title, status: 'open' as const, question: `question:${input.question}`, answer: `answer:${input.question}`, grounds: [...new Set(input.grounds)].sort(byCodePoint), scope: scopes, by, at: (this.options.now?.() ?? new Date()).toISOString(), closedBy: null, closedAt: null };
    try {
      writeTask(this.options.productFolder, file, task);
    } catch (error) {
      throw new LoopRefusal(409, `${file}:1: the task could not be written: ${(error as Error).message}`);
    }
    const committed = await commitFiles(this.options.productFolder, [file], `Plan the task ${slug}\n\nTask: ${slug}`, by, { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv);
    this.notify();
    return { task: { ...task, id: `task:${slug}`, file }, state: 'created', ...committed };
  }

  /**
   * What a scope reaches through the graph, read while the reader edits it: the preview follows the scope, not the answer.
   * A scope that names nothing refuses with its scopes rather than answering an empty list.
   */
  async scopeImpact(scope: readonly TaskScope[]): Promise<TaskImpact> {
    const keys = [...new Set(scope.flatMap((one) => groundsOfScope(one)))].sort(byCodePoint);
    if (keys.length === 0) throw new WikiReadError('docs/tasks:1: this scope names no place of the product, so the change reaches nothing: name a section, a file, a symbol or a statement');
    const owner = await this.open();
    return await impactOf(owner, this.options.productFolder, keys);
  }

  /** Closes a task by hand: the file says who and when, and the change is committed as the reader. */
  async closeTask(id: string): Promise<{ task: PlannedTask; state: 'closed'; committed: boolean; note?: string; commit?: string }> {
    const read = readTasks(this.options.productFolder);
    const task = read.tasks.find((candidate) => candidate.id === id || candidate.slug === id);
    if (task === undefined) throw new LoopRefusal(404, `docs/tasks:1: there is no task ${id}: docs/tasks/${id.replace(/^task:/, '')}.md is not in the product repository`);
    if (task.status === 'closed') throw new LoopRefusal(409, `${task.file}:1: the task ${task.slug} is already closed`);
    let closing: ReturnType<typeof closingCommit>;
    try {
      closing = closingCommit(task, this.taskRepositories(), { pageFiles: await this.pageFiles() });
    } catch (error) {
      throw new LoopRefusal(409, (error as Error).message);
    }
    if (closing !== undefined) throw new LoopRefusal(409, `${task.file}:1: the task ${task.slug} is already closed by the commit ${closing.commit} of ${closing.repository || 'the product'}`);
    const by = await localIdentity(this.options.productFolder, { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv);
    const at = (this.options.now?.() ?? new Date()).toISOString();
    const closed: PlannedTask = { ...task, status: 'closed', closedBy: 'person', closedAt: at };
    // The file is replaced whole: a half-written task is a task the wiki cannot read.
    writeFileSync(join(this.options.productFolder, task.file), renderTask(closed), 'utf8');
    const committed = await commitFiles(this.options.productFolder, [task.file], `Close the task ${task.slug} by hand\n\nTask: ${task.slug}`, by, { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv);
    this.notify();
    return { task: closed, state: 'closed', ...committed };
  }

  /**
   * «Поправить страницы сейчас»: a refresh limited to exactly the pages the task's impact lists. The plan the agent is
   * given is that list, computed here, so the run cannot widen it; a task that reaches no page of the product refuses
   * with its grounds rather than writing something else.
   */
  async runTask(id: string): Promise<{ ok: true; task: TaskRow; pages: readonly string[]; fill: FillState } | { ok: false; message: string }> {
    const read = readTasks(this.options.productFolder);
    const task = read.tasks.find((candidate) => candidate.id === id || candidate.slug === id);
    if (task === undefined) return { ok: false, message: `there is no task ${id}: docs/tasks/${id.replace(/^task:/, '')}.md is not in the product repository` };
    const owner = await this.open();
    // A task a commit already closed writes nothing: its change is in the history.
    try {
      const closing = closingCommit(task, this.taskRepositories(), { pageFiles: await this.pageFiles() });
      if (closing !== undefined) return { ok: false, message: `the task ${task.slug} is closed by the commit ${closing.commit} of ${closing.repository || 'the product'}, so its pages are not written again` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    let impact: TaskImpact;
    try {
      impact = await impactOf(owner, this.options.productFolder, impactGroundsOf(task));
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    if (impact.writable.length === 0) {
      return { ok: false, message: `the task ${task.slug} reaches no page of the product that the agent writes (${impact.pages.map((page) => page.file).join(', ') || 'no page at all'}): its grounds are ${impact.grounds.join(', ')}` };
    }
    // The task press limited the *writer* to the pages the task reaches; this build runs no writer (the owner:
    // "Старый код, старый цикл разбора мы удаляем" — the agent stage is a later task's, decision 0033 item 1), so the
    // press is refused by name rather than reported as a run that wrote nothing.
    return { ok: false, message: `the task ${task.slug} reaches the pages ${impact.writable.join(', ')}, and writing them needs the agent stage, which this build does not run: a later task builds it (decision 0033, item 1)` };
  }

  /** A person's correction of a statement: a new file, committed with the person as author. */
  async correct(statement: string, reason: string): Promise<Corrected> {
    const done = await recordCorrection({ productFolder: this.options.productFolder, statement, reason, ...(this.options.now === undefined ? {} : { now: this.options.now }), env: { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv });
    this.notify();
    return done;
  }

  /** The single code repository the pages are written from, and the commit the graph describes of it; absent otherwise. */
  private singleRepository(): { name: string; path: string; commit: string } | undefined {
    const repositories = this.repositories().filter((repo) => repo.present);
    if (repositories.length !== 1) return undefined;
    const pin = this.pins.get(repositories[0]!.name);
    return pin === undefined || pin.head === '' ? undefined : { name: repositories[0]!.name, path: repositories[0]!.path, commit: pin.head };
  }

  /** The corrections people made and what the engine found itself, each with who fixes it. */
  async problems(): Promise<ProblemListing> {
    return await this.problemListing();
  }

  /**
   * The Problems page's first level: one row per rule, with the counts the page and the sidebar show, and no problem
   * list (madarch-8bdc.2.5). `section` filters the rows; the totals and the severity counts are of the rows shown, so
   * a filtered page never claims a number the other pages do not hold.
   */
  async problemCategories(section?: ProblemSection): Promise<ProblemCategories> {
    const listing = await this.problemListing();
    const categories = section === undefined ? listing.categories : listing.categories.filter((category) => category.section === section);
    const problems = section === undefined ? listing.problems : listing.problems.filter((problem) => problem.section === section);
    const sections = { code: 0, documents: 0, wiki: 0 } as Record<ProblemSection, number>;
    const severities = { blocker: 0, critical: 0, major: 0, minor: 0, info: 0 } as Record<ProblemSeverity, number>;
    for (const problem of problems) { sections[problem.section] += 1; severities[problem.severity] += 1; }
    return {
      categories,
      total: problems.length,
      open: problems.filter((problem) => !problem.closed).length,
      closed: problems.filter((problem) => problem.closed).length,
      dismissed: listing.dismissed,
      sections, severities,
      notes: listing.notes,
    };
  }

  /**
   * The second level: the sources of one rule — the page or the file each problem stands in — grouped, counted and
   * paged in code-point order of their keys. `after` is the key of the last source of the previous page, exactly as
   * a folder page takes it; `next` is the key to pass back.
   */
  async problemSources(rule: string, options: { after?: string; limit: number }): Promise<ProblemSources | undefined> {
    const listing = await this.problemListing();
    const category = listing.categories.find((candidate) => candidate.rule === rule);
    if (category === undefined) return undefined;
    const rows = listing.problems.filter((problem) => problem.rule === rule);
    const grouped = new Map<string, Problem[]>();
    for (const problem of rows) {
      const key = problem.page ?? problem.file;
      const held = grouped.get(key);
      if (held === undefined) grouped.set(key, [problem]);
      else held.push(problem);
    }
    const keys = [...grouped.keys()].sort(byCodePoint);
    const start = options.after === undefined ? 0 : keys.findIndex((key) => byCodePoint(key, options.after!) > 0);
    const shown = start < 0 ? [] : keys.slice(start, start + options.limit);
    const sources = shown.map((key) => {
      const held = grouped.get(key)!;
      const first = held[0]!;
      return {
        key,
        label: first.page === null ? (first.file === '' ? key : first.file) : (first.pageTitle ?? first.page),
        page: first.page,
        pageTitle: first.pageTitle,
        file: first.file === '' ? null : first.file,
        count: held.length,
        open: held.filter((problem) => !problem.closed).length,
      };
    });
    return {
      rule, kind: category.kind, section: category.section, sonar: category.sonar, severity: category.severity,
      count: rows.length, open: rows.filter((problem) => !problem.closed).length, closed: rows.filter((problem) => problem.closed).length,
      totalSources: keys.length, sources,
      next: start >= 0 && start + options.limit < keys.length ? (shown[shown.length - 1] ?? null) : null,
    };
  }

  /**
   * The third level: the items of one source of one rule, paged by the stable problem id in code-point order: the
   * client passes `next` back as `after`, and no page is silently short — it states the count of the whole source.
   */
  async problemItems(rule: string, source: string, options: { after?: string; limit: number }): Promise<ProblemItems | undefined> {
    const listing = await this.problemListing();
    const category = listing.categories.find((candidate) => candidate.rule === rule);
    if (category === undefined) return undefined;
    const rows = listing.problems.filter((problem) => problem.rule === rule && (problem.page ?? problem.file) === source)
      .sort((a, b) => byCodePoint(a.id, b.id));
    if (rows.length === 0) return undefined;
    const start = options.after === undefined ? 0 : rows.findIndex((problem) => byCodePoint(problem.id, options.after!) > 0);
    const shown = start < 0 ? [] : rows.slice(start, start + options.limit);
    const more = start >= 0 && start + options.limit < rows.length;
    return {
      rule, source,
      count: rows.length, open: rows.filter((problem) => !problem.closed).length, closed: rows.filter((problem) => problem.closed).length,
      problems: shown,
      next: more ? (shown[shown.length - 1]?.id ?? null) : null,
    };
  }

  /** The listing as the page reads it: the same collection `problems()` cached, for the three levels. */
  private async problemListing(): Promise<ProblemListing> {
    const context = await this.context();
    if ('absent' in context) {
      // A product the graph holds no kinds manifest of is not judged: the page says so, and answers no problem, rather
      // than a count of a checkout the wiki no longer reads (madarch-hsqs stage C).
      return { problems: [], categories: [], sections: { code: 0, documents: 0, wiki: 0 }, open: 0, closed: 0, dismissed: 0, notes: [{ message: `the product has no ${context.file} in the graph yet: start a fill to read the product repository` }] };
    }
    const owner = await this.open();
    return await this.problemsFor(await this.problemsKey(), owner);
  }

  /**
   * What the Problems page reads, as one key: the graph revision (every product file the page reads is the graph's at
   * that revision), the pins it is shown beside, the writer's unplaced plan and the manifest. The revision the change
   * stream moves with is not part of it: a fill that reads a commit moves that revision without changing a problem
   * (madarch-m38l.19). A read of a page never stamps the checkout (madarch-hsqs stage C).
   */
  private async problemsKey(): Promise<string> {
    return `${await this.problemInputsKey()}|${this.storeKey()}`;
  }

  /** What the Problems listing reads besides the store: the graph revision and the writer's plan. */
  private async problemInputsKey(): Promise<string> {
    const plan = this.writer.plan === undefined ? '' : this.writer.plan.unplaced.map((entry) => `${entry.kind}:${entry.slug}`).join(',');
    return `${plan}|${await this.graphRevision()}`;
  }

  /** The store as a listing reads it: the snapshot the pages show and what each repository was filled to. */
  private storeKey(): string {
    const pins = [...this.pins.values()].map((pin) => `${pin.name}@${pin.commit}`).join(',');
    const snapshot = this.reader === undefined ? '' : String(this.reader.seq);
    return `${snapshot}|${pins}`;
  }

  /** The key where a store that cannot answer is no reason to fail an answer: the background refresh. */
  private async problemsKeySafe(): Promise<string> {
    try {
      return await this.problemsKey();
    } catch {
      return '';
    }
  }

  /** Collects the listing once per key: a reader that asks while it runs waits for the same collection. */
  private problemsFor(key: string, owner: DatabaseOwner): Promise<ProblemListing> {
    if (this.problemsCache?.key === key) return Promise.resolve(this.problemsCache.listing);
    if (this.problemsFlight?.key === key) return this.problemsFlight.promise;
    const sequence = (this.problemsSequence += 1);
    const promise = this.collectProblems(owner)
      .then((listing) => {
        if (this.problemsCache === undefined || this.problemsCache.sequence < sequence) this.problemsCache = { key, sequence, listing };
        this.problemsFailed = undefined;
        // The body is not made again for a listing that landed: its count is read from this cache by every answer
        // (`statusLive`), so the count appears on the next poll without re-reading a single file (madarch-u3vw.8).
        return listing;
      })
      .finally(() => {
        if (this.problemsFlight?.promise === promise) this.problemsFlight = undefined;
      });
    this.problemsFlight = { key, promise };
    return promise;
  }

  /**
   * Collects the listing for the current inputs in the background; a page or a fill never waits for it. A key whose
   * collection failed is not walked again on every poll of the menu: a change of the inputs, or a listing that lands,
   * is what tries it again (madarch-u3vw.8).
   */
  private refreshProblems(key: string): void {
    if (this.fill.state === 'running' || this.problemsFlight !== undefined) return;
    if (key === '' || this.problemsCache?.key === key || this.problemsFailed === key) return;
    void this.open()
      .then(async (owner) => {
        const current = await this.problemsKeySafe();
        if (current === '' || this.problemsCache?.key === current) return undefined;
        return this.problemsFor(current, owner);
      })
      .catch(() => { this.problemsFailed = key; });
  }

  private async collectProblems(owner: DatabaseOwner): Promise<ProblemListing> {
    const context = await this.context();
    if ('absent' in context) throw new WikiReadError(`the product has no ${context.file}: the wiki shows the kinds that file declares`);
    const repository = this.singleRepository();
    const files = await this.productFiles();
    const dismissals = await readProblemDismissalsIn(files);
    const dismissed = new Set(dismissals.items.map((item) => item.id));
    const listing = await collectProblems({
      productFolder: this.options.productFolder, owner, files, manifest: context.manifest,
      // The Problems page reads the same revision every other read does: a fill that lands meanwhile changes the next listing, not this one.
      graph: new GraphReader(owner, () => this.validAt(), undefined, undefined, graphKindsOf(context.manifest).declared, graphKindsOf(context.manifest).generated, graphKindsOf(context.manifest).edges),
      findingKinds: [...context.manifest.kinds.values()].filter((kind) => kind.findings === true).map((kind) => kind.name).sort(),
      settings: context.manifest.problems ?? defaultSettings(),
      ...(repository === undefined ? {} : { repository }),
      resolve: (url) => context.ctx.resolver.resolve(url), findings: [...context.findings, ...dismissals.problems.map((problem) => ({ file: problem.file, line: problem.line, message: problem.message }))],
      ...(this.writer.plan === undefined ? {} : { unplaced: this.writer.plan.unplaced }),
      dismissed,
    });
    return listing;
  }

  /**
   * «Не проблема»: the person's reason becomes a file in the product repository, committed as the person, and the
   * problem is left out of the page from now on. A problem the page no longer lists is refused with its id.
   */
  async dismissProblem(id: string, reason: string): Promise<{ file: string; committed: boolean; note?: string; commit?: string }> {
    const listing = await this.problems();
    const problem = listing.problems.find((candidate) => candidate.id === id);
    if (problem === undefined) throw new LoopRefusal(404, `docs/problems:1: there is no problem ${JSON.stringify(id)} in the current listing: its rule, place or inputs changed, so the page offers no such problem`);
    const [rule, ...rest] = id.split('\u0000');
    const identity = rest.join('\u0000');
    if (rule === undefined || identity === '') throw new LoopRefusal(400, `docs/problems:1: the problem id ${JSON.stringify(id)} is not <rule>\\0<identity>`);
    const by = await localIdentity(this.options.productFolder, { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv);
    const at = (this.options.now?.() ?? new Date()).toISOString();
    let written: ReturnType<typeof writeProblemDismissal>;
    try {
      written = writeProblemDismissal({ productFolder: this.options.productFolder, rule, identity, place: problem.place.label, reason, by, at });
    } catch (error) {
      throw new LoopRefusal(400, (error as Error).message);
    }
    const committed = await commitFiles(this.options.productFolder, [written.file], `Record that a problem is not one\n\nTask: madarch-m38l.19`, by, { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv);
    this.notify();
    return { file: written.file, ...committed };
  }

  /**
   * «Создать задачу»: a task scoped to exactly the place the problem names (madarch-m38l.14's task format).
   * A problem that names no place a person can change says why instead of opening an empty task.
   */
  async createProblemTask(id: string): Promise<{ task: PlannedTask; state: 'created'; committed: boolean; note?: string; commit?: string }> {
    const listing = await this.problems();
    const problem = listing.problems.find((candidate) => candidate.id === id);
    if (problem === undefined) throw new LoopRefusal(404, `docs/problems:1: there is no problem ${JSON.stringify(id)} in the current listing: its rule, place or inputs changed, so the page offers no such problem`);
    if (problem.scope === undefined) throw new LoopRefusal(409, `docs/problems:1: the problem ${JSON.stringify(id)} names no place a change can reach, so no task is opened for it`);
    const title = `Fix ${problem.rule} in ${problem.place.label}`;
    const wanted = taskSlug(title, [problem.scope]);
    const existing = readTasks(this.options.productFolder);
    if (existing.findings.length > 0) throw new LoopRefusal(409, `docs/tasks:1: cannot safely check existing tasks: ${existing.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`).join('; ')}`);
    // A different task whose 12-character hash collides takes the next free suffix; the same one keeps its file.
    const collided = existing.tasks.find((candidate) => candidate.slug === wanted);
    let slug = wanted;
    if (collided !== undefined && taskSlug(collided.title, collided.scope) !== wanted) {
      for (let n = 2; ; n += 1) {
        const candidate = `${wanted}-${n}`;
        if (!existing.tasks.some((task) => task.slug === candidate)) { slug = candidate; break; }
      }
    }
    const file = `${TASKS_FOLDER}/${slug}.md`;
    if (existing.tasks.some((task) => task.slug === slug)) throw new LoopRefusal(409, `${file}:1: a task with this id already exists`);
    const by = await localIdentity(this.options.productFolder, { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv);
    const task: Omit<PlannedTask, 'id' | 'file'> = {
      slug, title, status: 'open',
      // A problem is not a person's answer: the task names the finding it came from, and the reason is the problem's own.
      question: '', answer: '', problem: problem.id,
      grounds: problem.entity?.key != null ? [problem.entity.key] : [problem.file],
      scope: [problem.scope], by, at: (this.options.now?.() ?? new Date()).toISOString(), closedBy: null, closedAt: null,
    };
    try {
      writeTask(this.options.productFolder, file, task);
    } catch (error) {
      throw new LoopRefusal(409, `${file}:1: the task could not be written: ${(error as Error).message}`);
    }
    const committed = await commitFiles(this.options.productFolder, [file], `Plan the task ${slug}\n\nTask: ${slug}`, by, { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv);
    this.notify();
    return { task: { ...task, id: `task:${slug}`, file }, state: 'created', ...committed };
  }

  /**
   * Which pages a refresh would touch and why, computed from what the wiki holds now and shown before the press. The
   * commits the fill has not read yet are counted but cannot be judged until they are read.
   */
  async refreshPlan(language?: string): Promise<{ available: true; plan: RefreshPlan; language: { from: string | null; to: string; changed: boolean }; commitsNotRead: number | null } | { available: false; reason: string }> {
    const context = await this.context();
    // A product with no publication yet is said so by the one sentence a reader can act on: start the fill once.
    if ('absent' in context) return { available: false, reason: this.pins.size === 0 ? 'nothing has been read from the code yet: start the fill once to read it' : `the product has no ${context.file} in the graph` };
    const repository = this.singleRepository();
    if (repository === undefined) return { available: false, reason: this.pins.size === 0 ? 'nothing has been read from the code yet: start the fill once to read it' : 'the pages are written from one code repository and this product declares more or fewer' };
    const current = context.manifest.language ?? 'en';
    const wanted = language ?? current;
    const written = this.pagesLanguage();
    const changed = written !== undefined ? written !== wanted : language !== undefined && language !== current;
    const owner = await this.open();
    const planned = await planRefresh({ owner, productFolder: this.options.productFolder, repository, commit: repository.commit, language: { from: written ?? current, to: wanted, changed } });
    let commitsNotRead: number | null = null;
    try {
      const { stdout } = await execFileAsync('git', ['rev-list', '--count', `${repository.commit}..HEAD`], { cwd: repository.path, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
      commitsNotRead = Number(stdout.trim());
    } catch {
      commitsNotRead = null;
    }
    return { available: true, plan: planned.plan, language: { from: written ?? current, to: wanted, changed }, commitsNotRead: Number.isInteger(commitsNotRead) ? commitsNotRead : null };
  }

  /** Stops a running fill at its next commit and closes the store. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
    await this.writerAgent?.close().catch(() => undefined);
    await this.fillRun?.control('stop').catch(() => undefined);
    await this.running?.catch(() => undefined);
    // The graph verdicts own a connection of their own for their snapshot, and a close that returned before they ended
    // left it open under a store a caller then removed: an unhandled postmaster-exit error between tests
    // (madarch-8bdc.2.9).
    await this.verdictRun?.catch(() => undefined);
    await this.opening?.catch(() => undefined);
    await this.swapping.catch(() => undefined);
    this.listeners.clear();
    await this.fillQueue?.stop().catch(() => undefined);
    this.fillQueue = undefined;
    if (this.reader !== undefined) await this.reader.owner.close().catch(() => undefined);
    this.reader = undefined;
    // The worker that draws the templates is not the product's to end: the server opens and closes products around single
    // requests, and a worker started for every page would pay a process's start on every page. A worker nothing asks for
    // for ten seconds ends itself (`liquid.ts`).
    this.opening = undefined;
  }
}

/** What a repository was filled to: the graph's repository entity and its as-is edge, read with the snapshot it belongs to. */
export interface RepositoryPin {
  name: string;
  /** The repository's web address, as the files producer read its remote; a local path when it has none. */
  url: string;
  /**
   * The repository's node in the temporal graph, which its history reads are keyed by, or `null` when the store holds
   * no temporal reading of it — a store this fill wrote, whose facts are the as-is record tables. It is an id, never
   * the repository's name: a name there made a page fail with `invalid input syntax for type bigint`.
   */
  scope: string | null;
  head: string;
  /** The commit the graph holds for the repository, and the effective time it was read at. */
  commit: string;
  effectiveTime: string;
  commits: number;
  filledCommits: number;
}

/** The products home's knowledge wikis: one per product folder, created when first asked for. */
export class KnowledgeHost {
  private readonly products = new Map<string, KnowledgeProduct>();
  /** The root the products' stores stand in: what the fill role of this server is told to watch (madarch-8bdc.9). */
  readonly root: string;

  constructor(private readonly storeRoot: string, private readonly now?: () => Date, private readonly extra: Pick<KnowledgeProductOptions, 'env' | 'agentFactory' | 'errorLog' | 'snapshotMs' | 'choicesQuery' | 'fillQueued'> = {}) {
    this.root = storeRoot;
  }

  of(productFolder: string): KnowledgeProduct {
    const key = resolve(productFolder);
    let held = this.products.get(key);
    if (held === undefined) {
      held = new KnowledgeProduct({ productFolder: key, storeRoot: this.storeRoot, ...(this.now === undefined ? {} : { now: this.now }), ...this.extra });
      this.products.set(key, held);
    }
    return held;
  }

  async close(): Promise<void> {
    for (const product of this.products.values()) await product.close();
    this.products.clear();
  }
}
