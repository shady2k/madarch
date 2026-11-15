/**
 * The file-text queue (madarch-u3vw.16, decision 0037): a page's read of a file's text is a job on the one pg-boss queue,
 * claimed by the fill role, which asks the git plugin for the blob's lines through madarch.plugins/3 and settles the job
 * with the bytes as its result. The api role enqueues the job and reads its own record back through the queue, so there
 * is one queue and no second store: the queue holds the request and the answer.
 *
 * The agent's file reads call `readBlobThroughPlugin` directly — the same plugin read the job performs — so the page and
 * the agent share one mechanism.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { PluginHost } from '../plugin/host.js';
import { closureOf } from '../plugin/closure.js';
import { parsePluginLock, PLUGINS_LOCK_FILE } from '../plugin/lock.js';
import { readFileSync } from 'node:fs';
import { sandboxRepositoryPath } from '../plugin/sandbox.js';
import { readProduct } from '../product/manifest.js';
import { RELEASE_CLOSURE_HASHES } from '../plugin/release-closures.js';
import type { ClaimedJob, QueueService } from '../fill/queue.js';

/** WHERE this module raises from. */
const WHERE = 'src/knowledge/file-texts.ts';

/** The queue the reads wait in: the store's one pg-boss queue, beside the fills. */
export const FILE_TEXT_QUEUE = 'file-texts';

/** One request on the queue: the product, the plugin's folder, the repository and the blob, with the lines asked for. */
export interface FileTextJob {
  readonly product: string;
  readonly plugin: string;
  readonly repository: string;
  readonly root: string;
  readonly blob: string;
  readonly from: number;
  /** The column inside `from` the text starts at, 1-based: where a line cut at the byte bound continues. */
  readonly fromColumn: number | null;
  readonly to: number | null;
}

/** The answer one job settles with: the lines' text, the whole blob's counts, and whether it is text at all. */
export interface FileTextResult {
  readonly text: string;
  readonly lines: number;
  readonly bytes: number;
  readonly binary: boolean;
  /** True when the text reaches the end of the blob; false when it was cut at `FILE_TEXT_MAX_BYTES`. */
  readonly complete: boolean;
  /** Where a cut text continues: the line, and the column inside it (1-based); null when the text is complete. */
  readonly next: { readonly line: number; readonly column: number } | null;
}

/**
 * The most bytes one read answers (the owner's review of madarch-u3vw.16): a range is a job result, and a blob that is one
 * hundred-megabyte line must not become one. A text past this is cut, and the answer names the line and the column the
 * next range continues at, so nothing is dropped silently.
 */
export const FILE_TEXT_MAX_BYTES = 256 * 1024;

/** Declares the read queue on a store's queue service: a read is quick, and one retry covers a host that died mid-read. */
export async function declareFileTextQueue(queue: QueueService): Promise<void> {
  // The declaration the store preparation installed, applied to this client: the settings must be the prepared ones.
  await queue.declare({ name: FILE_TEXT_QUEUE, leaseSeconds: 120, retries: 1, retryDelaySeconds: 1, retryBackoff: false });
}

/** Asks for one read: the job's id is what the caller reads its answer by. */
export async function askFileText(queue: QueueService, request: FileTextJob): Promise<string> {
  const held = await queue.enqueue({ queue: FILE_TEXT_QUEUE, data: request });
  if (!held.created) throw new Error(`${WHERE}:1: the queue created no file read: the ${FILE_TEXT_QUEUE} queue holds singletons and its key was taken`);
  return held.id;
}

/** The answer to one read, or null while the queue holds no answer yet. */
export async function fileTextAnswer(queue: QueueService, id: string): Promise<FileTextResult | { readonly error: string } | null> {
  const held = await queue.job<FileTextResult & { readonly error?: string }>(FILE_TEXT_QUEUE, id);
  if (held === null) return null;
  if (held.state === 'completed') return held.output ?? { error: `${WHERE}:1: the read's job completed with no answer` };
  if (held.state === 'failed' || held.state === 'cancelled') return { error: held.output?.error ?? `${WHERE}:1: the read's job ended ${held.state} without words` };
  return null;
}

/** The oldest reads waiting, claimed for this pass. */
export async function claimFileTexts(queue: QueueService, limit = 4): Promise<readonly ClaimedJob<FileTextJob>[]> {
  return await queue.claim<FileTextJob>({ queue: FILE_TEXT_QUEUE, limit });
}

/** Settles one read: the bytes as the job's result, or the words of why it could not be read. */
export async function settleFileText(queue: QueueService, job: ClaimedJob<FileTextJob>, answer: FileTextResult | { readonly error: string }): Promise<void> {
  if ('error' in answer) await queue.fail(FILE_TEXT_QUEUE, job, answer.error);
  else await queue.complete(FILE_TEXT_QUEUE, job, answer);
}

/** What one read needs: the product, the plugin's folder in it, the repository's name and folder, and the blob. */
export interface BlobRead {
  readonly product: string;
  readonly plugin: string;
  readonly repository: string;
  readonly root: string;
  readonly blob: string;
  readonly from?: number;
  /** The column inside `from` the text starts at, 1-based: where a line cut at the byte bound continues. */
  readonly fromColumn?: number;
  readonly to?: number;
}

/** A refusal this module answers with, as the words a page shows. */
export class BlobReadRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'BlobReadRefusal'; }
}

/** Whether a path lies inside a folder (and is not it). */
function inside(folder: string, path: string): boolean {
  const held = relative(folder, path);
  return held !== '' && !held.startsWith('..') && !isAbsolute(held);
}

/** Checks a read's paths and returns the plugin folder, the repository root and the locked closure. */
export function verifyBlobRead(read: BlobRead): { pluginFolder: string; repositoryRoot: string; closure: string } {
  if (!existsSync(join(read.product, 'workspace.yaml'))) throw new BlobReadRefusal(`${WHERE}:1: the product ${JSON.stringify(read.product)} holds no workspace.yaml, so no repository of it can be read`);
  // Every path is checked by where it really goes, never by how it is spelled (the owner's review of madarch-u3vw.16): a
  // `repos/<name>` that is a link to a repository outside the product reads nothing, and neither does a plugin folder
  // that links out.
  const real = (path: string): string | undefined => { try { return realpathSync(path); } catch { return undefined; } };
  const productReal = real(read.product);
  if (productReal === undefined) throw new BlobReadRefusal(`${WHERE}:1: the product ${JSON.stringify(read.product)} is not there, so no repository of it can be read`);
  const pluginFolder = join(read.product, read.plugin);
  const pluginReal = real(pluginFolder);
  if (pluginReal === undefined || !inside(productReal, pluginReal)) throw new BlobReadRefusal(`${WHERE}:1: the plugin folder ${JSON.stringify(read.plugin)} at ${pluginFolder} resolves to ${pluginReal ?? 'nothing'}, which is not inside the product ${productReal}`);
  if (!existsSync(join(pluginReal, 'plugin.json'))) throw new BlobReadRefusal(`${WHERE}:1: no plugin.json answers in ${pluginFolder}, so no blob is read through it`);
  const repositoryRoot = read.root;
  // A path outside the product's repos/ (or its own folder) is refused by its spelling first, so a request that names
  // another place is told so; then the real path refuses a link that leaves the product.
  const lexicalRepos = join(read.product, 'repos');
  const lexicalOwn = resolve(repositoryRoot) === resolve(read.product);
  if (!lexicalOwn && !inside(lexicalRepos, repositoryRoot)) {
    throw new BlobReadRefusal(`${WHERE}:1: the repository ${JSON.stringify(read.repository)} is not read from the product's repos/ folder: ${repositoryRoot} lies outside ${lexicalRepos}`);
  }
  const rootReal = real(repositoryRoot);
  if (rootReal === undefined) throw new BlobReadRefusal(`${WHERE}:1: the repository folder ${repositoryRoot} is not there: connect the repository with "madarch repo add" and bootstrap it`);
  const repos = join(productReal, 'repos');
  // A repository the product's manifest declares as a link to a local checkout (`repos: [{ name, linked: true }]`) is read
  // where it lies: the manifest is the person's own declaration of it. Any other folder outside the product's repos/ is
  // refused by its real path.
  const declaredLink = (() => {
    const held = readProduct(read.product);
    return held.ok && held.product.repos.some((repo) => repo.name === read.repository && repo.linked === true);
  })();
  // The product's own repository is the product folder itself; any other repository is one its repos/ holds.
  const own = rootReal === productReal;
  if (!own && !declaredLink && !inside(repos, rootReal)) {
    throw new BlobReadRefusal(`${WHERE}:1: the repository ${JSON.stringify(read.repository)} at ${repositoryRoot} resolves to ${rootReal}, which is neither the product ${productReal} nor a folder its repos/ holds (${repos}): a read follows no link out of the product`);
  }
  const stat = (() => { try { return statSync(rootReal); } catch { return undefined; } })();
  if (stat === undefined || !stat.isDirectory()) throw new BlobReadRefusal(`${WHERE}:1: the repository folder ${repositoryRoot} is not there: connect the repository with "madarch repo add" and bootstrap it`);
  if (!existsSync(join(rootReal, 'HEAD')) && !existsSync(join(rootReal, '.git'))) throw new BlobReadRefusal(`${WHERE}:1: the repository folder ${repositoryRoot} is no git checkout, so git's object store cannot answer`);
  const lockFile = join(read.product, PLUGINS_LOCK_FILE);
  let lockText: string | undefined;
  try { lockText = readFileSync(lockFile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BlobReadRefusal(`${lockFile}:1: the plugin lock cannot be read: ${(error as Error).message}`); }
  const lock = parsePluginLock(lockText, lockFile);
  if (!lock.ok) throw new BlobReadRefusal(`${lock.file}:${String(lock.line)}: ${lock.message}`);
  const closure = closureOf(pluginFolder);
  const id = read.plugin.split(/[/\\]/u).filter((part) => part !== '').at(-1) ?? read.plugin;
  const locked = lock.entries.find((entry) => entry.id === id);
  if (locked === undefined) throw new BlobReadRefusal(`${lock.file}:1: the product's lock names no plugin ${JSON.stringify(id)}, and a file's text is read only through a locked plugin`);
  if (locked.closure !== closure.hash) throw new BlobReadRefusal(`${WHERE}:1: the plugin ${id} at ${pluginFolder} hashes to ${closure.hash}, and ${lock.file} locks ${locked.closure}: a read runs exactly the closure the lock names`);
  return { pluginFolder, repositoryRoot: rootReal, closure: closure.hash };
}

/** One open reader: the plugin session that answers a repository's reads, its scratch folder, and when it last answered. */
interface Reader {
  /** The map's key: the plugin folder and the repository root. */
  readonly key: string;
  readonly host: PluginHost;
  readonly session: Awaited<ReturnType<PluginHost['open']>>;
  readonly workRoot: string;
  lastUsed: number;
  /** The idle timer that ends this reader: it does not keep the process alive, and it closes the plugin when it fires. */
  idle?: ReturnType<typeof setTimeout>;
}

/** The readers this process holds, by plugin folder and repository: a page's tab asks several ranges of one file. */
const READERS = new Map<string, Reader>();
/** How long a reader stands idle before its sandbox is ended. */
const READER_IDLE_MS = 30_000;

/** Ends every reader this process holds: the fill role calls this as it gives its stores up. */
export async function closeFileTextSessions(): Promise<void> {
  for (const [key, held] of [...READERS]) {
    READERS.delete(key);
    if (held.idle !== undefined) clearTimeout(held.idle);
    await held.session.close().catch(() => undefined);
    rmSync(held.workRoot, { recursive: true, force: true });
  }
}

/** The reader for one (plugin, repository), opened on first use and reused while it stands. */
async function readerFor(verified: { pluginFolder: string; repositoryRoot: string }, options: { readonly releaseHashes?: readonly string[]; readonly env?: Readonly<Record<string, string | undefined>> }): Promise<Reader> {
  const key = `${verified.pluginFolder}\u0000${verified.repositoryRoot}`;
  const held = READERS.get(key);
  if (held !== undefined && Date.now() - held.lastUsed < READER_IDLE_MS) { held.lastUsed = Date.now(); return held; }
  if (held !== undefined) {
    READERS.delete(key);
    if (held.idle !== undefined) clearTimeout(held.idle);
    await held.session.close().catch(() => undefined);
    rmSync(held.workRoot, { recursive: true, force: true });
  }
  const workRoot = mkdtempSync(join(tmpdir(), 'madarch-file-read-'));
  const host = new PluginHost({
    pluginFolder: verified.pluginFolder,
    repository: verified.repositoryRoot,
    workRoot,
    trust: 'production',
    releaseHashes: options.releaseHashes ?? RELEASE_CLOSURE_HASHES,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  try {
    const session = await host.open();
    const reader: Reader = { key, host, session, workRoot, lastUsed: Date.now() };
    READERS.set(key, reader);
    return reader;
  } catch (error) {
    rmSync(workRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Ends a reader when it has been idle for `READER_IDLE_MS`: the plugin's process is stopped and its scratch folder
 * removed, so a fill that read a blob leaves nothing running and its process can end. The timer does not keep the
 * process alive, and a read in the meantime re-arms it (madarch-64o5.110).
 */
function armIdle(reader: Reader): void {
  if (reader.idle !== undefined) clearTimeout(reader.idle);
  reader.idle = setTimeout(() => {
    if (Date.now() - reader.lastUsed < READER_IDLE_MS) { armIdle(reader); return; }
    READERS.delete(reader.key);
    void reader.session.close().catch(() => undefined);
    rmSync(reader.workRoot, { recursive: true, force: true });
  }, READER_IDLE_MS + 50);
  reader.idle.unref?.();
}

/**
 * Reads one blob through the plugin: the plugin runs in its sandbox with the repository bound, answers the lines asked
 * for, and is kept for the next range of the same repository. The plugin names the repository at the path its sandbox
 * gives it, never the host's own.
 */
export async function readBlobThroughPlugin(read: BlobRead, options: { readonly releaseHashes?: readonly string[]; readonly env?: Readonly<Record<string, string | undefined>> } = {}): Promise<FileTextResult> {
  const verified = verifyBlobRead(read);
  const env = options.env ?? process.env;
  const reader = await readerFor(verified, options);
  const answer = await reader.session.readBlob({ repository: sandboxRepositoryPath(verified.repositoryRoot, env), blob: read.blob, ...(read.from === undefined ? {} : { from: read.from }), ...(read.to === undefined ? {} : { to: read.to }) });
  reader.lastUsed = Date.now();
  armIdle(reader);
  const firstLine = Math.max(1, Math.trunc(read.from ?? 1));
  const firstColumn = Math.max(1, Math.trunc(read.fromColumn ?? 1));
  // A range that starts inside a line drops that line's part before the column: the plugin answers whole lines.
  let text = answer.text;
  if (firstColumn > 1 && !answer.binary) {
    const newline = text.indexOf('\n');
    const head = newline < 0 ? text : text.slice(0, newline);
    const tail = newline < 0 ? '' : text.slice(newline);
    text = head.slice(Math.min(firstColumn - 1, head.length)) + tail;
  }
  // Every answer is bounded in bytes, not only in lines (the owner's review of madarch-u3vw.16): a job result, a page's
  // first range and the agent's read alike name where a cut text continues, and nothing is dropped silently.
  const bounded = boundFileText(text, firstLine, firstColumn);
  return { text: bounded.text, lines: answer.lines, bytes: answer.bytes, binary: answer.binary, complete: bounded.complete, next: bounded.next };
}

/**
 * Cuts one answer at `FILE_TEXT_MAX_BYTES`: at the last whole line that fits, or inside the first line when no line break
 * fits before the bound. Answers the text kept and, for a cut, the line and the column the next range continues at — the
 * first line's column being `firstColumn` when the range starts inside a line.
 */
export function boundFileText(text: string, firstLine: number, firstColumn = 1, maxBytes = FILE_TEXT_MAX_BYTES): { text: string; complete: boolean; next: { line: number; column: number } | null } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, complete: true, next: null };
  let bytes = 0;
  let index = 0;
  let lines = 0;
  let lineStart = 0;
  while (index < text.length) {
    const character = text[index]!;
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > maxBytes) break;
    bytes += width;
    index += 1;
    if (character === '\n') { lines += 1; lineStart = index; }
  }
  // A whole line fits: cut after its break, and the next range starts the next line at its first column. Otherwise cut
  // inside the line, and the next range starts where this one stopped, in the same line.
  const cut = lineStart > 0 ? lineStart : index;
  const taken = text.slice(0, cut);
  return {
    text: taken,
    complete: false,
    next: lineStart > 0
      ? { line: firstLine + lines, column: 1 }
      : { line: firstLine, column: firstColumn + cut },
  };
}

/** The words one failed read answers with: the refusal's own, or the failure's, never a bare exception. */
function failureOf(error: unknown): string {
  return error instanceof Error ? `${WHERE}:1: ${error.message}` : `${WHERE}:1: the read failed: ${String(error)}`;
}

/** Answers the reads waiting on the queue: the api role's pages wait on these jobs. Answers how many were served. */
export async function serveFileTexts(queue: QueueService, options: { readonly releaseHashes?: readonly string[]; readonly env?: Readonly<Record<string, string | undefined>>; readonly log?: (line: string) => void } = {}): Promise<number> {
  const jobs = await claimFileTexts(queue);
  for (const job of jobs) {
    try {
      const answer = await readBlobThroughPlugin({ product: job.data.product, plugin: job.data.plugin, repository: job.data.repository, root: job.data.root, blob: job.data.blob, from: job.data.from, ...(job.data.fromColumn === null ? {} : { fromColumn: job.data.fromColumn }), ...(job.data.to === null ? {} : { to: job.data.to }) }, options);
      await settleFileText(queue, job, answer);
    } catch (error) {
      options.log?.(`madarch file read: ${failureOf(error)}`);
      await settleFileText(queue, job, { error: failureOf(error) });
    }
  }
  return jobs.length;
}
