/**
 * The Markdown documents the wiki reads (madarch-m38l.6): the product
 * repository's own (the README at its root and everything under `docs/`, as the
 * working tree holds them) and each connected code repository's, as they were at
 * the commit the graph was filled from. The documents the wiki lists, and the
 * ones the entities of the manifest's document kinds are read from, are the
 * same set: the product's pages (the files of its Markdown kinds) and the
 * documents the manifest excludes are neither.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { byCodePoint } from '../model/order.js';
import { matchesAny, type KindsManifest } from './kinds.js';

const execFileAsync = promisify(execFile);

/** A Markdown document: by its name. */
export const DOCUMENT_PATH = /\.(md|markdown)$/i;
/** The most documents listed of one code repository; a repository with more says how many it has. */
export const DOCUMENT_LIMIT = 2000;
/** The largest document an entity is read from. */
export const DOCUMENT_BYTES = 1024 * 1024;
/** The most bytes of one code repository's documents read at once; the rest is named in a finding, not read. */
export const DOCUMENT_BUDGET_BYTES = 64 * 1024 * 1024;

/** The harness files of a coding agent: never listed as a source of the product, wherever they stand. */
export const HARNESS_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);

/** A document's title: its first level-one heading, else its file name without the Markdown extension. */
export function documentTitle(markdown: string, path: string): string {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return heading === null ? path.split('/').pop()!.replace(/\.(md|markdown)$/i, '') : heading[1]!.replace(/[*_`]/g, '');
}

/** Whether a path is a page of a Markdown kind of the manifest: its one file, or a file below its folder. */
export function isKindPage(manifest: KindsManifest, path: string): boolean {
  for (const decl of manifest.kinds.values()) {
    if (decl.source !== 'markdown') continue;
    if (decl.file !== undefined && decl.file === path) return true;
    if (decl.folder !== undefined && path.startsWith(`${decl.folder.replace(/\/+$/, '')}/`)) return true;
  }
  return false;
}

/** Whether the wiki lists a document of the product repository (`repo` null) or of a code repository: not a page of a kind, not excluded. */
export function listedDocument(manifest: KindsManifest, repo: string | null, path: string): boolean {
  if (repo === null && isKindPage(manifest, path)) return false;
  return !matchesAny(manifest.excludeDocuments, path);
}

/** Where the product's `docs` folder really is when it is a link out of the product repository; undefined when it is inside or absent. */
export function docsLinkedOutside(productFolder: string): string | undefined {
  try {
    const real = realpathSync(join(productFolder, 'docs'));
    const root = realpathSync(productFolder);
    return real === root || real.startsWith(`${root}${sep}`) ? undefined : real;
  } catch {
    return undefined;
  }
}

/** The product repository's Markdown documents, `/`-separated and in code point order; a `docs` folder that links out of the product is not walked. */
export function productDocumentPaths(productFolder: string): string[] {
  const found: string[] = [];
  const walk = (folder: string, relativeFolder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name))) {
      if (entry.name.startsWith('.')) continue;
      const relative = relativeFolder === '' ? entry.name : `${relativeFolder}/${entry.name}`;
      if (entry.isDirectory()) walk(join(folder, entry.name), relative);
      else if (entry.isFile() && DOCUMENT_PATH.test(entry.name)) found.push(relative);
    }
  };
  for (const entry of readdirSync(productFolder, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name))) {
    if (entry.isFile() && DOCUMENT_PATH.test(entry.name) && !entry.name.startsWith('.')) found.push(entry.name);
  }
  if (existsSync(join(productFolder, 'docs')) && docsLinkedOutside(productFolder) === undefined) walk(join(productFolder, 'docs'), 'docs');
  return found;
}

/** A code repository's Markdown documents at a commit (HEAD when there is none), in code point order. */
export async function repoDocumentPaths(repoName: string, repoPath: string, commit: string | undefined): Promise<string[]> {
  let names: string[];
  try {
    const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '-z', '--name-only', commit === undefined || commit === '' ? 'HEAD' : commit], { cwd: repoPath, maxBuffer: 1 << 28, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    names = stdout.split('\0').filter((name) => name !== '' && DOCUMENT_PATH.test(name) && !name.split('/').some((part) => part === 'node_modules' || part.startsWith('.')));
  } catch (error) {
    throw new Error(`src/knowledge/doc-sources.ts: the documents of the repository ${repoName} cannot be listed with git in ${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return names.sort(byCodePoint);
}

/** The text of the product repository's document; undefined when it is not a readable file inside the product, of a size the wiki reads. */
export function readProductDocument(productFolder: string, path: string): string | undefined {
  try {
    // A file that is a link out of the product is somebody else's file: its real place must stand inside the product.
    const real = realpathSync(join(productFolder, path));
    const root = realpathSync(productFolder);
    if (!real.startsWith(`${root}${sep}`)) return undefined;
    const stats = statSync(real);
    if (!stats.isFile() || stats.size > DOCUMENT_BYTES) return undefined;
    return readFileSync(real, 'utf8');
  } catch {
    return undefined;
  }
}

/** One `git cat-file` process answering the names it is given, one per line; the whole answer. */
async function catFile(mode: '--batch' | '--batch-check', repoName: string, repoPath: string, commit: string, paths: readonly string[]): Promise<Buffer> {
  const child = spawn('git', ['cat-file', mode], { cwd: repoPath, env: { ...process.env, LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  child.stdin.end(paths.map((path) => `${commit}:${path}\n`).join(''));
  const code = await exited;
  if (code !== 0) throw new Error(`src/knowledge/doc-sources.ts: git cat-file ${mode} failed in ${repoPath} (repository ${repoName}, commit ${commit}): ${Buffer.concat(errors).toString('utf8').trim()}`);
  return Buffer.concat(chunks);
}

/**
 * Several documents of a code repository at a commit through two `git cat-file` processes: the sizes first (a line each),
 * then only the documents that may be read. A path git does not hold is absent from the answer. A document over the size
 * limit, one past the budget of bytes read from this repository (so many large documents cannot exhaust memory), and one
 * whose name holds a line break (the protocol is one name a line) are answered as `null`.
 */
export async function readRepoDocuments(repoName: string, repoPath: string, commit: string, paths: readonly string[]): Promise<Map<string, string | null>> {
  const answer = new Map<string, string | null>();
  if (paths.length === 0) return answer;
  for (const path of paths) if (/[\r\n]/.test(path)) answer.set(path, null);
  const askable = paths.filter((path) => !/[\r\n]/.test(path));
  if (askable.length === 0) return answer;
  const sizes = (await catFile('--batch-check', repoName, repoPath, commit, askable)).toString('utf8').split('\n');
  const wanted: string[] = [];
  let budget = DOCUMENT_BUDGET_BYTES;
  askable.forEach((path, index) => {
    const blob = /^[0-9a-f]+ blob (\d+)$/.exec(sizes[index] ?? '');
    if (blob === null) return; // "<name> missing": git holds no such path at the commit
    const size = Number(blob[1]);
    if (size > DOCUMENT_BYTES || size > budget) answer.set(path, null);
    else {
      budget -= size;
      wanted.push(path);
    }
  });
  if (wanted.length === 0) return answer;
  const out = await catFile('--batch', repoName, repoPath, commit, wanted);
  let at = 0;
  for (const path of wanted) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) throw new Error(`src/knowledge/doc-sources.ts: the answer of git cat-file ended before ${path} in ${repoPath} (repository ${repoName})`);
    const blob = /^[0-9a-f]+ blob (\d+)$/.exec(out.subarray(at, end).toString('utf8'));
    at = end + 1;
    if (blob === null) throw new Error(`src/knowledge/doc-sources.ts: git cat-file named ${path} in ${repoPath} (repository ${repoName}) a blob when sizing it and no blob when reading it`);
    const size = Number(blob[1]);
    answer.set(path, out.subarray(at, at + size).toString('utf8'));
    at += size + 1;
  }
  return answer;
}
