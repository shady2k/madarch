/**
 * The modules a page's module views are drawn from (madarch-tzte.23.7; decision 0026,
 * "Diagrams"): a repository page shows the repository's modules at the first level
 * that has more than one, and a module page shows its own child modules and the
 * modules it relates to at its own level.
 *
 * The graph here is one this test makes with the schema's constructors and reads
 * through the in-memory reader the diagram fixture already shares (`readsOf`), so the
 * rules are judged without a database: the descent through a clustering whose top
 * level is one module, the neighbours of a module rolled up from the files their
 * imports join, and the two views a page draws from them.
 *
 * The expectations are the task's own, written from its DONE WHEN and from 0026:
 * "a repository page's module-dependency and component diagrams show the repository's
 * modules at the first level that has more than one ... with their dependency edges; a
 * module page shows its own child modules and its neighbours".
 */
import { describe, expect, test } from 'bun:test';
import { buildDiagram } from '../src/fill/diagrams.js';
import { diagramSpecsFor, moduleNeighbours, moduleViewScope } from '../src/fill/graph-diagrams.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact, type FactProvenance } from '../src/fill/facts.js';
import { readsOf } from './fill-diagram-fixture.js';

const COMMIT = 'a'.repeat(40);

/** One provenance: a fact the modules stage read at a place in a repository, at the pinned commit. */
function at(repository: string, file: string, line = 1): FactProvenance {
  return {
    source: { system: 'fill-stage-5', version: '1' },
    repository: { id: repository, commit: COMMIT },
    place: { file: repositoryPath(file), range: { startLine: line, startColumn: 0, endLine: line, endColumn: 1 } },
  };
}

/** One node fact, made through the schema's own constructor so every fact here is one the schema reads. */
function node(kind: string, value: Record<string, unknown>, place: FactProvenance): Fact {
  return makeNodeFact({ kind, value, provenance: place, layer: 'extracted' } as unknown as Parameters<typeof makeNodeFact>[0]) as Fact;
}

/** One edge fact, made the same way. */
function edge(kind: string, value: Record<string, unknown>, place: FactProvenance): Fact {
  return makeEdgeFact({ kind, value, provenance: place, layer: 'extracted' } as unknown as Parameters<typeof makeEdgeFact>[0]) as Fact;
}

/**
 * The graph: one repository whose clustering puts everything below a single top-level
 * module (`single`), which is what stage 5 makes of a repository of one package — the
 * shape madarch-tzte.23.5's walk met on a real checkout, where the page drew one box.
 *
 * `single` holds three clusters (`app`, `api`, `shared`), each holding one file, and
 * three imports join them: app → api, app → shared and api → shared. A second
 * repository (`other`) holds one module of its own and a file the app imports across
 * the repository boundary, which is a relation no module of `single`'s level stands for.
 */
function graph() {
  const single = node('repository', { repository: 'single', form: 'code' }, at('single', 'README.md'));
  const other = node('repository', { repository: 'other', form: 'code' }, at('other', 'README.md'));
  const top = node('module', { repository: 'single', name: 'single', seed: 'package', members: 3, importance: 1 }, at('single', 'package.json'));
  const app = node('module', { repository: 'single', name: 'app', parent: top.id, seed: 'cluster', members: 1 }, at('single', 'src/app/app.ts'));
  const api = node('module', { repository: 'single', name: 'api', parent: top.id, seed: 'cluster', members: 1 }, at('single', 'src/api/api.ts'));
  const shared = node('module', { repository: 'single', name: 'shared', parent: top.id, seed: 'cluster', members: 1 }, at('single', 'src/shared/shared.ts'));
  const elsewhere = node('module', { repository: 'other', name: 'other', seed: 'package', members: 1 }, at('other', 'src/thing.ts'));
  const appFile = node('file', { repository: 'single', path: repositoryPath('src/app/app.ts'), roles: ['source'], language: 'typescript' }, at('single', 'src/app/app.ts', 2));
  const apiFile = node('file', { repository: 'single', path: repositoryPath('src/api/api.ts'), roles: ['source'], language: 'typescript' }, at('single', 'src/api/api.ts', 2));
  const sharedFile = node('file', { repository: 'single', path: repositoryPath('src/shared/shared.ts'), roles: ['source'], language: 'typescript' }, at('single', 'src/shared/shared.ts', 2));
  const otherFile = node('file', { repository: 'other', path: repositoryPath('src/thing.ts'), roles: ['source'], language: 'typescript' }, at('other', 'src/thing.ts', 2));
  const holds = [
    edge('contains', { from: single.id, to: top.id }, at('single', 'package.json')),
    edge('contains', { from: top.id, to: app.id }, at('single', 'src/app/app.ts')),
    edge('contains', { from: top.id, to: api.id }, at('single', 'src/api/api.ts')),
    edge('contains', { from: top.id, to: shared.id }, at('single', 'src/shared/shared.ts')),
    edge('contains', { from: other.id, to: elsewhere.id }, at('other', 'src/thing.ts')),
    edge('contains', { from: app.id, to: appFile.id }, at('single', 'src/app/app.ts', 2)),
    edge('contains', { from: api.id, to: apiFile.id }, at('single', 'src/api/api.ts', 2)),
    edge('contains', { from: shared.id, to: sharedFile.id }, at('single', 'src/shared/shared.ts', 2)),
    edge('contains', { from: elsewhere.id, to: otherFile.id }, at('other', 'src/thing.ts', 2)),
  ];
  const imports = [
    edge('import', { from: appFile.id, to: api.id, specifier: '../api/api.js' }, at('single', 'src/app/app.ts', 3)),
    edge('import', { from: appFile.id, to: sharedFile.id, specifier: '../shared/shared.js' }, at('single', 'src/app/app.ts', 4)),
    edge('import', { from: apiFile.id, to: sharedFile.id, specifier: '../shared/shared.js' }, at('single', 'src/api/api.ts', 3)),
    edge('import', { from: appFile.id, to: otherFile.id, specifier: 'other' }, at('single', 'src/app/app.ts', 5)),
  ];
  return { single, other, top, app, api, shared, elsewhere, appFile, apiFile, sharedFile, otherFile, holds, imports, facts: [single, other, top, app, api, shared, elsewhere, appFile, apiFile, sharedFile, otherFile, ...holds, ...imports] };
}

const fx = graph();
const reads = readsOf(fx.facts);

/** One arrow as a reader reads it: its two ends by label, its kind and how it stands. */
function arrowNames(model: { readonly elements: readonly { readonly id: string; readonly label: string }[]; readonly edges: readonly { readonly from: string; readonly to: string; readonly label: string; readonly facts: readonly string[] }[] }): string[] {
  const named = new Map(model.elements.map((element) => [element.id, element.label]));
  return model.edges.map((arrow) => `${String(named.get(arrow.from))}>${String(named.get(arrow.to))}:${arrow.label}:${String(arrow.facts.length)}`).sort();
}

describe('the level a repository page draws', () => {
  test('a repository whose top level is one module draws the level below it, where its structure is', async () => {
    // The single top-level module holds three clusters: the page is drawn by the module that holds them, which is the
    // first level with more than one, and the walk says so as the scope whose children are that level.
    expect(await moduleViewScope(reads, { id: fx.single.id, name: 'single' })).toEqual([fx.top.id]);
  });

  test('a repository whose top level already has more than one module draws it, and so does one the stages never clustered', async () => {
    // `other` holds one module and nothing below it: the level above it is the finest structure there is, and the
    // repository's own scope draws it (a level that has no module is a page saying nothing).
    expect(await moduleViewScope(reads, { id: fx.other.id, name: 'other' })).toEqual([fx.other.id]);
    // A repository the graph holds no module for at all: its own scope, which draws nothing rather than failing.
    expect(await moduleViewScope(reads, { id: 'repository:' + '0'.repeat(64), name: 'absent' })).toEqual(['repository:' + '0'.repeat(64)]);
  });

  test('the descent stops at the first level with more than one, whatever stands below it', async () => {
    // A chain of single modules (`root` → `one` → `two`) and two clusters under the last one: the walk passes the two
    // single levels and answers the module whose children are the two.
    const root = node('module', { repository: 'chain', name: 'chain', seed: 'package', members: 2 }, at('chain', 'package.json'));
    const one = node('module', { repository: 'chain', name: 'one', parent: root.id, seed: 'cluster', members: 2 }, at('chain', 'one/x.ts'));
    const two = node('module', { repository: 'chain', name: 'two', parent: one.id, seed: 'cluster', members: 2 }, at('chain', 'one/two/x.ts'));
    const leafA = node('module', { repository: 'chain', name: 'a', parent: two.id, seed: 'cluster', members: 1 }, at('chain', 'one/two/a/x.ts'));
    const leafB = node('module', { repository: 'chain', name: 'b', parent: two.id, seed: 'cluster', members: 1 }, at('chain', 'one/two/b/x.ts'));
    const chainReads = readsOf([root, one, two, leafA, leafB]);
    expect(await moduleViewScope(chainReads, { id: 'repository:' + '1'.repeat(64), name: 'chain' })).toEqual([two.id]);
  });

  test('a repository page names the level as the scope of its two module views, and keeps its own for the others', () => {
    const specs = diagramSpecsFor({ kind: 'repository', id: fx.single.id, repositoryId: fx.single.id, moduleScopes: { view: [fx.top.id], neighbours: [] } });
    expect(specs.map((spec) => [spec.type, spec.nodes])).toEqual([
      ['c4-context', []],
      ['c4-container', [fx.single.id]],
      ['c4-component', [fx.top.id]],
      ['module-dependency', [fx.top.id]],
      ['er', [fx.single.id]],
    ]);
  });

  test('the two module views of that page draw the three clusters and the imports between them', async () => {
    const component = await buildDiagram({ type: 'c4-component', nodes: [fx.top.id] }, reads);
    expect(component.elements.map((element) => element.label)).toEqual(['api', 'app', 'shared']);
    // Three imports join the three clusters; the app's import of the other repository's file stands for no element
    // of this level, and a relation the view cannot place is not drawn (0026's view is what the graph holds).
    expect(arrowNames(component)).toEqual(['api>shared:import:1', 'app>api:import:1', 'app>shared:import:1']);
    // The module-dependency view is the same level with the two kinds a module dependency is made of, and it says
    // where it stands: the module, at the depth of its own children.
    const dependencies = await buildDiagram({ type: 'module-dependency', nodes: [fx.top.id] }, reads);
    expect(dependencies.level).toBe(1);
    expect(dependencies.elements.map((element) => element.label)).toEqual(['api', 'app', 'shared']);
    expect(dependencies.title).toBe('Module dependencies: single');
  });
});

describe('the modules a module page draws beside itself', () => {
  test('a module relates to the modules of its own level its files import, and to no other', async () => {
    // `app` imports a file of `api` and a file of `shared`; its import of `other`'s file names a module of another
    // repository, which stands at no level of this one.
    const names = (ids: readonly string[]): string[] => ids.map((id) => {
      const held = [fx.app, fx.api, fx.shared, fx.top].find((module) => module.id === id);
      return held === undefined ? id : String((held.value as unknown as Record<string, unknown>)['name']);
    }).sort();
    expect(names(await moduleNeighbours(reads, fx.app, 'single'))).toEqual(['api', 'shared']);
    // `api` imports one file of `shared` and is imported by `app`: a neighbour is a neighbour whichever way the
    // import runs.
    expect(names(await moduleNeighbours(reads, fx.api, 'single'))).toEqual(['app', 'shared']);
    // `shared` imports nothing and is imported by both.
    expect(names(await moduleNeighbours(reads, fx.shared, 'single'))).toEqual(['api', 'app']);
    // The top module's level is the repository's own: it holds every module below it, so the imports of its members
    // leave it for no module of its level.
    expect(names(await moduleNeighbours(reads, fx.top, 'single'))).toEqual([]);
  });

  test('a module page draws its own child modules, and itself beside its neighbours at a depth of zero', () => {
    // The module's own children are what the component view below them draws.
    expect(diagramSpecsFor({ kind: 'module', id: fx.app.id, repositoryId: fx.single.id })[0]).toEqual({ type: 'c4-component', nodes: [fx.app.id] });
    // A module with neighbours is drawn as itself among them: a depth of zero draws the modules a view names, because
    // no child of the module's scope holds a neighbour.
    expect(diagramSpecsFor({ kind: 'module', id: fx.app.id, repositoryId: fx.single.id, moduleScopes: { view: [fx.app.id], neighbours: [fx.api.id, fx.shared.id] } })[1]).toEqual({
      type: 'module-dependency',
      nodes: [fx.app.id, fx.api.id, fx.shared.id],
      level: 0,
    });
    // A module no other module of its level relates to has its children drawn twice instead of a diagram of one box.
    expect(diagramSpecsFor({ kind: 'module', id: fx.app.id, repositoryId: fx.single.id, moduleScopes: { view: [fx.app.id], neighbours: [] } })[1]).toEqual({ type: 'module-dependency', nodes: [fx.app.id] });
  });

  test('the module among its neighbours draws them, with the imports rolled up to each module', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.app.id, fx.api.id, fx.shared.id], level: 0 }, reads);
    expect(model.elements.map((element) => element.label)).toEqual(['api', 'app', 'shared']);
    // The imports of two files inside `app` into `shared` fold into one arrow, and the import into `other`'s file is
    // no relation of this level and is not drawn.
    expect(arrowNames(model)).toEqual(['api>shared:import:1', 'app>api:import:1', 'app>shared:import:1']);
    expect(model.level).toBe(0);
    expect(model.marker).toBeNull();
  });

  test('a collapsed view at a depth of zero opens the modules it folded, not the level below them', async () => {
    const model = await buildDiagram({ type: 'module-dependency', nodes: [fx.app.id, fx.api.id, fx.shared.id], level: 0 }, reads, { limits: { nodes: 1 } });
    expect(model.elements.map((element) => element.label)).toEqual(['single']);
    expect([...(model.elements[0]!.standsFor ?? [])].sort()).toEqual([fx.api.id, fx.app.id, fx.shared.id].sort());
    expect(model.elements[0]!.drillDown?.view).toEqual({ type: 'module-dependency', nodes: [fx.api.id, fx.app.id, fx.shared.id].sort(), level: 0 });
  });
});
