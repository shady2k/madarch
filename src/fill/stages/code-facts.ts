/**
 * The facts one file's bytes hold that a reader of the graph uses (decision 0033,
 * items 5 and 14; madarch-8bdc.2.4, madarch-8bdc.2.5): its Go struct fields, the
 * unit it belongs to and the ports its code listens on, with the file's coverage.
 *
 * **The parse is no longer stored.** Until madarch-8bdc.2.5 this stage published
 * every expression, binding and call of a file as a graph node, and the readings
 * that needed them read them back: 29 267 of the training repository's 42 294
 * nodes were one file's syntax tree, written, indexed and read again. The owner's
 * rule is that a stage parses its file, keeps the facts it found and throws the
 * tree away, so the walk moved into `file-facts.ts` and every reading calls it
 * over the bytes it holds. What stays published here is what a reader asks the
 * graph for: a field (the catalog's `code.field`), the unit a file belongs to, the
 * ports it listens on, and this stage's coverage of the file.
 *
 * **The code-facts capability is unchanged in name.** The plan still names one unit
 * per source file, compares the file's blob with the coverage this stage wrote, and
 * re-plans a file whose manifest chain moved; the publication still replaces the
 * unit's facts in one transaction. Only the facts it publishes got smaller.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { FACT_KINDS, makeNodeFact, type CoverageGap, type CoverageValue } from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { evidenceAtPlace, refuseRow, rowRecord, unknownKeys } from './draft.js';
import { rolesFor } from './inventory.js';
import type { ManifestEntry, ManifestLookup } from './service-membership.js';
import { folderOf, manifestChainOf, serviceMembershipOf, type ServiceMembership, type ServiceMembershipRead } from './service-membership.js';
import type { StaticStageContext, StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { fileFactIdOf } from './syntax-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';
import { gapWhatOf, storeText, type CallableFact, type FieldFact } from './file-facts.js';

/** The stage's id, as it is registered and as its units are named. */
export const CODE_FACTS_STAGE_ID = 'code-facts';

/** The stage's own version, bumped when what it writes or plans changes. */
const CODE_FACTS_STAGE_VERSION = 8;

/** The fact kinds the stage produces, in code point order. */
const CODE_FACTS_STAGE_KINDS: readonly string[] = ['callable', 'coverage', 'declares', 'field', 'listener-port', 'service-unit'];

/** The node kind a Go struct field is, and the two facts a file's own membership answers. */
const FIELD_KIND = 'code.field';
const SERVICE_UNIT_KIND = 'code.service-unit';
const LISTENER_PORT_KIND = 'code.listener-port';

/** The relation a file's own facts hang from it by. */
const DECLARES_RELATION = 'code.declares';

/** The reader every fact of this stage cites. */
const CODE_FACTS_SOURCE = { system: 'madarch-code-facts', version: '1' } as const;

/** The most bytes one file's facts may hold; the context's own cap, named here so a gap says what it was. */
const FILE_BYTE_LIMIT = 1_048_576;

/** Where one field stands in a file: the bytes a reader slices and the lines it counts, 1-based. */
type SourceSpan = FieldFact['span'];

/** The read the plan makes of what this stage published, by the file. */
export const CODE_FACTS_PUBLISHED_READ = 'stage-code-facts-published';

/** The read of one repository's published code facts: one row per file this stage read. */
function publishedFactsRead(repository: string): string {
  return JSON.stringify({ read: CODE_FACTS_PUBLISHED_READ, repository });
}

/** One row of that read: one file this stage read, at the blob its bytes stood under. */
export interface PublishedCodeFactsRow {
  readonly kind: 'coverage';
  readonly file: string;
  readonly blob: string;
  /** The manifests the reading stood on, nearest first; absent where an earlier version wrote the row. */
  readonly unitChain?: readonly string[];
}

/** The keys a row of that read holds, and no others. */
const FACTS_ROW_FIELDS: readonly string[] = ['blob', 'file', 'kind', 'unitChain'];

/** The stage, built over the source that holds the run's pins. */
export function createCodeFactsStage(sources: SnapshotSource): FillStage {
  return {
    id: CODE_FACTS_STAGE_ID,
    version: CODE_FACTS_STAGE_VERSION,
    staticReading: true,
    // The file nodes stage 0 published are what a field, a unit and a port hang from and what
    // the plan compares blobs against: a graph without them starves this stage by name.
    consumes: { required: [{ capability: 'file', scope: 'repository', freshness: 'current' }], optional: [] },
    produces: [
      { kind: 'callable', schemaVersion: 1, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'declares', schemaVersion: 1, scope: 'file' },
      { kind: 'field', schemaVersion: 1, scope: 'file' },
      { kind: 'listener-port', schemaVersion: 1, scope: 'file' },
      { kind: 'service-unit', schemaVersion: 1, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planCodeFacts(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeCodeFactsUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(CODE_FACTS_STAGE_ID, CODE_FACTS_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run fills, in code point order of the unit ids: a unit per
 * source file this stage's own coverage does not name at the blob the pinned
 * commit holds, and one per published file the commit no longer holds, whose
 * unit publishes nothing and so retracts what an earlier run wrote there.
 */
async function planCodeFacts(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const factsRead = publishedFactsRead(pin.id);
    const own = publishedFactsRows(await graph.query(factsRead), pin.id, factsRead);
    const readState = new Map(own.map((row) => [row.file, row]));
    const mine = reader.files().filter((entry) => isFactPath(entry.path));
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    // The manifest chain above a folder, read once per folder: the plan is the run's own reading
    // of the tree, and a manifest that moved moves every file under it (the unit's own walk is
    // path-scoped; this one answers the same chain from the same pinned tree).
    const chains = new Map<string, Promise<readonly string[]>>();
    const lookup = async (path: string): Promise<ManifestEntry | undefined> => {
      const entry = reader.entry(path);
      return entry === undefined || entry.form === 'commit' ? undefined : { path, blob: entry.id };
    };
    const chainAt = (folder: string): Promise<readonly string[]> => {
      const held = chains.get(folder);
      if (held !== undefined) return held;
      const made = manifestChainOf(folder, lookup);
      chains.set(folder, made);
      return made;
    };
    for (const entry of mine) {
      const held = readState.get(entry.path);
      const chain = await chainAt(folderOf(entry.path));
      if (held !== undefined && held.blob === entry.id && sameChain(held.unitChain, chain)) continue;
      if (!tree.files.has(entry.path)) {
        blocked = true;
        continue;
      }
      units.push({ id: fileUnitId(pin.id, entry.path), scope: `${pin.id}:${entry.path}` });
    }
    for (const row of own) {
      if (present.has(row.file)) continue;
      units.push({ id: fileUnitId(pin.id, row.file), scope: `${pin.id}:${row.file}` });
    }
  }
  if (blocked) return { units: [], coverage: 'nothing-found' };
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anySource ? 'planned' : 'nothing-found' };
}

/** Whether a path is a file this stage reads: source the inventory read as code, in a grammar the syntax stage loads. */
function isFactPath(path: string): boolean {
  return rolesFor(path).includes('source') && (path.endsWith('.go') || /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path));
}

/** Whether two manifest chains are one reading: the same manifests at the same blobs, in the same order. */
function sameChain(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && left.length === right.length && left.every((entry, index) => entry === right[index]);
}

// ---- the facts of one file ------------------------------------------------

/**
 * One unit: the source file the unit names, read at the pinned commit. The file's
 * bytes are parsed through the run's own memory (`FileFactsCache`), so a file the
 * operations, library-effects or data-model reading also read in this run is
 * parsed once, and this unit's fields cost nothing that was not already paid.
 */
async function executeCodeFactsUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const stage = staticSourceOf(unit, context);
  const source = stage.repository;
  const entry = await source.entry(planned.path);
  if (entry === undefined) {
    context.progress(`${planned.path} is not in the tree of ${planned.repository} at ${source.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  const file = await source.file(planned.path);
  if (file === undefined || file.unread !== undefined) {
    const reason = file === undefined ? 'inaccessible' : file.unread === 'too-large' ? 'too-large' : 'unsupported';
    const coverage: CoverageValue = {
      repository: planned.repository,
      scope: planned.path,
      complete: false,
      read: [],
      unread: [{ what: `${planned.path} at ${String(CODE_FACTS_SOURCE.system)} ${CODE_FACTS_SOURCE.version}`, reason }],
    };
    writeCoverage(context, source, planned.path, coverage, entry.id, await manifestChainAt(source, planned.path));
    context.progress(`${planned.path} of ${planned.repository} is ${reason === 'too-large' ? `above the static reading cap of ${String(FILE_BYTE_LIMIT)} bytes` : 'not a source text this stage reads'}: the file is published as a ${reason} coverage gap`, 1);
    return { outcome: 'draft' };
  }
  refuseWhenCancelled(unit, context);
  const gaps: CoverageGap[] = [];
  // The unit the file belongs to, read from the manifests above its folder one path at a time:
  // the walk names a gap where a manifest's declaration could not be read.
  let membership: ServiceMembershipRead = { chain: [], gaps: [] };
  try {
    membership = await serviceMembershipOf(planned.path, manifestLookup(source));
  } catch (error) {
    gaps.push({ what: gapWhatOf(error, planned.path), reason: 'error' });
  }
  for (const gap of membership.gaps) gaps.push({ what: gap, reason: 'unsupported' });
  const parsed = await stage.fileFacts.parse({
    repository: planned.repository,
    commit: source.commit,
    path: planned.path,
    blob: entry.id,
    bytes: file.content!,
    exists: async (candidate: string) => (await source.entry(candidate)) !== undefined,
  });
  for (const gap of parsed.gaps) gaps.push(gap);
  // A file no tree was made of is one gap in this stage's own words, as it was before the parse
  // left the store: the reason is the reader's, and the words name this reading.
  if (!parsed.parsed) gaps.push({ what: `${planned.path} at ${String(CODE_FACTS_SOURCE.system)} ${CODE_FACTS_SOURCE.version}`, reason: parsed.unreadReason ?? 'error' });
  const evidence = evidenceAtPlace(source, planned.path);
  const fileKey = fileFactIdOf(planned.repository, planned.path);
  for (const write of factWrites({
    repository: planned.repository, path: planned.path, fileKey, fields: parsed.facts.fields, callables: parsed.callables,
    commit: source.commit, evidence,
    ports: parsed.ports, ...(membership.unit === undefined ? {} : { membership: membership.unit }),
  })) {
    context.draft.write(write);
  }
  const coverage: CoverageValue = {
    repository: planned.repository,
    scope: planned.path,
    complete: gaps.length === 0,
    read: parsed.parsed ? [planned.path] : [],
    unread: gaps,
  };
  writeCoverage(context, source, planned.path, coverage, entry.id, membership.chain);
  context.progress(
    `read ${planned.path} of ${planned.repository} at ${source.commit}: ${String(parsed.facts.fields.length)} ${parsed.facts.fields.length === 1 ? 'field' : 'fields'}, ${String(parsed.ports.length)} ${parsed.ports.length === 1 ? 'port' : 'ports'}, ${membership.unit === undefined ? 'no service unit' : `the service unit ${membership.unit.name}`}, ${String(gaps.length)} ${gaps.length === 1 ? 'gap' : 'gaps'}`,
    1,
  );
  return { outcome: 'draft' };
}

/** What one unit's draft writes: a field, the unit the file belongs to, and the ports its code listens on. */
function factWrites(input: {
  readonly repository: string;
  readonly path: string;
  readonly fileKey: string;
  readonly fields: readonly FieldFact[];
  readonly callables: readonly CallableFact[];
  readonly commit: string;
  readonly evidence: string;
  readonly ports: readonly string[];
  readonly membership?: ServiceMembership;
}): readonly StageDraftWrite[] {
  const writes: StageDraftWrite[] = [];
  const provenance = { source: CODE_FACTS_SOURCE, repository: { id: input.repository, commit: input.commit } };
  // The callables a file declares or writes as an argument. This is the one place a name stands
  // for a body no declaration names: a route's handler, a callback, a goroutine. A reader ends its
  // edges at that node (the operations reading's `symbolNodeKey`), and asks the graph for a member
  // of a declared type by name (`methodLookup`), which is a question over a folder and not over a
  // file — so the fact stays published, by its own reason, while the expression tree that produced
  // it does not.
  for (const callable of input.callables) {
    if (callable.callable !== true) continue;
    const key = `code.callable:${input.repository}:${callable.key.slice('code.symbol:'.length)}`;
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key,
        kind: 'code.callable',
        label: callable.qualifiedName,
        properties: {
          ...callable,
          recordKey: key,
          factKind: 'callable',
          repository: input.repository,
          file: input.path,
          path: input.path,
          symbolKey: callable.key,
          symbolGlobalName: `${input.repository}:${input.path}#${callable.qualifiedName}`,
          provenance: { ...provenance, place: { file: input.path, range: rangeOf(callable.span) } },
        },
      },
    });
    writes.push({ kind: 'edge', evidence: input.evidence, value: { relation: DECLARES_RELATION, from: { key: input.fileKey }, to: { key }, properties: { factKind: 'declares', repository: input.repository } } });
  }
  for (const field of input.fields) {
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: field.id,
        kind: FIELD_KIND,
        label: field.name,
        properties: {
          ...field,
          recordKey: field.id,
          factKind: 'field',
          repository: input.repository,
          file: input.path,
          path: input.path,
          provenance: { ...provenance, place: { file: input.path, range: rangeOf(field.span) } },
        },
      },
    });
  }
  // The unit the file belongs to: one node per file, so a later stage reads an operation's
  // service by the file it stands in (`byProperty('code.service-unit', 'file', path)`).
  if (input.membership !== undefined) {
    const unitKey = serviceUnitKeyOf(input.repository, input.path);
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: unitKey,
        kind: SERVICE_UNIT_KIND,
        label: input.membership.name,
        properties: {
          recordKey: unitKey,
          factKind: 'service-unit',
          repository: input.repository,
          file: input.path,
          path: input.path,
          name: input.membership.name,
          root: input.membership.root,
          manifestPath: input.membership.manifestPath,
          ecosystem: input.membership.ecosystem,
          declared: input.membership.declared,
          provenance,
        },
      },
    });
    writes.push({ kind: 'edge', evidence: input.evidence, value: { relation: DECLARES_RELATION, from: { key: input.fileKey }, to: { key: unitKey }, properties: { factKind: 'declares', repository: input.repository } } });
  }
  // The ports the file's code listens on: one node per port, carrying the unit it serves where one
  // declares it, so a contract's server is matched to its service by a read by property.
  for (const port of input.ports) {
    const portKey = listenerPortKeyOf(input.repository, input.path, port);
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: portKey,
        kind: LISTENER_PORT_KIND,
        label: port,
        properties: {
          recordKey: portKey,
          factKind: 'listener-port',
          repository: input.repository,
          file: input.path,
          path: input.path,
          port,
          ...(input.membership === undefined ? {} : { service: input.membership.name }),
          provenance,
        },
      },
    });
    writes.push({ kind: 'edge', evidence: input.evidence, value: { relation: DECLARES_RELATION, from: { key: input.fileKey }, to: { key: portKey }, properties: { factKind: 'declares', repository: input.repository } } });
  }
  // No fact a store holds may carry U+0000 or a lone surrogate: PostgreSQL's text and jsonb cannot, and a
  // source file may hold the byte itself. Each string a write carries is kept as the escape a reader sees.
  return writes.map((write): StageDraftWrite => {
    if (write.kind === 'node') {
      return { ...write, value: { ...write.value, label: storeText(write.value.label), properties: storeDeep(write.value.properties) as Record<string, unknown> } };
    }
    if (write.kind === 'edge' && write.value.properties !== undefined) {
      return { ...write, value: { ...write.value, properties: storeDeep(write.value.properties) as Record<string, unknown> } };
    }
    return write;
  });
}


/** A value whose strings are storage-safe: U+0000 and lone surrogates as the escapes a reader sees. */
function storeDeep(value: unknown): unknown {
  if (typeof value === 'string') return storeText(value);
  if (Array.isArray(value)) return value.map(storeDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = storeDeep((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** The key of one file's service-unit node: the vocabulary's kind, the repository and the file. */
function serviceUnitKeyOf(repository: string, path: string): string {
  return `${SERVICE_UNIT_KIND}:${repository}:${path}`;
}

/** The key of one file's port node: the unit's own key shape, with the port it listens on. */
function listenerPortKeyOf(repository: string, path: string, port: string): string {
  return `${LISTENER_PORT_KIND}:${repository}:${path}#${port}`;
}

/** The line range a fact's place carries: the syntax stage's own shape for a node's provenance. */
function rangeOf(span: SourceSpan): { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number } {
  return { startLine: span.lineStart, startColumn: 0, endLine: span.lineEnd, endColumn: 0 };
}

/** One file's coverage: what was read, every place this stage could not read, the blob the bytes stood under, and the manifests the membership stood on. */
function writeCoverage(context: StageContext, source: StaticStageSource, path: string, coverage: CoverageValue, blob: string, unitChain: readonly string[]): void {
  const fact = makeNodeFact({
    kind: 'coverage',
    layer: 'extracted',
    provenance: { source: CODE_FACTS_SOURCE, repository: { id: coverage.repository, commit: source.commit } },
    value: coverage,
  });
  const evidence = evidenceAtPlace(source, path);
  for (const write of graphWritesOf(fact, evidence)) {
    context.draft.write(write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, blob, unitChain: [...unitChain] } } }
      : write);
  }
}

/** How one unit reads a manifest above its file: one path at a time, its blob and, below the cap, its bytes. */
function manifestLookup(source: StaticStageSource): ManifestLookup {
  return async (path: string): Promise<ManifestEntry | undefined> => {
    const entry = await source.entry(path);
    if (entry === undefined || entry.form === 'commit') return undefined;
    if (entry.bytes !== undefined && entry.bytes > FILE_BYTE_LIMIT) return { path, blob: entry.id };
    const file = await source.file(path);
    return { path, blob: entry.id, ...(file?.content === undefined ? {} : { bytes: file.content }) };
  };
}

/** The manifest chain above one file, read from the pinned tree without reading a manifest's bytes. */
async function manifestChainAt(source: StaticStageSource, path: string): Promise<readonly string[]> {
  return await manifestChainOf(folderOf(path), async (candidate: string) => {
    const entry = await source.entry(candidate);
    return entry === undefined || entry.form === 'commit' ? undefined : { path: candidate, blob: entry.id };
  });
}

/** The unit's static repository, refused by name where the run handed none. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageContext {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the code-facts stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/code-facts.ts, decision 0033)`);
  }
  return held;
}

/** A cancelled unit stops where it stands: a cancelled unit publishes nothing. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned file: a cancelled unit publishes nothing (src/fill/stages/code-facts.ts)`);
  }
}

// ---- reading a read's rows ------------------------------------------------

/**
 * The plan's own read, read: each row is one file this stage read and the blob
 * its bytes stood under. A row naming another kind, a file that is no
 * repository path, a blob that is no blob id, or a key this read does not
 * define is refused, naming the read, the row and the field.
 */
function publishedFactsRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedCodeFactsRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'what a file\'s code facts read');
    unknownKeys(held, FACTS_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'coverage') throw refuseRow(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" facts`);
    const file = held['file'];
    if (typeof file !== 'string' || file === '') {
      throw refuseRow(read, index, repository, `its file ${JSON.stringify(file)} is no repository path: a coverage stands for a file of the repository`);
    }
    const blob = held['blob'];
    if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob)) {
      throw refuseRow(read, index, repository, `its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits`);
    }
    const unitChain = held['unitChain'];
    if (unitChain !== undefined && (!Array.isArray(unitChain) || unitChain.some((entry) => typeof entry !== 'string' || entry === ''))) {
      throw refuseRow(read, index, repository, `its unitChain ${JSON.stringify(unitChain)} is no list of manifest places: a place is a path and the blob it stood under`);
    }
    return { kind: 'coverage', file, blob, ...(unitChain === undefined ? {} : { unitChain: unitChain as readonly string[] }) };
  });
}
