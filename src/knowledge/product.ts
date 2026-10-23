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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { RemoteOwner } from './remote-owner.js';
import { byCodePoint } from '../model/order.js';
import { readProduct, type ProductIdentity } from '../product/manifest.js';
import { selfCommand } from '../product/self-command.js';
import { insideFolder, homeKind, readKinds, setKindsLanguage, type Finding, type KindsManifest } from './kinds.js';
import { linesOf } from './lines.js';
import { applyReset, planReset, type ResetPlan } from './reset.js';
import { parseMessage, type FromWorker, type RepositoryPin, type ToWorker, type WorkerStart } from './fill-protocol.js';
import { snapshotNumbers } from './fill-worker.js';
import { locationOf, type RenderContext } from './blocks.js';
import { GraphReader } from './graph-read.js';
import { readMarkdownEntities, type MarkdownEntity } from './markdown.js';
import type { AgentOffer, DocumentListing, DocumentPage, DocumentRef, FillState, WikiStatus, WriterState, WriterUnit } from './model.js';
import { anchorLines } from './anchors.js';
import { adapterOf, installAdapter, makeUnitAgent, offers, WRITER_BOUNDS } from './agents.js';
import { productSlug, PRODUCT_PATH, type ToolAnswer, type ToolClient, type UnitAgent } from '../writer/index.js';
import { CONTENT_LANGUAGES } from '../writer/prompts.js';
import type { DraftEnv } from '../product/home.js';
import { kindSummaries, renderPage, listEntities, type PageResult } from './render.js';
import { buildStatement, type StatementResult } from './statement.js';
import { Resolver, type Resolution } from './resolve.js';
import { indexCounts, statementsRelyingOn } from './index/queries.js';
import { webLink } from './index/web-link.js';
import { readDocEntities, type DocEntity, type DocumentSource } from './doc-entities.js';
import { DOCUMENT_LIMIT, DOCUMENT_PATH, docsLinkedOutside, listedDocument, productDocumentPaths, readProductDocument, readRepoDocuments, repoDocumentPaths } from './doc-sources.js';
import { ensureLoopKinds, seedStarterSet } from './seed.js';
import { readCorrections } from '../loop/entities.js';
import { answerQuestion, recordCorrection, type Answered, type Corrected } from '../loop/answer.js';
import { planRefresh, type RefreshPlan } from '../loop/plan.js';
import { listProblems, listQuestions, questionDetail, type ProblemListing, type QuestionDetail, type QuestionListing } from '../loop/views.js';

const execFileAsync = promisify(execFile);


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
export type AgentFactory = (agentId: string) => (UnitAgent & { close(): Promise<void> }) | { error: string };

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
  /** Starts the fill worker; tests inject one. */
  workerFactory?: FillWorkerFactory;
  /** The least time between two snapshots of the store the fill writes, in milliseconds (default 8000). */
  snapshotMs?: number;
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
  private installing: Promise<unknown> | undefined;
  private choosing: Promise<unknown> = Promise.resolve();
  private choiceWrites = 0;
  private swapping: Promise<void> = Promise.resolve();
  /** A reset is under way: no fill starts meanwhile, and no second reset. */
  private resetting = false;
  private lastUse = Date.now();
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
      await owner.ready;
      if (this.pins.size === 0) await this.loadPins(owner);
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

  /** The starter set written into this product by this server, for the page to say so once. */
  private seeded: string[] = [];
  /** Why the starter set could not be written, when it could not. */
  private seedError: string | undefined;

  /**
   * The product's kinds manifest. A product without one is given the starter set (`madarch new` and `madarch init` seed
   * the same files): the wiki has one app, and an empty folder opens on the pages the starter templates draw.
   */
  private kinds(folder: string): ReturnType<typeof readKinds> {
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
    await owner.transaction('snapshot', async (tx) => {
      const rows = await tx.query<Record<string, unknown>>('SELECT repo, scope, head, commit_hash, effective_time, commits, filled_commits FROM knowledge_fill');
      for (const row of rows.rows) {
        this.pins.set(String(row['repo']), {
          name: String(row['repo']), scope: String(row['scope']), head: String(row['head']), commit: String(row['commit_hash']),
          effectiveTime: String(row['effective_time']), commits: Number(row['commits']), filledCommits: Number(row['filled_commits']),
        });
      }
    });
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
      if (held.seq >= seq) {
        for (const pin of pins) this.pins.set(pin.name, pin);
        return;
      }
      const path = join(this.readRoot(), String(seq));
      const owner = new RemoteOwner(path, { create: false });
      await owner.ready;
      // The new process answers its first statements slowly; it is warmed with what the old one answered, then the reads move.
      if (held.owner instanceof RemoteOwner) await owner.warm(held.owner.recent());
      this.reader = { owner, seq, path };
      // What the repositories were filled to is applied with the snapshot it belongs to: a source is read at the commit
      // the graph it is shown beside was filled from.
      for (const pin of pins) this.pins.set(pin.name, pin);
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
  async startFill(options: { expectAgent?: string | null; language?: string } = {}): Promise<{ started: true; fill: FillState } | { started: false; message: string; fill: FillState }> {
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
    this.running = this.runJob(product, repositories, { language: wanted, languageChanged, languageFrom: written ?? current }).finally(() => {
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
  private async runJob(product: ProductIdentity, repositories: readonly { name: string; path: string }[], run: { language: string; languageChanged: boolean; languageFrom: string }): Promise<void> {
    const failFill = (message: string): void => {
      this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message };
      this.notify();
    };
    try {
      await this.open();
    } catch (error) {
      failFill(`the product's graph store could not be opened: ${error instanceof Error ? error.message : String(error)}`);
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
      failFill(`the fill worker could not be started: ${error instanceof Error ? error.message : String(error)}`);
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
          if (message.state === 'done') this.fill = { state: 'done', startedAt: this.fill.startedAt, finishedAt: now(), gaps: message.gaps };
          else if (message.state === 'stopped') this.fill = { state: 'idle', message: 'the fill was stopped; it resumes where it stopped' };
          else this.fill = { state: 'failed', startedAt: this.fill.startedAt, finishedAt: now(), message: message.message };
          this.notify();
          return;
        case 'agent-wanted': {
          const chosen = this.writer.agent;
          if (chosen === null) { worker.send({ type: 'agent-failed', message: 'no agent was chosen for this press' }); return; }
          const built = this.options.agentFactory === undefined ? makeUnitAgent(chosen.id, this.env) : this.options.agentFactory(chosen.id);
          if ('error' in built) { worker.send({ type: 'agent-failed', message: built.error }); return; }
          // A unit never starts once the wiki is shutting down, even if the agent was closed before its connection opened.
          const made: UnitAgent & { close(): Promise<void> } = {
            run: async (request) => {
              if (this.stopping) throw new Error('the wiki is shutting down; this unit did not start');
              await built.run(request);
            },
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
          setUnit(message.unit, { state: 'writing' });
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
            ? { ...this.writer, state: 'done', current: undefined, finishedAt: now(), ...(message.message === undefined ? {} : { message: message.message }) }
            : { ...this.writer, state: 'failed', current: undefined, finishedAt: now(), message: message.message };
          this.notify();
          return;
        case 'log':
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
      failFill(`the fill worker ended with exit code ${code} before the fill was done: ${worker.stderr().trim().split('\n').slice(-6).join(' | ') || 'it said nothing on standard error'}`);
    }
    if (this.writer.state === 'running') {
      this.writer = { ...this.writer, state: 'failed', current: undefined, finishedAt: now(), message: `the fill worker ended with exit code ${code} while the agent was writing: ${worker.stderr().trim().split('\n').slice(-6).join(' | ') || 'it said nothing on standard error'}` };
      this.notify();
    }
  }

  // ---- the agent stage ---------------------------------------------------------------------

  private get env(): DraftEnv {
    return this.options.env ?? process.env;
  }

  private choiceFile(): string {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    return join(this.options.storeRoot, product.id, 'writer.json');
  }

  /** The agent the reader chose for this product, or null; a file that names an agent madarch does not offer is an error naming it. */
  chosenAgent(): { id: string; label: string } | null {
    const file = this.choiceFile();
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`${file}: the chosen agent cannot be read: ${(error as Error).message}`);
    }
    let id: unknown;
    try {
      id = (JSON.parse(text) as { agent?: unknown }).agent;
    } catch (error) {
      throw new Error(`${file}:1: the chosen agent is not JSON: ${(error as Error).message}; delete the file to choose again`);
    }
    const entry = typeof id === 'string' ? adapterOf(id) : undefined;
    if (entry === undefined) throw new Error(`${file}:1: ${JSON.stringify(id)} is not an agent madarch offers; delete the file to choose again`);
    return { id: entry.id, label: entry.label };
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
      await rm(this.choiceFile(), { force: true });
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
    const file = this.choiceFile();
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${(this.choiceWrites += 1)}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ agent: id })}\n`, 'utf8');
    await rename(temporary, file);
    this.notify();
    return { ok: true, agent: { id: entry.id, label: entry.label } };
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
  async reset(): Promise<{ ok: true; plan: ResetPlan } | { ok: false; message: string }> {
    if (this.running !== undefined) return { ok: false, message: 'a fill of this product is running; start over after it ends' };
    if (this.resetting) return { ok: false, message: 'this product is already being started over' };
    const product = this.product();
    if ('message' in product) return { ok: false, message: product.message };
    let plan: ResetPlan;
    try {
      plan = planReset(product.folder, this.storeFolder(), this.options.storeRoot);
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

  /** Resolves when the running fill has ended; for tests and for a clean stop. */
  async settled(): Promise<void> {
    await this.running;
  }

  // ---- reads -----------------------------------------------------------------------------

  /** The inputs of one page: the manifest and Markdown as they stand now, and the graph. */
  async context(): Promise<{ ctx: RenderContext; manifest: KindsManifest; findings: Finding[] } | { absent: true; file: string }> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const read = this.kinds(product.folder);
    if (!read.present) return { absent: true, file: read.file };
    const owner = await this.open();
    const graph = new GraphReader(owner, this.validAt);
    const markdownRead = readMarkdownEntities(product.folder, read.manifest);
    const markdown = new Map<string, MarkdownEntity>(markdownRead.entities.map((entity) => [entity.id, entity]));
    const reading = await this.documentEntities(product.folder, read.manifest);
    const docEntities = new Map<string, DocEntity>(reading.entities.map((entity) => [entity.id, entity]));
    const entityAtLine = new Map<string, DocEntity>(reading.entities.map((entity) => [`${entity.repo ?? ''}\0${entity.path}\0${entity.line}`, entity]));
    const repoOfScope = (scope: string): string | undefined => [...this.pins.values()].find((pin) => pin.scope === scope)?.name;
    const readSource = async (repo: string | null, path: string): Promise<string | undefined> => {
      if (repo === null) {
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
      const pin = this.pins.get(repo);
      if (pin === undefined || pin.commit === '') return undefined;
      return await gitBlob(join(product.folder, 'repos', repo), pin.commit, path);
    };
    const webOf = (repo: string | null, path: string, lineStart: number, lineEnd: number): { host: string; url: string } | undefined => {
      if (repo === null) return undefined;
      const origin = this.originOf(join(product.folder, 'repos', repo));
      const commit = this.pins.get(repo)?.commit;
      if (origin === undefined || commit === undefined || commit === '') return undefined;
      return webLink({ origin, commit, path, lineStart, lineEnd });
    };
    const resolver = new Resolver({
      graph,
      markdown,
      declared: (kind) => read.manifest.kinds.has(kind),
      readDocument: readSource,
      repositories: () => [...this.pins.keys()].sort(byCodePoint),
      locate: (entity) => (entity.span === undefined ? undefined : locationOf({ repoOfScope, webOf }, entity.scope, entity.span)),
      documentEntity: (repo, path, line) => entityAtLine.get(`${repo ?? ''}\0${path}\0${line}`),
    });
    return {
      ctx: { productFolder: product.folder, manifest: read.manifest, graph, markdown, docEntities, documents: reading.sources, repositories: [...this.pins.keys()].sort(byCodePoint), webOf, index: { relyingOn: (key) => statementsRelyingOn(owner, key), counts: () => indexCounts(owner) }, commitOf: (repo) => this.pins.get(repo)?.commit ?? null, resolver, repoOfScope, readSource },
      manifest: read.manifest,
      findings: [...read.manifest.findings, ...markdownRead.findings, ...reading.findings],
    };
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
    const findings: Finding[] = [];
    const sources: DocumentSource[] = [];
    const stamps: string[] = [];
    const outside = docsLinkedOutside(productFolder);
    if (outside !== undefined) findings.push({ file: 'docs', line: 1, message: `docs is a link to ${outside}, outside the product repository ${productFolder}: its documents are not read for entities` });
    for (const path of productDocumentPaths(productFolder).filter((candidate) => listedDocument(manifest, null, candidate))) {
      const text = readProductDocument(productFolder, path);
      if (text === undefined) { findings.push({ file: path, line: 1, message: 'the document is too large or cannot be read, so no entity is read from it' }); continue; }
      sources.push({ repo: null, path, text });
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
          if (text === null) { cut.push({ file: `repos/${repo.name}/${path}`, line: 1, message: 'the document is too large, comes past the budget of bytes read from this repository, or its name holds a line break, so no entity is read from it' }); continue; }
          held.push({ repo: repo.name, path, text });
        }
        if (all.length > DOCUMENT_LIMIT) cut.push({ file: `repos/${repo.name}`, line: 1, message: `the repository holds ${all.length} Markdown documents and the wiki reads the first ${DOCUMENT_LIMIT} of them for entities` });
        this.repoDocs.set(key, held);
        this.repoDocFindings.set(key, cut);
      }
      sources.push(...held);
      findings.push(...(this.repoDocFindings.get(key) ?? []));
      stamps.push(key);
    }
    const signature = JSON.stringify([...manifest.kinds.values()].filter((kind) => kind.source === 'document').map((kind) => [kind.name, kind.identifier, kind.terms]));
    const memoKey = `${signature}\0${stamps.join('\n')}`;
    if (this.docMemo?.key !== memoKey) {
      const read = readDocEntities(sources, manifest);
      this.docMemo = { key: memoKey, sources, entities: read.entities, findings: read.findings };
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

  async status(): Promise<WikiStatus> {
    const product = this.product();
    if ('message' in product) throw new WikiReadError(product.message);
    const common = { product: { name: product.name, id: product.id } };
    const declared = this.repositories();
    const context = await this.context();
    if ('absent' in context) {
      return { ...common, manifest: 'no-manifest', manifestFile: context.file, language: 'en', seeded: [], ...(this.seedError === undefined ? {} : { seedError: this.seedError }), findings: [], kinds: [], groups: [], repositories: declared.map((repo) => ({ name: repo.name, filled: false })), filled: false, incomplete: false, fill: this.fill, writer: this.writer, bounds: WRITER_BOUNDS, chosenAgent: this.chosenAgent(), home: null, loop: this.loopCounts() };
    }
    const home = homeKind(context.manifest);
    const homeEntity = home === undefined ? undefined : [...context.ctx.markdown.values()].find((entity) => entity.kind === home.name);
    const kinds = await kindSummaries(context.ctx);
    const incomplete = [...this.pins.values()].some((pin) => pin.filledCommits < pin.commits || pin.commits === 0);
    return {
      ...common,
      manifest: 'ok',
      manifestFile: context.manifest.file,
      language: context.manifest.language ?? 'en',
      seeded: this.seeded,
      findings: context.findings,
      kinds,
      groups: [...context.manifest.groups.values()].map((group) => ({ group: group.name, labels: { ...group.labels } })),
      repositories: declared.map((repo) => ({ name: repo.name, filled: (this.pins.get(repo.name)?.filledCommits ?? 0) > 0 })),
      filled: this.pins.size > 0,
      incomplete,
      fill: this.fill.state === 'idle' && this.pins.size > 0 && !incomplete ? { state: 'done', ...(this.lastFillAt() === undefined ? {} : { finishedAt: this.lastFillAt()! }) } : this.fill,
      writer: this.writer,
      bounds: WRITER_BOUNDS,
      chosenAgent: this.chosenAgent(),
      home: homeEntity?.id ?? null,
      loop: this.loopCounts(),
    };
  }

  /** How many questions wait for an answer or for a refresh, and how many corrections wait for one, from their files. */
  private loopCounts(): WikiStatus['loop'] {
    const questions = listQuestions(this.options.productFolder);
    return { questionsOpen: questions.open, questionsAnswered: questions.answered, correctionsOpen: readCorrections(this.options.productFolder).items.filter((correction) => correction.status === 'open').length };
  }

  async page(id: string, lang?: string): Promise<PageResult> {
    const context = await this.context();
    if ('absent' in context) return { ok: false, status: 404, message: `the product has no ${context.file}: the wiki shows the kinds that file declares` };
    return await renderPage(context.ctx, id, lang);
  }

  /** The statement view of one sentence of an agent's page. */
  async statement(id: string, sentence: string, turn = 0): Promise<StatementResult> {
    const context = await this.context();
    if ('absent' in context) return { ok: false, status: 404, message: `the product has no ${context.file}: the wiki shows the kinds that file declares` };
    return await buildStatement(context.ctx, id, sentence, turn);
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
    const manifest: KindsManifest = read.present ? read.manifest : { file: read.file, kinds: new Map(), groups: new Map(), excludeDocuments: [], findings: [] };
    const documents: DocumentRef[] = [];
    const truncated: DocumentListing['truncated'] = [];
    // The product's own pages (the files of its Markdown kinds) are entity pages, and the manifest names the harness files that are no product document.
    for (const path of productDocumentPaths(product.folder)) if (listedDocument(manifest, null, path)) documents.push({ repo: null, path });
    for (const repo of this.repositories().filter((candidate) => candidate.present)) {
      const names = (await repoDocumentPaths(repo.name, repo.path, this.pins.get(repo.name)?.commit)).filter((name) => listedDocument(manifest, repo.name, name));
      if (names.length > DOCUMENT_LIMIT) truncated.push({ repo: repo.name, total: names.length, shown: DOCUMENT_LIMIT });
      for (const name of names.slice(0, DOCUMENT_LIMIT)) documents.push({ repo: repo.name, path: name });
    }
    return { documents, truncated };
  }

  /** One document as a page; `undefined` when the repository has no such document. */
  async document(repo: string | null, path: string): Promise<DocumentPage | undefined> {
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
    const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
    return {
      repo,
      path,
      title: heading === null ? path.split('/').pop()!.replace(/\.(md|markdown)$/i, '') : heading[1]!.replace(/[*_`]/g, ''),
      markdown,
      resolutions,
      anchors: Object.fromEntries(anchorLines(markdown)),
      commit: repo === null ? null : this.pins.get(repo)?.commit ?? null,
    };
  }

  /** A file of a repository as the graph was filled from it, for the source view. */
  async source(repo: string | null, path: string): Promise<{ text: string; commit: string | null } | undefined> {
    const context = await this.context();
    if ('absent' in context) return undefined;
    const text = await context.ctx.readSource(repo, path);
    if (text === undefined) return undefined;
    return { text, commit: repo === null ? null : this.pins.get(repo)?.commit ?? null };
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
    const repository = this.singleRepository();
    return await listProblems({
      productFolder: this.options.productFolder, owner, ...(repository === undefined ? {} : { repository }),
      resolve: (url) => context.ctx.resolver.resolve(url), findings: context.findings,
      ...(this.writer.plan === undefined ? {} : { unplaced: this.writer.plan.unplaced }),
    });
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

  constructor(private readonly storeRoot: string, private readonly now?: () => Date, private readonly extra: Pick<KnowledgeProductOptions, 'env' | 'agentFactory' | 'errorLog' | 'workerFactory' | 'snapshotMs'> = {}) {}

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
