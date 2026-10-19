/**
 * Stage 1 of the fill (decision 0026): the inventory stage writes what the
 * pinned tree of each repository holds — one `file` node per file (its roles,
 * the language stage 3 will parse it as, its size and the blob its bytes stand
 * under), one `directory` node per folder that holds a file, and one `contains`
 * edge from each node's container to it (a folder, or the repository node at
 * the root).
 *
 * **Units.** A unit is one file or one directory, named
 * `<kind>:<repository>:<path>`; its scope is `<repository>:<path>`. That is the
 * granularity incrementality needs: a commit that changes one file's bytes
 * moves that file's unit (and, through the directory rule below, the units of
 * the folders it stands in) and no other, so a second run writes that file's
 * facts and no other file's.
 *
 * **The plan reads what the previous runs published.** Before it names a unit,
 * the plan makes one tracked read per repository — a JSON document naming the
 * read and the repository (`publishedTreeRead`) — and the graph answers the
 * `file` and `directory` facts it already holds for it. So a plan holds:
 *
 * - a file's unit when the file is new or its blob moved at the pinned commit;
 * - a file's unit for a published path the commit no longer holds, which
 *   publishes nothing and so retracts the facts of a file that was deleted or
 *   renamed away (a rename leaves no stale fact behind);
 * - a directory's unit when the folder is new, when it vanished, and when it
 *   holds a file this run writes, so a changed file's folders are published
 *   with it.
 *
 * A graph that answers nothing for a repository plans its whole tree, which is
 * what a first run is. The plan is in code point order of the unit ids, so two
 * runs of one commit plan the same units in the same order.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { ID_PATTERN } from '../../model/schema.js';
import {
  FACT_KINDS, isRepositoryPath, makeEdgeFact, makeNodeFact, repositoryPath,
  type Fact, type FactProvenance, type FactRange, type FileRole, type FileValue,
} from '../facts.js';
import type { SnapshotEntry, SnapshotReader, SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { checkFactDraft, evidenceAt, provenanceOf } from './draft.js';

/** The stage's id, as it is registered and as its units are named. */
export const INVENTORY_STAGE_ID = 'inventory';

/** The stage's own version, bumped when what it writes or plans changes. */
export const INVENTORY_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order. */
export const INVENTORY_STAGE_KINDS: readonly string[] = ['contains', 'directory', 'file'];

/** The read the plan makes; the wiring answers it from the product graph. */
export const PUBLISHED_TREE_READ = 'stage-1-published-tree';

/**
 * The one tracked read the inventory's plan makes: the `file` and `directory`
 * facts the graph already holds for one repository's stage-1 tree. The text is
 * a JSON document, so a wiring reads it as data and not as prose: `{"read":
 * "stage-1-published-tree", "repository": "<the product's name for it>"}`.
 */
export function publishedTreeRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_TREE_READ, repository });
}

/** One row of that read: a file or directory fact, as the graph holds it. */
export interface PublishedTreeRow {
  readonly kind: 'directory' | 'file';
  readonly repository: string;
  readonly path: string;
  /** The blob a file's bytes stood under; absent where the fact was written before the field existed. */
  readonly blob?: string;
}

/** The keys a row of the read holds, and no others. */
const ROW_FIELDS: readonly string[] = ['blob', 'kind', 'path', 'repository'];

/** What the read answered, as the plan compares against it. */
interface PublishedTree {
  /** Each published file's path, and the blob it stood under (`undefined` where the row named none). */
  readonly files: ReadonlyMap<string, string | undefined>;
  readonly directories: ReadonlySet<string>;
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
 * writes its node's fact and the `contains` edge from that node's container.
 */
export function createInventoryStage(sources: SnapshotSource): FillStage {
  return {
    id: INVENTORY_STAGE_ID,
    version: INVENTORY_STAGE_VERSION,
    // The repository node and the snapshot the plan's paths stand in come from
    // stage 0: a file's `contains` edge is drawn from a repository node that
    // must be published before it, and a `nothing-found` snapshot starves the
    // inventory instead of filling a graph with paths nobody pinned.
    consumes: {
      required: [
        { capability: 'repository', scope: 'repository', freshness: 'current' },
        { capability: 'snapshot', scope: 'repository', freshness: 'current' },
      ],
      optional: [],
    },
    // A unit's publication replaces only that unit's facts (0027), so the
    // ownership scope is the widest the stage may ever replace: a `file` fact
    // is owned at the file, and the folder and the `contains` edge at the
    // repository (the scope vocabulary has no scope for one folder).
    produces: [
      { kind: 'contains', schemaVersion: FACT_KINDS['contains'].version, scope: 'repository' },
      { kind: 'directory', schemaVersion: FACT_KINDS['directory'].version, scope: 'repository' },
      { kind: 'file', schemaVersion: FACT_KINDS['file'].version, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planInventory(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeInventoryUnit(sources, unit, context),
    validate: (draft: StageDraftSet) => checkFactDraft(INVENTORY_STAGE_ID, INVENTORY_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run of the inventory fills: a unit per file whose blob moved at
 * the pinned commit (or that is new), a retraction for a published file the
 * commit no longer holds, and a directory's unit where the folder is new,
 * vanished, or holds a file this run writes.
 */
async function planInventory(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anyFile = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const read = publishedTreeRead(pin.id);
    const published = publishedTreeRows(await graph.query(read), pin.id, read);
    const files = reader.files();
    // A tree whose entries are all unfiled held entries too: it is not a
    // repository that found nothing, and stage 0's coverage names the gap.
    anyFile = anyFile || files.length > 0 || reader.unfiled().length > 0;
    // Every walk below is over maps and sets, so a plan costs what the
    // repository holds and not its square: 0026 asks the fill to be complete on
    // any repository size.
    const standing = new Set(files.map((entry) => String(entry.path)));
    const written = new Set<string>();
    for (const entry of files) {
      if (published.files.get(entry.path) === entry.id) continue;
      written.add(entry.path);
      units.push({ id: fileUnitId(pin.id, entry.path), scope: scopeOf(pin.id, entry.path) });
    }
    for (const path of published.files.keys()) {
      if (standing.has(path)) continue;
      // A path the pinned commit no longer holds: the unit publishes nothing,
      // which is how what an earlier commit's run wrote there is retracted.
      units.push({ id: fileUnitId(pin.id, path), scope: scopeOf(pin.id, path) });
    }
    // The folders that hold a file this run writes, at any depth, are published
    // with it; a folder the commit no longer holds is planned to be cleared.
    const writtenFolders = new Set(directoriesOf([...written]));
    const folders = foldersOf(reader);
    for (const path of folders) {
      if (published.directories.has(path) && !writtenFolders.has(path)) continue;
      units.push({ id: directoryUnitId(pin.id, path), scope: scopeOf(pin.id, path) });
    }
    for (const path of published.directories) {
      if (!folders.has(path)) units.push({ id: directoryUnitId(pin.id, path), scope: scopeOf(pin.id, path) });
    }
  }
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
function directoriesOf(paths: readonly string[]): readonly string[] {
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

/**
 * The read's rows, read: each row names the repository it was read for, a
 * kind, a repository path and (for a file) the blob it stood under. A row that
 * names another repository, a kind this stage does not hold, a path that is no
 * repository path or a blob that is no blob id is refused, naming the read, the
 * row and what was wrong with it — a row read past would plan a wrong unit in
 * silence, and a row dropped would leave a stale fact behind.
 *
 * Every stage that plans from this read reads its rows here: the syntax stage
 * (madarch-tzte.21.3) plans from the same document, and one reader is what keeps
 * the two from accepting different rows — two copies of this rule drifted apart
 * within one rebase, where a duplicate path and a folder carrying a blob were
 * refused by one stage and accepted by the other.
 */
export function publishedTreeRows(rows: readonly unknown[], repository: string, read: string): PublishedTree {
  const files = new Map<string, string | undefined>();
  const directories = new Set<string>();
  rows.forEach((row, index) => {
    const refuse = (detail: string): Error => new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw refuse(`${JSON.stringify(row)} is no row: a row is an object naming its kind, its repository and its path`);
    }
    const held = row as Record<string, unknown>;
    const kind = held['kind'];
    if (kind !== 'file' && kind !== 'directory') {
      throw refuse(`its kind is ${JSON.stringify(kind)}, and this stage holds "file" and "directory"`);
    }
    const named = held['repository'];
    if (named !== repository) {
      throw refuse(`its repository is ${JSON.stringify(named)}, and the read was for ${JSON.stringify(repository)}: one read is one repository`);
    }
    const unknown = Object.keys(held).filter((key) => !ROW_FIELDS.includes(key)).sort(byCodePoint);
    if (unknown.length > 0) {
      throw refuse(`it holds ${unknown.map((key) => JSON.stringify(key)).join(', ')}, and a row holds ${ROW_FIELDS.join(', ')}: a run, a unit, an attempt or a session is none of them`);
    }
    const rawPath = held['path'];
    if (typeof rawPath !== 'string' || !isRepositoryPath(rawPath)) {
      throw refuse(`its path ${JSON.stringify(rawPath)} is no repository path: a path from the repository's root, "/"-separated, with no "." or ".." leg`);
    }
    const path = repositoryPath(rawPath as string);
    // Two rows for one path in one answer are refused rather than resolved by
    // order: the fact log is versioned, and which of two versions of one file a
    // read meant is not this stage's to guess.
    const twice = files.has(path) || directories.has(path);
    if (twice) throw refuse(`its path ${JSON.stringify(path)} stands in an earlier row of this answer: one read answers one row per path`);
    if (kind === 'directory') {
      if (held['blob'] !== undefined) {
        throw refuse(`it is a folder and carries a blob: a row's blob is the file's bytes, and a folder holds no bytes of its own`);
      }
      directories.add(path);
      return;
    }
    const blob = held['blob'];
    if (blob !== undefined && (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob))) {
      throw refuse(`its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits, or no blob at all`);
    }
    files.set(path, typeof blob === 'string' ? blob : undefined);
  });
  return { files, directories };
}

// ---- one unit ------------------------------------------------------------

/**
 * One unit: the file's or the folder's node fact and the `contains` edge from
 * its container. A path the pinned commit no longer holds, or one that holds a
 * submodule's commit (whose tree stands in another repository), writes nothing,
 * and a unit that writes nothing is how this stage asks for a retraction: the
 * publication that replaces a unit's facts with an empty set is what removes
 * what an earlier run wrote for it (madarch-tzte.20.2's publication semantics;
 * this change states the request, not the mechanism).
 */
async function executeInventoryUnit(sources: SnapshotSource, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const reader = await sources.open(planned.repository);
  refuseWhenCancelled(unit, context);
  const provenance = provenanceOf(reader);
  // A folder stands in the tree while a file of this repository stands in it:
  // git holds no empty folder, so a path with no file under it is gone.
  const stands = planned.kind === 'file' || foldersOf(reader).has(planned.path);
  const facts = !stands
    ? []
    : planned.kind === 'file'
      ? await fileFacts(reader, planned.path, provenance)
      : directoryFacts(reader, planned.path, provenance);
  if (facts.length === 0) {
    context.progress(`the ${planned.kind} ${planned.path} does not stand in ${planned.repository} at ${reader.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  for (const fact of facts) {
    context.draft.write({ kind: 'fact', evidence: evidenceAt(reader, planned.path), value: fact });
  }
  context.progress(`wrote ${facts.length} ${facts.length === 1 ? 'fact' : 'facts'} for ${planned.kind} ${planned.path} of ${planned.repository} at ${reader.commit}`, 1);
  return { outcome: 'draft' };
}

/**
 * One file's facts: its node, and the edge from the folder (or the repository)
 * it stands in. A file's place is the whole of it — the bytes the commit holds
 * are read once here, so the range a reader is shown is the file's own and not
 * a claim about it — and its bytes are the tree's count of them, which the
 * reader has already checked against what git answers.
 */
async function fileFacts(reader: SnapshotReader, path: string, provenance: FactProvenance): Promise<readonly Fact[]> {
  const entry: SnapshotEntry | undefined = reader.entry(path);
  // A path the commit does not hold, and one that holds a submodule's commit,
  // are no file of this repository: the unit publishes nothing.
  if (entry === undefined || entry.form === 'commit') return [];
  // The same decoding `readText` answers with, the byte order mark included:
  // two readings of one file's bytes must not disagree by a code unit.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await reader.read(entry.path));
  const language = languageFor(entry.path);
  const placed: FileValue = {
    repository: reader.repository,
    path: entry.path,
    roles: rolesFor(entry.path),
    blob: entry.id,
    ...(language === undefined ? {} : { language }),
    ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
  };
  const file = makeNodeFact({
    kind: 'file',
    value: placed,
    provenance: { ...provenance, place: { file: entry.path, range: wholeFileRange(text) } },
    layer: 'extracted',
  });
  return [file, containment(reader, entry.path, file.id, provenance)];
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

/** One folder's facts: its node, and the edge from the folder (or the repository) it stands in. */
function directoryFacts(reader: SnapshotReader, path: string, provenance: FactProvenance): readonly Fact[] {
  const directory = makeNodeFact({
    kind: 'directory',
    value: { repository: reader.repository, path: repositoryPath(path) },
    provenance,
    layer: 'extracted',
  });
  return [directory, containment(reader, path, directory.id, provenance)];
}

/**
 * The `contains` edge from the node a path stands in to the node it is: the
 * folder above it, or the repository node at the root. The repository's id is
 * the one stage 0 published — its identity is the repository's name alone, so
 * the same node is named here whatever commit it was pinned at.
 */
function containment(reader: SnapshotReader, path: string, child: string, provenance: FactProvenance): Fact {
  const parent = parentOf(path);
  const container = parent === undefined
    ? makeNodeFact({ kind: 'repository', value: { repository: reader.repository, form: reader.form }, provenance, layer: 'extracted' })
    : makeNodeFact({ kind: 'directory', value: { repository: reader.repository, path: repositoryPath(parent) }, provenance, layer: 'extracted' });
  return makeEdgeFact({ kind: 'contains', value: { from: container.id, to: child }, provenance, layer: 'extracted' });
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

/**
 * A cancelled unit stops where it stands, and a unit that has read nothing is
 * no draft: the publication of an empty fact set retracts what an earlier run
 * wrote, which a cancellation must never do in silence.
 */
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

/**
 * The folders a path's legs name a role for, by the leg's own name: a file
 * under `test/` is a test, one under `vendor/` is vendored, one under
 * `migrations/` is a migration, and one under `fixtures/` is a fixture.
 */
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
 * — where the path places nothing at all — the one role `asset`, which claims
 * no more than that the repository ships it. A role the path does not name is
 * never guessed: `source` is claimed only for a file whose extension is code.
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
