/**
 * Stage 4, the resolution of a file's names (decision 0026's stage 4; decision
 * 0033's "The file is the unit of static work"), through its own `plan` and
 * `execute`: the orchestrator is not needed and not used.
 *
 * Every expectation comes from the task and the decisions, never from the
 * module. The fixture is a repository the test makes in a temporary folder and
 * removes: `a.ts` calls an exported function of `b.ts`, extends a class of it
 * and mentions a plain name of it. The file pass (stages 0 to 3) runs first on
 * the test's own repository, and the graph the resolution reads is the one those
 * three published — its nodes and edges, keyed as the drafts key them — so a
 * unit's bounded reads answer exactly what the run would have answered.
 *
 * What is asserted: a resolved call, inheritance and reference edge with the
 * symbol at each end; one positioned occurrence per resolved mention; a coverage
 * that names what could not be tied down with its own place; that a name the
 * file declares itself is resolved without asking the graph; that a file's
 * mentions are read page by page when it writes more than one page; and the
 * plan's incrementality — a second run of one commit plans no unit, a changed
 * target re-plans its importers, and a vanished path is retracted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveStageGraph } from '../src/fill/registry.js';
import { createGitSnapshotSource, type SnapshotSource } from '../src/fill/snapshot.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import { staticStageContext, type StaticGraphNode, type StaticGraphReader } from '../src/fill/stages/static-context.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import { createSnapshotStage, publishedRepositoryRead } from '../src/fill/stages/snapshot.js';
import { createInventoryStage, publishedContainmentRead } from '../src/fill/stages/inventory.js';
import { createSyntaxStage } from '../src/fill/stages/syntax.js';
import { publishedTreeRead } from '../src/fill/stages/tree-rows.js';
import { publishedGapsRead, publishedImportsRead } from '../src/fill/stages/syntax-specifiers.js';
import {
  createSemanticResolutionStage, publishedResolvedRead, publishedResolvedRows, SEMANTIC_RESOLUTION_STAGE_ID,
} from '../src/fill/stages/semantic-resolution.js';
import { gapRowsOf, importRowsOf, itemsOf, nodesOfKind, treeRowsOf } from './fill-static-drafts.js';

const REPOSITORY = 'orders-api';

/** A throwaway repository the test commits into by hand. */
interface Fixture {
  readonly root: string;
  commit(): string;
  git(...args: string[]): string;
  write(path: string, text: string): Promise<void>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-resolution-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = async (path: string, text: string): Promise<void> => {
    const at = join(root, path);
    await mkdir(join(at, '..'), { recursive: true });
    await writeFile(at, text);
  };
  return {
    root,
    git,
    write,
    commit(): string {
      git('add', '-A');
      git('commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD').trim();
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** The source one pinned repository's stages read: the test's own commit of its own folder. */
function sourceAt(root: string, commit: string): SnapshotSource {
  return createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root, commit }]);
}

/** The repository a unit's scope names: `<repository>` or `<repository>:<path>`. */
function repositoryOfScope(scope: string): string {
  const parts = scope.split(':');
  if (parts[0] === 'file' || parts[0] === 'directory') return parts[1] ?? '';
  return parts.length === 1 ? scope : parts[0]!;
}

/** What a stage wrote, and the reads it made. */
interface Recorder {
  readonly writes: StageDraftWrite[];
  readonly notes: string[];
  readonly queries: string[];
}

/** The graph one run's nodes and edges: what the file pass published, as a graph store would hold it. */
interface Graph {
  readonly nodes: readonly StaticGraphNode[];
  readonly edges: readonly { readonly relation: string; readonly from: string; readonly to: string; readonly position?: { readonly start: number; readonly end: number }; readonly properties?: Record<string, unknown> }[];
}

/**
 * The graph the file pass's drafts publish: each node key becomes a node id (the
 * order of the writes, `n1`, `n2`, …), each edge's keys become the ids of the
 * nodes they name, and a node's properties are the draft's own. A key the draft
 * does not define is refused rather than dropped, as the store refuses it.
 */
function graphOf(writes: readonly StageDraftWrite[]): Graph {
  const ids = new Map<string, string>();
  const nodes: StaticGraphNode[] = [];
  for (const write of writes) {
    if (write.kind !== 'node') continue;
    const id = `n${String(nodes.length + 1)}`;
    ids.set(write.value.key, id);
    nodes.push({ id, kind: write.value.kind, label: write.value.label, properties: write.value.properties, producer: 'fill.syntax', scope: '0' });
  }
  const edges: { relation: string; from: string; to: string; position?: { start: number; end: number }; properties?: Record<string, unknown> }[] = [];
  for (const write of writes) {
    if (write.kind !== 'edge') continue;
    const from = 'key' in write.value.from ? ids.get(write.value.from.key) : undefined;
    const to = 'key' in write.value.to ? ids.get(write.value.to.key) : undefined;
    if (from === undefined || to === undefined) {
      throw new Error(`the draft's ${write.value.relation} edge names a node no write of the same draft defines: ${JSON.stringify(write.value)}`);
    }
    edges.push({ relation: write.value.relation, from, to, ...(write.value.position === undefined ? {} : { position: write.value.position }), ...(write.value.properties === undefined ? {} : { properties: write.value.properties }) });
  }
  return { nodes, edges };
}

/** The number of a node id, so a page's order and cursor are the store's own (ids ascend). */
function numberOf(id: string): number {
  return Number(id.slice(1));
}

/**
 * The graph reader a unit is handed over one {@link Graph}: by key, by global
 * name and one neighbourhood per page, as the store answers them. The
 * neighbourhood follows the relations recursively and pages in node id order,
 * which is `readTraversal`'s own rule.
 */
function readerOf(graph: Graph): StaticGraphReader & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async byKey(key: string): Promise<readonly StaticGraphNode[]> {
      asked.push(`key:${key}`);
      return graph.nodes.filter((node) => node.properties['recordKey'] === key);
    },
    async byGlobalName(name: string): Promise<readonly StaticGraphNode[]> {
      asked.push(`global:${name}`);
      return graph.nodes.filter((node) => node.kind === 'code.symbol' && node.properties['globalName'] === name);
    },
    async byProperty(kind: string, field: string, value: string): Promise<{ readonly rows: readonly StaticGraphNode[]; readonly next: string | null }> {
      asked.push(`property:${kind}:${field}:${value}`);
      return { rows: graph.nodes.filter((node) => node.kind === kind && node.properties[field] === value), next: null };
    },
    async edgesByProperty(): Promise<{ readonly rows: readonly never[]; readonly next: string | null }> {
      asked.push('edges');
      return { rows: [], next: null };
    },
    async neighbourhood(nodeId: string, options: { readonly relations: readonly string[]; readonly direction: 'out' | 'in'; readonly limit?: number; readonly after?: string }) {
      asked.push(`near:${nodeId}:${options.relations.join(',')}:${options.direction}:${options.after ?? 'first'}`);
      const found = new Set<string>();
      const walk = (at: string): void => {
        for (const edge of graph.edges) {
          if (!options.relations.includes(edge.relation)) continue;
          const [from, to] = options.direction === 'out' ? [edge.from, edge.to] : [edge.to, edge.from];
          if (from !== at || found.has(to)) continue;
          found.add(to);
          walk(to);
        }
      };
      walk(nodeId);
      const limit = options.limit ?? 256;
      const after = options.after === undefined ? 0 : numberOf(options.after);
      const rows = [...found].map(numberOf).filter((id) => id > after).sort((left, right) => left - right);
      const page = rows.slice(0, limit).map((id) => graph.nodes.find((node) => numberOf(node.id) === id)!);
      const more = rows.length > limit;
      return { rows: page, next: more ? page[page.length - 1]!.id : null };
    },
  } as StaticGraphReader & { readonly asked: string[] };
}

/** One unit's context: the draft collected here, the reads answered by the test's graph, and a signal the test holds. */
async function contextFor(unit: StageUnit, options: { readonly source?: SnapshotSource; readonly reader?: StaticGraphReader; readonly answer?: (read: string) => readonly unknown[] } = {}): Promise<{ context: StageContext; recorder: Recorder; controller: AbortController }> {
  const recorder: Recorder = { writes: [], notes: [], queries: [] };
  const controller = new AbortController();
  const graph = {
    query: async (read: string) => {
      recorder.queries.push(read);
      return options.answer?.(read) ?? [];
    },
  };
  const repository = options.source === undefined ? undefined : await (async () => {
    const { staticStageSourceOf } = await import('../src/fill/stages/static-context.js');
    return staticStageSourceOf(options.source!, repositoryOfScope(unit.scope));
  })();
  return {
    recorder,
    controller,
    context: {
      unit,
      config: { id: SEMANTIC_RESOLUTION_STAGE_ID, version: 2, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
      graph,
      ...(repository === undefined ? {} : { static: staticStageContext(repository, options.reader ?? readerOf({ nodes: [], edges: [] })) }),
      draft: {
        write: (entry: StageDraftWrite) => { recorder.writes.push(entry); },
        writes: () => ({ writes: recorder.writes }),
      },
      progress: (note: string) => { recorder.notes.push(note); },
      signal: controller.signal,
    },
  };
}

/** What the file pass published for one commit: its drafts, the tree its plans read, and the graph a unit reads. */
interface Published {
  readonly tree: StageDraftWrite[];
  readonly syntax: StageDraftWrite[];
  readonly graph: Graph;
}

/** Runs stages 0 to 3 of one pinned repository the way the orchestrator does, each unit against what the earlier ones wrote. */
async function filePass(source: SnapshotSource): Promise<Published> {
  const snapshot = createSnapshotStage(source);
  const tree: StageDraftWrite[] = [];
  for (const unit of (await snapshot.plan({ query: async () => [] })).units) {
    const run = await contextFor(unit, { source });
    await snapshot.execute(unit, run.context);
    tree.push(...run.recorder.writes);
  }
  const inventory = createInventoryStage(source);
  for (const unit of (await inventory.plan({
    query: async (read: string) => {
      if (read === publishedTreeRead(REPOSITORY)) return treeRowsOf(tree, REPOSITORY);
      if (read === publishedRepositoryRead(REPOSITORY)) return [{ kind: 'repository', repository: REPOSITORY }];
      if (read === publishedContainmentRead(REPOSITORY)) return [];
      return [];
    },
  })).units) {
    const run = await contextFor(unit, { source });
    await inventory.execute(unit, run.context);
    tree.push(...run.recorder.writes);
  }
  const syntax = createSyntaxStage(source);
  const writes: StageDraftWrite[] = [];
  for (const unit of (await syntax.plan({
    query: async (read: string) => (read === publishedTreeRead(REPOSITORY) ? treeRowsOf(tree, REPOSITORY) : []),
  })).units) {
    const run = await contextFor(unit, { source });
    await syntax.execute(unit, run.context);
    writes.push(...run.recorder.writes);
  }
  return { tree, syntax: writes, graph: graphOf([...tree, ...writes]) };
}

/** The units one plan named, by id, in code point order. */
function unitIds(plan: { units: readonly { id: string }[] }): string[] {
  return plan.units.map((unit) => unit.id);
}

/** The reads a plan makes, answered from the file pass's drafts and this stage's own last run. */
function planAnswers(published: Published, resolved: readonly StageDraftWrite[] = []): (read: string) => readonly unknown[] {
  return (read: string) => {
    if (read === publishedTreeRead(REPOSITORY)) return treeRowsOf([...published.tree, ...published.syntax], REPOSITORY);
    if (read === publishedImportsRead(REPOSITORY)) return importRowsOf(published.syntax);
    if (read === publishedGapsRead(REPOSITORY)) return gapRowsOf(published.syntax);
    if (read === publishedResolvedRead(REPOSITORY)) {
      return nodesOfKind(resolved, 'code.coverage')
        .filter((node) => typeof node.properties['blob'] === 'string')
        .map((node) => ({ kind: 'coverage', file: String(node.properties['scope']), blob: String(node.properties['blob']), read: (node.properties['read'] as readonly string[] | undefined) ?? [] }));
    }
    throw new Error(`the plan asked the read ${read}, and this test answers no such read`);
  };
}

/** The stage, one unit and what it wrote. */
async function runUnit(unit: { id: string; scope: string }, published: Published, source: SnapshotSource): Promise<{ readonly writes: readonly StageDraftWrite[]; readonly notes: readonly string[]; readonly asked: readonly string[] }> {
  const stage = createSemanticResolutionStage(source);
  const reader = readerOf(published.graph);
  const run = await contextFor(unit, { source, reader });
  await stage.execute(unit, run.context);
  return { writes: run.recorder.writes, notes: run.recorder.notes, asked: reader.asked };
}

/** The file unit of one path. */
function fileUnit(path: string): { id: string; scope: string } {
  return { id: `file:${REPOSITORY}:${path}`, scope: `${REPOSITORY}:${path}` };
}

/** What a call refused with, so a test can read what it names; `answered` when it did not refuse. */
async function refusedBy(call: () => unknown): Promise<string> {
  try {
    await call();
    return 'answered';
  } catch (error) {
    return (error as Error).message;
  }
}

/** The key a node of one kind and path carries in the drafts. */
function keyOf(writes: readonly StageDraftWrite[], kind: string, path: string): string {
  const held = nodesOfKind(writes, kind).filter((node) => node.properties['path'] === path || node.properties['file'] === path);
  if (held.length !== 1) throw new Error(`the drafts hold ${String(held.length)} ${kind} nodes for ${path}, and this test needs exactly one`);
  return held[0]!.key;
}

/** The key of one symbol of one file, by its qualified name. */
function symbolKeyOf(writes: readonly StageDraftWrite[], path: string, qualifiedName: string): string {
  const held = nodesOfKind(writes, 'code.symbol').filter((node) => node.properties['file'] === path && node.properties['qualifiedName'] === qualifiedName);
  if (held.length !== 1) throw new Error(`the drafts hold ${String(held.length)} symbols named ${qualifiedName} of ${path}, and this test needs exactly one`);
  return held[0]!.key;
}

/** The edges of one relation a unit wrote, as `[from key, to key]` and their properties. */
function edgesOf(writes: readonly StageDraftWrite[], relation: string): readonly { readonly from: string; readonly to: string; readonly properties: Record<string, unknown>; readonly position?: { readonly start: number; readonly end: number } }[] {
  return writes
    .filter((write) => write.kind === 'edge' && write.value.relation === relation)
    .map((write) => write as Extract<StageDraftWrite, { kind: 'edge' }>)
    .map((write) => ({
      from: 'key' in write.value.from ? write.value.from.key : '',
      to: 'key' in write.value.to ? write.value.to.key : '',
      properties: (write.value.properties ?? {}) as Record<string, unknown>,
      ...(write.value.position === undefined ? {} : { position: write.value.position }),
    }));
}

/** The one coverage node a unit wrote, refused where it wrote another number of them. */
function coverageOf(writes: readonly StageDraftWrite[]): { readonly scope: string; readonly complete: boolean; readonly read: readonly string[]; readonly unread: readonly { readonly what: string }[]; readonly blob: string } {
  const held = nodesOfKind(writes, 'code.coverage');
  if (held.length !== 1) throw new Error(`the unit wrote ${String(held.length)} coverage nodes, and this test expects one`);
  const properties = held[0]!.properties;
  return {
    scope: String(properties['scope']),
    complete: properties['complete'] === true,
    read: (properties['read'] as readonly string[]) ?? [],
    unread: (properties['unread'] as readonly { what: string }[]) ?? [],
    blob: String(properties['blob']),
  };
}

/** The two files the fixture commits: `a.ts` calls, extends and mentions names of `b.ts`. */
const A_TS = [
  "import { create, Thing } from './b.js';",
  'export class Service extends Thing {',
  '  run(): number {',
  '    return create(1);',
  '  }',
  '}',
  'export const made = create(2);',
  'export function local(): number { return 7; }',
  'export const called = local();',
  '',
].join('\n');
const B_TS = [
  'export class Thing {}',
  'export function create(n: number): number { return n; }',
  '',
].join('\n');

describe('the resolution stage of the registry', () => {
  test('it is the static stage the graph runs after the syntax stage, on that stage\'s mentions and symbols', () => {
    const stage = createSemanticResolutionStage(createGitSnapshotSource(() => []));
    expect(stage.id).toBe(SEMANTIC_RESOLUTION_STAGE_ID);
    expect(stage.staticReading).toBe(true);
    expect(stage.consumes.required.map((consume) => consume.capability).sort()).toEqual(['file', 'import', 'mention', 'symbol']);
    expect(createStageRegistry({ snapshots: createGitSnapshotSource(() => []) }).get(SEMANTIC_RESOLUTION_STAGE_ID)).toBeDefined();
    const read = deriveStageGraph(createStageRegistry({ snapshots: createGitSnapshotSource(() => []) }), undefined);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The graph orders the resolution after the stage that writes its mentions and its symbols.
    const into = read.graph.edges.filter((edge) => edge.to === SEMANTIC_RESOLUTION_STAGE_ID).map((edge) => [edge.from, edge.via]).sort();
    expect(into).toEqual([
      ['snapshot', 'file'],
      ['syntax', 'import'],
      ['syntax', 'mention'],
      ['syntax', 'symbol'],
    ].sort());
    expect(read.graph.order.indexOf('syntax')).toBeLessThan(read.graph.order.indexOf(SEMANTIC_RESOLUTION_STAGE_ID));
  });
});

describe('the plan', () => {
  let f: Fixture;
  let commit = '';
  let published: Published;

  beforeAll(async () => {
    f = await fixture();
    await f.write('src/a.ts', A_TS);
    await f.write('src/b.ts', B_TS);
    await f.write('README.md', '# orders\n');
    commit = f.commit();
    published = await filePass(sourceAt(f.root, commit));
  }, 120_000);

  afterAll(async () => {
    await f.dispose();
  });

  test('a first run plans every source file, in code point order, and no document', async () => {
    const stage = createSemanticResolutionStage(sourceAt(f.root, commit));
    const plan = await stage.plan({ query: async (read: string) => planAnswers(published)(read) });
    expect(plan.coverage).toBe('planned');
    expect(unitIds(plan)).toEqual([`file:${REPOSITORY}:src/a.ts`, `file:${REPOSITORY}:src/b.ts`]);
  }, 60_000);

  test('a second run of one commit plans no unit', async () => {
    const stage = createSemanticResolutionStage(sourceAt(f.root, commit));
    // What this stage resolved: both files, at the pinned blob, each reading itself and — for `a.ts` — `b.ts`.
    const resolved: StageDraftWrite[] = [
      { kind: 'node', evidence: 'fixture', value: { key: 'resolved:a', kind: 'code.coverage', label: 'a', properties: { factKind: 'coverage', scope: 'src/a.ts', blob: published.graph.nodes.find((node) => node.properties['path'] === 'src/a.ts')!.properties['blob'], read: ['src/a.ts', 'src/b.ts'] } } },
      { kind: 'node', evidence: 'fixture', value: { key: 'resolved:b', kind: 'code.coverage', label: 'b', properties: { factKind: 'coverage', scope: 'src/b.ts', blob: published.graph.nodes.find((node) => node.properties['path'] === 'src/b.ts')!.properties['blob'], read: ['src/b.ts'] } } },
    ];
    const plan = await stage.plan({ query: async (read: string) => planAnswers(published, resolved)(read) });
    expect(unitIds(plan)).toEqual([]);
  }, 60_000);

  test('an imported file whose blob moved re-plans the file that imports it, and no other', async () => {
    await f.write('src/b.ts', `${B_TS}// a comment moves the bytes and no symbol\n`);
    const moved = f.commit();
    const at = await filePass(sourceAt(f.root, moved));
    const stage = createSemanticResolutionStage(sourceAt(f.root, moved));
    const resolved: StageDraftWrite[] = [
      { kind: 'node', evidence: 'fixture', value: { key: 'resolved:a', kind: 'code.coverage', label: 'a', properties: { factKind: 'coverage', scope: 'src/a.ts', blob: published.graph.nodes.find((node) => node.properties['path'] === 'src/a.ts')!.properties['blob'], read: ['src/a.ts', 'src/b.ts'] } } },
      { kind: 'node', evidence: 'fixture', value: { key: 'resolved:b', kind: 'code.coverage', label: 'b', properties: { factKind: 'coverage', scope: 'src/b.ts', blob: published.graph.nodes.find((node) => node.properties['path'] === 'src/b.ts')!.properties['blob'], read: ['src/b.ts'] } } },
    ];
    const plan = await stage.plan({ query: async (read: string) => planAnswers(at, resolved)(read) });
    expect(unitIds(plan)).toEqual([`file:${REPOSITORY}:src/a.ts`, `file:${REPOSITORY}:src/b.ts`]);
  }, 120_000);

  test('a source file the pinned commit no longer holds is planned, and its unit publishes nothing', async () => {
    await f.git('rm', '-q', 'src/b.ts');
    const without = f.commit();
    const at = await filePass(sourceAt(f.root, without));
    const stage = createSemanticResolutionStage(sourceAt(f.root, without));
    const resolved: StageDraftWrite[] = [
      { kind: 'node', evidence: 'fixture', value: { key: 'resolved:a', kind: 'code.coverage', label: 'a', properties: { factKind: 'coverage', scope: 'src/a.ts', blob: published.graph.nodes.find((node) => node.properties['path'] === 'src/a.ts')!.properties['blob'], read: ['src/a.ts', 'src/b.ts'] } } },
      { kind: 'node', evidence: 'fixture', value: { key: 'resolved:b', kind: 'code.coverage', label: 'b', properties: { factKind: 'coverage', scope: 'src/b.ts', blob: published.graph.nodes.find((node) => node.properties['path'] === 'src/b.ts')!.properties['blob'], read: ['src/b.ts'] } } },
    ];
    const plan = await stage.plan({ query: async (read: string) => planAnswers(at, resolved)(read) });
    expect(unitIds(plan)).toEqual([`file:${REPOSITORY}:src/a.ts`, `file:${REPOSITORY}:src/b.ts`]);
    // The vanished path has no node, and a unit that reads no file node writes nothing.
    const gone = await runUnit(fileUnit('src/b.ts'), at, sourceAt(f.root, without));
    expect(gone.writes).toEqual([]);
    expect(gone.notes[0]).toContain('stands at no node of the graph');
  }, 120_000);
});

/** One repository the test writes, commits, runs the file pass over, and resolves one file of. */
async function runOn(files: Readonly<Record<string, string>>, path = 'src/a.ts'): Promise<{ readonly published: Published; readonly writes: readonly StageDraftWrite[]; readonly asked: readonly string[]; readonly notes: readonly string[]; readonly commit: string; readonly f: Fixture }> {
  const f = await fixture();
  for (const [at, text] of Object.entries(files)) await f.write(at, text);
  const commit = f.commit();
  const source = sourceAt(f.root, commit);
  const published = await filePass(source);
  const run = await runUnit(fileUnit(path), published, source);
  return { published, writes: run.writes, asked: run.asked, notes: run.notes, commit, f };
}

describe('one unit resolves the names its file writes', () => {
  test('a call, an inheritance and a call of the file\'s own function: one edge each, from the caller to the symbol it names', async () => {
    const run = await runOn({ 'src/a.ts': A_TS, 'src/b.ts': B_TS, 'README.md': '# orders\n' });
    try {
      const create = symbolKeyOf(run.published.syntax, 'src/b.ts', 'create');
      const thing = symbolKeyOf(run.published.syntax, 'src/b.ts', 'Thing');
      const calls = edgesOf(run.writes, 'code.calls');
      expect(calls.map((edge) => [edge.from, edge.to, edge.properties['count']]).sort()).toEqual([
        [symbolKeyOf(run.published.syntax, 'src/a.ts', 'Service.run'), create, 1],
        [symbolKeyOf(run.published.syntax, 'src/a.ts', 'made'), create, 1],
        [symbolKeyOf(run.published.syntax, 'src/a.ts', 'called'), symbolKeyOf(run.published.syntax, 'src/a.ts', 'local'), 1],
      ].sort());
      expect(calls.every((edge) => edge.properties['factKind'] === 'call' && edge.properties['precision'] === 'syntactic')).toBe(true);
      expect(edgesOf(run.writes, 'code.inherits').map((edge) => [edge.from, edge.to])).toEqual([
        [symbolKeyOf(run.published.syntax, 'src/a.ts', 'Service'), thing],
      ]);
      // Every resolved mention is one positioned occurrence from the file to the symbol it names.
      const occurrences = edgesOf(run.writes, 'code.occurrence');
      expect(occurrences).toHaveLength(4);
      expect(occurrences.every((edge) => edge.from === keyOf([...run.published.tree, ...run.published.syntax], 'code.file', 'src/a.ts'))).toBe(true);
      expect(occurrences.every((edge) => edge.position !== undefined && edge.position.end > edge.position.start)).toBe(true);
      const coverage = coverageOf(run.writes);
      expect(coverage.scope).toBe('src/a.ts');
      expect(coverage.read).toEqual(['src/a.ts', 'src/b.ts']);
      expect(coverage.complete).toBe(true);
      expect(coverage.unread).toEqual([]);
      // The reads it made: its file by key, its mentions and symbols by one neighbourhood each, and one
      // global name per name it takes from b.ts — and none for `local`, which a.ts declares itself.
      expect(run.asked.filter((asked) => asked.startsWith('global:')).sort()).toEqual([
        `global:${REPOSITORY}:src/b.ts#Thing`,
        `global:${REPOSITORY}:src/b.ts#create`,
      ]);
      expect(run.asked.filter((asked) => asked.startsWith('key:'))).toEqual([`key:${keyOf([...run.published.tree, ...run.published.syntax], 'code.file', 'src/a.ts')}`]);
    } finally {
      await run.f.dispose();
    }
  }, 180_000);

  test('two runs of one commit write the same edges and the same coverage', async () => {
    const run = await runOn({ 'src/a.ts': A_TS, 'src/b.ts': B_TS });
    try {
      const again = await runUnit(fileUnit('src/a.ts'), run.published, sourceAt(run.f.root, run.commit));
      expect(again.writes).toEqual(run.writes);
    } finally {
      await run.f.dispose();
    }
  }, 180_000);

  test('an imported name the target file does not declare is a coverage gap with its own place', async () => {
    const run = await runOn({
      'src/a.ts': "import { missing } from './b.js';\nexport const used = missing(1);\n",
      'src/b.ts': B_TS,
    });
    try {
      expect(edgesOf(run.writes, 'code.calls')).toEqual([]);
      const coverage = coverageOf(run.writes);
      expect(coverage.complete).toBe(false);
      expect(coverage.unread.map((gap) => gap.what)).toEqual([
        'missing at src/a.ts:2:20, the import "./b.js" binds "missing" to "missing", and the file "src/b.ts" declares no symbol of that name',
      ]);
      expect(coverage.read).toEqual(['src/a.ts', 'src/b.ts']);
    } finally {
      await run.f.dispose();
    }
  }, 180_000);

  test('a name imported from a package outside the repository is out of the resolution\'s claim: no edge and no gap', async () => {
    const run = await runOn({
      'src/a.ts': "import { create } from 'lodash';\nexport const made = create(1);\n",
      'src/b.ts': B_TS,
    });
    try {
      expect(edgesOf(run.writes, 'code.calls')).toEqual([]);
      expect(coverageOf(run.writes).unread).toEqual([]);
      expect(run.asked.filter((asked) => asked.startsWith('global:'))).toEqual([]);
    } finally {
      await run.f.dispose();
    }
  }, 180_000);

  test('a name a parameter binds is no mention of a symbol, and a name nothing binds is out of the claim', async () => {
    const run = await runOn({
      'src/a.ts': 'export function take(create: number): number { return create; }\nexport const other = create(1);\n',
      'src/b.ts': B_TS,
    });
    try {
      expect(edgesOf(run.writes, 'code.calls')).toEqual([]);
      expect(coverageOf(run.writes).unread).toEqual([]);
    } finally {
      await run.f.dispose();
    }
  }, 180_000);

  test('a file with more mentions than one page is read page by page, and every mention is resolved', async () => {
    const lines = ['export function local(): number { return 1; }'];
    for (let index = 0; index < 300; index += 1) lines.push(`export const v${String(index)} = local();`);
    const run = await runOn({ 'src/a.ts': `${lines.join('\n')}\n`, 'src/b.ts': B_TS });
    try {
      const calls = edgesOf(run.writes, 'code.calls');
      expect(calls).toHaveLength(300);
      expect(calls.every((edge) => edge.properties['count'] === 1)).toBe(true);
      expect(edgesOf(run.writes, 'code.occurrence')).toHaveLength(300);
      // The reads past the first page name the cursor the page before answered.
      expect(run.asked.filter((asked) => asked.startsWith('near:') && !asked.endsWith(':first')).length).toBeGreaterThan(1);
      expect(coverageOf(run.writes).complete).toBe(true);
    } finally {
      await run.f.dispose();
    }
  }, 300_000);

  test('a cancelled unit raises rather than publishing an empty draft', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', A_TS);
      await f.write('src/b.ts', B_TS);
      const commit = f.commit();
      const source = sourceAt(f.root, commit);
      const published = await filePass(source);
      const stage = createSemanticResolutionStage(source);
      const run = await contextFor(fileUnit('src/a.ts'), { source, reader: readerOf(published.graph) });
      run.controller.abort();
      expect(await refusedBy(async () => await stage.execute(fileUnit('src/a.ts'), run.context))).toContain('cancelled before it resolved the pinned file');
    } finally {
      await f.dispose();
    }
  }, 180_000);
});

describe('a graph that does not answer what the file pass published is refused, naming the place', () => {
  test('a mention node that holds no place, and a symbol node that is no symbol', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', A_TS);
      await f.write('src/b.ts', B_TS);
      const commit = f.commit();
      const source = sourceAt(f.root, commit);
      const published = await filePass(source);
      const stage = createSemanticResolutionStage(source);
      const withoutRange = {
        nodes: published.graph.nodes.map((node) => node.kind === 'code.mention' ? { ...node, properties: { ...node.properties, range: undefined } } : node),
        edges: published.graph.edges,
      };
      const first = await contextFor(fileUnit('src/a.ts'), { source, reader: readerOf(withoutRange) });
      expect(await refusedBy(async () => await stage.execute(fileUnit('src/a.ts'), first.context))).toContain('its range is');
      // A node hung from the file by code.mentions that is no mention at all.
      const wrongKind = {
        nodes: published.graph.nodes.map((node) => node.kind === 'code.mention' ? { ...node, kind: 'code.symbol' } : node),
        edges: published.graph.edges,
      };
      const second = await contextFor(fileUnit('src/a.ts'), { source, reader: readerOf(wrongKind) });
      expect(await refusedBy(async () => await stage.execute(fileUnit('src/a.ts'), second.context))).toContain('where it was asked for the file\'s mentions');
    } finally {
      await f.dispose();
    }
  }, 180_000);
});

/** The read the plan makes of this stage's own resolutions, for the row refusals below. */
const RESOLVED_READ = publishedResolvedRead(REPOSITORY).toString();

/** The key a file node of one path carries in the drafts. */
function fileNodeKeyOf(published: Published, path: string): string {
  return keyOf([...published.tree, ...published.syntax], 'code.file', path);
}

describe('the plan refuses a row it would plan by', () => {
  const read = publishedResolvedRead(REPOSITORY);
  const row = { kind: 'coverage' as const, file: 'src/a.ts', blob: 'b'.repeat(40), read: ['src/a.ts', 'src/b.ts'] };

  test('a row names the kind, the file, the blob and the list of files it read', async () => {
    expect(publishedResolvedRows([row], REPOSITORY, read)).toEqual([row]);
    expect(await refusedBy(() => publishedResolvedRows([{ ...row, kind: 'gap' }], REPOSITORY, read))).toContain('its kind is "gap"');
    expect(await refusedBy(() => publishedResolvedRows([{ ...row, file: '../a.ts' }], REPOSITORY, read))).toContain('is no repository path');
    expect(await refusedBy(() => publishedResolvedRows([{ ...row, blob: 'not-a-blob' }], REPOSITORY, read))).toContain('is no blob id');
    expect(await refusedBy(() => publishedResolvedRows([{ ...row, read: 'src/a.ts' }], REPOSITORY, read))).toContain('is no list of paths');
    expect(await refusedBy(() => publishedResolvedRows([{ ...row, read: ['../a.ts'] }], REPOSITORY, read))).toContain('is no repository path');
    expect(await refusedBy(() => publishedResolvedRows([{ ...row, run: 'r1' }], REPOSITORY, read))).toContain('"run"');
    expect(await refusedBy(() => publishedResolvedRows([null], REPOSITORY, read))).toContain('is no row');
  });

  test('a plan whose file has no node in the published tree plans nothing, and says so', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', A_TS);
      await f.write('src/b.ts', B_TS);
      const commit = f.commit();
      const source = sourceAt(f.root, commit);
      const published = await filePass(source);
      const stage = createSemanticResolutionStage(source);
      // The tree the plan reads without a.ts's file node: the unit cannot read a mention of a file
      // the snapshot has not published, so the plan names nothing rather than a half answer.
      const answers = planAnswers(published);
      const plan = await stage.plan({
        query: async (readText: string) => {
          if (readText !== publishedTreeRead(REPOSITORY)) return answers(readText);
          return treeRowsOf([...published.tree, ...published.syntax], REPOSITORY).filter((row) => row.path !== 'src/a.ts');
        },
      });
      expect(plan.coverage).toBe('nothing-found');
      expect(unitIds(plan)).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 180_000);
});

describe('a file\'s imports and declarations decide what a mention names', () => {
  test('a default import names the target file\'s default export, and a namespace member its own name', async () => {
    const run = await runOn({
      'src/a.ts': [
        "import makeIt from './b.js';",
        "import * as things from './b.js';",
        'export const made = makeIt(1);',
        'export const named = things.create(2);',
        'export const whole = things;',
        '',
      ].join('\n'),
      'src/b.ts': 'export default function (n: number): number { return n; }\nexport function create(n: number): number { return n; }\n',
    });
    try {
      const calls = edgesOf(run.writes, 'code.calls');
      expect(calls.map((edge) => [edge.from, edge.to]).sort()).toEqual([
        // The anonymous default export is the target file's `default` symbol.
        [symbolKeyOf(run.published.syntax, 'src/a.ts', 'made'), symbolKeyOf(run.published.syntax, 'src/b.ts', 'default')],
        [symbolKeyOf(run.published.syntax, 'src/a.ts', 'named'), symbolKeyOf(run.published.syntax, 'src/b.ts', 'create')],
      ].sort());
      // `things` alone names a module, and no symbol stands for it: out of the resolution's claim.
      expect(coverageOf(run.writes).complete).toBe(true);
      expect(run.asked.filter((asked) => asked.startsWith('global:')).sort()).toEqual([
        `global:${REPOSITORY}:src/b.ts#create`,
        `global:${REPOSITORY}:src/b.ts#default`,
      ]);
    } finally {
      await run.f.dispose();
    }
  }, 180_000);

  test('a declaration of the file beats an import of the same name from the mention\'s own line on', async () => {
    const run = await runOn({
      'src/a.ts': [
        "import { create } from './b.js';",
        'export const made = create(1);',
        'export function local(create: number): number {',
        '  return create;',
        '}',
        '',
      ].join('\n'),
      'src/b.ts': 'export function create(n: number): number { return n; }\n',
    });
    try {
      const calls = edgesOf(run.writes, 'code.calls');
      expect(calls.map((edge) => edge.to)).toEqual([symbolKeyOf(run.published.syntax, 'src/b.ts', 'create')]);
      // The mention of `create` inside `local` names the parameter, not the import: one global ask.
      expect(run.asked.filter((asked) => asked.startsWith('global:'))).toEqual([`global:${REPOSITORY}:src/b.ts#create`]);
    } finally {
      await run.f.dispose();
    }
  }, 180_000);

  test('two calls of one target from one symbol fold into one edge with the count of the places', async () => {
    const run = await runOn({
      'src/a.ts': 'export function local(): number { return 1; }\nexport function twice(): number { return local() + local(); }\n',
      'src/b.ts': B_TS,
    });
    try {
      const calls = edgesOf(run.writes, 'code.calls');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.properties['count']).toBe(2);
      expect(edgesOf(run.writes, 'code.occurrence')).toHaveLength(2);
    } finally {
      await run.f.dispose();
    }
  }, 180_000);
});

describe('a node the graph answers that is no symbol or no mention is refused, naming the node and the read', () => {
  test('a symbol node of another file, one with no place, and one whose range ends before it starts', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', A_TS);
      await f.write('src/b.ts', B_TS);
      const commit = f.commit();
      const source = sourceAt(f.root, commit);
      const published = await filePass(source);
      const stage = createSemanticResolutionStage(source);
      const name = 'orders-api:src/a.ts#run';
      const cases: readonly { readonly nodes: readonly StaticGraphNode[]; readonly edges: Graph['edges']; readonly expected: string }[] = [
        {
          nodes: [{ id: 'n1', kind: 'code.symbol', label: 'run', properties: { recordKey: 'symbol:x', file: 'src/b.ts', qualifiedName: 'run', symbolKind: 'method', provenance: { place: { range: { startLine: 1, startColumn: 0, endLine: 2, endColumn: 1 } } } }, producer: 'fill.syntax', scope: '0' }],
          edges: [{ relation: 'code.contains', from: 'n0', to: 'n1' }],
          expected: 'which is declared in "src/b.ts", and the read was for the symbols of "src/a.ts"',
        },
        {
          nodes: [{ id: 'n1', kind: 'code.symbol', label: 'run', properties: { recordKey: 'symbol:x', file: 'src/a.ts', qualifiedName: 'run', symbolKind: 'method' }, producer: 'fill.syntax', scope: '0' }],
          edges: [{ relation: 'code.contains', from: 'n0', to: 'n1' }],
          expected: 'with no place.range',
        },
        {
          nodes: [{ id: 'n1', kind: 'code.symbol', label: 'run', properties: { recordKey: 'symbol:x', file: 'src/a.ts', qualifiedName: 'run', symbolKind: 'method', provenance: { place: { range: { startLine: 4, startColumn: 0, endLine: 2, endColumn: 1 } } } }, producer: 'fill.syntax', scope: '0' }],
          edges: [{ relation: 'code.contains', from: 'n0', to: 'n1' }],
          expected: 'a range\'s end is never before its start',
        },
        {
          nodes: [{ id: 'n1', kind: 'code.mention', label: 'run', properties: { recordKey: 'mention:x', name: 'run', use: 'call', access: 'read-access', parameterBound: false, range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 } }, producer: 'fill.syntax', scope: '0' }],
          edges: [{ relation: 'code.mentions', from: 'n0', to: 'n1' }],
          expected: 'its byte span [undefined, undefined) is no span: 0 <= start < end',
        },
        {
          nodes: [{ id: 'n1', kind: 'code.mention', label: 'run', properties: { recordKey: 'mention:x', name: ' ', use: 'call', access: 'read-access', parameterBound: false, range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 3, startByte: 0, endByte: 3 } }, producer: 'fill.syntax', scope: '0' }],
          edges: [{ relation: 'code.mentions', from: 'n0', to: 'n1' }],
          expected: 'its name is " "',
        },
      ];
      for (const held of cases) {
        // The unit's own file node keeps its published id, and the doctored node stands beside it.
        const file = published.graph.nodes.filter((node) => node.kind === 'code.file' && node.properties['path'] === 'src/a.ts');
        const nodes = [...held.nodes.map((node) => ({ ...node, id: `n${String(file.length + 1)}` })), ...file];
        const edges = held.edges.map((edge) => ({ ...edge, from: edge.from === 'n0' ? file[0]!.id : edge.from, to: edge.to === 'n1' ? nodes[0]!.id : edge.to }));
        const graph = { nodes, edges };
        const run = await contextFor(fileUnit('src/a.ts'), { source, reader: readerOf(graph) });
        const message = await refusedBy(async () => await stage.execute(fileUnit('src/a.ts'), run.context));
        expect(message).toContain(held.expected);
      }
      void name;
    } finally {
      await f.dispose();
    }
  }, 300_000);
});

describe('the readers refuse a node they cannot read whole', () => {
  test('a symbol range that is no number, a name that is no text, a file that names no blob, and a mention with no byte span', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts', A_TS);
      await f.write('src/b.ts', B_TS);
      const commit = f.commit();
      const source = sourceAt(f.root, commit);
      const published = await filePass(source);
      const stage = createSemanticResolutionStage(source);
      const file = published.graph.nodes.find((node) => node.kind === 'code.file' && node.properties['path'] === 'src/a.ts')!;
      const symbol = published.graph.nodes.find((node) => node.kind === 'code.symbol' && node.properties['file'] === 'src/a.ts')!;
      const mention = published.graph.nodes.find((node) => node.kind === 'code.mention' && node.properties['file'] === 'src/a.ts')!;
      const cases: readonly { readonly node: StaticGraphNode; readonly fileNode?: StaticGraphNode; readonly relation: string; readonly expected: string }[] = [
        // A range whose line is a text is no range.
        { node: { ...symbol, properties: { ...symbol.properties, provenance: { place: { range: { startLine: 'one', startColumn: 0, endLine: 2, endColumn: 1 } } } } }, relation: 'code.contains', expected: 'place.range.startLine is "one"' },
        // A node with no key names nothing.
        { node: { ...symbol, properties: { ...symbol.properties, recordKey: ' ' } }, relation: 'code.contains', expected: 'its recordKey is " "' },
        // The file node of this unit carries no blob: the plan could not tell one reading from the next.
        { node: { ...file, properties: { ...file.properties, blob: undefined } }, fileNode: { ...file, properties: { ...file.properties, blob: undefined } }, relation: '', expected: 'carries no blob' },
        // A resolved mention with no byte span cannot position its occurrence.
        { node: { ...mention, properties: { ...mention.properties, range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 } } }, relation: 'code.mentions', expected: 'its byte span [undefined, undefined) is no span' },
      ];
      for (const held of cases) {
        const fileNode = held.fileNode ?? file;
        const graph = held.relation === ''
          ? { nodes: [fileNode], edges: [] }
          : { nodes: [fileNode, held.node], edges: [{ relation: held.relation, from: fileNode.id, to: held.node.id }] };
        const run = await contextFor(fileUnit('src/a.ts'), { source, reader: readerOf(graph) });
        expect(await refusedBy(async () => await stage.execute(fileUnit('src/a.ts'), run.context))).toContain(held.expected);
      }
    } finally {
      await f.dispose();
    }
  }, 300_000);
});
