/**
 * The code sites of a repository's contract reading, as a static stage
 * (decision 0033, items 5, 7, 14 and 15; madarch-8bdc.2.4): one unit per source
 * file, the file's own bytes, and the records the extract driver's contracts
 * reading publishes from that file's code.
 *
 * **What it publishes.** The untrusted inputs a file reads (`code.input`), the
 * SQL string builders and execution sinks it holds (`code.sql-build`,
 * `code.sql-sink`), the `code.flows-into` links between them, and the
 * `code.contains` edge that reaches each record from the file it stands in.
 * The reader is the driver's own per-file one: `readTsFile` takes one parsed
 * tree and answers what that file states, so the stage and the driver cannot
 * disagree about a file's inputs or its SQL path.
 *
 * **What it reads from elsewhere, and why.** Nothing: every record of this
 * stage is a fact of the file's own bytes. The families that link across files
 * (routes, entry points, the serving and calling links, the channels a file
 * speaks on) are not published here yet; the change record says which reads
 * they need.
 *
 * **What a unit publishes when it cannot read.** A path the pinned commit no
 * longer holds publishes nothing, so the publication retracts what an earlier
 * run wrote there. A file above the static cap, bytes that are not UTF-8 and a
 * tree the parser could not read are named in the file's coverage — a gap,
 * never a silence.
 *
 * **A refill writes nothing.** The plan compares each file's blob with this
 * stage's own coverage; a file it already read at the blob the pinned commit
 * holds is not planned again.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { isRepositoryPath } from '../facts.js';
import { FACT_KINDS, makeNodeFact, type CoverageGap, type CoverageValue, type FactSource } from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { readTsFile, type TsFileFacts } from '../../extract/contracts/ts-code.js';
import {
  EDGE_CONTAINS, inputKey, KIND_INPUT, KIND_SQL_BUILD, KIND_SQL_SINK, REL_FLOWS_INTO, sqlBuildKey, sqlSinkKey,
} from '../../extract/contracts/schema.js';
import type { ExtractedNode, SourceSpan } from '../../extract/records.js';
import { evidenceAtPlace } from './draft.js';
import { readSyntaxTree } from './syntax-extract.js';
import type { StaticStageContext, StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { fileFactIdOf } from './syntax-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';

/** The stage's id, as it is registered and as its units are named. */
export const CONTRACTS_CODE_STAGE_ID = 'contracts-code';

/** The stage's own version, bumped when what it writes or plans changes. */
const CONTRACTS_CODE_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order. */
const CONTRACTS_CODE_STAGE_KINDS: readonly string[] = ['contains', 'coverage', 'flows-into', 'input', 'sql-build', 'sql-sink'];

/** The reader every fact of this stage cites as its source: this fill's own reading of one file's code. */
export const CONTRACTS_CODE_SOURCE_SYSTEM = 'madarch-contracts-code';

/** The reader every fact of this stage cites. */
const CONTRACTS_CODE_SOURCE: FactSource = { system: CONTRACTS_CODE_SOURCE_SYSTEM, version: '1' };

/** The read the plan makes of what this stage published, by the file. */
export const PUBLISHED_CONTRACTS_CODE_READ = 'stage-contracts-code-published';

/** The read of one repository's published code sites: one row per file this stage read. */
function publishedContractsCodeRead(repository: string): string {
  return JSON.stringify({ read: PUBLISHED_CONTRACTS_CODE_READ, repository });
}

/** One row of that read: one file this stage read, at the blob its bytes stood under. */
interface PublishedContractsCodeRow {
  readonly kind: 'coverage';
  readonly path: string;
  readonly blob?: string;
}

/** The keys a row of that read holds, and no others. */
const CONTRACTS_CODE_ROW_FIELDS: readonly string[] = ['blob', 'kind', 'path', 'repository'];

/** The stage, built over the source that holds the run's pins. */
export function createContractsCodeStage(sources: SnapshotSource): FillStage {
  return {
    id: CONTRACTS_CODE_STAGE_ID,
    version: CONTRACTS_CODE_STAGE_VERSION,
    staticReading: true,
    consumes: { required: [{ capability: 'file', scope: 'repository', freshness: 'current' }], optional: [] },
    produces: [
      { kind: 'contains', schemaVersion: FACT_KINDS['contains'].version, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'flows-into', schemaVersion: 1, scope: 'file' },
      { kind: 'input', schemaVersion: 1, scope: 'file' },
      { kind: 'sql-build', schemaVersion: 1, scope: 'file' },
      { kind: 'sql-sink', schemaVersion: 1, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planContractsCode(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeContractsCodeUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(CONTRACTS_CODE_STAGE_ID, CONTRACTS_CODE_STAGE_KINDS, draft),
  };
}

/**
 * Whether a path is a file this stage reads: the extract driver's own source
 * rule (`src/extract/contracts/index.ts`, `isSourcePath`) for the TypeScript
 * files whose inputs and SQL path it publishes. A test file, a declaration file
 * and a file that is neither is no site of this reading.
 */
function isContractsCodePath(path: string): boolean {
  return path.endsWith('.ts')
    && !path.endsWith('.d.ts')
    && !/(^|\/)(test|tests|__tests__)\//.test(path)
    && !/\.(test|spec)\.[tj]s$/.test(path);
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run fills, in code point order of the unit ids: a unit per
 * source file this stage's own coverage does not name at the blob the pinned
 * commit holds, and one per published file the commit no longer holds, whose
 * unit publishes nothing and so retracts what an earlier run wrote for it.
 */
async function planContractsCode(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const ownRead = publishedContractsCodeRead(pin.id);
    const own = publishedContractsCodeRows(await graph.query(ownRead), pin.id, ownRead);
    const readBlobs = new Map<string, string | undefined>(own.map((row) => [row.path, row.blob]));
    const mine = reader.files().filter((entry) => isContractsCodePath(entry.path));
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    for (const entry of mine) {
      if (readBlobs.get(entry.path) === entry.id) continue;
      if (!tree.files.has(entry.path)) {
        blocked = true;
        continue;
      }
      units.push({ id: fileUnitId(pin.id, entry.path), scope: `${pin.id}:${entry.path}` });
    }
    for (const row of own) {
      if (present.has(row.path)) continue;
      units.push({ id: fileUnitId(pin.id, row.path), scope: `${pin.id}:${row.path}` });
    }
  }
  if (blocked) return { units: [], coverage: 'nothing-found' };
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anySource ? 'planned' : 'nothing-found' };
}

/** The plan's own read, read: each row is one file this stage read and the blob its bytes stood under. */
function publishedContractsCodeRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedContractsCodeRow[] {
  return rows.map((row, index) => {
    const refuse = (detail: string): Error => new Error(`the read ${read} answered row ${index + 1} for the repository ${JSON.stringify(repository)}, and ${detail}`);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw refuse(`${JSON.stringify(row)} is no row: a row is an object naming its kind and its path`);
    const held = row as Record<string, unknown>;
    for (const key of Object.keys(held).sort(byCodePoint)) {
      if (!CONTRACTS_CODE_ROW_FIELDS.includes(key)) throw refuse(`it holds ${JSON.stringify(key)}, and a row holds ${CONTRACTS_CODE_ROW_FIELDS.join(', ')}`);
    }
    if (held['kind'] !== 'coverage') throw refuse(`its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" rows`);
    const path = held['path'];
    if (typeof path !== 'string' || !isRepositoryPath(path) || !isContractsCodePath(path)) {
      throw refuse(`its path ${JSON.stringify(path)} is no source file of this reading: one is a TypeScript file the driver's own source rule reads`);
    }
    const blob = held['blob'];
    if (blob !== undefined && (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob))) throw refuse(`its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits`);
    return { kind: 'coverage', path, ...(blob === undefined ? {} : { blob }) };
  });
}

// ---- one unit ------------------------------------------------------------

/**
 * One unit: the source file the unit names, read at the pinned commit, and the
 * code sites its bytes state. A path the commit no longer holds publishes
 * nothing, so an earlier run's records for a file deleted or renamed away are
 * retracted by the publication itself.
 */
async function executeContractsCodeUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
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
    const reason = file === undefined ? 'inaccessible' : file.unread === 'too-large' ? 'too-large' : 'unsupported';
    writeCoverage(context, source, planned.path, { repository: planned.repository, scope: planned.path, complete: false, read: [], unread: [{ what: `${planned.path} at ${String(CONTRACTS_CODE_SOURCE.system)} ${CONTRACTS_CODE_SOURCE.version}`, reason }] }, entry.id);
    context.progress(`${planned.path} of ${planned.repository} is ${reason === 'too-large' ? 'above the static reading cap' : 'not a source file this stage reads'}: the file is published as a ${reason} coverage gap`, 1);
    return { outcome: 'draft' };
  }
  const read = await readSyntaxTree(planned.path, file.content!, (tree) => readTsFile(planned.path, tree.root));
  if (!read.read) {
    const gaps: CoverageGap[] = read.unread.map((gap) => ({ what: `${planned.path}:1: ${gap.what}`, reason: gap.reason }));
    writeCoverage(context, source, planned.path, { repository: planned.repository, scope: planned.path, complete: false, read: [], unread: gaps }, entry.id);
    context.progress(`${planned.path} of ${planned.repository} could not be read as TypeScript: the file is published as a coverage gap`, 1);
    return { outcome: 'draft' };
  }
  const facts = read.value as TsFileFacts;
  const evidence = evidenceAtPlace(source, planned.path);
  const fileKey = fileFactIdOf(planned.repository, planned.path);
  for (const write of codeSiteWrites({ repository: planned.repository, path: planned.path, fileKey, facts, evidence })) context.draft.write(write);
  writeCoverage(context, source, planned.path, { repository: planned.repository, scope: planned.path, complete: true, read: [planned.path], unread: [] }, entry.id);
  context.progress(
    `read ${planned.path} of ${planned.repository} at ${source.commit}: ${String(facts.inputs.length)} ${facts.inputs.length === 1 ? 'input' : 'inputs'}, ${String(facts.sqlSinks.length)} ${facts.sqlSinks.length === 1 ? 'SQL sink' : 'SQL sinks'}`,
    1,
  );
  return { outcome: 'draft' };
}

// ---- what one unit's draft writes ----------------------------------------

/** The relation a file contains a record by. */
const CONTAINS_RELATION = EDGE_CONTAINS;

/** What one unit's draft writes: the file's inputs, its SQL path and its containment. */
function codeSiteWrites(input: {
  readonly repository: string;
  readonly path: string;
  readonly fileKey: string;
  readonly facts: TsFileFacts;
  readonly evidence: string;
}): readonly StageDraftWrite[] {
  const writes: StageDraftWrite[] = [];
  const commit = commitOf(input.evidence);
  const nodes: { node: ExtractedNode; contains: boolean }[] = [];
  const edges: { relation: string; from: string; to: string }[] = [];
  const { path, facts } = input;
  for (const held of facts.inputs) {
    const key = inputKey(path, 'query', held.name);
    nodes.push({
      contains: true,
      node: {
        key,
        kind: KIND_INPUT,
        label: `query ${held.name}`,
        properties: { source: 'query', name: held.name, ...(held.fn !== undefined ? { readBy: held.fn } : {}) },
        span: held.span,
      },
    });
  }
  const pathBuilds = facts.stringSplicers.filter((splicer) => facts.buildersOnPath.includes(splicer.fn));
  for (const build of pathBuilds) {
    nodes.push({
      contains: build.span !== undefined,
      node: {
        key: sqlBuildKey(path, build.fn),
        kind: KIND_SQL_BUILD,
        label: build.fn,
        properties: { function: build.fn, spliced: build.spliced },
        ...(build.span === undefined ? {} : { span: build.span }),
      },
    });
  }
  for (const sink of facts.sqlSinks) {
    nodes.push({
      contains: true,
      node: {
        key: sqlSinkKey(path, sink.callee),
        kind: KIND_SQL_SINK,
        label: sink.callee,
        properties: { callee: sink.callee, ...(sink.fn !== undefined ? { function: sink.fn } : {}) },
        span: sink.span,
      },
    });
  }
  if (facts.inputs.length > 0 && pathBuilds.length > 0) {
    for (const held of facts.inputs) {
      if (held.fn === undefined) continue;
      if (!(facts.returnedQueryProps.get(held.fn) ?? []).includes(held.name)) continue;
      for (const build of pathBuilds) {
        if (!build.spliced.includes(held.name)) continue;
        const feeds = (facts.callSiteArgs.get(build.fn) ?? []).some((arguments_) =>
          arguments_.some((variable) => facts.bindings.get(variable)?.calls.includes(held.fn!) ?? false));
        if (feeds) edges.push({ relation: REL_FLOWS_INTO, from: inputKey(path, 'query', held.name), to: sqlBuildKey(path, build.fn) });
      }
    }
    for (const sink of facts.sqlSinks) {
      if (sink.fn === undefined) continue;
      const sinkArgVars = (facts.callSiteArgs.get(sink.fn) ?? []).flat();
      for (const build of pathBuilds) {
        const reaches = sinkArgVars.some((variable) => {
          const binding = facts.bindings.get(variable);
          if (binding === undefined) return false;
          if (binding.calls.includes(build.fn)) return true;
          return binding.vars.some((inner) => facts.bindings.get(inner)?.calls.includes(build.fn) ?? false);
        });
        if (reaches) edges.push({ relation: REL_FLOWS_INTO, from: sqlBuildKey(path, build.fn), to: sqlSinkKey(path, sink.callee) });
      }
    }
  }
  for (const held of [...nodes].sort((left, right) => byCodePoint(left.node.key, right.node.key))) {
    const span = held.node.span;
    if (span === undefined) {
      throw new Error(`${path}:1: the contracts-code stage read a ${held.node.kind} with no span, and every record of this reading names the bytes it was read from (src/fill/stages/contracts-code.ts)`);
    }
    writes.push(nodeWrite(held.node, span, input.repository, commit, input.evidence));
    if (held.contains) writes.push(edgeWrite(CONTAINS_RELATION, input.fileKey, held.node.key, { span, discriminator: '' }, input.repository, input.evidence, commit));
  }
  for (const edge of edges) writes.push(edgeWrite(edge.relation, edge.from, edge.to, { discriminator: '' }, input.repository, input.evidence, commit));
  return writes;
}

/** One node write of this stage: the record, its span and the envelope the graph holds it with. */
function nodeWrite(node: ExtractedNode, span: SourceSpan, repository: string, commit: string, evidence: string): StageDraftWrite {
  return {
    kind: 'node',
    evidence,
    value: {
      key: node.key,
      kind: node.kind,
      label: node.label,
      properties: {
        ...node.properties,
        span: { ...span },
        recordKey: node.key,
        factKind: factKindOf(node.kind),
        layer: 'extracted',
        repository,
        provenance: { source: CONTRACTS_CODE_SOURCE, repository: { id: repository, commit }, place: { file: span.path, range: { startLine: span.lineStart, startColumn: 0, endLine: span.lineEnd, endColumn: 0 } } },
      },
    },
  };
}

/** The fact kind a record's node kind stands for. */
function factKindOf(kind: string): string {
  if (kind === KIND_INPUT) return 'input';
  if (kind === KIND_SQL_BUILD) return 'sql-build';
  return 'sql-sink';
}

/** One edge write of this stage: its record's properties, its span and the discriminator the driver gives it. */
function edgeWrite(relation: string, from: string, to: string, record: { readonly span?: SourceSpan; readonly discriminator: string }, repository: string, evidence: string, commit: string): StageDraftWrite {
  return {
    kind: 'edge',
    evidence,
    value: {
      relation,
      from: { key: from },
      to: { key: to },
      properties: {
        factKind: relation.slice('code.'.length),
        layer: 'extracted',
        repository,
        discriminator: record.discriminator,
        ...(record.span === undefined ? {} : { span: { ...record.span } }),
        provenance: { source: CONTRACTS_CODE_SOURCE, repository: { id: repository, commit }, ...(record.span === undefined ? {} : { place: { file: record.span.path, range: { startLine: record.span.lineStart, startColumn: 0, endLine: record.span.lineEnd, endColumn: 0 } } }) },
      },
    },
  };
}

/** The commit the evidence text names (`<repository>@<commit>:<path>`). */
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
    provenance: { source: CONTRACTS_CODE_SOURCE, repository: { id: coverage.repository, commit: source.commit } },
    value: coverage,
  });
  const evidence = evidenceAtPlace(source, path);
  for (const write of graphWritesOf(fact, evidence)) {
    context.draft.write(write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, blob } } }
      : write);
  }
}

/** The unit's static repository, refused by name where the run handed none. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageContext {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the contracts-code stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/contracts-code.ts, decision 0033)`);
  }
  return held;
}

/** A cancelled unit stops where it stands: a cancelled unit publishes nothing. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned file: a cancelled unit publishes nothing (src/fill/stages/contracts-code.ts)`);
  }
}
