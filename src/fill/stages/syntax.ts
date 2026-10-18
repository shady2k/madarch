/**
 * Stage 3 of the fill (decision 0026, "syntax (tree-sitter, per file)"): the
 * syntax stage reads every source file of a pinned repository and writes what
 * the file declares — its symbols and the place each definition stands at, its
 * comments, its entry points, its tests, the files it imports, and one coverage
 * node saying what was read and what could not be read.
 *
 * **Units.** A unit is one source file, named `file:<repository>:<path>`; its
 * scope is `<repository>:<path>`. That is the granularity incrementality needs:
 * a commit that changes one file's bytes moves that file's unit and no other,
 * so a second run reads that file and no other.
 *
 * **The plan reads what the previous runs published.** Before it names a unit,
 * the plan makes one tracked read per repository — the same JSON document the
 * inventory's plan makes (`publishedTreeRead`) — and the graph answers the
 * `file` facts it already holds for that repository. So the plan holds:
 *
 * - a source file's unit when the file is new or its blob moved at the pinned
 *   commit: a file whose blob did not move is not re-planned (0026);
 * - a published source path the commit no longer holds, which publishes nothing
 *   and so retracts the facts of a file that was deleted, renamed away or
 *   rewritten in another language.
 *
 * **Which files are this stage's.** A path the inventory read as `source` (its
 * extension is code) is read here: with a grammar where this stage has one, and
 * as an unread coverage gap where it has none — never dropped in silence. A
 * file that is no code at all is the inventory's and the later stages' business,
 * not this stage's.
 *
 * **Bytes.** A file's bytes come from the pinned snapshot through
 * `SnapshotSource` (`src/fill/snapshot.ts`, stage 0), bound to the commit the
 * run pinned; the stage never reads a checkout's working tree. The extraction
 * itself is pure (`syntax-extract.ts`), so the same bytes answer the same facts
 * on every machine and in every run.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { ID_PATTERN } from '../../model/schema.js';
import { FACT_KINDS, isRepositoryPath, repositoryPath } from '../facts.js';
import type { SnapshotReader, SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { checkFactDraft, evidenceAt } from './draft.js';
import { publishedTreeRead, publishedTreeRows, rolesFor } from './inventory.js';
import { extractFileSyntax, unreadFileSyntax } from './syntax-extract.js';
import { syntaxFacts, type SyntaxFactSet } from './syntax-facts.js';

/** The stage's id, as it is registered and as its units are named. */
export const SYNTAX_STAGE_ID = 'syntax';

/** The stage's own version, bumped when what it writes or plans changes. */
export const SYNTAX_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order. */
export const SYNTAX_STAGE_KINDS: readonly string[] = [
  'comment', 'coverage', 'defines', 'entry-point', 'import', 'occurrence', 'symbol', 'test',
];

/** The unit id of one source file: what the unit is, the repository and the path, and nothing of a run. */
export function fileUnitId(repository: string, path: string): string {
  return `file:${repository}:${path}`;
}

/** The scope a unit covers, as the run's wiring sees it: the repository and the path. */
function scopeOf(repository: string, path: string): string {
  return `${repository}:${path}`;
}

/**
 * The stage, built over the source that holds the run's pins. `plan` reads the
 * pins and the published tree (one tracked read per repository); each unit
 * reads one file's bytes and writes that file's facts.
 */
export function createSyntaxStage(sources: SnapshotSource): FillStage {
  return {
    id: SYNTAX_STAGE_ID,
    version: SYNTAX_STAGE_VERSION,
    // The file facts of stage 1 are what this stage plans from and what its
    // `defines` and `import` edges name: a graph without them is a syntax stage
    // with nothing to read, which the registry reports as starvation rather
    // than a stage that writes edges to nodes nobody published.
    consumes: { required: [{ capability: 'file', scope: 'repository', freshness: 'current' }], optional: [] },
    produces: [
      { kind: 'comment', schemaVersion: FACT_KINDS['comment'].version, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'defines', schemaVersion: FACT_KINDS['defines'].version, scope: 'file' },
      { kind: 'entry-point', schemaVersion: FACT_KINDS['entry-point'].version, scope: 'file' },
      { kind: 'import', schemaVersion: FACT_KINDS['import'].version, scope: 'file' },
      { kind: 'occurrence', schemaVersion: FACT_KINDS['occurrence'].version, scope: 'file' },
      { kind: 'symbol', schemaVersion: FACT_KINDS['symbol'].version, scope: 'file' },
      { kind: 'test', schemaVersion: FACT_KINDS['test'].version, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planSyntax(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeSyntaxUnit(sources, unit, context),
    validate: (draft: StageDraftSet) => checkFactDraft(SYNTAX_STAGE_ID, SYNTAX_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run of the syntax stage fills: a unit per source file whose
 * blob moved at the pinned commit (or that is new), and a retraction for a
 * published source path the commit no longer holds. A graph that answers
 * nothing for a repository plans its whole tree of source files, which is what
 * a first run is. The plan is in code point order of the unit ids, so two runs
 * of one commit plan the same units in the same order.
 */
async function planSyntax(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const read = publishedTreeRead(pin.id);
    // The same reader the inventory's own plan uses: one rule for the rows of
    // one read, so the two stages cannot accept different rows.
    const published = publishedTreeRows(await graph.query(read), pin.id, read).files;
    const mine = reader.files().filter((entry) => isSourcePath(entry.path));
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    for (const entry of mine) {
      // The blob is what tells one reading of a file from the next: a file whose
      // blob did not move is already read, so this run plans no unit for it.
      if (published.get(entry.path) === entry.id) continue;
      units.push({ id: fileUnitId(pin.id, entry.path), scope: scopeOf(pin.id, entry.path) });
    }
    for (const [path] of published) {
      // A published source path the commit no longer holds: the unit publishes
      // nothing, and the publication retracts what an earlier run wrote there.
      if (present.has(path) || !isSourcePath(path)) continue;
      units.push({ id: fileUnitId(pin.id, path), scope: scopeOf(pin.id, path) });
    }
  }
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anySource ? 'planned' : 'nothing-found' };
}

/** Whether a path is a file this stage reads: the inventory's own rule, the role the path names. */
function isSourcePath(path: string): boolean {
  return rolesFor(path).includes('source');
}

/** A unit id read back as this stage planned it; an id this stage never plans is refused. */
export function plannedUnit(id: string): { repository: string; path: string } {
  const parts = id.split(':');
  const refuse = (detail: string): Error =>
    new Error(`the unit ${JSON.stringify(id)} is not one this stage plans, and ${detail}: a unit id is "file:<repository>:<path>"`);
  if (parts.length < 3 || parts[0] !== 'file') throw refuse(`its first part is ${JSON.stringify(parts[0] ?? '')}`);
  const repository = parts[1] ?? '';
  const path = parts.slice(2).join(':');
  if (!ID_PATTERN.test(repository)) throw refuse(`its repository ${JSON.stringify(repository)} is no repository name`);
  if (!isRepositoryPath(path)) throw refuse(`its path ${JSON.stringify(path)} is no repository path`);
  return { repository, path };
}

// ---- one unit ------------------------------------------------------------

/**
 * One unit: the source file the unit names, read at the pinned commit, and
 * every fact its findings make. A path the commit no longer holds publishes
 * nothing, so an earlier run's facts for a file that was deleted or renamed
 * away are retracted by the publication itself; a path whose bytes are no
 * source text here (a symbolic link holds the path it points at, a submodule's
 * commit stands in another repository) is published as a coverage gap, since a
 * file this stage did not read must say so.
 */
async function executeSyntaxUnit(sources: SnapshotSource, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const reader = await sources.open(planned.repository);
  refuseWhenCancelled(unit, context);
  const entry = reader.entry(planned.path);
  if (entry === undefined) {
    context.progress(
      `${planned.path} is not in the tree of ${planned.repository} at ${reader.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`,
      1,
    );
    return { outcome: 'draft' };
  }
  if (entry.form !== 'blob') {
    // A symbolic link's bytes are the path it points at and a submodule's tree
    // stands in the repository it names: neither is a source text this stage can
    // read, and neither is dropped in silence — the file's coverage says so.
    const set = syntaxFacts({
      repository: planned.repository,
      commit: reader.commit,
      path: repositoryPath(planned.path),
      findings: unreadFileSyntax(planned.path, 'unsupported'),
      files: reader.files().map((other) => other.path),
    });
    writeDraft(context, reader, planned.path, set);
    const what = entry.form === 'link' ? 'a symbolic link, whose bytes are the path it points at' : 'a submodule, whose tree stands in the repository it names';
    context.progress(`${planned.path} is ${what}: the file is published as a coverage gap and not read`, 1);
    return { outcome: 'draft' };
  }
  const bytes = await reader.read(planned.path);
  refuseWhenCancelled(unit, context);
  const findings = await extractFileSyntax(planned.path, bytes);
  const set = syntaxFacts({
    repository: planned.repository,
    commit: reader.commit,
    path: repositoryPath(planned.path),
    findings,
    files: reader.files().map((file) => file.path),
  });
  writeDraft(context, reader, planned.path, set);
  const read = findings.parsed ? `read ${planned.path}` : `${planned.path} was not read`;
  context.progress(
    `${read} of ${planned.repository} at ${reader.commit}: ${findings.symbols.length} ${findings.symbols.length === 1 ? 'symbol' : 'symbols'}, ${findings.imports.length} ${findings.imports.length === 1 ? 'import' : 'imports'}, ${findings.comments.length} ${findings.comments.length === 1 ? 'comment' : 'comments'}`,
    1,
  );
  return { outcome: 'draft' };
}

/** Writes each of one file's facts into the unit's draft, citing the repository, the commit and the path they were read from. */
function writeDraft(context: StageContext, reader: SnapshotReader, path: string, set: SyntaxFactSet): void {
  const evidence = evidenceAt(reader, path);
  for (const fact of set.facts) context.draft.write({ kind: 'fact', evidence, value: fact });
}

/**
 * A cancelled unit stops where it stands, and a unit that has read nothing is
 * no draft: the publication of an empty fact set retracts what the unit wrote
 * before, which a cancellation must never do in silence.
 */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned file: a cancelled unit publishes nothing`);
  }
}
