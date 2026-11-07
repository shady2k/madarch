/**
 * The code pass's tree reader and library run (decision 0033's "The code pass",
 * items 5 and 14 as amended 2026-11-06): the one place in the fill that writes a
 * commit's tree out and lets a library read it.
 *
 * **The tree is the commit's, never a working tree.** Every entry the snapshot
 * reader lists is written byte for byte into a throwaway folder: files as their
 * blobs, nothing renamed, nothing folded. A submodule's gitlink is another
 * repository's tree and is written not at all; a symbolic link is named in the
 * coverage, never followed (a link can point outside the folder the library
 * walks). The folder is made under the machine's temporary folder, outside any
 * checkout, and removed when the unit ends.
 *
 * **One run per module root.** The library reads only the `go.mod` at the index
 * root (its `go-module.ts` says so in 1.6.2), so a Go module below the root
 * loses every cross-package call when the whole tree is indexed as one. The
 * stage therefore reads the tree for the `go.mod` files it holds — a module's
 * own manifest, not a pattern of a repository — and indexes each module's
 * folder as its own root beside the tree's own root. What each run answers is
 * read before the next run starts, and each run's `.codegraph` folder is
 * removed at once, so no run sees another's index.
 *
 * **The library is a library here.** It is loaded through its package entry,
 * `CodeGraph.init`/`indexAll` and the reads below; never its CLI and never its
 * MCP server, which are the two surfaces that report to its telemetry endpoint.
 * `DO_NOT_TRACK=1` is set for the process as well, and the measurement of the
 * first pass (strace over a full index: no `connect(2)`, no socket, no DNS
 * lookup) is recorded in `/work/out/report-cg.md`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SnapshotReader } from '../snapshot.js';
import type { LibraryEdge, LibraryIndex, LibraryNode, LibraryRun } from './codegraph-map.js';

/** The library's version this stage is written against; `package.json` pins it exactly. */
const LIBRARY_PACKAGE = '@colbymchenry/codegraph';

/** The library asks nothing of the machine it does not need; this keeps its telemetry off whatever it decides. */
function silenceTelemetry(): void {
  if (process.env['DO_NOT_TRACK'] === undefined) process.env['DO_NOT_TRACK'] = '1';
}

/** The node kinds the library can emit, as 1.6.2 declares them: every one is read, and the join decides which are ours. */
const LIBRARY_NODE_KINDS: readonly string[] = [
  'class', 'component', 'constant', 'enum', 'enum_member', 'export', 'field', 'file', 'function',
  'import', 'interface', 'method', 'module', 'namespace', 'parameter', 'property', 'protocol',
  'route', 'struct', 'trait', 'type_alias', 'union', 'variable',
];

/** One library node, as the package answers it. */
interface LibraryNodeAnswer {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

/** One library edge, as the package answers it. */
interface LibraryEdgeAnswer {
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly line?: number;
  readonly column?: number;
  readonly metadata?: Record<string, unknown>;
}

/** What one index call answered, as this module reads it. */
interface IndexAnswer {
  readonly filesIndexed?: number;
  readonly filesSkipped?: number;
  readonly filesErrored?: number;
  readonly errors?: readonly unknown[];
  readonly durationMs?: number;
}

/** The part of one open project this module asks: no method it does not use is named. */
interface OpenProject {
  indexAll(options?: { readonly onProgress?: (progress: { readonly phase: string }) => void; readonly signal?: AbortSignal }): Promise<IndexAnswer>;
  getNodesByKind(kind: string): readonly LibraryNodeAnswer[];
  getOutgoingEdgesFrom(ids: readonly string[]): readonly LibraryEdgeAnswer[];
  getFile(path: string): unknown;
  getStats(): { readonly nodeCount: number; readonly edgeCount: number; readonly fileCount: number };
  close(): void;
}

/** The package's entry: the class the stage opens a project with. */
interface LibraryModule {
  readonly CodeGraph: { init(root: string, options?: { index?: boolean }): Promise<OpenProject> };
  readonly detectLanguage: (filePath: string) => string;
}

let loading: Promise<LibraryModule> | undefined;

/** The library, loaded once per process; its absence is a refusal that names the package and how to install it. */
async function library(): Promise<LibraryModule> {
  silenceTelemetry();
  loading ??= (async () => {
    const loaded = await import(LIBRARY_PACKAGE) as unknown as Partial<LibraryModule> & { default?: Partial<LibraryModule> };
    const held = loaded.CodeGraph === undefined ? loaded.default : loaded;
    if (held?.CodeGraph === undefined || held.detectLanguage === undefined) {
      throw new Error(`the code pass needs the package ${LIBRARY_PACKAGE}, pinned in package.json, and what it loaded holds no CodeGraph class or detectLanguage function: install the pin (bun install) before the fill runs (${import.meta.dir}/codegraph-index.ts)`);
    }
    return held as LibraryModule;
  })();
  return await loading;
}

/** One `go.mod` of the tree: the folder it stands in and the module path it declares. */
export interface ModuleRoot {
  /** The folder from the repository's root; `''` for the root itself. */
  readonly folder: string;
  readonly module: string;
}

/** The module roots of one tree, read from the tree's own `go.mod` files, in code point order of their folders. */
export async function moduleRootsOf(reader: SnapshotReader): Promise<readonly ModuleRoot[]> {
  const roots: ModuleRoot[] = [];
  for (const entry of reader.entries()) {
    const path = String(entry.path);
    const name = path === 'go.mod' ? 'go.mod' : path.endsWith('/go.mod') ? 'go.mod' : '';
    if (name === '' || entry.form !== 'blob') continue;
    const text = Buffer.from(await reader.read(path)).toString('utf8');
    const declared = /^\s*module\s+(\S+)\s*$/m.exec(text);
    if (declared === null) continue;
    roots.push({ folder: path === 'go.mod' ? '' : path.slice(0, -'/go.mod'.length), module: declared[1]! });
  }
  return roots.sort((left, right) => (left.folder < right.folder ? -1 : left.folder > right.folder ? 1 : 0));
}

/** What one checkout wrote: the files, in code point order, the symbolic links it did not follow, and where each line of each file starts. */
interface Checkout {
  readonly folder: string;
  readonly files: readonly string[];
  readonly links: readonly string[];
  /** The byte offset each line of a file starts at, from 1; the entry after the last line is the file's own length. */
  readonly lines: ReadonlyMap<string, readonly number[]>;
}

/** The byte offset each line of one file starts at, in a `\n`-separated text: what turns a line number into a span. */
function lineStartsOf(bytes: Uint8Array): number[] {
  const starts = [0];
  for (let at = 0; at < bytes.length; at += 1) if (bytes[at] === 0x0a) starts.push(at + 1);
  return starts;
}

/**
 * Writes one commit's tree into `folder`, byte for byte: files as their blobs,
 * a symbolic link named and not followed, a submodule's gitlink not written at
 * all (its bytes stand in another repository). Only a path that is a repository
 * path is written — the reader's own unfiled names are named here and never
 * renamed into a folder.
 */
async function checkOut(reader: SnapshotReader, folder: string): Promise<Checkout> {
  mkdirSync(folder, { recursive: true });
  const files: string[] = [];
  const links: string[] = [];
  const lines = new Map<string, readonly number[]>();
  for (const entry of reader.entries()) {
    const path = String(entry.path);
    if (entry.form === 'commit') continue;
    const target = join(folder, ...path.split('/'));
    if (entry.form === 'link') {
      links.push(path);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    const bytes = await reader.read(path);
    writeFileSync(target, bytes);
    lines.set(path, lineStartsOf(bytes));
    files.push(path);
  }
  return { folder, files: files.sort(), links: links.sort(), lines };
}

/** The peak resident memory of this process while the run went on, sampled every 50 ms. */
function peakRssAround<T>(work: () => Promise<T>): Promise<{ readonly value: T; readonly peakBytes: number }> {
  const start = process.memoryUsage().rss;
  let peak = start;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  return work().then(
    (value) => { clearInterval(timer); return { value, peakBytes: Math.max(peak, process.memoryUsage().rss) }; },
    (error: unknown) => { clearInterval(timer); throw error; },
  );
}

/** One index run at one root, its records read before its own index folder is removed. */
async function indexOne(root: string, folder: string, module: string | undefined, checkout: Checkout, signal: AbortSignal | undefined): Promise<LibraryRun> {
  const modulePath = await library();
  const started = Date.now();
  const opened = await modulePath.CodeGraph.init(root, { index: false });
  try {
    const { value: answer, peakBytes } = await peakRssAround(async () => await opened.indexAll(signal === undefined ? {} : { signal }));
    const nodes: LibraryNode[] = [];
    const ids: string[] = [];
    for (const kind of LIBRARY_NODE_KINDS) {
      for (const node of opened.getNodesByKind(kind)) {
        ids.push(node.id);
        nodes.push({
          id: node.id, kind: node.kind, name: node.name, qualifiedName: node.qualifiedName,
          filePath: node.filePath, startLine: node.startLine, endLine: node.endLine,
          startColumn: node.startColumn, endColumn: node.endColumn,
        });
      }
    }
    const edges: LibraryEdge[] = [];
    for (let at = 0; at < ids.length; at += 500) {
      for (const edge of opened.getOutgoingEdgesFrom(ids.slice(at, at + 500))) {
        edges.push({ source: edge.source, target: edge.target, kind: edge.kind, ...(edge.line === undefined ? {} : { line: edge.line }), metadata: edge.metadata ?? {} });
      }
    }
    // What this run read: every file of the checkout it knows, and every file it
    // walked past. The second list is what makes a smaller result visible.
    const indexed: string[] = [];
    const skipped: { path: string; why: string }[] = [];
    for (const path of checkout.files) {
      const relative = folder === '' ? path : path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : undefined;
      if (relative === undefined) continue;
      if (opened.getFile(relative) === null) {
        const language = modulePath.detectLanguage(relative);
        skipped.push({ path, why: language === 'unknown' ? 'unsupported' : `the library holds no record of this ${language} file` });
      } else indexed.push(path);
    }
    if (Array.isArray(answer.errors)) {
      for (const error of answer.errors) skipped.push({ path: folder === '' ? '.' : folder, why: `the library reported ${String((error as { message?: unknown })?.message ?? 'an error')}` });
    }
    return { root: folder, module, nodes, edges, indexed, skipped, wallMs: Date.now() - started, processPeakRssBytes: peakBytes, libraryDurationMs: answer.durationMs };
  } finally {
    opened.close();
    rmSync(join(root, '.codegraph'), { recursive: true, force: true });
  }
}

/** The scratch folder one unit writes its checkout into, and the shim that removes it whatever happened. */
export interface Scratch {
  readonly folder: string;
  close(): void;
}

/** A fresh temporary folder outside every checkout. */
export function scratchFolder(): Scratch {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-codegraph-'));
  return { folder, close: () => rmSync(folder, { recursive: true, force: true }) };
}

/**
 * One repository's index: the commit's tree written into `scratch`, the tree's
 * root indexed, then every folder that holds a `go.mod` indexed as its own root,
 * and the whole run measured.
 */
export async function indexRepository(reader: SnapshotReader, scratch: Scratch, options: { readonly signal?: AbortSignal } = {}): Promise<LibraryIndex> {
  const started = Date.now();
  const checkout = await checkOut(reader, join(scratch.folder, 'tree'));
  const modules = await moduleRootsOf(reader);
  const runs: LibraryRun[] = [];
  const roots = ['', ...modules.map((root) => root.folder).filter((folder) => folder !== '')];
  let peak = 0;
  for (const folder of roots) {
    const run = await indexOne(join(checkout.folder, ...(folder === '' ? [] : folder.split('/'))), folder, modules.find((root) => root.folder === folder)?.module, checkout, options.signal);
    peak = Math.max(peak, run.processPeakRssBytes);
    runs.push(run);
  }
  return { runs, moduleRoots: roots, lines: checkout.lines, wallMs: Date.now() - started, processPeakRssBytes: peak };
}
