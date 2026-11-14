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
import { here } from '../model/raise.js';
import { failRequestedFill } from './fill-run.js';
import { cancelRun } from '../fill/orchestrator.js';
import { createOneGraphSchema } from '../graph/one-graph.js';
import { EMPTY_CONTRACT } from '../graph/contract.js';
import { declaredEdgeReads, declaredKindReads, graphContractOf } from '../fill/stages/plugin-contract.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { requestStorePreparation, requestStoreReset } from '../product/store-preparation.js';
import { createDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';
import { openPreparedDatabaseOwner } from '../adapters/store-readiness.js';
import { SCHEMA_LOCK_SQL, storeSchemaLockKey } from '../adapters/schema-lock.js';
import { byCodePoint } from '../model/order.js';
import { readProduct, type ProductIdentity } from '../product/manifest.js';
import { productRepositoryId } from '../product/identity.js';
import { KINDS_FILE, readKinds, readKindsFrom, setKindsLanguage, type KindsManifest } from '../product/manifest/kinds.js';
import { applyReset, planReset, type ResetPlan } from './reset.js';
import type { KnowledgeFillResult, KnowledgeFillRun } from './fill-run.js';
import { askFillRun, openFillRunQueue } from '../fill/run-jobs.js';
import { startKnowledgeFill } from './fill-run.js';
import { readFillRunDetail } from './fill-runs.js';
import { askRunControl, readFillEnd, readRunConfiguration } from '../fill/orchestrator-store.js';
import { readProducerOutcomes } from '../graph/producer-outcomes.js';
import { createRun, readChain, readRuns, hasSuccessfulFill, readLatestRun, readRun, readLiveRun, readStoreStamp } from '../fill/state-store.js';
import { fillWritesPages } from '../fill/steps.js';
import { headCommitOf } from '../product/fill-updates.js';
import { pluginsFillingKind, pluginTurnUnitId } from '../fill/plugin-turns.js';
import { GraphReader, type GeneratedEdgeRead, type GeneratedKindRead } from './graph-read.js';
import { graphMarkdownEntities, pageOpinionKinds } from './markdown.js';
import type { AgentOffer, ChangedPage, FillErrorView, FillRunView, FillState, RepositoryCounts, WikiStatus, WriterState, WriterBounds } from './model.js';
import { readFillProgressOf } from '../obs/progress.js';
import { agentUsageOf, readTraceRunSummary, TraceSpanReader } from '../obs/trace-report.js';
import { traceFiles } from '../obs/trace.js';
import { withSpan } from '../obs/trace.js';
import { assertPluginTurnsEnabled, fillStageConfigurationFrom } from '../product/manifest/fill-config.js';
import { firstFillStagesOfFiles, engineFirstFillStages, WORKFLOWS_FILE } from '../product/manifest/workflows.js';
import { workingTreeFiles } from '../plugin/product-files.js';
import { planManifestFill } from '../plugin/fill-declarations.js';
import { configuredPluginAgent, pluginAgentOptions, adapterOf, readAgentSettings, installAdapter, offers, queryAgentChoices, WRITER_AGENTS, WRITER_BOUNDS } from './agents.js';
import { DEFAULT_EDITORIAL_REQUESTS_PER_PAGE, MAX_EDITORIAL_REQUESTS } from '../writer/editorial.js';
import { isModelRole, modelPair, resolveModelRoles, type ModelAssignments, type ModelPair, type ModelRole, type ModelRoleView } from './model-roles.js';
import type { AgentChoices } from '../fill/acp-choices.js';
import { journalFolder, journalOfUnit, NO_COUNTERS, readJournalFile, type Journal, type PageJournal } from '../writer/journal.js';
import { PRODUCT_PATH, type UnitAgent } from '../writer/units.js';
import { CONTENT_LANGUAGES } from '../writer/units.js';
import type { DraftEnv } from '../product/home.js';
import { groupViews } from './catalog-view.js';
import { ACTIVE_FILL_FILE, CHANGED_PAGES_FILE, invalidateInterruptedRun, readChangedPages } from './changed-pages.js';
import { acpGraphJudge } from './graph-verdict-acp-judge.js';
import { graphVerdictFile, loadGraphSnapshot, readGraphVerdictState, writeGraphVerdictBudgets, writeGraphVerdictState } from './graph-verdict-store.js';
import { GRAPH_VERDICT_VALIDATOR_VERSION, graphVerdictFingerprint, graphVerdictReport, graphVerdictRows, graphVerdictsRunnable, runGraphVerdicts, type GraphEvidenceContent, type GraphJudge, type GraphJudgeFactory, type GraphVerdictBudgets, type GraphVerdictMetrics, type GraphVerdictReport, type GraphVerdictRow } from './graph-verdicts.js';
import { Resolver } from './resolve.js';
import { graphProblemDismissals } from '../loop/graph.js';
import { commitFiles, localIdentity, LoopRefusal, type Answered, type Corrected } from '../loop/answer.js';
import { type PlannedTask, type TaskScope } from '../loop/tasks.js';
import { type TaskChoice, type TaskProposal } from '../loop/propose.js';
import { StoredProductFiles } from '../plugin/product-source.js';
import { planRefresh, type RefreshPlan } from '../loop/plan.js';
import { type ProblemListing, type TaskRow } from '../loop/views.js';
import { collectProblems } from '../problems/index.js';
import { defaultSettings } from '../problems/types.js';
import { WikiReadError } from './read-error.js';
import { productStoreFolder, storeDatabasePath } from '../product/store.js';
import { writeProblemDismissal } from '../loop/problem-files.js';
import { readKindUsage, type KindUsageView } from '../adapters/agent-usage.js';
import { authoredEntity } from '../graph/authored.js';
import { importAuthored } from './import-authored.js';
import { authoredHistoryPresent } from '../adapters/authored-import.js';
import { publishValidatedManifests, validateProductManifests, readPublishedManifest } from '../graph/manifest-publication.js';
import { manifestPublicationState, waitForManifestPublication } from '../product/manifest-publication-state.js';
import { withManifestContract } from '../graph/manifest-contract.js';
import { publishedManifestOf } from '../graphql/manifest.js';
import { SchemaRefusal } from '../graphql/names.js';
import { graphqlSchemaOf } from '../graphql/schema.js';
import { executeGraphql, type MessageBody } from '../graph/graphql-execute.js';
import { ReadContext, type DiagramNeighbourhood } from '../graph/graphql-read.js';
import { readProductTemplates } from '../graph/product-templates.js';
import { structureRevisionOf } from '../graph/graphql-execute.js';
import { putEdgeOpinion, putEntityOpinion, retractOpinion, type WriteSource } from '../graph/graph-writes.js';

/**
 * What a manifest declares for the graph reader: the graph kinds its contract names, and the tables its own field
 * bindings build. No kind's name stands here: the manifest is the product's data and the reader reads it.
 */
function graphKindsOf(manifest: KindsManifest): { declared: ReadonlySet<string>; generated: ReadonlyMap<string, GeneratedKindRead>; edges: ReadonlyMap<string, GeneratedEdgeRead> } {
  const contract = graphContractOf(manifest);
  // Vertices and edges both: a read asks whether the product declares an edge kind too (history, touched).
  return { declared: new Set([...contract.vertex.map((kind) => kind.name), ...contract.edge.map((kind) => kind.name)]), generated: declaredKindReads(manifest), edges: declaredEdgeReads(manifest) };
}

/** One term as the glossary page states it: what it is, its other names, and the file and lines it is stated at. */
const execFileAsync = promisify(execFile);

/** The writer's id for the unit that writes one document's localized source, whose page is the document entity's own id. */
const LOCALIZED_SOURCE_UNIT = 'localized-source:';

/** The scopes of a confirmed task, each once, in the order the reader sent them. */
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

/** What the source view answers for one file: its text at the commit read, or why the graph holds none of that version. */
export type SourceRead = { readonly text: string; readonly commit: string | null } | { readonly absent: string };

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
  private storeOpening: Promise<DatabaseOwner | null> | undefined;
  /** The store's fill-run queue, opened with the store and closed with it (madarch-8bdc.9). */
  private fillQueue: Awaited<ReturnType<typeof openFillRunQueue>> | undefined;
  private fill: FillState = { state: 'idle' };
  private running: Promise<void> | undefined;
  /** Closing cancels only the wait, not the daemon-owned publication. */
  private readonly publicationWait = new AbortController();
  /** The fill the store is running now, as its host controls it; undefined between runs. */
  private fillRun: KnowledgeFillRun | undefined;
  /** The run id of the fill under way: the trace it writes is read by that id, never as "the newest file". */
  private fillRunId: string | undefined;
  /** What the last finished run's trace and the store's counts say: the end state's numbers. */
  private fillExtras: { counts?: FillState['counts']; run?: FillRunView; outcomes?: FillState['outcomes']; error?: FillErrorView } = {};
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


  private singleRepository(): { name: string; path: string; commit: string } | undefined {
    const repositories = this.repositories().filter((repo) => repo.present);
    if (repositories.length !== 1) return undefined;
    const pin = this.pins.get(repositories[0]!.name);
    return pin === undefined || pin.head === '' ? undefined : { name: repositories[0]!.name, path: repositories[0]!.path, commit: pin.head };
  }


  /** A person's explicit entity action never fills the product or installs a manifest. */
  async authored(action: 'create' | 'show' | 'update' | 'delete' | 'list' | 'schema', kind: string, args: { uid?: string; values?: Readonly<Record<string, unknown>>; words?: string; ifRevision?: string } = {}) {
    return await withSpan('authored.action', { 'authored.action': action, 'authored.kind': kind }, async () => {
      const owner = await this.open();
      await this.followStoreFill();
      const read = await this.manifestRead(this.options.productFolder);
      if (!read.present || (this.pins.size === 0 && !await hasSuccessfulFill(owner))) throw new LoopRefusal(409, `${join(this.folder, KINDS_FILE)}:1: the graph has no permitted fill yet. Open the catalogue, select its kinds and press Fill first.`);
      if (read.manifest.findings.length > 0) {
        const first = read.manifest.findings[0]!;
        throw new LoopRefusal(409, `${resolve(this.folder, first.file)}:${first.line}: ${first.message}`);
      }
      const identity = this.product();
      if ('message' in identity) throw new LoopRefusal(409, identity.message);
      const writing = action === 'create' || action === 'update' || action === 'delete';
      const by = writing ? await localIdentity(this.folder, { ...process.env, ...this.options.env }) : undefined;
      const person = by === undefined ? '' : `person:${by.name} <${by.email}>`;
      const answer = await owner.transaction(writing ? 'write' : 'snapshot', async (tx) => await authoredEntity(tx, read.manifest, identity.name, person, action === 'show' ? 'read' : action === 'update' ? 'edit' : action, kind, args));
      if (writing) {
        this.generation += 1;
        if (this.reader !== undefined) this.reader.seq = this.generation;
        this.filesMemo = undefined;
        this.manifestMemo = undefined;
        this.notify();
      }
      return answer;
    });
  }

  /** Explicitly migrate the retired sources; a fill and a normal CRUD call never import them. */
  async importAuthored() {
    return await withSpan('authored.import', {}, async () => {
      const owner = await this.open();
      await this.followStoreFill();
      const read = await this.manifestRead(this.folder);
      if (!read.present || (this.pins.size === 0 && !await hasSuccessfulFill(owner))) throw new LoopRefusal(409, `${join(this.folder, KINDS_FILE)}:1: open the catalogue and press Fill first.`);
      const identity = this.product();
      if ('message' in identity) throw new LoopRefusal(409, identity.message);
      const by = await localIdentity(this.folder, { ...process.env, ...this.options.env });
      const result = await importAuthored(this.folder, owner, read.manifest, identity.name, `person:${by.name} <${by.email}>`);
      this.generation += 1;
      if (this.reader !== undefined) this.reader.seq = this.generation;
      this.filesMemo = undefined;
      this.manifestMemo = undefined;
      this.notify();
      return result;
    });
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


  /** Connects to the prepared store without reading or publishing the catalogue. */
  private async openStore(): Promise<DatabaseOwner>;
  private async openStore(preparedOnly: true): Promise<DatabaseOwner | null>;
  private async openStore(preparedOnly = false): Promise<DatabaseOwner | null> {
    if (this.closed) throw new Error('the wiki is shutting down');
    this.lastUse = Date.now();
    this.idleTimer ??= setInterval(() => { void this.closeIfIdle(); }, 60_000).unref();
    this.storeOpening ??= preparedOnly
      ? openPreparedDatabaseOwner(storeDatabasePath(this.storeFolder()), ['fill-state', 'orchestrator'])
      : createDatabaseOwner({ store: storeDatabasePath(this.storeFolder()), connectOnly: true });
    const opening = this.storeOpening;
    try {
      const owner = await opening;
      if (owner === null) {
        if (this.storeOpening === opening) this.storeOpening = undefined;
        if (!preparedOnly) return await this.openStore();
      }
      return owner;
    } catch (error) {
      if (this.storeOpening === opening) this.storeOpening = undefined;
      throw error;
    }
  }

  /**
   * Opens the store once, in this process (madarch-8bdc.9): the wiki reads the database the fill writes, directly. A store
   * with no tables at all (an empty folder the home made, or an earlier madarch's) is given them here, as the fill's own
   * schema does, so a first read is an empty page and never a missing relation; a store that has them is read and not
   * touched — a write here would lock the tables a running fill publishes into.
   */
  private async open(): Promise<DatabaseOwner> {
    if (this.closed) throw new Error('the wiki is shutting down');
    const publication = manifestPublicationState(this.folder);
    if (publication?.status === 'pending') throw new WikiReadError('The catalogue is being published. Please wait.');
    if (publication?.status === 'failed') throw new WikiReadError(`The catalogue could not be published: ${publication.message}`);
    this.lastUse = Date.now();
    this.opening ??= (async () => {
      // Managed readers use only what the daemon published, not a second read of the checkout.
      const manifests = publication === undefined ? validateProductManifests(this.folder) : undefined;
      if (manifests !== undefined) {
        if (!manifests.ok) throw new Error(manifests.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`).join('\n'));
        const contract = manifests.value === undefined ? EMPTY_CONTRACT : graphContractOf(manifests.value.manifest);
        await requestStorePreparation(storeDatabasePath(this.storeFolder()), withManifestContract(contract));
      }
      const owner = await this.openStore();
      try {
        await owner.ready;
        if (manifests?.ok && manifests.value !== undefined) await publishValidatedManifests(owner, manifests.value);
        await this.ensureStoreTables(owner);
        await this.loadPins(owner);
        // The publication the pins were read at: the first answer does not read them again (followStoreFill).
        this.storeStamp = await readStoreStamp(owner).catch(() => undefined);
      } catch (error) {
        // An owner that failed to open is given back: a retry must not leave a connection behind per request.
        await owner.close().catch(() => undefined);
        this.storeOpening = undefined;
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
        await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
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
  private async productFiles(): Promise<StoredProductFiles> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const repository = productRepositoryId(product);
    const owner = await this.open();
    const manifest = await this.manifestRead(product.folder);
    const kinds = manifest.present ? graphKindsOf(manifest.manifest) : undefined;
    const reader = new GraphReader(owner, this.validAt, undefined, undefined,
      kinds?.declared ?? new Set<string>(), kinds?.generated, kinds?.edges);
    const seq = this.reader?.seq ?? 0;
    const held = this.filesMemo;
    if (held !== undefined && held.seq === seq && held.repository === repository) return held.files;
    const files = await StoredProductFiles.load(reader, repository, product.folder);
    this.filesMemo = { seq, repository, files };
    return files;
  }

  /** The manifest one graph revision was read as: the whole parse stands for the revision, not for a page. */
  private manifestMemo: { seq: number; folder: string; read: ReturnType<typeof readKindsFrom> } | undefined;

  /** The product's kinds manifest and the declaration files beside it, read from the graph: absent when the graph holds none. */
  private async manifestRead(folder: string): Promise<ReturnType<typeof readKindsFrom>> {
    const seq = this.reader?.seq ?? 0;
    const held = this.manifestMemo;
    if (held !== undefined && held.seq === seq && held.folder === folder) return held.read;
    const manifest = !existsSync(storeDatabasePath(this.storeFolder()))
      ? undefined
      : await (await this.open()).run(async (tx) => await readPublishedManifest(tx));
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
  /**
   * The product's GraphQL schema (decision 0036, sections 1 to 4), derived from its published manifest: the contract
   * the wiki, MCP and outside systems read through. A manifest whose names cannot make a schema is refused with the
   * line that declares it, never served as a smaller schema.
   */
  async graphqlSchema(): Promise<string> {
    // What the graph holds, never the checkout: an edit start has not published is no schema this product serves, and
    // the SDL answers the very schema POST /graphql reads.
    const owner = await this.open();
    await this.followStoreFill();
    const manifest = await owner.transaction('snapshot', async (tx) => await readPublishedManifest(tx));
    const file = join(this.options.productFolder, KINDS_FILE);
    if (manifest === undefined) throw new WikiReadError(`${file}:1: the graph holds no published manifest: open the product once so its catalogue is published`);
    try {
      return graphqlSchemaOf(publishedManifestOf(manifest));
    } catch (error) {
      if (error instanceof SchemaRefusal) throw new WikiReadError(`${file}:1: the manifest's names cannot make a schema: ${error.message}`);
      throw error;
    }
  }

  /**
   * Runs one GraphQL operation against this product's graph (decision 0036, section 2): the manifest the start
   * published, the one executor the wiki and MCP share, and the schema its published manifest derives.
   */
  async graphql(operation: { readonly query: string; readonly variables?: Readonly<Record<string, unknown>>; readonly operationName?: string | null; readonly lang?: string }): Promise<{ readonly status: number; readonly body: MessageBody }> {
    const owner = await this.open();
    await this.followStoreFill();
    // The executor reads the published manifest inside its own snapshot: the schema and the rows answer one revision.
    return await executeGraphql(owner, { folder: this.options.productFolder }, operation);
  }

  /**
   * One entity's neighbourhood at a depth, read through the graph read layer inside one snapshot (decision 0036, sections
   * 7 and 8): what a rendered diagram is drawn from. The manifest and the templates are read in the same snapshot, so the
   * schema, the relations and the rows answer one revision.
   */
  async diagramNeighbourhood(id: string, depth: number, lang: string | undefined): Promise<DiagramNeighbourhood | undefined> {
    const owner = await this.open();
    await this.followStoreFill();
    return await owner.transaction('snapshot', async (tx) => {
      await tx.query("SET LOCAL statement_timeout = '2000ms'");
      const manifest = await readPublishedManifest(tx);
      if (manifest === undefined) throw new WikiReadError(`${join(this.options.productFolder, KINDS_FILE)}:1: the graph holds no published manifest: open the product once so its catalogue is published`);
      const published = publishedManifestOf(manifest);
      const templates = readProductTemplates(this.options.productFolder);
      const structure = structureRevisionOf(graphqlSchemaOf(published), templates.templates);
      const context = new ReadContext(tx, manifest, published, this.options.productFolder, lang, structure, templates);
      return await context.diagramNeighbourhood(id, depth, lang);
    });
  }

  /** The agent's opinion of an entity's fields: the entity is created when its key names none. */
  async putEntity(source: WriteSource, input: { readonly kind: string; readonly key?: unknown; readonly id?: string; readonly values: unknown; readonly evidence: unknown; readonly words?: string }): Promise<{ kind: string; key?: Record<string, unknown>; uid?: string; written?: number }> {
    const owner = await this.open();
    await this.followStoreFill();
    return await putEntityOpinion(owner, source, input);
  }

  /** The agent's opinion of an edge and its attributes. */
  async putEdge(source: WriteSource, input: { readonly kind: string; readonly from: unknown; readonly to: unknown; readonly discriminator?: string; readonly values?: unknown; readonly evidence: unknown; readonly words?: string }): Promise<{ kind: string; written?: number; retracted?: boolean }> {
    const owner = await this.open();
    await this.followStoreFill();
    return await putEdgeOpinion(owner, source, input);
  }

  /** Closes only this agent's own open opinions of an entity, of the fields it names, or of an edge. */
  async retract(source: WriteSource, input: { readonly entity?: unknown; readonly edge?: unknown; readonly evidence: unknown; readonly words?: string }): Promise<{ kind: string; retracted?: boolean; written?: number }> {
    const owner = await this.open();
    await this.followStoreFill();
    return await retractOpinion(owner, source, input);
  }

  async declaredRoles(): Promise<string[]> {
    const product = this.product();
    if ('message' in product) return [];
    const read = await this.manifestRead(product.folder);
    return read.present ? [...read.manifest.roles.keys()] : [];
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

  }

  /** Gives back the reader of a product nobody is reading, unless a fill is under way. */
  private async closeIfIdle(): Promise<void> {
    if (this.closed || this.running !== undefined || this.storeOpening === undefined || Date.now() - this.lastUse < READER_IDLE_MS) return;
    const held = this.storeOpening;
    await this.swapping.catch(() => undefined);
    if (this.storeOpening !== held) return;
    this.reader = undefined;
    this.opening = undefined;
    // The store's fill-run queue is opened on this reader's owner and asks it for statements on pg-boss's own
    // timer: it stops before the owner it borrows closes (madarch-8bdc.12), or the timer throws into the process.
    const queue = this.fillQueue;
    this.fillQueue = undefined;
    if (queue !== undefined) await queue.stop().catch(() => undefined);
    this.storeOpening = undefined;
    await held.then((owner) => owner?.close()).catch(() => undefined);
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
      const at = commit === '' ? undefined : await reader.commitFacts(facts.name, commit).catch(() => null);
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
  async startFill(options: { selected?: readonly string[]; agent?: string | null; tokenCap?: number; expectAgent?: string | null; language?: string; task?: string; taskPages?: readonly string[]; targets?: { readonly kinds: readonly string[]; readonly vertex?: string } } = {}): Promise<{ started: true; runId: string; fill: FillState } | { started: false; message: string; fill: FillState }> {
    if (this.running !== undefined) {
      const busy = this.fill.state === 'running' || this.writer.state === 'running' || this.writer.state === 'waiting';
      if (busy) return { started: false, message: 'a fill of this product is already running', fill: this.fill };
      // The fill and the agent stage are over; the worker is closing its store and ending. A press now waits for that.
      await Promise.race([this.running, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
      if (this.running !== undefined) return { started: false, message: 'the previous fill of this product is still closing its store; press again in a moment', fill: this.fill };
    }
    const publication = manifestPublicationState(this.folder);
    if (publication?.status === 'failed') return { started: false, message: `The catalogue could not be published: ${publication.message}`, fill: this.fill };
    const product = this.product();
    if ('message' in product) return { started: false, message: product.message, fill: this.fill };
    // Starting a fill is a write path: its own reading of the product is the working tree the files producer is about to
    // read, never the graph it is about to write (madarch-hsqs stage C).
    const read = readKinds(product.folder);
    if (!read.present) return { started: false, message: `the product has no ${read.file}: the wiki shows the kinds that file declares`, fill: this.fill };
    try {
      if (options.tokenCap !== undefined && (!Number.isInteger(options.tokenCap) || options.tokenCap < 1)) throw new Error(`${read.manifest.file}:1: token cap must be a positive integer`);
      const selectedAgent = options.agent === undefined ? configuredPluginAgent(this.storeFolder(), this.env) : options.agent === null ? undefined : pluginAgentOptions(options.agent, this.env, join(this.storeFolder(), 'agent-runs'));
      const plan = planManifestFill(read.manifest, product.folder, options.targets?.kinds, selectedAgent !== undefined);
      const files = workingTreeFiles(product.folder);
      assertPluginTurnsEnabled(plan.order, files.has(WORKFLOWS_FILE) ? firstFillStagesOfFiles(files, product.folder) : engineFirstFillStages(), fillStageConfigurationFrom(files, product.folder));
    } catch (error) {
      return { started: false, message: error instanceof Error ? error.message : String(error), fill: this.fill };
    }
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
    if (publication?.status !== 'pending') await this.open().catch(() => undefined);
    const request = { ...(options.agent === undefined ? {} : { agent: options.agent }), ...(options.tokenCap === undefined ? {} : { tokenCap: options.tokenCap }), ...(wanted === undefined ? {} : { language: wanted }), ...(task === undefined ? {} : { task }), ...(options.targets === undefined ? {} : { targets: options.targets }) };
    // The run's id names its trace, which the answer's progress is read from: it is the press's own moment, as every
    // reader of a run's trace finds it.
    const runId = `fill-${startedAt.replace(/[-:.]/gu, '').replace(/Z$/u, 'Z')}`;
    const selection = options.targets === undefined ? undefined : {
      selected: [...(options.selected ?? options.targets.kinds)], order: [...options.targets.kinds],
      ...(options.targets.vertex === undefined ? {} : { vertex: options.targets.vertex }),
      groups: options.targets.kinds.flatMap((kind) => {
        const declaration = read.manifest.kinds.get(kind);
        const plugins = pluginsFillingKind(read.manifest, kind);
        return plugins.map((plugin) => ({ kind, group: declaration?.group ?? null, plugin, stageUnitId: pluginTurnUnitId(plugin, kind, options.targets?.vertex) }));
      }),
    };
    if (publication?.status !== 'pending') await createRun(await this.open(), { runId, product: product.name, at: Date.parse(startedAt), ...(selection === undefined ? {} : { selection }) });
    const press = { ...request, ...(selection === undefined ? {} : { selection }) };
    // The repository the run reads, as the product declares it: the card says what it is reading
    // before the run's own trace has a unit to count.
    this.fillRunId = runId;
    this.fill = { state: 'running', startedAt, runId, commit: 0, commits: 0, gaps: 0, ...(repositories[0] === undefined ? {} : { repository: repositories[0].name }) };
    this.notify();
    this.running = (async () => {
      try {
        const ready = await waitForManifestPublication(this.folder, this.publicationWait.signal);
        if (this.closed) return;
        if (ready?.status === 'failed') throw new Error(`The catalogue could not be published: ${ready.message}`);
        await (this.options.fillQueued === true ? this.runQueuedFill(product, runId, press) : this.runInlineFill(product, runId, press));
      } catch (error) {
        if (publication?.status !== 'pending') await failRequestedFill(await this.open(), runId, error instanceof Error ? error.message : String(error));
        if (this.closed) return;
        this.fill = { state: 'failed', startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message: error instanceof Error ? error.message : String(error), code: 'store' };
        if (this.writer.state === 'waiting') this.writer = { ...this.writer, state: 'idle' };
        this.notify();
      }
    })().finally(() => {
      // The mark goes only when the run is over, after its result is recorded: a restart before this point has no list.
      this.clearActiveFill();
      this.running = undefined;
      this.fillRun = undefined;
    });
    return { started: true, runId, fill: this.fill };
  }

  /**
   * Fills the store in this process (madarch-8bdc.9): what `madarch fill`, a test that drives this class alone and every
   * caller that is not the api role does. The server's products ask a fill process instead (`runQueuedFill`).
   */
  private async runInlineFill(product: ProductIdentity, runId: string, asked: { readonly agent?: string | null; readonly tokenCap?: number; readonly language?: string; readonly task?: string; readonly selection?: import('../fill/fsm.js').RunSelection; readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string } } = {}): Promise<void> {
    const storeFolder = this.storeFolder();
    this.fillRunId = runId;
    let result: KnowledgeFillResult | undefined;
    try {
      const owner = await createDatabaseOwner({ store: storeDatabasePath(storeFolder), connectOnly: true });
      if (await readRun(owner, runId) === null) await createRun(owner, { runId, product: product.name, at: Date.parse(this.fill.startedAt!), ...(asked.selection === undefined ? {} : { selection: asked.selection }) });
      const run = await startKnowledgeFill({
        productFolder: product.folder,
        storeFolder,
        runId,
        database: owner,
        env: this.env,
        ...(asked.agent === undefined ? {} : { pluginAgent: asked.agent === null ? null : pluginAgentOptions(asked.agent, this.env, join(storeFolder, 'agent-runs')) }),
        ...(asked.tokenCap === undefined ? {} : { tokenCap: asked.tokenCap }),
        prepareContract: async (contract) => await requestStorePreparation(storeDatabasePath(storeFolder), contract),
        ...(asked.targets === undefined ? {} : { targets: asked.targets }),
        onPublish: () => { void this.published(undefined).catch(() => undefined); },
      });
      try {
        result = await run.done;
      } finally {
        await run.close().catch(() => undefined);
      }
    } catch (error) {
      await failRequestedFill(await this.open(), runId, error instanceof Error ? error.message : String(error));
      this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message: error instanceof Error ? error.message : String(error), code: 'store' };
      this.notify();
      return;
    }
    if (result === undefined || !result.ok) {
      this.fill = {
        state: result?.state === 'paused' ? 'paused' : result?.state === 'cancelled' ? 'stopped' : 'failed', runId, startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(),
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
    // A standalone fill owns the fill only. The serving host validates after queued fills; an inline caller asks
    // graphVerdicts explicitly when it needs validation, rather than inheriting unrelated work at close.
    this.lastUse = Date.now();
  }

  /**
   * Asks for the fill through the store's own queue and follows it where its own state is written (madarch-8bdc.9): the
   * api role never fills in the process that answers pages — a fill process of the same binary claims the job, reads git
   * and publishes into the store, and the pages read what it published. The two talk only through PostgreSQL.
   */
  private async runQueuedFill(product: ProductIdentity, runId: string, asked: { readonly agent?: string | null; readonly tokenCap?: number; readonly language?: string; readonly task?: string; readonly selection?: import('../fill/fsm.js').RunSelection; readonly targets?: { readonly kinds: readonly string[]; readonly vertex?: string } }): Promise<void> {
    const storeFolder = this.storeFolder();
    this.fillRunId = runId;
    let state: string | undefined;
    let end: Awaited<ReturnType<typeof readFillEnd>> = null;
    try {
      const owner = await this.open();
      if (await readRun(owner, runId) === null) await createRun(owner, { runId, product: product.name, at: Date.parse(this.fill.startedAt!), ...(asked.selection === undefined ? {} : { selection: asked.selection }) });
      // One queue per product, opened with its store and closed with it: starting and stopping the queue's own scheduler
      // around every press cost more than the fill it asked for.
      this.fillQueue ??= await openFillRunQueue(owner);
      await askFillRun(this.fillQueue, { product: product.folder, store: storeFolder, runId, ...(asked.agent === undefined ? {} : { agent: asked.agent }), ...(asked.tokenCap === undefined ? {} : { tokenCap: asked.tokenCap }), ...(asked.language === undefined ? {} : { language: asked.language }), ...(asked.task === undefined ? {} : { task: asked.task }), ...(asked.targets === undefined ? {} : { targets: asked.targets }) });
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
      await failRequestedFill(await this.open(), runId, error instanceof Error ? error.message : String(error));
      this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message: error instanceof Error ? error.message : String(error), code: 'store' };
      this.notify();
      return;
    }
    if (state !== 'succeeded') {
      this.fill = { state: state === 'paused' ? 'paused' : state === 'cancelled' ? 'stopped' : 'failed', runId, startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message: end?.message ?? `the fill ended ${state ?? 'without a run'}`, code: 'fill' };
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
    return readAgentSettings(this.choiceFile());
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
    const signal = this.publicationWait.signal;
    signal.throwIfAborted();
    const file = graphVerdictFile(this.storeFolder());
    const state = readGraphVerdictState(file);
    const roles = this.modelRoles();
    // The validation owns its connection for the snapshot: the reader's owner may be closed as idle after the fill,
    // while this validation is still starting (the fill role and the api role have different lifetimes).
    const owner = await createDatabaseOwner({ store: storeDatabasePath(this.storeFolder()), connectOnly: true });
    let snapshot: Awaited<ReturnType<typeof loadGraphSnapshot>>;
    try {
      const manifest = await owner.run(async (tx) => await readPublishedManifest(tx));
      const kinds = manifest === undefined ? undefined : graphKindsOf(manifest);
      const reader = new GraphReader(owner, this.validAt, undefined, undefined, kinds?.declared, kinds?.generated, kinds?.edges);
      snapshot = await loadGraphSnapshot(reader, signal);
    } finally { await owner.close().catch(() => undefined); }
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
    // The evidence is read from the text a fill published, the same opinion the source view answers (section 8). The
    // read is one for the whole run: the promise is kept, so concurrent asks share it rather than each reading the store.
    let opinions: ReturnType<KnowledgeProduct['sourceOpinions']> | undefined;
    const product = this.product();
    const readEvidence = async (path: string): Promise<GraphEvidenceContent | undefined> => {
      signal.throwIfAborted();
      if ('message' in product) throw new WikiReadError(product.message);
      opinions ??= this.sourceOpinions();
      const held = (await opinions).get(path);
      if (held === undefined) return undefined;
      return { text: held.text, repository: held.repository ?? productRepositoryId(product), commit: held.commit };
    };
    const result = await runGraphVerdicts({
      snapshot,
      signal,
      roles,
      budgets: state.budgets,
      readEvidence,
      ...(state.cache === undefined ? {} : { previous: state.cache }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(jev === null ? {} : { jev }),
      ...(this.options.graphJevVersion === undefined ? {} : { jevVersion: this.options.graphJevVersion }),
      judgeFor,
    });
    signal.throwIfAborted();
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
  async resetPlan(): Promise<ResetPlan> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    try {
      const { graph, manifest } = await this.graphAndManifest();
      return await planReset(product.folder, this.storeFolder(), graph, manifest, this.options.storeRoot);
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
    const place = `${this.options.productFolder}:1:`;
    if (this.running !== undefined) return { ok: false, message: `${place} a fill of this product is running; start over after it ends` };
    if (this.resetting) return { ok: false, message: `${place} this product is already being started over` };
    const product = this.product();
    if ('message' in product) return { ok: false, message: product.message };
    this.resetting = true;
    try {
      const owner = await this.open();
      if (await authoredHistoryPresent(owner)) return { ok: false, message: `${this.storeFolder()}:1: this store holds person-authored history. Start over is refused to preserve authored data and its journal; export a backup and use a preserving migration instead.` };
      if (await readLiveRun(owner) !== null) return { ok: false, message: `${place} a fill of this product is running; start over after it ends` };
      const manifests = validateProductManifests(product.folder);
      if (!manifests.ok) return { ok: false, message: manifests.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`).join('\n') };
      const contract = withManifestContract(manifests.value === undefined ? EMPTY_CONTRACT : graphContractOf(manifests.value.manifest));
      const { graph: resetGraph, manifest: resetManifest } = await this.graphAndManifest();
      const plan = await planReset(product.folder, this.storeFolder(), resetGraph, resetManifest, this.options.storeRoot);
      if (expected !== undefined && (['store', 'agentPages', 'keptPages', 'unansweredQuestions', 'keptAnswers'] as const).some((key) => JSON.stringify(expected[key]) !== JSON.stringify(plan[key]))) return { ok: false, message: `${place} reset inputs changed since the preview; request a new preview: nothing was removed` };
      await applyReset(product.folder, plan, { resetStore: async () => {
        await this.swapping;
        await this.opening;
        await this.verdictRun;
        await this.problemsFlight?.promise;
        const held = this.fillQueue;
        this.fillQueue = undefined;
        if (held !== undefined) await held.stop();
        await this.storeOpening?.then((owner) => owner?.close());
        this.storeOpening = undefined;
        this.reader = undefined;
        this.opening = undefined;
        await requestStoreReset(storeDatabasePath(this.storeFolder()), contract);
        const fresh = await createDatabaseOwner({ store: storeDatabasePath(this.storeFolder()), connectOnly: true });
        try {
          if (manifests.value !== undefined) await publishValidatedManifests(fresh, manifests.value);
        } finally { await fresh.close(); }
      } });
      this.generation += 1;
      this.storeStamp = undefined;
      this.countsMemo = undefined;
      this.filesMemo = undefined;
      this.manifestMemo = undefined;
      this.problemsCache = undefined;
      this.pins.clear();
      this.fill = { state: 'idle' };
      this.fillExtras = {};
      this.fillRun = undefined;
      this.fillRunId = undefined;
      this.pausedRun = undefined;
      this.pauseRestored = false;
      this.changedPages = undefined;
      this.changedLoaded = false;
      this.writer = { state: 'idle', agent: null, units: [] };
      this.notify();
      return { ok: true, plan };
    } catch (error) {
      return { ok: false, message: `${place} ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      this.resetting = false;
    }
  }

  /**
   * What the two local resets of the settings page would do, for the confirmation: the pages the agent wrote, the pages
   * kept because a person wrote them, the graph store and the questions left unanswered. The resets touch no file the
   * product's own repository holds: the engine holds no copy of the starter set to put back (madarch-64o5.3).
   */
  async dangerPlan(): Promise<{ rewrite: { agentPages: string[]; keptPages: string[] }; fresh: ResetPlan }> {
    const plan = await this.resetPlan();
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
      const { graph, manifest } = await this.graphAndManifest();
      plan = await planReset(product.folder, this.storeFolder(), graph, manifest, this.options.storeRoot);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    this.resetting = true;
    try {
      await applyReset(product.folder, plan, { keepQuestions: true, keepStore: true });
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
    danger: Awaited<ReturnType<KnowledgeProduct['dangerPlan']>>;
    /** Why the two resets cannot say what they would do (a `docs` folder that is a link out of the product, say); both are then refused. */
    dangerError?: string;
    busy: boolean;
  }> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const read = await this.manifestRead(product.folder);
    let danger: Awaited<ReturnType<KnowledgeProduct['dangerPlan']>>;
    let dangerError: string | undefined;
    try {
      danger = await this.dangerPlan();
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

  /**
   * The product's state as one poll reads it (decision 0036, section 8): who it is and the language it writes, its
   * groups, purposes and roles, the repositories and what each was filled to, the fill and the writer, the chosen agent,
   * and each kind the manifest declares with its count from one graph query. The page layer this used to describe is
   * gone: pages and their data are read through `/graphql` (sections 2 to 5), and no kind's name stands here.
   */
  async status(): Promise<WikiStatus> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const publication = manifestPublicationState(this.folder);
    if (publication !== undefined && publication.status !== 'published') {
      const body = this.unpublishedStatus(product);
      const run = await this.runViewOf();
      return { ...body, fill: { ...body.fill, ...(run === null ? {} : { run }) }, publication: publication.status === 'failed' ? 'failed' : 'pending', ...(publication.status === 'failed' ? { publicationMessage: publication.message } : {}) };
    }
    // An unfilled product opens no store merely to answer a poll: without one, the manifest is the checkout's own file.
    const stored = existsSync(storeDatabasePath(this.storeFolder()));
    if (!stored) return this.unpublishedStatus(product);
    await this.open();
    await this.followStoreFill();
    this.restorePause();
    const read = await this.manifestRead(product.folder);
    const run = await this.runViewOf();
    // What the last run's trace and the store's producer results say: the fill's end state, read for the poll.
    const runId = this.fillRunId ?? run?.runId;
    const outcomes = runId === undefined ? undefined : await readProducerOutcomes(this.reader!.owner, { runId }).catch(() => undefined);
    const counts = await this.repositoryCounts();
    this.fillExtras = {
      ...(counts === undefined ? {} : { counts }),
      ...(run === null ? {} : { run }),
      ...(outcomes === undefined ? {} : { outcomes }),
      ...(this.fill.state === 'failed' && this.fill.message !== undefined ? { error: this.errorOf(this.fill.message) } : {}),
    };
    const fill = this.statusFill();
    const manifestFile = join(product.folder, KINDS_FILE);
    const base: WikiStatus = {
      product: { name: product.name, id: product.id },
      // Three states, never mixed: the file is absent (`no-manifest`), it stands in the repository but no fill has read
      // it into the graph yet (`not-filled`), or the graph holds it (`ok`).
      manifest: read.present ? 'not-filled' : existsSync(manifestFile) ? 'not-filled' : 'no-manifest',
      manifestFile,
      language: read.present ? read.manifest.language ?? 'en' : 'en',
      kinds: [],
      groups: read.present ? groupViews(read.manifest) : [],
      repositories: this.repositories().map((repo) => ({ name: repo.name, filled: (this.pins.get(repo.name)?.filledCommits ?? 0) > 0 })),
      filled: await hasSuccessfulFill(this.reader!.owner),
      incomplete: [...this.pins.values()].some((pin) => pin.filledCommits < pin.commits || pin.commits === 0),
      fill: { ...fill, ...(run === null ? {} : { run }) },
      writer: this.writerOf(),
      bounds: { ...WRITER_BOUNDS, editorialRequestsPerPage: this.editorialRequestsPerPage() },
      chosenAgent: this.chosenAgent(),
      roles: {},
      publication: 'done',
    };
    if (!read.present) return base;
    const manifest = read.manifest;
    return {
      ...base,
      manifest: base.filled ? 'ok' : 'not-filled',
      purposes: manifest.purposes === undefined ? undefined : [...manifest.purposes.values()].sort((a, b) => a.order - b.order || byCodePoint(a.id, b.id)).map((purpose) => ({ id: purpose.id, labels: { ...purpose.labels }, order: purpose.order, kinds: [...manifest.kinds.values()].filter((kind) => kind.purpose === purpose.id).map((kind) => kind.name) })),
      roles: Object.fromEntries([...manifest.roles.values()].map((role) => [role.name, { ...(role.open === undefined ? {} : { open: [...role.open] }), lead: [...role.lead] }])),
      kinds: await this.kindCounts(manifest),
    };
  }

  /**
   * The kinds the manifest holds and the count of each, from one graph query over the generated tables (section 8). A
   * manifest that declares a catalogue names every entry of it, catalogue-only ones included: the wiki's menu is the
   * product's whole map, and a kind nothing filled yet stands with a count of zero.
   */
  private async kindCounts(manifest: KindsManifest): Promise<WikiStatus['kinds']> {
    const owner = await this.open();
    const kinds = graphKindsOf(manifest);
    const reader = new GraphReader(owner, this.validAt, undefined, undefined, kinds.declared, kinds.generated, kinds.edges);
    const counts = new Map((await reader.kindCounts().catch(() => [])).map((one) => [one.kind, one.count] as const));
    const names = manifest.catalog === undefined ? [...manifest.kinds.keys()] : [...manifest.catalog.kinds.keys()];
    return names.map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
  }

  /** The writer's state as the poll states it: what it does and the plan it holds, never the units it has done. */
  private writerOf(): WikiStatus['writer'] {
    const { units: _units, ...state } = this.writer;
    return state;
  }

  /**
   * The fill the poll shows: live while it runs, and the store's last finish once it is idle and every repository is
   * filled. The counts are the run's own, never a second count kept here.
   */
  private statusFill(): WikiStatus['fill'] {
    if (this.fill.state === 'running') {
      const progress = this.fillRunId === undefined ? undefined : readFillProgressOf(this.storeFolder(), this.fillRunId, this.traceReader);
      return { ...this.fill, ...(this.fillRunId === undefined ? {} : { runId: this.fillRunId }), ...(progress === undefined ? {} : { progress }) };
    }
    const ended: WikiStatus['fill'] = { ...this.fill, ...this.fillExtras };
    const incomplete = [...this.pins.values()].some((pin) => pin.filledCommits < pin.commits || pin.commits === 0);
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

  private countsMemo: { seq: number; counts?: RepositoryCounts } | undefined;

  /**
   * The counts the end state states: the repository the pages show, read from the store once per publication (the old
   * answer read them on every poll; a publication is what moves them).
   */
  private async repositoryCounts(): Promise<RepositoryCounts | undefined> {
    const owner = this.reader?.owner;
    if (owner === undefined || this.pins.size === 0) return undefined;
    const seq = this.reader?.seq ?? 0;
    if (this.countsMemo?.seq === seq) return this.countsMemo.counts;
    const facts = await new GraphReader(owner, this.validAt).repositoryFactsAll().catch(() => []);
    const declared = this.repositories().map((repository) => repository.name);
    const chosen = facts.find((one) => one.name === declared[0]) ?? facts[0];
    const counts = chosen?.counts;
    this.countsMemo = { seq, ...(counts === undefined ? {} : { counts }) };
    return counts;
  }

  /**
   * What a failed run's message names: the file and line the error was raised at, and the path the run was about. The
   * message is the engine's own (`<file>:<line>:<column>: <words>`), so the three are read from it rather than guessed.
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

  /** A complete status before publication, built only from local product files (decision 0036, section 8). */
  private unpublishedStatus(product: ProductIdentity): WikiStatus {
    const file = join(product.folder, KINDS_FILE);
    return {
      product: { name: product.name, id: product.id },
      manifest: existsSync(file) ? 'not-filled' : 'no-manifest', manifestFile: file,
      language: 'en', kinds: [], groups: [],
      repositories: this.repositories().map((repo) => ({ name: repo.name, filled: false })),
      filled: false, incomplete: false, fill: this.fill, writer: this.writerOf(),
      bounds: { ...WRITER_BOUNDS, editorialRequestsPerPage: this.editorialRequestsPerPage() },
      chosenAgent: this.chosenAgent(), roles: {},
    };
  }

  /** The graph and the manifest the loop's plan reads: the pages a reset would keep or remove, and the kinds it names. */
  private async graphAndManifest(): Promise<{ graph: GraphReader; manifest: KindsManifest }> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const read = await this.manifestRead(product.folder);
    if (!read.present) throw new WikiReadError(`${join(product.folder, KINDS_FILE)}:1: the product manifest is absent from the graph`);
    const kinds = graphKindsOf(read.manifest);
    const owner = await this.open();
    return { graph: new GraphReader(owner, this.validAt, undefined, undefined, kinds.declared, kinds.generated, kinds.edges), manifest: read.manifest };
  }


  /**
   * What the agent spent on one kind (madarch-stm0.4, decision 0035, item 22): every run's model, tokens in and out and
   * cost, per plugin run and field, from the store's mechanism tables. The kind's page and its Markdown list state it.
   */
  async kindUsage(kind: string): Promise<KindUsageView> {
    return await readKindUsage(await this.open(), kind);
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
        await this.loadPins(this.reader.owner).catch(() => undefined);
        // The graph a fill just published has a manifest and templates the worker has not opened yet: warm them beside
        // the answer, never inside it — a status during a fill answers within its own bound (madarch-64o5.3).
        void this.warmReader().catch(() => undefined);
      }
    } catch {
      // The store cannot be read: the answer is what this process last knew.
    }
    let named: Awaited<ReturnType<typeof readRun>>;
    try {
      const identity = this.product();
      if ('message' in identity) return;
      const chain = await readChain(this.reader.owner, identity.name);
      named = chain !== null && chain.state === 'active' && chain.context.activeRunId !== null
        ? await readRun(this.reader.owner, chain.context.activeRunId)
        : (await readRuns(this.reader.owner, identity.name))[0] ?? null;
    } catch {
      return;
    }
    // A queued request belongs to this process until its runner settles it. The chain may still name the previous
    // run before the worker claims this request; adopting that run would report its old end as this press's result.
    if (this.running !== undefined && this.fillRunId !== undefined && named?.runId !== this.fillRunId) return;
    const live = named !== null && ['created', 'planning', 'running', 'pausing', 'cancelling'].includes(named.state) ? named : null;
    if (named !== null && (named.state === 'paused' || named.state === 'cancelled')) {
      this.fillRunId = named.runId;
      this.fill = {
        state: named.state === 'paused' ? 'paused' : 'stopped', runId: named.runId,
        startedAt: new Date(named.createdAt).toISOString(),
        ...(named.state === 'cancelled' ? { finishedAt: new Date(named.updatedAt).toISOString() } : {}),
      };
    }
    if (live !== null) {
      if (this.fill.state !== 'running' || this.fillRunId !== live.runId) {
        this.fillRunId = live.runId;
        this.fill = { state: 'running', runId: live.runId, startedAt: new Date(live.createdAt).toISOString(), commit: 0, commits: 0, gaps: 0 };
      }
      return;
    }
    // A run may finish between polls. Adopt its published end, not a terminal row whose store work is still settling.
    const namedEnd = named !== null && (named.state === 'succeeded' || named.state === 'failed')
      ? await readFillEnd(this.reader.owner, named.runId).catch(() => null) : null;
    if (named !== null && namedEnd !== null && named.runId !== this.fillRunId) {
      this.fillRunId = named.runId;
      this.fill = { state: 'running', runId: named.runId, startedAt: new Date(named.createdAt).toISOString(), commit: 0, commits: 0, gaps: 0 };
    }
    if (this.fill.state === 'running' && this.fillRunId !== undefined) {
      // The end of the run is the row the process that ran it writes after the store is finished (madarch-8bdc.9): the
      // run row's terminal state alone is not the store's publication, because the pins a page reads land after it. A run
      // the process has not ended here yet keeps this answer `running`.
      const end = namedEnd ?? await readFillEnd(this.reader.owner, this.fillRunId).catch(() => null);
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

  /** The persisted run is authoritative; its trace only supplies metrics. */
  private async runViewOf(runId?: string): Promise<FillRunView | null> {
    if (!existsSync(storeDatabasePath(this.storeFolder()))) return null;
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const publication = manifestPublicationState(this.folder);
    const preparing = publication !== undefined && publication.status !== 'published';
    const owner = preparing ? await this.openStore(true) : await this.openStore();
    if (owner === null) return null;
    const record = runId === undefined ? await readLatestRun(owner, product.name) : await readRun(owner, runId);
    if (record === null || record.product !== product.name) return null;
    const configuration = await readRunConfiguration(owner, record.runId);
    const chosenEntry = traceFiles(this.storeFolder()).find((one) => one.runId === record.runId);
    let run: ReturnType<typeof readTraceRunSummary> | undefined;
    if (chosenEntry !== undefined) {
      const stat = statSync(chosenEntry.file);
      const key = `${chosenEntry.file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (this.traceSummaryMemo?.key !== key) {
        this.traceSummaryMemo = { key, value: readTraceRunSummary({ store: this.storeFolder(), runId: record.runId }, this.traceReader) };
      }
      run = this.traceSummaryMemo.value;
    }
    return {
      runId: record.runId,
      state: record.state,
      ...(configuration === null ? {} : { selection: configuration.snapshot.targets ?? null }),
      startedAt: new Date(record.createdAt).toISOString(),
      ...(['succeeded', 'completed_partial', 'cancelled', 'blocked', 'failed'].includes(record.state) ? { finishedAt: new Date(record.updatedAt).toISOString() } : {}),
      wallMs: run?.report.wallMs ?? record.updatedAt - record.createdAt,
      spans: run?.report.spanCount ?? 0,
      slowest: run?.report.names.slice(0, 5).map((name) => ({ name: name.name, count: name.count, selfMs: name.selfMs })) ?? [],
      steps: run?.steps.map((step) => ({
        step: step.step, wallMs: step.wallMs, peakRssBytes: step.peakRssBytes, startRssBytes: step.startRssBytes,
        slowest: step.slowest,
      })) ?? [],
      agentUsage: run?.report.agentUsage ?? agentUsageOf([]),
    };
  }

  /** Canonical history, never inferred from trace size or local status. */
  async fillRuns(runId?: string) {
    const owner = await this.open();
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const records = runId === undefined ? await readRuns(owner, product.name) : [await readRun(owner, runId)];
    return await Promise.all(records.filter((run) => run !== null && run.product === product.name).map(async (run) => {
      const summary = (await this.runViewOf(run!.runId))!;
      return (await readFillRunDetail(owner, run!.runId, { now: (this.options.now?.() ?? new Date()).getTime(), summary }))!;
    }));
  }

  /** A scoped control never targets mutable latest-run fields. */
  async controlFillRun(runId: string, action: 'pause' | 'stop') {
    const owner = await this.open();
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const run = await readRun(owner, runId);
    if (run === null || run.product !== product.name) return { ok: false as const, status: 404, message: `${here()}: this product holds no run ${JSON.stringify(runId)}` };
    if (!(action === 'pause' ? ['running'] : ['created', 'planning', 'running', 'pausing', 'paused']).includes(run.state)) return { ok: false as const, status: 409, message: `${here()}: run ${runId} is ${run.state} and cannot ${action}` };
    if (run.state === 'paused') {
      // A paused worker has ended and holds no live sessions; use the same durable cancellation as its host.
      await cancelRun({ database: owner, product: product.name, clock: Date.now, authority: new Map(), sink: undefined }, { runId, cause: 'stopped from the fill run page' });
    } else {
      await askRunControl(owner, { runId, action, at: Date.now() });
    }
    return { ok: true as const, runId };
  }

  private readonly traceReader = new TraceSpanReader();

  private traceSummaryMemo: { key: string; value: ReturnType<typeof readTraceRunSummary> } | undefined;

  /** The newest run of the store's trace, or the named one. */
  async runView(runId?: string): Promise<FillRunView | null> {
    return this.runViewOf(runId);
  }

  /**
   * A file of a repository as the graph was filled from it, for the source view (decision 0036, section 8): the text of
   * the `source_text` opinion a fill published, never a second read of the checkout.
   */
  async source(repo: string | null, path: string): Promise<SourceRead | undefined> {
    // A fill another process published moves the store before this answer reads it: the follow step the old page context
    // ran, so the commit named here and the kinds the text is read from are the store's, not this process's last look.
    await this.open();
    await this.followStoreFill();
    const held = (await this.sourceOpinions()).get(repo === null ? path : `repos/${repo}/${path}`);
    if (held === undefined) return undefined;
    return { text: held.text, commit: repo === null ? null : this.pins.get(repo)?.commit ?? null };
  }

  /** Every file's text the graph holds, by the address a page's evidence names it with. */
  private async sourceOpinions(): Promise<Map<string, { text: string; repository: string | null; commit: string }>> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const read = await this.manifestRead(product.folder);
    const opinions = new Map<string, { text: string; repository: string | null; commit: string }>();
    if (!read.present) return opinions;
    const kinds = graphKindsOf(read.manifest);
    const owner = await this.open();
    const reader = new GraphReader(owner, this.validAt, undefined, undefined, kinds.declared, kinds.generated, kinds.edges);
    for (const kind of read.manifest.kinds.values()) {
      if (!kind.fields?.some((field) => field.name === 'source_text')) continue;
      let after: string | undefined;
      do {
        const page = await reader.list(kind.name, { limit: 500, ...(after === undefined ? {} : { after }) });
        for (const entity of page.rows) {
          const fields = entity.properties;
          if (typeof fields['path'] !== 'string' || typeof fields['source_text'] !== 'string') continue;
          const repository = typeof fields['repository'] === 'string' ? fields['repository'] : null;
          opinions.set(repository === null ? fields['path'] : `repos/${repository}/${fields['path']}`, { text: fields['source_text'], repository, commit: typeof fields['commit'] === 'string' ? fields['commit'] : '' });
        }
        after = page.next ?? undefined;
      } while (after !== undefined);
    }
    return opinions;
  }

  // ---- the loop of questions and corrections (madarch-m38l.7) ---------------------------------

  /** A person's answer: written into the question's file and committed with the person as author. */
  async answer(_slug: string, _text: string): Promise<Answered> {
    throw new LoopRefusal(410, `${resolve(this.folder, 'madarch/catalog.yaml')}:1: authored entities now live in the database. Open the kind in the catalogue and use New or Edit, or use madarch entity. Lifecycle operations are not available on this path.`);
  }

  async proposeTask(_question: string, _choice: TaskChoice, _asked?: 'en' | 'ru'): Promise<TaskProposal> {
    throw new LoopRefusal(410, `${join(this.folder, KINDS_FILE)}:1: create an authored entity from its kind instead. Task lifecycle commands are not available.`);
  }

  /** Create a task only after the reader confirms its proposed scope: a product file, committed as the reader. */
  async createTask(_input: { question: string; title: string; grounds: string[]; scope: TaskScope[] }): Promise<{ task: PlannedTask; state: 'created'; committed: boolean; note?: string; commit?: string }> {
    throw new LoopRefusal(410, `${resolve(this.folder, 'madarch/catalog.yaml')}:1: authored entities now live in the database. Open the kind in the catalogue and use New or Edit, or use madarch entity. Lifecycle operations are not available on this path.`);
  }

  /** Closes a task by hand: the file says who and when, and the change is committed as the reader. */
  async closeTask(_id: string): Promise<{ task: PlannedTask; state: 'closed'; committed: boolean; note?: string; commit?: string }> {
    throw new LoopRefusal(410, `${resolve(this.folder, 'madarch/catalog.yaml')}:1: authored entities now live in the database. Open the kind in the catalogue and use New or Edit, or use madarch entity. Lifecycle operations are not available on this path.`);
  }

  async runTask(_id: string): Promise<{ ok: true; task: TaskRow; pages: readonly string[]; fill: FillState } | { ok: false; message: string }> {
    return { ok: false, message: `${join(this.folder, KINDS_FILE)}:1: authored task lifecycle commands are not available. CRUD never starts an agent or fill.` };
  }

  /** A person's correction of a statement: a new file, committed with the person as author. */
  async correct(_statement: string, _reason: string): Promise<Corrected> {
    throw new LoopRefusal(410, `${resolve(this.folder, 'madarch/catalog.yaml')}:1: authored entities now live in the database. Open the kind in the catalogue and use New or Edit, or use madarch entity. Lifecycle operations are not available on this path.`);
  }

  async problems(): Promise<ProblemListing> {
    return await this.problemListing();
  }

  /** The listing the dismissal reads: collected once per key, from the graph and the manifest. */
  private async problemListing(): Promise<ProblemListing> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const file = join(product.folder, KINDS_FILE);
    // A product the graph holds no kinds manifest of is not judged: the answer says so, rather than a count of a
    // checkout the wiki no longer reads (madarch-hsqs stage C).
    const read = await this.manifestRead(product.folder);
    if (!read.present) return { problems: [], categories: [], sections: { code: 0, documents: 0, wiki: 0 }, open: 0, closed: 0, dismissed: 0, notes: [{ message: `the product has no ${file} in the graph yet: start a fill to read the product repository` }] };
    const owner = await this.open();
    return await this.problemsFor(await this.problemsKey(), owner);
  }

  /**
   * What the Problems page reads, as one key: the graph revision (every product file the page reads is the graph's at
   * that revision), the pins it is shown beside, the writer's unplaced plan and the manifest. The revision the change
   * stream moves with is not part of it: a fill that reads a commit moves that revision without changing a problem
   * (madarch-m38l.19). A read of a page never stamps the checkout (madarch-hsqs stage C).
   */
  private async problemsKey(revision?: string): Promise<string> {
    return `${await this.problemInputsKey(revision)}|${this.storeKey()}`;
  }

  /** What the Problems listing reads besides the store: the graph revision and the writer's plan. */
  private async problemInputsKey(revision?: string): Promise<string> {
    const plan = this.writer.plan === undefined ? '' : this.writer.plan.unplaced.map((entry) => `${entry.kind}:${entry.slug}`).join(',');
    return `${plan}|${revision ?? await this.graphRevision()}`;
  }

  /** Repository pins beside the graph publication stamp; local reader generations do not change graph facts. */
  private storeKey(): string {
    return [...this.pins.values()].map((pin) => `${pin.name}@${pin.commit}`).join(',');
  }

  /** Collects the listing once per key: a reader that asks while it runs waits for the same collection. */
  private problemsFor(key: string, owner: DatabaseOwner): Promise<ProblemListing> {
    if (this.problemsCache?.key === key) return Promise.resolve(this.problemsCache.listing);
    if (this.problemsFlight?.key === key) return this.problemsFlight.promise;
    const sequence = (this.problemsSequence += 1);
    const promise = this.collectProblems(owner)
      .then((listing) => {
        if (this.problemsCache === undefined || this.problemsCache.sequence < sequence) this.problemsCache = { key, sequence, listing };
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

  private async collectProblems(owner: DatabaseOwner): Promise<ProblemListing> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const read = await this.manifestRead(product.folder);
    if (!read.present) throw new WikiReadError(`the product has no ${join(product.folder, KINDS_FILE)}: the wiki shows the kinds that file declares`);
    const manifest = read.manifest;
    const kinds = graphKindsOf(manifest);
    const graph = new GraphReader(owner, () => this.validAt(), undefined, undefined, kinds.declared, kinds.generated, kinds.edges);
    const repository = this.singleRepository();
    const files = await this.productFiles();
    const dismissals = { items: await graphProblemDismissals(graph), problems: [] };
    const dismissed = new Set(dismissals.items.map((item) => item.id));
    const markdown = new Map((await graphMarkdownEntities(graph, pageOpinionKinds(manifest, kinds.generated))).entities.map((entity) => [entity.id, entity] as const));
    const resolver = new Resolver({
      graph,
      documentKinds: [...manifest.kinds.values()].filter((kind) => kind.fields?.some((field) => field.name === 'markdown')).map((kind) => kind.name),
      markdown,
      declared: (kind) => manifest.kinds.has(kind),
      repositories: () => [...this.pins.keys()].sort(byCodePoint),
      locate: () => undefined,
    });
    return await collectProblems({
      productFolder: this.options.productFolder, owner, files, manifest,
      // The listing reads the same revision every other read does: a fill that lands meanwhile changes the next listing, not this one.
      graph,
      findingKinds: [...manifest.kinds.values()].filter((kind) => kind.findings === true).map((kind) => kind.name).sort(),
      settings: manifest.problems ?? defaultSettings(),
      ...(repository === undefined ? {} : { repository }),
      resolve: (url) => resolver.resolve(url), findings: manifest.findings,
      ...(this.writer.plan === undefined ? {} : { unplaced: this.writer.plan.unplaced }),
      dismissed,
    });
  }

  /**
   * «Не проблема»: the person's reason becomes a file in the product repository, committed as the person, and the
   * problem is left out of the page from now on. A problem the page no longer lists is refused with its id.
   */
  async dismissProblem(id: string, reason: string): Promise<{ file: string; committed: boolean; note?: string; commit?: string }> {
    const listing = await this.problems();
    const problem = listing.problems.find((candidate) => candidate.id === id);
    if (problem === undefined) throw new LoopRefusal(404, `${join(this.folder, 'docs/problems')}:1: there is no problem ${JSON.stringify(id)} in the current listing: its rule, place or inputs changed, so the page offers no such problem`);
    const [rule, ...rest] = id.split('\u0000');
    const identity = rest.join('\u0000');
    if (rule === undefined || identity === '') throw new LoopRefusal(400, `${join(this.folder, 'docs/problems')}:1: the problem id ${JSON.stringify(id)} is not <rule>\\0<identity>`);
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
  async createProblemTask(_id: string): Promise<{ task: PlannedTask; state: 'created'; committed: boolean; note?: string; commit?: string }> {
    throw new LoopRefusal(410, `${resolve(this.folder, 'madarch/catalog.yaml')}:1: authored entities now live in the database. Open the kind in the catalogue and use New or Edit, or use madarch entity. Lifecycle operations are not available on this path.`);
  }

  async refreshPlan(language?: string): Promise<{ available: true; plan: RefreshPlan; language: { from: string | null; to: string; changed: boolean }; commitsNotRead: number | null } | { available: false; reason: string }> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const file = join(product.folder, KINDS_FILE);
    const read = await this.manifestRead(product.folder);
    // A product with no publication yet is said so by the one sentence a reader can act on: start the fill once.
    if (!read.present) return { available: false, reason: this.pins.size === 0 ? 'nothing has been read from the code yet: start the fill once to read it' : `the product has no ${file} in the graph` };
    const repository = this.singleRepository();
    if (repository === undefined) return { available: false, reason: this.pins.size === 0 ? 'nothing has been read from the code yet: start the fill once to read it' : 'the pages are written from one code repository and this product declares more or fewer' };
    const current = read.manifest.language ?? 'en';
    const wanted = language ?? current;
    const written = this.pagesLanguage();
    const changed = written !== undefined ? written !== wanted : language !== undefined && language !== current;
    const owner = await this.open();
    const { graph } = await this.graphAndManifest();
    const planned = await planRefresh({ owner, graph, manifest: read.manifest, productFolder: this.options.productFolder, repository, commit: repository.commit, language: { from: written ?? current, to: wanted, changed } });
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
    this.publicationWait.abort();
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
    await this.storeOpening?.then((owner) => owner?.close()).catch(() => undefined);
    this.storeOpening = undefined;
    this.reader = undefined;
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
    const results = await Promise.allSettled([...this.products.values()].map((product) => product.close()));
    this.products.clear();
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
