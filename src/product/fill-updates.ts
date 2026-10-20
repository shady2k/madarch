/**
 * The update after commits to a product's default branch (decision 0026,
 * "Updates": "On a default-branch commit: the deterministic stages run for what
 * changed; impact propagates over graph edges; only affected agent units and
 * pages rerun, in dependency order"). This is the watcher the background server
 * holds: it reads the products home's repositories' default branches and, when
 * one of them moves, starts one update run of that product — debounced, so a
 * batch of quick commits is one run, and never over a fill already in progress.
 *
 * **What it costs when nothing happens.** No git subprocess is ever started: a
 * commit moves a ref, and a ref is a file, so each repository's own Git folder is
 * watched (its branch's ref, `packed-refs` and `HEAD`), and a head is read from
 * those files — `refs/heads/<branch>`, else the `packed-refs` line for it — never
 * through `git`. The interval below is a safety net for a watcher the system
 * dropped, not the mechanism: once a minute it re-reads each product's manifest
 * and its repositories' refs, a few small files, and reads no history and runs
 * nothing.
 *
 * **What it remembers.** The head it last read of each repository, kept in
 * `<home>/.madarch/updates.json` beside the fill's own state, so a server
 * restarted after a commit starts that commit's update once rather than never or
 * twice. A repository the file holds no head for — a product watched for the
 * first time — takes its first read as the baseline: the server starts no run for
 * work that stood before it looked, which is the first fill's own job.
 *
 * **When it may start a run.** Only after the wizard was run in this home: the
 * agent it chose is what a run spends, and a server that invented an agent nobody
 * chose would spend the person's money without their decision. A run is also
 * never started over a fill in progress: the product's chain of runs refuses it
 * (`startRun`, decision 0027), and a refused start leaves the commit waiting, so
 * the update follows as soon as the fill ends.
 *
 * **What a person sees.** The run the watcher starts is one of the product's runs
 * like any other: its durable progress events are what the fill progress answers
 * (`GET /api/fill`, `src/fill/orchestrator-host.ts`), and this module's own lines
 * say what it saw and why it did nothing.
 */
import { mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { byCodePoint } from '../model/order.js';
import type { FillProduct } from '../fill/orchestrator-host.js';
import { listProducts } from './list.js';
import { readChosenAgent } from './fill-wizard.js';

/** One repository of one product, as the watcher names it in its lines. */
export interface WatchedRepository {
  /** The product's name, as its manifest names it. */
  readonly product: string;
  /** The repository's id: the product's own name for the product repository, the manifest's name for a code repository. */
  readonly repository: string;
  /** The full path of the checkout. */
  readonly folder: string;
  /** The branch the manifest declares for a code repository; the checkout's own HEAD branch where it declares none. */
  readonly declaredBranch?: string;
}

/** A ref's own answer: the branch the checkout stands on, the commit that branch names, and the file it was read from. */
export interface RepositoryHead {
  readonly branch: string;
  readonly commit: string;
  readonly file: string;
}

/** What starting one update run is asked for. */
export interface UpdateRunRequest {
  /** The product the update fills. */
  readonly product: FillProduct;
  /** The run's id: one per product and commit, so the same commit never starts two runs. */
  readonly runId: string;
  /** The commit the default branch stands on, as the watcher read it. */
  readonly commit: string;
  /** The repository whose default branch moved. */
  readonly repository: string;
  /** The branch the commit landed on. */
  readonly branch: string;
}

/** How one update run ended as far as the watcher is concerned. */
export type UpdateRunAnswer =
  | { readonly started: true }
  /** A refusal that is not a deferral: the commit is dropped with the reason named, so the watcher cannot loop on it. */
  | { readonly started: false; readonly code: string; readonly reason: string }
  /** The product fills now: the commit waits, and the next pass asks again. */
  | { readonly started: false; readonly deferred: true; readonly reason: string };

/** Starts one product's update run: the background server's fill service. */
export type UpdateRunStarter = (request: UpdateRunRequest) => Promise<UpdateRunAnswer>;

/** One commit waiting for its debounce to end. */
export interface PendingUpdate {
  readonly product: string;
  readonly repository: string;
  readonly commit: string;
  /** The branch the commit landed on. */
  readonly branch: string;
  /** When the watcher first saw the commit; the debounce is counted from here. */
  readonly since: number;
}

/** What one pass over the home did, for the lines and for a test. */
export interface UpdatePassReport {
  /** The commits this pass left waiting for their debounce or for a fill to end. */
  readonly waiting: readonly PendingUpdate[];
  /** The runs this pass asked for, started or not. */
  readonly asked: readonly { readonly request: UpdateRunRequest; readonly answer: UpdateRunAnswer }[];
  /** The repositories this pass could not read, each naming its own path. */
  readonly unreadable: readonly string[];
}

export interface UpdateWatchOptions {
  /** The products home whose products are watched. */
  readonly home: string;
  /** How one update run is started. */
  readonly start: UpdateRunStarter;
  /** How long a default branch must stand still before its commit's run starts, so a batch of quick commits is one run. */
  readonly debounceMs?: number;
  /** How often a safety net re-reads the refs, for a watcher the system dropped; it starts no git. */
  readonly intervalMs?: number;
  /** Where this module's lines go; nothing by default. */
  readonly log?: (line: string) => void;
  /** Recorded time; the real clock unless a test passes its own. */
  readonly clock?: () => number;
  /**
   * Whether the person enabled automatic updates in this home — the wizard's own
   * choice. It reads the chosen agent by default; a test that does not care
   * passes `() => true`.
   */
  readonly enabled?: () => Promise<boolean> | boolean;
  /**
   * Registers one file watcher and answers its undo. The platform's own watcher
   * by default; a test that drives its passes itself passes a recorder here, so
   * nothing runs on a timer it does not hold.
   */
  readonly watchPath?: (path: string, onChange: () => void) => () => void;
}

/** The update watcher the background server holds. */
export interface UpdateWatch {
  /** Reads the baseline, registers the watchers and starts the interval; answers the pass that read the baseline. */
  outset(): Promise<UpdatePassReport>;
  /** One pass, awaited: the interval's own work, and what a test drives. */
  pass(): Promise<UpdatePassReport>;
  /** The commits waiting for their debounce or for a fill to end. */
  pending(): readonly PendingUpdate[];
  /** Ends every watcher and timer; safe to call twice. */
  stop(): void;
}

/** The heads this watcher last saw, as they are kept under the products home. */
export interface SeenHeads { readonly repositories: Record<string, { readonly branch: string; readonly commit: string }> }

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_INTERVAL_MS = 60_000;
/** How soon a pass follows a watcher's event: a batch of ref writes in one moment is one pass, not one per write. */
const COALESCE_MS = 25;
/** The file the last heads are kept in, under the products home. */
export const UPDATE_STATE_FILE = join('.madarch', 'updates.json');

/** The key one repository's last head stands under: `product/repository`, which no two pairs share. */
export function seenKey(product: string, repository: string): string {
  return `${product}/${repository}`;
}

/** One ref's value, read from its file in a Git folder, or from `packed-refs` where the ref stands packed. */
export function refValueOf(commonDir: string, ref: string): { commit: string; file: string } | undefined {
  const loose = join(commonDir, ...ref.split('/'));
  try {
    const text = readFileSync(loose, 'utf8').trim();
    if (text !== '') return { commit: text, file: loose };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const packed = join(commonDir, 'packed-refs');
  let text: string;
  try {
    text = readFileSync(packed, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  for (const line of text.split('\n')) {
    // A header line starts with `#`, and a peeled tag's line with `^`: neither is a ref's value.
    if (line === '' || line.startsWith('#') || line.startsWith('^')) continue;
    const [commit, name] = line.split(' ');
    if (name === ref && commit !== undefined) return { commit, file: packed };
  }
  return undefined;
}

/**
 * The Git folder of one checkout, read from the checkout itself: `.git` is the
 * folder in an ordinary checkout, or a file naming it (`gitdir: <path>`) in a
 * worktree and in a submodule. Nothing here runs git.
 */
export function gitFolderOf(folder: string): { gitDir: string; commonDir: string } | undefined {
  const dotGit = join(folder, '.git');
  let gitDir: string;
  try {
    if (statSync(dotGit).isDirectory()) gitDir = dotGit;
    else {
      const text = readFileSync(dotGit, 'utf8').trim();
      if (!text.startsWith('gitdir:')) return undefined;
      gitDir = resolve(folder, text.slice('gitdir:'.length).trim());
    }
  } catch {
    return undefined;
  }
  // A worktree's refs live in the repository's own folder, which `commondir` names.
  let commonDir = gitDir;
  try {
    const text = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (text !== '') commonDir = resolve(gitDir, text);
  } catch {
    // An ordinary checkout holds no `commondir`: its own folder is the common one.
  }
  return { gitDir, commonDir };
}

/**
 * One checkout's default branch and its head, read from the refs' files. The
 * branch is the one the product declares for the repository, else the one the
 * checkout's own HEAD stands on. A detached HEAD with no declared branch names no
 * default branch, and that is the `reason` a caller reports rather than a run.
 */
export function headOf(folder: string, declaredBranch?: string): { ok: true; head: RepositoryHead } | { ok: false; reason: string } {
  const folders = gitFolderOf(folder);
  if (folders === undefined) {
    return { ok: false, reason: `the checkout at ${folder} is no Git repository this watcher can read: ${join(folder, '.git')} is no folder and no "gitdir:" file` };
  }
  const headPath = join(folders.gitDir, 'HEAD');
  let headText: string;
  try {
    headText = readFileSync(headPath, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: `the checkout at ${folder} holds no ${headPath}, so it names no HEAD` };
    throw error;
  }
  const symbolic = headText.startsWith('ref:') ? headText.slice('ref:'.length).trim() : undefined;
  const branch = declaredBranch ?? (symbolic === undefined ? undefined : symbolic.replace(/^refs\/heads\//u, ''));
  if (branch === undefined) {
    return { ok: false, reason: `the checkout at ${folder} stands on a detached HEAD (${headPath} reads ${JSON.stringify(headText)}) and the product declares no branch for it, so it has no default branch to watch` };
  }
  const value = refValueOf(folders.commonDir, `refs/heads/${branch}`);
  if (value === undefined) {
    return { ok: false, reason: `the checkout at ${folder} stands on the branch ${JSON.stringify(branch)}, which names no commit: neither ${join(folders.commonDir, 'refs', 'heads', ...branch.split('/'))} nor ${join(folders.commonDir, 'packed-refs')} holds it` };
  }
  return { ok: true, head: { branch, commit: value.commit, file: value.file } };
}

/** The paths a watcher of one checkout listens to: its branch's ref, `packed-refs`, `HEAD`, and the branch folder it stands in. */
export function watchedPathsOf(folder: string, declaredBranch?: string): readonly string[] {
  const folders = gitFolderOf(folder);
  if (folders === undefined) return [];
  const read = headOf(folder, declaredBranch);
  const paths = [join(folders.gitDir, 'HEAD'), folders.commonDir, join(folders.commonDir, 'refs', 'heads')];
  if (read.ok) {
    // The branch's own folder, not only the checkout's first level: a branch named `feature/x` lives one level deeper.
    paths.push(join(folders.commonDir, 'refs', 'heads', ...read.head.branch.split('/')));
  }
  return [...new Set(paths)];
}

/** The repositories one product's update watches: its product repository and every code repository its manifest declares. */
export function repositoriesOf(product: { readonly name: string; readonly folder: string; readonly repos: readonly { readonly name: string; readonly branch?: string }[] }): readonly WatchedRepository[] {
  const watched: WatchedRepository[] = [{ product: product.name, repository: product.name, folder: product.folder }];
  for (const repo of product.repos) {
    watched.push({
      product: product.name,
      repository: repo.name,
      folder: resolve(product.folder, 'repos', repo.name),
      ...(repo.branch === undefined ? {} : { declaredBranch: repo.branch }),
    });
  }
  return watched;
}

/** Reads the heads this watcher last saw, or none where it never wrote one. */
export function readSeenHeads(home: string): Record<string, { branch: string; commit: string }> {
  const file = join(home, UPDATE_STATE_FILE);
  let parsed: Partial<SeenHeads>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SeenHeads>;
  } catch {
    // A file that is not there yet, and one that cannot be read, answer the same: nothing has been watched.
    return {};
  }
  const repositories = parsed.repositories;
  if (repositories === undefined || repositories === null || typeof repositories !== 'object') return {};
  const read: Record<string, { branch: string; commit: string }> = {};
  for (const [key, value] of Object.entries(repositories)) {
    const entry = value as { branch?: unknown; commit?: unknown } | null;
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.branch !== 'string' || typeof entry.commit !== 'string') continue;
    read[key] = { branch: entry.branch, commit: entry.commit };
  }
  return read;
}

/**
 * What one read of the kept heads could not use, named where it stands: a file that
 * was written and cannot be read back is no record, and the watcher says so once
 * rather than reading it as "nothing has been watched" in silence and skipping the
 * commit that waited in it.
 */
export function seenHeadsNote(home: string): string | undefined {
  const file = join(home, UPDATE_STATE_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return `the heads the watcher keeps in ${file} cannot be read, so every repository is read as a baseline and a commit that waited there is not asked for again: ${(error as Error).message}`;
  }
  try {
    JSON.parse(text);
    return undefined;
  } catch (error) {
    return `the heads the watcher keeps in ${file} are not a JSON record, so every repository is read as a baseline and a commit that waited there is not asked for again: ${(error as Error).message}`;
  }
}

/** Writes the heads, whole, through a temporary file: a reader never sees half a record. */
function writeSeenHeads(home: string, seen: Record<string, { branch: string; commit: string }>): void {
  const file = join(home, UPDATE_STATE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ repositories: seen }, null, 2)}\n`);
  renameSync(temp, file);
}

/** The id of one product's update run for one commit: the same commit never starts two runs, and the id names both. */
export function updateRunId(product: string, commit: string): string {
  return `update-${product}-${commit.slice(0, 12)}`;
}

/**
 * The watcher: one pass reads the products home and its repositories' heads,
 * keeps the commits whose branch moved waiting for the debounce, and starts one
 * run per product when their debounce ended and the product fills nothing.
 */
export function createUpdateWatch(options: UpdateWatchOptions): UpdateWatch {
  const home = resolve(options.home);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const clock = options.clock ?? Date.now;
  const log = options.log ?? (() => undefined);
  // The agent the wizard chose stands in the person's own home (`fill-wizard.ts`'s default, `homeFromEnv()`), not in
  // the products home this watcher lists: the home passed here is where the products stand.
  const enabled = options.enabled ?? (async () => (await readChosenAgent()) !== undefined);
  const watchPath = options.watchPath ?? ((path: string, onChange: () => void) => {
    const watcher = watch(path, { persistent: false }, () => onChange());
    watcher.on('error', (error: Error) => log(`the watcher on ${path} failed, and the interval reads the refs until it works again: ${error.message}`));
    return () => watcher.close();
  });
  const keptNote = seenHeadsNote(home);
  if (keptNote !== undefined) log(keptNote);
  const seen = readSeenHeads(home);
  const waiting = new Map<string, PendingUpdate>();
  const watchers = new Map<string, () => void>();
  const said = new Set<string>();
  let interval: ReturnType<typeof setInterval> | undefined;
  let coalesce: ReturnType<typeof setTimeout> | undefined;
  /** The timer that runs the pass a waiting commit's debounce ends, so one commit's run does not wait for the interval. */
  let due: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let tail: Promise<UpdatePassReport> = Promise.resolve({ waiting: [], asked: [], unreadable: [] });

  /** Says one line once per key: a state that repeats every pass is said when it begins, not sixty times an hour. */
  function say(key: string, line: string): void {
    if (said.has(key)) return;
    said.add(key);
    log(line);
  }

  /** Registers one watcher on each path a checkout's refs live in: a change there runs the pass after a moment. */
  function watchRepository(repository: WatchedRepository, branch: string | undefined): void {
    for (const path of watchedPathsOf(repository.folder, branch)) {
      if (watchers.has(path)) continue;
      try {
        watchers.set(path, watchPath(path, schedule));
      } catch (error) {
        say(`watch:${path}`, `the watcher on ${path} could not be registered, and the interval reads that repository's refs instead: ${(error as Error).message}`);
      }
    }
  }

  /** Runs one pass when a waiting commit's debounce ends: the update a commit asks for does not wait for the interval. */
  function scheduleDue(delayMs: number): void {
    if (stopped) return;
    if (due !== undefined) clearTimeout(due);
    due = setTimeout(() => {
      due = undefined;
      void enqueue();
    }, Math.max(1, delayMs));
    due.unref();
  }

  /** Runs one pass a moment after a change: the refs a batch of commits writes are one pass, not one per write. */
  function schedule(): void {
    if (stopped) return;
    if (coalesce !== undefined) clearTimeout(coalesce);
    coalesce = setTimeout(() => {
      coalesce = undefined;
      void enqueue();
    }, COALESCE_MS);
    coalesce.unref();
  }

  async function runPass(): Promise<UpdatePassReport> {
    const report: { waiting: PendingUpdate[]; asked: { request: UpdateRunRequest; answer: UpdateRunAnswer }[]; unreadable: string[] } = { waiting: [], asked: [], unreadable: [] };
    if (stopped) return report;
    const listed = listProducts({ home });
    if (listed.outcome !== 'listed') {
      log(`the products home ${home} cannot be listed, so no repository is watched: ${listed.message}`);
      return report;
    }
    for (const refusal of listed.unreadable) log(`the product in ${refusal.folder} is not watched, because its manifest does not read: ${refusal.file}:${String(refusal.line)}: ${refusal.message}`);
    const now = clock();
    /** The heads this pass handled: what the file keeps, so a commit is asked for once. */
    const handled: Record<string, { branch: string; commit: string }> = {};
    for (const product of listed.products) {
      for (const repository of repositoriesOf(product)) {
        const key = seenKey(product.name, repository.repository);
        // The branch watched is the one the product declares, else the one this repository stood on when it was
        // first read: a person switching branches changes HEAD, never which branch this watcher follows.
        const branch = repository.declaredBranch ?? seen[key]?.branch;
        watchRepository(repository, branch);
        let read: ReturnType<typeof headOf>;
        try {
          read = headOf(repository.folder, branch);
        } catch (error) {
          report.unreadable.push(`the refs of the repository ${JSON.stringify(repository.repository)} of the product ${JSON.stringify(product.name)} in ${repository.folder} could not be read: ${(error as Error).message}`);
          continue;
        }
        if (!read.ok) {
          report.unreadable.push(read.reason);
          say(`head:${key}`, `${read.reason}, so that repository is not watched until it reads`);
          continue;
        }
        // A repository that reads again says why it did not the next time it does not.
        said.delete(`head:${key}`);
        const before = seen[key];
        if (before === undefined) {
          // The first read of a repository is its baseline: no run for work that stood before the watcher looked.
          handled[key] = { branch: read.head.branch, commit: read.head.commit };
          say(`baseline:${key}`, `the repository ${JSON.stringify(repository.repository)} of the product ${JSON.stringify(product.name)} stands on ${read.head.branch} at ${read.head.commit}, which is the watcher's baseline: no update runs for what stood before it`);
          continue;
        }
        if (before.commit === read.head.commit && before.branch === read.head.branch) continue;
        const held = waiting.get(key);
        // A branch that moved twice before its run starts is one commit waiting, counted from the first read of it.
        const since = held !== undefined && held.commit === read.head.commit ? held.since : now;
        waiting.set(key, { product: product.name, repository: repository.repository, commit: read.head.commit, branch: read.head.branch, since });
        if (held === undefined || held.commit !== read.head.commit) {
          log(`the repository ${JSON.stringify(repository.repository)} of the product ${JSON.stringify(product.name)} moved on ${read.head.branch}: ${before.commit} -> ${read.head.commit} (${read.head.file})`);
        }
      }
    }
    // A commit whose debounce has not ended yet names when its pass is due: one commit's update follows its own
    // quiet period, not the interval's next minute.
    const early = [...waiting.values()].filter((entry) => now - entry.since < debounceMs);
    if (early.length > 0) scheduleDue(Math.min(...early.map((entry) => entry.since + debounceMs - now)) + 1);
    const due = [...waiting.values()].filter((entry) => now - entry.since >= debounceMs);
    if (due.length > 0) {
      let mayRun = false;
      let readFailed = false;
      try {
        mayRun = await enabled();
      } catch (error) {
        // A settings file this machine cannot read is no answer about the person's choice: nothing is started, the
        // commits keep waiting, and the reason is said once rather than a pass an hour.
        readFailed = true;
        say('enabled-unreadable', `no update runs by itself until this home's agent choice can be read, and a commit waits for it: ${(error as Error).message}`);
      }
      if (mayRun) {
        // A choice that reads again says why a commit waited the next time it does not read.
        said.delete('disabled');
        said.delete('enabled-unreadable');
      }
      if (!mayRun && readFailed) {
        // The commits keep waiting: they are asked for again once the choice reads.
      } else if (!mayRun) {
        say('disabled', `no update runs by itself in this home: the wizard was not run, so no agent is chosen and nothing says what a run may spend — choose an agent in the wizard and updates follow commits to the default branch (${home})`);
        for (const entry of due) waiting.delete(seenKey(entry.product, entry.repository));
      } else {
        // One run per product covers every repository the product pins: the commit its id names is the newest the
        // product's moved branches hold.
        const byProduct = new Map<string, PendingUpdate>();
        for (const entry of due) {
          const held = byProduct.get(entry.product);
          const newer = held === undefined || entry.since > held.since || (entry.since === held.since && byCodePoint(entry.repository, held.repository) < 0);
          if (newer) byProduct.set(entry.product, entry);
        }
        for (const entry of [...byProduct.values()].sort((left, right) => byCodePoint(left.product, right.product))) {
          const product = listed.products.find((candidate) => candidate.name === entry.product)!;
          const request: UpdateRunRequest = {
            product: { name: product.name, folder: product.folder },
            runId: updateRunId(entry.product, entry.commit),
            commit: entry.commit,
            repository: entry.repository,
            branch: entry.branch,
          };
          let answer: UpdateRunAnswer;
          try {
            answer = await options.start(request);
          } catch (error) {
            // A start that throws is a refusal this pass reports: the watcher keeps watching the other products, and
            // the commit is dropped with the reason so that nothing loops on it.
            answer = { started: false, code: 'fill-updates/start-failed', reason: (error as Error).message };
          }
          report.asked.push({ request, answer });
          if (answer.started) {
            for (const candidate of [...waiting.values()]) {
              if (candidate.product !== entry.product) continue;
              waiting.delete(seenKey(candidate.product, candidate.repository));
              handled[seenKey(candidate.product, candidate.repository)] = { branch: candidate.branch, commit: candidate.commit };
            }
            said.delete(`deferred:${entry.product}`);
            log(`the update of the product ${JSON.stringify(entry.product)} started as ${request.runId} at ${entry.branch} ${entry.commit}`);
            continue;
          }
          if ('deferred' in answer && answer.deferred === true) {
            // The product fills now: the commit stays waiting, and the next pass asks again.
            say(`deferred:${entry.product}`, `the update of the product ${JSON.stringify(entry.product)} waits for the fill in progress: ${answer.reason}`);
            continue;
          }
          const refusal = answer as { readonly started: false; readonly code: string; readonly reason: string };
          for (const candidate of [...waiting.values()]) {
            if (candidate.product !== entry.product) continue;
            waiting.delete(seenKey(candidate.product, candidate.repository));
            handled[seenKey(candidate.product, candidate.repository)] = { branch: candidate.branch, commit: candidate.commit };
          }
          log(`the update of the product ${JSON.stringify(entry.product)} at ${entry.commit} was not started: ${refusal.code}: ${refusal.reason}`);
        }
      }
    }
    report.waiting.push(...waiting.values());
    // The heads are kept only where a commit was handled: a watcher that restarts asks for a commit that waited,
    // and never asks twice for one a run already covers.
    const changed = Object.entries(handled).some(([key, value]) => seen[key]?.commit !== value.commit || seen[key]?.branch !== value.branch);
    if (changed) {
      Object.assign(seen, handled);
      try {
        writeSeenHeads(home, seen);
      } catch (error) {
        log(`the heads the watcher handled could not be kept in ${join(home, UPDATE_STATE_FILE)}, so a restarted server asks for them again: ${(error as Error).message}`);
      }
    }
    return report;
  }

  /** One pass at a time: a change that lands while a pass runs is that pass's successor, never its twin. */
  function enqueue(): Promise<UpdatePassReport> {
    const next = tail.then(() => runPass(), () => runPass());
    tail = next.catch(() => ({ waiting: [], asked: [], unreadable: [] }));
    return next;
  }

  return {
    async outset(): Promise<UpdatePassReport> {
      const first = enqueue();
      if (intervalMs > 0) {
        interval = setInterval(() => { void enqueue(); }, intervalMs);
        interval.unref();
      }
      return await first;
    },
    pass(): Promise<UpdatePassReport> {
      return enqueue();
    },
    pending(): readonly PendingUpdate[] {
      return [...waiting.values()];
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (interval !== undefined) clearInterval(interval);
      if (coalesce !== undefined) clearTimeout(coalesce);
      if (due !== undefined) clearTimeout(due);
      interval = undefined;
      coalesce = undefined;
      due = undefined;
      for (const close of watchers.values()) {
        try {
          close();
        } catch {
          // A watcher the system already dropped needs no undo.
        }
      }
      watchers.clear();
    },
  };
}
