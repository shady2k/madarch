/**
 * The modules stage (madarch-tzte.21.7, decision 0026's stage 5) through its own
 * `plan`, `execute` and `validate` with a fake context: the orchestrator
 * (madarch-tzte.19.5) is not needed and not used.
 *
 * Every expectation comes from the task and the decisions, never from the
 * module: the DONE WHEN's fixture — two packages with a dense graph inside each
 * — yields two modules; a graph of one file and the symbol it declares splits
 * the repository's rank the way PageRank defines it (20/57 and 37/57, worked out
 * from the damping and the teleport below); a cluster over the size threshold is
 * split by folder, a cluster with no folder left to split by is a gap, and no
 * module holds more children than the fan-in bound. The graph is the test's own:
 * the reads a plan and a unit make are answered from the facts the stages
 * before this one published in the same test, which is what a fact store would
 * answer, and no test touches a real database.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factId, makeNodeFact, repositoryPath, type Fact, type FactProvenance, type FileValue, type SymbolValue } from '../src/fill/facts.js';
import { deriveStageGraph } from '../src/fill/registry.js';
import { createGitSnapshotSource, type SnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import {
  createModulesStage, edgeRows, fileRows, MODULES_STAGE_ID, modulesUnitId, packageRows, publishedFilesRead, publishedPackagesRead,
  publishedSymbolsRead, resolvedEdgesRead, symbolRows, type PublishedFileRow, type PublishedSymbolRow,
} from '../src/fill/stages/modules.js';

// ---- the test's own repository, context and graph ---------------------------

/** The product's own name for the repository every fixture pins. */
const REPOSITORY = 'orders-api';

/** A commit the graph's provenance cites: the fixture's own commit is what a unit writes, and a row's value carries none. */
const COMMIT = 'b'.repeat(40);

/** A throwaway repository the test commits into by hand. */
interface Fixture {
  readonly root: string;
  commit(): string;
  write(path: string, text?: string): Promise<void>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-modules-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = async (path: string, text = 'export const x = 1;\n'): Promise<void> => {
    const at = join(root, path);
    await mkdir(join(at, '..'), { recursive: true });
    await writeFile(at, text);
  };
  return {
    root,
    write,
    commit(): string {
      git('add', '-A');
      git('commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD').trim();
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** A source pinned at one commit of the test's repository. */
function sourceAt(root: string, commit: string): SnapshotSource {
  return createGitSnapshotSource([{ id: REPOSITORY, form: 'code', root, commit }]);
}

/** What a stage recorded while it ran. */
interface Recorder {
  readonly writes: StageDraftWrite[];
  readonly notes: string[];
  readonly queries: string[];
}

/** One unit's context: the reads answered by the test, the draft collected here, and a signal the test holds. */
function contextFor(unit: StageUnit, answer: (read: string) => readonly unknown[], config: unknown = {}): { context: StageContext; recorder: Recorder; controller: AbortController } {
  const recorder: Recorder = { writes: [], notes: [], queries: [] };
  const controller = new AbortController();
  return {
    recorder,
    controller,
    context: {
      unit,
      config: { id: MODULES_STAGE_ID, version: 1, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config },
      graph: {
        query: async (read: string) => {
          recorder.queries.push(read);
          return answer(read);
        },
      },
      draft: {
        write: (entry: StageDraftWrite) => { recorder.writes.push(entry); },
        writes: () => ({ writes: recorder.writes }),
      },
      progress: (note: string) => { recorder.notes.push(note); },
      signal: controller.signal,
    },
  };
}

/** The provenance a fact of the test's graph cites. */
function placeAt(path: string, line = 1): FactProvenance {
  return {
    source: { system: 'tree-sitter', version: '1.0.0' },
    repository: { id: REPOSITORY, commit: COMMIT },
    place: { file: repositoryPath(path), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 8 } },
  };
}

/** One file fact, as stage 1 publishes it. */
function fileFact(path: string): Fact {
  return makeNodeFact({
    kind: 'file',
    layer: 'extracted',
    provenance: placeAt(path),
    value: { repository: REPOSITORY, path: repositoryPath(path), roles: ['source'], blob: 'c'.repeat(40) },
  });
}

/** One symbol fact, as stages 3 and 4 publish it: a function declared in a file. */
function symbolFact(path: string, qualifiedName: string): Fact {
  return makeNodeFact({
    kind: 'symbol',
    layer: 'extracted',
    provenance: placeAt(path),
    value: { repository: REPOSITORY, file: repositoryPath(path), qualifiedName, symbolKind: 'function' },
  });
}

/** What a fact store would answer for one file fact: its row, with the value and the place it holds. */
function fileRow(fact: Fact): PublishedFileRow {
  const value = fact.value as FileValue;
  return { kind: 'file', path: value.path, id: fact.id, value, place: fact.provenance.place!.range };
}

/** What a fact store would answer for one symbol fact. */
function symbolRow(fact: Fact): PublishedSymbolRow {
  const value = fact.value as SymbolValue;
  return { kind: 'symbol', file: value.file, id: fact.id, value, place: fact.provenance.place!.range };
}

/** The four reads a unit makes, answered from the facts the test published: what a fact store would answer. */
function answerFor(input: {
  readonly packages?: readonly { readonly name: string; readonly form: 'build-target' | 'package' | 'workspace'; readonly manifest?: string }[];
  readonly files?: readonly Fact[];
  readonly symbols?: readonly Fact[];
  readonly edges?: readonly { readonly kind: string; readonly from: string; readonly to: string; readonly count?: number }[];
}): (read: string) => readonly unknown[] {
  return (read: string) => {
    if (read === publishedPackagesRead(REPOSITORY)) return (input.packages ?? []).map((pkg) => ({ kind: 'package', ...pkg }));
    if (read === publishedFilesRead(REPOSITORY)) return (input.files ?? []).map(fileRow);
    if (read === publishedSymbolsRead(REPOSITORY)) return (input.symbols ?? []).map(symbolRow);
    if (read === resolvedEdgesRead(REPOSITORY)) return input.edges ?? [];
    throw new Error(`the modules stage made a read this test does not answer: ${read}`);
  };
}

/** One fact of a draft set, as the fact store would hold it. */
interface DraftFact {
  readonly kind: string;
  readonly id: string;
  readonly value: Record<string, unknown>;
  readonly provenance: {
    readonly source?: { readonly system: string; readonly version: string };
    readonly place?: { readonly file: string; readonly range: { readonly startLine: number } };
  };
}

/** The facts one draft set holds, in the order they were written; a write that is no fact is left out. */
function factsOf(writes: readonly StageDraftWrite[]): readonly DraftFact[] {
  const facts: DraftFact[] = [];
  for (const write of writes) if (write.kind === 'fact') facts.push(write.value as DraftFact);
  return facts;
}

/** The facts of a kind in a draft set, in the order they were written. */
function factsOfKind(writes: readonly StageDraftWrite[], kind: string): readonly DraftFact[] {
  return factsOf(writes).filter((fact) => fact.kind === kind);
}

/** The one fact of a kind a draft set holds, refused where it holds another number of them. */
function factOfKind(writes: readonly StageDraftWrite[], kind: string): DraftFact {
  const held = factsOfKind(writes, kind);
  if (held.length !== 1) throw new Error(`the draft holds ${held.length} ${kind} facts, and this test expects one: ${held.map((fact) => fact.id).join(', ')}`);
  return held[0]!;
}

/** The module facts of a draft set: name, seed, parent, members and importance. */
function modules(writes: readonly StageDraftWrite[]): readonly { readonly id: string; readonly name: string; readonly seed: string; readonly parent?: string; readonly members: number; readonly importance: number }[] {
  return factsOfKind(writes, 'module').map((fact) => ({
    id: fact.id,
    name: String(fact.value['name']),
    seed: String(fact.value['seed']),
    ...(typeof fact.value['parent'] === 'string' ? { parent: fact.value['parent'] } : {}),
    members: Number(fact.value['members']),
    importance: Number(fact.value['importance']),
  }));
}

/** The `contains` edges of a draft set, as pairs of fact ids. */
function contained(writes: readonly StageDraftWrite[]): readonly { readonly from: string; readonly to: string }[] {
  return factsOfKind(writes, 'contains').map((fact) => ({ from: String(fact.value['from']), to: String(fact.value['to']) }));
}

/** The importance a draft wrote for one fact id. */
function importanceOf(writes: readonly StageDraftWrite[], kind: string, id: string): number {
  const held = factsOfKind(writes, kind).find((fact) => fact.id === id);
  if (held === undefined) throw new Error(`the draft holds no ${kind} fact of the id ${id}: ${factsOfKind(writes, kind).map((fact) => fact.id).join(', ')}`);
  return Number(held.value['importance']);
}

/** The module facts each module holds as children, by the module's fact id, in the order the draft wrote them. */
function childrenByModule(writes: readonly StageDraftWrite[]): ReadonlyMap<string, readonly { readonly id: string; readonly name: string }[]> {
  const named = new Map(modules(writes).map((module) => [module.id, module]));
  const children = new Map<string, { readonly id: string; readonly name: string }[]>();
  for (const edge of contained(writes)) {
    const child = named.get(edge.to);
    if (child === undefined) continue;
    const held = children.get(edge.from) ?? [];
    held.push({ id: child.id, name: child.name });
    children.set(edge.from, held);
  }
  return children;
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

/** One unit, executed over a graph the test answers; the draft it wrote. */
async function executed(source: SnapshotSource, answer: (read: string) => readonly unknown[], config: unknown = {}): Promise<Recorder> {
  const stage = createModulesStage(source);
  const unit = { id: modulesUnitId(REPOSITORY), scope: REPOSITORY };
  const { context, recorder } = contextFor(unit, answer, config);
  expect(await stage.execute(unit, context)).toEqual({ outcome: 'draft' });
  return recorder;
}

// ---- the registry ----------------------------------------------------------

describe('the modules stage is registered', () => {
  test('it runs after the stages whose facts it reads, and declares the capabilities it produces', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "orders-api" }\n');
      const commit = f.commit();
      const registry = createStageRegistry({ snapshots: sourceAt(f.root, commit) });
      const read = deriveStageGraph(registry);
      if (!read.ok) throw new Error(`the graph did not derive: ${JSON.stringify(read)}`);
      expect(registry.get(MODULES_STAGE_ID)?.version).toBe(1);
      // The clustering and the rank read stage 1's files, stage 3's symbols and
      // imports and stage 4's resolved edges, and stage 2's packages are its
      // seeds: every producer runs before it.
      for (const earlier of ['inventory', 'syntax', 'semantic-resolution', 'build-configuration']) {
        expect(read.graph.order.indexOf(earlier)).toBeLessThan(read.graph.order.indexOf(MODULES_STAGE_ID));
      }
      expect(registry.get(MODULES_STAGE_ID)?.produces.map((produced) => produced.kind)).toEqual(['contains', 'coverage', 'module']);
      expect(registry.get(MODULES_STAGE_ID)?.consumes.required.map((consume) => consume.capability)).toEqual(['file', 'symbol']);
    } finally {
      await f.dispose();
    }
  });

  test('the stage\'s defaults are a size threshold and a fan-in bound, and both read', () => {
    const stage = createModulesStage(createGitSnapshotSource([]));
    expect(stage.defaults.config).toEqual({ sizeThreshold: 50, maxFanIn: 50 });
    expect(stage.configSchema).toBeDefined();
  });
});

// ---- planning --------------------------------------------------------------

describe('the modules stage plans one unit per repository', () => {
  test('a pinned repository that holds a file is one unit, in code point order of the unit ids', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts');
      const commit = f.commit();
      const source = createGitSnapshotSource([
        { id: 'web', form: 'code', root: f.root, commit },
        { id: 'catalog-api', form: 'code', root: f.root, commit },
      ]);
      const stage = createModulesStage(source);
      const plan = await stage.plan({ query: async (read: string) => { throw new Error(`the plan makes no read and this test answers none: ${read}`); } });
      expect(plan.units.map((unit) => unit.id)).toEqual(['modules:catalog-api', 'modules:web']);
      expect(plan.units.map((unit) => unit.scope)).toEqual(['catalog-api', 'web']);
      expect(plan.coverage).toBe('planned');
    } finally {
      await f.dispose();
    }
  });

  test('a run that pins no repository with a file found nothing, which is not an empty plan of a graph nobody read', async () => {
    const stage = createModulesStage(createGitSnapshotSource([]));
    const plan = await stage.plan({ query: async () => [] });
    expect(plan.units).toEqual([]);
    expect(plan.coverage).toBe('nothing-found');
  });
});

// ---- clustering ------------------------------------------------------------

describe('the modules stage clusters the graph recursively', () => {
  test('two packages with a dense graph inside each are two modules, each holding half the repository\'s rank', async () => {
    const f = await fixture();
    try {
      for (const pkg of ['catalog', 'orders']) {
        await f.write(`packages/${pkg}/package.json`, `{ "name": "@acme/${pkg}" }\n`);
        await f.write(`packages/${pkg}/a.ts`);
        await f.write(`packages/${pkg}/b.ts`);
      }
      const commit = f.commit();
      const ordersA = fileFact('packages/orders/a.ts');
      const ordersB = fileFact('packages/orders/b.ts');
      const catalogA = fileFact('packages/catalog/a.ts');
      const catalogB = fileFact('packages/catalog/b.ts');
      // The dense internal graph of the DONE WHEN's fixture: each package's two
      // files import each other and nothing crosses a package's boundary.
      const answer = answerFor({
        packages: [
          { name: '@acme/orders', form: 'package', manifest: 'packages/orders/package.json' },
          { name: '@acme/catalog', form: 'package', manifest: 'packages/catalog/package.json' },
        ],
        files: [ordersA, ordersB, catalogA, catalogB],
        edges: [
          { kind: 'import', from: ordersA.id, to: ordersB.id },
          { kind: 'import', from: ordersB.id, to: ordersA.id },
          { kind: 'import', from: catalogA.id, to: catalogB.id },
          { kind: 'import', from: catalogB.id, to: catalogA.id },
        ],
      });
      const recorder = await executed(sourceAt(f.root, commit), answer);
      const held = modules(recorder.writes);
      expect(held.map((module) => module.name).sort()).toEqual(['@acme/catalog', '@acme/orders']);
      // The DONE WHEN's bar: two packages, two modules, each seeded by its own
      // package and holding its own two files.
      for (const module of held) {
        expect(module.seed).toBe('package');
        expect(module.parent).toBeUndefined();
        expect(module.members).toBe(2);
        // Two identical packages with a two-file cycle each: the graph is
        // symmetric, so each node holds a quarter of the rank and each package
        // half of it — worked out from the fixture, not from the code.
        expect(module.importance).toBeCloseTo(0.5, 12);
      }
      expect(held.map((module) => module.importance).reduce((left, right) => left + right, 0)).toBeCloseTo(1, 12);
      // Each file's own share, and the containment that holds the tree: the
      // module holds its two files and no other module's.
      for (const file of [ordersA, ordersB, catalogA, catalogB]) expect(importanceOf(recorder.writes, 'file', file.id)).toBeCloseTo(0.25, 12);
      const edges = contained(recorder.writes);
      const orders = held.find((module) => module.name === '@acme/orders')!;
      expect(edges.filter((edge) => edge.from === orders.id).map((edge) => edge.to).sort()).toEqual([ordersA.id, ordersB.id].sort());
      expect(factOfKind(recorder.writes, 'coverage').value['complete']).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  test('a file and the symbol it declares split the repository\'s rank as PageRank defines it', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts');
      const commit = f.commit();
      const file = fileFact('src/a.ts');
      const symbol = symbolFact('src/a.ts', 'a');
      const recorder = await executed(sourceAt(f.root, commit), answerFor({ files: [file], symbols: [symbol] }));
      // One file, one symbol, no edge between them but the declaration that a
      // file holds its symbols. With N = 2, damping d = 0.85, the teleport part
      // (1 − d)/N = 0.075 and d/N = 0.425, the walk's fixed point is
      //   f = 0.075 + 0.425·s
      //   s = 0.075 + 0.425·s + 0.85·f      (the symbol points at nothing, and
      //                                      the file's whole share goes to it)
      // which solves to s = 37/57 and f = 20/57 — the numbers this test expects.
      expect(importanceOf(recorder.writes, 'file', file.id)).toBeCloseTo(20 / 57, 11);
      expect(importanceOf(recorder.writes, 'symbol', symbol.id)).toBeCloseTo(37 / 57, 11);
      // No package stands for the repository, so the repository itself is the
      // one module, and everything under it is its own rank.
      const root = factOfKind(recorder.writes, 'module');
      expect(root.value['name']).toBe(REPOSITORY);
      expect(root.value['seed']).toBe('cluster');
      expect(root.value['members']).toBe(2);
      expect(root.value['importance']).toBeCloseTo(1, 12);
      // The module holds the file and the symbol the file declares.
      expect(contained(recorder.writes).map((edge) => edge.to).sort()).toEqual([file.id, symbol.id].sort());
    } finally {
      await f.dispose();
    }
  });

  test('a cluster over the size threshold is split by folder, and its own files stay in it', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "@acme/app" }\n');
      await f.write('index.ts');
      await f.write('src/x.ts');
      await f.write('src/y.ts');
      const commit = f.commit();
      const index = fileFact('index.ts');
      const x = fileFact('src/x.ts');
      const y = fileFact('src/y.ts');
      const recorder = await executed(sourceAt(f.root, commit), answerFor({
        packages: [{ name: '@acme/app', form: 'package', manifest: 'package.json' }],
        files: [index, x, y],
      }), { sizeThreshold: 2, maxFanIn: 50 });
      const held = modules(recorder.writes);
      expect(held.map((module) => module.name).sort()).toEqual(['@acme/app', 'src']);
      const app = held.find((module) => module.name === '@acme/app')!;
      const src = held.find((module) => module.name === 'src')!;
      // The package's own file stays in the package's module; the folder below
      // it is a module of its own, held by the package.
      expect(src.parent).toBe(app.id);
      expect(src.seed).toBe('cluster');
      expect(src.members).toBe(2);
      expect(app.members).toBe(3);
      const edges = contained(recorder.writes);
      expect(edges).toContainEqual({ from: app.id, to: src.id });
      expect(edges.filter((edge) => edge.from === app.id).map((edge) => edge.to)).toContain(index.id);
      expect(edges.filter((edge) => edge.from === src.id).map((edge) => edge.to).sort()).toEqual([x.id, y.id].sort());
    } finally {
      await f.dispose();
    }
  });

  test('a cluster holding exactly the size threshold is not split', async () => {
    const f = await fixture();
    try {
      await f.write('a.ts');
      await f.write('src/x.ts');
      const commit = f.commit();
      const a = fileFact('a.ts');
      const x = fileFact('src/x.ts');
      // Two files and a threshold of two: the cluster fits, and no boundary is
      // drawn inside it (the rule splits a cluster that is *over* the threshold).
      const recorder = await executed(sourceAt(f.root, commit), answerFor({ files: [a, x] }), { sizeThreshold: 2, maxFanIn: 50 });
      const held = modules(recorder.writes);
      expect(held).toHaveLength(1);
      expect(held[0]!.members).toBe(2);
      expect(contained(recorder.writes).map((edge) => edge.to).sort()).toEqual([a.id, x.id].sort());
      expect(factOfKind(recorder.writes, 'coverage').value['complete']).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  test('a cluster with no folder left to split by is a gap, never a smaller module', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "@acme/app" }\n');
      await f.write('a.ts');
      await f.write('b.ts');
      const commit = f.commit();
      const recorder = await executed(sourceAt(f.root, commit), answerFor({
        packages: [{ name: '@acme/app', form: 'package', manifest: 'package.json' }],
        files: [fileFact('a.ts'), fileFact('b.ts')],
      }), { sizeThreshold: 1, maxFanIn: 50 });
      const held = modules(recorder.writes);
      expect(held).toHaveLength(1);
      // Both files stand directly in the package's folder and the threshold is
      // one: the cluster is kept whole and the coverage says why.
      expect(held[0]!.members).toBe(2);
      const coverage = factOfKind(recorder.writes, 'coverage');
      expect(coverage.value['complete']).toBe(false);
      const unread = coverage.value['unread'] as readonly { readonly what: string; readonly reason: string }[];
      expect(unread).toHaveLength(1);
      expect(unread[0]!.reason).toBe('too-large');
      expect(unread[0]!.what).toContain('the size threshold is 1');
    } finally {
      await f.dispose();
    }
  });

  test('files standing directly in a split cluster are named when they are still over the threshold', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "@acme/app" }\n');
      await f.write('a.ts');
      await f.write('b.ts');
      await f.write('src/x.ts');
      const commit = f.commit();
      const recorder = await executed(sourceAt(f.root, commit), answerFor({
        packages: [{ name: '@acme/app', form: 'package', manifest: 'package.json' }],
        files: [fileFact('a.ts'), fileFact('b.ts'), fileFact('src/x.ts')],
      }), { sizeThreshold: 1, maxFanIn: 50 });
      // The package splits off `src`, and its own two files still stand over the
      // threshold of one: the cluster says so, rather than standing as a module
      // larger than the bound in a coverage that calls it whole.
      expect(modules(recorder.writes).map((module) => module.name).sort()).toEqual(['@acme/app', 'src']);
      const coverage = factOfKind(recorder.writes, 'coverage');
      expect(coverage.value['complete']).toBe(false);
      const unread = coverage.value['unread'] as readonly { readonly what: string; readonly reason: string }[];
      expect(unread).toHaveLength(1);
      expect(unread[0]!.reason).toBe('too-large');
      expect(unread[0]!.what).toContain('2 files stand directly in this folder');
    } finally {
      await f.dispose();
    }
  });

  test('a fan-in bound of one cannot group anything, and is refused by name', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts');
      const commit = f.commit();
      const message = await refusedBy(() => executed(sourceAt(f.root, commit), answerFor({ files: [fileFact('src/a.ts')] }), { maxFanIn: 1 }));
      expect(message).toContain('maxFanIn');
      expect(message).toContain('a module\'s fan-in bound is 2 or more');
    } finally {
      await f.dispose();
    }
  });

  test('no module holds more children than the fan-in bound: the children are grouped into intermediate modules', async () => {
    const f = await fixture();
    try {
      for (const folder of ['f1', 'f2', 'f3']) await f.write(`${folder}/a.ts`);
      const commit = f.commit();
      const files = ['f1', 'f2', 'f3'].map((folder) => fileFact(`${folder}/a.ts`));
      const recorder = await executed(sourceAt(f.root, commit), answerFor({ files }), { sizeThreshold: 1, maxFanIn: 2 });
      const held = modules(recorder.writes);
      const childrenOf = childrenByModule(recorder.writes);
      const root = held.find((module) => module.name === REPOSITORY)!;
      // Three folders beside one another and a bound of two: the root holds two
      // intermediate modules, named by their place among its children, and the
      // folders stand under them at the names they had.
      const parts = childrenOf.get(root.id) ?? [];
      expect(parts.map((module) => module.name).sort()).toEqual(['part-1', 'part-2']);
      // The draft is written in code point order of the fact ids, so the groups
      // are read back by name and not by the order they were written in.
      const namesUnder = (name: string): string[] => {
        const group = parts.find((module) => module.name === name);
        return (childrenOf.get(group?.id ?? '') ?? []).map((module) => module.name).sort();
      };
      expect(namesUnder('part-1')).toEqual(['f1', 'f2']);
      expect(namesUnder('part-2')).toEqual(['f3']);
      for (const module of held.filter((entry) => entry.name.startsWith('part-'))) expect(module.seed).toBe('cluster');
      for (const names of childrenOf.values()) expect(names.length).toBeLessThanOrEqual(2);
    } finally {
      await f.dispose();
    }
  });

  test('the fan-in bound holds however wide the folder is, level after level', async () => {
    const f = await fixture();
    try {
      for (const folder of ['f1', 'f2', 'f3', 'f4', 'f5']) await f.write(`${folder}/a.ts`);
      const commit = f.commit();
      const files = ['f1', 'f2', 'f3', 'f4', 'f5'].map((folder) => fileFact(`${folder}/a.ts`));
      const recorder = await executed(sourceAt(f.root, commit), answerFor({ files }), { sizeThreshold: 1, maxFanIn: 2 });
      const held = modules(recorder.writes);
      for (const children of childrenByModule(recorder.writes).values()) expect(children.length).toBeLessThanOrEqual(2);
      // Five folders, two children a module at the most: the folders stand at
      // their own names somewhere under the root, reached through the grouping.
      const root = held.find((module) => module.name === REPOSITORY)!;
      const reachable = new Set<string>();
      const walk = (id: string): void => {
        for (const child of childrenByModule(recorder.writes).get(id) ?? []) {
          reachable.add(child.name);
          walk(child.id);
        }
      };
      walk(root.id);
      expect([...reachable].filter((name) => name.startsWith('f')).sort()).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
      expect(held.length).toBeGreaterThan(5);
    } finally {
      await f.dispose();
    }
  });

  test('a file belongs to the seed whose folder is the longest prefix of its path', async () => {
    const f = await fixture();
    try {
      for (const path of ['package.json', 'index.ts', 'packages/api/package.json', 'packages/api/src/a.ts', 'packages/api/src/deep/b.ts']) await f.write(path);
      const commit = f.commit();
      const index = fileFact('index.ts');
      const a = fileFact('packages/api/src/a.ts');
      const b = fileFact('packages/api/src/deep/b.ts');
      const recorder = await executed(sourceAt(f.root, commit), answerFor({
        packages: [
          // The same two packages, answered innermost *last*: the plan reads by
          // the folder's length and not by the order the read answered in.
          { name: '@acme/api', form: 'package', manifest: 'packages/api/package.json' },
          { name: '@acme/root', form: 'package', manifest: 'package.json' },
        ],
        files: [index, a, b],
      }));
      const held = modules(recorder.writes);
      const root = held.find((module) => module.name === '@acme/root')!;
      const api = held.find((module) => module.name === '@acme/api')!;
      const edges = contained(recorder.writes);
      // The inner package holds the files under its folder; the root package
      // holds what stands above it, and never reaches into the inner one.
      expect(edges.filter((edge) => edge.from === api.id).map((edge) => edge.to).sort()).toEqual([a.id, b.id].sort());
      expect(edges.filter((edge) => edge.from === root.id).map((edge) => edge.to)).toEqual([index.id]);
      expect(root.members).toBe(1);
      expect(api.members).toBe(2);
    } finally {
      await f.dispose();
    }
  });

  test('two seeds claiming one folder are told apart by their manifest path, and two packages of one name say which manifest they came from', async () => {
    const f = await fixture();
    try {
      await f.write('Cargo.toml');
      await f.write('go.mod');
      await f.write('index.ts');
      await f.write('packages/web/package.json', '{ "name": "@acme/web" }\n');
      await f.write('packages/site/Cargo.toml');
      await f.write('packages/web/a.ts');
      await f.write('packages/site/b.ts');
      const commit = f.commit();
      const index = fileFact('index.ts');
      const web = fileFact('packages/web/a.ts');
      const site = fileFact('packages/site/b.ts');
      const recorder = await executed(sourceAt(f.root, commit), answerFor({
        packages: [
          // Two seeds of the root folder (`Cargo.toml` and `go.mod`) and two
          // packages of one name in two forms: a package and a build target of
          // one name are two facts of the schema, and each top-level module of a
          // shared name says which manifest it came from.
          { name: 'root-crate', form: 'package', manifest: 'Cargo.toml' },
          { name: 'root-module', form: 'package', manifest: 'go.mod' },
          { name: '@acme/web', form: 'package', manifest: 'packages/web/package.json' },
          { name: '@acme/web', form: 'build-target', manifest: 'packages/site/Cargo.toml' },
        ],
        files: [index, web, site],
      }));
      const held = modules(recorder.writes);
      expect(held.map((module) => module.name).sort()).toEqual([
        '@acme/web (packages/site/Cargo.toml)',
        '@acme/web (packages/web/package.json)',
        'root-crate',
      ]);
      // The ids differ, so the two clusters of one package name are two facts
      // and not one fact published twice.
      expect(new Set(held.map((module) => module.id)).size).toBe(3);
      // The two seeds of the root folder claim one file between them, and the
      // manifest that stands first in code point order holds it.
      const rootCrate = held.find((module) => module.name === 'root-crate')!;
      expect(contained(recorder.writes).filter((edge) => edge.from === rootCrate.id).map((edge) => edge.to)).toEqual([index.id]);
      // The seed that lost the file seeds no module, and the coverage says so.
      const coverage = factOfKind(recorder.writes, 'coverage');
      expect(coverage.value['complete']).toBe(false);
      const unread = coverage.value['unread'] as readonly { readonly what: string }[];
      expect(unread).toHaveLength(1);
      expect(unread[0]!.what).toContain('root-module');
    } finally {
      await f.dispose();
    }
  });

  test('a call edge\'s site count is the weight the rank gives it', async () => {
    const f = await fixture();
    try {
      for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) await f.write(path);
      const commit = f.commit();
      const a = fileFact('src/a.ts');
      const b = fileFact('src/b.ts');
      const c = fileFact('src/c.ts');
      const callA = symbolFact('src/a.ts', 'a');
      const callB = symbolFact('src/b.ts', 'b');
      const callC = symbolFact('src/c.ts', 'c');
      const recorder = await executed(sourceAt(f.root, commit), answerFor({
        files: [a, b, c],
        symbols: [callA, callB, callC],
        // One symbol calls two symbols, three sites into one and one into the
        // other: the edge's weight is what stage 4 folded in, and the rank
        // follows it. With the weight ignored the two would be equal, since
        // nothing else tells them apart.
        edges: [
          { kind: 'call', from: callA.id, to: callB.id, count: 3 },
          { kind: 'call', from: callA.id, to: callC.id, count: 1 },
        ],
      }));
      expect(importanceOf(recorder.writes, 'symbol', callB.id)).toBeGreaterThan(importanceOf(recorder.writes, 'symbol', callC.id));
    } finally {
      await f.dispose();
    }
  });

  test('the same graph answers the same modules and the same ranks, whatever order the reads answer in', async () => {
    const f = await fixture();
    try {
      for (const pkg of ['catalog', 'orders']) {
        await f.write(`packages/${pkg}/package.json`, `{ "name": "@acme/${pkg}" }\n`);
        await f.write(`packages/${pkg}/a.ts`);
        await f.write(`packages/${pkg}/b.ts`);
      }
      const commit = f.commit();
      const ordersA = fileFact('packages/orders/a.ts');
      const ordersB = fileFact('packages/orders/b.ts');
      const catalogA = fileFact('packages/catalog/a.ts');
      const catalogB = fileFact('packages/catalog/b.ts');
      const symbol = symbolFact('packages/orders/a.ts', 'a');
      const input = {
        packages: [
          { name: '@acme/orders', form: 'package' as const, manifest: 'packages/orders/package.json' },
          { name: '@acme/catalog', form: 'package' as const, manifest: 'packages/catalog/package.json' },
        ],
        files: [ordersA, ordersB, catalogA, catalogB],
        symbols: [symbol],
        edges: [
          { kind: 'import', from: ordersA.id, to: ordersB.id },
          { kind: 'call', from: symbol.id, to: symbol.id, count: 2 },
        ],
      };
      const source = sourceAt(f.root, commit);
      const first = await executed(source, answerFor(input));
      const reversed = (read: string) => [...answerFor(input)(read)].reverse();
      const second = await executed(source, reversed);
      const shape = (writes: readonly StageDraftWrite[]) => factsOf(writes).map((fact) => ({ kind: fact.kind, id: fact.id, value: fact.value }));
      expect(shape(second.writes)).toEqual(shape(first.writes));
    } finally {
      await f.dispose();
    }
  });

  test('a rank a later run measures moves, and the fact it is about keeps its id', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts');
      await f.write('src/b.ts');
      const commit = f.commit();
      const a = fileFact('src/a.ts');
      const b = fileFact('src/b.ts');
      const first = await executed(sourceAt(f.root, commit), answerFor({ files: [a, b] }));
      const second = await executed(sourceAt(f.root, commit), answerFor({
        files: [a, b],
        edges: [{ kind: 'import', from: a.id, to: b.id }],
      }));
      // The edge moves the rank between the two files, and the facts they are
      // written on are the same nodes: one id each, a new value.
      expect(importanceOf(second.writes, 'file', a.id)).toBeLessThan(importanceOf(first.writes, 'file', a.id));
      expect(importanceOf(second.writes, 'file', b.id)).toBeGreaterThan(importanceOf(first.writes, 'file', b.id));
      expect(factsOfKind(second.writes, 'file').map((fact) => fact.id).sort()).toEqual(factsOfKind(first.writes, 'file').map((fact) => fact.id).sort());
    } finally {
      await f.dispose();
    }
  });
});

// ---- what the unit says about its own reading ------------------------------

describe('the modules stage writes the coverage of what it read', () => {
  test('the coverage names the scopes it read, and every seed that stands for no module', async () => {
    const f = await fixture();
    try {
      await f.write('package.json', '{ "name": "@acme/app" }\n');
      await f.write('index.ts');
      const commit = f.commit();
      const recorder = await executed(sourceAt(f.root, commit), answerFor({
        packages: [
          { name: '@acme/app', form: 'package', manifest: 'package.json' },
          { name: '@acme/workspaces', form: 'workspace', manifest: 'package.json' },
          { name: '@acme/ghost', form: 'package' },
        ],
        files: [fileFact('index.ts')],
      }));
      const coverage = factOfKind(recorder.writes, 'coverage');
      expect(coverage.value['repository']).toBe(REPOSITORY);
      // The coverage's identity is the repository, the scope and the *reader*
      // (facts.ts), and stage 0 writes its own coverage of the same repository
      // under git's reader: two readers are two coverages, and a stage that
      // named git's reader would have its gaps overwritten by stage 0's row,
      // because the store keeps the first publication of an id.
      expect(coverage.provenance.source?.system).toBe('madarch-fill');
      const stage0 = factId({
        kind: 'coverage',
        value: { repository: REPOSITORY, scope: coverage.value['scope'] as string, complete: true, read: [], unread: [] },
        provenance: { source: { system: 'git', version: '2.51.0' }, repository: { id: REPOSITORY, commit: COMMIT } },
      });
      expect(coverage.id).not.toBe(stage0);
      expect(coverage.value['read']).toEqual(['calls', 'files', 'imports', 'inherits', 'packages', 'references', 'symbols']);
      // The repository's own fact id, not a path: the scope a reader joins on.
      const repositoryId = factId({ kind: 'repository', value: { repository: REPOSITORY, form: 'code' }, provenance: placeAt('index.ts') });
      expect(coverage.value['scope']).toBe(repositoryId);
      const unread = coverage.value['unread'] as readonly { readonly what: string }[];
      expect(unread.map((gap) => gap.what).join('\n')).toContain('a workspace holds the packages of its folders');
      expect(unread.map((gap) => gap.what).join('\n')).toContain('names no manifest');
      expect(coverage.value['complete']).toBe(false);
    } finally {
      await f.dispose();
    }
  });
});

// ---- the reads, read ------------------------------------------------------

describe('the reads are read strictly', () => {
  /** The read text the row readers are called with: what a refusal names, and what a wiring would answer. */
  const read = publishedFilesRead(REPOSITORY);

  test('a row the read does not answer is refused, naming the read, the row and the field', async () => {
    expect(await refusedBy(() => packageRows([{ kind: 'module', name: 'x', form: 'package' }], REPOSITORY, read))).toContain('answered row 1');
    expect(await refusedBy(() => packageRows([{ kind: 'package', name: 'x', form: 'workspace', extra: 1 }], REPOSITORY, read))).toContain('extra');
    expect(await refusedBy(() => packageRows([{ kind: 'package', name: ' ', form: 'package' }], REPOSITORY, read))).toContain('is no package name');
    const file = fileFact('src/a.ts');
    expect(await refusedBy(() => fileRows([{ ...fileRow(file), id: `file:${'0'.repeat(64)}` }], REPOSITORY, read))).toContain('is not the digest of its value');
    expect(await refusedBy(() => fileRows([{ ...fileRow(file), place: { startLine: 2, startColumn: 0, endLine: 1, endColumn: 0 } }], REPOSITORY, read))).toContain('a range\'s end is never before its start');
    const symbol = symbolFact('src/a.ts', 'a');
    expect(await refusedBy(() => symbolRows([{ ...symbolRow(symbol), value: { ...symbolRow(symbol).value, repository: 'other-api' } }], REPOSITORY, read))).toContain('one fact is one repository');
    expect(await refusedBy(() => edgeRows([{ kind: 'import', from: symbol.id, to: file.id }], REPOSITORY, read))).toContain('is no file fact id');
    expect(await refusedBy(() => edgeRows([{ kind: 'import', from: file.id, to: file.id, count: 2 }], REPOSITORY, read))).toContain('an import edge folds no sites');
    // One file, one symbol and one package are one fact each: a read that answers one twice is refused rather than counted twice.
    expect(await refusedBy(() => fileRows([fileRow(file), fileRow(file)], REPOSITORY, read))).toContain('one file is one fact');
    expect(await refusedBy(() => symbolRows([symbolRow(symbol), symbolRow(symbol)], REPOSITORY, read))).toContain('one symbol is one fact');
    expect(await refusedBy(() => packageRows([
      { kind: 'package', name: 'x', form: 'package' },
      { kind: 'package', name: 'x', form: 'package' },
    ], REPOSITORY, read))).toContain('a package is one fact');
    expect(await refusedBy(() => edgeRows([
      { kind: 'call', from: symbol.id, to: symbol.id, count: 1 },
      { kind: 'call', from: symbol.id, to: symbol.id, count: 3 },
    ], REPOSITORY, read))).toContain('it repeats row 1');
  });

  test('an edge whose end names no node of the reads is refused, never dropped from the walk', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts');
      const commit = f.commit();
      const a = fileFact('src/a.ts');
      const message = await refusedBy(() => executed(sourceAt(f.root, commit), answerFor({
        files: [a],
        edges: [{ kind: 'import', from: a.id, to: `file:${'1'.repeat(64)}` }],
      })));
      expect(message).toContain(resolvedEdgesRead(REPOSITORY));
      expect(message).toContain('is no node of the reads');
    } finally {
      await f.dispose();
    }
  });

  test('a symbol whose file the files read does not hold is refused, naming both reads', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts');
      const commit = f.commit();
      const orphan = symbolFact('src/vanished.ts', 'a');
      const message = await refusedBy(() => executed(sourceAt(f.root, commit), answerFor({ files: [fileFact('src/a.ts')], symbols: [orphan] })));
      expect(message).toContain(publishedSymbolsRead(REPOSITORY));
      expect(message).toContain(publishedFilesRead(REPOSITORY));
      expect(message).toContain('src/vanished.ts');
    } finally {
      await f.dispose();
    }
  });
});

// ---- one unit's own refusals ----------------------------------------------

describe('one unit refuses what it cannot take', () => {
  test('a cancelled unit publishes nothing, and says so', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts');
      const commit = f.commit();
      const stage = createModulesStage(sourceAt(f.root, commit));
      const unit = { id: modulesUnitId(REPOSITORY), scope: REPOSITORY };
      const { context, recorder, controller } = contextFor(unit, answerFor({ files: [fileFact('src/a.ts')] }));
      controller.abort();
      expect(await refusedBy(() => stage.execute(unit, context))).toContain(`the unit "${unit.id}" was cancelled`);
      expect(recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a unit id this stage never plans is refused, naming its shape', async () => {
    const stage = createModulesStage(createGitSnapshotSource([]));
    const { context } = contextFor({ id: 'file:orders-api:src/a.ts', scope: 'orders-api' }, () => []);
    expect(await refusedBy(() => stage.execute({ id: 'file:orders-api:src/a.ts', scope: 'orders-api' }, context)))
      .toContain('a unit id is "modules:<repository>"');
    expect(stage.id).toBe(MODULES_STAGE_ID);
  });

  test('a configuration value that is no whole number of one or more is refused by name', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts');
      const commit = f.commit();
      const message = await refusedBy(() => executed(sourceAt(f.root, commit), answerFor({ files: [fileFact('src/a.ts')] }), { sizeThreshold: 0 }));
      expect(message).toContain('sizeThreshold');
    } finally {
      await f.dispose();
    }
  });

  test('a draft is judged against the schema and the stage\'s own kinds', async () => {
    const f = await fixture();
    try {
      await f.write('src/a.ts');
      const commit = f.commit();
      const stage = createModulesStage(sourceAt(f.root, commit));
      const unit = { id: modulesUnitId(REPOSITORY), scope: REPOSITORY };
      const { context, recorder } = contextFor(unit, answerFor({ files: [fileFact('src/a.ts')] }));
      await stage.execute(unit, context);
      expect(await stage.validate({ writes: recorder.writes }, { query: async () => [] })).toEqual({ ok: true });
      // A write of a kind this stage does not write is refused, naming the stage and the kind.
      const foreign = { kind: 'fact' as const, evidence: 'orders-api@x', value: { ...factsOf(recorder.writes)[0]!, kind: 'document' } };
      const verdict = await stage.validate({ writes: [foreign] }, { query: async () => [] });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) return;
      expect(verdict.errors.join('\n')).toContain('the modules stage does not produce a "document" fact');
    } finally {
      await f.dispose();
    }
  });
});
