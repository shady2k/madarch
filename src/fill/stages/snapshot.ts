/**
 * Stage 0 of the fill (decision 0026; decision 0033's "The file is the unit of
 * static work"): the snapshot stage pins the code repositories and the product
 * repository the run fills, and writes what it pinned as graph nodes — one
 * `code.repository` node and one `code.commit` node per repository at the
 * commit it was read at, one `code.file` node per file, one `code.directory`
 * node per folder, and one `code.coverage` node for each path the tree holds
 * that no node can name.
 *
 * **Units.** A unit is one file, one folder, one unfiled path or one repository:
 * `file:<repository>:<path>`, `directory:<repository>:<path>`,
 * `unfiled:<repository>:<path>` or `repository:<repository>`. The plan reads the
 * pinned tree's listing — paths and blob ids, never blob contents — and each
 * unit's `execute` reads one file's bytes through the static context. No unit
 * reads the tree, and no repository-wide object is handed to a stage.
 *
 * **The plan reads what the previous runs published.** A file's unit stands
 * when the file is new or its blob moved; a folder's unit when the folder is
 * new or vanished; a repository's unit when its repository or commit node is
 * absent; an unfiled path's unit when its coverage node is absent. A published
 * path the pinned commit no longer holds is planned too, and its unit publishes
 * nothing: the publication of an empty draft under the unit's own scope ends
 * what an earlier run wrote there.
 *
 * The stage writes graph nodes only; the orchestrator's publication transaction
 * applies them to the 0028 graph (decision 0027's one atomic operation). The
 * vocabulary is the extractors' own `code.*` (decision 0033, item 7).
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { ID_PATTERN } from '../../model/schema.js';
import {
  FACT_KINDS, isRepositoryPath, makeNodeFact, repositoryPath, type DirectoryValue, type Fact, type FactProvenance,
  type FileValue, type RepositoryValue, type SnapshotValue,
} from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage, type StageContext, type StageExecutionResult, type StageGraphReader, type StagePlan, type StageUnit } from '../stage.js';
import { evidenceAtPlace, provenanceOfPlace } from './draft.js';
import { directoriesOf, languageFor, rolesFor, wholeFileRange } from './inventory.js';
import type { StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf, type StaticNodeDraft } from './static-graph.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';

/** The stage's id, as it is registered and as its units are named. */
export const SNAPSHOT_STAGE_ID = 'snapshot';

/** The stage's own version, bumped when what it writes or plans changes. */
export const SNAPSHOT_STAGE_VERSION = 2;

/** The fact kinds the stage produces, in code point order. */
export const SNAPSHOT_STAGE_KINDS: readonly string[] = ['coverage', 'directory', 'file', 'repository', 'snapshot'];

/** The read the plan makes of the repository and commit nodes an earlier run published. */
export const PUBLISHED_REPOSITORY_READ = 'stage-0-published-repository';

/** The read the plan makes of the coverage nodes the stage published for paths no fact can name. */
export const PUBLISHED_UNFILED_READ = 'stage-0-unfiled';

/** The read of one repository's published repository and commit nodes. */
export function publishedRepositoryRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_REPOSITORY_READ, repository });
}

/** The read of one repository's published unfiled coverage. */
function publishedUnfiledRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_UNFILED_READ, repository });
}

/** One row of the repository read. */
export interface PublishedRepositoryRow {
  readonly kind: 'repository' | 'snapshot';
  readonly repository: string;
  readonly commit?: string;
}

/** One row of the unfiled read. */
export interface PublishedUnfiledRow {
  readonly kind: 'coverage';
  readonly repository: string;
  readonly path: string;
}

/** The unit id of one file. */
function fileUnitId(repository: string, path: string): string {
  return `file:${repository}:${path}`;
}

/** The unit id of one directory. */
function directoryUnitId(repository: string, path: string): string {
  return `directory:${repository}:${path}`;
}

/** The unit id of one path no fact can name. */
function unfiledUnitId(repository: string, path: string): string {
  return `unfiled:${repository}:${path}`;
}

/** The unit id of one repository's repository and commit nodes. */
function repositoryUnitId(repository: string): string {
  return `repository:${repository}`;
}

/** The scope a unit covers: `<repository>` for a repository, `<repository>:<path>` for a path. */
function scopeOf(repository: string, path?: string): string {
  return path === undefined ? repository : `${repository}:${path}`;
}

/** One unit id as this stage planned it. */
type PlannedUnit =
  | { readonly kind: 'file'; readonly repository: string; readonly path: string }
  | { readonly kind: 'directory'; readonly repository: string; readonly path: string }
  | { readonly kind: 'unfiled'; readonly repository: string; readonly path: string }
  | { readonly kind: 'repository'; readonly repository: string };

/**
 * The stage, built over the source that holds the run's pins. `plan` reads the
 * pins and the graph's published nodes; each unit reads one file's bytes, one
 * folder's standing or one repository's scalars.
 */
export function createSnapshotStage(sources: SnapshotSource): FillStage {
  return {
    id: SNAPSHOT_STAGE_ID,
    version: SNAPSHOT_STAGE_VERSION,
    staticReading: true,
    consumes: { required: [], optional: [] },
    produces: [
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'repository' },
      { kind: 'directory', schemaVersion: FACT_KINDS['directory'].version, scope: 'repository' },
      { kind: 'file', schemaVersion: FACT_KINDS['file'].version, scope: 'file' },
      { kind: 'repository', schemaVersion: FACT_KINDS['repository'].version, scope: 'repository' },
      { kind: 'snapshot', schemaVersion: FACT_KINDS['snapshot'].version, scope: 'repository' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planSnapshot(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeSnapshotUnit(unit, context),
    validate: (draft) => checkStaticGraphDraft(SNAPSHOT_STAGE_ID, SNAPSHOT_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/** The units one run of the snapshot fills, from the pinned tree's listing and the graph's published nodes. */
async function planSnapshot(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anything = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const files = reader.files();
    const unfiled = reader.unfiled();
    anything = anything || files.length > 0 || unfiled.length > 0;
    const read = publishedTreeRead(pin.id);
    const published = publishedTreeRows(await graph.query(read), pin.id, read);
    const present = new Set<string>(files.map((entry) => entry.path));
    const folders = new Set(directoriesOf(files.map((entry) => entry.path)));
    for (const entry of files) {
      if (published.files.get(entry.path) === entry.id) continue;
      units.push({ id: fileUnitId(pin.id, entry.path), scope: scopeOf(pin.id, entry.path) });
    }
    for (const path of published.files.keys()) {
      if (present.has(path)) continue;
      units.push({ id: fileUnitId(pin.id, path), scope: scopeOf(pin.id, path) });
    }
    for (const path of folders) {
      if (published.directories.has(path)) continue;
      units.push({ id: directoryUnitId(pin.id, path), scope: scopeOf(pin.id, path) });
    }
    for (const path of published.directories) {
      if (folders.has(path)) continue;
      units.push({ id: directoryUnitId(pin.id, path), scope: scopeOf(pin.id, path) });
    }
    const repositoryRead = publishedRepositoryRead(pin.id);
    const repositories = publishedRepositoryRows(await graph.query(repositoryRead), pin.id, repositoryRead);
    const commitPublished = repositories.some((row) => row.kind === 'snapshot' && row.commit === reader.commit);
    const repositoryPublished = repositories.some((row) => row.kind === 'repository');
    if (!commitPublished || !repositoryPublished) units.push({ id: repositoryUnitId(pin.id), scope: scopeOf(pin.id) });
    if (unfiled.length > 0) {
      const unfiledRead = publishedUnfiledRead(pin.id);
      const publishedUnfiled = new Set(publishedUnfiledRows(await graph.query(unfiledRead), pin.id, unfiledRead).map((row) => row.path));
      for (const entry of unfiled) {
        if (publishedUnfiled.has(entry.path)) continue;
        units.push({ id: unfiledUnitId(pin.id, entry.path), scope: scopeOf(pin.id, entry.path) });
      }
    }
  }
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anything ? 'planned' : 'nothing-found' };
}

/** The repository read's rows, read: a repository node and the commit nodes one repository published. */
export function publishedRepositoryRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedRepositoryRow[] {
  return rows.map((row, index) => {
    const refuse = (detail: string): Error => new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw refuse(`${JSON.stringify(row)} is no row: a row is an object naming its kind and its repository`);
    const held = row as Record<string, unknown>;
    const kind = held['kind'];
    if (kind !== 'repository' && kind !== 'snapshot') throw refuse(`its kind is ${JSON.stringify(kind)}, and this read answers "repository" and "snapshot"`);
    if (held['repository'] !== repository) throw refuse(`its repository is ${JSON.stringify(held['repository'])}, and the read was for ${JSON.stringify(repository)}: one read is one repository`);
    const keys = Object.keys(held).sort(byCodePoint);
    const allowed = kind === 'snapshot' ? ['commit', 'kind', 'repository'] : ['kind', 'repository'];
    const unknown = keys.filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw refuse(`it holds ${unknown.map((key) => JSON.stringify(key)).join(', ')}, and a ${kind} row holds ${allowed.join(', ')}`);
    if (kind === 'repository') return { kind, repository };
    const commit = held['commit'];
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw refuse(`its commit ${JSON.stringify(commit)} is no commit id: 40 lower-case hexadecimal digits`);
    return { kind, repository, commit };
  });
}

/** The unfiled read's rows, read. */
function publishedUnfiledRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedUnfiledRow[] {
  return rows.map((row, index) => {
    const refuse = (detail: string): Error => new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw refuse(`${JSON.stringify(row)} is no row: a row is an object naming its kind, its repository and its path`);
    const held = row as Record<string, unknown>;
    if (held['kind'] !== 'coverage') throw refuse(`its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" rows`);
    if (held['repository'] !== repository) throw refuse(`its repository is ${JSON.stringify(held['repository'])}, and the read was for ${JSON.stringify(repository)}: one read is one repository`);
    const keys = Object.keys(held).sort(byCodePoint);
    const unknown = keys.filter((key) => !['kind', 'path', 'repository'].includes(key));
    if (unknown.length > 0) throw refuse(`it holds ${unknown.map((key) => JSON.stringify(key)).join(', ')}, and a row holds kind, path, repository`);
    if (typeof held['path'] !== 'string' || held['path'] === '') throw refuse(`its path ${JSON.stringify(held['path'])} is no path: an unfiled path is the tree's own name`);
    return { kind: 'coverage', repository, path: held['path'] };
  });
}

// ---- one unit ------------------------------------------------------------

/** One unit: the node or nodes its path or repository makes, or nothing for a path the commit no longer holds. */
async function executeSnapshotUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const source = staticSourceOf(unit, context);
  const provenance = provenanceOfPlace(source);
  if (planned.kind === 'unfiled') {
    context.draft.write({ kind: 'node', evidence: evidenceAtPlace(source, planned.path), value: unfiledNode(planned.repository, planned.path, provenance) });
    context.progress(`named the path ${planned.path} of ${source.repository} that no repository path can hold: the coverage node says it was not read`, 1);
    return { outcome: 'draft' };
  }
  const facts = await factsOf(planned, source, provenance);
  for (const fact of facts) {
    const evidence = fact.provenance.place === undefined
      ? evidenceAtPlace(source)
      : evidenceAtPlace(source, fact.provenance.place.file);
    for (const write of graphWritesOf(fact, evidence)) context.draft.write(write);
  }
  if (facts.length === 0) {
    context.progress(`nothing stands at ${plannedUnitPlace(planned)} in ${source.repository} at ${source.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  context.progress(`wrote ${facts.length} ${facts.length === 1 ? 'node' : 'nodes'} for ${plannedUnitPlace(planned)} of ${source.repository} at ${source.commit}`, 1);
  return { outcome: 'draft' };
}

/** The place a unit names, for a progress note. */
function plannedUnitPlace(unit: PlannedUnit): string {
  return unit.kind === 'repository' ? `the repository ${unit.repository}` : `the ${unit.kind} ${unit.path}`;
}

/** The facts one unit makes: the file's node, the folder's, the repository's two, or the unfiled path's coverage. */
async function factsOf(unit: PlannedUnit, source: StaticStageSource, provenance: FactProvenance): Promise<readonly Fact[]> {
  if (unit.kind === 'file') {
    const entry = await source.entry(unit.path);
    if (entry === undefined || entry.form === 'commit') return [];
    const file = await source.file(unit.path);
    if (file === undefined || file.form === 'commit') return [];
    const language = languageFor(file.path);
    const placed: FileValue = {
      repository: source.repository,
      path: repositoryPath(file.path),
      roles: rolesFor(file.path),
      blob: file.id,
      ...(language === undefined ? {} : { language }),
      ...(file.bytes === undefined ? {} : { bytes: file.bytes }),
    };
    const text = file.content === undefined ? undefined : new TextDecoder('utf-8', { ignoreBOM: true }).decode(file.content);
    const range = text === undefined ? { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 } : wholeFileRange(text);
    const fileFact = makeNodeFact({
      kind: 'file',
      value: placed,
      provenance: { ...provenance, place: { file: repositoryPath(file.path), range } },
      layer: 'extracted',
    });
    if (file.unread === undefined) return [fileFact];
    const coverage = makeNodeFact({
      kind: 'coverage',
      value: { repository: source.repository, scope: repositoryPath(file.path), complete: false, read: [], unread: [{ what: file.path, reason: file.unread }] },
      provenance,
      layer: 'extracted',
    });
    return [fileFact, coverage];
  }
  if (unit.kind === 'directory') {
    if (!(await source.holdsDirectory(unit.path))) return [];
    const directory: DirectoryValue = { repository: source.repository, path: repositoryPath(unit.path) };
    return [makeNodeFact({ kind: 'directory', value: directory, provenance, layer: 'extracted' })];
  }
  const repositoryValue: RepositoryValue = { repository: source.repository, form: source.form, ...(source.defaultBranch === undefined ? {} : { defaultBranch: source.defaultBranch }) };
  const snapshotValue: SnapshotValue = { repository: source.repository, commit: source.commit, tree: source.tree, fileCount: source.fileCount, byteCount: source.byteCount };
  return [
    makeNodeFact({ kind: 'repository', value: repositoryValue, provenance, layer: 'extracted' }),
    makeNodeFact({ kind: 'snapshot', value: snapshotValue, provenance, layer: 'extracted' }),
  ];
}

/**
 * The coverage node of a tree path no fact can name: its key is its repository
 * and its raw path, and its properties say what could not be read. No fact
 * stands behind it because the fact schema holds repository paths, and this
 * path is exactly the one it cannot hold.
 */
function unfiledNode(repository: string, path: string, provenance: FactProvenance): StaticNodeDraft {
  const key = `unfiled:${repository}:${path}`;
  return {
    key,
    kind: 'code.coverage',
    label: `${repository}:${path}`,
    properties: {
      recordKey: key,
      factKind: 'coverage',
      repository,
      scope: path,
      complete: false,
      read: [],
      unread: [{ what: path, reason: 'unsupported' }],
      unfiledPath: true,
      layer: 'extracted',
      status: 'proposed',
      provenance,
    },
  };
}

/** The unit id read back as this stage planned it; an id this stage never plans is refused. */
function plannedUnit(id: string): PlannedUnit {
  const first = id.indexOf(':');
  const kind = first < 0 ? '' : id.slice(0, first);
  const rest = first < 0 ? '' : id.slice(first + 1);
  const refuse = (detail: string): Error => new Error(`the unit ${JSON.stringify(id)} is not one this stage plans, and ${detail}: a unit id is "file:<repository>:<path>", "directory:<repository>:<path>", "unfiled:<repository>:<path>" or "repository:<repository>"`);
  if (kind === 'repository') {
    if (!ID_PATTERN.test(rest)) throw refuse(`its repository ${JSON.stringify(rest)} is no repository name`);
    return { kind, repository: rest };
  }
  if (kind !== 'file' && kind !== 'directory' && kind !== 'unfiled') throw refuse(`its kind is ${JSON.stringify(kind)}`);
  const second = rest.indexOf(':');
  const repository = second < 0 ? '' : rest.slice(0, second);
  const path = second < 0 ? '' : rest.slice(second + 1);
  if (!ID_PATTERN.test(repository)) throw refuse(`its repository ${JSON.stringify(repository)} is no repository name`);
  if (kind !== 'unfiled' && !isRepositoryPath(path)) throw refuse(`its path ${JSON.stringify(path)} is no repository path`);
  if (kind === 'unfiled' && path === '') throw refuse('its path is empty: an unfiled path is the tree\'s own name');
  return { kind, repository, path };
}

/** The unit's static repository, refused by name where the run handed none. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageSource {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the snapshot stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/snapshot.ts, decision 0033)`);
  }
  return held.repository;
}

/** A cancelled unit stops where it stands: a cancellation publishes nothing. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned repository: a cancelled unit publishes nothing`);
  }
}
