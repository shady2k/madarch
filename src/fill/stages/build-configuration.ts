/**
 * Stage 2 of the fill (decision 0026): the build and configuration stage reads
 * what a repository's manifests declare and writes it into the graph — a
 * `package` node per package a manifest declares (a `package.json`, a `go.mod`,
 * a `Cargo.toml`), a `dependency` edge between two of those packages where one
 * manifest's declaration names the other, a `deploy-unit` node per Dockerfile
 * and per compose service, an `environment-variable` node with the `consumes`
 * edge from the file that declares it, an `entry-point` node per declared
 * binary, script and container command, and a `coverage` node per manifest
 * saying what was read and what was not.
 *
 * **Units.** One unit is one manifest file: `manifest:<repository>:<path>`, its
 * scope `<repository>:<path>`. That granularity is what incrementality needs —
 * the run's wiring (madarch-tzte.21.8) names a unit's own input by that scope,
 * so a commit that changes one manifest's bytes replans that unit and no other
 * — and it is the same shape the inventory stage's units use.
 *
 * **The plan reads what earlier runs published, to retract.** One tracked read
 * per repository — the JSON document `publishedManifestsRead` — answers the
 * manifest paths stage 2 has already digested there. The plan holds a unit for
 * every manifest the pinned tree holds and one for every published path the
 * commit no longer holds; the second kind publishes nothing, which is how a
 * deleted or renamed manifest's facts are retracted (the request a publication
 * of an empty fact set makes). A plan does not compare blobs itself: the
 * unit's input digest is the run's inputs seam own (0027), and a plan that
 * named every manifest reads the tree once and no bytes.
 *
 * **A manifest that does not read is coverage.** A parse failure, a declaration
 * this stage cannot read, a dependency that names no package the pinned
 * repositories declare, a lock file's content: each is a `coverage` gap naming
 * the manifest path, the 1-based line and what stood there. Nothing is skipped
 * in silence, and a gap is never a claim of absence (0005).
 *
 * **Dependency edges hold only between packages the graph holds.** An edge's
 * ends are nodes (0026's checked writes): a manifest's dependency becomes an
 * edge where it names a package another manifest of the same repository
 * declares — by a `file:`/`link:`/`workspace:` path, a Cargo `path`, or the
 * package's own name — and a dependency that names a package outside the
 * pinned repositories stays out of the graph as a named gap, never as an edge
 * with an invented end.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { ID_PATTERN } from '../../model/schema.js';
import {
  FACT_KINDS, factId, isRepositoryPath, makeEdgeFact, makeNodeFact, repositoryPath,
  type CoverageGapReason, type DeployForm, type EntryPointForm, type Fact, type FactProvenance, type FactRange, type PackageForm,
} from '../facts.js';
import type { SnapshotEntry, SnapshotReader, SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { checkFactDraft, evidenceAt, provenanceOf } from './draft.js';
import { rolesFor } from './inventory.js';
import {
  readCompose, readDockerfile, readGoMod, readJson, readToml,
  type ComposeReading, type DockerfileReading, type GoModReading, type TextGap, type TomlReading,
} from './manifest-format.js';

/** The stage's id, as it is registered and as its units are named. */
export const BUILD_CONFIGURATION_STAGE_ID = 'build-configuration';

/** The stage's own version, bumped when what it reads, plans or writes changes. */
export const BUILD_CONFIGURATION_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order. */
export const BUILD_CONFIGURATION_STAGE_KINDS: readonly string[] = [
  'consumes', 'coverage', 'dependency', 'deploy-unit', 'entry-point', 'environment-variable', 'package',
];

/** The read the plan makes; the wiring answers it from the product graph. */
export const PUBLISHED_MANIFESTS_READ = 'stage-2-published-manifests';

/**
 * The one tracked read the plan makes: the manifest paths stage 2 has already
 * digested in one repository. The text is a JSON document, so a wiring reads it
 * as data and not as prose: `{"read": "stage-2-published-manifests",
 * "repository": "<the product's name for it>"}`.
 */
export function publishedManifestsRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_MANIFESTS_READ, repository });
}

/** One row of that read: one manifest path stage 2 published facts for. */
export interface PublishedManifestRow {
  readonly kind: 'manifest';
  readonly repository: string;
  readonly path: string;
}

/** The keys a row of the read holds, and no others. */
const ROW_FIELDS: readonly string[] = ['kind', 'path', 'repository'];

/** The unit id of one manifest file, and the scope it covers: the repository and the path. */
export function manifestUnitId(repository: string, path: string): string {
  return `manifest:${repository}:${path}`;
}

// ---- the manifests this stage reads ---------------------------------------

/**
 * The kinds of manifest this stage reads, and the file a path's name makes it:
 * `npm` a `package.json`, `go` a `go.mod`, `cargo` a `Cargo.toml`, `dockerfile`
 * a `Dockerfile`, a `Containerfile` or a `Dockerfile.<suffix>`, `compose` a
 * compose file, and `lock` a lock file, whose content this stage reads not at
 * all and reports as a gap rather than leaving unmentioned.
 */
export type ManifestKind = 'cargo' | 'compose' | 'dockerfile' | 'go' | 'lock' | 'npm';

/** The lock files this stage recognises, so that one is a declared gap and not a silence. */
const LOCK_NAMES: readonly string[] = ['bun.lock', 'bun.lockb', 'Cargo.lock', 'go.sum', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

/** The compose file's name: `compose.yml`, `docker-compose.yml`, and their `.override`, `.prod` and `yaml` forms. */
const COMPOSE_NAME = /^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)*\.ya?ml$/u;

/** The kind of manifest a repository path's name makes it, or `undefined` where this stage reads none there. */
export function manifestKindOf(path: string): ManifestKind | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'package.json') return 'npm';
  if (name === 'go.mod') return 'go';
  if (name === 'Cargo.toml') return 'cargo';
  if (name === 'Dockerfile' || name === 'Containerfile' || name.startsWith('Dockerfile.')) return 'dockerfile';
  if (COMPOSE_NAME.test(name)) return 'compose';
  if (LOCK_NAMES.includes(name)) return 'lock';
  return undefined;
}

// ---- the stage ------------------------------------------------------------

/**
 * The stage, built over the source that holds the run's pins. `plan` reads the
 * pins and the published manifests; each unit reads one manifest's bytes and
 * writes what it declares.
 */
export function createBuildConfigurationStage(sources: SnapshotSource): FillStage {
  return {
    id: BUILD_CONFIGURATION_STAGE_ID,
    version: BUILD_CONFIGURATION_STAGE_VERSION,
    // A `consumes` edge is drawn from the file node stage 1 publishes, and the
    // bytes of every manifest come from the pinned tree: a manifest read
    // against no tree, or before the file it names stands in the graph, is a
    // graph whose edges name nodes nobody wrote.
    consumes: {
      required: [
        { capability: 'file', scope: 'file', freshness: 'current' },
        { capability: 'snapshot', scope: 'repository', freshness: 'current' },
      ],
      optional: [],
    },
    // Every fact of a unit is read from that unit's one manifest and cites it:
    // the package's and the deploy unit's `manifest`, the entry point's `file`,
    // the coverage's `scope`, and the place of every edge. So the unit's
    // publication replaces what that one file declared, and no wider scope may
    // take another manifest's facts of a same-named package with it.
    produces: [
      { kind: 'consumes', schemaVersion: FACT_KINDS['consumes'].version, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'dependency', schemaVersion: FACT_KINDS['dependency'].version, scope: 'file' },
      { kind: 'deploy-unit', schemaVersion: FACT_KINDS['deploy-unit'].version, scope: 'file' },
      { kind: 'entry-point', schemaVersion: FACT_KINDS['entry-point'].version, scope: 'file' },
      { kind: 'environment-variable', schemaVersion: FACT_KINDS['environment-variable'].version, scope: 'file' },
      { kind: 'package', schemaVersion: FACT_KINDS['package'].version, scope: 'file' },
    ],
    // Which manifests a repository holds is the tree's business, and how a
    // dependency resolves is the manifests' own: a product configures neither.
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planManifests(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeManifestUnit(sources, unit, context),
    validate: (draft: StageDraftSet) => checkFactDraft(BUILD_CONFIGURATION_STAGE_ID, BUILD_CONFIGURATION_STAGE_KINDS, draft),
  };
}

/** The scope a unit covers, as the run's wiring sees it: the repository and the path. */
function scopeOf(repository: string, path: string): string {
  return `${repository}:${path}`;
}

// ---- planning -------------------------------------------------------------

/**
 * The units one run of this stage fills: a unit per manifest the pinned tree
 * holds, in code point order of their ids, and a unit per published manifest
 * path the commit no longer holds, whose `execute` writes nothing and so asks
 * for what an earlier run published there to be retracted.
 */
async function planManifests(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anyManifest = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const read = publishedManifestsRead(pin.id);
    const published = publishedManifests(await graph.query(read), pin.id, read);
    const standing = new Set<string>();
    for (const entry of reader.files()) {
      if (manifestKindOf(entry.path) === undefined) continue;
      standing.add(entry.path);
      anyManifest = true;
      units.push({ id: manifestUnitId(pin.id, entry.path), scope: scopeOf(pin.id, entry.path) });
    }
    for (const path of published) {
      if (standing.has(path)) continue;
      // A path the pinned commit no longer holds: the unit publishes nothing,
      // which is how a manifest that was deleted or renamed away asks for its
      // facts to be retracted. Its kind is read from the path again when the
      // unit runs, so a name this stage no longer reads plans nothing either.
      units.push({ id: manifestUnitId(pin.id, path), scope: scopeOf(pin.id, path) });
    }
  }
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anyManifest ? 'planned' : 'nothing-found' };
}

/**
 * The read's rows, read: each row names the repository it was read for and a
 * repository path. A row that names another repository, a kind this stage does
 * not hold, a path that is no repository path, or a key the read does not name
 * (a run id among them) is refused, naming the read, the row and what was
 * wrong with it — a row read past plans a wrong unit in silence, and a row
 * dropped leaves a stale fact behind. Two rows for one path are one row.
 */
function publishedManifests(rows: readonly unknown[], repository: string, read: string): ReadonlySet<string> {
  const paths = new Set<string>();
  rows.forEach((row, index) => {
    const refuse = (detail: string): Error => new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw refuse(`${JSON.stringify(row)} is no row: a row is an object naming its kind, its repository and its path`);
    }
    const held = row as Record<string, unknown>;
    if (held['kind'] !== 'manifest') {
      throw refuse(`its kind is ${JSON.stringify(held['kind'])}, and this stage holds "manifest"`);
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
    paths.add(repositoryPath(rawPath));
  });
  return paths;
}

// ---- one unit -------------------------------------------------------------

/**
 * One unit: the manifest's bytes read through the snapshot reader, what it
 * declares written into the draft, and one coverage fact saying what the unit
 * read and what it did not. A path the pinned commit no longer holds, one that
 * holds a submodule's commit and one whose name declares no manifest this
 * stage reads write nothing, and a unit that writes nothing is how this stage
 * asks for its earlier facts to be retracted.
 */
async function executeManifestUnit(sources: SnapshotSource, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const reader = await sources.open(planned.repository);
  refuseWhenCancelled(unit, context);
  const kind = manifestKindOf(planned.path);
  if (kind === undefined) {
    context.progress(`the path ${planned.path} declares no manifest this stage reads: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  const entry: SnapshotEntry | undefined = reader.entry(planned.path);
  if (entry === undefined || entry.form === 'commit') {
    context.progress(`the path ${planned.path} stands in no file of ${planned.repository} at ${reader.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  if (entry.form === 'link') {
    // A link's own bytes are the path it points at, and a manifest a link
    // stands for is read by whoever follows it. This stage reads a manifest's
    // own bytes, so the link is a named gap rather than the text of a path
    // read as a manifest.
    const linked = linkedGap(reader, entry.path, provenanceOf(reader));
    context.draft.write({ kind: 'fact', evidence: evidenceAt(reader, entry.path), value: linked });
    context.progress(`the path ${entry.path} of ${reader.repository} is a symbolic link, and this stage reads a manifest's own bytes: it publishes the gap and no facts`, 1);
    return { outcome: 'draft' };
  }
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await reader.read(entry.path));
  refuseWhenCancelled(unit, context);
  const lines = text.split('\n');
  const provenance = provenanceOf(reader);
  const drafted = await draftOf(kind, reader, entry.path, text, lines, provenance);
  // Two declarations of one fact are one fact: a compose file naming one
  // service twice, or a Cargo manifest naming one dependency twice, writes the
  // node once, and the repeat is named in the unit's coverage.
  for (const fact of dedupeFacts(drafted.facts)) {
    context.draft.write({ kind: 'fact', evidence: evidenceAt(reader, entry.path), value: fact });
  }
  const coverage = coverageOf(reader, entry.path, provenance, lines, drafted);
  context.draft.write({ kind: 'fact', evidence: evidenceAt(reader, entry.path), value: coverage });
  context.progress(
    `read ${entry.path} of ${reader.repository} at ${reader.commit}: ${drafted.facts.length} ${drafted.facts.length === 1 ? 'fact' : 'facts'}, ${drafted.unread.length} ${drafted.unread.length === 1 ? 'gap' : 'gaps'}`,
    1,
  );
  return { outcome: 'draft' };
}

/** The coverage one symbolic link publishes: the link's path, and why nothing stands there. */
function linkedGap(reader: SnapshotReader, path: string, provenance: FactProvenance): Fact {
  const what = `${path}:1 a symbolic link stands here, and this stage reads a manifest's own bytes and does not follow a link`;
  return makeNodeFact({
    kind: 'coverage',
    value: { repository: reader.repository, scope: path, complete: false, read: [], unread: [{ what, reason: 'unsupported' }] },
    provenance,
    layer: 'extracted',
  });
}

/** A unit id read back as this stage planned it; an id this stage never plans is refused. */
function plannedUnit(id: string): { repository: string; path: string } {
  const kind = id.slice(0, Math.max(0, id.indexOf(':')));
  const rest = id.indexOf(':') < 0 ? '' : id.slice(id.indexOf(':') + 1);
  const repository = rest.slice(0, Math.max(0, rest.indexOf(':')));
  const path = rest.indexOf(':') < 0 ? '' : rest.slice(rest.indexOf(':') + 1);
  const refuse = (detail: string): Error => new Error(`the unit ${JSON.stringify(id)} is not one this stage plans, and ${detail}: a unit id is "manifest:<repository>:<path>"`);
  if (kind !== 'manifest') throw refuse(`its kind is ${JSON.stringify(kind)}`);
  if (!ID_PATTERN.test(repository)) throw refuse(`its repository ${JSON.stringify(repository)} is no repository name`);
  if (!isRepositoryPath(path)) throw refuse(`its path ${JSON.stringify(path)} is no repository path`);
  return { repository, path };
}

/**
 * A cancelled unit stops where it stands, and a unit that has read nothing is
 * no draft: the publication of an empty fact set retracts what an earlier run
 * wrote, which a cancellation must never do in silence.
 */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned manifest: a cancelled unit publishes nothing`);
  }
}

// ---- what one manifest declares -------------------------------------------

/** One gap in what a unit read: what it could not read, and why. */
interface Unread {
  /** The path, the 1-based line and what stood there: what a reader of the graph acts on. */
  readonly what: string;
  readonly reason: CoverageGapReason;
}

/** What one manifest's reading found: its facts, the declarations it read, and the gaps it named. */
interface ManifestDrafting {
  readonly facts: readonly Fact[];
  readonly read: readonly string[];
  readonly unread: readonly Unread[];
}

/** A manifest this stage drafted, and the line its own gap stands at, when it stopped at one. */
interface DraftingResult extends ManifestDrafting {
  /** The line a parse stopped at; a coverage that reads nothing stands there. */
  readonly stoppedAt?: number;
}

/** What every drafting starts from. */
const NOTHING: ManifestDrafting = { facts: [], read: [], unread: [] };

/**
 * What one manifest's bytes declare, by the kind of manifest its name makes it.
 * A reader that stops is one gap and no facts, since what a half-read manifest
 * declares is nobody's to guess; and every gap names the path, the line and
 * what stood there.
 */
async function draftOf(kind: ManifestKind, reader: SnapshotReader, path: string, text: string, lines: readonly string[], provenance: FactProvenance): Promise<DraftingResult> {
  const at = (line: number): FactProvenance => ({ ...provenance, place: { file: repositoryPath(path), range: lineRange(lines, line) } });
  const gap = (line: number, detail: string): Unread => ({ what: `${path}:${line} ${detail}`, reason: 'unsupported' });
  const stopped = (read: TextGap, readSoFar: readonly string[] = []): DraftingResult => ({
    facts: [],
    read: readSoFar,
    unread: [gap(read.line, read.detail)],
    stoppedAt: read.line,
  });
  switch (kind) {
    case 'lock':
      // A lock file's content is where an install pinned its versions, and no
      // fact of this stage carries a version of a package outside the graph:
      // the file is named as a gap rather than left unmentioned.
      return { ...NOTHING, unread: [gap(1, 'a lock file declares resolved versions, and no fact of this stage carries one')] };
    case 'npm':
      return npmDrafting(await packageIndexOf(reader), reader, path, text, lines, at, gap, stopped);
    case 'go': {
      const read = readGoMod(text);
      if (!read.ok) return stopped(read.gap);
      return goDrafting(read.value, reader, path, at, gap, await packageIndexOf(reader));
    }
    case 'cargo': {
      const read = readToml(text);
      if (!read.ok) return stopped(read.gap);
      const drafted = cargoDrafting(read.value, reader, path, at, gap, await packageIndexOf(reader));
      // What the reader noted while it read (a key or a table declared twice)
      // is this unit's coverage, as it is for a package.json.
      return { ...drafted, unread: [...drafted.unread, ...read.gaps.map((note) => gap(note.line, note.detail))] };
    }
    case 'dockerfile': {
      const read = readDockerfile(text);
      if (!read.ok) return stopped(read.gap);
      return dockerfileDrafting(read.value, reader, path, at, gap);
    }
    case 'compose': {
      const read = readCompose(text);
      if (!read.ok) return stopped(read.gap);
      const drafted = composeDrafting(read.value, reader, path, at, gap);
      return { ...drafted, unread: [...drafted.unread, ...read.gaps.map((note) => gap(note.line, note.detail))] };
    }
  }
}

/** The range of one line of a manifest: its own first character to its own end. */
function lineRange(lines: readonly string[], line: number): FactRange {
  const text = lines[line - 1] ?? '';
  return { startLine: line, startColumn: 0, endLine: line, endColumn: text.length };
}

/** The range of a whole manifest, as a reader counts lines: the last line's end, a trailing newline ending a line. */
function wholeFileRange(lines: readonly string[]): FactRange {
  const endLine = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  return { startLine: 1, startColumn: 0, endLine: Math.max(1, endLine), endColumn: (lines[Math.max(1, endLine) - 1] ?? '').length };
}

/** The id of the file node stage 1 published for a path: a file's identity is its repository and its path. */
function fileNodeId(reader: SnapshotReader, path: string, provenance: FactProvenance): string {
  // The roles are stage 1's own declaration of what a path is, and a file's
  // identity does not read them: the id computed here is the node the inventory
  // stage published, whatever roles it wrote beside it.
  return factId({ kind: 'file', value: { repository: reader.repository, path: repositoryPath(path), roles: rolesFor(path) }, provenance });
}

/** One variable a manifest declares, and the line the configuration declares it at. */
interface DeclaredVariable {
  readonly name: string;
  readonly line: number;
}

/**
 * The environment variables and the `consumes` edges from the file that
 * declares them: one node per variable (its identity is its name alone, so the
 * variable one manifest provides is the variable another consumes) and one edge
 * from the declaring file's node. A name that is no environment variable's name
 * is a gap naming its line rather than a node with a name the schema refuses.
 */
function variableFacts(
  reader: SnapshotReader,
  path: string,
  provenance: FactProvenance,
  at: (line: number) => FactProvenance,
  gap: (line: number, detail: string) => Unread,
  declared: readonly DeclaredVariable[],
): ManifestDrafting {
  const facts: Fact[] = [];
  const unread: Unread[] = [];
  const file = fileNodeId(reader, path, provenance);
  const seen = new Set<string>();
  for (const variable of [...declared].sort((left, right) => byCodePoint(left.name, right.name) || left.line - right.line)) {
    if (!ENVIRONMENT_VARIABLE_NAME.test(variable.name)) {
      unread.push(gap(variable.line, `${JSON.stringify(variable.name)} is no environment variable's name: a name is letters, digits and "_", starting with a letter or "_"`));
      continue;
    }
    if (seen.has(variable.name)) continue;
    seen.add(variable.name);
    const node = makeNodeFact({ kind: 'environment-variable', value: { name: variable.name }, provenance: at(variable.line), layer: 'extracted' });
    facts.push(node);
    facts.push(makeEdgeFact({ kind: 'consumes', value: { from: file, variable: node.id }, provenance: at(variable.line), layer: 'extracted' }));
  }
  return { facts, read: declared.length === 0 ? [] : ['environment'], unread };
}

/** The name of an environment variable: what a shell and a container accept. */
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// ---- a package.json -------------------------------------------------------

/** The declarations of a package.json that name a dependency, in code point order. */
const NPM_DEPENDENCY_GROUPS: readonly string[] = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * What one `package.json` declares: its package (`workspace` where it declares
 * workspaces, `package` otherwise), one `dependency` edge per declaration that
 * names another package of this repository, and entry points for its `bin`
 * binaries and its `scripts`.
 */
function npmDrafting(
  index: PackageIndex,
  reader: SnapshotReader,
  path: string,
  text: string,
  lines: readonly string[],
  at: (line: number) => FactProvenance,
  gap: (line: number, detail: string) => Unread,
  stopped: (read: TextGap) => DraftingResult,
): DraftingResult {
  const read = readJson(text);
  if (!read.ok) return stopped(read.gap);
  const value = read.value.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return stopped({ line: 1, detail: 'the file is no JSON object: a package.json maps what the package is' });
  }
  const fields = value as Record<string, unknown>;
  const lineAt = read.value.lineAt;
  const readNames: string[] = [];
  const unread: Unread[] = read.gaps.map((note) => gap(note.line, note.detail));
  const facts: Fact[] = [];
  const repository = reader.repository;

  const nameValue = fields['name'];
  const name = typeof nameValue === 'string' && nameValue.trim() !== '' ? nameValue.trim() : undefined;
  const form: PackageForm = fields['workspaces'] === undefined ? 'package' : 'workspace';
  const version = typeof fields['version'] === 'string' && fields['version'].trim() !== '' ? fields['version'].trim() : undefined;
  if (nameValue !== undefined) readNames.push('name');
  if (fields['version'] !== undefined) readNames.push('version');
  if (fields['workspaces'] !== undefined) readNames.push('workspaces');
  let held: Fact | undefined;
  if (name === undefined) {
    unread.push(gap(nameValue === undefined ? 1 : lineAt(['name']), nameValue === undefined
      ? 'the manifest declares no package name, so no package node stands for it'
      : `${JSON.stringify(nameValue)} is no package name: a package is named by a string`));
  } else {
    held = makeNodeFact({
      kind: 'package',
      value: { repository, name, form, ecosystem: 'npm', ...(version === undefined ? {} : { version }), manifest: repositoryPath(path) },
      provenance: at(lineAt(['name'])),
      layer: 'extracted',
    });
    facts.push(held);
  }

  // The dependency edges: a declaration becomes an edge where it names a
  // package another manifest of this repository declares. Everything else is a
  // gap naming its line — 0026 keeps an edge's ends to nodes that stand.
  const edges: Fact[] = [];
  for (const group of NPM_DEPENDENCY_GROUPS) {
    const declared = fields[group];
    if (declared === undefined) continue;
    readNames.push(group);
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
      unread.push(gap(lineAt([group]), `${group} is no mapping of dependency names to what the package wants`));
      continue;
    }
    const dependencies = declared as Record<string, unknown>;
    for (const dependency of Object.keys(dependencies).sort(byCodePoint)) {
      const line = lineAt([group, dependency]);
      if (held === undefined) {
        unread.push(gap(line, `the dependency ${JSON.stringify(dependency)} stands in a manifest that declares no package for the edge to stand on`));
        continue;
      }
      const resolved = resolveNpmDependency(index, repository, path, dependency, dependencies[dependency], at(line));
      if (!resolved.ok) {
        unread.push(gap(line, `the dependency ${JSON.stringify(dependency)} ${resolved.why}`));
        continue;
      }
      if (resolved.id === held.id) {
        unread.push(gap(line, `the dependency ${JSON.stringify(dependency)} is the package of this manifest: a package does not depend on itself`));
        continue;
      }
      edges.push(makeEdgeFact({ kind: 'dependency', value: { from: held.id, to: resolved.id, basis: 'manifest' }, provenance: at(line), layer: 'extracted' }));
    }
  }
  facts.push(...dedupeFacts(edges));

  // The declared entry points: a binary a package ships, and a script a caller
  // runs. A `bin` written as one string names the command after the package.
  const entryPoints: Fact[] = [];
  const entry = (formOfEntry: EntryPointForm, entryName: string, line: number): void => {
    entryPoints.push(makeNodeFact({ kind: 'entry-point', value: { repository, file: repositoryPath(path), name: entryName, form: formOfEntry }, provenance: at(line), layer: 'extracted' }));
  };
  const bin = fields['bin'];
  if (bin !== undefined) {
    readNames.push('bin');
    if (typeof bin === 'string') {
      if (name === undefined) unread.push(gap(lineAt(['bin']), 'the manifest ships a binary named after the package, and the package declares no name'));
      else entry('cli-command', name, lineAt(['bin']));
    } else if (bin !== null && typeof bin === 'object' && !Array.isArray(bin)) {
      for (const command of Object.keys(bin as Record<string, unknown>).sort(byCodePoint)) entry('cli-command', command, lineAt(['bin', command]));
    } else {
      unread.push(gap(lineAt(['bin']), 'bin is neither a path nor a mapping of command names to paths'));
    }
  }
  const scripts = fields['scripts'];
  if (scripts !== undefined) {
    readNames.push('scripts');
    if (scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)) {
      for (const script of Object.keys(scripts as Record<string, unknown>).sort(byCodePoint)) entry('cli-command', script, lineAt(['scripts', script]));
    } else {
      unread.push(gap(lineAt(['scripts']), 'scripts is no mapping of script names to the commands they run'));
    }
  }
  facts.push(...dedupeFacts(entryPoints));
  return { facts, read: readNames, unread };
}

// ---- a go.mod -------------------------------------------------------------

/** What one `go.mod` declares: the module it is, and a dependency edge per requirement of another module of this repository. */
function goDrafting(
  read: GoModReading,
  reader: SnapshotReader,
  path: string,
  at: (line: number) => FactProvenance,
  gap: (line: number, detail: string) => Unread,
  index: PackageIndex,
): DraftingResult {
  const held = makeNodeFact({
    kind: 'package',
    value: { repository: reader.repository, name: read.module, form: 'package', ecosystem: 'go', manifest: repositoryPath(path) },
    provenance: at(1),
    layer: 'extracted',
  });
  const edges: Fact[] = [];
  const unread: Unread[] = [];
  for (const requirement of read.requires) {
    const resolved = resolveByName(index, reader.repository, requirement.path, 'go', at(requirement.line));
    if (!resolved.ok) {
      unread.push(gap(requirement.line, `the requirement ${JSON.stringify(requirement.path)} ${resolved.why}`));
      continue;
    }
    if (resolved.id === held.id) {
      // A module that requires itself names the node the edge would stand in.
      unread.push(gap(requirement.line, `the requirement ${JSON.stringify(requirement.path)} is the module of this file: a package does not depend on itself`));
      continue;
    }
    edges.push(makeEdgeFact({ kind: 'dependency', value: { from: held.id, to: resolved.id, basis: 'manifest' }, provenance: at(requirement.line), layer: 'extracted' }));
  }
  return { facts: [held, ...dedupeFacts(edges)], read: read.read, unread };
}

// ---- a Cargo.toml ---------------------------------------------------------

/** The dependency tables of a Cargo manifest this stage reads, in code point order. */
const CARGO_DEPENDENCY_TABLES: readonly string[] = ['build-dependencies', 'dependencies', 'dev-dependencies'];

/**
 * What one `Cargo.toml` declares: its package (or its workspace, which names
 * none), one `dependency` edge per dependency that names another Cargo package
 * of this repository (by a `path`, or by the package's own name), and entry
 * points for its `[[bin]]` binaries and its `[lib]` library.
 */
function cargoDrafting(
  read: TomlReading,
  reader: SnapshotReader,
  path: string,
  at: (line: number) => FactProvenance,
  gap: (line: number, detail: string) => Unread,
  index: PackageIndex,
): DraftingResult {
  const tables = read.value;
  const readNames: string[] = [];
  const unread: Unread[] = [];
  const facts: Fact[] = [];
  const repository = reader.repository;
  const manifest = repositoryPath(path);
  const packageTable = tableOf(tables['package']);
  const packageName = typeof packageTable?.['name'] === 'string' ? (packageTable['name'] as string).trim() : undefined;
  const version = typeof packageTable?.['version'] === 'string' ? (packageTable['version'] as string).trim() : undefined;
  if (tables['package'] !== undefined) readNames.push('package');
  if (tables['workspace'] !== undefined) readNames.push('workspace');
  let held: Fact | undefined;
  if (packageName === undefined || packageName === '') {
    unread.push(gap(packageTable === undefined ? 1 : read.lineAt(['package', 'name']), 'the manifest declares no package name, so no package node stands for it'));
  } else {
    held = makeNodeFact({
      kind: 'package',
      // A Cargo manifest that declares a workspace and no package name (a
      // virtual manifest) writes no package node at all: a package's identity
      // is its name, and there is none to stand for it. The unit's coverage
      // says so.
      value: { repository, name: packageName, form: 'package', ecosystem: 'cargo', ...(version === undefined || version === '' ? {} : { version }), manifest },
      provenance: at(read.lineAt(['package', 'name'])),
      layer: 'extracted',
    });
    facts.push(held);
  }
  const edges: Fact[] = [];
  const dependencyTables: { readonly where: readonly string[]; readonly name: string }[] = [];
  for (const name of CARGO_DEPENDENCY_TABLES) if (tables[name] !== undefined) dependencyTables.push({ where: [name], name });
  const targets = tableOf(tables['target']);
  if (targets !== undefined) {
    readNames.push('target');
    for (const target of Object.keys(targets).sort(byCodePoint)) {
      const held2 = tableOf(targets[target]);
      if (held2 === undefined) continue;
      for (const name of CARGO_DEPENDENCY_TABLES) if (held2[name] !== undefined) dependencyTables.push({ where: ['target', target, name], name });
    }
  }
  for (const group of dependencyTables.sort((left, right) => byCodePoint(left.where.join('.'), right.where.join('.')))) {
    readNames.push(group.name);
    const declared = tableOf(valueAt(tables, group.where));
    if (declared === undefined) {
      unread.push(gap(read.lineAt(group.where), `${group.where.join('.')} is no table of dependency names`));
      continue;
    }
    for (const dependency of Object.keys(declared).sort(byCodePoint)) {
      const line = read.lineAt([...group.where, dependency]);
      if (held === undefined) {
        unread.push(gap(line, `the dependency ${JSON.stringify(dependency)} stands in a manifest that declares no package for the edge to stand on`));
        continue;
      }
      const resolved = resolveCargoDependency(index, repository, path, dependency, declared[dependency], at(line));
      if (!resolved.ok) {
        unread.push(gap(line, `the dependency ${JSON.stringify(dependency)} ${resolved.why}`));
        continue;
      }
      if (resolved.id === held.id) {
        unread.push(gap(line, `the dependency ${JSON.stringify(dependency)} is the package of this manifest: a package does not depend on itself`));
        continue;
      }
      edges.push(makeEdgeFact({ kind: 'dependency', value: { from: held.id, to: resolved.id, basis: 'manifest' }, provenance: at(line), layer: 'extracted' }));
    }
  }
  facts.push(...dedupeFacts(edges));

  // The declared entry points: every `[[bin]]` is a command, and the `[lib]`
  // is a library. Cargo names a target after its package where it declares no
  // name of its own, so that name stands here too.
  const entryPoints: Fact[] = [];
  const bins = Array.isArray(tables['bin']) ? tables['bin'] : [];
  bins.forEach((entry, position) => {
    const table = tableOf(entry);
    const declared = typeof table?.['name'] === 'string' ? (table['name'] as string).trim() : undefined;
    const named = declared === undefined || declared === '' ? packageName : declared;
    // A target that declares no name takes its package's, and then stands at
    // its own table header: the name key it does not carry is no place.
    const line = declared === undefined || declared === '' ? read.lineAt(['bin', position]) : read.lineAt(['bin', position, 'name']);
    if (named === undefined || named === '') {
      unread.push(gap(line, 'a binary declares no name and its package none either'));
      return;
    }
    entryPoints.push(makeNodeFact({ kind: 'entry-point', value: { repository, file: manifest, name: named, form: 'cli-command' }, provenance: at(line), layer: 'extracted' }));
  });
  if (bins.length > 0) readNames.push('bin');
  const library = tableOf(tables['lib']);
  if (tables['lib'] !== undefined) {
    readNames.push('lib');
    const declared = typeof library?.['name'] === 'string' ? (library['name'] as string).trim() : undefined;
    const named = declared === undefined || declared === '' ? packageName : declared;
    const line = declared === undefined || declared === '' ? read.lineAt(['lib']) : read.lineAt(['lib', 'name']);
    if (named === undefined || named === '') unread.push(gap(line, 'the library declares no name and its package none either'));
    else entryPoints.push(makeNodeFact({ kind: 'entry-point', value: { repository, file: manifest, name: named, form: 'library-export' }, provenance: at(line), layer: 'extracted' }));
  }
  facts.push(...dedupeFacts(entryPoints));
  return { facts, read: readNames, unread };
}

/** One value of a parsed table as a table, where it is one. */
function tableOf(value: unknown): Record<string, unknown> | undefined {
  return value === null || typeof value !== 'object' || Array.isArray(value) ? undefined : (value as Record<string, unknown>);
}

/** The value at a path inside a parsed table. */
function valueAt(root: Record<string, unknown>, path: readonly string[]): unknown {
  let held: unknown = root;
  for (const key of path) {
    const table = tableOf(held);
    if (table === undefined) return undefined;
    held = table[key];
  }
  return held;
}

/** One fact of each id, in the order the first stood: two declarations of one fact are one fact. */
function dedupeFacts(facts: readonly Fact[]): readonly Fact[] {
  const seen = new Set<string>();
  const kept: Fact[] = [];
  for (const fact of facts) {
    if (seen.has(fact.id)) continue;
    seen.add(fact.id);
    kept.push(fact);
  }
  return kept;
}

// ---- a Dockerfile ---------------------------------------------------------

/**
 * What one Dockerfile declares: the container it builds (named by the folder it
 * stands in, or by the repository at the root, since a Dockerfile's own name is
 * its file name), the environment variables its `ENV` and `ARG` instructions
 * declare with the file as the place that reads them, and the command its
 * `ENTRYPOINT` and `CMD` name.
 */
function dockerfileDrafting(
  read: DockerfileReading,
  reader: SnapshotReader,
  path: string,
  at: (line: number) => FactProvenance,
  gap: (line: number, detail: string) => Unread,
): DraftingResult {
  const repository = reader.repository;
  const folder = parentOf(path);
  const facts: Fact[] = [];
  const unread: Unread[] = [];
  const readNames = new Set<string>();
  for (const instruction of read.instructions) readNames.add(instruction.name.toLowerCase());
  facts.push(makeNodeFact({
    kind: 'deploy-unit',
    value: { repository, name: folder === undefined ? repository : folder, form: 'container', manifest: repositoryPath(path) },
    provenance: at(1),
    layer: 'extracted',
  }));
  if (!read.instructions.some((instruction) => instruction.name === 'FROM')) {
    unread.push(gap(1, 'the file declares no FROM: a Dockerfile builds from a base image'));
  }
  const variables: DeclaredVariable[] = [];
  const entryPoints: Fact[] = [];
  for (const instruction of read.instructions) {
    if (instruction.name === 'ENV' || instruction.name === 'ARG') {
      const declared = declaredVariableNames(instruction.argument);
      for (const name of declared.names) variables.push({ name, line: instruction.line });
      if (declared.malformed) {
        // Docker refuses a line that mixes `KEY=value` pairs with a lone name,
        // so this reader does not guess which form a token takes: it reads the
        // pairs it found and names the line it could not read whole.
        unread.push(gap(instruction.line, `${instruction.name} mixes "KEY=value" pairs with a lone name, and which form a token takes is Docker's own rule`));
      }
      readNames.add(instruction.name === 'ENV' ? 'env' : 'arg');
      continue;
    }
    if (instruction.name === 'ENTRYPOINT' || instruction.name === 'CMD') {
      const command = instruction.argument.trim();
      if (command === '') {
        unread.push(gap(instruction.line, `${instruction.name} names no command`));
        continue;
      }
      readNames.add(instruction.name === 'ENTRYPOINT' ? 'entrypoint' : 'cmd');
      entryPoints.push(makeNodeFact({
        kind: 'entry-point',
        value: { repository, file: repositoryPath(path), name: command, form: 'main' },
        provenance: at(instruction.line),
        layer: 'extracted',
      }));
    }
  }
  const declared = variableFacts(reader, path, at(1), at, gap, variables);
  if (variables.length > 0) readNames.add('environment');
  facts.push(...declared.facts);
  facts.push(...dedupeFacts(entryPoints));
  return { facts, read: [...readNames].sort(byCodePoint), unread: [...unread, ...declared.unread] };
}

/**
 * The variable names one `ENV` or `ARG` instruction declares: `KEY=value`
 * pairs, `KEY value` (the first token alone names the variable when the
 * instruction's first token carries no `=`), and the name alone.
 */
function declaredVariableNames(argument: string): { readonly names: readonly string[]; readonly malformed: boolean } {
  const tokens = argument.trim().split(/\s+/u).filter((token) => token !== '');
  const first = tokens[0];
  if (first === undefined) return { names: [], malformed: false };
  // `ENV KEY the rest is the value`: a first token with no `=` names the
  // variable and the whole remainder is its value.
  if (!first.includes('=')) return { names: [first], malformed: false };
  const names: string[] = [];
  let malformed = false;
  for (const token of tokens) {
    const at = token.indexOf('=');
    if (at > 0) names.push(token.slice(0, at));
    else malformed = true;
  }
  return { names, malformed };
}

// ---- a compose file ------------------------------------------------------

/**
 * What one compose file declares: a `service` deploy unit per service, the
 * environment variables its services declare (with the file as the place that
 * reads them), and a gap naming every `env_file` it hands its environment to,
 * which this stage does not read.
 */
function composeDrafting(
  read: ComposeReading,
  reader: SnapshotReader,
  path: string,
  at: (line: number) => FactProvenance,
  gap: (line: number, detail: string) => Unread,
): DraftingResult {
  const repository = reader.repository;
  const facts: Fact[] = [];
  const unread: Unread[] = [];
  const variables: DeclaredVariable[] = [];
  const readNames = new Set<string>(['services']);
  for (const service of read.services) {
    facts.push(makeNodeFact({
      kind: 'deploy-unit',
      value: { repository, name: service.name, form: 'service', manifest: repositoryPath(path) },
      provenance: at(service.line),
      layer: 'extracted',
    }));
    if (service.environment.length > 0) readNames.add('environment');
    for (const variable of service.environment) variables.push({ name: variable.name, line: variable.line });
    for (const file of service.envFiles) {
      readNames.add('env_file');
      unread.push(gap(file.line, `the service ${JSON.stringify(service.name)} takes its environment from ${JSON.stringify(file.named)}, and this stage reads no env_file`));
    }
  }
  if (read.services.length === 0) unread.push(gap(1, 'the file declares no services: a compose file serves at least one'));
  const declared = variableFacts(reader, path, at(1), at, gap, variables);
  facts.push(...declared.facts);
  return { facts, read: [...readNames].sort(byCodePoint), unread: [...unread, ...declared.unread] };
}

// ---- the packages a repository declares ----------------------------------

/** One package a manifest declares, as the graph's node names it. */
interface IndexedPackage {
  readonly name: string;
  readonly form: PackageForm;
  readonly ecosystem: string;
}

/** What one repository's manifests declare: the package at each manifest path, and the paths that declare each name. */
interface PackageIndex {
  readonly byPath: ReadonlyMap<string, IndexedPackage>;
  readonly byName: ReadonlyMap<string, readonly string[]>;
}

/** One index per reader, built once while a run fills: the tree of a commit never changes. */
const PACKAGE_INDEXES = new WeakMap<SnapshotReader, Promise<PackageIndex>>();

/**
 * The packages one repository's manifests declare, by manifest path and by
 * name, read once per reader. A dependency's end is a node (0026), so a
 * resolution answers which manifest declares the package and what that
 * manifest calls it; a manifest this index cannot read declares nothing here,
 * and the unit whose dependency named it reports the miss in its coverage.
 */
async function packageIndexOf(reader: SnapshotReader): Promise<PackageIndex> {
  const held = PACKAGE_INDEXES.get(reader);
  if (held !== undefined) return await held;
  const built = buildPackageIndex(reader);
  PACKAGE_INDEXES.set(reader, built);
  return await built;
}

/** The index itself: one read of every manifest of a kind that declares a package. */
async function buildPackageIndex(reader: SnapshotReader): Promise<PackageIndex> {
  const byPath = new Map<string, IndexedPackage>();
  const byName = new Map<string, string[]>();
  for (const entry of reader.files()) {
    const kind = manifestKindOf(entry.path);
    if (kind !== 'npm' && kind !== 'go' && kind !== 'cargo') continue;
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await reader.read(entry.path));
    const declared = declaredPackageOf(kind, text);
    if (declared === undefined) continue;
    byPath.set(entry.path, declared);
    const held = byName.get(declared.name) ?? [];
    held.push(entry.path);
    byName.set(declared.name, held);
  }
  for (const held of byName.values()) held.sort(byCodePoint);
  return { byPath, byName };
}

/** The package one manifest declares, read for the index alone: what a dependency's name resolves against. */
function declaredPackageOf(kind: ManifestKind, text: string): IndexedPackage | undefined {
  if (kind === 'npm') {
    const read = readJson(text);
    if (!read.ok) return undefined;
    const fields = tableOf(read.value.value);
    const name = fields === undefined ? undefined : fields['name'];
    if (typeof name !== 'string' || name.trim() === '') return undefined;
    return { name: name.trim(), form: fields?.['workspaces'] === undefined ? 'package' : 'workspace', ecosystem: 'npm' };
  }
  if (kind === 'go') {
    const read = readGoMod(text);
    return read.ok ? { name: read.value.module, form: 'package', ecosystem: 'go' } : undefined;
  }
  const read = readToml(text);
  if (!read.ok) return undefined;
  const packageTable = tableOf(read.value.value['package']);
  const name = packageTable?.['name'];
  return typeof name === 'string' && name.trim() !== '' ? { name: name.trim(), form: 'package', ecosystem: 'cargo' } : undefined;
}

/** What a dependency's declaration resolved to: the package's node, or why none stands. */
type Resolution = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly why: string };

/** The node id of one package, as the graph's identity reads it: the repository, the form and the name. */
function packageNodeId(repository: string, held: IndexedPackage, provenance: FactProvenance): string {
  return factId({ kind: 'package', value: { repository, name: held.name, form: held.form }, provenance });
}

/**
 * The package a manifest path declares, or the reason no package stands there.
 * The path names the manifest's own format, so a package of another ecosystem
 * standing there is refused rather than joined: a dependency's end is the
 * package the declaring manifest's own ecosystem resolves.
 */
function resolveAtPath(index: PackageIndex, repository: string, ecosystem: string, path: string, provenance: FactProvenance): Resolution {
  const held = index.byPath.get(path);
  if (held === undefined) return { ok: false, why: `names ${JSON.stringify(path)}, which declares no package this repository's manifests do` };
  if (held.ecosystem !== ecosystem) {
    return { ok: false, why: `names ${JSON.stringify(path)}, which declares a ${held.ecosystem} package, and this manifest depends on a ${ecosystem} one` };
  }
  return { ok: true, id: packageNodeId(repository, held, provenance) };
}

/**
 * The package one name declares in this repository, in the ecosystem of the
 * manifest that declares the dependency, or the reason no single one stands: a
 * `yaml` a `Cargo.toml` depends on is the crate, never a same-named npm
 * package another manifest of the repository ships.
 */
function resolveByName(index: PackageIndex, repository: string, name: string, ecosystem: string, provenance: FactProvenance): Resolution {
  const named = index.byName.get(name) ?? [];
  const paths = named.filter((path) => index.byPath.get(path)?.ecosystem === ecosystem);
  if (paths.length === 0) {
    return { ok: false, why: named.length === 0 ? 'names no package this repository\'s manifests declare' : `names no ${ecosystem} package this repository's manifests declare` };
  }
  if (paths.length > 1) return { ok: false, why: `names ${paths.length} ${ecosystem} packages this repository's manifests declare (${paths.join(', ')}), and no one of them is the dependency's end` };
  const first = paths[0];
  const held = first === undefined ? undefined : index.byPath.get(first);
  if (held === undefined) return { ok: false, why: `names no ${ecosystem} package this repository's manifests declare` };
  return { ok: true, id: packageNodeId(repository, held, provenance) };
}

/** How one `package.json` dependency's specifier resolves: a `file:`/`link:` path, else the package's own name. */
function resolveNpmDependency(index: PackageIndex, repository: string, fromPath: string, name: string, spec: unknown, provenance: FactProvenance): Resolution {
  if (typeof spec === 'string') {
    const prefixed = /^(file|link):(.*)$/u.exec(spec);
    if (prefixed !== null) {
      const target = resolveRelative(parentOf(fromPath), prefixed[2] ?? '');
      if (target === undefined) return { ok: false, why: `names the path ${JSON.stringify(spec)}, which leaves the repository` };
      return resolveAtPath(index, repository, 'npm', target === '' ? 'package.json' : `${target}/package.json`, provenance);
    }
  }
  return resolveByName(index, repository, name, 'npm', provenance);
}

/** How one Cargo dependency's specifier resolves: a `path` table with a manifest, else the package's own name. */
function resolveCargoDependency(index: PackageIndex, repository: string, fromPath: string, name: string, spec: unknown, provenance: FactProvenance): Resolution {
  const table = tableOf(spec);
  const declared = table?.['path'];
  if (typeof declared === 'string') {
    const target = resolveRelative(parentOf(fromPath), declared);
    if (target === undefined) return { ok: false, why: `names the path ${JSON.stringify(declared)}, which leaves the repository` };
    return resolveAtPath(index, repository, 'cargo', target === '' ? 'Cargo.toml' : `${target}/Cargo.toml`, provenance);
  }
  return resolveByName(index, repository, name, 'cargo', provenance);
}

/** The folder a path stands in; `undefined` at the repository root. */
function parentOf(path: string): string | undefined {
  const at = path.lastIndexOf('/');
  return at < 0 ? undefined : path.slice(0, at);
}

/**
 * The repository path a relative specifier names, from the folder the manifest
 * stands in: `.` and empty legs are dropped, `..` takes a leg back, and a path
 * that climbs above the repository's root is no path of it at all.
 */
function resolveRelative(folder: string | undefined, spec: string): string | undefined {
  const parts = folder === undefined || folder === '' ? [] : folder.split('/');
  for (const leg of spec.replace(/\\/gu, '/').split('/')) {
    if (leg === '' || leg === '.') continue;
    if (leg === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(leg);
  }
  return parts.join('/');
}

// ---- the coverage one unit publishes -------------------------------------

/**
 * The coverage a unit publishes: the manifest path as its scope, the
 * declarations it read in code point order and each once, and every gap with
 * its reason, in code point order of its `what`. A manifest that stopped at a
 * line stands there, so the fact's own place names the line a reader opens.
 */
function coverageOf(
  reader: SnapshotReader,
  path: string,
  provenance: FactProvenance,
  lines: readonly string[],
  drafted: DraftingResult,
): Fact {
  const unread = [...new Map(drafted.unread.map((gap) => [gap.what, gap])).values()]
    .sort((left, right) => byCodePoint(left.what, right.what));
  const read = [...new Set(drafted.read)].sort(byCodePoint);
  const place: FactRange = drafted.stoppedAt === undefined ? wholeFileRange(lines) : lineRange(lines, drafted.stoppedAt);
  return makeNodeFact({
    kind: 'coverage',
    value: { repository: reader.repository, scope: path, complete: unread.length === 0, read, unread },
    provenance: { ...provenance, place: { file: repositoryPath(path), range: place } },
    layer: 'extracted',
  });
}
