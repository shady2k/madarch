/**
 * The state machines of the code, as a static stage (decision 0033, items 5,
 * 14 and 15; decision 0026's diagrams): one unit per source file, one file's
 * bytes, and the transition tables that file writes down.
 *
 * **What it publishes.** A state machine is a table a developer writes in the
 * source: a Go map of maps of states (`map[Status]map[Event]Status{...}`) or a
 * TypeScript object of states (`const transitions = { pending: { captured:
 * 'confirmed' } }`), read by `src/knowledge/state-machines.ts`'s own reader.
 * The stage publishes the machine, its states and the transitions between them
 * in the extractors' `code.*` vocabulary (decision 0033, item 7):
 *
 * - one `code.state-machine` node per table, hung from its file's node by the
 *   `code.contains` relation the file pass uses for what a file holds;
 * - one `code.state` node per state the table names, hung from the machine;
 * - one `code.transitions` edge per move, from the state it leaves to the state
 *   it enters, positioned at the line the table writes it on;
 * - one `code.coverage` node per file this stage read, carrying the blob the
 *   bytes stood under and every place the reader could not read — a file it
 *   could not read is a named gap, never a silence.
 *
 * **The unit reads no other file and no whole-tree object.** The reader is the
 * one `src/knowledge/state-machines.ts` already has, and it takes a path and a
 * text: the unit hands it the pinned file's bytes from its static context
 * (decision 0033, item 5). Nothing of the graph is read inside the unit: a
 * table is what one file says, and the file's own bytes are its whole evidence.
 *
 * **The plan reads what the previous runs published.** A unit stands for a
 * source file this stage's own coverage does not name at the blob the pinned
 * commit holds, and for a published path the commit no longer holds, whose unit
 * publishes nothing and so retracts what an earlier run wrote for it: a second
 * run of one commit plans no unit.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { FACT_KINDS, makeNodeFact, repositoryPath, type CoverageGap, type CoverageValue, type FactSource } from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { stateMachinesOf, type StateMachine } from '../../knowledge/state-machines.js';
import { evidenceAtPlace, refuseRow, rowRecord, unknownKeys } from './draft.js';
import { rolesFor } from './inventory.js';
import { STATIC_FILE_BYTE_LIMIT, type StaticStageContext, type StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { fileFactIdOf } from './syntax-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';

/** The stage's id, as it is registered and as its units are named. */
export const STATE_MACHINES_STAGE_ID = 'state-machines';

/** The stage's own version, bumped when what it writes or plans changes. */
const STATE_MACHINES_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order: the machines, their states, the moves, and the file's coverage. */
const STATE_MACHINES_STAGE_KINDS: readonly string[] = ['contains', 'coverage', 'declares', 'state', 'state-machine', 'transition'];

/** The node kinds this stage writes, in the extractors' vocabulary (decision 0033, item 7). */
const MACHINE_KIND = 'code.state-machine';
const STATE_KIND = 'code.state';

/** The relations it writes: what a file declares, what a machine holds, and what a state enters. */
const DECLARES_RELATION = 'code.declares';
const CONTAINS_RELATION = 'code.contains';
const TRANSITION_RELATION = 'code.transitions';

/** The reader every fact of this stage cites as its source: this fill's own reading of a file's transition tables. */
const STATE_MACHINES_SOURCE: FactSource = { system: 'madarch-state-machines', version: '1' };

/** The read the plan makes of what this stage published, by the file. */
export const PUBLISHED_MACHINES_READ = 'stage-state-machines-published';

/** The read of one repository's published state machines: one row per file this stage read, at the blob it stood under. */
export function publishedMachinesRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_MACHINES_READ, repository });
}

/** One row of that read: one file this stage read, at the blob its bytes stood under. */
export interface PublishedMachinesRow {
  readonly kind: 'coverage';
  readonly file: string;
  readonly blob: string;
}

/** The keys a row of that read holds, and no others. */
const MACHINES_ROW_FIELDS: readonly string[] = ['blob', 'file', 'kind'];

/** The stage, built over the source that holds the run's pins. */
export function createStateMachinesStage(sources: SnapshotSource): FillStage {
  return {
    id: STATE_MACHINES_STAGE_ID,
    version: STATE_MACHINES_STAGE_VERSION,
    staticReading: true,
    // The file nodes stage 0 published are what a machine hangs from and what the plan
    // compares blobs against: a graph without them is a stage with nothing to hang its
    // reading on, which the registry reports as starvation.
    consumes: { required: [{ capability: 'file', scope: 'repository', freshness: 'current' }], optional: [] },
    produces: [
      { kind: 'contains', schemaVersion: FACT_KINDS['contains'].version, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      // The contract vocabulary's own relation: a file declares the machine its bytes write, and the
      // resolution stage reads a file's `code.contains` children as its symbols, so a machine is never one.
      { kind: 'declares', schemaVersion: 1, scope: 'file' },
      { kind: 'state', schemaVersion: 1, scope: 'file' },
      { kind: 'state-machine', schemaVersion: 1, scope: 'file' },
      { kind: 'transition', schemaVersion: 1, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planStateMachines(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeStateMachinesUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(STATE_MACHINES_STAGE_ID, STATE_MACHINES_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run fills, in code point order of the unit ids: a unit per
 * source file this stage's own coverage does not name at the blob the pinned
 * commit holds, and one per published file the commit no longer holds, which
 * publishes nothing and so retracts what an earlier run wrote there.
 */
async function planStateMachines(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const machinesRead = publishedMachinesRead(pin.id);
    const own = publishedMachinesRows(await graph.query(machinesRead), pin.id, machinesRead);
    const readBlobs = new Map<string, string>(own.map((row) => [row.file, row.blob]));
    const mine = reader.files().filter((entry) => isReadablePath(entry.path));
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    for (const entry of mine) {
      if (readBlobs.get(entry.path) === entry.id) continue;
      // A file whose node the snapshot has not published is no unit of this stage yet: its
      // containment edge would end at a node nothing published, and the run's re-plan wave
      // plans it once the snapshot has (decision 0033, item 15).
      if (!tree.files.has(entry.path)) {
        blocked = true;
        continue;
      }
      units.push({ id: fileUnitId(pin.id, entry.path), scope: `${pin.id}:${entry.path}` });
    }
    for (const row of own) {
      // A published file the commit no longer holds: the unit publishes nothing, and the
      // publication retracts what it wrote there.
      if (present.has(row.file)) continue;
      units.push({ id: fileUnitId(pin.id, row.file), scope: `${pin.id}:${row.file}` });
    }
  }
  if (blocked) return { units: [], coverage: 'nothing-found' };
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anySource ? 'planned' : 'nothing-found' };
}

/**
 * Whether a path is a file this stage reads: source the inventory read as code,
 * and a grammar the state reader reads. The reader's own rule is the authority
 * on the languages (it answers none for a file it does not read), and the
 * inventory's role keeps a document or a data file out of the plan.
 */
function isReadablePath(path: string): boolean {
  return rolesFor(path).includes('source') && (path.endsWith('.go') || /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path));
}

// ---- one unit ------------------------------------------------------------

/**
 * One unit: the source file the unit names, read at the pinned commit, and the
 * machines its text writes down. A path the commit no longer holds publishes
 * nothing, so an earlier run's machines for a file deleted or renamed away are
 * retracted by the publication itself.
 */
async function executeStateMachinesUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const stage = staticSourceOf(unit, context);
  refuseWhenCancelled(unit, context);
  const source = stage.repository;
  const entry = await source.entry(planned.path);
  if (entry === undefined) {
    context.progress(`${planned.path} is not in the tree of ${planned.repository} at ${source.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  const file = await source.file(planned.path);
  if (file === undefined || file.unread !== undefined) {
    // A submodule, a file above the static cap and a file whose bytes are no text are all
    // named as a gap of the file's own coverage: a file this stage did not read must say so
    // (decision 0033, "Capability boundaries").
    const reason = file === undefined ? 'inaccessible' : file.unread === 'too-large' ? 'too-large' : 'unsupported';
    const coverage: CoverageValue = {
      repository: planned.repository,
      scope: planned.path,
      complete: false,
      read: [],
      unread: [{ what: `${planned.path} at ${String(STATE_MACHINES_SOURCE.system)} ${STATE_MACHINES_SOURCE.version}`, reason }],
    };
    writeCoverage(context, source, planned.path, coverage, entry.id);
    context.progress(`${planned.path} of ${planned.repository} is ${reason === 'too-large' ? 'above the static reading cap' : 'not a source text this stage reads'}: the file is published as a ${reason} coverage gap`, 1);
    return { outcome: 'draft' };
  }
  const bytes = file.content!;
  refuseWhenCancelled(unit, context);
  const text = decodeText(bytes, planned.path, planned.repository, source.commit);
  const gaps: CoverageGap[] = [];
  let machines: readonly StateMachine[] = [];
  if (text === undefined) {
    gaps.push({ what: `${planned.path} is not UTF-8 text`, reason: 'unsupported' });
  } else {
    try {
      machines = await stateMachinesOf(planned.path, text);
    } catch (error) {
      // A file whose syntax tree the reader cannot classify is a gap of the reading, named
      // with the file and the line the reader reported, never a unit that fails the run.
      gaps.push({ what: gapWhatOf(error, planned.path), reason: 'error' });
    }
  }
  const evidence = evidenceAtPlace(source, planned.path);
  for (const write of machineWrites({ repository: planned.repository, path: planned.path, fileKey: fileFactIdOf(planned.repository, planned.path), machines, evidence })) {
    context.draft.write(write);
  }
  const coverage: CoverageValue = {
    repository: planned.repository,
    scope: planned.path,
    complete: gaps.length === 0,
    read: text === undefined ? [] : [planned.path],
    unread: gaps,
  };
  writeCoverage(context, source, planned.path, coverage, entry.id);
  const states = machines.reduce((count, machine) => count + machine.states.length, 0);
  const moves = machines.reduce((count, machine) => count + machine.transitions.length, 0);
  context.progress(
    `read ${planned.path} of ${planned.repository} at ${source.commit}: ${String(machines.length)} ${machines.length === 1 ? 'state machine' : 'state machines'}, ${String(states)} ${states === 1 ? 'state' : 'states'}, ${String(moves)} ${moves === 1 ? 'transition' : 'transitions'}, ${String(gaps.length)} ${gaps.length === 1 ? 'gap' : 'gaps'}`,
    1,
  );
  return { outcome: 'draft' };
}

/** The file's text, or none where the bytes are not UTF-8: a fatal decode names the file instead of guessing its characters. */
function decodeText(bytes: Uint8Array, path: string, repository: string, commit: string): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // A file whose bytes are no UTF-8 text names itself in the gap the caller writes.
    return undefined;
  }
}

/** What one unreadable file says in its coverage: the reader's own words, or the path and the failure where it named none. */
function gapWhatOf(error: unknown, path: string): string {
  const message = error instanceof Error ? error.message : String(error);
  // The reader names the file and the line it refused at (`src/x.ts:12: ...`); a message that
  // does not is given the path and a line, so every gap names where to look.
  return message.startsWith(`${path}:`) ? message : `${path}:1: ${message}`;
}

/** The key of one machine of a file: the vocabulary's kind, the repository, the path and the table's name. */
function machineKeyOf(repository: string, path: string, name: string): string {
  return `${MACHINE_KIND}:${repository}:${path}#${name}`;
}

/** The key of one state of one machine: the machine's own key and the state's name, so two machines of a file never share a state. */
function stateKeyOf(repository: string, path: string, machine: string, name: string): string {
  return `${STATE_KIND}:${repository}:${path}#${machine}/${name}`;
}

/** What one unit's draft writes: the machine and state nodes, the containment and transition edges. */
function machineWrites(input: {
  readonly repository: string;
  readonly path: string;
  readonly fileKey: string;
  readonly machines: readonly StateMachine[];
  readonly evidence: string;
}): readonly StageDraftWrite[] {
  const writes: StageDraftWrite[] = [];
  for (const machine of input.machines) {
    const machineKey = machineKeyOf(input.repository, input.path, machine.name);
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: machineKey,
        kind: MACHINE_KIND,
        label: machine.name,
        properties: {
          recordKey: machineKey,
          factKind: 'state-machine',
          repository: input.repository,
          file: input.path,
          name: machine.name,
          ...(machine.type === null ? {} : { type: machine.type }),
          lineStart: machine.lineStart,
          lineEnd: machine.lineEnd,
          provenance: { source: STATE_MACHINES_SOURCE, repository: { id: input.repository, commit: commitOf(input.evidence) }, place: { file: input.path, range: { startLine: machine.lineStart, endLine: machine.lineEnd } } },
        },
      },
    });
    writes.push({
      kind: 'edge',
      evidence: input.evidence,
      value: { relation: DECLARES_RELATION, from: { key: input.fileKey }, to: { key: machineKey }, properties: { factKind: 'declares', repository: input.repository } },
    });
    for (const state of machine.states) {
      const stateKey = stateKeyOf(input.repository, input.path, machine.name, state.name);
      writes.push({
        kind: 'node',
        evidence: input.evidence,
        value: {
          key: stateKey,
          kind: STATE_KIND,
          label: state.label,
          properties: {
            recordKey: stateKey,
            factKind: 'state',
            repository: input.repository,
            file: input.path,
            machine: machine.name,
            name: state.name,
            label: state.label,
            line: state.line,
          },
        },
      });
      writes.push({
        kind: 'edge',
        evidence: input.evidence,
        value: { relation: CONTAINS_RELATION, from: { key: machineKey }, to: { key: stateKey }, properties: { factKind: 'contains', repository: input.repository } },
      });
    }
    for (const move of machine.transitions) {
      writes.push({
        kind: 'edge',
        evidence: input.evidence,
        value: {
          relation: TRANSITION_RELATION,
          from: { key: stateKeyOf(input.repository, input.path, machine.name, move.from) },
          to: { key: stateKeyOf(input.repository, input.path, machine.name, move.to) },
          properties: {
            factKind: 'transition',
            repository: input.repository,
            file: input.path,
            machine: machine.name,
            ...(move.event === null ? {} : { event: move.event }),
            line: move.line,
          },
        },
      });
    }
  }
  return writes;
}

/** The commit the evidence text names (`<repository>@<commit>` or `…:<path>`), for a node's provenance. */
function commitOf(evidence: string): string {
  const at = evidence.indexOf('@');
  const rest = at < 0 ? evidence : evidence.slice(at + 1);
  const end = rest.indexOf(':');
  return end < 0 ? rest : rest.slice(0, end);
}

/** One file's coverage: what was read, and every place this stage could not read, with the blob the bytes stood under. */
function writeCoverage(context: StageContext, source: StaticStageSource, path: string, coverage: CoverageValue, blob: string): void {
  const fact = makeNodeFact({
    kind: 'coverage',
    layer: 'extracted',
    provenance: { source: STATE_MACHINES_SOURCE, repository: { id: coverage.repository, commit: source.commit } },
    value: coverage,
  });
  const evidence = evidenceAtPlace(source, path);
  for (const write of graphWritesOf(fact, evidence)) {
    // The blob the plan compares against the pinned commit stands on the coverage node: the file
    // node's blob is every reading's, and this one says which reading of the file this stage made.
    context.draft.write(write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, blob } } }
      : write);
  }
}

/** The unit's static repository, refused by name where the run handed none: a static unit reads only through its own context. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageContext {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the state-machines stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/state-machines.ts, decision 0033)`);
  }
  return held;
}

/** A cancelled unit stops where it stands: a cancelled unit publishes nothing. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned file: a cancelled unit publishes nothing (src/fill/stages/state-machines.ts)`);
  }
}

// ---- reading a read's rows ------------------------------------------------

/**
 * The plan's own read, read: each row is one file this stage read and the blob
 * its bytes stood under. A row naming another kind, a file that is no
 * repository path, a blob that is no blob id, or a key this read does not
 * define is refused, naming the read, the row and the field.
 */
export function publishedMachinesRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedMachinesRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'what a file\'s state machines read');
    unknownKeys(held, MACHINES_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'coverage') throw refuseRow(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" facts`);
    const file = held['file'];
    if (typeof file !== 'string' || file === '') {
      throw refuseRow(read, index, repository, `its file ${JSON.stringify(file)} is no repository path: a coverage stands for a file of the repository`);
    }
    const blob = held['blob'];
    if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob)) {
      throw refuseRow(read, index, repository, `its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits`);
    }
    return { kind: 'coverage', file, blob };
  });
}
