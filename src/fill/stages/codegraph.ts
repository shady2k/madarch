/**
 * The code pass: the library's reading of one repository's tree, as a stage of
 * the fill (decision 0033's "The code pass", items 5 and 14 as amended
 * 2026-11-06; the owner's words "Да, берем.").
 *
 * **One unit is one repository at one pinned commit.** The stage writes that
 * commit's tree into a throwaway folder outside the checkout, indexes it with
 * `@colbymchenry/codegraph` through its library API, reads the library's nodes
 * and edges, joins their ends to the records the per-file passes published, and
 * writes the links through the ordinary draft and publication. The unit's id is
 * `tree:<repository>` and its scope is the repository, so a later commit is the
 * same unit at another input and its publication replaces what the earlier
 * commit wrote there. The folder is removed whatever happened.
 *
 * **The plan reads its own coverage, and waits for the file pass.** A unit stands
 * for a repository this stage has not read at the pinned commit: the coverage
 * node of the last run names the commit, and a run that finds the same commit
 * names no unit. And a unit stands only once every source file of the pinned
 * tree stands in the file pass's own coverage at the commit's blob, because the
 * join has nothing to stand on before that; the run plans the stage again when
 * the file pass published (decision 0027's re-planning). The orchestrator's own
 * input for the unit is the repository's commit, so a commit that moved plans
 * the unit again even where the plan is not asked.
 *
 * **What it writes.** Calls (a constructor call among them, as the reference
 * states it), references, implementations and inheritances, each with the
 * library's `resolvedBy` and confidence and with `provenance` naming the pass;
 * the symbols of a file no per-file pass of ours can read, and no other node;
 * and one coverage node per commit, naming what was read, what was left out and
 * what the run cost in wall clock and memory. The mapping and the join are in
 * `codegraph-map.ts`; the tree and the library run are in `codegraph-index.ts`.
 */
import { Type } from 'typebox';
import { factId, type CoverageGap, type FactProvenance, type FactSource, type SnapshotValue } from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { evidenceAtPlace } from './draft.js';
import {
  CODEGRAPH_EDGE_FACT_KINDS, CODEGRAPH_LIBRARY_VERSION, codegraphJoin, codegraphProduces, edgeWriteOf, gapsOf,
  type JoinInput, type LibraryIndex, type PublishedSymbol,
} from './codegraph-map.js';
import { indexRepository, scratchFolder } from './codegraph-index.js';
import { checkStaticGraphDraft } from './static-graph.js';
import { publishedCoverageRead, publishedCoverageRows } from './syntax.js';
import { syntaxLanguageOf } from './syntax-extract.js';

/** The stage's id, as it is registered and as its units are named. */
const CODEGRAPH_STAGE_ID = 'codegraph';

/** The stage's own version, bumped when what it writes or plans changes. */
const CODEGRAPH_STAGE_VERSION = 2;

/** The fact kinds the stage produces, in code point order: the links, its coverage and the symbols of a file no per-file pass reads. */
const CODEGRAPH_STAGE_KINDS: readonly string[] = [...CODEGRAPH_EDGE_FACT_KINDS, 'coverage', 'symbol'];

/** The reader every record of this stage cites. */
const CODEGRAPH_SOURCE: FactSource = { system: 'codegraph', version: CODEGRAPH_LIBRARY_VERSION };

/** The read the plan makes of this stage's own coverage: which commit it read, per repository. */
export const CODEGRAPH_PUBLISHED_READ = 'codegraph-published-coverage';

/** The read of one repository's coverage, as a plan records it. */
function codegraphPublishedRead(repository: string): string {
  return JSON.stringify({ read: CODEGRAPH_PUBLISHED_READ, repository });
}

/** One row of that read: the commit the last run of this stage read the repository at. */
export interface CodegraphPublishedRow {
  readonly kind: 'coverage';
  readonly commit: string;
}

/** The read's rows, read: each names the commit it covered, and nothing else is a row of this read. */
export function codegraphPublishedRows(rows: readonly unknown[], repository: string, read: string): readonly CodegraphPublishedRow[] {
  return rows.map((row, index) => {
    const at = `the read ${read} answered row ${String(index + 1)} for the repository ${JSON.stringify(repository)}, and`;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${at} ${JSON.stringify(row)} is no row: a row is an object naming its kind and the commit it covered (${import.meta.dir}/codegraph.ts)`);
    const held = row as Record<string, unknown>;
    if (held['kind'] !== 'coverage') throw new Error(`${at} its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" rows (${import.meta.dir}/codegraph.ts)`);
    if (typeof held['commit'] !== 'string' || !/^[0-9a-f]{40}$/.test(held['commit'])) {
      throw new Error(`${at} its commit ${JSON.stringify(held['commit'])} is no commit: 40 lower-case hexadecimal digits (${import.meta.dir}/codegraph.ts)`);
    }
    return { kind: 'coverage', commit: held['commit'] };
  });
}

/** The unit id of one repository's tree: what the unit is, and nothing of a run. */
export function treeUnitId(repository: string): string {
  return `tree:${repository}`;
}

/** What one unit's measurement says: the tree it read, what the library made of it, and what it cost. */
interface CodegraphMeasurement {
  readonly wallMs: number;
  readonly processPeakRssBytes: number;
  readonly moduleRoots: readonly string[];
  readonly runs: readonly {
    readonly root: string;
    readonly module?: string;
    readonly nodes: number;
    readonly edges: number;
    readonly indexed: number;
    readonly wallMs: number;
    readonly processPeakRssBytes: number;
    readonly libraryDurationMs?: number;
  }[];
  readonly linkedEdges: number;
  readonly symbolsJoined: number;
  readonly symbolsUnresolved: number;
}

/** The stage, registered over the run's pinned repositories. */
export function createCodegraphStage(sources: SnapshotSource): FillStage {
  return {
    id: CODEGRAPH_STAGE_ID,
    version: CODEGRAPH_STAGE_VERSION,
    staticReading: true,
    // The published symbols are the join's other half: the stage stands after
    // the pass that writes them, and after the inventory and the file pass that
    // state the records it reads. Nothing else is needed — the tree comes from
    // the pin and no fact of another stage is corrected here.
    consumes: {
      required: [
        { capability: 'file', scope: 'repository', freshness: 'current' },
        { capability: 'symbol', scope: 'repository', freshness: 'current' },
      ],
      optional: [],
    },
    produces: codegraphProduces(),
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planTrees(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeTreeUnit(sources, unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(CODEGRAPH_STAGE_ID, CODEGRAPH_STAGE_KINDS, draft),
  };
}

/**
 * The units one run fills: a unit per pinned repository this stage has not read
 * at the pinned commit, once the per-file pass has read that tree's source files
 * at the bytes the commit holds.
 *
 * **Why the plan waits for the file pass.** The join stands on the symbols the
 * per-file pass publishes, so a unit that ran before them would write no edge and
 * report every declaration unresolved. The file pass's own coverage names the
 * file it read and the blob its bytes stood under, so the plan waits until every
 * source file of the pinned tree stands in that coverage at the commit's own
 * blob. A stage whose plan answers no unit is planned again once a producer of
 * its inputs published (decision 0027's re-planning), which is how this one gets
 * its turn after the file pass's units.
 *
 * A repository whose tree holds no source file a per-file pass can read plans at
 * once: there is nothing to join to.
 */
async function planTrees(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const read = codegraphPublishedRead(pin.id);
    const covered = codegraphPublishedRows(await graph.query(read), pin.id, read);
    if (covered.some((row) => row.commit === reader.commit)) continue;
    const sourceFiles = reader.files()
      .map((entry) => String(entry.path))
      .filter((path) => syntaxLanguageOf(path) !== undefined);
    if (sourceFiles.length > 0) {
      const coverageRead = publishedCoverageRead(pin.id);
      const filePass = publishedCoverageRows(await graph.query(coverageRead), pin.id, coverageRead);
      const readAt = new Map(filePass.map((row) => [row.file, row.blob]));
      const unread = sourceFiles.filter((path) => readAt.get(path) !== reader.entry(path)?.id);
      if (unread.length > 0) {
        // The file pass has not read these files at this commit's bytes yet: this
        // stage's plan answers nothing, and the run asks it again after the pass
        // published (src/fill/stages/codegraph.ts).
        continue;
      }
    }
    units.push({ id: treeUnitId(pin.id), scope: pin.id });
  }
  return { units };
}

/** The provenance of one unit's records: the library and the commit its reading stands on. */
function provenanceOf(repository: string, commit: string): FactProvenance {
  return { source: CODEGRAPH_SOURCE, repository: { id: repository, commit } };
}

/** One unit: the tree read, joined, and written. */
async function executeTreeUnit(sources: SnapshotSource, unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  const repository = unit.scope;
  const held = context.static;
  if (held === undefined || held.repository === undefined) {
    throw new Error(`the unit ${JSON.stringify(unit.id)} runs the code pass, and its context holds no pinned repository: a run hands a static stage its repository's answers (${import.meta.dir}/codegraph.ts)`);
  }
  const reader = await sources.open(repository);
  if (reader.commit !== held.repository.commit) {
    throw new Error(`the code pass of ${JSON.stringify(repository)} was planned at the commit ${held.repository.commit} and reads ${reader.commit}: one unit reads one commit, and a moved pin is another plan (${import.meta.dir}/codegraph.ts)`);
  }
  const published = await publishedSymbols(context, repository);
  context.progress(`read ${String(published.length)} published ${published.length === 1 ? 'symbol' : 'symbols'} of ${repository} at ${reader.commit}`, 0.1);
  const scratch = scratchFolder();
  let index: LibraryIndex;
  try {
    index = await indexRepository(reader, scratch, { signal: context.signal });
  } finally {
    scratch.close();
  }
  const input: JoinInput = {
    repository,
    commit: reader.commit,
    index,
    published,
    readByFill: (path: string) => syntaxLanguageOf(path) !== undefined,
  };
  const joined = codegraphJoin(input);
  const gaps = gapsOf(index, joined);
  const provenance = provenanceOf(repository, reader.commit);
  const measurement: CodegraphMeasurement = {
    wallMs: index.wallMs,
    processPeakRssBytes: index.processPeakRssBytes,
    moduleRoots: index.moduleRoots,
    runs: index.runs.map((run) => ({
      root: run.root, ...(run.module === undefined ? {} : { module: run.module }), nodes: run.nodes.length, edges: run.edges.length,
      indexed: run.indexed.length, wallMs: run.wallMs, processPeakRssBytes: run.processPeakRssBytes,
      ...(run.libraryDurationMs === undefined ? {} : { libraryDurationMs: run.libraryDurationMs }),
    })),
    linkedEdges: joined.edges.length,
    symbolsJoined: joined.symbolsJoined,
    symbolsUnresolved: joined.symbolsUnresolved,
  };
  const evidence = `${repository} at ${reader.commit}: the library's reading of the tree`;
  for (const node of joined.nodes) {
    context.draft.write({ kind: 'node', evidence: evidenceAtPlace({ repository, commit: reader.commit }, node.file), value: node });
  }
  for (const edge of joined.edges) {
    context.draft.write(edgeWriteOf(edge, repository, reader.commit, evidence));
  }
  context.draft.write(coverageWrite({ repository, commit: reader.commit, provenance, evidence, gaps, measurement }));
  context.progress(
    `read ${repository} at ${reader.commit}: ${String(joined.edges.length)} ${joined.edges.length === 1 ? 'link' : 'links'} joined to ${String(joined.symbolsJoined)} declarations, ${String(joined.symbolsUnresolved)} unresolved, ${String(gaps.length)} ${gaps.length === 1 ? 'gap' : 'gaps'}, ${String(index.runs.length)} ${index.runs.length === 1 ? 'index' : 'indexes'} in ${String(index.wallMs)} ms`,
    1,
  );
  return { outcome: 'draft' };
}

/** Every symbol the per-file passes published for one repository, read page by page. */
async function publishedSymbols(context: StageContext, repository: string): Promise<readonly PublishedSymbol[]> {
  const graph = context.static!;
  const symbols: PublishedSymbol[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await graph.byProperty('code.symbol', 'repository', repository, { limit: 256, ...(after === undefined ? {} : { after }) });
    for (const node of page.rows) {
      const properties = node.properties as Record<string, unknown>;
      const provenance = properties['provenance'];
      const place = provenance !== null && typeof provenance === 'object' ? (provenance as Record<string, unknown>)['place'] : undefined;
      const range = place !== null && typeof place === 'object' ? (place as Record<string, unknown>)['range'] : undefined;
      const file = place !== null && typeof place === 'object' ? (place as Record<string, unknown>)['file'] : undefined;
      const key = properties['recordKey'];
      const qualifiedName = properties['qualifiedName'];
      if (typeof key !== 'string' || typeof file !== 'string' || typeof qualifiedName !== 'string' || range === null || typeof range !== 'object') {
        throw new Error(`the graph answered the symbol node ${node.id} of ${JSON.stringify(repository)} without the key, the file, the name or the span a symbol carries: the code pass joins the library's declarations to exactly those records (${import.meta.dir}/codegraph.ts)`);
      }
      const startLine = Number((range as Record<string, unknown>)['startLine']);
      const endLine = Number((range as Record<string, unknown>)['endLine']);
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
        throw new Error(`the graph answered the symbol node ${node.id} of ${JSON.stringify(repository)} with the span ${JSON.stringify(range)}, which is no line range: the code pass joins by the place the per-file pass read (${import.meta.dir}/codegraph.ts)`);
      }
      symbols.push({ key, file, qualifiedName, startLine, endLine });
    }
    if (page.next === null) break;
    after = page.next;
  }
  return symbols;
}

/** The unit's coverage node: the commit, what was read, what was left out, and what the run cost. */
function coverageWrite(input: {
  readonly repository: string;
  readonly commit: string;
  readonly provenance: FactProvenance;
  readonly evidence: string;
  readonly gaps: readonly CoverageGap[];
  readonly measurement: CodegraphMeasurement;
}): StageDraftWrite {
  // The scope is the snapshot the unit stood on, as the modules stage's own
  // coverage names it: a second run at a later commit is a second coverage of a
  // later tree, never the first run's row standing for ever.
  const scope = factId({
    kind: 'snapshot',
    value: { repository: input.repository, commit: input.commit } as SnapshotValue,
    provenance: input.provenance,
  });
  const value = {
    repository: input.repository,
    scope,
    complete: input.gaps.length === 0,
    read: ['calls', 'implements', 'inherits', 'instantiates', 'references'],
    unread: [...input.gaps],
  };
  const key = factId({ kind: 'coverage', value, provenance: input.provenance });
  return {
    kind: 'node',
    evidence: input.evidence,
    value: {
      key,
      kind: 'code.coverage',
      label: `${input.repository} at ${input.commit}`,
      properties: {
        ...value,
        commit: input.commit,
        recordKey: key,
        factKind: 'coverage',
        layer: 'extracted',
        status: 'proposed',
        provenance: { ...input.provenance, pass: 'codegraph' },
        measurement: input.measurement,
      },
    },
  };
}
