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
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../adapters/database-owner.js';
import { fillGraph } from '../extract/driver/index.js';
import { HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS } from '../extract/driver/extractors.js';
import { createGraphStore, type GraphStore } from '../graph/index.js';
import { byCodePoint } from '../model/order.js';
import { readProduct, type ProductIdentity } from '../product/manifest.js';
import { insideFolder, homeKind, readKinds, type Finding, type KindsManifest } from './kinds.js';
import { locationOf, type RenderContext } from './blocks.js';
import { GraphReader } from './graph-read.js';
import { readMarkdownEntities, type MarkdownEntity } from './markdown.js';
import type { FillState, WikiStatus } from './model.js';
import { kindSummaries, renderPage, listEntities, type PageResult } from './render.js';
import { Resolver } from './resolve.js';

const execFileAsync = promisify(execFile);

/** The fill was asked to stop at a commit boundary. */
class FillStopped extends Error {}

interface RepositoryPin {
  name: string;
  scope: string;
  head: string;
  /** The commit the graph holds for the repository, and the effective time it was read at. */
  commit: string;
  effectiveTime: string;
  commits: number;
  filledCommits: number;
}

export interface KnowledgeProductOptions {
  productFolder: string;
  /** The folder the product's store lives under: `<root>/<product id>/graph`. */
  storeRoot: string;
  /** A fill that is told to stop and the clock for it; tests inject. */
  now?: () => Date;
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
  private owner: DatabaseOwner | undefined;
  private store: GraphStore | undefined;
  private opening: Promise<void> | undefined;
  private fill: FillState = { state: 'idle' };
  private running: Promise<void> | undefined;
  private stopping = false;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly pins = new Map<string, RepositoryPin>();
  private identity: ProductIdentity | undefined;
  private revision = 0;

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

  private storePath(): string {
    const product = this.product();
    if ('message' in product) throw new Error(product.message);
    return join(this.options.storeRoot, product.id, 'graph');
  }

  /** Opens the store once: the database, the graph's tables and the fill record. */
  private async open(): Promise<{ owner: DatabaseOwner; store: GraphStore }> {
    if (this.closed) throw new Error('the wiki is shutting down');
    this.opening ??= (async () => {
      const path = this.storePath();
      await mkdir(dirname(path), { recursive: true });
      const owner = createPGliteDatabaseOwner({ path, btreeGist: true });
      await owner.ready;
      const store = createGraphStore(owner, this.options.now === undefined ? {} : { now: this.options.now });
      await store.createSchema();
      await owner.transaction('write', async (tx) => {
        await tx.query(`CREATE TABLE IF NOT EXISTS knowledge_fill (
          repo text PRIMARY KEY, scope text NOT NULL, head text NOT NULL, commit_hash text NOT NULL, effective_time text NOT NULL,
          commits int NOT NULL, filled_commits int NOT NULL)`);
        const rows = await tx.query<Record<string, unknown>>('SELECT repo, scope, head, commit_hash, effective_time, commits, filled_commits FROM knowledge_fill');
        for (const row of rows.rows) {
          this.pins.set(String(row['repo']), {
            name: String(row['repo']), scope: String(row['scope']), head: String(row['head']), commit: String(row['commit_hash']),
            effectiveTime: String(row['effective_time']), commits: Number(row['commits']), filledCommits: Number(row['filled_commits']),
          });
        }
      });
      this.owner = owner;
      this.store = store;
    })();
    try {
      await this.opening;
    } catch (error) {
      this.opening = undefined;
      throw error;
    }
    return { owner: this.owner!, store: this.store! };
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
  async startFill(): Promise<{ started: true; fill: FillState } | { started: false; message: string; fill: FillState }> {
    if (this.running !== undefined) return { started: false, message: 'a fill of this product is already running', fill: this.fill };
    const product = this.product();
    if ('message' in product) return { started: false, message: product.message, fill: this.fill };
    const read = readKinds(product.folder);
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
    // The slot is claimed before anything is awaited, so two asks in the store's opening are not two fills.
    this.stopping = false;
    this.fill = { state: 'running', startedAt: (this.options.now?.() ?? new Date()).toISOString(), commit: 0, commits: 0, gaps: 0 };
    this.notify();
    this.running = (async () => {
      try {
        await this.open();
      } catch (error) {
        this.fill = { state: 'failed', message: `the product's graph store could not be opened: ${error instanceof Error ? error.message : String(error)}` };
        this.notify();
        return;
      }
      await this.runFill(repositories);
    })().finally(() => {
      this.running = undefined;
    });
    return { started: true, fill: this.fill };
  }

  /** Resolves when the running fill has ended; for tests and for a clean stop. */
  async settled(): Promise<void> {
    await this.running;
  }

  private async runFill(repositories: readonly { name: string; path: string }[]): Promise<void> {
    const { owner, store } = await this.open();
    let gaps = 0;
    try {
      for (const repo of repositories) {
        this.fill = { ...this.fill, repository: repo.name, commit: 0, commits: 0 };
        this.notify();
        const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo.path, encoding: 'utf8' })).stdout.trim();
        // A refill walks the history from its first commit again: the source pin only moves forward, past what was already read.
        const base = this.pins.get(repo.name)?.filledCommits ?? 0;
        const report = await fillGraph({
          owner,
          store,
          repository: repo.path,
          ref: head,
          extractors: TREE_EXTRACTORS,
          owners: OWNERS,
          history: HISTORY_EXTRACTOR,
          snapshots: {},
          onStart: async (start) => {
            await this.pin(owner, { name: repo.name, scope: start.repositoryNode, head: start.head, commit: this.pins.get(repo.name)?.commit ?? '', effectiveTime: this.pins.get(repo.name)?.effectiveTime ?? '', commits: start.commits, filledCommits: base });
            this.fill = { ...this.fill, commits: start.commits };
          },
          onCommit: async (done, place) => {
            const held = this.pins.get(repo.name)!;
            if (place.index > base) await this.pin(owner, { ...held, commit: done.hash, effectiveTime: done.effectiveTime, filledCommits: place.index });
            this.fill = { ...this.fill, commit: place.index, commits: place.commits };
            this.notify();
            // The extractors and the store answer in microtasks, so a fill runs as one unbroken turn of the event loop and the
            // server would not answer a request until it ended: a macrotask turn after each commit lets the open pages read.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (this.stopping) throw new FillStopped('the fill was stopped');
          },
        });
        gaps += report.gaps.length;
      }
      this.fill = { state: 'done', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), gaps };
    } catch (error) {
      this.fill = error instanceof FillStopped
        ? { state: 'idle', message: 'the fill was stopped; it resumes where it stopped' }
        : { state: 'failed', startedAt: this.fill.startedAt, finishedAt: (this.options.now?.() ?? new Date()).toISOString(), message: error instanceof Error ? error.message : String(error) };
    }
    this.notify();
  }

  private async pin(owner: DatabaseOwner, pin: RepositoryPin): Promise<void> {
    this.pins.set(pin.name, pin);
    await owner.run((tx) => tx.query(
      `INSERT INTO knowledge_fill (repo, scope, head, commit_hash, effective_time, commits, filled_commits) VALUES ($1, $2, $3, $4, $5, $6::int, $7::int)
       ON CONFLICT (repo) DO UPDATE SET scope = $2, head = $3, commit_hash = $4, effective_time = $5, commits = $6::int, filled_commits = $7::int`,
      [pin.name, pin.scope, pin.head, pin.commit, pin.effectiveTime, String(pin.commits), String(pin.filledCommits)],
    ));
  }

  // ---- reads -----------------------------------------------------------------------------

  /** The inputs of one page: the manifest and Markdown as they stand now, and the graph. */
  async context(): Promise<{ ctx: RenderContext; manifest: KindsManifest; findings: Finding[] } | { absent: true; file: string }> {
    const product = this.product();
    if ('message' in product) throw new Error(product.message);
    const read = readKinds(product.folder);
    if (!read.present) return { absent: true, file: read.file };
    const { owner } = await this.open();
    const graph = new GraphReader(owner, this.validAt);
    const markdownRead = readMarkdownEntities(product.folder, read.manifest);
    const markdown = new Map<string, MarkdownEntity>(markdownRead.entities.map((entity) => [entity.id, entity]));
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
    const resolver = new Resolver({
      graph,
      markdown,
      declared: (kind) => read.manifest.kinds.has(kind),
      readDocument: readSource,
      repositories: () => [...this.pins.keys()].sort(byCodePoint),
      locate: (entity) => (entity.span === undefined ? undefined : locationOf({ repoOfScope }, entity.scope, entity.span)),
    });
    return {
      ctx: { productFolder: product.folder, manifest: read.manifest, graph, markdown, resolver, repoOfScope, readSource },
      manifest: read.manifest,
      findings: [...read.manifest.findings, ...markdownRead.findings],
    };
  }

  async status(): Promise<WikiStatus> {
    const product = this.product();
    if ('message' in product) throw new Error(product.message);
    const common = { product: { name: product.name, id: product.id } };
    const declared = this.repositories();
    const context = await this.context();
    if ('absent' in context) {
      return { ...common, manifest: 'no-manifest', manifestFile: context.file, findings: [], kinds: [], repositories: declared.map((repo) => ({ name: repo.name, filled: false })), filled: false, incomplete: false, fill: this.fill, home: null };
    }
    const home = homeKind(context.manifest);
    const homeEntity = home === undefined ? undefined : [...context.ctx.markdown.values()].find((entity) => entity.kind === home.name);
    const kinds = await kindSummaries(context.ctx);
    const incomplete = [...this.pins.values()].some((pin) => pin.filledCommits < pin.commits || pin.commits === 0);
    return {
      ...common,
      manifest: 'ok',
      manifestFile: context.manifest.file,
      findings: context.findings,
      kinds,
      repositories: declared.map((repo) => ({ name: repo.name, filled: (this.pins.get(repo.name)?.filledCommits ?? 0) > 0 })),
      filled: this.pins.size > 0,
      incomplete,
      fill: this.fill.state === 'idle' && this.pins.size > 0 && !incomplete ? { state: 'done' } : this.fill,
      home: homeEntity?.id ?? null,
    };
  }

  async page(id: string): Promise<PageResult> {
    const context = await this.context();
    if ('absent' in context) return { ok: false, status: 404, message: `the product has no ${context.file}: the wiki shows the kinds that file declares` };
    return await renderPage(context.ctx, id);
  }

  async list(kind: string, options: { q?: string; after?: string; limit: number }) {
    const context = await this.context();
    if ('absent' in context) return undefined;
    return await listEntities(context.ctx, kind, options);
  }

  /** A file of a repository as the graph was filled from it, for the source view. */
  async source(repo: string | null, path: string): Promise<{ text: string; commit: string | null } | undefined> {
    const context = await this.context();
    if ('absent' in context) return undefined;
    const text = await context.ctx.readSource(repo, path);
    if (text === undefined) return undefined;
    return { text, commit: repo === null ? null : this.pins.get(repo)?.commit ?? null };
  }

  /** Stops a running fill at its next commit and closes the store. */
  async close(): Promise<void> {
    this.closed = true;
    this.stopping = true;
    try {
      await this.running;
    } catch {
      // a failed fill has already said so
    }
    await this.opening?.catch(() => undefined);
    this.listeners.clear();
    if (this.owner !== undefined) await this.owner.close();
    this.owner = undefined;
    this.store = undefined;
    this.opening = undefined;
  }
}

/** The products home's knowledge wikis: one per product folder, created when first asked for. */
export class KnowledgeHost {
  private readonly products = new Map<string, KnowledgeProduct>();

  constructor(private readonly storeRoot: string, private readonly now?: () => Date) {}

  of(productFolder: string): KnowledgeProduct {
    const key = resolve(productFolder);
    let held = this.products.get(key);
    if (held === undefined) {
      held = new KnowledgeProduct({ productFolder: key, storeRoot: this.storeRoot, ...(this.now === undefined ? {} : { now: this.now }) });
      this.products.set(key, held);
    }
    return held;
  }

  async close(): Promise<void> {
    for (const product of this.products.values()) await product.close();
    this.products.clear();
  }
}
