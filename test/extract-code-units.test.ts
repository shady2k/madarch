/**
 * The code-structure extractor on small repositories written in the test
 * (madarch-o0eq.6): the rules the training repository exercises only in
 * passing -- member calls through a typed field, a Go interface satisfied by
 * its method set, package-qualified names, dead exports, cycles, the test
 * catalogue's skip reasons and table sizes -- and the failures that must be
 * gaps. Expected values are the facts of the sources written here.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { extractCode } from '../src/extract/code/index.js';
import { cycles } from '../src/extract/code/graph.js';
import { goImportFolder } from '../src/extract/code/program.js';
import { fileKey, moduleKey, packageKey, symbolKey } from '../src/extract/code/keys.js';
import type { ExtractedEdge, ExtractedNode, TreeReader } from '../src/extract/records.js';

function treeOf(files: Record<string, string>): TreeReader {
  const paths = Object.keys(files).sort();
  const encoder = new TextEncoder();
  return {
    paths,
    read(path: string): Uint8Array {
      const text = files[path];
      if (text === undefined) throw new Error(`no such path in the tree: ${path}`);
      return encoder.encode(text);
    },
  };
}

function edgesOf(edges: readonly ExtractedEdge[], type: string, from?: string, to?: string): ExtractedEdge[] {
  return edges.filter((e) => e.type === type && (from === undefined || e.from === from) && (to === undefined || e.to === to));
}

function nodeOf(nodes: readonly ExtractedNode[], key: string): ExtractedNode {
  const found = nodes.find((n) => n.key === key);
  if (found === undefined) throw new Error(`no node ${key}; the extraction holds ${nodes.map((n) => n.key).join(', ')}`);
  return found;
}

describe('cycles (strongly connected components)', () => {
  const graph = (pairs: [string, string][]): Map<string, Set<string>> => {
    const edges = new Map<string, Set<string>>();
    for (const [from, to] of pairs) edges.set(from, (edges.get(from) ?? new Set()).add(to));
    return edges;
  };

  test('a three-node ring is one cycle, a self import is none, and a chain into the ring is not part of it', () => {
    const edges = graph([['a', 'b'], ['b', 'c'], ['c', 'a'], ['d', 'd'], ['e', 'a']]);
    expect(cycles(['a', 'b', 'c', 'd', 'e'], edges)).toEqual([['a', 'b', 'c']]);
  });

  test('two separate cycles come out in code point order of their first member', () => {
    const edges = graph([['y', 'z'], ['z', 'y'], ['b', 'a'], ['a', 'b']]);
    expect(cycles(['a', 'b', 'y', 'z'], edges)).toEqual([['a', 'b'], ['y', 'z']]);
  });

  test('a chain of fifty thousand nodes does not exhaust the stack, and closing it makes one cycle', () => {
    const names = Array.from({ length: 50_000 }, (_, i) => `n${String(i).padStart(6, '0')}`);
    const edges = new Map<string, Set<string>>();
    for (let i = 0; i < names.length - 1; i++) edges.set(names[i]!, new Set([names[i + 1]!]));
    expect(cycles(names, edges)).toEqual([]);
    edges.set(names[names.length - 1]!, new Set([names[0]!]));
    const found = cycles(names, edges);
    expect(found.length).toBe(1);
    expect(found[0]!.length).toBe(50_000);
  });
});

describe('goImportFolder', () => {
  const modules = [
    { folder: 'services/a', module: 'alpha' },
    { folder: 'services/a/tools', module: 'alpha/tools' },
  ];
  const folders = new Set(['services/a', 'services/a/store', 'services/a/tools', 'services/a/tools/gen']);

  test('the longest module that prefixes the import wins, and the folder must exist', () => {
    expect(goImportFolder('alpha/store', modules, folders)).toBe('services/a/store');
    expect(goImportFolder('alpha/tools/gen', modules, folders)).toBe('services/a/tools/gen');
    expect(goImportFolder('alpha', modules, folders)).toBe('services/a');
    expect(goImportFolder('alpha/missing', modules, folders)).toBeUndefined();
    expect(goImportFolder('alphabet/store', modules, folders)).toBeUndefined();
    expect(goImportFolder('fmt', modules, folders)).toBeUndefined();
  });
});

describe('a TypeScript repository', () => {
  const tree = treeOf({
    'package.json': JSON.stringify({ name: 'shop', devDependencies: { jest: '29.0.0' } }),
    'src/store.ts': [
      'export interface Store { save(value: string): void }',
      'export class MemoryStore implements Store { save(value: string): void {} }',
      'export function unusedHelper(): number { return 1; }',
      'export const used = 1;',
      '',
    ].join('\n'),
    'src/service.ts': [
      "import { Store, used } from './store';",
      'export class Service {',
      '  constructor(private readonly store: Store) {}',
      '  run(): void { this.store.save(String(used)); }',
      '}',
      '',
    ].join('\n'),
    'src/main.ts': [
      "import { Service } from './service';",
      "import { MemoryStore } from './store';",
      'const service = new Service(new MemoryStore());',
      'service.run();',
      '',
    ].join('\n'),
    'test/service.test.ts': [
      "import { Service } from '../src/service';",
      "describe('Service', () => {",
      "  it('runs', () => {",
      '    new Service(null as any).run();',
      '  });',
      "  it.each([1, 2, 3])('runs %p', () => {});",
      "  it.skip('later', () => {",
      '    // waits for the vault',
      '  });',
      '});',
      '',
    ].join('\n'),
  });
  let nodes: readonly ExtractedNode[];
  let edges: readonly ExtractedEdge[];
  let gapCount: number;

  beforeAll(async () => {
    const result = await extractCode(tree);
    nodes = result.nodes;
    edges = result.edges;
    gapCount = result.gaps.length;
    expect(gapCount).toBe(0);
  });

  test('a call through a constructor-property field reaches the interface method and, marked, its implementation', () => {
    const run = symbolKey('src/service.ts', 'Service.run');
    const direct = edgesOf(edges, 'code.calls', run, symbolKey('src/store.ts', 'Store.save'));
    expect(direct.length).toBe(1);
    expect(direct[0]!.properties['via']).toBeUndefined();
    const fanned = edgesOf(edges, 'code.calls', run, symbolKey('src/store.ts', 'MemoryStore.save'));
    expect(fanned.length).toBe(1);
    expect(fanned[0]!.properties['via']).toBe('interface');
    expect(edgesOf(edges, 'code.implements', symbolKey('src/store.ts', 'MemoryStore'), symbolKey('src/store.ts', 'Store'))[0]!.properties['form']).toBe('declared');
  });

  test('a call from a statement at the top of a file is the file\'s own', () => {
    const calls = edgesOf(edges, 'code.calls', fileKey('src/main.ts'), symbolKey('src/service.ts', 'Service.run'));
    expect(calls.length).toBe(1);
    expect(calls[0]!.span?.path).toBe('src/main.ts');
  });

  test('an export no one references is dead; one that is imported and used, and an unexported name, are not', () => {
    expect(nodeOf(nodes, symbolKey('src/store.ts', 'unusedHelper')).properties['deadExport']).toBe(true);
    expect(nodeOf(nodes, symbolKey('src/store.ts', 'used')).properties['deadExport']).toBe(false);
    expect(nodeOf(nodes, symbolKey('src/service.ts', 'Service')).properties['deadExport']).toBe(false);
  });

  test('the test catalogue: three cases of one suite, a table of three, a skip with its comment as the reason, jest from the package', () => {
    const cases = nodes.filter((n) => n.kind === 'code.test-case');
    expect(cases.map((c) => c.properties['name']).sort()).toEqual(['later', 'runs', 'runs %p']);
    const byName = new Map(cases.map((c) => [c.properties['name'] as string, c]));
    expect(byName.get('runs')!.properties['testKind']).toBe('unit');
    expect(byName.get('runs %p')!.properties['testKind']).toBe('table-driven');
    expect(byName.get('runs %p')!.properties['cases']).toBe(3);
    expect(byName.get('later')!.properties['skipped']).toBe(true);
    expect(byName.get('later')!.properties['skipReason']).toBe('waits for the vault');
    for (const c of cases) {
      expect(c.properties['suite']).toEqual(['Service']);
      expect(c.properties['framework']).toBe('jest');
    }
    const subjects = edgesOf(edges, 'code.tests', byName.get('runs')!.key).map((e) => e.to);
    expect(subjects).toContain(symbolKey('src/service.ts', 'Service.run'));
    expect(subjects).toContain(symbolKey('src/service.ts', 'Service'));
    expect(edgesOf(edges, 'code.tests', byName.get('later')!.key)).toEqual([]);
  });

  test('the package holds its tests and the src folder is a module of it', () => {
    const pkg = nodeOf(nodes, packageKey(''));
    expect(pkg.properties['testFiles']).toBe(1);
    expect(pkg.properties['hasTests']).toBe(true);
    expect(edgesOf(edges, 'code.contains', packageKey(''), moduleKey('src')).length).toBe(1);
    expect(edgesOf(edges, 'code.depends-on', moduleKey('src')).length).toBe(0);
  });
});

describe('a Go repository', () => {
  const tree = treeOf({
    'go.mod': 'module app\n\ngo 1.22\n',
    'store/store.go': [
      'package store',
      '',
      'type Repo struct{ n int }',
      '',
      'func New() *Repo { return &Repo{} }',
      '',
      'func (r *Repo) Save(id string) error { return nil }',
      '',
      'func (r *Repo) Close() {}',
      '',
      'func Unused() {}',
      '',
    ].join('\n'),
    'app/service.go': [
      'package app',
      '',
      'type Saver interface{ Save(id string) error }',
      '',
      'type Service struct{ saver Saver }',
      '',
      'func NewService(s Saver) *Service { return &Service{saver: s} }',
      '',
      'func (s *Service) Do() error { return s.saver.Save("x") }',
      '',
    ].join('\n'),
    'cmd/main.go': [
      'package main',
      '',
      'import (',
      '\t"app/app"',
      '\t"app/store"',
      ')',
      '',
      'func main() {',
      '\trepo := store.New()',
      '\tsvc := app.NewService(repo)',
      '\t_ = svc.Do()',
      '\tdefer repo.Close()',
      '}',
      '',
    ].join('\n'),
    'app/service_test.go': [
      'package app',
      '',
      'import "testing"',
      '',
      'func TestDo(t *testing.T) {',
      '\tt.Skip("needs a database")',
      '}',
      '',
      'func TestTable(t *testing.T) {',
      '\tcases := []struct{ name string }{{"a"}, {"b"}}',
      '\tfor _, c := range cases {',
      '\t\t_ = NewService(nil)',
      '\t\t_ = c',
      '\t}',
      '}',
      '',
    ].join('\n'),
  });
  let nodes: readonly ExtractedNode[];
  let edges: readonly ExtractedEdge[];

  beforeAll(async () => {
    const result = await extractCode(tree);
    nodes = result.nodes;
    edges = result.edges;
    expect(result.gaps).toEqual([]);
  });

  test('main reaches package functions by their package, and methods through the types the constructors return', () => {
    const main = symbolKey('cmd/main.go', 'main');
    expect(edgesOf(edges, 'code.calls', main, symbolKey('store/store.go', 'New')).length).toBe(1);
    expect(edgesOf(edges, 'code.calls', main, symbolKey('app/service.go', 'NewService')).length).toBe(1);
    expect(edgesOf(edges, 'code.calls', main, symbolKey('app/service.go', 'Service.Do')).length).toBe(1);
    expect(edgesOf(edges, 'code.calls', main, symbolKey('store/store.go', 'Repo.Close')).length).toBe(1);
  });

  test('a type satisfies an interface by its method set: an inferred, structural implementation, and the call fans out to it', () => {
    const implements_ = edgesOf(edges, 'code.implements', symbolKey('store/store.go', 'Repo'), symbolKey('app/service.go', 'Saver'));
    expect(implements_.length).toBe(1);
    expect(implements_[0]!.properties).toEqual({ form: 'structural', inferred: true });
    const fanned = edgesOf(edges, 'code.calls', symbolKey('app/service.go', 'Service.Do'), symbolKey('store/store.go', 'Repo.Save'));
    expect(fanned[0]!.properties['via']).toBe('interface');
    expect(edgesOf(edges, 'code.calls', symbolKey('app/service.go', 'Service.Do'), symbolKey('app/service.go', 'Saver.Save')).length).toBe(1);
  });

  test('modules are the Go packages, the dependencies run from main to what it imports, and the root go.mod is the package', () => {
    expect(nodeOf(nodes, moduleKey('store')).properties['packageName']).toBe('store');
    expect(nodeOf(nodes, moduleKey('cmd')).properties['packageName']).toBe('main');
    expect(edgesOf(edges, 'code.depends-on', moduleKey('cmd')).map((e) => e.to).sort()).toEqual([moduleKey('app'), moduleKey('store')]);
    expect(edgesOf(edges, 'code.depends-on', moduleKey('app')).length).toBe(0);
    expect(nodeOf(nodes, packageKey('')).properties['name']).toBe('app');
    expect(nodes.filter((n) => n.kind === 'code.cycle')).toEqual([]);
  });

  test('an exported function nothing refers to is dead; a used one and a method are not marked', () => {
    expect(nodeOf(nodes, symbolKey('store/store.go', 'Unused')).properties['deadExport']).toBe(true);
    expect(nodeOf(nodes, symbolKey('store/store.go', 'New')).properties['deadExport']).toBe(false);
    expect(nodeOf(nodes, symbolKey('store/store.go', 'Repo.Save')).properties['deadExport']).toBeUndefined();
    expect(nodeOf(nodes, symbolKey('cmd/main.go', 'main')).properties['entryPoint']).toBe('main');
  });

  test('Go tests: t.Skip gives the reason, a slice of anonymous structs is a table with its rows counted', () => {
    const cases = new Map(nodes.filter((n) => n.kind === 'code.test-case').map((n) => [n.properties['name'] as string, n]));
    expect([...cases.keys()].sort()).toEqual(['TestDo', 'TestTable']);
    expect(cases.get('TestDo')!.properties['skipped']).toBe(true);
    expect(cases.get('TestDo')!.properties['skipReason']).toBe('needs a database');
    expect(cases.get('TestTable')!.properties['testKind']).toBe('table-driven');
    expect(cases.get('TestTable')!.properties['cases']).toBe(2);
    expect(cases.get('TestTable')!.properties['framework']).toBe('go-test');
    expect(edgesOf(edges, 'code.tests', cases.get('TestTable')!.key).map((e) => e.to)).toContain(symbolKey('app/service.go', 'NewService'));
  });
});

describe('what cannot be read is a gap', () => {
  test('a manifest that is not JSON, a go.mod with no module, a file of bytes that are not text and a file that fails to read', async () => {
    const files: Record<string, string> = {
      'a/package.json': '{ not json',
      'b/go.mod': 'go 1.22\n',
      'c/ok.ts': 'export const fine = 1;\n',
    };
    const base = treeOf(files);
    const reader: TreeReader = {
      paths: [...base.paths, 'c/bad.ts', 'c/broken.go'].sort(),
      read(path) {
        if (path === 'c/bad.ts') return new Uint8Array([0xc3, 0x28, 0xff]);
        if (path === 'c/broken.go') throw new Error('permission denied');
        return base.read(path);
      },
    };
    const result = await extractCode(reader);
    const byPath = new Map(result.gaps.map((g) => [g.path, g.reason]));
    expect(byPath.get('a/package.json')).toContain('not JSON');
    expect(byPath.get('b/go.mod')).toContain('names no module');
    expect(byPath.get('c/bad.ts')).toContain('not parsed');
    expect(byPath.get('c/broken.go')).toContain('permission denied');
    expect(nodeOf(result.nodes, fileKey('c/ok.ts')).properties['parsed']).toBe(true);
    expect(nodeOf(result.nodes, fileKey('c/bad.ts')).properties['parsed']).toBe(false);
  });

  test('a tree with no source file is an empty extraction, not an error', async () => {
    const result = await extractCode(treeOf({ 'README.md': '# nothing to read\n' }));
    expect(result).toEqual({ producer: 'code.extract.code', nodes: [], edges: [], gaps: [] });
  });
});
