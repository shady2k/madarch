/**
 * The plugin host's half of the file-text channel (madarch-u3vw.16, decision 0037): a blob is read through the git
 * plugin, which runs in its own sandbox with the repository bound read-only. The host claims the api role's request from
 * the store and answers it; the agent's file reads call the same `readBlobThroughPlugin`, so the page and the agent share
 * one read path and neither reads a working copy.
 *
 * The request names the product folder, the plugin's folder in it, the repository's folder and the blob id. Each is
 * checked here before anything runs: the plugin folder lies inside the product, the repository lies under its `repos/`,
 * and the plugin's closure is the one the product's lock names.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { PluginHost } from '../plugin/host.js';
import { closureOf } from '../plugin/closure.js';
import { parsePluginLock, PLUGINS_LOCK_FILE } from '../plugin/lock.js';
import { readFileSync } from 'node:fs';
import { sandboxRepositoryPath } from '../plugin/sandbox.js';
import { RELEASE_CLOSURE_HASHES } from '../plugin/release-closures.js';
import { answerFileText, claimFileTexts, type FileTextAnswer, type FileTextAsk, type FileTextDatabase } from '../adapters/file-text-store.js';

/** WHERE this module raises from. */
const WHERE = 'src/knowledge/file-texts.ts';

/** What one read needs: the product, the plugin's folder in it, the repository's name and folder, and the blob. */
export interface BlobRead {
  readonly product: string;
  readonly plugin: string;
  readonly repository: string;
  readonly root: string;
  readonly blob: string;
  readonly from?: number;
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
  const pluginFolder = join(read.product, read.plugin);
  if (!inside(read.product, pluginFolder)) throw new BlobReadRefusal(`${WHERE}:1: the plugin folder ${JSON.stringify(read.plugin)} is not inside the product`);
  if (!existsSync(join(pluginFolder, 'plugin.json'))) throw new BlobReadRefusal(`${WHERE}:1: no plugin.json answers in ${pluginFolder}, so no blob is read through it`);
  const repositoryRoot = read.root;
  const repos = join(read.product, 'repos');
  if (!inside(repos, repositoryRoot)) throw new BlobReadRefusal(`${WHERE}:1: the repository ${JSON.stringify(read.repository)} is not read from the product's repos/ folder: ${repositoryRoot} lies outside ${repos}`);
  const stat = (() => { try { return statSync(repositoryRoot); } catch { return undefined; } })();
  if (stat === undefined || !stat.isDirectory()) throw new BlobReadRefusal(`${WHERE}:1: the repository folder ${repositoryRoot} is not there: connect the repository with "madarch repo add" and bootstrap it`);
  if (!existsSync(join(repositoryRoot, 'HEAD')) && !existsSync(join(repositoryRoot, '.git'))) throw new BlobReadRefusal(`${WHERE}:1: the repository folder ${repositoryRoot} is no git checkout, so git's object store cannot answer`);
  // The plugin runs exactly the closure the product locked: a changed closure needs a person's approval, as in a fill.
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
  return { pluginFolder, repositoryRoot, closure: closure.hash };
}

/** One open reader: the plugin session that answers a repository's reads, its scratch folder, and when it last answered. */
interface Reader {
  readonly host: PluginHost;
  readonly session: Awaited<ReturnType<PluginHost['open']>>;
  readonly workRoot: string;
  lastUsed: number;
}

/** The readers this process holds, by plugin folder and repository: a page's tab asks several ranges of one file. */
const READERS = new Map<string, Reader>();
/** How long a reader stands idle before its sandbox is ended. */
const READER_IDLE_MS = 30_000;

/** Ends every reader this process holds: the fill role calls this as it gives its stores up. */
export async function closeFileTextSessions(): Promise<void> {
  for (const [key, held] of [...READERS]) {
    READERS.delete(key);
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
    const reader: Reader = { host, session, workRoot, lastUsed: Date.now() };
    READERS.set(key, reader);
    return reader;
  } catch (error) {
    rmSync(workRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Reads one blob through the plugin: the plugin runs in its sandbox with the repository bound, answers the lines asked
 * for, and is kept for the next range of the same repository. The plugin names the repository at the path its sandbox
 * gives it, never the host's own.
 */
export async function readBlobThroughPlugin(read: BlobRead, options: { readonly releaseHashes?: readonly string[]; readonly env?: Readonly<Record<string, string | undefined>> } = {}): Promise<FileTextAnswer> {
  const verified = verifyBlobRead(read);
  const env = options.env ?? process.env;
  const reader = await readerFor(verified, options);
  const answer = await reader.session.readBlob({ repository: sandboxRepositoryPath(verified.repositoryRoot, env), blob: read.blob, ...(read.from === undefined ? {} : { from: read.from }), ...(read.to === undefined ? {} : { to: read.to }) });
  reader.lastUsed = Date.now();
  return { text: answer.text, lines: answer.lines, bytes: answer.bytes, binary: answer.binary };
}

/** The words one failed read answers with: the refusal's own, or the failure's, never a bare exception. */
function failureOf(error: unknown): string {
  return error instanceof Error ? `${WHERE}:1: ${error.message}` : `${WHERE}:1: the read failed: ${String(error)}`;
}

/** Answers the store's requests: the api role's pages wait on these rows. Answers how many were served. */
export async function serveFileTexts(database: FileTextDatabase, options: { readonly releaseHashes?: readonly string[]; readonly env?: Readonly<Record<string, string | undefined>>; readonly log?: (line: string) => void } = {}): Promise<number> {
  const asks = await claimFileTexts(database);
  for (const ask of asks) await answerOne(database, ask, options);
  return asks.length;
}

async function answerOne(database: FileTextDatabase, ask: FileTextAsk, options: { readonly releaseHashes?: readonly string[]; readonly env?: Readonly<Record<string, string | undefined>>; readonly log?: (line: string) => void }): Promise<void> {
  try {
    const answer = await readBlobThroughPlugin({ product: ask.product, plugin: ask.plugin, repository: ask.repository, root: ask.root, blob: ask.blob, from: ask.from, ...(ask.to === null ? {} : { to: ask.to }) }, options);
    await answerFileText(database, ask.id, { text: answer });
  } catch (error) {
    options.log?.(`madarch file read: ${failureOf(error)}`);
    await answerFileText(database, ask.id, { error: failureOf(error) });
  }
}
