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
 * kept in the store (`knowledge_fill`), so a source view shows the bytes the
 * graph's spans were read from, and a restarted server still knows.
 */
import { memberParent } from './blocks.js';
import { glossaryTerms, termLinks, type GlossaryTerm } from './glossary.js';
import { GUIDE_OUTPUTS } from '../writer/guides/host-contract.js';
import type { GuideContextFor, GuideHostFor } from '../writer/guides/host.js';
import type { GuideKind, GuideLocale } from '../writer/guides/model.js';
import { readGuidePage } from '../writer/guides/read.js';
import { createGuideReadFactories, guideProductPin } from '../writer/guides/writer.js';
import { createGraphStore } from '../graph/index.js';
import { createGitSnapshotSource } from '../fill/snapshot.js';
import { detectDocumentLanguage, localizedSourcePath, parseLocalizedSource, type LocalizedDocumentSource } from '../writer/localized-source.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseOwner, OuterTransaction } from '../adapters/database-owner.js';
import { RemoteOwner } from './remote-owner.js';
import { byCodePoint } from '../model/order.js';
import { MANIFEST_FILE, readProduct, type ProductIdentity } from '../product/manifest.js';
import { canonicalJsonDigest } from '../model/canonical.js';
import { selfCommand } from '../product/self-command.js';
import { headCommitOf } from '../product/fill-updates.js';
import { insideFolder, homeKind, KINDS_FILE, readKinds, setKindsLanguage, type Finding, type KindsManifest } from './kinds.js';
import { WORKFLOWS_FILE } from './workflows.js';
import { linesOf } from './lines.js';
import { applyReset, planReset, type ResetPlan } from './reset.js';
import type { KnowledgeFillResult, KnowledgeFillRun } from './fill-run.js';
import { startFillInWorker } from './fill-worker.js';
import { fillWritesPages } from '../fill/steps.js';
import { snapshotNumbers } from './fill-run.js';
import { locationOf, type RenderContext } from './blocks.js';
import { GraphReader } from './graph-read.js';
import { treeReadProducer } from '../extract/driver/index.js';
import { TREE_EXTRACTORS, HISTORY_EXTRACTOR } from '../extract/driver/extractors.js';
import { selectHistory, withHistoryLinks, type HistoryContext, type HistorySelection } from './temporal.js';
import { markdownFilesBelow, readMarkdownEntities, type MarkdownEntity } from './markdown.js';
import type { AgentOffer, Block, ChangedPage, DocumentListing, DocumentPage, DocumentRef, FillErrorView, FillRunView, FillState, Neighborhood, PageModel, PlannedMarkView, PlannedSectionView, RepositoryFactsView, WikiStatus, WriterState, WriterUnit } from './model.js';
import { commitPage, filePage, folderPage, recordedFileCount, recordedFileFacts, recordedFiles, repositoryOf, repositoryPage, type CommitPageModel, type FilePageFacts, type FilePageModel, type FolderPageModel } from './repository-view.js';
import { readFillProgressOf } from '../obs/progress.js';
import { readTraceRun } from '../obs/trace-report.js';
import { neighborhoodOf } from './diagrams.js';
import { anchorLines, titleOfAnchor } from './anchors.js';
import { adapterOf, installAdapter, makeUnitAgent, offers, queryAgentChoices, WRITER_AGENTS, WRITER_BOUNDS } from './agents.js';
import { DEFAULT_EDITORIAL_REQUESTS_PER_PAGE, MAX_EDITORIAL_REQUESTS } from '../writer/editorial.js';
import type { WriterBounds } from './model.js';
import { emptyModelAssignments, isModelRole, modelPair, resolveModelRoles, type ModelAssignments, type ModelPair, type ModelRole, type ModelRoleView } from './model-roles.js';
import type { AgentChoices } from '../fill/acp-choices.js';
import { addStarterItems, currentOffers, filesAPersonEdited, replaceWithStarterSet, upgradeStarterSet, type StarterOffer, type UpgradeReport, rememberChangedStarterFileIfOwned } from './starter-upgrade.js';
import { fileJournal, journalFolder, journalOfUnit, newRunId, NO_COUNTERS, readJournalFile, type Journal, type PageJournal } from '../writer/journal.js';
import { productSlug, PRODUCT_PATH, type ToolAnswer, type ToolClient, type UnitAgent } from '../writer/index.js';
import { CONTENT_LANGUAGES } from '../writer/prompts.js';
import type { DraftEnv } from '../product/home.js';
import { documentTitleOf, findSubject, graphTitleOf, kindSummaries, markdownTitleOf, productTitleOf, recordFilePage, renderPage, listEntities, type PageResult } from './render.js';
import { indexCounts, statementsRelyingOn } from './index/queries.js';
import { PAGE_KIND, STATEMENT_OF } from './index/vocabulary.js';
import { ACTIVE_FILL_FILE, CHANGED_PAGES_FILE, DOCUMENT_PAGES_FILE, invalidateInterruptedRun, readChangedPages, readDocumentPages } from './changed-pages.js';
import { documentSections } from './index/sections.js';
import { webLink } from './index/web-link.js';
import { acpGraphJudge } from './graph-verdict-acp-judge.js';
import { graphVerdictFile, loadGraphSnapshot, readGraphVerdictState, writeGraphVerdictBudgets, writeGraphVerdictState } from './graph-verdict-store.js';
import { GRAPH_VERDICT_VALIDATOR_VERSION, graphVerdictFingerprint, graphVerdictReport, graphVerdictRows, graphVerdictsRunnable, runGraphVerdicts, type GraphEvidenceContent, type GraphJudge, type GraphJudgeFactory, type GraphVerdictBudgets, type GraphVerdictMetrics, type GraphVerdictReport, type GraphVerdictRow } from './graph-verdicts.js';

/** The wiki's address of a document, at a section when one is named: the client opens it as it opens any in-wiki link. */
const documentAddress = (repo: string | null, path: string, anchor?: string): string => {
  const query = new URLSearchParams();
  if (repo !== null) query.set('repo', repo);
  query.set('path', path);
  return `/k/doc?${query.toString()}${anchor === undefined || anchor === '' ? '' : `#${encodeURIComponent(anchor)}`}`;
};
import { archifyFrame, likec4Model } from './view-frames.js';
import { buildViews, chosenRenderer, parseSpec, payloadOf, RENDERERS_OF, ViewRefusal, type GraphView, type ViewPayload } from './views.js';
import { buildStatement, type StatementResult } from './statement.js';
import { noEntityMessage, Resolver, type Resolution } from './resolve.js';
import { readDocEntities, type DocEntity, type DocumentSource } from './doc-entities.js';
import { IDENTITIES_FILE, readDocIdentities, sameDocIdentities, writeDocIdentities } from './doc-identities.js';
import { CLASSIFICATIONS_FILE, readClassificationStore, storedClassifier } from './semantics.js';
import { DOCUMENT_LIMIT, DOCUMENT_PATH, HARNESS_FILES, documentTitle, docsLinkedOutside, listedDocument, productDocumentPaths, readProductDocument, readRepoDocuments, repoDocumentPaths } from './doc-sources.js';
import { ensureLoopKinds, seedStarterSet, TEMPLATES } from './seed.js';
import { CORRECTIONS_FOLDER, QUESTIONS_FOLDER, readCorrections } from '../loop/entities.js';
import { answerQuestion, commitFiles, localIdentity, LoopRefusal, recordCorrection, type Answered, type Corrected } from '../loop/answer.js';
import { readScope, readTasks, renderTask, scopeWords, TASKS_FOLDER, taskSlug, writeTask, type PlaceView, type PlannedTask, type TaskScope } from '../loop/tasks.js';
import { impactOf, type TaskImpact } from '../loop/impact.js';
import { impactGroundsOf } from '../loop/planned.js';
import { closingCommit, defaultBranch, type RepositoryRef } from '../loop/closure.js';
import { groundsOfScope, NO_MARKS, markForEntity, marksForDocument, marksForPage, plannedMarks, type PlannedMarks } from '../loop/planned.js';
import { proposeTask, type TaskChoice, type TaskProposal } from '../loop/propose.js';
import { readKnowledgePages } from './index/index.js';
import { rendersInProcess, warmRenderWorker } from './liquid.js';
import { planRefresh, type RefreshPlan } from '../loop/plan.js';
import { listQuestions, listTasks, openTasks, questionDetail, taskDetail, type ProblemListing, type QuestionDetail, type QuestionListing, type TaskDetail, type TaskListing, type TaskRow } from '../loop/views.js';
import { collectProblems, openProblemsOf } from '../problems/index.js';
import { defaultSettings } from '../problems/types.js';
import { WikiReadError } from './read-error.js';
import { productStoreFolder, storeDatabasePath, storeSnapshotsFolder } from '../product/store.js';
import { readProblemDismissals, writeProblemDismissal } from '../loop/problem-files.js';

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

/** How long the server keeps the previous snapshot open after a newer one is read, so a request in flight on it ends. */
const SNAPSHOT_KEEP_MS = 3_000;
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
  /** Host authority shared with the guide writer; never derived from guide front matter. */
  guideContextFor?: GuideContextFor;
  guideHostFor?: GuideHostFor;
  /** Where the knowledge wiki says what it could not do; the host's error log. */
  errorLog?: (line: string) => void;
  /** The least time between two snapshots of the store the fill writes, in milliseconds (default 8000). */
  snapshotMs?: number;
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

/** Runs git in a code repository for one blob; the file is `undefined` when git has none there. */
async function gitBlob(repository: string, commit: string, path: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['cat-file', 'blob', `${commit}:${path}`], { cwd: repository, maxBuffer: 1 << 26, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    return stdout;
  } catch {
    return undefined;
  }
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

/** Shares history reads only after the last temporal change in an immutable reader snapshot. */
export function createSnapshotHistoryReader() {
  type HistoryData = {
    evidence: Awaited<ReturnType<GraphReader['historyEvidence']>>;
    completed: Awaited<ReturnType<GraphReader['completedTrees']>>;
    landmarks: Awaited<ReturnType<GraphReader['landmarkPlan']>>;
  };
  type Entry = { boundary: Promise<number | null>; data?: Promise<HistoryData> };
  const snapshots = new WeakMap<DatabaseOwner, Map<string, Entry>>();
  return async (owner: DatabaseOwner, pin: Pick<RepositoryPin, 'name' | 'head'> & { readonly scope: string }, validAt: string, selection: HistorySelection): Promise<HistoryContext> => {
    // Pin fields belong to this owner; never reread mutable caller state after an await.
    const { name, scope, head } = pin;
    const capturedMillis = Date.parse(validAt);
    let entries = snapshots.get(owner);
    if (entries === undefined) { entries = new Map(); snapshots.set(owner, entries); }
    const key = JSON.stringify([name, scope, head]);
    let entry = entries.get(key);
    if (entry === undefined) {
      const held: Entry = { boundary: owner.transaction('snapshot', async (tx) => {
        // All current node/edge versions are a conservative superset of history's inputs.
        // Round UP: an ISO millisecond must not cross a submillisecond boundary early.
        const result = await tx.query<{ boundary_epoch_millis: string | null }>(`
          SELECT ceil(extract(epoch FROM max(boundary)) * 1000)::text AS boundary_epoch_millis
          FROM (
            SELECT valid_from, valid_to FROM node_version WHERE scope_id = $1::bigint AND recorded_to = 'infinity'
            UNION ALL
            SELECT valid_from, valid_to FROM edge_version WHERE scope_id = $1::bigint AND recorded_to = 'infinity'
          ) versions CROSS JOIN LATERAL (VALUES (valid_from), (valid_to)) bounds(boundary)
          WHERE isfinite(boundary)`, [scope]);
        const boundary = result.rows[0]?.boundary_epoch_millis;
        // An absent/malformed result cannot certify the terminal interval.
        return boundary === null ? null : typeof boundary === 'string' && /^-?\d+$/.test(boundary) && Number.isSafeInteger(Number(boundary)) ? Number(boundary) : Infinity;
      }) };
      entry = held;
      entries.set(key, held);
      void held.boundary.catch(() => { if (entries.get(key) === held) entries.delete(key); });
    }
    const boundary = await entry.boundary;
    const terminal = Number.isFinite(capturedMillis) && (boundary === null || capturedMillis >= boundary);
    const load = async (): Promise<HistoryData> => {
      // Every statement uses this call's captured time, never a moving wall clock.
      const graph = new GraphReader(owner, () => validAt);
      const evidence = await graph.historyEvidence(scope);
      const completed = await graph.completedTrees(scope, treeReadProducer(TREE_EXTRACTORS, HISTORY_EXTRACTOR));
      const landmarks = await graph.landmarkPlan(name, scope, head);
      return { evidence, completed, landmarks };
    };
    let pending: Promise<HistoryData>;
    if (!terminal) pending = load();
    else {
      pending = entry.data ??= load();
      const held = entry;
      void pending.catch(() => { if (held.data === pending) delete held.data; });
    }
    const { evidence, completed, landmarks } = await pending;
    // Selection is never cached. A caller cannot mutate the retained landmark proof.
    return selectHistory(selection, evidence, completed, landmarks === undefined ? undefined : structuredClone(landmarks));
  };
}

/**
 * The writer's units as a reader knows them (madarch-m38l.23): the page each one writes, and that page's kind and title as
 * the wiki knows them now — from the documents and the Markdown for a page that stands, from the product page's own
 * declaration for a domain still waiting. Nothing is invented: a unit whose page neither stands nor is declared keeps only
 * what the run said about it, and no field is filled from the unit's id.
 */
function namedUnits(ctx: RenderContext, units: readonly WriterUnit[]): WriterUnit[] {
  // The writer's enrichment units name a passage of a person's document: `enrichment:<document entity id>` (`enrichmentPath`).
  const ENRICHMENT_UNIT = 'enrichment:';
  return units.map((unit) => {
    const localized = unit.unit.startsWith(LOCALIZED_SOURCE_UNIT) ? unit.unit.slice(LOCALIZED_SOURCE_UNIT.length) : undefined;
    // A localized source writes a document's page: its kind and title are the document entity's own.
    const doc = localized === undefined ? undefined : ctx.docEntities.get(localized);
    const page = ctx.markdown.get(localized ?? unit.unit);
    // An enrichment's page is a passage of a document, and the passage is read before its page stands: the reader's
    // title for a page the run is writing now is the passage's own, never the writer's id for it.
    const passage = page === undefined && unit.unit.startsWith(ENRICHMENT_UNIT) ? ctx.docEntities.get(unit.unit.slice(ENRICHMENT_UNIT.length)) : undefined;
    const family = unit.unit.slice(0, unit.unit.indexOf(':'));
    // The unit's own id names the page kind it writes (`product`, `domain`, `administrator-guide`, `enrichment`): a name
    // only where the manifest declares that kind, so the reader never reads a kind this product does not have.
    const declared = unit.kind ?? family;
    const kind = doc?.kind ?? page?.kind ?? (ctx.manifest.kinds.has(declared) ? declared : undefined);
    const title = doc?.title ?? passage?.title ?? page?.title ?? unit.title;
    return { ...unit, page: localized ?? unit.unit, ...(kind === undefined ? {} : { kind }), ...(title === undefined ? {} : { title }) };
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

/** One read of the status and the render context its writer units were named against. */
type StatusRead = { body: WikiStatus; ctx: RenderContext | undefined };

export class KnowledgeProduct {
  /** The store the reads are made on: a snapshot of the primary store, or an empty one before any fill (see `fill-protocol.ts`). */
  private reader: { owner: DatabaseOwner; seq: number; path: string } | undefined;
  private opening: Promise<void> | undefined;
  private fill: FillState = { state: 'idle' };
  private running: Promise<void> | undefined;
  /** The fill the store is running now, as its host controls it; undefined between runs. */
  private fillRun: KnowledgeFillRun | undefined;
  /** The run id of the fill under way: the trace it writes is read by that id, never as "the newest file". */
  private fillRunId: string | undefined;
  /** What the last finished run's trace and the store's counts say: the end state's numbers. */
  private fillExtras: { counts?: FillState['counts']; run?: FillRunView; error?: FillErrorView } = {};
  private stopping = false;
  /** A person asked for a pause: the worker finishes the page and the commit in progress and ends before the next one. */
  private pauseAsked = false;
  /** A person asked for a stop: the run ends now, and the page in progress stays as it was before the run. */
  private stopAsked = false;
  /** The pause kept beside the store was read into this product's state; one read is enough for the life of the process. */
  private pauseRestored = false;
  /** What the run now under way was asked to do, and what a pause of it must keep for resume. */
  private currentRun: PausedRun | undefined;
  /** The paused run a next fill takes up, if this product has one. */
  private pausedRun: PausedRun | undefined;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly pins = new Map<string, RepositoryPin>();
  private identity: ProductIdentity | undefined;
  private revision = 0;
  private writer: WriterState = { state: 'idle', agent: null, units: [] };
  private writerAgent: { close(): Promise<void> } | undefined;
  /** The Problems page's open count, read once per revision and repository head (the navigation polls the status). */
  private problemCount: { key: string; open: number } | undefined;
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
  /** The document entities of the last completed run, by durable page id, as kept beside the store. */
  private documentBaselineMemo: Map<string, string> | undefined | null;

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
    this.identity = read.product;
    return read.product;
  }

  private storeFolder(): string {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    return productStoreFolder(this.options.productFolder, this.options.storeRoot);
  }

  /** The primary store: the fill worker's alone while it runs. */
  private graphPath(): string {
    return storeDatabasePath(this.storeFolder());
  }

  /** The folder the snapshots of the primary store are made in, one numbered folder each. */
  private readRoot(): string {
    return storeSnapshotsFolder(this.storeFolder());
  }

  /**
   * Opens the reader once. The newest snapshot is read as it is; with none, a store written by an earlier madarch (no
   * worker holds it) is copied, and with no store at all an empty one with the graph's tables is made, so a product
   * before its first fill reads as empty rather than failing.
   */
  private async open(): Promise<DatabaseOwner> {
    if (this.closed) throw new Error('the wiki is shutting down');
    this.lastUse = Date.now();
    this.idleTimer ??= setInterval(() => { void this.closeIfIdle(); }, 60_000).unref();
    this.opening ??= (async () => {
      const root = this.readRoot();
      mkdirSync(root, { recursive: true });
      let seq = snapshotNumbers(root).pop();
      let created = false;
      if (seq === undefined) {
        seq = 0;
        created = !existsSync(this.graphPath());
      }
      // The reader reads the store the fill writes, never a copy of it: its own repeatable-read transaction, begun in
      // a process of its own (so opening the store never holds up this server's thread), is the snapshot it answers from.
      const path = this.storeFolder();
      const owner = new RemoteOwner(path, { create: created });
      try {
        await owner.ready;
        // This newly opened snapshot owns a complete pin set even when an idle reader retained old pins.
        await this.loadPins(owner);
      } catch (error) {
        // A reader that failed to open is given back: a retry must not leave one worker process behind per request.
        await owner.close().catch(() => undefined);
        throw error;
      }
      this.reader = { owner, seq, path };
    })();
    try {
      await this.opening;
    } catch (error) {
      this.opening = undefined;
      throw error;
    }
    return this.reader!.owner;
  }

  /** Whether the starter set was checked for this product by this server (once: the files move on only with madarch). */
  private upgraded = false;
  /** What the check found: the files it brought up to date and what an edited manifest lacks. */
  private upgradeReport: UpgradeReport | undefined;

  /** Where this machine records what madarch wrote into the product's manifest and templates. */
  private starterRecord(): string {
    return join(dirname(this.choiceFile()), 'starter.json');
  }

  /**
   * Brings the manifest and the templates madarch alone wrote to the current starter set (madarch-m38l.11). A file a
   * person edited is never touched: what the set holds and it lacks is offered on the Problems page. A failure is
   * logged with its path and leaves the product as it was.
   */
  private upgrade(folder: string): void {
    this.upgraded = true;
    try {
      this.upgradeReport = upgradeStarterSet(folder, this.starterRecord());
      const changed = [...this.upgradeReport.rewritten, ...this.upgradeReport.written];
      if (changed.length > 0) {
        this.options.errorLog?.(`the knowledge wiki brought ${folder} to the current starter set: ${changed.join(', ')}`);
        this.notify();
      }
    } catch (error) {
      this.options.errorLog?.(error instanceof Error ? error.message : String(error));
    }
  }

  /** What the current starter set holds that this product's edited manifest lacks, each with the Problems page's «Add». */
  starterOffers(): StarterOffer[] {
    const product = this.product();
    if ('message' in product) return [];
    // Judging a manifest runs git; it is judged again only when the file changed.
    let stamp: string;
    try {
      const stat = statSync(join(product.folder, KINDS_FILE));
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return [];
    }
    if (this.offered?.stamp === stamp) return this.offered.offers;
    try {
      const offers = currentOffers(product.folder, this.starterRecord());
      this.offered = { stamp, offers };
      return offers;
    } catch {
      return [];
    }
  }

  private offered: { stamp: string; offers: StarterOffer[] } | undefined;

  /** Adds items of the starter set to the product's manifest (and the templates they need), on the reader's press. */
  addStarter(ids: readonly string[]): { ok: true; written: string[] } | { ok: false; message: string } {
    const product = this.product();
    if ('message' in product) return { ok: false, message: product.message };
    const offered = new Set(this.starterOffers().map((offer) => offer.id));
    const unknown = ids.filter((id) => !offered.has(id));
    if (unknown.length > 0) return { ok: false, message: `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not offered by the starter set for this product now (${[...offered].join(', ') || 'nothing is offered'}): read the Problems page again` };
    try {
      const written = addStarterItems(product.folder, ids, this.starterRecord());
      this.notify();
      return { ok: true, written };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The starter set written into this product by this server, for the page to say so once. */
  private seeded: string[] = [];
  /** Why the starter set could not be written, when it could not. */
  private seedError: string | undefined;

  /**
   * The product's kinds manifest. A product without one is given the starter set (`madarch new` and `madarch init` seed
   * the same files): the wiki has one app, and an empty folder opens on the pages the starter templates draw.
   */
  private kinds(folder: string): ReturnType<typeof readKinds> {
    // A product made by an earlier madarch is brought to the current starter set once, before its manifest is read.
    if (!this.upgraded && existsSync(join(folder, KINDS_FILE))) this.upgrade(folder);
    const read = readKinds(folder);
    if (read.present) return read;
    try {
      const written = seedStarterSet(folder);
      this.seeded = [...this.seeded, ...written];
      if (written.length > 0) this.options.errorLog?.(`the knowledge wiki gave ${folder} its starter set: ${written.join(', ')}`);
    } catch (error) {
      this.seedError = error instanceof Error ? error.message : String(error);
      this.options.errorLog?.(this.seedError);
      return read;
    }
    return readKinds(folder);
  }

  /**
   * The roles this product's manifest declares, in its order (decision 0031, "the roles are the product's"): the
   * reader's settings accept these and "everything" alone, and the engine keeps no role of its own.
   */
  declaredRoles(): string[] {
    const product = this.product();
    if ('message' in product) return [];
    const read = this.kinds(product.folder);
    return read.present ? [...read.manifest.roles.keys()] : [];
  }

  /** Starts the reader in the background, so the first page a person opens does not wait for it to start. */
  warm(): void {
    if (this.closed || this.opening !== undefined) return;
    const product = this.product();
    if ('message' in product || !this.kinds(product.folder).present) return;
    // A page whose templates a person wrote or edited is drawn in a worker of the product's own (madarch-u3vw.1): started
    // here, so the first page a reader opens does not pay the process's start. A product of the starter set's own
    // templates is drawn by the server itself, and starts no process at all.
    if (!rendersInProcess(product.folder)) warmRenderWorker(product.folder);
    this.open().catch(() => undefined);
  }

  /** Gives back the reader of a product nobody is reading, unless a fill is under way. */
  private async closeIfIdle(): Promise<void> {
    if (this.closed || this.running !== undefined || this.reader === undefined || Date.now() - this.lastUse < READER_IDLE_MS) return;
    const held = this.reader;
    await this.swapping.catch(() => undefined);
    if (this.reader !== held) return;
    this.reader = undefined;
    this.opening = undefined;
    await held.owner.close().catch(() => undefined);
  }

  private async loadPins(owner: DatabaseOwner): Promise<void> {
    const next = await owner.transaction('snapshot', async (tx) => {
      const rows = await tx.query<Record<string, unknown>>('SELECT repo, scope, head, commit_hash, effective_time, commits, filled_commits FROM knowledge_fill');
      return rows.rows.map((row):RepositoryPin=>({name:String(row['repo']),scope:row['scope']===null?null:String(row['scope']),head:String(row['head']),commit:String(row['commit_hash']),effectiveTime:String(row['effective_time']),commits:Number(row['commits']),filledCommits:Number(row['filled_commits'])}));
    });
    this.replacePins(next);
  }

  private replacePins(pins:readonly RepositoryPin[]):void {
    this.pins.clear();
    for(const pin of pins) this.pins.set(pin.name,pin);
  }

  /**
   * Reads a newer snapshot: opens it beside the one in use, switches the reads to it and, after the requests in flight
   * have ended, closes and removes the old one. A request is never held up by this: the open runs while the old
   * snapshot answers.
   */
  private swapReader(seq: number, pins: readonly RepositoryPin[] | undefined): Promise<void> {
    const work = this.swapping.then(async () => {
      if (this.closed) return;
      await this.open();
      const held = this.reader!;
      // A delayed or already-consumed notice cannot change the active snapshot's pins.
      if (held.seq >= seq) return;
      // The store a reader reads never moves: a newer generation is a reader opened at a newer moment on the same store.
      const path = held.path;
      const owner = new RemoteOwner(path, { create: false });
      try {
        await owner.ready;
        // The new process answers its first statements slowly; warm before changing either reader or pins.
        if (held.owner instanceof RemoteOwner) await owner.warm(held.owner.recent());
      } catch(error) {await owner.close().catch(()=>undefined);throw error;}
      this.reader = { owner, seq, path };
      // What the repositories were filled to is applied with the snapshot it belongs to: a source is read at the commit
      // the graph it is shown beside was filled from. A caller that names no pins takes the snapshot's own
      // (`knowledge_fill`, which the fill wrote before the snapshot was made).
      if (pins === undefined) await this.loadPins(owner);
      else this.replacePins(pins);
      setTimeout(() => {
        void held.owner.close().catch(() => undefined).finally(() => rmSync(held.path, { recursive: true, force: true }));
      }, SNAPSHOT_KEEP_MS).unref();
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
    const paused = await this.fillRun?.control('pause');
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
      this.pauseAsked = false;
      this.fill = { ...this.fill, state: 'stopped', ...(this.fill.finishedAt === undefined ? { finishedAt: at } : {}) };
      this.writer = { ...this.writer, state: 'stopped', current: undefined, ...(this.writer.finishedAt === undefined ? { finishedAt: at } : {}) };
      this.pausedRun = undefined;
      this.currentRun = undefined;
      this.clearPause();
      this.notify();
      return { ok: true, fill: this.fill, writer: this.writer };
    }
    this.stopAsked = true;
    // Stop overrides Pause everywhere: a pause pressed before this confirmation is not replayed and leaves nothing to resume.
    this.pauseAsked = false;
    this.pausedRun = undefined;
    const stopped = await this.fillRun?.control('stop');
    if (stopped === undefined || !stopped.ok) return { ok: false, status: 409, message: stopped?.message ?? 'no fill of this product is running: there is nothing to stop' };
    this.notify();
    return { ok: true, fill: this.fill, writer: this.writer };
  }

  /** The file a paused run is kept in, beside the store whose pages it was writing. */
  private pauseFile(): string {
    return join(this.storeFolder(), 'pause.json');
  }

  /** What a run under way would need from a pause taken now: its language, its plan, and the pages it has published. */
  private pauseSnapshot(): PausedRun | undefined {
    const run = this.currentRun;
    if (run === undefined) return undefined;
    const plan = this.writer.plan ?? run.plan;
    return {
      ...run,
      ...(plan === undefined ? {} : { plan }),
      completedPages: [...new Set(this.writer.units.filter((unit) => unit.state === 'written').map((unit) => unit.path))],
    };
  }

  /** Keeps the paused run beside the store, so a server that starts again shows the same run. A failure is logged. */
  private async recordPause(): Promise<void> {
    // A stop is terminal: it never leaves a resumable run behind, whatever pause was pressed before it.
    if (this.stopAsked) return;
    this.pausedRun = this.pauseSnapshot();
    try {
      await mkdir(dirname(this.pauseFile()), { recursive: true });
      await writeFile(this.pauseFile(), `${JSON.stringify({ fill: this.fill, writer: this.writer, ...(this.pausedRun === undefined ? {} : { run: this.pausedRun }) }, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.options.errorLog?.(`the knowledge wiki could not keep the pause of ${this.storeFolder()}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  async startFill(options: { expectAgent?: string | null; language?: string; task?: string; taskPages?: readonly string[] } = {}): Promise<{ started: true; fill: FillState } | { started: false; message: string; fill: FillState }> {
    if (this.running !== undefined) {
      const busy = this.fill.state === 'running' || this.writer.state === 'running' || this.writer.state === 'waiting';
      if (busy) return { started: false, message: 'a fill of this product is already running', fill: this.fill };
      // The fill and the agent stage are over; the worker is closing its store and ending. A press now waits for that.
      await Promise.race([this.running, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
      if (this.running !== undefined) return { started: false, message: 'the previous fill of this product is still closing its store; press again in a moment', fill: this.fill };
    }
    const product = this.product();
    if ('message' in product) return { started: false, message: product.message, fill: this.fill };
    const read = this.kinds(product.folder);
    if (!read.present) return { started: false, message: `the product has no ${read.file}: the wiki shows the kinds that file declares`, fill: this.fill };
    const repositories = this.repositories();
    if (repositories.length === 0) {
      return { started: false, message: 'the product declares no code repository: connect one with "madarch repo add <name> <url>", then start the fill', fill: this.fill };
    }
    const missing = repositories.filter((repo) => !repo.present);
    if (missing.length > 0) {
      return { started: false, message: `the repositories ${missing.map((repo) => repo.name).join(', ')} are not checked out under repos/: run "madarch bootstrap" first`, fill: this.fill };
    }
    if (this.closed) return { started: false, message: 'the wiki is shutting down', fill: this.fill };
    // A product made before the loop of questions and corrections gets its two kinds and their templates now.
    try {
      if (ensureLoopKinds(product.folder).length > 0) this.notify();
    } catch (error) {
      return { started: false, message: error instanceof Error ? error.message : String(error), fill: this.fill };
    }
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
    const written = this.pagesLanguage();
    const languageChanged = resuming ? paused.languageChanged : written !== undefined ? written !== wanted : options.language !== undefined && options.language !== current;
    if (!resuming && options.language !== undefined && options.language !== read.manifest.language) {
      const set = setKindsLanguage(product.folder, options.language);
      if (set !== undefined) return { started: false, message: set, fill: this.fill };
      this.notify();
    }
    // The per-page editorial bound is a product setting (madarch-ztyq.9, review 199): read and validated before
    // the fill claims its slot, and carried to the worker so the writer enforces the same number the page shows.
    let editorialRequestsPerPage: number;
    try {
      editorialRequestsPerPage = this.editorialRequestsPerPage();
    } catch (error) {
      return { started: false, message: error instanceof Error ? error.message : String(error), fill: this.fill };
    }
    // The slot is claimed before anything is awaited, so two asks in the store's opening are not two fills.
    this.stopping = false;
    this.pauseAsked = false;
    this.stopAsked = false;
    // A resumed run takes the pause off the store: what stands there now is the run that starts, not the one it ended.
    this.clearPause();
    const asked = resuming ? paused : undefined;
    // A run limited to a task keeps the task it was pressed for; a resumed task carries the one it paused on.
    const task = asked?.task ?? options.task;
    const taskPages = asked?.taskPages ?? options.taskPages;
    const resume = asked?.plan === undefined ? undefined : { plan: asked.plan, completedPages: [...asked.completedPages] };
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
    this.currentRun = {
      language: wanted,
      languageChanged,
      languageFrom: resuming ? paused.languageFrom : written ?? current,
      ...(task === undefined ? {} : { task }),
      ...(taskPages === undefined ? {} : { taskPages }),
      ...(resume === undefined ? {} : { plan: resume.plan }),
      completedPages: resume?.completedPages ?? [],
      ...(resuming ? { resumed: true } : {}),
    };
    this.pausedRun = undefined;
    this.notify();
    this.running = this.runOrchestratedFill(product, repositories).finally(() => {
      // The mark goes only when the run is over, after its result is recorded: a restart before this point has no list.
      this.clearActiveFill();
      this.running = undefined;
      this.fillRun = undefined;
    });
    return { started: true, fill: this.fill };
  }

  /**
   * One fill of the product's knowledge store, through the one orchestrator (decision 0033, item 1): the static
   * stages the product's workflow names are driven into `<store>/graph`, a snapshot is made for the reader, and the
   * pages read the graph this path published. It runs no model and writes no page: a page is an agent's work and a
   * later stage's, and nothing of the old loop is carried over.
   */
  private async runOrchestratedFill(product: ProductIdentity, repositories: readonly { readonly name: string; readonly path: string }[]): Promise<void> {
    void repositories;
    const startedAt = (this.options.now?.() ?? new Date()).toISOString();
    const runId = `fill-${startedAt.replace(/[-:.]/gu, '').replace(/Z$/u, 'Z')}`;
    const storeFolder = this.storeFolder();
    // The trace this run writes is read by its id: a second trace in the store (a server's tool
    // calls) is never taken for the fill's progress.
    this.fillRunId = runId;
    // The fill runs in a process of its own (`madarch knowledge-fill-worker`; madarch-m38l.4, decision 0033 item 27):
    // it reads git and parses on its own cores, and a store opened inside this process held every page of the wiki for
    // 2.4-2.9 s while a first fill opened its database (the pages test/knowledge-responsive.test.ts measured in CI). The
    // generation each publication announces is handed to the reader here, so a page follows the fill as it reads rather
    // than waiting for its end.
    let run: KnowledgeFillRun & { close(): Promise<void> };
    try {
      run = startFillInWorker({ productFolder: product.folder, storeFolder, runId, ...(this.options.snapshotMs === undefined ? {} : { snapshotMs: this.options.snapshotMs }) }, (snapshot) => {
        void this.swapReader(snapshot, undefined).catch((error: unknown) => {
          this.options.errorLog?.(`the knowledge wiki could not read the snapshot ${snapshot} of ${this.readRoot()}: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
    } catch (error) {
      // The program that runs the fill's worker could not be started: no store was opened and nothing was read.
      this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message: error instanceof Error ? error.message : String(error), code: 'store' };
      this.notify();
      return;
    }
    this.fillRun = run;
    let result: KnowledgeFillResult;
    try {
      result = await run.done;
    } catch (error) {
      // The worker could not open the store (or ended without an answer): the run failed at its store, and the answer
      // names the worker and the lines it left on its own error stream.
      this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message: error instanceof Error ? error.message : String(error), code: 'store' };
      this.notify();
      await run.close();
      return;
    }
    await run.close();
    if (!result.ok) {
      this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), ...(result.message === undefined ? {} : { message: result.message }), code: 'fill' };
      this.notify();
      return;
    }
    if (result.snapshot !== undefined) {
      // The snapshot carries the store's own pins (the `knowledge_fill` rows the run wrote), so the reader reads the
      // commits its graph was filled from beside the graph itself.
      await this.swapReader(result.snapshot, undefined).catch((error: unknown) => {
        this.options.errorLog?.(`the knowledge wiki could not read the snapshot ${result.snapshot} of ${this.readRoot()}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    // A run that ended says which pages it changed: this fill writes no page (a page is an agent's
    // work, and no agent stage runs in this step), so the answer is the empty list unless the store
    // kept a record of pages the run changed — never an absent field a reader would take for "unknown".
    this.changedLoaded = false;
    // A writer that waited for units the run never planned has nothing to wait for: the run ended.
    if (this.writer.state === 'waiting' && this.writer.units.length === 0) this.writer = { ...this.writer, state: 'idle' };
    this.fill = {
      state: 'done', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), gaps: 0,
      changed: this.lastChangedPages() ?? [],
      ...(result.unread === undefined || result.unread.length === 0 ? {} : { unread: [...result.unread] }),
    };
    this.notify();
    this.lastUse = Date.now();
    // The rules and the judge read the snapshot as soon as the fill ends (madarch-mwhd.1 finding 6): a reader who
    // opens the settings page afterwards sees what was decided, not a page that has to start the work itself.
    void this.graphVerdicts({ force: true }).catch((error: unknown) => {
      this.options.errorLog?.(`the knowledge wiki could not validate the graph after the fill: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // ---- what a run changed -------------------------------------------------------------------

  /** The file marking a run between its start and the end of its run job. */
  private activeFillFile(): string {
    return join(this.storeFolder(), ACTIVE_FILL_FILE);
  }

  /** The file the changed pages of the last completed run are kept in. */
  private changedPagesFile(): string {
    return join(this.storeFolder(), CHANGED_PAGES_FILE);
  }

  /** The file the document entities of the last completed run are kept in: the line their next run is counted from. */
  private documentPagesFile(): string {
    return join(this.storeFolder(), DOCUMENT_PAGES_FILE);
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

  /** When the graph last published a work item, as the reader holds it: the line a run's changes are counted from. */
  private async lastPublishedAt(): Promise<string | null> {
    const owner = await this.open();
    const rows = (await owner.run((tx) => tx.query<{ at: string | null }>(`SELECT max(published_at)::text AS at FROM work_item WHERE published_at IS NOT NULL`))).rows;
    return rows[0]?.['at'] ?? null;
  }

  /**
   * The pages a run changed, from the graph's own account of it: every node and every edge the run opened or closed, the
   * pages of the entities that are still there, the page a touched statement belongs to through `statement-of`, the
   * Markdown pages whose file it wrote, and the document entities whose passage changed. A run that starts from an
   * empty graph (`before` null) wrote every page; after it, only what it touched is named. A page the run removed is not
   * named: there is no page left to open. Only the kinds the product declares are pages; the index's own nodes and
   * sections are not.
   */
  private async pagesChangedSince(before: string | null): Promise<{ pages: ChangedPage[]; documents: Map<string, string> }> {
    const context = await this.context();
    if ('absent' in context) throw new WikiReadError(`the product has no ${context.file}: the wiki shows the kinds that file declares`);
    const owner = await this.open();
    // The version a page shows is the one valid now: a node recorded last, whose time ended, is not a page any more.
    const at = this.validAt();
    const visible = `v.valid_from <= $3::timestamptz AND $3::timestamptz < v.valid_to`;
    const visibleEdge = `e.valid_from <= $3::timestamptz AND $3::timestamptz < e.valid_to`;
    const rows = (await owner.run((tx) => tx.query<{ id: string | null; title: string | null; kind: string; page: boolean; properties: Record<string, unknown> | null }>(
      `WITH published AS (
         SELECT id FROM work_item WHERE published_at IS NOT NULL AND ($1::timestamptz IS NULL OR published_at > $1::timestamptz)
       ), touched AS (
         SELECT node_id FROM node_version WHERE opened_by IN (SELECT id FROM published) OR closed_by IN (SELECT id FROM published)
         UNION SELECT src_id FROM edge_version WHERE opened_by IN (SELECT id FROM published) OR closed_by IN (SELECT id FROM published)
         UNION SELECT dst_id FROM edge_version WHERE opened_by IN (SELECT id FROM published) OR closed_by IN (SELECT id FROM published)
       ), touched_pages AS (
         -- A statement's page is not touched when the statement's ground changes: the page is reached through statement-of.
         SELECT DISTINCT pv.properties->>'id' AS id
           FROM edge_version e
           JOIN relation_type ek ON ek.id = e.relation_type_id
           JOIN node_version sv ON sv.node_id = e.src_id AND sv.recorded_to = 'infinity' AND sv.valid_from <= $3::timestamptz AND $3::timestamptz < sv.valid_to
           JOIN node_version pv ON pv.node_id = e.dst_id AND pv.recorded_to = 'infinity' AND pv.valid_from <= $3::timestamptz AND $3::timestamptz < pv.valid_to
          WHERE ek.key = $4 AND e.recorded_to = 'infinity' AND ${visibleEdge}
            AND sv.node_id IN (SELECT node_id FROM touched)
       )
       SELECT v.properties->>'recordKey' AS id, v.label AS title, k.key AS kind, false AS page, v.properties AS properties
         FROM node_version v JOIN node_kind k ON k.id = v.kind_id
        WHERE v.recorded_to = 'infinity' AND v.properties ? 'recordKey' AND ${visible}
          AND ($1::timestamptz IS NULL OR v.node_id IN (SELECT node_id FROM touched))
       UNION ALL
       SELECT v.properties->>'id' AS id, v.label AS title, k.key AS kind, true AS page, v.properties AS properties
         FROM node_version v JOIN node_kind k ON k.id = v.kind_id AND k.key = $2
        WHERE v.recorded_to = 'infinity' AND v.properties ? 'id' AND ${visible}
          AND ($1::timestamptz IS NULL OR v.node_id IN (SELECT node_id FROM touched) OR v.properties->>'id' IN (SELECT id FROM touched_pages))`,
      [before, PAGE_KIND, at, STATEMENT_OF]))).rows;
    const found = new Map<string, ChangedPage>();
    for (const row of rows) {
      const id = row['id'];
      if (id === null) continue;
      if (row['page']) {
        const entity = context.ctx.markdown.get(id);
        if (entity === undefined) continue;
        const declaration = context.manifest.kinds.get(entity.kind);
        if (declaration === undefined) continue;
        if (!found.has(id)) found.set(id, { id, title: markdownTitleOf(declaration.title, entity) });
        continue;
      }
      const declaration = context.manifest.kinds.get(row['kind']);
      if (declaration === undefined) continue;
      const properties = row['properties'] ?? {};
      const title = graphTitleOf(declaration.title, { key: id, kind: row['kind'], label: row['title'] ?? id, properties });
      if (declaration.member !== undefined) {
        // A member has no page of its own: what changed is the page of the entity that holds it, at the member's
        // fragment. Naming the member's title would name a page a reader cannot open under that title.
        const entity = (await context.ctx.graph.find(id)).find((candidate) => candidate.kind === row['kind']);
        if (entity === undefined) continue;
        const parent = await memberParent(context.ctx, { source: 'graph', entity }, declaration.member);
        if (parent === undefined) continue;
        const parentDeclaration = context.manifest.kinds.get(parent.kind);
        if (parentDeclaration === undefined) continue;
        if (!found.has(parent.key)) found.set(parent.key, { id: parent.key, title: graphTitleOf(parentDeclaration.title, parent) });
        continue;
      }
      if (!found.has(id)) found.set(id, { id, title });
    }
    // A document entity is a page too, and its page id is its durable identity. The line is the last completed run's
    // entities: a passage whose text, title or address changed is named; a document that gained none is not.
    const documents = this.documentDigests(context);
    const baseline = this.documentBaseline();
    for (const [id, digest] of documents) {
      if (baseline !== undefined && baseline.get(id) === digest) continue;
      const entity = context.ctx.docEntities.get(id);
      if (entity === undefined) continue;
      const declaration = context.manifest.kinds.get(entity.kind);
      if (declaration === undefined) continue;
      if (!found.has(id)) found.set(id, { id, title: documentTitleOf(declaration.title, entity) });
    }
    return { pages: [...found.values()].sort((a, b) => byCodePoint(a.id, b.id)), documents };
  }

  /** The document entities a page stands for, by durable page id, digested as the page renders them. */
  private documentDigests(context: { manifest: KindsManifest; ctx: RenderContext }): Map<string, string> {
    const out = new Map<string, string>();
    for (const entity of context.ctx.docEntities.values()) {
      const declaration = context.manifest.kinds.get(entity.kind);
      if (declaration?.source !== 'document') continue;
      out.set(entity.id, canonicalJsonDigest({
        kind: entity.kind,
        title: entity.title,
        pageTitle: documentTitleOf(declaration.title, entity),
        identifier: entity.identifier,
        repo: entity.repo,
        path: entity.path,
        anchor: entity.anchor,
        aliases: entity.aliases,
        text: entity.text,
        language: context.ctx.language,
        localizedStatement: context.ctx.localizedSources.get(entity.id)?.statement ?? null,
        semantics: entity.semantics,
        pass: entity.pass,
        headingPath: entity.headingPath,
      }));
    }
    return out;
  }

  /** The document entities of the last completed run, or undefined when none is recorded. */
  private documentBaseline(): Map<string, string> | undefined {
    if (this.documentBaselineMemo !== undefined) return this.documentBaselineMemo ?? undefined;
    const baseline = readDocumentPages(this.storeFolder());
    this.documentBaselineMemo = baseline ?? null;
    return baseline;
  }

  /** Records what the run changed: in the fill's state, beside its store, and to the streams. */
  private async recordChangedPages(before: string | null | undefined): Promise<void> {
    // A run that did not finish changed nothing the wiki may claim; one whose boundary is unknown would be a guess.
    if (before === undefined || this.fill.state !== 'done' || this.writer.state === 'failed') return;
    let changed: ChangedPage[];
    let documents: Map<string, string>;
    try {
      const result = await this.pagesChangedSince(before);
      changed = result.pages;
      documents = result.documents;
    } catch (error) {
      this.options.errorLog?.(`the knowledge wiki could not list the pages the fill of ${this.storeFolder()} changed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.fill = { ...this.fill, changed };
    this.changedPages = changed;
    this.changedLoaded = true;
    try {
      await writeFile(this.changedPagesFile(), `${JSON.stringify({ startedAt: this.fill.startedAt ?? null, finishedAt: this.fill.finishedAt ?? null, pages: changed })}\n`, 'utf8');
    } catch (error) {
      this.options.errorLog?.(`the knowledge wiki could not record which pages the fill of ${this.storeFolder()} changed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await writeFile(this.documentPagesFile(), `${JSON.stringify({ startedAt: this.fill.startedAt ?? null, finishedAt: this.fill.finishedAt ?? null, entities: Object.fromEntries(documents) })}\n`, 'utf8');
      this.documentBaselineMemo = documents;
    } catch (error) {
      this.options.errorLog?.(`the knowledge wiki could not record the document entities of the fill of ${this.storeFolder()}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.notify();
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
    const owner = await this.open();
    const snapshot = await loadGraphSnapshot(owner);
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
      for (const repository of this.repositories()) {
        if (!repository.present) continue;
        const pin = this.pins.get(repository.name);
        if (pin === undefined || pin.commit === '') continue;
        const text = await gitBlob(join(this.options.productFolder, 'repos', repository.name), pin.commit, path);
        if (text === undefined) continue;
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
      if (!install) return { ok: false, status: 409, message: `the ${entry.label} adapter is not installed: say yes to install it into ${offer.install?.folder ?? 'madarch\'s agents folder'}` };
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
      if (!install) return { ok: false, status: 409, message: `the ${entry.label} adapter is not installed: say yes to install it into ${offer.install?.folder ?? 'madarch\'s agents folder'}` };
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
   * kept because a person wrote them, the graph store, and the starter files a person edited that «from scratch» replaces.
   */
  dangerPlan(): { rewrite: { agentPages: string[]; keptPages: string[] }; fresh: ResetPlan & { editedStarterFiles: string[]; replacedStarterFiles: string[] } } {
    const plan = this.resetPlan();
    const record = this.starterRecord();
    return {
      rewrite: { agentPages: plan.agentPages, keptPages: plan.keptPages },
      fresh: { ...plan, editedStarterFiles: filesAPersonEdited(this.options.productFolder, record), replacedStarterFiles: [KINDS_FILE, ...Object.keys(TEMPLATES).map((name) => `templates/${name}`)] },
    };
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
   * «Start from scratch»: the pages the agent wrote, the graph and the reader go, the manifest and the templates are put
   * at the current starter set, and a fresh fill starts. Everything is local to this machine and this checkout.
   */
  async startFresh(expected?: ResetPlan): Promise<{ ok: true; plan: ResetPlan; starter: string[]; fill: FillState; fillRefused?: string } | { ok: false; message: string }> {
    const done = await this.reset(expected);
    if (!done.ok) return done;
    const product = this.product();
    if ('message' in product) return { ok: false, message: product.message };
    let starter: string[];
    try {
      starter = replaceWithStarterSet(product.folder, this.starterRecord());
    } catch (error) {
      return { ok: false, message: `the pages and the graph were removed, but the manifest could not be put at the current starter set: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.upgraded = true;
    this.docMemo = undefined;
    this.repoDocs.clear();
    this.notify();
    const chosen = this.chosenAgent();
    const started = await this.startFill(chosen === null ? {} : { expectAgent: chosen.id });
    return started.started ? { ok: true, plan: done.plan, starter, fill: started.fill } : { ok: true, plan: done.plan, starter, fill: this.fill, fillRefused: started.message };
  }

  /**
   * What the product settings page shows: the agent and the model chosen for it, the page language, the writer's bounds,
   * where the product's files and its derived store are on this machine, and what the two local resets would do.
   */
  settingsView(): {
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
  } {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const read = readKinds(product.folder);
    let danger: ReturnType<KnowledgeProduct['dangerPlan']>;
    let dangerError: string | undefined;
    try {
      danger = this.dangerPlan();
    } catch (error) {
      dangerError = error instanceof Error ? error.message : String(error);
      danger = { rewrite: { agentPages: [], keptPages: [] }, fresh: { store: [], agentPages: [], keptPages: [], unansweredQuestions: [], keptAnswers: [], editedStarterFiles: [], replacedStarterFiles: [] } };
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
  setLanguage(language: string): { ok: true } | { ok: false; message: string } {
    const product = this.product();
    if ('message' in product) return { ok: false, message: product.message };
    if (!Object.keys(CONTENT_LANGUAGES).includes(language)) return { ok: false, message: `"language" is ${JSON.stringify(language)}: the pages are written in ${Object.keys(CONTENT_LANGUAGES).join(' or ')}` };
    // Pages written before the language of the pages was recorded are in the language the manifest names now: say so before
    // it changes, or the next refresh compares the new language with itself and rewrites nothing.
    const read = readKinds(product.folder);
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
    const previousManifest = readFileSync(join(product.folder, KINDS_FILE), 'utf8');
    const failure = setKindsLanguage(product.folder, language);
    if (failure !== undefined) return { ok: false, message: failure };
    try {
      const manifest = readFileSync(join(product.folder, KINDS_FILE), 'utf8');
      rememberChangedStarterFileIfOwned(product.folder, this.starterRecord(), KINDS_FILE, previousManifest, manifest);
    } catch (error) {
      const file = join(product.folder, KINDS_FILE);
      try { writeFileSync(file, previousManifest, 'utf8'); }
      catch (restoreError) { return { ok: false, message: `${file}: the language changed but its madarch provenance could not be recorded (${(error as Error).message}) and the previous manifest could not be restored (${(restoreError as Error).message})` }; }
      return { ok: false, message: `${file}: the language was not changed because its madarch provenance could not be recorded: ${(error as Error).message}` };
    }
    this.notify();
    return { ok: true };
  }

  /** Resolves when the running fill has ended; for tests and for a clean stop. */
  async settled(): Promise<void> {
    await this.running;
  }

  // ---- reads -----------------------------------------------------------------------------

  /** The inputs of one page: the manifest and Markdown as they stand now, and the graph. */
  async context(history?: HistoryContext, snapshot?: PageSnapshot): Promise<{ ctx: RenderContext; manifest: KindsManifest; findings: Finding[] } | { absent: true; file: string }> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    // The manifest is parsed once per revision of its text and the template paths it names: every read asks for it, and a
    // manifest of many kinds is milliseconds of YAML (madarch-m38l.21). An edit still invalidates by content.
    const read = this.kindsForStamp(product.folder);
    if (!read.present) return { absent: true, file: read.file };
    const owner = snapshot?.owner ?? await this.open();
    const currentGraph = new GraphReader(owner, snapshot === undefined ? this.validAt : () => snapshot.validAt, undefined, snapshot?.transaction);
    const scope = history === undefined ? undefined : (snapshot?.pins ?? this.pins).get(history.repo)?.scope ?? undefined;
    const indexOwner = snapshot === undefined ? owner : pageSnapshotOwner(owner, snapshot.transaction);
    const pins = snapshot?.pins ?? this.pins;
    if (history !== undefined && (history.coverage !== 'covered' || history.effectiveAt === null || scope === undefined)) throw new WikiReadError(`${product.folder}/${KINDS_FILE}:1: historical structure is not covered for ${history.repo} at ${history.at}`);
    const graph = history === undefined ? currentGraph : currentGraph.at(history.effectiveAt!, scope!);
    // Guide payloads enter their strict host verifier, never the generic YAML materializer.
    const ordinaryKinds = new Map([...read.manifest.kinds].filter(([kind]) => !Object.hasOwn(GUIDE_OUTPUTS, kind)));
    const markdownRead = history === undefined ? readMarkdownEntities(product.folder, { ...read.manifest, kinds: ordinaryKinds }) : { entities: [], findings: [] };
    if (history === undefined) for (const [kind, output] of Object.entries(GUIDE_OUTPUTS)) {
      const declaration = read.manifest.kinds.get(kind);
      if (declaration?.source !== 'markdown' || declaration.file === undefined) continue;
      if (!existsSync(join(product.folder, declaration.file))) continue;
      const title = declaration.labels?.[read.manifest.language === 'ru' ? 'ru' : 'en']?.one ?? kind;
      markdownRead.entities.push({ id: output.id, kind, title, relates: [], producer: 'agent', sources: [], body: '', bodyLine: 1, file: declaration.file, front: {} });
    }
    const markdown = new Map<string, MarkdownEntity>(markdownRead.entities.map((entity) => [entity.id, entity]));
    const reading = history === undefined ? await this.documentEntities(product.folder, read.manifest) : { entities: [], sources: [], findings: [] };
    const docEntities = new Map<string, DocEntity>(reading.entities.map((entity) => [entity.id, entity]));
    const language = read.manifest.language ?? 'en';
    const localizedSources = new Map<string, LocalizedDocumentSource>();
    const localizedFindings: Finding[] = [];
    for (const entity of reading.entities) {
      const sourceLanguage = detectDocumentLanguage(entity.text);
      if (sourceLanguage === language) continue;
      const file = localizedSourcePath(entity);
      if (sourceLanguage === undefined) {
        localizedFindings.push({ file, line: entity.line, message: `the source language cannot be identified confidently as English or Russian; no localized statement is shown` });
        continue;
      }
      const text = readProductDocument(product.folder, file);
      if (text === undefined) {
        localizedFindings.push({ file, line: 1, message: `no localized source exists for ${entity.id}; fill the wiki in ${language} to write it`, pending: entity.id });
        continue;
      }
      const parsed = parseLocalizedSource(file, text, entity, language);
      if (!parsed.ok) {
        localizedFindings.push({ file, line: parsed.line, message: `${parsed.message}; no localized statement is shown` });
        continue;
      }
      if (parsed.source.sourceLanguage !== sourceLanguage) {
        localizedFindings.push({ file, line: 2, message: `source-language is ${parsed.source.sourceLanguage}, but the current document is detected as ${sourceLanguage}` });
        continue;
      }
      // A product with one code repository does not name it in the place of a localized statement either.
      const single = entity.repo !== null && this.repositories().length === 1;
      localizedSources.set(entity.id, single ? { ...parsed.source, sourceDocument: parsed.source.sourceDocument.replace(new RegExp(`^repos/${entity.repo?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), '') } : parsed.source);
    }
    const entityAtLine = new Map<string, DocEntity>(reading.entities.map((entity) => [`${entity.repo ?? ''}\0${entity.path}\0${entity.line}`, entity]));
    // A page id names a durable identity: the resolver finds the page by it, whatever heading the document writes now.
    const entityById = new Map<string, DocEntity>(reading.entities.map((entity) => [`${entity.repo ?? ''}\0${entity.path}\0${entity.stableId}`, entity]));
    // A source anchor names the passage the document gives that anchor now — and a passage of one paragraph has an anchor
    // of its own (`stories.1.2`), so two meanings of one paragraph never open one another's page (the review of C(b)).
    // Every anchor the tree derives is indexed, not only the primary one: a paragraph's place (`transport.1`) and a
    // heading's number both address the passage they name, and the first meaning of a split paragraph keeps them
    // (the review of the sixth pass, finding 1).
    const entityByAnchor = new Map<string, DocEntity>();
    for (const entity of reading.entities) for (const anchor of [entity.anchor, ...entity.aliases]) {
      const key = `${entity.repo ?? ''}\0${entity.path}\0${anchor}`;
      if (!entityByAnchor.has(key)) entityByAnchor.set(key, entity);
    }
    const repoOfScope = (scope: string): string | undefined => [...pins.values()].find((pin) => pin.scope !== null && pin.scope === scope)?.name;
    const readSource = async (repo: string | null, path: string): Promise<string | undefined> => {
      if (repo === null) {
        if (history !== undefined) return undefined;
        // The product repository's own files, not its git folder or a dotfile (`.env`, `.git/config`) a reader never meant to publish.
        if (!insideFolder(product.folder, path) || path.split('/').some((part) => part.startsWith('.')) || path.startsWith('repos/')) return undefined;
        try {
          // Through a link too: the real file must stand inside the product repository, and be a file of a size the view shows.
          const real = realpathSync(join(product.folder, path));
          if (!insideFolder(realpathSync(product.folder), relative(realpathSync(product.folder), real)) || !statSync(real).isFile() || statSync(real).size > 2 * 1024 * 1024) return undefined;
          return readFileSync(real, 'utf8');
        } catch {
          return undefined;
        }
      }
      if (history !== undefined && repo !== history.repo) return undefined;
      const pin = pins.get(repo);
      if (pin === undefined || pin.commit === '') return undefined;
      return await gitBlob(join(product.folder, 'repos', repo), history?.commit ?? pin.commit, path);
    };
    const webOf = (repo: string | null, path: string, lineStart: number, lineEnd: number): { host: string; url: string } | undefined => {
      if (repo === null) return undefined;
      const origin = this.originOf(join(product.folder, 'repos', repo));
      if (history !== undefined && repo !== history.repo) return undefined;
      const commit = history?.commit ?? pins.get(repo)?.commit;
      if (origin === undefined || commit === undefined || commit === '') return undefined;
      return webLink({ origin, commit, path, lineStart, lineEnd });
    };
    // The store's records answer the kind `code.file` (madarch-8bdc.2.5): the fill publishes the repository's paths in
    // the record tables, and a page of a past time is the temporal graph's alone, so a historical page is asked nothing
    // of them. The repository resolved is the one the wiki's repository pages show, the product's first declared one.
    const records = history === undefined ? this.recordFiles(indexOwner) : undefined;
    const resolver = new Resolver({
      graph,
      markdown,
      declared: (kind) => read.manifest.kinds.has(kind),
      readDocument: readSource,
      repositories: () => history === undefined ? [...pins.keys()].sort(byCodePoint) : [history.repo],
      locate: (entity) => (entity.span === undefined ? undefined : locationOf({ repoOfScope, webOf }, entity.scope, entity.span)),
      documentEntity: (repo, path, line) => entityAtLine.get(`${repo ?? ''}\0${path}\0${line}`),
      documentEntityByAnchor: (repo, path, anchor) => entityByAnchor.get(`${repo ?? ''}\0${path}\0${anchor}`),
      documentEntityById: (repo, path, stableId) => entityById.get(`${repo ?? ''}\0${path}\0${stableId}`),
    });
    // A page the running fill has taken up is not a problem yet (madarch-m38l.23): the agent is writing it now, and the
    // page says so in place of the missing statement until the run ends.
    const writing = this.writer.state === 'waiting' || this.writer.state === 'running';
    return {
      ctx: { productFolder: product.folder, manifest: read.manifest, graph, markdown, docEntities, localizedSources, language, documents: reading.sources, ...(writing ? { awaitsLocalized: true } : {}), repositories: history === undefined ? [...pins.keys()].sort(byCodePoint) : [history.repo], webOf, ...(records === undefined ? {} : { records }), ...(history === undefined ? { index: { relyingOn: (key: string) => statementsRelyingOn(indexOwner, key), counts: () => indexCounts(indexOwner) } } : {}), commitOf: (repo) => history === undefined ? pins.get(repo)?.commit ?? null : repo === history.repo ? history.commit : null, resolver, repoOfScope, readSource },
      manifest: read.manifest,
      findings: [...read.manifest.findings, ...markdownRead.findings, ...reading.findings, ...(writing ? localizedFindings.filter((finding) => finding.pending === undefined) : localizedFindings)],
    };
  }

  /** The planned-change marks, read once per revision and per head of the product's repositories: a commit makes them read again. */
  private marksMemo: { key: string; marks: PlannedMarks } | undefined;

  /** What the planned-change marks depend on besides the wiki's revision: the tasks folder and every repository's head. */
  private marksKey(): string {
    const parts: string[] = [String(this.revision)];
    try { parts.push(String(statSync(join(this.options.productFolder, TASKS_FOLDER)).mtimeMs)); } catch { parts.push('-'); }
    // A head is a ref, and a ref is a file: the key reads it from the checkout's own Git folder (`headCommitOf`), never
    // by starting git. Every page asks for this key before it is drawn, and `git rev-parse HEAD` here started two
    // subprocesses and waited for them on the serving thread: while a fill ran, every other answer queued behind them
    // (measured: `marks key` p50 2 ms, p99 8 ms of blocked thread per answer; the page's own p50 fell from 3 ms to 1 ms
    // once the key read the files).
    for (const repository of [{ path: this.options.productFolder }, ...this.repositories().filter((repo) => repo.present)]) {
      parts.push(headCommitOf(repository.path)?.commit ?? '-');
    }
    return parts.join('|');
  }

  /** The memo of the document entities: they are read again only when a document, a commit or a document kind changed. */
  private docMemo: { key: string; sources: DocumentSource[]; entities: DocEntity[]; findings: Finding[] } | undefined;
  private readonly repoDocs = new Map<string, DocumentSource[]>();

  /**
   * The Markdown documents the wiki lists (the product repository's as the working tree holds them, each code repository's
   * at the commit the graph was filled from) and the entities of the manifest's document kinds in them. A repository with
   * more documents than the listing's limit is read up to it, and a finding says so.
   */
  private async documentEntities(productFolder: string, manifest: KindsManifest): Promise<{ sources: DocumentSource[]; entities: DocEntity[]; findings: Finding[] }> {
    if (![...manifest.kinds.values()].some((kind) => kind.source === 'document')) return { sources: [], entities: [], findings: [] };
    const store = this.storeFolder();
    const findings: Finding[] = [];
    const sources: DocumentSource[] = [];
    const stamps: string[] = [];
    const outside = docsLinkedOutside(productFolder);
    if (outside !== undefined) findings.push({ file: 'docs', line: 1, message: `docs is a link to ${outside}, outside the product repository ${productFolder}: its documents are not read for entities`, source: join(productFolder, 'docs') });
    for (const path of productDocumentPaths(productFolder).filter((candidate) => listedDocument(manifest, null, candidate))) {
      const text = readProductDocument(productFolder, path);
      if (text === undefined) { findings.push({ file: path, line: 1, message: 'the document is too large or cannot be read, so no entity is read from it', source: join(productFolder, path) }); continue; }
      sources.push({ repo: null, path, text, origin: join(productFolder, path) });
      stamps.push(`${path}\0${text.length}\0${Bun.hash(text)}`);
    }
    for (const repo of this.repositories().filter((candidate) => candidate.present)) {
      const commit = this.pins.get(repo.name)?.commit;
      // A checkout that holds no commit has no documents: it is named with its path, and nothing is
      // read of it. A repository added before its first commit must not fail the product's wiki.
      if (commit === undefined || commit === '') {
        if (headCommitOf(repo.path) === undefined) {
          findings.push({ file: repo.path, line: 1, message: `the repository ${JSON.stringify(repo.name)} holds no commit yet: nothing is read from it until it does`, source: repo.path });
          continue;
        }
      }
      const at = commit === undefined || commit === '' ? 'HEAD' : commit;
      const key = `${repo.name}@${at}@${manifest.excludeDocuments.join(',')}`;
      let held = this.repoDocs.get(key);
      if (held === undefined) {
        const all = (await repoDocumentPaths(repo.name, repo.path, commit)).filter((candidate) => listedDocument(manifest, repo.name, candidate));
        const paths = all.slice(0, DOCUMENT_LIMIT);
        const texts = await readRepoDocuments(repo.name, repo.path, at, paths);
        held = [];
        const cut: Finding[] = [];
        for (const path of paths) {
          const text = texts.get(path);
          if (text === undefined) continue;
          if (text === null) { cut.push({ file: `repos/${repo.name}/${path}`, line: 1, message: 'the document is too large, comes past the budget of bytes read from this repository, or its name holds a line break, so no entity is read from it', source: join(repo.path, path) }); continue; }
          held.push({ repo: repo.name, path, text, origin: join(repo.path, path) });
        }
        if (all.length > DOCUMENT_LIMIT) cut.push({ file: `repos/${repo.name}`, line: 1, message: `the repository holds ${all.length} Markdown documents and the wiki reads the first ${DOCUMENT_LIMIT} of them for entities`, source: repo.path });
        this.repoDocs.set(key, held);
        this.repoDocFindings.set(key, cut);
      }
      sources.push(...held);
      findings.push(...(this.repoDocFindings.get(key) ?? []));
      stamps.push(key);
    }
    const signature = JSON.stringify([...manifest.kinds.values()].filter((kind) => kind.source === 'document').map((kind) => [kind.name, kind.identifier, kind.terms, kind.headings, kind.semantics, kind.structure]));
    // The identities beside the product and the meanings jev and the agent read are part of what the read stands on: a changed one reads the documents again.
    const identityFile = join(store, IDENTITIES_FILE);
    const classificationFile = join(store, CLASSIFICATIONS_FILE);
    const stampOf = (file: string): string => { try { return String(statSync(file).mtimeMs); } catch { return '-'; } };
    const keyOf = (): string => `${signature}\0${stamps.join('\n')}\0${String((manifest.expect ?? []).map((entry) => entry.kind).join(','))}\0${String(manifest.ignoreBlocks.join(','))}\0${stampOf(identityFile)}\0${stampOf(classificationFile)}`;
    if (this.docMemo?.key !== keyOf()) {
      const held = readDocIdentities(identityFile);
      const hasClassifications = existsSync(classificationFile);
      const classifications = hasClassifications ? readClassificationStore(classificationFile) : { answers: new Map(), findings: [] as Finding[] };
      const read = readDocEntities(sources, manifest, { identities: held.identities, ...(hasClassifications ? { classifier: storedClassifier(classifications.answers) } : {}) });
      // The identities are kept beside the product, never in the repository: editing a heading keeps its links.
      if (!sameDocIdentities(held.identities, read.identities)) {
        try { writeDocIdentities(identityFile, read.identities); }
        catch (error) { held.findings.push({ file: identityFile, line: 1, message: `the identities of the document sections could not be kept, so a renamed section loses its links at the next read: ${(error as Error).message}` }); }
      }
      this.docMemo = { key: keyOf(), sources, entities: read.entities, findings: [...held.findings, ...classifications.findings, ...read.findings] };
    }
    return { sources, entities: this.docMemo.entities, findings: [...findings, ...this.docMemo.findings] };
  }
  private readonly repoDocFindings = new Map<string, Finding[]>();

  private readonly origins = new Map<string, string | null>();

  /** The origin URL of a code repository's checkout (`git remote get-url origin`), read once; undefined when it has none. */
  private originOf(checkout: string): string | undefined {
    if (!this.origins.has(checkout)) {
      try {
        this.origins.set(checkout, execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null);
      } catch {
        this.origins.set(checkout, null);
      }
    }
    return this.origins.get(checkout) ?? undefined;
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
      key = this.statusKey();
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
   * What moves without a file: the fill, the writer and the agent, taken from this process on every answer. The units
   * are named against the context of the cached read, so a unit that starts while the files stay unchanged keeps the
   * reader-facing kind, title and page the read's documents and Markdown gave it (madarch-m38l.23). The Problems count
   * is the one collected for exactly these inputs, else absent: an answer never keeps a count collected for inputs the
   * cache has replaced — while a fill holds the collection back, the answer is pending (madarch-u3vw.8).
   */
  private async statusLive(body: WikiStatus, ctx: RenderContext | undefined): Promise<WikiStatus> {
    const problems = this.problemsKeySafe();
    const collected = this.problemsCache;
    let loop = body.loop;
    if (problems === '' || collected === undefined || collected.key !== problems) {
      // No listing for these inputs yet: the count is pending (the collection runs beside the answer, and the next poll
      // carries it), and a reader shows the corrections it counts from their files.
      this.openProblems();
      const { problemsOpen: _pending, ...rest } = loop;
      loop = rest;
    } else {
      loop = { ...loop, problemsOpen: collected.listing.open };
    }
    // A snapshot the fill published moves the store's numbers, not the files the body was made from: they are read for
    // every answer, in the reader's process, over the snapshot the pages show.
    const numbers = ctx === undefined ? undefined : await this.numbersOf(ctx);
    return { ...body, ...(numbers ?? {}), loop, fill: this.statusFill(), writer: ctx === undefined ? this.writer : { ...this.writer, units: this.unitRows(ctx) }, chosenAgent: this.chosenAgent() };
  }

  /**
   * What a status answer states of the store: the kinds' counts, the repository the pages show and what the pins hold.
   * The context's own read of the manifest and the product's documents is not made again — only the two fields that read
   * the store are bound to the reader this answer uses, so a snapshot the fill published is stated at once.
   */
  private async numbersOf(ctx: RenderContext): Promise<Partial<WikiStatus>> {
    let bound = ctx;
    try {
      const owner = await this.open();
      bound = { ...ctx, graph: new GraphReader(owner, this.validAt), ...(ctx.records === undefined ? {} : { records: this.recordFiles(owner) }) };
    } catch {
      // The store cannot be opened: the counts stand as the body read them and the answer still says how the fill is.
    }
    const kinds = await kindSummaries(bound).catch(() => undefined);
    const repository = await this.repositoryView().catch(() => undefined);
    const run = this.runViewOf();
    this.fillExtras = {
      ...(repository === undefined ? {} : { counts: repository.counts }),
      ...(run === null ? {} : { run }),
      ...(this.fill.state === 'failed' && this.fill.message !== undefined ? { error: this.errorOf(this.fill.message) } : {}),
    };
    return {
      ...(kinds === undefined ? {} : { kinds }),
      ...(repository === undefined ? {} : { repository }),
      repositories: this.repositories().map((repo) => ({ name: repo.name, filled: (this.pins.get(repo.name)?.filledCommits ?? 0) > 0 })),
      filled: this.pins.size > 0,
      incomplete: [...this.pins.values()].some((pin) => pin.filledCommits < pin.commits || pin.commits === 0),
    };
  }

  private statusMemo: { key: string; body: WikiStatus; ctx: RenderContext | undefined } | undefined;
  private statusFlight: { key: string; promise: Promise<StatusRead> } | undefined;

  /**
   * Every file and store state the answer reads besides the fill and the writer, as one key: the Problems listing's
   * own key (the snapshot, the pins, the plan, the starter set and every file the page reads) and the three the listing
   * leaves out — the task files, whose closures the menu counts, the store's last finish, which the menu shows, and the
   * commit each repository's default branch stands at, which is what a task closure reads (madarch-u3vw.8).
   *
   * A file's own content is the stamp: an edit that keeps its size and restores its mtime is still an edit, and the
   * content hash is kept beside the metadata so an unchanged file is not read again on every poll.
   */
  private statusKey(): string {
    let finished = '-';
    try {
      finished = this.contentStamp(join(this.storeFolder(), 'last-fill.json'));
    } catch {
      // No fill has finished yet, or the store is not open: nothing to stamp.
    }
    const tasks = this.folderStamp(TASKS_FOLDER);
    // A product with no task file has no closure to read: a branch that moves cannot close a task that is not there.
    const branches = tasks.endsWith(':absent') || tasks.endsWith(':empty') ? '-' : this.defaultBranchHeads();
    // The files and the plan and nothing of the store: a snapshot the fill publishes moves the numbers a body states,
    // and those are read for every answer (`numbersOf`), not by making the body again.
    return `${this.problemInputsKey()}|tasks:${tasks}|finished:${finished}|branches:${branches}`;
  }

  /** The files of one product-relative folder, each by its content; absent and empty folders are different stamps. */
  private folderStamp(relative: string): string {
    const path = join(this.options.productFolder, relative);
    let names: string[];
    try {
      names = readdirSync(path).sort(byCodePoint);
    } catch {
      return `${path}:absent`;
    }
    const files = names.filter((name) => name.endsWith('.md')).map((name) => this.contentStamp(join(path, name)));
    return files.length === 0 ? `${path}:empty` : files.join(';');
  }

  /**
   * The commit each repository's default branch stands at, as the closure check reads it. A commit on the default
   * branch closes a task without touching a product file or moving a filled pin, so the status key names it too.
   */
  private defaultBranchHeads(): string {
    const parts: string[] = [];
    for (const repository of this.taskRepositories()) {
      const branch = defaultBranch(repository.path);
      try {
        const commit = execFileSync('git', ['-C', repository.path, 'rev-parse', branch], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        parts.push(`${repository.name}@${branch}@${commit}`);
      } catch {
        parts.push(`${repository.name}@${branch}@-`);
      }
    }
    return parts.join(',');
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
  private runViewOf(runId?: string): FillRunView | null {
    try {
      const run = readTraceRun({ store: this.storeFolder(), ...(runId === undefined ? {} : { runId }) });
      return {
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
   * The repository a page is about: the one the caller named when the product declares it, the
   * product's first declared repository otherwise, and any repository the store holds when the
   * product declares none. A product's own repository is filled beside its code repositories, and
   * a page about "the repository" is about the code the reader connected, not about the product's
   * own pages.
   */
  private async currentRepository(owner: DatabaseOwner, named: string | null = null): Promise<string | null> {
    let declared: string[] = [];
    try {
      declared = this.repositories().map((repository) => repository.name);
    } catch {
      declared = [];
    }
    const wanted = named !== null && declared.includes(named) ? named : declared[0] ?? named;
    return await repositoryOf(owner, wanted);
  }

  /** The repository the store holds, as a page states it: the named one, else the declared first one. */
  async repositoryView(named: string | null = null): Promise<RepositoryFactsView | undefined> {
    const owner = await this.open();
    const repository = await this.currentRepository(owner, named);
    if (repository === null) return undefined;
    const page = await repositoryPage(owner, repository);
    if (page === null) return undefined;
    return {
      name: page.repository, url: page.url, defaultBranch: page.defaultBranch, asIsCommit: page.asIsCommit,
      counts: page.counts, gaps: page.gaps, steps: page.steps,
    };
  }

  /** One folder's page, or null when the store holds no tree, no such folder, and no file inside it. */
  async folderView(folder: string, after?: string): Promise<FolderPageModel | null> {
    const owner = await this.open();
    const repository = await this.currentRepository(owner);
    if (repository === null) return null;
    return await folderPage(owner, repository, folder, after);
  }

  /** One file's page, or null when the store holds no such file. */
  async fileView(path: string, after?: { readonly walk: number; readonly commit: string }): Promise<FilePageModel | null> {
    const owner = await this.open();
    const repository = await this.currentRepository(owner);
    if (repository === null) return null;
    return await filePage(owner, repository, path, after);
  }

  /** One commit's page, or null when the store holds no such commit. */
  async commitView(hash: string): Promise<CommitPageModel | null> {
    const owner = await this.open();
    const repository = await this.currentRepository(owner);
    if (repository === null) return null;
    return await commitPage(owner, repository, hash);
  }

  /** The newest run of the store's trace, or the named one. */
  async runView(runId?: string): Promise<FillRunView | null> {
    return this.runViewOf(runId);
  }

  private async statusNow(): Promise<StatusRead> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    // A run a person paused before the server stopped stands as it was: its pages are named from the store it left.
    this.restorePause();
    const common = { product: { name: product.name, id: product.id } };
    const declared = this.repositories();
    const context = await this.context();
    if ('absent' in context) {
      return { body: { ...common, manifest: 'no-manifest', manifestFile: context.file, language: 'en', seeded: [], ...(this.seedError === undefined ? {} : { seedError: this.seedError }), findings: [], kinds: [], groups: [], repositories: declared.map((repo) => ({ name: repo.name, filled: false })), filled: false, incomplete: false, fill: this.fill, writer: this.writer, bounds: { ...WRITER_BOUNDS, editorialRequestsPerPage: this.editorialRequestsPerPage() }, chosenAgent: this.chosenAgent(), home: null, roles: {}, loop: this.loopCounts(), starterOffers: 0 }, ctx: undefined };
    }
    const home = homeKind(context.manifest);
    const homeEntity = home === undefined ? undefined : [...context.ctx.markdown.values()].find((entity) => entity.kind === home.name);
    // The body is the files' reading: the kinds' counts and the repository's numbers are read for every answer
    // (`numbersOf`), because a snapshot moves them without moving a file.
    const loop = this.loopCounts();
    const incomplete = [...this.pins.values()].some((pin) => pin.filledCommits < pin.commits || pin.commits === 0);
    const body: WikiStatus = {
      ...common,
      manifest: 'ok',
      manifestFile: context.manifest.file,
      language: context.manifest.language ?? 'en',
      seeded: this.seeded,
      findings: context.findings,
      kinds: await kindSummaries(context.ctx),
      groups: [...context.manifest.groups.values()].map((group) => ({ group: group.name, labels: { ...group.labels }, ...(group.short === undefined ? {} : { short: { ...group.short } }), ...(group.parent === undefined ? {} : { parent: group.parent }), ...(group.open === undefined ? {} : { open: group.open }) })),
      repositories: declared.map((repo) => ({ name: repo.name, filled: (this.pins.get(repo.name)?.filledCommits ?? 0) > 0 })),
      filled: this.pins.size > 0,
      incomplete,
      fill: this.statusFill(),
      writer: { ...this.writer, units: this.unitRows(context.ctx) },
      bounds: { ...WRITER_BOUNDS, editorialRequestsPerPage: this.editorialRequestsPerPage() },
      chosenAgent: this.chosenAgent(),
      home: homeEntity?.id ?? null,
      roles: Object.fromEntries([...context.manifest.roles.values()].map((role) => [role.name, { ...(role.open === undefined ? {} : { open: [...role.open] }), lead: [...role.lead] }])),
      loop,
      starterOffers: this.starterOffers().length,
    };
    return { body, ctx: context.ctx };
  }

  /**
   * The manifest's declarations as a stamp reads them: which files to look at, never what to make of them. The
   * manifest costs a YAML parse of every kind (eleven milliseconds of a status answer the menu polls), and the
   * declaration a stamp needs changes only with the file: the paths stay the same when a template is deleted, and the
   * stamp says `absent` for it either way. A template's appearance is the one thing outside the manifest that changes
   * which declarations are accepted, so it is compared too (madarch-u3vw.8). What the manifest *means* is read fresh
   * where it is drawn, findings and all.
   */
  private stampKinds: { manifest: string; templates: string; read: ReturnType<typeof readKinds> } | undefined;
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

  private kindsForStamp(folder: string, seed = true): ReturnType<typeof readKinds> {
    // The manifest's declarations are stamped by content too: an edit that keeps its size and mtime is still an edit.
    // The workflows manifest is read beside it, so its own edit moves the same key: a saved workflow's finding
    // appears, or goes, at the next read.
    const manifest = `${this.contentStamp(join(folder, KINDS_FILE))}\n${this.contentStamp(join(folder, WORKFLOWS_FILE))}`;
    const held = this.stampKinds;
    // Which declarations the manifest accepts also depends on the files it names: a template written after the answer
    // was warmed accepts a kind the read refused, and the files of that kind must be stamped from then on
    // (madarch-u3vw.8). The comparison is a stat per named template, never a parse.
    if (held !== undefined && held.manifest === manifest && this.templateStamps(folder, held.read) === held.templates) return held.read;
    // A reading that must not write asks for the manifest as it stands: an absent one is not made the starter set, and
    // is not kept, so the next reading that opens the product still seeds it.
    const read = seed ? this.kinds(folder) : readKinds(folder);
    if (!read.present) return read;
    this.stampKinds = { manifest, templates: this.templateStamps(folder, read), read };
    return read;
  }

  /**
   * The template paths a declaration names, and the Liquid fallback the parser takes for a named `.md` that does not
   * exist: writing the fallback accepts a kind, so the path is stamped before either file exists (madarch-u3vw.8).
   */
  private templatePaths(read: ReturnType<typeof readKinds>): string[] {
    if (!read.present) return [];
    const named = new Set<string>(read.manifest.declaredTemplates ?? []);
    for (const kind of read.manifest.kinds.values()) named.add(kind.template);
    const paths = new Set<string>();
    for (const path of named) {
      paths.add(path);
      if (path.endsWith('.md')) paths.add(`${path.slice(0, -'.md'.length)}.liquid`);
    }
    return [...paths];
  }

  /** The template candidates of a read, each by its content; the paths are compared to say whether a kind can have appeared. */
  private templateStamps(folder: string, read: ReturnType<typeof readKinds>): string {
    return this.templatePaths(read).map((path) => this.contentStamp(join(folder, path))).join('\n');
  }

  /**
   * A stamp of every file the Problems page reads besides the pinned graph: the product's manifest, the kinds manifest,
   * the workflows manifest, every template path a declaration names, the files of the Markdown kinds, the product's
   * documents, the questions and the corrections, and the store's identities and classifications. Status is polled, so
   * the page's count is kept; an edit of any of these — a manifest a person changed, a document, a question — must
   * change this key, or the menu keeps a count the page no longer shows (madarch-m38l.24, the review; the template
   * paths and the content hashes are madarch-u3vw.8).
   */
  private problemInputsStamp(): string {
    const folder = this.options.productFolder;
    const parts: string[] = [];
    parts.push(this.contentStamp(join(folder, MANIFEST_FILE)));
    parts.push(this.contentStamp(join(folder, KINDS_FILE)));
    // The workflows manifest is read beside the kinds manifest, so its findings are the listing's too: an edit of it
    // must move this key, or the page keeps the listing of the file it no longer holds.
    parts.push(this.contentStamp(join(folder, WORKFLOWS_FILE)));
    const manifest = this.kindsForStamp(folder);
    if (manifest.present) {
      // Every path a declaration names is stamped, even one whose kind was refused, and the Liquid fallback of a named
      // `.md` before it exists: creating either is what makes the kind and clears its finding, and the manifest's own
      // mtime may not move when only that file is written (madarch-u3vw.8).
      for (const template of this.templatePaths(manifest)) parts.push(this.contentStamp(join(folder, template)));
      for (const kind of manifest.manifest.kinds.values()) {
        if (kind.source !== 'markdown') continue;
        if (kind.file !== undefined) parts.push(this.contentStamp(join(folder, kind.file)));
        else if (kind.folder !== undefined) for (const path of markdownFilesBelow(folder, kind.folder)) parts.push(this.contentStamp(join(folder, path)));
      }
    }
    for (const path of productDocumentPaths(folder)) parts.push(this.contentStamp(join(folder, path)));
    parts.push(this.folderStamp(QUESTIONS_FOLDER));
    parts.push(this.folderStamp(CORRECTIONS_FOLDER));
    try {
      const store = this.storeFolder();
      parts.push(this.contentStamp(join(store, IDENTITIES_FILE)));
      parts.push(this.contentStamp(join(store, CLASSIFICATIONS_FILE)));
    } catch {
      parts.push('store:absent');
    }
    return parts.join('\n');
  }

  /**
   * The open problems of the Problems page. Status is polled, so the count is read once per revision of the product's
   * files, every repository's head and the unplaced units; a product whose page cannot be read falls back to the
   * corrections, which are read from their files without the page resolver.
   */
  private openProblems(): { count: number; key: string } | undefined {
    const key = this.problemsKeySafe();
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

  /** How many questions wait for an answer or for a refresh, and how many corrections wait for one, from their files. */
  private loopCounts(): WikiStatus['loop'] {
    const questions = listQuestions(this.options.productFolder);
    const correctionsOpen = readCorrections(this.options.productFolder).items.filter((correction) => correction.status === 'open').length;
    // The menu says what the Tasks page says: the closure of each task, not the status its file still carries.
    const tasksOpen = openTasks(this.options.productFolder, this.taskRepositories(), this.pageFiles());
    // Until the Problems page can be read, an open correction is the count that is known from the files alone; the
    // status replaces it with the page's own open count once that page can be built (openProblems).
    return { questionsOpen: questions.open, questionsAnswered: questions.answered, correctionsOpen, tasksOpen, problemsOpen: correctionsOpen };
  }

  /**
   * The store's record tables as a page's context reads them: the files of the repository the wiki's repository pages
   * show, counted and paged. A context built once for the files and a status answer that states the store's numbers
   * both read them here, so the kind `code.file` answers from one reader whichever path asked.
   */
  private recordFiles(indexOwner: DatabaseOwner): NonNullable<RenderContext['records']> {
    let held: Promise<string | null> | undefined;
    const repository = (): Promise<string | null> => (held ??= repositoryOf(indexOwner, this.repositories()[0]?.name ?? null));
    return {
      files: {
        count: async (prefix?: string): Promise<number> => { const name = await repository(); return name === null ? 0 : await recordedFileCount(indexOwner, name, prefix); },
        page: async (options: { readonly after?: string; readonly prefix?: string; readonly limit: number }) => {
          const name = await repository();
          return name === null ? { total: 0, rows: [], next: null } : await recordedFiles(indexOwner, name, options);
        },
      },
    };
  }

  /**
   * The facts of one file the store holds, by the page id the kind `code.file` names it with (`code.file:<path>`), or
   * `undefined` when the id names no file of the repository the wiki's repository pages show. The record tables are
   * read on the reader's own snapshot, the way the repository pages read them.
   */
  private async recordedFileFacts(id: string): Promise<FilePageFacts | undefined> {
    if (!id.startsWith('code.file:')) return undefined;
    const owner = await this.open();
    const repository = await repositoryOf(owner, this.repositories()[0]?.name ?? null);
    if (repository === null) return undefined;
    return await recordedFileFacts(owner, repository, id);
  }

  private readonly readSnapshotHistory = createSnapshotHistoryReader();

  async historyAt(selection: HistorySelection): Promise<HistoryContext> {
    const owner = await this.open();
    if (this.reader?.owner !== owner) return await this.historyAt(selection);
    const pin = this.pins.get(selection.repo);
    // A repository the store holds no temporal reading of has no history to read: its pages say so, and no statement
    // is sent to a graph that holds no version of it.
    if (pin === undefined || pin.scope === null) return { ...selection, coverage: 'unknown', commit: null, effectiveAt: null, until: null, points: [] };
    return await this.readSnapshotHistory(owner, { ...pin, scope: pin.scope }, this.validAt(), selection);
  }

  async page(id: string, lang?: string, options: { defer?: boolean; only?: string; history?: HistorySelection } = {}): Promise<PageResult> {
    const history = options.history === undefined ? undefined : await this.historyAt(options.history);
    // A gap is a visible result, not an empty current page or a reason to fall back to the tip.
    if (history !== undefined && history.coverage !== 'covered') return { ok: true, page: { id, kind: id.slice(0, id.indexOf(':')), title: id, trail: [], blocks: [], resolutions: {}, findings: [], notes: [], history } };
    const guideKind = (Object.keys(GUIDE_OUTPUTS) as GuideKind[]).find((kind) => GUIDE_OUTPUTS[kind].id === id);
    if (guideKind !== undefined) {
      // Guide authority can open its own transactions. It never enters the page batch.
      const context = await this.context(history);
      if ('absent' in context) return { ok: false, status: 404, message: `the product has no ${context.file}: the wiki shows the kinds that file declares` };
      return await this.guidePage(guideKind, lang === 'ru' ? 'ru' : lang === 'en' ? 'en' : context.ctx.language === 'ru' ? 'ru' : 'en', context.ctx, history);
    }
    // These operations can open their own snapshots; finish them before holding the reader pipe.
    const historyNavigation = history === undefined && id.startsWith('code.') ? await Promise.all([...this.pins.keys()].sort(byCodePoint).map(async (repo) => { const indexed = await this.historyAt({ repo, at: '?' }); return { repo, points: indexed.points, ...(indexed.landmarks === undefined ? {} : { landmarks: indexed.landmarks }) }; })) : undefined;
    const planned = history === undefined ? await this.plannedForPage(id) : undefined;
    // A file the store holds has its page from the record tables, read before the page's own transaction: a record read
    // opens a transaction of its own, and the page's transaction is one it cannot nest in.
    const fileFacts = history === undefined ? await this.recordedFileFacts(id).catch(() => undefined) : undefined;
    const owner = await this.open();
    // A newer snapshot may replace this one while the page is being rendered (a fill swaps readers under open reads).
    // The rendered owner is still a store, so its page keeps its Problems badge.
    const ownerWasReader = this.reader?.owner === owner;
    const validAt = this.validAt();
    const pins = new Map(this.pins);
    const rendered: PageResult = await owner.transaction('snapshot', async (transaction) => {
      const context = await this.context(history, { owner, transaction, validAt, pins });
      if ('absent' in context) return { ok: false, status: 404, message: `the product has no ${context.file}: the wiki shows the kinds that file declares` };
      if (history !== undefined && await findSubject(context.ctx, id) === undefined) return { ok: true, page: { id, kind: id.slice(0, id.indexOf(':')), title: id, trail: [], blocks: [], resolutions: {}, findings: [], notes: [], history, historicalAbsent: true } };
      // A file the store holds is a record, and its page states the record's facts: the reader the kind's catalogue
      // lists is the one that answers here (`render.ts`), so a listing never names a file whose page the wiki cannot draw.
      const recorded = fileFacts === undefined ? undefined : await recordFilePage(context.ctx, fileFacts, id, lang);
      const result: PageResult = recorded === undefined
        ? await renderPage(context.ctx, id, lang, history === undefined ? options : { ...options, defer: false })
        : { ok: true, page: recorded };
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
        const listing = await this.problemsFor(this.problemsKey(), owner);
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
    const gap = (en: string, ru: string): PageResult => {
      const message = `${file}:1: $.guide: ${locale === 'ru' ? ru : en}`;
      return { ok: true, page: { ...base, blocks: [{ type: 'problem', block: 'guide', file, line: 1, message }], findings: [{ file, line: 1, message }] } };
    };
    if (declaration?.source !== 'markdown' || declaration.file === undefined) return gap('the registered guide output is not declared by this product', 'Этот продукт не объявляет зарегистрированное руководство');
    if (history !== undefined) return gap('historical guide input proof is unavailable; current content was not substituted', 'Нет подтверждённых входных данных руководства на эту дату; текущая версия не подставлена');
    try {
      if ((this.options.guideContextFor === undefined) !== (this.options.guideHostFor === undefined)) return gap('guide context and verification authority must be supplied together', 'Контекст и проверяющая сторона руководства должны быть заданы вместе');
      const productPin = guideProductPin(ctx.productFolder, [...this.pins.keys()]);
      const repositories = [...this.pins.values()].map((pin) => ({ name: pin.name, commit: pin.commit })).concat({ name: productPin.id, commit: productPin.commit }).sort((a, b) => byCodePoint(a.name, b.name));
      const valid = [...this.pins.values()].map((pin) => pin.effectiveTime).sort(byCodePoint).pop();
      if (valid === undefined || repositories.some((pin) => pin.commit === '')) return gap('the repositories have no complete pinned input', 'Нет полных закреплённых входных данных репозиториев');
      if ([...this.pins.values()].some((pin) => !this.repositories().some((repository) => repository.name === pin.name && repository.present))) return gap('a pinned source repository is unavailable', 'Закреплённый исходный репозиторий недоступен');
      const owner = await this.open();
      const defaults = createGuideReadFactories({ owner, store: createGraphStore(owner), output: ctx.productFolder,
        snapshots: createGitSnapshotSource([...([...this.pins.values()].map((pin) => ({ id: pin.name, form: 'code' as const, root: this.repositories().find((repository) => repository.name === pin.name)?.path ?? join(ctx.productFolder, 'repos', pin.name), commit: pin.commit }))), productPin]),
        scopeOf: (repository) => this.pins.get(repository)?.scope ?? undefined,
      });
      const contextFor = this.options.guideContextFor ?? defaults.guideContextFor;
      const hostFor = this.options.guideHostFor ?? defaults.guideHostFor;
      const current = await contextFor({ kind, locale, valid, repositories });
      const currentCode = current?.repositories.filter((repository) => repository.name !== productPin.id).sort((a, b) => byCodePoint(a.name, b.name));
      const requestedCode = repositories.filter((repository) => repository.name !== productPin.id);
      if (current === undefined || !current.repositories.some((repository) => repository.name === productPin.id) || JSON.stringify(currentCode) !== JSON.stringify(requestedCode)) return gap('the current prepared input proof is unavailable or stale', 'Подтверждение текущих подготовленных данных недоступно или устарело');
      const host = await hostFor({ kind, locale, context: current });
      const root = realpathSync(ctx.productFolder);
      const actual = realpathSync(file);
      if (!insideFolder(root, relative(root, actual)) || !statSync(actual).isFile() || statSync(actual).size > 2 * 1024 * 1024) return gap('guide artifact is unsafe or exceeds 2097152 bytes; nothing was truncated', 'Файл руководства небезопасен или превышает 2097152 байта; данные не сокращены');
      const read = await readGuidePage({ file, source: readFileSync(actual, 'utf8'), kind, locale, host });
      if (!read.ok) return { ok: true, page: { ...base, findings: [...read.diagnostics], blocks: read.diagnostics.map((diagnostic) => ({ type: 'problem', block: 'guide', file: diagnostic.file, line: diagnostic.line, message: diagnostic.message })) } };
      return { ok: true, page: { ...base, title: read.data.guide.title, findings: [...read.diagnostics], blocks: [{ type: 'guide', data: read.data }] } };
    } catch {
      return gap('guide artifact or source verification is unavailable; no success was inferred', 'Файл руководства или проверка источников недоступны; успех не предполагается');
    }
  }

  /** The planned changes one page stands in: its own entity, and the statements of it a task's grounds reach. */
  private async plannedForPage(id: string): Promise<PageModel['planned']> {
    try {
      const marks = await this.marks();
      const entity = markForEntity(marks, id);
      const byStatement = marksForPage(marks, id);
      const statements: (PlannedMarkView & { sentence: string })[] = [];
      if (byStatement.size > 0) {
        for (const statement of readKnowledgePages(this.options.productFolder).pages.find((candidate) => candidate.id === id)?.statements ?? []) {
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

  /** The file each page of the product is written in: what a task's statement scope names when a commit closes it. */
  private pageFiles(): Map<string, string> {
    return new Map(readKnowledgePages(this.options.productFolder).pages.map((page) => [page.id, page.file] as const));
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

  /** The terms of the product's glossaries, read from its documents (no fill is needed). */
  async glossary(): Promise<{ terms: GlossaryTerm[]; resolutions: Record<string, Resolution>; findings: Finding[] }> {
    const context = await this.context();
    if ('absent' in context) return { terms: [], resolutions: {}, findings: [] };
    const terms = glossaryTerms(context.manifest, context.ctx.docEntities.values(), context.ctx.localizedSources, context.ctx.language, context.ctx.repositories.length === 1);
    // The links the terms' texts hold are resolved here once, so the page draws them as it draws any other (broken ones marked).
    const resolutions: Record<string, Resolution> = {};
    for (const url of [...new Set(terms.flatMap(termLinks))].sort(byCodePoint)) resolutions[url] = await context.ctx.resolver.resolve(url);
    return { terms, resolutions, findings: context.findings };
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
   * The Markdown documents the wiki shows as pages: the product repository's own (its README and everything under docs/,
   * as the working tree holds them) and each connected repository's, as it was at the commit the graph was filled from.
   */
  async documents(): Promise<DocumentListing> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    // Listing the documents writes nothing: a product with no manifest has no pages of kinds and no excluded files, so
    // the read never seeds the starter set. A manifest that is there is parsed once per revision, never once per listing.
    const read = this.kindsForStamp(product.folder, false);
    const manifest: KindsManifest = read.present ? read.manifest : { file: read.file, roles: new Map(), properties: new Map(), kinds: new Map(), declaredTemplates: [], groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] };
    const documents: DocumentRef[] = [];
    const truncated: DocumentListing['truncated'] = [];
    // The product's own pages (the files of its Markdown kinds) are entity pages, and the manifest names the harness files that are no product document.
    const shown = (path: string): boolean => !HARNESS_FILES.has(path.split('/').pop()!);
    for (const path of productDocumentPaths(product.folder).filter(shown)) {
      if (!listedDocument(manifest, null, path)) continue;
      documents.push({ repo: null, path, title: documentTitle(readProductDocument(product.folder, path) ?? '', path) });
    }
    for (const repo of this.repositories().filter((candidate) => candidate.present)) {
      const commit = this.pins.get(repo.name)?.commit;
      const names = (await repoDocumentPaths(repo.name, repo.path, commit)).filter((name) => shown(name) && listedDocument(manifest, repo.name, name));
      if (names.length > DOCUMENT_LIMIT) truncated.push({ repo: repo.name, total: names.length, shown: DOCUMENT_LIMIT });
      const listed = names.slice(0, DOCUMENT_LIMIT);
      // One git process reads the lot; a document too large to read is titled by its file name.
      const texts = await readRepoDocuments(repo.name, repo.path, commit === undefined || commit === '' ? 'HEAD' : commit, listed);
      for (const name of listed) documents.push({ repo: repo.name, path: name, title: documentTitle(texts.get(name) ?? '', name) });
    }
    for (const kind of Object.keys(GUIDE_OUTPUTS)) {
      const declared = manifest.kinds.get(kind);
      if (declared?.source !== 'markdown' || declared.file === undefined || !existsSync(join(product.folder, declared.file))) continue;
      if (!documents.some((document) => document.repo === null && document.path === declared.file)) documents.push({ repo: null, path: declared.file, title: declared.labels?.[manifest.language === 'ru' ? 'ru' : 'en']?.one ?? kind });
    }
    return { documents, truncated };
  }

  /** One document as a page; `undefined` when the repository has no such document. */
  async document(repo: string | null, path: string): Promise<DocumentPage | undefined> {
    const registry = readKinds(this.options.productFolder);
    const guideKind = repo === null && registry.present ? (Object.keys(GUIDE_OUTPUTS) as GuideKind[]).find((kind) => registry.manifest.kinds.get(kind)?.source === 'markdown' && registry.manifest.kinds.get(kind)?.file === path) : undefined;
    if (guideKind !== undefined) {
      const assembled = await this.page(GUIDE_OUTPUTS[guideKind].id);
      if (!assembled.ok) return undefined;
      const only = assembled.page.blocks.length === 1 ? assembled.page.blocks[0] : undefined;
      if (only?.type !== 'guide') return { repo: null, path, title: assembled.page.title, markdown: assembled.page.findings.map((finding) => finding.message).join('\n'), resolutions: {}, anchors: {}, commit: null, planned: [] };
      return { repo: null, path, title: assembled.page.title, markdown: only.data.markdown, resolutions: assembled.page.resolutions, anchors: {}, commit: null, planned: [] };
    }
    if (!DOCUMENT_PATH.test(path)) return undefined;
    const context = await this.context();
    if ('absent' in context) return undefined;
    // A document of a code repository is read at the commit the graph was filled from, and at the checkout's HEAD where
    // the repository was never filled: a reader may open its documents before the first fill.
    const markdown = repo === null
      ? await context.ctx.readSource(null, path)
      : (this.repositories().some((candidate) => candidate.name === repo && candidate.present)
        ? await gitBlob(join(this.options.productFolder, 'repos', repo), this.pins.get(repo)?.commit || 'HEAD', path)
        : undefined);
    if (markdown === undefined) return undefined;
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
      anchors: Object.fromEntries(anchorLines(markdown)),
      commit: repo === null ? null : this.pins.get(repo)?.commit ?? null,
      planned: planned.sections,
      ...(planned.note === undefined ? {} : { plannedNote: planned.note }),
    };
  }

  /** A file of a repository as the graph was filled from it, for the source view. */
  async source(repo: string | null, path: string, selection?: HistorySelection): Promise<{ text: string; commit: string | null; history?: HistoryContext } | undefined> {
    const history = selection === undefined ? undefined : await this.historyAt(selection);
    if (history !== undefined && (history.coverage !== 'covered' || repo !== history.repo)) return undefined;
    const context = await this.context(history);
    if ('absent' in context) return undefined;
    const text = await context.ctx.readSource(repo, path);
    if (text === undefined) return undefined;
    return { text, commit: history?.commit ?? (repo === null ? null : this.pins.get(repo)?.commit ?? null), ...(history === undefined ? {} : { history }) };
  }

  // ---- the loop of questions and corrections (madarch-m38l.7) ---------------------------------

  /** The questions of the product, from their files; they need no graph and no fill. */
  questions(): QuestionListing {
    return listQuestions(this.options.productFolder);
  }

  async question(slug: string): Promise<QuestionDetail | undefined> {
    const context = await this.context();
    const resolve = 'absent' in context
      ? async (url: string) => ({ state: 'broken' as const, target: url, reason: `the product has no ${context.file}` })
      : (url: string) => context.ctx.resolver.resolve(url);
    return await questionDetail(this.options.productFolder, slug, resolve);
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
    const key = this.marksKey();
    const held = this.marksMemo;
    if (held !== undefined && held.key === key) return held.marks;
    const product = this.product();
    if ('message' in product) return NO_MARKS;
    const owner = await this.open();
    const repositories = this.repositories().filter((repo) => repo.present).map((repo) => ({ name: repo.name, path: repo.path }));
    const marks = await plannedMarks({
      owner, productFolder: this.options.productFolder,
      // The product's own repository closes a task as a code repository does: its documents are in it.
      repositories: [{ name: '', path: product.folder }, ...repositories],
      productFiles: productDocumentPaths(product.folder),
      pageFiles: this.pageFiles(),
    });
    this.marksMemo = { key, marks };
    return marks;
  }

  /** The product's tasks, open first, each with what its change reaches through the graph. */
  async tasks(): Promise<TaskListing> {
    const owner = await this.open();
    return await listTasks({ productFolder: this.options.productFolder, owner, repositories: this.taskRepositories(), pageFiles: this.pageFiles(), placeOf: (scope) => this.placeOf(scope) });
  }

  /** One task with its complete impact: the pages a run would rewrite and the marks it stands on. */
  async task(id: string): Promise<TaskDetail | undefined> {
    const owner = await this.open();
    return await taskDetail({ productFolder: this.options.productFolder, owner, repositories: this.taskRepositories(), pageFiles: this.pageFiles(), placeOf: (scope) => this.placeOf(scope) }, id, await this.marks());
  }

  /** The task an answer proposes: the scope its grounds name and its impact through the graph, before anything is written. */
  async proposeTask(question: string, choice: TaskChoice, asked?: 'en' | 'ru'): Promise<TaskProposal> {
    const owner = await this.open();
    const read = readKinds(this.options.productFolder);
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
    const repoOf = (path: string): string | null => {
      if (productDocumentPaths(this.options.productFolder).includes(path)) return null;
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
      return { kind: 'symbol', label: hash < 0 ? rest : rest.slice(hash + 1), where: hash < 0 ? null : rest.slice(0, hash), href: `/k/e/${encodeURIComponent(key)}`, path: hash < 0 ? rest : rest.slice(0, hash), words };
    }
    const page = scope.key.slice(0, scope.key.indexOf('#'));
    const title = readKnowledgePages(this.options.productFolder).pages.find((candidate) => candidate.id === page)?.title ?? page;
    return { kind: 'statement', label: title, where: null, href: `/k/e/${encodeURIComponent(page)}`, path: null, words };
  }

  /** Create a task only after the reader confirms its proposed scope: a product file, committed as the reader. */
  async createTask(input: { question: string; title: string; grounds: string[]; scope: TaskScope[] }): Promise<{ task: PlannedTask; state: 'created'; committed: boolean; note?: string; commit?: string }> {
    const question = this.questions().rows.find((row) => row.slug === input.question);
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
      closing = closingCommit(task, this.taskRepositories(), { pageFiles: this.pageFiles() });
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
      const closing = closingCommit(task, this.taskRepositories(), { pageFiles: this.pageFiles() });
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
    const context = await this.context();
    if ('absent' in context) throw new WikiReadError(`the product has no ${context.file}: the wiki shows the kinds that file declares`);
    const owner = await this.open();
    return await this.problemsFor(this.problemsKey(), owner);
  }

  /**
   * What the Problems page reads, as one key: the graph snapshot, the pins it is shown beside, the writer's unplaced
   * plan, the starter set, and every file the page reads. The revision the change stream moves with is not part of it:
   * a fill that reads a commit moves that revision without changing a single problem (madarch-m38l.19).
   */
  private problemsKey(): string {
    return `${this.problemInputsKey()}|${this.storeKey()}`;
  }

  /**
   * What the Problems listing reads besides the store: the manifest, the templates and documents it names, the
   * product's Markdown and the writer's plan. A snapshot the fill publishes does not change any of them.
   */
  private problemInputsKey(): string {
    const plan = this.writer.plan === undefined ? '' : this.writer.plan.unplaced.map((entry) => `${entry.kind}:${entry.slug}`).join(',');
    return `${plan}|${this.starterOffers().length}|${this.problemInputsStamp()}`;
  }

  /** The store as a listing reads it: the snapshot the pages show and what each repository was filled to. */
  private storeKey(): string {
    const pins = [...this.pins.values()].map((pin) => `${pin.name}@${pin.commit}`).join(',');
    const snapshot = this.reader === undefined ? '' : String(this.reader.seq);
    return `${snapshot}|${pins}`;
  }

  /** The key where a missing file or a folder that cannot be read is no reason to fail an answer: the background refresh. */
  private problemsKeySafe(): string {
    try {
      return this.problemsKey();
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
  private refreshProblems(key: string = this.problemsKeySafe()): void {
    if (this.fill.state === 'running' || this.problemsFlight !== undefined) return;
    if (key === '' || this.problemsCache?.key === key || this.problemsFailed === key) return;
    void this.open()
      .then((owner) => {
        const current = this.problemsKeySafe();
        if (current === '' || this.problemsCache?.key === current) return undefined;
        return this.problemsFor(current, owner);
      })
      .catch(() => { this.problemsFailed = key; });
  }

  private async collectProblems(owner: DatabaseOwner): Promise<ProblemListing> {
    const context = await this.context();
    if ('absent' in context) throw new WikiReadError(`the product has no ${context.file}: the wiki shows the kinds that file declares`);
    const repository = this.singleRepository();
    const dismissals = readProblemDismissals(this.options.productFolder);
    const dismissed = new Set(dismissals.items.map((item) => item.id));
    const listing = await collectProblems({
      productFolder: this.options.productFolder, owner,
      // The Problems page reads the same revision every other read does: a fill that lands meanwhile changes the next listing, not this one.
      graph: new GraphReader(owner, () => this.validAt()),
      settings: context.manifest.problems ?? defaultSettings(),
      ...(repository === undefined ? {} : { repository }),
      resolve: (url) => context.ctx.resolver.resolve(url), findings: [...context.findings, ...dismissals.problems.map((problem) => ({ file: problem.file, line: problem.line, message: problem.message }))],
      ...(this.writer.plan === undefined ? {} : { unplaced: this.writer.plan.unplaced }),
      starter: this.starterOffers(), dismissed,
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
    if ('absent' in context) return { available: false, reason: `the product has no ${context.file}` };
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
    this.stopping = true;
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
    await this.writerAgent?.close().catch(() => undefined);
    await this.fillRun?.control('stop').catch(() => undefined);
    await this.running?.catch(() => undefined);
    await this.opening?.catch(() => undefined);
    await this.swapping.catch(() => undefined);
    this.listeners.clear();
    if (this.reader !== undefined) await this.reader.owner.close().catch(() => undefined);
    this.reader = undefined;
    // The worker that draws the templates is not the product's to end: the server opens and closes products around single
    // requests, and a worker started for every page would pay a process's start on every page. A worker nothing asks for
    // for ten seconds ends itself (`liquid.ts`).
    this.opening = undefined;
  }
}

/** What a repository was filled to: kept in the primary store (`knowledge_fill`) and applied with the snapshot it belongs to. */
export interface RepositoryPin {
  name: string;
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

  constructor(private readonly storeRoot: string, private readonly now?: () => Date, private readonly extra: Pick<KnowledgeProductOptions, 'env' | 'agentFactory' | 'errorLog' | 'snapshotMs' | 'choicesQuery' | 'guideContextFor' | 'guideHostFor'> = {}) {}

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
