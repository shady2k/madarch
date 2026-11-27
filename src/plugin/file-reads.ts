/**
 * A file's text, read from git's object store through the git plugin (madarch-u3vw.16, decision 0037): the graph names the
 * blob, the host proves the request stays inside the product and runs the plugin in its sandbox, and the answer is the
 * lines asked for. The module is the plugin host's own — it opens a sandbox and reads the product's folders — and the
 * queue's side of a read lives in src/knowledge/file-texts.ts.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { startSpan } from '../obs/trace.js';
import { PluginHost } from './host.js';
import { closureOf } from './closure.js';
import { parsePluginLock, PLUGINS_LOCK_FILE } from './lock.js';
import { sandboxRepositoryPath } from './sandbox.js';
import { readProduct } from '../product/manifest.js';
import { RELEASE_CLOSURE_HASHES } from './release-closures.js';
import { boundFileText, type FileTextResult } from '../knowledge/file-text-shape.js';

const WHERE = 'src/plugin/file-reads.ts';

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
  // The checks open the product's folders: one span covers the whole proof that a read stays inside them.
  const span = startSpan('plugin.read.verify', {});
  try {
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
  let stat: ReturnType<typeof statSync> | undefined;
  try { stat = statSync(rootReal); } catch { stat = undefined; }
  if (stat === undefined || !stat.isDirectory()) throw new BlobReadRefusal(`${WHERE}:1: the repository folder ${repositoryRoot} is not there: connect the repository with "madarch repo add" and bootstrap it`);
  if (!existsSync(join(rootReal, 'HEAD')) && !existsSync(join(rootReal, '.git'))) throw new BlobReadRefusal(`${WHERE}:1: the repository folder ${repositoryRoot} is no git checkout, so git's object store cannot answer`);
  const lockFile = join(read.product, PLUGINS_LOCK_FILE);
  let lockText: string | undefined;
  try { lockText = readFileSync(lockFile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BlobReadRefusal(`${lockFile}:1: the plugin lock cannot be read: ${(error as Error).message}`); }
  const lock = parsePluginLock(lockText, lockFile);
  if (!lock.ok) throw new BlobReadRefusal(`${lock.file}:${String(lock.line)}: ${lock.message}`);
  const closure = closureOf(pluginFolder);
  const id = read.plugin.split('/').flatMap((part) => part.split(sep)).filter((part) => part !== '').at(-1) ?? read.plugin;
  const locked = lock.entries.find((entry) => entry.id === id);
  if (locked === undefined) throw new BlobReadRefusal(`${lock.file}:1: the product's lock names no plugin ${JSON.stringify(id)}, and a file's text is read only through a locked plugin`);
  if (locked.closure !== closure.hash) throw new BlobReadRefusal(`${WHERE}:1: the plugin ${id} at ${pluginFolder} hashes to ${closure.hash}, and ${lock.file} locks ${locked.closure}: a read runs exactly the closure the lock names`);
  return { pluginFolder, repositoryRoot: rootReal, closure: closure.hash };
  } finally { span.end(); }
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

/**
 * How a read runs its reader plugin: the release closures it trusts, the environment its host runs its own plugins in,
 * and whether that host runs them without isolation (madarch-64o5.178).
 */
export interface BlobReadOptions {
  readonly releaseHashes?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The host that asks for the text runs its plugins without isolation: the reader it opens does the same. */
  readonly unconfined?: boolean;
}

/** The readers this process holds, by plugin folder, repository and the way the reader runs: a page's tab asks several ranges of one file. */
const READERS = new Map<string, Reader>();
/** How long a reader stands idle before its sandbox is ended. */
const READER_IDLE_MS = 30_000;

/** Removes one reader's scratch folder, in a span of its own: the sandbox has ended, and its files go with it. */
function removeWorkRoot(folder: string): void {
  const span = startSpan('plugin.read.close', {});
  try { rmSync(folder, { recursive: true, force: true }); } finally { span.end(); }
}

/** Ends every reader this process holds: the fill role calls this as it gives its stores up. */
export async function closeFileTextSessions(): Promise<void> {
  // Each session is closed as its own span: the sandbox's end and its folder's removal.
  for (const [key, held] of [...READERS]) {
    READERS.delete(key);
    if (held.idle !== undefined) clearTimeout(held.idle);
    await held.session.close().catch(() => undefined);
    removeWorkRoot(held.workRoot);
  }
}

/** The reader for one (plugin, repository), opened on first use and reused while it stands. */
async function readerFor(verified: { pluginFolder: string; repositoryRoot: string }, options: BlobReadOptions): Promise<Reader> {
  // The way the reader runs is part of its key: an unconfined reader never answers a caller that asked for a confined
  // one, and the other way round (madarch-64o5.178).
  const mode = (options.env ?? process.env)['MADARCH_PLUGIN_SANDBOX'] === 'off' || options.unconfined === true ? 'unconfined' : 'confined';
  const key = `${verified.pluginFolder}\u0000${verified.repositoryRoot}\u0000${mode}`;
  const held = READERS.get(key);
  if (held !== undefined && Date.now() - held.lastUsed < READER_IDLE_MS) { held.lastUsed = Date.now(); return held; }
  if (held !== undefined) {
    READERS.delete(key);
    if (held.idle !== undefined) clearTimeout(held.idle);
    await held.session.close().catch(() => undefined);
    removeWorkRoot(held.workRoot);
  }
  const workRoot = mkdtempSync(join(tmpdir(), 'madarch-file-read-'));
  const host = new PluginHost({
    pluginFolder: verified.pluginFolder,
    repository: verified.repositoryRoot,
    workRoot,
    trust: 'production',
    releaseHashes: options.releaseHashes ?? RELEASE_CLOSURE_HASHES,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.unconfined === true ? { unconfined: true } : {}),
  });
  try {
    const session = await host.open();
    const reader: Reader = { key, host, session, workRoot, lastUsed: Date.now() };
    READERS.set(key, reader);
    return reader;
  } catch (error) {
    removeWorkRoot(workRoot);
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
    removeWorkRoot(reader.workRoot);
  }, READER_IDLE_MS + 50);
  reader.idle.unref?.();
}

/**
 * Reads one blob through the plugin: the plugin runs in its sandbox with the repository bound, answers the lines asked
 * for, and is kept for the next range of the same repository. The plugin names the repository at the path its sandbox
 * gives it, never the host's own.
 */
export async function readBlobThroughPlugin(read: BlobRead, options: BlobReadOptions = {}): Promise<FileTextResult> {
  const verified = verifyBlobRead(read);
  // The reader runs the way the host that asks for the text runs its own plugins (madarch-64o5.178): a host that chose no
  // isolation opens its reader without isolation too, and the reader is then told the repository's own path, as a child
  // without a sandbox reads it. The choice is made in a copy — the caller's environment is never changed.
  const env = options.unconfined === true ? { ...(options.env ?? process.env), MADARCH_PLUGIN_SANDBOX: 'off' } : options.env ?? process.env;
  const reader = await readerFor(verified, { ...options, env });
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
