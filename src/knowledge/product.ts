/**
 * One product's knowledge wiki (decision 0029): the product's own graph store,
 * the fill that writes it, and the reads that draw its pages.
 *
 * The store is a PGlite database under the machine's state (outside the
 * product repository: 0023, a derived index is rebuilt, never transferred),
 * named by the product's id, which survives a rename of its folder. A fill
 * runs the extract driver over each repository the manifest declares, into
 * that store, one commit at a time; after each commit the pages that are open
 * are told to read again (`subscribe`). What each repository was filled to is
 * kept in the store (`knowledge_fill`), so a source view shows the bytes the
 * graph's spans were read from, and a restarted server still knows.
 */
import { glossaryTerms, termLinks, type GlossaryTerm } from './glossary.js';
import { GUIDE_OUTPUTS } from '../writer/guides/host-contract.js';
import type { GuideContextFor, GuideHostFor } from '../writer/guides/host.js';
import type { GuideKind, GuideLocale } from '../writer/guides/model.js';
import { readGuidePage } from '../writer/guides/read.js';
import { createGuideReadFactories, guideProductPin } from '../writer/guides/writer.js';
import { createGraphStore } from '../graph/index.js';
import { createGitSnapshotSource } from '../fill/snapshot.js';
import { detectDocumentLanguage, localizedSourcePath, parseLocalizedSource, type LocalizedDocumentSource } from '../writer/localized-source.js';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseOwner, OuterTransaction } from '../adapters/database-owner.js';
import { RemoteOwner } from './remote-owner.js';
import { byCodePoint } from '../model/order.js';
import { MANIFEST_FILE, readProduct, type ProductIdentity } from '../product/manifest.js';
import { selfCommand } from '../product/self-command.js';
import { insideFolder, homeKind, KINDS_FILE, readKinds, setKindsLanguage, type Finding, type KindsManifest } from './kinds.js';
import { linesOf } from './lines.js';
import { applyReset, planReset, type ResetPlan } from './reset.js';
import { parseMessage, type FromWorker, type RepositoryPin, type ToWorker, type WorkerStart } from './fill-protocol.js';
import { snapshotNumbers } from './fill-worker.js';
import { locationOf, type RenderContext } from './blocks.js';
import { GraphReader } from './graph-read.js';
import { treeReadProducer } from '../extract/driver/index.js';
import { TREE_EXTRACTORS, HISTORY_EXTRACTOR } from '../extract/driver/extractors.js';
import { selectHistory, withHistoryLinks, type HistoryContext, type HistorySelection } from './temporal.js';
import { markdownFilesBelow, readMarkdownEntities, type MarkdownEntity } from './markdown.js';
import type { AgentOffer, Block, DocumentListing, DocumentPage, DocumentRef, FillState, Neighborhood, PageModel, PlannedMarkView, PlannedSectionView, WikiStatus, WriterState, WriterUnit } from './model.js';
import { neighborhoodOf } from './diagrams.js';
import { anchorLines, titleOfAnchor } from './anchors.js';
import { adapterOf, installAdapter, makeUnitAgent, offers, queryAgentChoices, WRITER_AGENTS, WRITER_BOUNDS } from './agents.js';
import { emptyModelAssignments, isModelRole, modelPair, resolveModelRoles, type ModelAssignments, type ModelPair, type ModelRole, type ModelRoleView } from './model-roles.js';
import type { AgentChoices } from '../fill/acp-choices.js';
import { addStarterItems, currentOffers, filesAPersonEdited, replaceWithStarterSet, upgradeStarterSet, type StarterOffer, type UpgradeReport, rememberChangedStarterFileIfOwned } from './starter-upgrade.js';
import { fileJournal, journalFolder, journalOfUnit, newRunId, type Journal, type PageJournal } from '../writer/journal.js';
import { productSlug, PRODUCT_PATH, type ToolAnswer, type ToolClient, type UnitAgent } from '../writer/index.js';
import { CONTENT_LANGUAGES } from '../writer/prompts.js';
import type { DraftEnv } from '../product/home.js';
import { findSubject, kindSummaries, productTitleOf, renderPage, listEntities, type PageResult } from './render.js';
import { indexCounts, statementsRelyingOn } from './index/queries.js';
import { documentSections } from './index/sections.js';
import { webLink } from './index/web-link.js';

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
import { readProblemDismissals, writeProblemDismissal } from '../loop/problem-files.js';

const execFileAsync = promisify(execFile);

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
/** A read the wiki cannot make and can say why: its message is for the reader, who sees it in place of the page. */
export class WikiReadError extends Error {}

/**
 * The folder a product's knowledge is kept in: named by the product's id under the knowledge root. An id with a
 * separator or a dot segment would name another place, so it names none.
 */
export function storeFolderOf(storeRoot: string, id: string, manifest: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new WikiReadError(`${manifest}: the product id ${JSON.stringify(id)} cannot name a folder (letters, digits, dots, hyphens and underscores only): the wiki keeps nothing for it`);
  }
  return join(storeRoot, id);
}

/** A fill worker as the server holds it: what it is told, what it says, and how it ends. */
export interface FillWorkerHandle {
  send(message: ToWorker): void;
  readonly lines: AsyncIterable<string>;
  /** Resolves with the exit code once the worker has ended and its output is read. */
  readonly exited: Promise<number>;
  /** The end of what the worker wrote on its standard error. */
  stderr(): string;
  kill(): void;
}

/** Starts the fill worker; the production one starts `madarch knowledge-fill-worker`, a process of its own. */
export type FillWorkerFactory = () => FillWorkerHandle;

/** The worker as a child process of this program (a checkout's script, or the release binary itself). */
export function spawnFillWorker(): FillWorkerHandle {
  const { command, args } = selfCommand(['knowledge-fill-worker']);
  const child = Bun.spawn([command, ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: process.env });
  let tail = '';
  void (async () => {
    for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) tail = (tail + new TextDecoder().decode(chunk)).slice(-4000);
  })();
  return {
    send: (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        void child.stdin.flush();
      } catch {
        // the worker is gone; its exit says so
      }
    },
    lines: linesOf(child.stdout as unknown as AsyncIterable<Uint8Array>),
    exited: child.exited,
    stderr: () => tail,
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

/** How long a worker may take to end after it was told to stop, in milliseconds, before it is killed. */
const STOP_GRACE_MS = 20_000;
/** How long the server keeps the previous snapshot open after a newer one is read, so a request in flight on it ends. */
const SNAPSHOT_KEEP_MS = 3_000;
/** A reader nobody has asked for this long is closed, and its memory (a PGlite is about a gigabyte) given back; the next page opens it again. */
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
  /** Starts the fill worker; tests inject one. */
  workerFactory?: FillWorkerFactory;
  /** The least time between two snapshots of the store the fill writes, in milliseconds (default 8000). */
  snapshotMs?: number;
  /** Asks an agent which models it offers; the production one starts its ACP adapter. Tests inject. */
  choicesQuery?: (agentId: string, env: DraftEnv) => Promise<{ ok: true; choices: AgentChoices } | { ok: false; message: string }>;
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
  return async (owner: DatabaseOwner, pin: Pick<RepositoryPin, 'name' | 'scope' | 'head'>, validAt: string, selection: HistorySelection): Promise<HistoryContext> => {
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

export class KnowledgeProduct {
  /** The store the reads are made on: a snapshot of the primary store, or an empty one before any fill (see `fill-protocol.ts`). */
  private reader: { owner: DatabaseOwner; seq: number; path: string } | undefined;
  private opening: Promise<void> | undefined;
  private fill: FillState = { state: 'idle' };
  private running: Promise<void> | undefined;
  private worker: FillWorkerHandle | undefined;
  private stopping = false;
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

  constructor(private readonly options: KnowledgeProductOptions) {}

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
    return storeFolderOf(this.options.storeRoot, product.id, join(this.options.productFolder, 'workspace.yaml'));
  }

  /** The primary store: the fill worker's alone while it runs. */
  private graphPath(): string {
    return join(this.storeFolder(), 'graph');
  }

  /** The folder the snapshots of the primary store are made in, one numbered folder each. */
  private readRoot(): string {
    return join(this.storeFolder(), 'read');
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
      if (seq === undefined && this.worker === undefined && existsSync(this.graphPath())) {
        const temporary = join(root, '1.tmp');
        rmSync(temporary, { recursive: true, force: true });
        cpSync(this.graphPath(), temporary, { recursive: true });
        await rename(temporary, join(root, '1'));
        seq = 1;
      }
      if (seq === undefined) {
        seq = 0;
        created = true;
      }
      const path = join(root, String(seq));
      // The snapshot is read by a process of its own, so that opening it never holds up this server's thread.
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
      return rows.rows.map((row):RepositoryPin=>({name:String(row['repo']),scope:String(row['scope']),head:String(row['head']),commit:String(row['commit_hash']),effectiveTime:String(row['effective_time']),commits:Number(row['commits']),filledCommits:Number(row['filled_commits'])}));
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
  private swapReader(seq: number, pins: readonly RepositoryPin[]): Promise<void> {
    const work = this.swapping.then(async () => {
      if (this.closed) return;
      await this.open();
      const held = this.reader!;
      // A delayed or already-consumed notice cannot change the active snapshot's pins.
      if (held.seq >= seq) return;
      const path = join(this.readRoot(), String(seq));
      const owner = new RemoteOwner(path, { create: false });
      try {
        await owner.ready;
        // The new process answers its first statements slowly; warm before changing either reader or pins.
        if (held.owner instanceof RemoteOwner) await owner.warm(held.owner.recent());
      } catch(error) {await owner.close().catch(()=>undefined);throw error;}
      this.reader = { owner, seq, path };
      // What the repositories were filled to is applied with the snapshot it belongs to: a source is read at the commit
      // the graph it is shown beside was filled from.
      this.replacePins(pins);
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
    const current = read.manifest.language ?? 'en';
    const wanted = options.language ?? current;
    if (!Object.keys(CONTENT_LANGUAGES).includes(wanted)) {
      return { started: false, message: `"language" is ${JSON.stringify(wanted)}: the pages are written in ${Object.keys(CONTENT_LANGUAGES).join(' or ')}`, fill: this.fill };
    }
    // The pages are in the language they were last written whole in: a run that failed half way leaves the old one on
    // record, so the next press writes them again. Pages from before the record are judged by what this press asks.
    const written = this.pagesLanguage();
    const languageChanged = written !== undefined ? written !== wanted : options.language !== undefined && options.language !== current;
    if (options.language !== undefined && options.language !== read.manifest.language) {
      const set = setKindsLanguage(product.folder, options.language);
      if (set !== undefined) return { started: false, message: set, fill: this.fill };
      this.notify();
    }
    // The slot is claimed before anything is awaited, so two asks in the store's opening are not two fills.
    this.stopping = false;
    this.fill = { state: 'running', startedAt: (this.options.now?.() ?? new Date()).toISOString(), commit: 0, commits: 0, gaps: 0 };
    const chosen = this.chosenAgent();
    this.writer = chosen === null ? { state: 'idle', agent: null, units: [] } : { state: 'waiting', agent: chosen, units: [] };
    this.notify();
    this.running = this.runJob(product, repositories, { language: wanted, languageChanged, languageFrom: written ?? current, ...(options.task === undefined ? {} : { task: options.task }), ...(options.taskPages === undefined ? {} : { taskPages: options.taskPages }) }).finally(() => {
      // A fill that did not reach its end leaves the agent stage unstarted, not waiting for ever.
      if (this.writer.state === 'waiting') this.writer = { ...this.writer, state: 'idle' };
      this.running = undefined;
      this.worker = undefined;
    });
    return { started: true, fill: this.fill };
  }

  /**
   * One fill: a worker process reads the repositories into the primary store and, when an agent is chosen, runs the
   * writer's work; this method hears the worker and keeps the fill's and the writer's state, the pins and the reader.
   */
  private async runJob(product: ProductIdentity, repositories: readonly { name: string; path: string }[], run: { language: string; languageChanged: boolean; languageFrom: string; task?: string; taskPages?: readonly string[] }): Promise<void> {
    const failFill = (message: string, code: string): void => {
      this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message, code };
      this.notify();
    };
    try {
      await this.open();
    } catch (error) {
      failFill(`the product's graph store could not be opened: ${error instanceof Error ? error.message : String(error)}`, 'store');
      return;
    }
    // A wiki that began shutting down while its store opened starts no worker.
    if (this.closed) {
      this.fill = { state: 'idle', message: 'the wiki shut down before the fill started' };
      this.notify();
      return;
    }
    let worker: FillWorkerHandle;
    try {
      worker = (this.options.workerFactory ?? spawnFillWorker)();
    } catch (error) {
      failFill(`the fill worker could not be started: ${error instanceof Error ? error.message : String(error)}`, 'worker-start');
      return;
    }
    this.worker = worker;
    const start: WorkerStart = {
      type: 'start',
      productFolder: product.folder,
      productName: product.name,
      graphPath: this.graphPath(),
      readRoot: this.readRoot(),
      repositories: repositories.map((repo) => ({ name: repo.name, path: repo.path })),
      writer: this.writer.agent !== null,
      language: run.language,
      languageChanged: run.languageChanged,
      languageFrom: run.languageFrom,
      ...(run.task === undefined ? {} : { task: run.task }),
      ...(run.taskPages === undefined ? {} : { taskPages: [...run.taskPages] }),
      snapshotMs: this.options.snapshotMs ?? 8_000,
    };
    worker.send(start);
    const calls = new Map<number, (value: { answer: ToolAnswer; finished: boolean }) => void>();
    let callIds = 0;
    const finishedUnits = new Map<string, boolean>();
    let workerGone = false;
    const unitsRunning: Promise<void>[] = [];
    let agent: (UnitAgent & { close(): Promise<void> }) | undefined;
    const setUnit = (unit: string, change: Partial<WriterUnit>): void => {
      this.writer = { ...this.writer, units: this.writer.units.map((held) => (held.unit === unit ? { ...held, ...change } : held)) };
    };
    const now = (): string => (this.options.now?.() ?? new Date()).toISOString();
    const heard = async (message: FromWorker): Promise<void> => {
      switch (message.type) {
        case 'rebuild':
          this.fill = {...this.fill, rebuilt: message.reason}; this.notify(); return;
        case 'progress':
          this.fill = { ...this.fill, repository: message.repository, commit: message.commit, commits: message.commits };
          this.notify();
          return;
        case 'phase':
          this.fill = { ...this.fill, repository: message.repository, phase: message.phase, commits: message.commits, newCommits: message.newCommits };
          this.notify();
          return;
        case 'snapshot':
          // Not waited for: the worker's tool calls go on while the snapshot is opened beside the one in use.
          this.swapReader(message.seq, message.pins).catch((error: unknown) => {
            // The reads stay on the snapshot they had; the next snapshot tries again.
            this.options.errorLog?.(`the knowledge wiki could not read the snapshot ${message.seq} of ${this.readRoot()}: ${error instanceof Error ? error.message : String(error)}`);
          }).finally(() => this.notify());
          return;
        case 'fill':
          // The end of the fill is shown once the last snapshot is being read: a page opened at "done" shows everything.
          await this.swapping.catch(() => undefined);
          if (message.state === 'done') this.fill = { state: 'done', startedAt: this.fill.startedAt, finishedAt: now(), gaps: message.gaps, ...(this.fill.rebuilt === undefined ? {} : {rebuilt:this.fill.rebuilt}) };
          else if (message.state === 'stopped') this.fill = { state: 'idle', message: 'the fill was stopped; it resumes where it stopped' };
          else this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: now(), message: message.message, ...(message.code === undefined ? {} : { code: message.code }) };
          this.notify();
          return;
        case 'agent-wanted': {
          const chosen = this.writer.agent;
          if (chosen === null) { worker.send({ type: 'agent-failed', message: 'no agent was chosen for this press' }); return; }
          const preferences = this.chosenAgent();
          const journal = fileJournal(journalFolder(this.storeFolder()), newRunId(this.options.now?.()));
          const built = this.options.agentFactory === undefined
            ? makeUnitAgent(chosen.id, this.env, (line) => this.options.errorLog?.(`the agent ${chosen.id}: ${line}`), preferences === null ? undefined : { ...(preferences.model === undefined ? {} : { model: preferences.model }), ...(preferences.reasoning === undefined ? {} : { reasoning: preferences.reasoning }) }, journal)
            : this.options.agentFactory(chosen.id, journal);
          if ('error' in built) { worker.send({ type: 'agent-failed', message: built.error }); return; }
          // A unit never starts once the wiki is shutting down, even if the agent was closed before its connection opened.
          const made: UnitAgent & { close(): Promise<void> } = {
            run: async (request) => {
              if (this.stopping) throw new Error('the wiki is shutting down; this unit did not start');
              return await built.run(request);
            },
            ...(built.warnings === undefined ? {} : { warnings: () => built.warnings!() }),
            close: () => built.close(),
          };
          this.writerAgent = made;
          agent = made;
          let slug: string;
          try {
            slug = productSlug(product.name);
          } catch (error) {
            await made.close();
            this.writerAgent = undefined;
            worker.send({ type: 'agent-failed', message: error instanceof Error ? error.message : String(error) });
            return;
          }
          this.writer = { state: 'running', agent: chosen, units: [{ unit: `product:${slug}`, path: PRODUCT_PATH, state: 'waiting' }], startedAt: now(), ...(this.writer.plan === undefined ? {} : { plan: this.writer.plan }) };
          this.notify();
          worker.send({ type: 'agent-ready' });
          return;
        }
        case 'plan':
          // Which pages the refresh touches and why, shown before the agent starts.
          this.writer = { ...this.writer, plan: message.plan };
          this.notify();
          return;
        case 'unit-start':
          if (!this.writer.units.some((unit) => unit.unit === message.unit)) this.writer = { ...this.writer, units: [...this.writer.units, { unit: message.unit, path: message.path, state: 'writing' }] };
          else setUnit(message.unit, { state: 'writing' });
          this.writer = { ...this.writer, current: message.unit };
          this.notify();
          return;
        case 'unit': {
          // The agent runs here, in the server; each tool call of the unit is answered by the worker, which holds the graph.
          const tools: ToolClient = {
            definitions: message.definitions,
            call: (name, args) => new Promise((resolve) => {
              if (workerGone) { resolve({ isError: true, answer: { error: 'worker-gone', message: 'the fill worker has ended; nothing more is answered for this unit' } } as never); return; }
              const callId = (callIds += 1);
              calls.set(callId, (value) => { finishedUnits.set(message.id, value.finished); resolve(value.answer as never); });
              worker.send({ type: 'tool', callId, unit: message.id, name, args });
            }),
            finished: () => finishedUnits.get(message.id) === true,
          };
          const running = (agent ?? (() => { throw new Error('src/knowledge/product.ts: a unit was asked before the agent was ready'); })()).run({ id: message.id, prompt: message.prompt, tools }).then(
            () => worker.send({ type: 'unit-end', id: message.id }),
            (error: unknown) => worker.send({ type: 'unit-end', id: message.id, error: error instanceof Error ? error.message : String(error) }),
          );
          unitsRunning.push(running);
          return;
        }
        case 'tool-result':
          calls.get(message.callId)?.({ answer: message.answer as ToolAnswer, finished: message.finished });
          calls.delete(message.callId);
          return;
        case 'unit-outcome': {
          const outcome = message.outcome;
          setUnit(outcome.unit, { state: outcome.status === 'written' ? 'written' : outcome.status === 'failed' ? 'failed' : 'not-written', writeAttempts: outcome.writeAttempts, calls: outcome.calls, refusals: outcome.refusals });
          if (outcome.status === 'written' && outcome.unit.startsWith('product:') && outcome.domains.length > 0) {
            this.writer = { ...this.writer, units: [...this.writer.units, ...outcome.domains.map((domain): WriterUnit => ({ unit: `domain:${domain.slug}`, path: `docs/domains/${domain.slug}.md`, state: 'waiting' }))] };
          }
          this.notify();
          return;
        }
        case 'page':
          this.notify();
          return;
        case 'writer':
          await this.swapping.catch(() => undefined);
          if (message.state === 'done') {
            try {
              await writeFile(join(this.storeFolder(), 'pages-language.json'), `${JSON.stringify({ language: run.language })}\n`, 'utf8');
            } catch (error) {
              this.options.errorLog?.(`the knowledge wiki could not record the language of the pages in ${this.storeFolder()}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          this.writer = message.state === 'done'
            ? { ...this.writer, state: 'done', current: undefined, finishedAt: now(), asked: message.asked, ...(message.message === undefined ? {} : { message: message.message }) }
            : { ...this.writer, state: 'failed', current: undefined, finishedAt: now(), asked: message.asked, message: message.message, ...(message.code === undefined ? {} : { code: message.code }) };
          if (message.state !== 'done') {
            // A writer that ended without every page says which units it left unwritten, with the reason each ended on,
            // on the process's error stream: the page a reader watches names the first problem, and this is the whole of it.
            const unwritten = this.writer.units.filter((unit) => unit.state !== 'written')
              .map((unit) => `${unit.unit}=${unit.state}${unit.refusals === undefined || unit.refusals.length === 0 ? '' : ` (${unit.refusals[0]!.rule} at line ${unit.refusals[0]!.line}: ${unit.refusals[0]!.message.slice(0, 400)})`}`);
            process.stderr.write(`knowledge writer failed: ${message.code ?? 'units'}; unwritten: ${unwritten.join('; ') || 'no unit is unwritten, so the failure is the index or the questions'}; ${message.message ?? ''}\n`);
          }
          this.notify();
          return;
        case 'log':
          // A line the worker could not put on a page — a document it could not read, a kind the documents lack — goes to
          // the host's log, where a person serving the product reads it.
          this.options.errorLog?.(message.line);
          return;
      }
    };
    try {
      for await (const line of worker.lines) {
        let message: FromWorker;
        try {
          message = parseMessage<FromWorker>(line, 'the fill worker');
        } catch (error) {
          this.options.errorLog?.(error instanceof Error ? error.message : String(error));
          continue;
        }
        await heard(message);
      }
    } catch (error) {
      this.options.errorLog?.(`the knowledge wiki lost the fill worker's output: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The worker's output has ended: a tool call still waiting for its answer never gets one, and the unit that made it
    // is answered with an error so its agent can end.
    workerGone = true;
    for (const [callId, answer] of [...calls]) {
      calls.delete(callId);
      answer({ answer: { isError: true, answer: { error: 'worker-gone', message: 'the fill worker has ended; nothing more is answered for this unit' } } as unknown as ToolAnswer, finished: true });
    }
    const code = await worker.exited;
    await Promise.allSettled(unitsRunning);
    await this.writerAgent?.close().catch(() => undefined);
    this.writerAgent = undefined;
    if (this.fill.state === 'done') {
      try {
        await writeFile(join(this.storeFolder(), 'last-fill.json'), `${JSON.stringify({ finishedAt: this.fill.finishedAt ?? now() })}\n`, 'utf8');
      } catch (error) {
        this.options.errorLog?.(`the knowledge wiki could not record when the fill ended in ${this.storeFolder()}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.fill.state === 'running') {
      failFill(`the fill worker ended with exit code ${code} before the fill was done: ${worker.stderr().trim().split('\n').slice(-6).join(' | ') || 'it said nothing on standard error'}`, 'worker-exit');
    }
    if (this.writer.state === 'running') {
      this.writer = { ...this.writer, state: 'failed', current: undefined, finishedAt: now(), code: 'worker-exit', message: `the fill worker ended with exit code ${code} while the agent was writing: ${worker.stderr().trim().split('\n').slice(-6).join(' | ') || 'it said nothing on standard error'}` };
      this.notify();
    }
  }

  // ---- the agent stage ---------------------------------------------------------------------

  /** What the agent did to write one page: the records of the newest run that wrote it, or of the run asked for. */
  journalOf(pageId: string, run?: string): PageJournal {
    if (!/^(product|domain):[a-z][a-z0-9-]*$/.test(pageId)) {
      throw new WikiReadError(`${JSON.stringify(pageId)} is no page an agent writes: the journal is kept per product or domain page (product:<slug>, domain:<slug>)`);
    }
    return journalOfUnit(journalFolder(this.storeFolder()), pageId, run);
  }

  private get env(): DraftEnv {
    return this.options.env ?? process.env;
  }

  private choiceFile(): string {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    return join(this.options.storeRoot, product.id, 'writer.json');
  }

  /**
   * What the choice file holds (madarch-j6ho.2): the writer's pair at the top level, as the earlier releases wrote it,
   * and the other roles under `roles`. A role that is absent is unassigned, never guessed.
   */
  private modelAssignments(): ModelAssignments {
    const file = this.choiceFile();
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyModelAssignments();
      throw new Error(`${file}: the model roles cannot be read: ${(error as Error).message}`);
    }
    let body: { agent?: unknown; model?: unknown; reasoning?: unknown; roles?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch (error) {
      throw new Error(`${file}:1: the model roles are not JSON: ${(error as Error).message}; delete the file to choose again`);
    }
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
    for (const key of Object.keys(heldRoles)) if (!isModelRole(key)) throw new Error(`${file}:1: roles.${key} is not a role madarch knows (${['writing', 'classification', 'analysis'].join(', ')})`);
    const writing = typeof body.agent === 'string'
      ? pair(body, 'the writer choice')
      : heldRoles.writing === undefined
        ? null
        : pair(heldRoles.writing, 'roles.writing');
    const other = (role: 'classification' | 'analysis'): ModelPair | null => heldRoles[role] === undefined ? null : pair(heldRoles[role], `roles.${role}`);
    return { writing, classification: other('classification'), analysis: other('analysis') };
  }

  /** The writer's pair, read as the writing role; compatibility for the callers that ask for one agent. */
  private choiceRecord(): ModelPair | null {
    return this.modelAssignments().writing;
  }

  private async writeAssignments(assignments: ModelAssignments): Promise<void> {
    const file = this.choiceFile();
    const any = assignments.writing !== null || assignments.classification !== null || assignments.analysis !== null;
    if (!any) {
      await rm(file, { force: true });
      return;
    }
    const body: Record<string, unknown> = {};
    if (assignments.writing !== null) {
      body.agent = assignments.writing.agent;
      if (assignments.writing.model !== undefined) body.model = assignments.writing.model;
      if (assignments.writing.reasoning !== undefined) body.reasoning = assignments.writing.reasoning;
    }
    const roles: Record<string, ModelPair> = {};
    if (assignments.classification !== null) roles.classification = assignments.classification;
    if (assignments.analysis !== null) roles.analysis = assignments.analysis;
    if (Object.keys(roles).length > 0) body.roles = roles;
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
    bounds: typeof WRITER_BOUNDS;
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
      bounds: WRITER_BOUNDS,
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
    const read = this.kinds(product.folder);
    if (!read.present) return { absent: true, file: read.file };
    const owner = snapshot?.owner ?? await this.open();
    const currentGraph = new GraphReader(owner, snapshot === undefined ? this.validAt : () => snapshot.validAt, undefined, snapshot?.transaction);
    const scope = history === undefined ? undefined : (snapshot?.pins ?? this.pins).get(history.repo)?.scope;
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
        localizedFindings.push({ file, line: 1, message: `no localized source exists for ${entity.id}; fill the wiki in ${language} to write it` });
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
    const repoOfScope = (scope: string): string | undefined => [...pins.values()].find((pin) => pin.scope === scope)?.name;
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
    return {
      ctx: { productFolder: product.folder, manifest: read.manifest, graph, markdown, docEntities, localizedSources, language, documents: reading.sources, repositories: history === undefined ? [...pins.keys()].sort(byCodePoint) : [history.repo], webOf, ...(history === undefined ? { index: { relyingOn: (key: string) => statementsRelyingOn(indexOwner, key), counts: () => indexCounts(indexOwner) } } : {}), commitOf: (repo) => history === undefined ? pins.get(repo)?.commit ?? null : repo === history.repo ? history.commit : null, resolver, repoOfScope, readSource },
      manifest: read.manifest,
      findings: [...read.manifest.findings, ...markdownRead.findings, ...reading.findings, ...localizedFindings],
    };
  }

  /** The planned-change marks, read once per revision and per head of the product's repositories: a commit makes them read again. */
  private marksMemo: { key: string; marks: PlannedMarks } | undefined;

  /** What the planned-change marks depend on besides the wiki's revision: the tasks folder and every repository's head. */
  private marksKey(): string {
    const parts: string[] = [String(this.revision)];
    try { parts.push(String(statSync(join(this.options.productFolder, TASKS_FOLDER)).mtimeMs)); } catch { parts.push('-'); }
    for (const repository of [{ path: this.options.productFolder }, ...this.repositories().filter((repo) => repo.present)]) {
      try { parts.push(execFileSync('git', ['-C', repository.path, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim()); } catch { parts.push('-'); }
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

  /** When the last fill of this product ended, as kept beside its store; absent when none was recorded. */
  private lastFillAt(): string | undefined {
    try {
      const finished = (JSON.parse(readFileSync(join(this.storeFolder(), 'last-fill.json'), 'utf8')) as { finishedAt?: unknown }).finishedAt;
      return typeof finished === 'string' ? finished : undefined;
    } catch {
      return undefined;
    }
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
    let keys: { key: string; problems: string } = { key: '', problems: '' };
    try {
      keys = this.statusKey();
    } catch {
      // A product whose inputs cannot be stamped is answered afresh: a key that cannot be computed caches nothing.
      keys = { key: '', problems: '' };
    }
    if (keys.key !== '') {
      const held = this.statusMemo;
      // A body whose count was left pending is made again once the fill that held its collection back has ended: the
      // answer it starts lands for the next poll, and the memo never keeps a pending body past the fill.
      const usable = held !== undefined && held.key === keys.key && (!held.pending || this.fill.state === 'running' || this.problemsFlight !== undefined);
      if (usable) return this.statusLive(held.body, held.problemsKey, keys.problems);
      // Eight polls of one reader, or three readers polling together, wait for one read of the same files.
      const flight = this.statusFlight;
      if (flight !== undefined && flight.key === keys.key) {
        const made = await flight.promise;
        return this.statusLive(made.body, made.problems, made.problems);
      }
      const promise = this.statusNow();
      this.statusFlight = { key: keys.key, promise };
      try {
        const made = await promise;
        this.statusMemo = { key: keys.key, problemsKey: made.problems, pending: made.problems === '', body: made.body };
        return this.statusLive(made.body, made.problems, made.problems);
      } finally {
        if (this.statusFlight?.promise === promise) this.statusFlight = undefined;
      }
    }
    return (await this.statusNow()).body;
  }

  /**
   * What moves without a file: the fill, the writer and the agent, taken from this process on every answer. The Problems
   * count is the one collected for exactly these inputs, else absent: an answer never keeps a count collected for inputs
   * the cache has replaced — while a fill holds the collection back, the answer is pending (madarch-u3vw.8).
   */
  private statusLive(body: WikiStatus, bodyProblems: string, problems: string): WikiStatus {
    const collected = this.problemsCache;
    let loop = body.loop;
    if (bodyProblems === '' || bodyProblems !== problems) {
      // No listing for these inputs: the count is pending, and a reader shows the corrections it counts from their files.
      const { problemsOpen: _pending, ...rest } = loop;
      loop = rest;
    } else if (collected !== undefined && collected.key === problems) {
      // A listing that landed after the body was made is the count for these inputs.
      loop = { ...loop, problemsOpen: collected.listing.open };
    }
    return { ...body, loop, fill: this.statusFill(), writer: this.writer, chosenAgent: this.chosenAgent() };
  }

  private statusMemo: { key: string; problemsKey: string; pending: boolean; body: WikiStatus } | undefined;
  private statusFlight: { key: string; promise: Promise<{ body: WikiStatus; problems: string }> } | undefined;

  /**
   * Every file and store state the answer reads besides the fill and the writer, as one key: the Problems listing's
   * own key (the snapshot, the pins, the plan, the starter set and every file the page reads) and the three the listing
   * leaves out — the task files, whose closures the menu counts, the store's last finish, which the menu shows, and the
   * commit each repository's default branch stands at, which is what a task closure reads (madarch-u3vw.8).
   *
   * A file's own content is the stamp: an edit that keeps its size and restores its mtime is still an edit, and the
   * content hash is kept beside the metadata so an unchanged file is not read again on every poll.
   */
  private statusKey(): { key: string; problems: string } {
    let finished = '-';
    try {
      finished = this.contentStamp(join(this.storeFolder(), 'last-fill.json'));
    } catch {
      // No fill has finished yet, or the store is not open: nothing to stamp.
    }
    const tasks = this.folderStamp(TASKS_FOLDER);
    // A product with no task file has no closure to read: a branch that moves cannot close a task that is not there.
    const branches = tasks.endsWith(':absent') || tasks.endsWith(':empty') ? '-' : this.defaultBranchHeads();
    const problems = this.problemsKey();
    return { key: `${problems}|tasks:${tasks}|finished:${finished}|branches:${branches}`, problems };
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

  /** The fill the menu shows: live while it runs, and the store's last finish once it is idle. */
  private statusFill(): WikiStatus['fill'] {
    const incomplete = [...this.pins.values()].some((pin) => pin.filledCommits < pin.commits || pin.commits === 0);
    if (this.fill.state !== 'idle' || this.pins.size === 0 || incomplete) return this.fill;
    const at = this.lastFillAt();
    return { state: 'done', ...(at === undefined ? {} : { finishedAt: at }) };
  }

  private async statusNow(): Promise<{ body: WikiStatus; problems: string }> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const common = { product: { name: product.name, id: product.id } };
    const declared = this.repositories();
    const context = await this.context();
    if ('absent' in context) {
      const body: WikiStatus = { ...common, manifest: 'no-manifest', manifestFile: context.file, language: 'en', seeded: [], ...(this.seedError === undefined ? {} : { seedError: this.seedError }), findings: [], kinds: [], groups: [], repositories: declared.map((repo) => ({ name: repo.name, filled: false })), filled: false, incomplete: false, fill: this.fill, writer: this.writer, bounds: WRITER_BOUNDS, chosenAgent: this.chosenAgent(), home: null, roles: {}, loop: this.loopCounts(), starterOffers: 0 };
      return { body, problems: '' };
    }
    const home = homeKind(context.manifest);
    const homeEntity = home === undefined ? undefined : [...context.ctx.markdown.values()].find((entity) => entity.kind === home.name);
    const kinds = await kindSummaries(context.ctx);
    const incomplete = [...this.pins.values()].some((pin) => pin.filledCommits < pin.commits || pin.commits === 0);
    const loop = this.loopCounts();
    // The count is the one collected for exactly the inputs this body reads; absent, the answer carries no count at all.
    const problems = await this.openProblems();
    if (problems !== undefined) loop.problemsOpen = problems.count;
    const body: WikiStatus = {
      ...common,
      manifest: 'ok',
      manifestFile: context.manifest.file,
      language: context.manifest.language ?? 'en',
      seeded: this.seeded,
      findings: context.findings,
      kinds,
      groups: [...context.manifest.groups.values()].map((group) => ({ group: group.name, labels: { ...group.labels }, ...(group.parent === undefined ? {} : { parent: group.parent }), ...(group.open === undefined ? {} : { open: group.open }) })),
      repositories: declared.map((repo) => ({ name: repo.name, filled: (this.pins.get(repo.name)?.filledCommits ?? 0) > 0 })),
      filled: this.pins.size > 0,
      incomplete,
      fill: this.statusFill(),
      writer: this.writer,
      bounds: WRITER_BOUNDS,
      chosenAgent: this.chosenAgent(),
      home: homeEntity?.id ?? null,
      roles: Object.fromEntries([...context.manifest.roles.values()].map((role) => [role.name, { ...(role.open === undefined ? {} : { open: [...role.open] }), lead: [...role.lead] }])),
      loop,
      starterOffers: this.starterOffers().length,
    };
    // The key is taken once more after the body is made: a change of the inputs while it was made leaves the count
    // pending rather than carried to the next poll (madarch-u3vw.8).
    let shown = '';
    if (problems !== undefined) {
      const current = this.problemsKeySafe();
      if (current !== '' && current === problems.key) shown = current;
    }
    return { body, problems: shown };
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

  private kindsForStamp(folder: string): ReturnType<typeof readKinds> {
    // The manifest's declarations are stamped by content too: an edit that keeps its size and mtime is still an edit.
    const manifest = this.contentStamp(join(folder, KINDS_FILE));
    const held = this.stampKinds;
    // Which declarations the manifest accepts also depends on the files it names: a template written after the answer
    // was warmed accepts a kind the read refused, and the files of that kind must be stamped from then on
    // (madarch-u3vw.8). The comparison is a stat per named template, never a parse.
    if (held !== undefined && held.manifest === manifest && this.templateStamps(folder, held.read) === held.templates) return held.read;
    const read = this.kinds(folder);
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
   * every template path a declaration names, the files of the Markdown kinds, the product's documents, the questions and
   * the corrections, and the store's identities and classifications. Status is polled, so the page's count is kept; an
   * edit of any of these — a manifest a person changed, a document, a question — must change this key, or the menu keeps
   * a count the page no longer shows (madarch-m38l.24, the review; the template paths and the content hashes are
   * madarch-u3vw.8).
   */
  private problemInputsStamp(): string {
    const folder = this.options.productFolder;
    const parts: string[] = [];
    parts.push(this.contentStamp(join(folder, MANIFEST_FILE)));
    parts.push(this.contentStamp(join(folder, KINDS_FILE)));
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
  private async openProblems(): Promise<{ count: number; key: string } | undefined> {
    const key = this.problemsKey();
    const cached = this.problemsCache;
    // The listing already collected for exactly these inputs: no walk.
    if (cached !== undefined && cached.key === key) return { count: cached.listing.open, key };
    // The first reader of a product pays for its one collection, so the menu has a count from its first poll. The key is
    // taken after the store is open: it carries the reader's revision, and the next poll must find this count under the
    // same key rather than treat it as collected for other inputs.
    if (cached === undefined && this.fill.state !== 'running') {
      try {
        const owner = await this.open();
        const fresh = this.problemsKey();
        return { count: (await this.problemsFor(fresh, owner)).open, key: fresh };
      } catch {
        return undefined;
      }
    }
    // Every other poll leaves the collection to the background, so no answer waits for a walk of the graph — and no
    // answer walks it while a fill runs (madarch-m38l.19). Until that collection lands, the answer says pending: the
    // count it holds is one collected for other inputs, and it is never shown (madarch-u3vw.8).
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

  private readonly readSnapshotHistory = createSnapshotHistoryReader();

  async historyAt(selection: HistorySelection): Promise<HistoryContext> {
    const owner = await this.open();
    if (this.reader?.owner !== owner) return await this.historyAt(selection);
    const pin = this.pins.get(selection.repo);
    if (pin === undefined) return { ...selection, coverage: 'unknown', commit: null, effectiveAt: null, until: null, points: [] };
    return await this.readSnapshotHistory(owner, pin, this.validAt(), selection);
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
    const owner = await this.open();
    const validAt = this.validAt();
    const pins = new Map(this.pins);
    const rendered: PageResult = await owner.transaction('snapshot', async (transaction) => {
      const context = await this.context(history, { owner, transaction, validAt, pins });
      if ('absent' in context) return { ok: false, status: 404, message: `the product has no ${context.file}: the wiki shows the kinds that file declares` };
      if (history !== undefined && await findSubject(context.ctx, id) === undefined) return { ok: true, page: { id, kind: id.slice(0, id.indexOf(':')), title: id, trail: [], blocks: [], resolutions: {}, findings: [], notes: [], history, historicalAbsent: true } };
      const result = await renderPage(context.ctx, id, lang, history === undefined ? options : { ...options, defer: false });
      if (!result.ok) return result;
      const page = history === undefined ? result.page : withHistoryLinks(result.page, history);
      return { ok: true, page: { ...page, ...(history === undefined ? { planned, ...(historyNavigation === undefined ? {} : { historyNavigation }) } : { history, blocks: page.blocks.filter((block) => block.type !== 'history') }) } };
    });
    // The badge is counted after the page's transaction closes: the Problems listing opens a transaction of its own, and a
    // nested one would wait on the pipe the page holds. A listing that cannot be made is said on the page, never shown as 0.
    if (!rendered.ok || rendered.page.historicalAbsent === true || history !== undefined) return rendered;
    // The caller may hold a renderer whose owner has no store behind it (a snapshot fixture, or a page rendered from an
    // injected transaction). There is no problems database to ask, so the page shows no count and no failure note.
    if (this.reader?.owner !== owner) return rendered;
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
    const base: PageModel = { id: output.id, kind, title, trail: [], blocks: [], resolutions: {}, findings: [], notes: [], ...(history === undefined ? { planned: await this.plannedForPage(output.id) } : { history }) };
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
        scopeOf: (repository) => this.pins.get(repository)?.scope,
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
    // Listing the documents writes nothing: a product with no manifest has no pages of kinds and no excluded files.
    const read = readKinds(product.folder);
    const manifest: KindsManifest = read.present ? read.manifest : { file: read.file, roles: new Map(), kinds: new Map(), declaredTemplates: [], groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] };
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
    const slug = taskSlug(input.title, input.question);
    const file = `docs/tasks/${slug}.md`;
    const existing = readTasks(this.options.productFolder);
    if (existing.findings.length > 0) throw new LoopRefusal(409, `docs/tasks:1: cannot safely check existing tasks: ${existing.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`).join('; ')}`);
    if (existing.tasks.some((task) => task.slug === slug)) throw new LoopRefusal(409, `${file}:1: a task with this id already exists`);
    // A scope the wiki cannot read back is refused now: a task file it cannot parse would vanish into findings.
    const scopes = dedupeScopes(input.scope);
    const bad = scopes.findIndex((scope) => readScope(JSON.parse(JSON.stringify(scope))) === undefined);
    if (bad >= 0) throw new LoopRefusal(400, `docs/tasks:1: scope[${bad}] is ${JSON.stringify(scopes[bad])}, and a scope is a section { path, anchor }, lines { path, start, end }, file { path }, symbol or statement { key }`);
    const task = { slug, title: input.title.trim(), status: 'open' as const, question: `question:${input.question}`, answer: `answer:${input.question}`, grounds: [...new Set(input.grounds)].sort(byCodePoint), scope: scopes, by, at: (this.options.now?.() ?? new Date()).toISOString(), closedBy: null, closedAt: null };
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
    if (this.chosenAgent() === null) return { ok: false, message: 'no agent is chosen for this product: choose one before fixing the pages' };
    const started = await this.startFill({ task: task.slug, taskPages: impact.writable });
    if (!started.started) return { ok: false, message: started.message };
    return { ok: true, task: (await listTasks({ productFolder: this.options.productFolder, owner, repositories: this.taskRepositories(), pageFiles: this.pageFiles(), placeOf: (scope) => this.placeOf(scope) })).tasks.find((row) => row.id === task.id)!, pages: impact.writable, fill: started.fill };
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
    const pins = [...this.pins.values()].map((pin) => `${pin.name}@${pin.commit}`).join(',');
    const plan = this.writer.plan === undefined ? '' : this.writer.plan.unplaced.map((entry) => `${entry.kind}:${entry.slug}`).join(',');
    const snapshot = this.reader === undefined ? '' : String(this.reader.seq);
    return `${snapshot}|${pins}|${plan}|${this.starterOffers().length}|${this.problemInputsStamp()}`;
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
        // A status body made while this listing was collecting carries the previous count. It is made again from the
        // listing that landed for exactly its inputs; a body already answered from this cache keeps the count through
        // statusLive (madarch-u3vw.8).
        if (this.statusMemo !== undefined) this.statusMemo = undefined;
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
    const [rule, ...rest] = id.split('\u0000');
    const identity = rest.join('\u0000');
    const slug = taskSlug(`Fix ${problem.rule} in ${problem.place.label}`, problem.id);
    const file = `${TASKS_FOLDER}/${slug}.md`;
    const existing = readTasks(this.options.productFolder);
    if (existing.findings.length > 0) throw new LoopRefusal(409, `docs/tasks:1: cannot safely check existing tasks: ${existing.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`).join('; ')}`);
    if (existing.tasks.some((task) => task.slug === slug)) throw new LoopRefusal(409, `${file}:1: a task with this id already exists`);
    const by = await localIdentity(this.options.productFolder, { ...process.env, ...(this.options.env ?? {}) } as NodeJS.ProcessEnv);
    const task: Omit<PlannedTask, 'id' | 'file'> = {
      slug, title: `Fix ${problem.rule} in ${problem.place.label}`, status: 'open',
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
    const worker = this.worker;
    if (worker !== undefined) {
      worker.send({ type: 'stop' });
      const killer = setTimeout(() => worker.kill(), STOP_GRACE_MS);
      try {
        await this.running;
      } catch {
        // a failed fill has already said so
      } finally {
        clearTimeout(killer);
      }
    } else {
      await this.running?.catch(() => undefined);
    }
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

/** The folder a products home keeps its knowledge stores in. */
export function defaultKnowledgeRoot(home: string): string {
  return join(home, '.madarch', 'knowledge');
}

/** The products home's knowledge wikis: one per product folder, created when first asked for. */
export class KnowledgeHost {
  private readonly products = new Map<string, KnowledgeProduct>();

  constructor(private readonly storeRoot: string, private readonly now?: () => Date, private readonly extra: Pick<KnowledgeProductOptions, 'env' | 'agentFactory' | 'errorLog' | 'workerFactory' | 'snapshotMs' | 'choicesQuery' | 'guideContextFor' | 'guideHostFor'> = {}) {}

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
