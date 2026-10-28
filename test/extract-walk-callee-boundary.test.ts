/**
 * The callee name of madarch-mwhd.3's walk helper (product-wiki/no-source-patterns,
 * parser-source-guard): the grammar answers which name a call's callee ends with, and no reader
 * slices a dot out of the callee's own text to find it.
 *
 * The name is the property of a `member_expression` (TypeScript's `mux.HandleFunc`), the field of
 * a `selector_expression` (Go's `http.NewServeMux`), or a plain identifier. A callee of another
 * kind -- a parenthesized callee, a subscript, a computed property -- answers undefined, and a
 * comment or a string that writes the shape is no call expression and answers nothing at all.
 */
import {expect, test} from 'bun:test';
import {calleeName, callsNamed, walkTree} from '../src/extract/contracts/walk.js';
import {readSyntaxTree} from '../src/fill/stages/syntax-extract.js';

/** Every call's callee name in one file, in the order the walk of the tree meets them. */
async function calleesOf(path: string, source: string): Promise<readonly (string | undefined)[]> {
  const read = await readSyntaxTree(path, new TextEncoder().encode(source), (parsed) => {
    const names: (string | undefined)[] = [];
    walkTree(parsed.root, (node) => {
      if (node.type === 'call_expression') names.push(calleeName(node));
    });
    return names;
  });
  if (!read.read) throw new Error(`${import.meta.path}: ${path} was not read: ${JSON.stringify(read.unread)}`);
  if (!read.complete) throw new Error(`${import.meta.path}: ${path} was not read whole; the fixture must parse`);
  return read.value;
}

/** How many calls of one file end with one of the names, read through the helper's own consumer. */
async function namedCallCount(path: string, source: string, names: readonly string[]): Promise<number> {
  const read = await readSyntaxTree(path, new TextEncoder().encode(source), (parsed) => callsNamed(parsed.root, new Set(names)).length);
  if (!read.read) throw new Error(`${import.meta.path}: ${path} was not read: ${JSON.stringify(read.unread)}`);
  if (!read.complete) throw new Error(`${import.meta.path}: ${path} was not read whole; the fixture must parse`);
  return read.value;
}

const tsPath = 'services/api/router.ts';
const goPath = 'services/api/router.go';

const tsSource = [
  'declare const mux: {HandleFunc: (path: string, handler: () => void) => void};',
  'declare const handlers: Record<string, () => void>;',
  'declare const deep: {inner: {register: () => void}};',
  'declare function Register(): void;',
  '// mux.HandleFunc is registered below, and this comment names no call.',
  "const note = 'mux.HandleFunc and handlers[name]() are shapes a reader writes, not calls';",
  "mux.HandleFunc('/healthz', () => {});",
  'deep.inner.register();',
  'Register();',
  'handlers[note]();',
  'void note;',
].join('\n');

const goSource = [
  'package api',
  'import "net/http"',
  '// mux.HandleFunc("/healthz", Health) is the registration this comment names; HandleRPC is not here.',
  'var handlers []func()',
  'func NewRouter() http.Handler {',
  '  mux := http.NewServeMux()',
  '  mux.HandleFunc("/healthz", Health)',
  '  handlers[0]()',
  '  return mux',
  '}',
  'func Health() {}',
].join('\n');

test('TypeScript answers the property of a member callee, and a subscript callee names none', async () => {
  // The four calls of the fixture, in walk order: a member's property, the last name of a chain,
  // a plain identifier -- and a subscript, whose callee kind is no name at all.
  expect(await calleesOf(tsPath, tsSource)).toEqual(['HandleFunc', 'register', 'Register', undefined]);
});

test('Go answers the field of a selector callee, and an index callee names none', async () => {
  expect(await calleesOf(goPath, goSource)).toEqual(['NewServeMux', 'HandleFunc', undefined]);
});

test('a comment or a string that writes the callee shape is no call, and names no callee', async () => {
  // The fixtures carry the decoys: `mux.HandleFunc` and `handlers[name]()` in the TypeScript
  // string, and `mux.HandleFunc("/healthz", Health)` in the Go comment. A comment and a string's
  // characters are not call expressions, so they reach no callee; the calls the tree holds are the
  // only ones read.
  expect(await namedCallCount(tsPath, tsSource, ['HandleFunc', 'register'])).toBe(2);
  expect(await namedCallCount(goPath, goSource, ['HandleFunc', 'NewServeMux', 'HandleRPC'])).toBe(2);
});

test('a name that only a comment writes finds no call of that name', async () => {
  // `HandleRPC` stands in the Go comment and nowhere else: no call of that name exists, and the
  // call the comment does name, `HandleFunc`, is counted because the tree holds it.
  expect(await namedCallCount(goPath, goSource, ['HandleRPC'])).toBe(0);
  expect(await namedCallCount(goPath, goSource, ['HandleFunc'])).toBe(1);
});
