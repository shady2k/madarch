/**
 * Stage 1 of the fill (decision 0026; decision 0033's per-file units): the
 * inventory stage draws the tree's containment — one `code.contains` edge from
 * each file's or folder's container to it, the container being a folder's node
 * or the repository's node. The nodes themselves are the snapshot stage's:
 * this stage publishes no node, and every edge's two ends are nodes the
 * snapshot already wrote (decision 0033, item 15: steps build on each other).
 *
 * **Units.** A unit is one file or one directory, named
 * `<kind>:<repository>:<path>`; its scope is `<repository>:<path>`. A commit
 * that changes one file's bytes moves that file's unit (and, through the
 * directory rule below, the units of the folders it stands in) and no other.
 *
 * **The plan reads what the previous runs published.** The plan reads the
 * `code.file` and `code.directory` nodes the graph holds for the repository
 * (`publishedTreeRead`) and plans:
 *
 * - a file's unit when the file is new or its blob moved at the pinned commit;
 * - a file's unit for a published path the commit no longer holds, which
 *   publishes nothing and so retracts the edge of a deleted or renamed-away
 *   file;
 * - a directory's unit when the folder is new, when it vanished, and when it
 *   holds a file this run writes, so a changed file's folders are published
 *   with it.
 *
 * A graph that answers nothing for a repository plans its whole tree, which is
 * what a first run is. The plan is in code point order of the unit ids.
 *
 * **What the files are.** The file node's roles, language, bytes and blob are
 * the snapshot stage's reading of the path and the tree; this stage keeps the
 * pure rules (`rolesFor`, `languageFor`, `wholeFileRange`, `directoriesOf`)
 * because the later stages read a path the same way, and the snapshot stage
 * uses them too.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { ID_PATTERN } from '../../model/schema.js';
import { FACT_KINDS, isRepositoryPath, makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance, type FactRange, type FileRole, type RepositoryForm } from '../facts.js';
import type { SnapshotReader, SnapshotSource } from '../snapshot.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageContext, type StageExecutionResult, type StageGraphReader, type StagePlan, type StageUnit } from '../stage.js';
import { evidenceAtPlace, provenanceOfPlace } from './draft.js';
import type { StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { fileFactIdOf } from './syntax-facts.js';
import { publishedRepositoryRead, publishedRepositoryRows } from './snapshot.js';
import { publishedTreeRead, publishedTreeRows, type PublishedTreeRow } from './tree-rows.js';

/** The stage's id, as it is registered and as its units are named. */
export const INVENTORY_STAGE_ID = 'inventory';

/** The stage's own version, bumped when what it writes or plans changes. */
export const INVENTORY_STAGE_VERSION = 2;

/** The fact kinds the stage produces, in code point order. */
export const INVENTORY_STAGE_KINDS: readonly string[] = ['contains'];

// The tree read lives in one module the three static stages share.
export { PUBLISHED_TREE_READ, publishedTreeRead, publishedTreeRows, type PublishedTreeRow } from './tree-rows.js';

/** The read the inventory's plan makes of its own containment edges. */
export const PUBLISHED_CONTAINMENT_READ = 'stage-1-published-containment';

/** The read of one repository's published containment edges. */
export function publishedContainmentRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_CONTAINMENT_READ, repository });
}

/** One row of that read: one child and the container it stands in (`''` is the repository root). */
export interface PublishedContainmentRow {
  readonly kind: 'contains';
  readonly child: 'file' | 'directory';
  /** The container's path, or `''` for the repository node. */
  readonly from: string;
  readonly to: string;
}

/** The read's rows, read: each row names a file or folder and the container it stands in. */
export function publishedContainmentRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedContainmentRow[] {
  return rows.map((row, index) => {
    const refuse = (detail: string): Error => new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw refuse(`${JSON.stringify(row)} is no row: a row is an object naming its kind, its child and its container`);
    const held = row as Record<string, unknown>;
    if (held['kind'] !== 'contains') throw refuse(`its kind is ${JSON.stringify(held['kind'])}, and this read answers "contains" rows`);
    const child = held['child'];
    if (child !== 'file' && child !== 'directory') throw refuse(`its child is ${JSON.stringify(child)}, and a containment row names a "file" or a "directory"`);
    const keys = Object.keys(held).sort(byCodePoint);
    const unknown = keys.filter((key) => !['child', 'from', 'kind', 'to'].includes(key));
    if (unknown.length > 0) throw refuse(`it holds ${unknown.map((key) => JSON.stringify(key)).join(', ')}, and a row holds child, from, kind, to`);
    const from = held['from'];
    if (typeof from !== 'string' || (from !== '' && !isRepositoryPath(from))) throw refuse(`its container ${JSON.stringify(from)} is no repository path: a container is a folder's path or "" for the repository`);
    const to = held['to'];
    if (typeof to !== 'string' || !isRepositoryPath(to)) throw refuse(`its child path ${JSON.stringify(to)} is no repository path`);
    return { kind: 'contains', child, from, to };
  });
}

/** A unit id as this stage planned it. */
interface PlannedUnit {
  readonly kind: 'directory' | 'file';
  readonly repository: string;
  readonly path: string;
}

/** The unit id of one file, and of one directory. */
export function fileUnitId(repository: string, path: string): string {
  return `file:${repository}:${path}`;
}
export function directoryUnitId(repository: string, path: string): string {
  return `directory:${repository}:${path}`;
}

/** The scope a unit covers, as the run's wiring sees it: the repository and the path. */
function scopeOf(repository: string, path: string): string {
  return `${repository}:${path}`;
}

/**
 * The stage, built over the source that holds the run's pins. `plan` reads the
 * pins and the published tree (one tracked read per repository); each unit
 * draws the edge from its node's container.
 */
export function createInventoryStage(sources: SnapshotSource): FillStage {
  return {
    id: INVENTORY_STAGE_ID,
    version: INVENTORY_STAGE_VERSION,
    staticReading: true,
    // The nodes a containment edge joins are the snapshot's: a graph without them is an inventory
    // with nothing to draw, which the registry reports as starvation rather than an edge to a node
    // nobody published.
    consumes: {
      required: [
        { capability: 'directory', scope: 'repository', freshness: 'current' },
        { capability: 'file', scope: 'repository', freshness: 'current' },
      ],
      optional: [],
    },
    produces: [
      { kind: 'contains', schemaVersion: FACT_KINDS['contains'].version, scope: 'repository' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planInventory(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeInventoryUnit(unit, context),
    validate: (draft) => checkStaticGraphDraft(INVENTORY_STAGE_ID, INVENTORY_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/** The units one run of the inventory fills, from the pinned tree and the published nodes. */
async function planInventory(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anyFile = false;
  // The nodes this stage's edges join are the snapshot's. If one a planned edge would end at is not
  // published yet, the plan names no unit at all: the run's re-plan wave plans the stage again once the
  // snapshot published past its recorded attempt (decision 0027; 0033, item 15). A partial plan would
  // leave the skipped units unplanned, because a stage that planned any unit is never re-planned.
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const files = reader.files();
    // A tree whose entries are all unfiled held entries too: stage 0's coverage names the gap.
    anyFile = anyFile || files.length > 0 || reader.unfiled().length > 0;
    const standing = new Set(files.map((entry) => String(entry.path)));
    const folders = foldersOf(reader);
    // The nodes this stage's edges join are the snapshot's. Until its repository node, and the node of
    // each file or folder an edge would end at, stand published, no unit is planned: the run's re-plan
    // wave plans this stage again once the snapshot published past its recorded attempt (decision 0027;
    // 0033, item 15 — every step builds on what the earlier one published).
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const repositoryRead = publishedRepositoryRead(pin.id);
    const repositories = publishedRepositoryRows(await graph.query(repositoryRead), pin.id, repositoryRead);
    if (!repositories.some((row) => row.kind === 'repository')) {
      blocked = true;
      continue;
    }
    // What this stage published before: the container each file and folder stands in. A file whose bytes
    // moved is the snapshot's to republish and keeps its edge; a file that moved to another folder, a
    // new one, a vanished one and a folder that appeared or went are this stage's units.
    const read = publishedContainmentRead(pin.id);
    const published = publishedContainmentRows(await graph.query(read), pin.id, read);
    const fileEdge = new Map<string, string>();
    const directoryEdge = new Map<string, string>();
    for (const row of published) (row.child === 'file' ? fileEdge : directoryEdge).set(row.to, row.from);
    const containerOf = (path: string): string => parentOf(path) ?? '';
    for (const entry of files) {
      if (fileEdge.get(entry.path) === containerOf(entry.path)) continue;
      const parent = parentOf(entry.path);
      if (!tree.files.has(entry.path) || (parent !== undefined && !tree.directories.has(parent))) {
        blocked = true;
        continue;
      }
      units.push({ id: fileUnitId(pin.id, entry.path), scope: scopeOf(pin.id, entry.path) });
    }
    for (const path of fileEdge.keys()) {
      if (standing.has(path)) continue;
      // A path the pinned commit no longer holds: the unit publishes nothing, which retracts its edge.
      units.push({ id: fileUnitId(pin.id, path), scope: scopeOf(pin.id, path) });
    }
    for (const path of folders) {
      if (directoryEdge.get(path) === containerOf(path)) continue;
      const parent = parentOf(path);
      if (!tree.directories.has(path) || (parent !== undefined && !tree.directories.has(parent))) {
        blocked = true;
        continue;
      }
      units.push({ id: directoryUnitId(pin.id, path), scope: scopeOf(pin.id, path) });
    }
    for (const path of directoryEdge.keys()) {
      if (!folders.has(path)) units.push({ id: directoryUnitId(pin.id, path), scope: scopeOf(pin.id, path) });
    }
  }
  if (blocked) return { units: [], coverage: 'nothing-found' };
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anyFile ? 'planned' : 'nothing-found' };
}

/**
 * The folders one reader's tree holds, worked out once per reader: git holds no
 * empty folder, so a folder stands exactly while a file of the tree stands in
 * it. A reader is held by the source across a run's units, so this is one walk
 * of the tree and not one per unit.
 */
const FOLDERS_BY_READER = new WeakMap<SnapshotReader, ReadonlySet<string>>();

/** The folders of a reader's tree: every folder that holds a file, at any depth. */
function foldersOf(reader: SnapshotReader): ReadonlySet<string> {
  const held = FOLDERS_BY_READER.get(reader);
  if (held !== undefined) return held;
  const folders = new Set(directoriesOf(reader.files().map((entry) => String(entry.path))));
  FOLDERS_BY_READER.set(reader, folders);
  return folders;
}

/**
 * The folders a set of paths stands in, each once: every ancestor of every
 * path, and never the repository root, which is the `repository` node and not a
 * folder of the tree.
 */
export function directoriesOf(paths: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    let parent = parentOf(path);
    while (parent !== undefined) {
      directories.add(parent);
      parent = parentOf(parent);
    }
  }
  return [...directories].sort(byCodePoint);
}

/** The folder a path stands in; `undefined` at the repository root. */
function parentOf(path: string): string | undefined {
  const at = path.lastIndexOf('/');
  return at < 0 ? undefined : path.slice(0, at);
}

// ---- one unit ------------------------------------------------------------

/**
 * One unit: the edge from the node's container to it. A path the pinned commit
 * no longer holds, or one that holds a submodule's commit (whose tree stands in
 * another repository), writes nothing, and the publication of an empty draft
 * under the unit's own scope ends what an earlier run wrote for it.
 */
async function executeInventoryUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const source = staticSourceOf(unit, context);
  const provenance = provenanceOfPlace(source);
  const stands = planned.kind === 'file'
    ? (await source.entry(planned.path)) !== undefined && (await source.entry(planned.path))?.form !== 'commit'
    : await source.holdsDirectory(planned.path);
  if (!stands) {
    context.progress(`the ${planned.kind} ${planned.path} does not stand in ${source.repository} at ${source.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  const edge = containment(source.repository, source.form, planned.path, planned.kind === 'file' ? fileFactIdOf(source.repository, planned.path) : directoryContainer(source.repository, planned.path, provenance).id, provenance);
  for (const write of graphWritesOf(edge, evidenceAtPlace(source, planned.path))) {
    // The edge says which kind its child is, so a reader of the containment rows names a file and a
    // folder without resolving the child's node (the snapshot published both kinds).
    context.draft.write(write.kind === 'edge' ? { ...write, value: { ...write.value, properties: { ...write.value.properties, childKind: planned.kind } } } : write);
  }
  context.progress(`drew the containment of ${planned.kind} ${planned.path} of ${source.repository} at ${source.commit}`, 1);
  return { outcome: 'draft' };
}

/**
 * The `contains` edge from the node a path stands in to the node it is: the
 * folder above it, or the repository node at the root. The container's id is
 * the one the snapshot published — a directory's identity is the repository and
 * the path, and a repository's identity is its name alone.
 */
function containment(repository: string, form: RepositoryForm, path: string, child: string, provenance: FactProvenance): Fact {
  const parent = parentOf(path);
  const container = parent === undefined
    ? makeNodeFact({ kind: 'repository', value: { repository, form }, provenance, layer: 'extracted' })
    : directoryContainer(repository, parent, provenance);
  return makeEdgeFact({ kind: 'contains', value: { from: container.id, to: child }, provenance, layer: 'extracted' });
}

/** The directory fact of one folder, whose id is the node key the snapshot published. */
function directoryContainer(repository: string, path: string, provenance: FactProvenance): { id: string } {
  return makeNodeFact({ kind: 'directory', value: { repository, path: repositoryPath(path) }, provenance, layer: 'extracted' });
}

/** The unit id read back as this stage planned it; an id this stage never plans is refused. */
function plannedUnit(id: string): PlannedUnit {
  const kind = id.slice(0, Math.max(0, id.indexOf(':')));
  const rest = id.indexOf(':') < 0 ? '' : id.slice(id.indexOf(':') + 1);
  const repository = rest.slice(0, Math.max(0, rest.indexOf(':')));
  const path = rest.indexOf(':') < 0 ? '' : rest.slice(rest.indexOf(':') + 1);
  const refuse = (detail: string): Error => new Error(`the unit ${JSON.stringify(id)} is not one this stage plans, and ${detail}: a unit id is "file:<repository>:<path>" or "directory:<repository>:<path>"`);
  if (kind !== 'file' && kind !== 'directory') throw refuse(`its kind is ${JSON.stringify(kind)}`);
  if (!ID_PATTERN.test(repository)) throw refuse(`its repository ${JSON.stringify(repository)} is no repository name`);
  if (!isRepositoryPath(path)) throw refuse(`its path ${JSON.stringify(path)} is no repository path`);
  return { kind: kind as 'directory' | 'file', repository, path };
}

/** The unit's static repository, refused by name where the run handed none. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageSource {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the inventory's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/inventory.ts, decision 0033)`);
  }
  return held.repository;
}

function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned tree: a cancelled unit publishes nothing`);
  }
}

// ---- the roles and the language a path carries ----------------------------

/**
 * The languages stage 3 parses, by the extension a path ends in: the same four
 * grammars `src/product/fill-index.ts` walks (typescript, tsx, javascript, go).
 * A file of another language carries no language: stage 3 names it as not
 * parsed, and this stage does not claim a parser for it.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.cjs': 'javascript',
  '.cts': 'typescript',
  '.go': 'go',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.mts': 'typescript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
};

/** The extensions of code in languages stage 3 has no parser for: the file is source all the same. */
const SOURCE_EXTENSIONS: readonly string[] = [
  '.bash', '.c', '.cc', '.clj', '.cpp', '.cs', '.css', '.cxx', '.dart', '.elm', '.ex', '.exs', '.fish', '.h', '.hh', '.hpp',
  '.hs', '.htm', '.html', '.java', '.jl', '.kt', '.kts', '.less', '.lua', '.m', '.ml', '.mm', '.php', '.pl', '.pm', '.ps1', '.py',
  '.r', '.rb', '.rs', '.sass', '.scala', '.scss', '.sh', '.sql', '.svelte', '.swift', '.vue', '.zig', '.zsh',
];

/** The extensions of a document. */
const DOCUMENT_EXTENSIONS: readonly string[] = ['.adoc', '.markdown', '.md', '.mdx', '.rst', '.txt'];

/** The names of a document a repository keeps without an extension (`LICENSE`, `CHANGELOG`). */
const DOCUMENT_NAMES: readonly string[] = ['AUTHORS', 'CHANGELOG', 'CODE_OF_CONDUCT', 'CONTRIBUTING', 'COPYING', 'LICENSE', 'NOTICE', 'README', 'SECURITY'];

/** The extensions of configuration: a manifest, a lock file, a workflow, a chart's values. */
const CONFIG_EXTENSIONS: readonly string[] = ['.cfg', '.conf', '.env', '.ini', '.json', '.lock', '.properties', '.toml', '.yaml', '.yml'];

/** The extensions of a build's own files. */
const BUILD_EXTENSIONS: readonly string[] = ['.bazel', '.bzl', '.cmake', '.gradle', '.mk', '.nix'];

/** The names of a build's own files, which carry no extension that says so. */
const BUILD_NAMES: readonly string[] = ['CMakeLists.txt', 'Containerfile', 'Dockerfile', 'GNUmakefile', 'Justfile', 'Makefile', 'build.rs', 'flake.nix', 'justfile', 'makefile', 'meson.build'];

/** The extensions of an asset: something the repository ships that is nobody's source. */
const ASSET_EXTENSIONS: readonly string[] = [
  '.7z', '.a', '.avif', '.bin', '.bmp', '.bz2', '.dat', '.db', '.dll', '.dylib', '.eot', '.gif', '.gz', '.ico', '.jar', '.jpeg',
  '.jpg', '.mov', '.mp3', '.mp4', '.ogg', '.onnx', '.otf', '.o', '.parquet', '.pdf', '.png', '.pt', '.snap', '.so', '.sqlite', '.sqlite3',
  '.svg', '.tar', '.tgz', '.tif', '.tiff', '.ttf', '.wasm', '.wav', '.webm', '.webp', '.woff', '.woff2', '.xz', '.zip',
];

/** The extensions a schema is written in. */
const SCHEMA_EXTENSIONS: readonly string[] = ['.avsc', '.graphql', '.proto', '.xsd'];

/** The folders a path's legs name a role for, by the leg's own name. */
const ROLE_BY_LEG: Readonly<Record<string, FileRole>> = {
  '.venv': 'vendor',
  '__fixtures__': 'fixture',
  '__tests__': 'test',
  'dist': 'generated',
  'e2e': 'test',
  'fixture': 'fixture',
  'fixtures': 'fixture',
  'gen': 'generated',
  'generated': 'generated',
  'migrate': 'migration',
  'migration': 'migration',
  'migrations': 'migration',
  'node_modules': 'vendor',
  'spec': 'test',
  'specs': 'test',
  'test': 'test',
  'testdata': 'fixture',
  'tests': 'test',
  'third_party': 'vendor',
  'thirdparty': 'vendor',
  'venv': 'vendor',
  'vendor': 'vendor',
};

/**
 * What a file is, from its path alone: its language (stage 3's parser's name,
 * where one parses it), the roles it plays (in code point order, each once) and
 * — where the path places nothing at all — the one role `asset`.
 */
export function rolesFor(path: string): readonly FileRole[] {
  const roles = new Set<FileRole>();
  const name = path.slice(path.lastIndexOf('/') + 1);
  const extension = extensionOf(name);
  const legs = path.split('/').slice(0, -1);
  for (const leg of legs) {
    const role = ROLE_BY_LEG[leg];
    if (role !== undefined) roles.add(role);
  }
  if (languageFor(path) !== undefined || SOURCE_EXTENSIONS.includes(extension)) roles.add('source');
  if (DOCUMENT_EXTENSIONS.includes(extension) || (extension === '' && DOCUMENT_NAMES.includes(name.toUpperCase()))) roles.add('document');
  if (CONFIG_EXTENSIONS.includes(extension) || name.startsWith('.env') || (name.startsWith('.') && !name.slice(1).includes('.'))) roles.add('config');
  if (BUILD_EXTENSIONS.includes(extension) || BUILD_NAMES.includes(name) || name.startsWith('Dockerfile.')) roles.add('build');
  if (ASSET_EXTENSIONS.includes(extension)) roles.add('asset');
  if (SCHEMA_EXTENSIONS.includes(extension) || /\.schema\.[^./]+$/u.test(name)) roles.add('schema');
  if (/\.(test|spec)\.[^./]+$/u.test(name) || /^test_.+\.(py|rb|exs)$/u.test(name) || /_test\.go$/u.test(name)) roles.add('test');
  if (/\.(gen|generated)\.[^./]+$/u.test(name) || /^zz_generated_/u.test(name) || /\.pb\.go$/u.test(name) || /\.g\.dart$/u.test(name)) roles.add('generated');
  if (/^\d{4}[-_].+\.sql$/u.test(name)) roles.add('migration');
  if (roles.size === 0) roles.add('asset');
  return [...roles].sort(byCodePoint);
}

/** The language stage 3 parses a path as, where one of its grammars reads it. */
export function languageFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return LANGUAGE_BY_EXTENSION[extensionOf(name)];
}

/** A file name's extension, lower case, with its dot; empty where the name carries none. */
function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at <= 0 ? '' : name.slice(at).toLowerCase();
}

/**
 * The range of a whole file, as a reader counts lines: from the first line's
 * first character to the last line's end. A trailing newline ends a line rather
 * than starting an empty one, and the columns are UTF-16 code units of the line
 * as it reads.
 */
export function wholeFileRange(text: string): FactRange {
  const lines = text.split('\n');
  const endLine = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  return { startLine: 1, startColumn: 0, endLine, endColumn: (lines[endLine - 1] ?? '').length };
}
