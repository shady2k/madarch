/**
 * The resolution stage's pure reading and the facts it makes (madarch-tzte.21.6,
 * decision 0026's stage 4 and the schema of madarch-tzte.20.1). Every
 * expectation here is taken from the task and the schema, never from the
 * module: a fixture the test writes decides what is bound and mentioned, the
 * symbol facts a helper makes decide what a mention resolves to, and
 * `src/fill/facts.ts` decides what a fact is.
 *
 * The extraction reads tree-sitter wasm grammars, so this file needs a machine
 * with AVX2 (`madarch-sky-test --avx2`).
 */
import { describe, expect, test } from 'bun:test';
import { checkFact, makeNodeFact, repositoryPath, type Fact, type FactRange, type SymbolKind } from '../src/fill/facts.js';
import { collectFileResolution, extractFileResolution } from '../src/fill/stages/resolution-extract.js';
import { oneFactPerId, resolutionFacts, type ResolutionSymbolRow } from '../src/fill/stages/resolution-facts.js';
import { extractFileSyntax, readSyntaxTree } from '../src/fill/stages/syntax-extract.js';
import { SYNTAX_SOURCE } from '../src/fill/stages/syntax-facts.js';

const encoder = new TextEncoder();
const COMMIT = '1'.repeat(40);
const REPOSITORY = 'orders-api';

/** One file's bytes, as the reader answers them for a file the test wrote. */
function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

/** A symbol fact of the shape stage 3 publishes, so the rows a resolution reads carry real ids. */
function symbolFact(file: string, qualifiedName: string, symbolKind: SymbolKind, range: FactRange): Fact {
  return makeNodeFact({
    kind: 'symbol',
    layer: 'extracted',
    provenance: { source: SYNTAX_SOURCE, repository: { id: REPOSITORY, commit: COMMIT }, place: { file: repositoryPath(file), range } },
    value: { repository: REPOSITORY, file: repositoryPath(file), qualifiedName, symbolKind },
  });
}

/** The row a read answers for one symbol fact. */
function rowOf(fact: Fact, file: string, qualifiedName: string, symbolKind: SymbolKind, range: FactRange): ResolutionSymbolRow {
  return { id: fact.id, file: repositoryPath(file), qualifiedName, symbolKind, range };
}

/** A range from a line to a line, whole lines. */
function lines(from: number, to: number): FactRange {
  return { startLine: from, startColumn: 0, endLine: to, endColumn: 0 };
}

/** One file's resolution facts, over the symbols the test hands it. */
function factsOfFile(input: {
  readonly path: string;
  readonly text: string;
  readonly files: readonly string[];
  readonly fileSymbols: readonly ResolutionSymbolRow[];
  readonly readSymbols?: ReadonlyMap<string, readonly ResolutionSymbolRow[]>;
  readonly index?: ReadonlyMap<string, string>;
  readonly indexAnswered?: boolean;
}): Promise<ReturnType<typeof resolutionFacts>> {
  return extractFileResolution(input.path, bytesOf(input.text)).then((findings) => resolutionFacts({
    repository: REPOSITORY,
    commit: COMMIT,
    path: repositoryPath(input.path),
    findings,
    files: input.files,
    fileSymbols: input.fileSymbols,
    readSymbols: input.readSymbols ?? new Map(),
    index: input.index ?? new Map(),
    indexAnswered: input.indexAnswered ?? false,
  }));
}

/** The one fact of a kind, refused where the answer holds another number of them. */
function only(facts: readonly Fact[], kind: string): Fact {
  const held = facts.filter((fact) => fact.kind === kind);
  if (held.length !== 1) throw new Error(`the answer holds ${held.length} ${kind} facts, and this test expects one`);
  return held[0]!;
}

// ---- the bindings ----------------------------------------------------------

describe('the names a file binds from other modules', () => {
  test('a named, an aliased, a default and a namespace import are read with the names they bind', async () => {
    const found = await extractFileResolution('src/a.ts', bytesOf([
      "import { create } from './one.js';",
      "import { other as renamed } from './two.js';",
      "import helper from './three.js';",
      "import * as ns from './four.js';",
      "import 'side-effect';",
      '',
    ].join('\n')));
    expect(found.parsed).toBe(true);
    expect(found.imports.map((entry) => JSON.stringify([entry.local, entry.specifier, entry.imported]))).toEqual([
      JSON.stringify(['create', './one.js', { form: 'named', name: 'create' }]),
      JSON.stringify(['helper', './three.js', { form: 'default' }]),
      JSON.stringify(['ns', './four.js', { form: 'namespace' }]),
      JSON.stringify(['renamed', './two.js', { form: 'named', name: 'other' }]),
    ].sort());
    // The binding stands at its own name, which is where a reader looks for it.
    const create = found.imports.find((entry) => entry.local === 'create')!;
    expect(create.span).toMatchObject({ startLine: 1, startColumn: 9 });
  });

  test('a Go import binds the package the specifier names, or the name its alias writes', async () => {
    const found = await extractFileResolution('cmd/main.go', bytesOf([
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\talias "example.com/x/order"',
      ')',
      '',
    ].join('\n')));
    expect(found.imports.map((entry) => [entry.local, entry.specifier, entry.imported.form])).toEqual([
      ['alias', 'example.com/x/order', 'namespace'],
      ['fmt', 'fmt', 'namespace'],
    ]);
  });
});

// ---- the mentions ----------------------------------------------------------

describe('the places a file mentions a name', () => {
  test('a call inside a declaration is a call; the declaration\'s own name is no mention', async () => {
    const found = await extractFileResolution('src/a.ts', bytesOf([
      "import { create } from './b.js';",
      '',
      'export function run(): void {',
      '  create();',
      '}',
      '',
    ].join('\n')));
    expect(found.mentions.map((mention) => [mention.name, mention.use])).toEqual([['create', 'call']]);
  });

  test('a member access mentions the object and never the member', async () => {
    const found = await extractFileResolution('src/a.ts', bytesOf([
      "import { order } from './b.js';",
      '',
      'export function run(): number {',
      '  return order.total;',
      '}',
      '',
    ].join('\n')));
    expect(found.mentions.map((mention) => [mention.name, mention.use])).toEqual([['order', 'mention']]);
  });

  test('a namespace import makes `ns.name` one mention of the name, reached through the binding', async () => {
    const found = await extractFileResolution('src/a.ts', bytesOf([
      "import * as deep from './b.js';",
      '',
      'export function run(): void {',
      '  deep.create();',
      '}',
      '',
    ].join('\n')));
    expect(found.mentions.map((mention) => [mention.name, mention.use, mention.through])).toEqual([['create', 'call', 'deep']]);
  });

  test('an extends and an implements clause are read as such, and a type mention is a plain mention', async () => {
    const found = await extractFileResolution('src/a.ts', bytesOf([
      "import { Base, Contract, Shape } from './b.js';",
      '',
      'export class Widget<T> extends Base implements Contract {',
      '  value: Shape = null as unknown as Shape;',
      '  other: Array<Shape> = [];',
      '}',
      '',
    ].join('\n')));
    expect(found.mentions.map((mention) => [mention.name, mention.use])).toEqual([
      ['Base', 'extends'],
      ['Contract', 'implements'],
      ['Shape', 'mention'],
      ['Shape', 'mention'],
      ['Array', 'mention'],
      ['Shape', 'mention'],
    ]);
  });

  test('a name an assignment writes is a write, and one a call reads is a read', async () => {
    const found = await extractFileResolution('src/a.ts', bytesOf([
      "import { total, bump } from './b.js';",
      '',
      'export function run(): void {',
      '  total = bump();',
      '}',
      '',
    ].join('\n')));
    expect(found.mentions.map((mention) => [mention.name, mention.access])).toEqual([['total', 'write-access'], ['bump', 'read-access']]);
  });

  test('a name a parameter binds is marked, and a name a declaration binds is not', async () => {
    const found = await extractFileResolution('src/a.ts', bytesOf([
      "import { value } from './b.js';",
      '',
      'export function run(value: number): number {',
      '  return value + outer;',
      '}',
      '',
      'const outer = 1;',
      '',
    ].join('\n')));
    expect(found.mentions.map((mention) => [mention.name, mention.parameterBound])).toEqual([['value', true], ['outer', false]]);
  });

  test('a JSX element\'s name is a mention, and an attribute\'s is not', async () => {
    const found = await extractFileResolution('src/page.tsx', bytesOf([
      "import { Widget } from './widget.js';",
      '',
      'export function Page(): unknown {',
      '  return <Widget title="x" onClick={Widget} />;',
      '}',
      '',
    ].join('\n')));
    expect(found.mentions.map((mention) => [mention.name, mention.use])).toEqual([['Widget', 'mention'], ['Widget', 'mention']]);
  });

  test('a Go file mentions the packages it calls and the names of its own file', async () => {
    const found = await extractFileResolution('cmd/main.go', bytesOf([
      'package main',
      '',
      'import (',
      '\t"fmt"',
      ')',
      '',
      'func helper(n int) int { return n }',
      '',
      'func main() {',
      '\tfmt.Println(helper(1))',
      '\tshape := Shape{Width: 2}',
      '\t_ = shape.Width',
      '}',
      '',
      'type Shape struct {',
      '\tWidth int',
      '}',
      '',
    ].join('\n')));
    // The package is a name of an import this reader does not follow; `helper`,
    // `Shape` and `shape` are this file's own names; `n` is a parameter, so its
    // mention is marked and the resolver claims nothing for it; `int` is one of
    // Go's predeclared types, which names no symbol of any repository. The
    // struct's field, the keyed element's key, the blank identifier and the
    // short declaration's left side are declarations, never mentions.
    expect(found.mentions.map((mention) => [mention.name, mention.use, mention.parameterBound]).sort()).toEqual([
      ['Shape', 'mention', false],
      ['fmt', 'mention', false],
      ['helper', 'call', false],
      ['int', 'mention', false],
      ['int', 'mention', false],
      ['int', 'mention', false],
      ['n', 'mention', true],
      ['shape', 'mention', false],
    ].sort());
  });

  test('a Go qualified type names a package this reader does not follow, and no mention of its type', async () => {
    const found = await extractFileResolution('cmd/main.go', bytesOf([
      'package main',
      '',
      'import (',
      '\thttp "net/http"',
      ')',
      '',
      'var client http.Client',
      '',
    ].join('\n')));
    // Neither `http` nor `Client` is a name this resolution can tie to a symbol
    // of the repository — the first is a package's, the second a type of that
    // package — so neither is a mention, and a same-named local type is never
    // mistaken for it.
    expect(found.mentions).toEqual([]);
  });

  test('no mention stands at a name stage 3 published as a definition', async () => {
    // The two readers share one grammar: a name this reader counted as a
    // mention where stage 3 read a declaration would be an occurrence of a
    // symbol in its own declaration, which is the drift this test catches.
    const text = [
      "import { create, helper as renamed } from './b.js';",
      '',
      'export interface Shape { width: number; }',
      'export type Alias = Shape;',
      'export enum Kind { One, Two = 2 }',
      '',
      'export class Widget extends Base {',
      '  value: Shape = null as unknown as Shape;',
      '  method(arg: Shape = {} as Shape): Shape {',
      '    const inner = (): Shape => arg;',
      '    return inner();',
      '  }',
      '}',
      '',
      'export function run({ a, b: c }: Shape): void {',
      '  create(a, c);',
      '  renamed();',
      '}',
      '',
      'export default class Named { field = 1; }',
      '',
    ].join('\n');
    const definitions = (await extractFileSyntax('src/a.ts', bytesOf(text))).symbols.map((symbol) => `${symbol.definitionSpan.startLine}:${symbol.definitionSpan.startColumn}`);
    const mentions = (await extractFileResolution('src/a.ts', bytesOf(text))).mentions.map((mention) => `${mention.span.startLine}:${mention.span.startColumn}`);
    expect(definitions.length).toBeGreaterThan(0);
    expect(mentions.filter((place) => definitions.includes(place))).toEqual([]);
  });
});

// ---- what the findings become ----------------------------------------------

describe('what one file\'s findings become', () => {
  test('a call of an imported function is one call edge at precision syntactic, and one occurrence at its place', async () => {
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 5));
    const create = symbolFact('src/b.ts', 'create', 'function', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 5))],
      readSymbols: new Map([['src/b.ts', [rowOf(create, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
    });
    const call = only(answer.facts, 'call');
    expect(call.value).toEqual({ from: run.id, to: create.id, count: 1, precision: 'syntactic' });
    expect(call.provenance.place).toEqual({ file: repositoryPath('src/a.ts'), range: { startLine: 4, startColumn: 2, endLine: 4, endColumn: 8 } });
    const occurrence = only(answer.facts, 'occurrence');
    expect(occurrence.value).toEqual({ symbol: create.id, roles: ['read-access'] });
    expect(answer.resolvedMentions).toBe(1);
    expect(answer.unresolvedMentions).toBe(0);
    expect(checkFact(call)).toEqual([]);
    expect(checkFact(occurrence)).toEqual([]);
  });

  test('two call sites of one relation fold into one edge, counted, with the earliest site\'s provenance', async () => {
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 9));
    const create = symbolFact('src/b.ts', 'create', 'function', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n  create();\n  if (create) create();\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 9))],
      readSymbols: new Map([['src/b.ts', [rowOf(create, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
    });
    const call = only(answer.facts, 'call');
    expect(call.value).toEqual({ from: run.id, to: create.id, count: 3, precision: 'syntactic' });
    expect(call.provenance.place).toMatchObject({ range: { startLine: 4 } });
    // Every site keeps its own occurrence: a mention is one place, and the
    // edge is the relation the places fold into.
    expect(answer.facts.filter((fact) => fact.kind === 'occurrence').length).toBe(4);
  });

  test('a name the target file does not declare is a coverage gap naming the name and its place', async () => {
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 5));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { missing } from './b.js';\n\nexport function run(): void {\n  missing();\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 5))],
      readSymbols: new Map([['src/b.ts', []]]),
    });
    expect(answer.facts.filter((fact) => fact.kind === 'call')).toEqual([]);
    expect(answer.unresolvedMentions).toBe(1);
    expect(answer.coverage.unread.map((gap) => gap.what).some((what) => what.includes('missing at src/a.ts:4:2'))).toBe(true);
  });

  test('a mention that stands in no symbol of the file is written as unresolved, since no edge can name a caller', async () => {
    const create = symbolFact('src/b.ts', 'create', 'function', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { create } from './b.js';\n\ncreate();\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [],
      readSymbols: new Map([['src/b.ts', [rowOf(create, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
    });
    expect(answer.facts.filter((fact) => fact.kind === 'call')).toEqual([]);
    expect(answer.coverage.unread.map((gap) => gap.what).some((what) => what.includes('stands in no symbol'))).toBe(true);
  });

  test('an import of a package outside the repository is named once, in the file\'s coverage', async () => {
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 5));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { map } from 'lodash';\n\nexport function run(): void {\n  map([]);\n}\n",
      files: ['src/a.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 5))],
    });
    expect(answer.facts.filter((fact) => fact.kind === 'call')).toEqual([]);
    expect(answer.unresolvedMentions).toBe(0);
    const gaps = answer.coverage.unread.map((gap) => gap.what);
    expect(gaps.filter((what) => what.includes('lodash') && what.includes('names a package outside this repository')).length).toBe(1);
  });

  test('a compiler index resolves a name at precision compiler, and its absence is named in the coverage', async () => {
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 7));
    const create = symbolFact('src/b.ts', 'create', 'function', lines(1, 3));
    const text = "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n}\n";
    const without = await factsOfFile({
      path: 'src/a.ts',
      text,
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 7))],
      readSymbols: new Map([['src/b.ts', [rowOf(create, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
    });
    expect((only(without.facts, 'call').value as { readonly precision: string }).precision).toBe('syntactic');
    expect(without.coverage.unread.map((gap) => gap.what).some((what) => what.includes('compiler index'))).toBe(true);

    const withIndex = await factsOfFile({
      path: 'src/a.ts',
      text,
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 7))],
      readSymbols: new Map([['src/b.ts', [rowOf(create, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
      index: new Map([['4:2', create.id]]),
      indexAnswered: true,
    });
    const call = only(withIndex.facts, 'call');
    expect(call.value).toEqual({ from: run.id, to: create.id, count: 1, precision: 'compiler' });
    expect(withIndex.coverage.unread.map((gap) => gap.what).some((what) => what.includes('compiler index'))).toBe(false);
  });

  test('a relation resolved both ways keeps the compiler\'s precision and counts every site', async () => {
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 9));
    const create = symbolFact('src/b.ts', 'create', 'function', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n  create();\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 9))],
      readSymbols: new Map([['src/b.ts', [rowOf(create, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
      index: new Map([['4:2', create.id]]),
      indexAnswered: true,
    });
    expect(only(answer.facts, 'call').value).toEqual({ from: run.id, to: create.id, count: 2, precision: 'compiler' });
  });

  test('a mention a parameter binds is resolved to nothing, and to no gap either', async () => {
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 5));
    const value = symbolFact('src/b.ts', 'value', 'function', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { value } from './b.js';\n\nexport function run(value: number): number {\n  return value;\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 5))],
      readSymbols: new Map([['src/b.ts', [rowOf(value, 'src/b.ts', 'value', 'function', lines(1, 3))]]]),
    });
    expect(answer.resolvedMentions).toBe(0);
    expect(answer.unresolvedMentions).toBe(0);
    expect(answer.facts.filter((fact) => fact.kind === 'occurrence' || fact.kind === 'call')).toEqual([]);
  });

  test('a default import of an anonymous default export resolves to the file\'s `default` symbol', async () => {
    // Stage 3 names an anonymous default export `default`, and a default import
    // is the name that reaches it.
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 5));
    const fallback = symbolFact('src/b.ts', 'default', 'class', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import Widget from './b.js';\n\nexport function run(): void {\n  new Widget();\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 5))],
      readSymbols: new Map([['src/b.ts', [rowOf(fallback, 'src/b.ts', 'default', 'class', lines(1, 3))]]]),
    });
    // Constructing is a mention of the class, not a call: the schema holds no
    // constructor symbol for a syntactic reader to call.
    const reference = only(answer.facts, 'reference');
    expect(reference.value).toMatchObject({ from: run.id, to: fallback.id, precision: 'syntactic' });
  });

  test('two facts of one id are one fact, and a collision that says different things is refused', () => {
    const symbol = symbolFact('src/b.ts', 'create', 'function', lines(1, 3));
    const place = { file: repositoryPath('src/a.ts'), range: { startLine: 4, startColumn: 2, endLine: 4, endColumn: 8 } };
    const read = makeNodeFact({ kind: 'occurrence', layer: 'extracted', provenance: { source: SYNTAX_SOURCE, repository: { id: REPOSITORY, commit: COMMIT }, place }, value: { symbol: symbol.id, roles: ['read-access'] } });
    const written = makeNodeFact({ kind: 'occurrence', layer: 'extracted', provenance: { source: SYNTAX_SOURCE, repository: { id: REPOSITORY, commit: COMMIT }, place }, value: { symbol: symbol.id, roles: ['write-access'] } });
    // One place, one symbol: one occurrence, keeping the roles of both, in code
    // point order (the schema's own order for a role list).
    const merged = oneFactPerId([read, written], repositoryPath('src/a.ts'));
    expect(merged.length).toBe(1);
    expect(merged[0]!.value).toEqual({ symbol: symbol.id, roles: ['read-access', 'write-access'] });
    // Two facts of one id that say different things would lose one of them, so
    // the refusal names the file and the place of each.
    const other = symbolFact('src/b.ts', 'other', 'function', lines(5, 6));
    const elsewhere = makeNodeFact({ kind: 'occurrence', layer: 'extracted', provenance: { source: SYNTAX_SOURCE, repository: { id: REPOSITORY, commit: COMMIT }, place }, value: { symbol: other.id, roles: ['read-access'] } });
    expect(() => oneFactPerId([read, { ...elsewhere, id: read.id }], repositoryPath('src/a.ts'))).toThrow(/src\/a\.ts:4:2/);
  });

  test('a class that extends an imported type writes an inherits edge with its form', async () => {
    const widget = symbolFact('src/a.ts', 'Widget', 'class', lines(3, 5));
    const base = symbolFact('src/b.ts', 'Base', 'class', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { Base } from './b.js';\n\nexport class Widget extends Base {}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(widget, 'src/a.ts', 'Widget', 'class', lines(3, 5))],
      readSymbols: new Map([['src/b.ts', [rowOf(base, 'src/b.ts', 'Base', 'class', lines(1, 3))]]]),
    });
    expect(only(answer.facts, 'inherits').value).toEqual({ from: widget.id, to: base.id, form: 'extends', precision: 'syntactic' });
  });


  test('a bare mention of a namespace binding names no symbol and is out of the claim', async () => {
    // `ns` is a module, and the schema holds no symbol for a module: a use of it
    // on its own is neither an edge to the target's default export nor a gap.
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 5));
    const fallback = symbolFact('src/b.ts', 'default', 'class', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import * as deep from './b.js';\n\nexport function run(): unknown {\n  return deep;\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 5))],
      readSymbols: new Map([['src/b.ts', [rowOf(fallback, 'src/b.ts', 'default', 'class', lines(1, 3))]]]),
    });
    expect(answer.facts.filter((fact) => fact.kind === 'reference' || fact.kind === 'call' || fact.kind === 'occurrence')).toEqual([]);
    expect(answer.unresolvedMentions).toBe(0);
    expect(answer.coverage.unread.map((gap) => gap.what).filter((what) => what.includes('deep at'))).toEqual([]);
  });

  test('a compiler index answers a mention a parameter binds, which the syntax alone cannot', async () => {
    // The parameter `create` shadows the import, so the syntactic resolution
    // claims nothing for this mention; the index names it, and its answer stands.
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 5));
    const create = symbolFact('src/b.ts', 'create', 'function', lines(1, 3));
    const text = "import { create } from './b.js';\n\nexport function run(create: () => void): void {\n  create();\n}\n";
    const findings = await extractFileResolution('src/a.ts', bytesOf(text));
    expect(findings.mentions.map((mention) => [mention.name, mention.parameterBound])).toEqual([['create', true]]);
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text,
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 5))],
      readSymbols: new Map([['src/b.ts', [rowOf(create, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
      index: new Map([['4:2', create.id]]),
      indexAnswered: true,
    });
    const call = only(answer.facts, 'call');
    expect(call.value).toMatchObject({ from: run.id, to: create.id, precision: 'compiler' });
    // Without the index the same mention is out of claim: no edge and no gap.
    const alone = await factsOfFile({
      path: 'src/a.ts',
      text,
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 5))],
      readSymbols: new Map([['src/b.ts', [rowOf(create, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
    });
    expect(alone.facts.filter((fact) => fact.kind === 'call')).toEqual([]);
    expect(alone.unresolvedMentions).toBe(0);
  });

  test('a declaration of a lexical scope binds a name; a class member never does', async () => {
    const widget = symbolFact('src/a.ts', 'Widget', 'class', lines(1, 9));
    const method = symbolFact('src/a.ts', 'Widget.total', 'method', lines(2, 4));
    const sum = symbolFact('src/a.ts', 'Widget.sum', 'method', lines(5, 7));
    const total = symbolFact('src/a.ts', 'total', 'function', lines(10, 12));
    const rows = [
      rowOf(widget, 'src/a.ts', 'Widget', 'class', lines(1, 9)),
      rowOf(method, 'src/a.ts', 'Widget.total', 'method', lines(2, 4)),
      rowOf(sum, 'src/a.ts', 'Widget.sum', 'method', lines(5, 7)),
      rowOf(total, 'src/a.ts', 'total', 'function', lines(10, 12)),
    ];
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: [
        'export class Widget {',
        '  total(): number {',
        '    return 2;',
        '  }',
        '  sum(): number {',
        '    return total();',
        '  }',
        '}',
        '',
        'export function total(): number {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
      files: ['src/a.ts'],
      fileSymbols: rows,
    });
    // A bare name inside a method body reaches no member of its class: `total()`
    // there is the file's own function, and an edge to `Widget.total` would be a
    // call nothing makes.
    const call = only(answer.facts, 'call');
    expect(call.value).toMatchObject({ from: sum.id, to: total.id });
    expect(answer.facts.filter((fact) => fact.kind === 'occurrence').map((fact) => (fact.value as { readonly symbol: string }).symbol)).toEqual([total.id]);
  });

  test('a declaration of the same lexical scope binds a name from its own line on, and one of another function never', async () => {
    const outer = symbolFact('src/a.ts', 'outer', 'function', lines(1, 4));
    const inner = symbolFact('src/a.ts', 'outer.helper', 'function', lines(2, 3));
    const other = symbolFact('src/a.ts', 'other', 'function', lines(6, 8));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: [
        'export function outer(): void {',
        '  const helper = (): void => {};',
        '  helper();',
        '}',
        '',
        'export function other(): void {',
        '  helper();',
        '}',
        '',
      ].join('\n'),
      files: ['src/a.ts'],
      fileSymbols: [
        rowOf(outer, 'src/a.ts', 'outer', 'function', lines(1, 4)),
        rowOf(inner, 'src/a.ts', 'outer.helper', 'function', lines(2, 3)),
        rowOf(other, 'src/a.ts', 'other', 'function', lines(6, 8)),
      ],
    });
    // The mention inside `outer` binds `outer`'s own declaration; the mention of
    // the same name inside `other` reaches nothing `outer` declares, and it is no
    // reference of this repository at all — neither an edge nor a gap.
    const calls = answer.facts.filter((fact) => fact.kind === 'call');
    expect(calls.length).toBe(1);
    expect(calls[0]!.value).toMatchObject({ from: outer.id, to: inner.id });
    expect(answer.coverage.unread.map((gap) => gap.what).filter((what) => what.includes('helper at src/a.ts:7'))).toEqual([]);
  });

  test('a declaration inside a constructor body is in a lexical scope too', async () => {
    const widget = symbolFact('src/a.ts', 'Widget', 'class', lines(3, 8));
    const ctor = symbolFact('src/a.ts', 'Widget.constructor', 'constructor', lines(4, 7));
    const local = symbolFact('src/a.ts', 'Widget.constructor.create', 'function', lines(5, 6));
    const imported = symbolFact('src/b.ts', 'create', 'function', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { create } from './b.js';\n\nexport class Widget {\n  constructor() {\n    const create = (): void => {};\n    create();\n  }\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [
        rowOf(widget, 'src/a.ts', 'Widget', 'class', lines(3, 9)),
        rowOf(ctor, 'src/a.ts', 'Widget.constructor', 'constructor', lines(4, 8)),
        rowOf(local, 'src/a.ts', 'Widget.constructor.create', 'function', lines(5, 6)),
      ],
      readSymbols: new Map([['src/b.ts', [rowOf(imported, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
    });
    expect(only(answer.facts, 'call').value).toMatchObject({ from: ctor.id, to: local.id });
  });

  test('a declaration written after the mention still binds it where the language hoists one', async () => {
    // A hoisted declaration wins over an import of the same name: the file's own
    // `create` is what `create()` calls, whatever the module also imports.
    const run = symbolFact('src/a.ts', 'run', 'function', lines(1, 4));
    const create = symbolFact('src/a.ts', 'run.create', 'function', lines(3, 4));
    const imported = symbolFact('src/b.ts', 'create', 'function', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n  function create(): void {}\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [
        rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 6)),
        rowOf(create, 'src/a.ts', 'run.create', 'function', lines(5, 6)),
      ],
      readSymbols: new Map([['src/b.ts', [rowOf(imported, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
    });
    expect(only(answer.facts, 'call').value).toMatchObject({ from: run.id, to: create.id });
  });

  test('a declaration of the file shadows an import of the same name, and a top-level one is found from anywhere', async () => {
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 5));
    const inner = symbolFact('src/a.ts', 'run.create', 'function', lines(4, 5));
    const imported = symbolFact('src/b.ts', 'create', 'function', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { create } from './b.js';\n\nexport function run(): void {\n  const create = (): void => {};\n  create();\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 6)), rowOf(inner, 'src/a.ts', 'run.create', 'function', lines(4, 5))],
      readSymbols: new Map([['src/b.ts', [rowOf(imported, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
    });
    const call = only(answer.facts, 'call');
    expect(call.value).toMatchObject({ from: run.id, to: inner.id });
    // A top-level declaration is found from a mention that no declaration holds:
    // the file's own function is called before it is written.
    const first = symbolFact('src/a.ts', 'first', 'function', lines(1, 3));
    const later = symbolFact('src/a.ts', 'later', 'function', lines(5, 5));
    const hoisted = await factsOfFile({
      path: 'src/a.ts',
      text: 'export function first(): void {\n  later();\n}\n\nexport function later(): void {}\n',
      files: ['src/a.ts'],
      fileSymbols: [
        rowOf(first, 'src/a.ts', 'first', 'function', lines(1, 3)),
        rowOf(later, 'src/a.ts', 'later', 'function', lines(5, 5)),
      ],
    });
    expect(only(hoisted.facts, 'call').value).toMatchObject({ from: first.id, to: later.id });
  });

  test('a declaration of an enclosing scope that stands after the mention still binds it there', async () => {
    // The mention stands in an arrow inside `outer`, and `outer`'s own `helper`
    // is declared after it: the language gives that declaration `outer`'s whole
    // scope, so the mention is `outer.helper` and never the import of the name.
    const outer = symbolFact('src/a.ts', 'outer', 'function', lines(3, 6));
    const inner = symbolFact('src/a.ts', 'outer.inner', 'function', lines(4, 4));
    const helper = symbolFact('src/a.ts', 'outer.helper', 'function', lines(5, 5));
    const imported = symbolFact('src/b.ts', 'helper', 'function', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { helper } from './b.js';\n\nexport function outer(): void {\n  const inner = (): void => helper();\n  function helper(): void {}\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [
        rowOf(outer, 'src/a.ts', 'outer', 'function', lines(3, 7)),
        rowOf(inner, 'src/a.ts', 'outer.inner', 'function', lines(4, 5)),
        rowOf(helper, 'src/a.ts', 'outer.helper', 'function', lines(5, 6)),
      ],
      readSymbols: new Map([['src/b.ts', [rowOf(imported, 'src/b.ts', 'helper', 'function', lines(1, 3))]]]),
    });
    expect(only(answer.facts, 'call').value).toMatchObject({ from: inner.id, to: helper.id });
  });

  test('a relative specifier that names no file of the repository is a gap at each use, with its place', async () => {
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 5));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { create } from './missing.js';\n\nexport function run(): void {\n  create();\n}\n",
      files: ['src/a.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 5))],
    });
    expect(answer.facts.filter((fact) => fact.kind === 'call')).toEqual([]);
    expect(answer.unresolvedMentions).toBe(1);
    const gaps = answer.coverage.unread.map((gap) => gap.what);
    expect(gaps.some((what) => what.includes('create at src/a.ts:4:2') && what.includes('./missing.js'))).toBe(true);
    // The import itself is named once too, so a specifier that names no file and
    // no name of which is ever used is still no silence.
    expect(gaps.filter((what) => what.includes('imports "./missing.js"') && what.includes('names no file of this repository'))).toHaveLength(1);
  });

  test('the coverage names the file and the files whose symbols the resolution read', async () => {
    const run = symbolFact('src/a.ts', 'run', 'function', lines(3, 5));
    const create = symbolFact('src/b.ts', 'create', 'function', lines(1, 3));
    const answer = await factsOfFile({
      path: 'src/a.ts',
      text: "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n}\n",
      files: ['src/a.ts', 'src/b.ts'],
      fileSymbols: [rowOf(run, 'src/a.ts', 'run', 'function', lines(3, 5))],
      readSymbols: new Map([['src/b.ts', [rowOf(create, 'src/b.ts', 'create', 'function', lines(1, 3))]]]),
    });
    expect(answer.coverage.read).toEqual(['src/a.ts', 'src/b.ts']);
    expect(answer.coverage.repository).toBe(REPOSITORY);
    expect(answer.coverage.scope).toBe('src/a.ts');
    // The facts are in code point order of kind and id, and the coverage is one
    // of them, so two runs answer the same set in the same order.
    const keys = answer.facts.map((fact) => `${fact.kind}\u0000${fact.id}`);
    expect([...keys].sort()).toEqual(keys);
  });

  test('a file with no grammar is read as one gap, and the facts it makes are its coverage alone', async () => {
    const answer = await factsOfFile({ path: 'scripts/run.py', text: 'print("hello")\n', files: ['scripts/run.py'], fileSymbols: [] });
    expect(answer.facts.filter((fact) => fact.kind === 'coverage').length).toBe(1);
    expect(answer.coverage).toEqual({
      repository: REPOSITORY,
      scope: 'scripts/run.py',
      complete: false,
      read: [],
      unread: [{ what: 'scripts/run.py', reason: 'unsupported' }],
    });
  });
});

describe('the pure reading shares one parse with the syntax stage', () => {
  test('the walk reads the same tree the syntax stage reads, and answers what the file binds and mentions', async () => {
    const text = "import { create } from './b.js';\n\nexport function run(): void {\n  create();\n}\n";
    const parsed = await readSyntaxTree('src/a.ts', bytesOf(text), (file) => collectFileResolution(file));
    expect(parsed.read).toBe(true);
    if (!parsed.read) return;
    expect(parsed.value.imports.map((entry) => entry.local)).toEqual(['create']);
    expect(parsed.value.mentions.map((mention) => mention.name)).toEqual(['create']);
    expect(parsed.complete).toBe(true);
  });
});
