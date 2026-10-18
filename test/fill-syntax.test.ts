/**
 * The syntax stage's pure extraction and the facts it makes (madarch-tzte.21.3,
 * decisions 0026 and 0020.1's schema). Every expectation here is taken from the
 * task and the schema, never from the module: a fixture the test writes decides
 * what is found, `src/fill/facts.ts` decides what a fact is, and the ids are
 * read back as digests of what each fact is about.
 *
 * The extraction reads tree-sitter wasm grammars, so this file needs a machine
 * with AVX2 (`madarch-sky-test --avx2`).
 */
import { describe, expect, test } from 'bun:test';
import { checkFact, makeNodeFact, repositoryPath, type Fact } from '../src/fill/facts.js';
import { extractFileSyntax, syntaxLanguageOf } from '../src/fill/stages/syntax-extract.js';
import { languageFor, rolesFor } from '../src/fill/stages/inventory.js';
import { resolveSpecifier, syntaxFacts } from '../src/fill/stages/syntax-facts.js';

const encoder = new TextEncoder();

/** One file's bytes, as the reader answers them for a file the test wrote. */
function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

/** The two exported functions and the one import the task names as the stage's normal case. */
const NORMAL_CASE = [
  "import { helper } from './helper.js';",
  '',
  'export function first(value: number): number {',
  '  return helper(value);',
  '}',
  '',
  'export function second(): void {}',
  '',
].join('\n');

describe('the language a path is read as', () => {
  test('each grammar reads its own extensions, and a language with no grammar has none', () => {
    expect(syntaxLanguageOf('src/orders.ts')).toBe('typescript');
    expect(syntaxLanguageOf('src/orders.mts')).toBe('typescript');
    expect(syntaxLanguageOf('src/orders.cts')).toBe('typescript');
    expect(syntaxLanguageOf('src/view.tsx')).toBe('tsx');
    expect(syntaxLanguageOf('src/view.jsx')).toBe('javascript');
    expect(syntaxLanguageOf('src/view.mjs')).toBe('javascript');
    expect(syntaxLanguageOf('cmd/server/main.go')).toBe('go');
    // A language no grammar of this stage reads is no language here: the file
    // is reported as an unread gap, never dropped in silence.
    expect(syntaxLanguageOf('tools/script.py')).toBeUndefined();
    expect(syntaxLanguageOf('Makefile')).toBeUndefined();
    expect(syntaxLanguageOf('docs/guide.md')).toBeUndefined();
  });
});

describe('the extraction\'s language table and the inventory stage agree', () => {
  test('every extension this stage parses is a source path the inventory names, with the same language', () => {
    // Two modules name the same four grammars: the extraction keeps its own
    // table so it depends on nothing but the schema, and the stage asks the
    // inventory which paths are source. This is where the two can disagree.
    for (const extension of ['.cjs', '.cts', '.go', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']) {
      const path = `src/file${extension}`;
      expect(rolesFor(path)).toContain('source');
      expect(languageFor(path)).toBe(syntaxLanguageOf(path));
    }
    // And the other way round: code the inventory names that no grammar of this
    // stage reads is planned and published as a coverage gap, not dropped.
    for (const extension of ['.py', '.rs', '.sh']) {
      expect(rolesFor(`src/file${extension}`)).toContain('source');
      expect(syntaxLanguageOf(`src/file${extension}`)).toBeUndefined();
    }
  });
});

describe('the pure per-file extraction', () => {
  test('the same bytes at the same path answer the same findings', async () => {
    const once = await extractFileSyntax('src/orders.ts', bytesOf(NORMAL_CASE));
    const twice = await extractFileSyntax('src/orders.ts', bytesOf(NORMAL_CASE));
    expect(twice).toEqual(once);
  });

  test('a fixture with two exported functions and one import yields exactly those two symbols and that import', async () => {
    const found = await extractFileSyntax('src/orders.ts', bytesOf(NORMAL_CASE));
    expect(found.parsed).toBe(true);
    expect(found.language).toBe('typescript');
    expect(found.symbols.map((symbol) => [symbol.name, symbol.qualifiedName, symbol.symbolKind]))
      .toEqual([['first', 'first', 'function'], ['second', 'second', 'function']]);
    expect(found.imports.map((entry) => entry.specifier)).toEqual(['./helper.js']);
    expect(found.unread).toEqual([]);
    // `export function first` puts the name at column 16 of line 3, five characters long.
    const first = found.symbols[0]!;
    expect([first.definitionSpan.startLine, first.definitionSpan.startColumn, first.definitionSpan.endColumn])
      .toEqual([3, 16, 21]);
    // The declaration's own span is the `function` the `export` carries: the
    // `export` itself is its parent statement, not part of the declaration.
    expect([first.span.startLine, first.span.startColumn]).toEqual([3, 7]);
    // The specifier's span is the literal as written, quotes included: it starts
    // after `import { helper } from ` and is 13 characters long.
    expect(NORMAL_CASE.indexOf("'./helper.js'")).toBe(23);
    expect(found.imports[0]!.span.startByte).toBe(23);
    expect(found.imports[0]!.span.endByte).toBe(36);
    expect(found.imports[0]!.span.startColumn).toBe(23);
  });

  test('a byte span counts the file\'s bytes and a column counts UTF-16 code units', async () => {
    // The emoji is four bytes and two UTF-16 code units: a span after it differs
    // between the two counts, which is why the extraction answers both.
    const text = '// \u{1F600} note\nexport const answer = 42;\n';
    const found = await extractFileSyntax('src/answer.ts', bytesOf(text));
    expect(found.comments.map((comment) => [comment.form, comment.text])).toEqual([['line', '\u{1F600} note']]);
    const answer = found.symbols[0]!;
    expect(answer.name).toBe('answer');
    expect(answer.symbolKind).toBe('constant');
    expect([answer.definitionSpan.startLine, answer.definitionSpan.startColumn]).toEqual([2, 13]);
    expect([answer.definitionSpan.startByte, answer.definitionSpan.endByte]).toEqual([26, 32]);
  });

  test('a comment is read with its form and without its markers, as written', async () => {
    const text = [
      '/** Documented. */',
      'export function documented(): void {}',
      '',
      '/* a block',
      '   comment */',
      'function plain(): void {}',
      '',
      '// a line comment',
      'export const value = 1;',
      '',
    ].join('\n');
    const found = await extractFileSyntax('src/comments.ts', bytesOf(text));
    expect(found.comments.map((comment) => [comment.form, comment.text])).toEqual([
      ['doc', 'Documented.'],
      ['block', 'a block\ncomment'],
      ['line', 'a line comment'],
    ]);
  });

  test('every declaration this stage reads becomes a symbol, and a nested one is qualified by its container', async () => {
    const text = [
      'export interface Order {',
      '  id: string;',
      '}',
      '',
      'export class OrderService {',
      '  private orders: Order[] = [];',
      '  static create(): OrderService { return new OrderService(); }',
      '  async place(id: string): Promise<void> {}',
      '}',
      '',
      'export type Id = string;',
      'export enum State { Open, Closed }',
      'export namespace Domain {',
      '  export function reset(): void {}',
      '}',
      'export const limits = { max: 3 };',
      'export let counter = 0;',
      'export const handler = (id: string) => id;',
      '',
    ].join('\n');
    const found = await extractFileSyntax('src/model.ts', bytesOf(text));
    expect(found.symbols.map((symbol) => [symbol.qualifiedName, symbol.symbolKind])).toEqual([
      ['Domain', 'namespace'],
      ['Domain.reset', 'function'],
      ['Id', 'type-alias'],
      ['Order', 'interface'],
      ['Order.id', 'property'],
      ['OrderService', 'class'],
      ['OrderService.create', 'method'],
      ['OrderService.orders', 'field'],
      ['OrderService.place', 'method'],
      ['State', 'enum'],
      ['State.Closed', 'enum-member'],
      ['State.Open', 'enum-member'],
      ['counter', 'variable'],
      ['handler', 'function'],
      ['limits', 'constant'],
    ]);
  });

  test('a Go file\'s declarations are read with the receiver they belong to', async () => {
    const text = [
      'package main',
      '',
      'import (',
      '\t"fmt"',
      '\t"os"',
      ')',
      '',
      'const greeting = "hello"',
      '',
      'var count = 0',
      '',
      'type Handler struct {',
      '\tName string',
      '}',
      '',
      'func (h Handler) Serve() error {',
      '\tfmt.Println(os.Args, h.Name)',
      '\treturn nil',
      '}',
      '',
      'func main() {',
      '\tfmt.Println(greeting, count)',
      '}',
      '',
    ].join('\n');
    const found = await extractFileSyntax('cmd/server/main.go', bytesOf(text));
    expect(found.symbols.map((symbol) => [symbol.qualifiedName, symbol.symbolKind])).toEqual([
      ['Handler', 'struct'],
      ['Handler.Name', 'field'],
      ['Handler.Serve', 'method'],
      ['count', 'variable'],
      ['greeting', 'constant'],
      ['main', 'function'],
    ]);
    expect(found.imports.map((entry) => entry.specifier)).toEqual(['fmt', 'os']);
    // `main` in `package main` is the way into the program; `Handler` is the
    // one top-level name the package exports for a caller.
    expect(found.entryPoints.map((entry) => [entry.form, entry.name])).toEqual([
      ['library-export', 'Handler'],
      ['main', 'main'],
    ]);
  });

  test('a Go test file\'s Test, Benchmark and Fuzz functions are tests, by the runner that knows them', async () => {
    const text = [
      'package main',
      '',
      'import "testing"',
      '',
      'func TestServe(t *testing.T) {}',
      'func TestServe_empty(t *testing.T) {}',
      'func BenchmarkServe(b *testing.B) {}',
      'func helper(t *testing.T) {}',
      '',
    ].join('\n');
    const found = await extractFileSyntax('cmd/server/main_test.go', bytesOf(text));
    expect(found.tests.map((entry) => [entry.name, entry.framework])).toEqual([
      ['BenchmarkServe', 'go-test'],
      ['TestServe', 'go-test'],
      ['TestServe_empty', 'go-test'],
    ]);
  });

  test('a JavaScript test call is a test named by its runner, and a call of any other name is not', async () => {
    const text = [
      "import { describe, expect, test, it } from 'bun:test';",
      '',
      "describe('orders', () => {",
      "  test('places an order', () => {",
      '    expect(1).toBe(1);',
      '  });',
      "  it('cancels an order', () => {});",
      "  it.only('skips the rest', () => {});",
      "  test.each([1, 2])('adds %i', () => {});",
      '});',
      '',
      'function test2(): void {}',
      "test2('not a test');",
      '',
    ].join('\n');
    const found = await extractFileSyntax('test/orders.test.ts', bytesOf(text));
    expect(found.tests.map((entry) => [entry.name, entry.framework])).toEqual([
      ['adds %i', 'bun-test'],
      ['cancels an order', 'bun-test'],
      ['places an order', 'bun-test'],
      ['skips the rest', 'bun-test'],
    ]);
  });

  test('a call that names a route, a command or a main is a way into the code', async () => {
    const text = [
      "import express from 'express';",
      '',
      'const app = express();',
      '',
      "app.get('/orders', (request, response) => response.end());",
      "app.delete('/orders/:id', (request, response) => response.end());",
      "app.command('serve');",
      '',
      'export function start(): void {}',
      '',
    ].join('\n');
    const found = await extractFileSyntax('src/server.ts', bytesOf(text));
    expect(found.entryPoints.map((entry) => [entry.form, entry.name])).toEqual([
      ['cli-command', 'serve'],
      ['http-route', '/orders'],
      ['http-route', '/orders/:id'],
      ['library-export', 'start'],
    ]);
  });

  test('a file with a language no grammar reads is a coverage gap, not a silence', async () => {
    const found = await extractFileSyntax('tools/script.py', bytesOf('def main():\n    pass\n'));
    expect(found.parsed).toBe(false);
    expect(found.language).toBeNull();
    expect(found.symbols).toEqual([]);
    expect(found.unread).toEqual([{ what: 'tools/script.py', reason: 'unsupported' }]);
  });

  test('a file the parser cannot read whole says so, and what it read stands', async () => {
    const found = await extractFileSyntax('src/broken.ts', bytesOf('export function ok(): void {}\nfunction ( {\n'));
    expect(found.parsed).toBe(true);
    expect(found.symbols.map((symbol) => symbol.name)).toEqual(['ok']);
    expect(found.unread).toEqual([{ what: 'src/broken.ts', reason: 'error' }]);
  });

  test('bytes that are not UTF-8 text are unread, with the reason', async () => {
    const found = await extractFileSyntax('src/binary.ts', Uint8Array.from([0x65, 0x78, 0xff, 0xfe, 0x0a]));
    expect(found.parsed).toBe(false);
    expect(found.unread).toEqual([{ what: 'src/binary.ts', reason: 'error' }]);
  });
});

describe('the facts one file\'s findings make', () => {
  const REPOSITORY = 'orders-api';
  const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const PATH = repositoryPath('src/orders.ts');
  const files: readonly string[] = ['src/helper.ts', PATH];

  /**
   * The id of a file's `file` fact, taken from the schema rather than from the
   * stage: a file fact's identity is the repository and the path, so the fact
   * the inventory stage publishes for a path is the one the schema builds here.
   */
  function fileIdOf(path: string): string {
    return makeNodeFact({
      kind: 'file',
      layer: 'extracted',
      provenance: { source: { system: 'git', version: '2.0.0' }, repository: { id: REPOSITORY, commit: COMMIT }, place: { file: repositoryPath(path), range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 } } },
      value: { repository: REPOSITORY, path: repositoryPath(path), roles: ['source'] },
    }).id;
  }

  async function factsOf(text: string, overrides: { readonly files?: readonly string[]; readonly commit?: string } = {}) {
    const findings = await extractFileSyntax(PATH, bytesOf(text));
    return syntaxFacts({
      repository: REPOSITORY,
      commit: overrides.commit ?? COMMIT,
      path: repositoryPath(PATH),
      findings,
      files: overrides.files ?? files,
    });
  }

  test('a fixture with two exported functions and one import makes those two symbols, their definitions, the import edge and the file\'s coverage', async () => {
    const set = await factsOf(NORMAL_CASE);
    expect(set.coverage).toEqual({ repository: REPOSITORY, scope: PATH, complete: true, read: [PATH], unread: [] });
    const byKind = (kind: string): Fact[] => set.facts.filter((fact) => fact.kind === kind);
    // The written set is in code point order of kind and id, so the two symbols
    // are read back in their own order rather than in the draft's.
    const names = byKind('symbol').map((fact) => (fact.value as { qualifiedName: string }).qualifiedName).sort();
    expect(names).toEqual(['first', 'second']);
    expect(byKind('defines')).toHaveLength(2);
    expect(byKind('occurrence')).toHaveLength(2);
    expect(byKind('import')).toHaveLength(1);
    expect(byKind('coverage')).toHaveLength(1);
    expect(byKind('comment')).toHaveLength(0);
    // Every fact is one the schema reads, and every id is its own identity's digest.
    for (const fact of set.facts) expect(checkFact(fact)).toEqual([]);
    // The import joins the file to the helper the specifier names, the `./x.js` of
    // a TypeScript repository being the `x.ts` a reader edits.
    const edge = byKind('import')[0]!;
    expect(edge.value).toEqual({ from: fileIdOf(PATH), to: fileIdOf('src/helper.ts'), specifier: './helper.js' });
    expect(edge.provenance.place?.file).toBe(PATH);
    expect([edge.provenance.place?.range.startLine, edge.provenance.place?.range.startColumn]).toEqual([1, 23]);
    // A definition is what the symbol stands at, and the occurrence carries the one role this stage has.
    const occurrence = byKind('occurrence')[0]!;
    expect((occurrence.value as { roles: readonly string[] }).roles).toEqual(['definition']);
    expect(occurrence.provenance.place?.range.startColumn).toBe(16);
    expect(occurrence.provenance.repository).toEqual({ id: REPOSITORY, commit: COMMIT });
  });

  test('a specifier this stage cannot tie to a file is a coverage gap, and no edge is invented', async () => {
    const text = [
      "import { helper } from './helper.js';",
      "import React from 'react';",
      "import missing from './gone.js';",
      '',
      'export function first(): void {}',
      '',
    ].join('\n');
    const set = await factsOf(text);
    expect(set.facts.filter((fact) => fact.kind === 'import')).toHaveLength(1);
    expect(set.coverage).toEqual({
      repository: REPOSITORY,
      scope: PATH,
      complete: false,
      read: [PATH],
      unread: [
        { what: './gone.js', reason: 'unsupported' },
        { what: 'react', reason: 'unsupported' },
      ],
    });
  });

  test('a language with no grammar makes the coverage fact and nothing else', async () => {
    const findings = await extractFileSyntax('tools/script.py', bytesOf('def main():\n    pass\n'));
    const set = syntaxFacts({
      repository: REPOSITORY,
      commit: COMMIT,
      path: repositoryPath('tools/script.py'),
      findings,
      files: [...files],
    });
    expect(set.facts.map((fact) => fact.kind)).toEqual(['coverage']);
    expect(set.coverage).toEqual({
      repository: REPOSITORY,
      scope: 'tools/script.py',
      complete: false,
      read: [],
      unread: [{ what: 'tools/script.py', reason: 'unsupported' }],
    });
  });

  test('an id is what the fact is about: the same file read at another commit keeps every id', async () => {
    const first = await factsOf(NORMAL_CASE);
    const second = await factsOf(NORMAL_CASE, { commit: 'b'.repeat(40) });
    expect(second.facts.map((fact) => fact.id)).toEqual(first.facts.map((fact) => fact.id));
    // The commit is where the fact was read, not what it is: provenance moves, the ids do not.
    expect(second.facts[0]!.provenance.repository.commit).toBe('b'.repeat(40));
  });

  test('the facts come out in code point order of kind and id, whatever order they were made in', async () => {
    const set = await factsOf(NORMAL_CASE);
    const order = set.facts.map((fact) => `${fact.kind}\u0000${fact.id}`);
    expect([...order].sort()).toEqual(order);
  });
});

describe('tying an import specifier to a file of the repository', () => {
  const known = new Set<string>([
    'src/index.ts', 'src/helper.ts', 'src/written.js', 'src/tool/index.ts', 'src/raw.json',
  ]);

  test('a relative specifier is resolved by the file it names, with or without an extension', () => {
    expect(resolveSpecifier('src/index.ts', './helper.js', known)).toBe('src/helper.ts');
    expect(resolveSpecifier('src/index.ts', './helper', known)).toBe('src/helper.ts');
    expect(resolveSpecifier('src/index.ts', './written.js', known)).toBe('src/written.js');
    expect(resolveSpecifier('src/index.ts', './tool', known)).toBe('src/tool/index.ts');
    expect(resolveSpecifier('src/index.ts', './raw.json', known)).toBe('src/raw.json');
    expect(resolveSpecifier('src/index.ts', '../src/helper.ts', known)).toBe('src/helper.ts');
  });

  test('a specifier that names no file of this repository is not resolved', () => {
    expect(resolveSpecifier('src/index.ts', 'react', known)).toBeUndefined();
    expect(resolveSpecifier('src/index.ts', 'node:fs', known)).toBeUndefined();
    expect(resolveSpecifier('src/index.ts', './gone.js', known)).toBeUndefined();
    expect(resolveSpecifier('src/index.ts', '../../outside.ts', known)).toBeUndefined();
  });
});
