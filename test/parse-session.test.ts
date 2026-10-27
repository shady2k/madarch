/**
 * The parse a whole extraction pass shares (madarch-mwhd.3): one parse per
 * (tree, path), answered to every reader of the path, held until the pass ends
 * and released when it does. Every fixture here is written by the test and read
 * through an in-memory `TreeReader`, so nothing depends on a checkout, a commit
 * or a file on disk.
 *
 * The tests read tree-sitter wasm grammars, so they need a machine with AVX2
 * (`madarch-sky-test --avx2`).
 */
import { describe, expect, test } from 'bun:test';
import type { TreeReader } from '../src/extract/records.js';
import { currentParseSession, openParseSession } from '../src/fill/stages/parse-session.js';
import { extractFileResolution } from '../src/fill/stages/resolution-extract.js';
import { extractFileSyntax, readSyntaxTree, type ParsedSyntaxTree, type SyntaxTreeRead } from '../src/fill/stages/syntax-extract.js';

const encoder = new TextEncoder();

/** One tree in memory: the paths it holds and the bytes of each, as a reader of a commit's tree answers them. */
function treeOf(files: Readonly<Record<string, string>>): TreeReader {
  const paths = Object.keys(files).sort();
  return {
    paths,
    read(path: string): Uint8Array {
      const held = files[path];
      if (held === undefined) throw new Error(`in-memory tree: no such path ${path}`);
      return encoder.encode(held);
    },
  };
}

/** One file a reader of the tree asks for: its path and the bytes the tree answers for it. */
function fileOf(tree: TreeReader, path: string): { readonly path: string; readonly bytes: Uint8Array } {
  return { path, bytes: tree.read(path) };
}

/** What one walk of a tree answers: every part of a parsed tree a reader can copy out of it. */
function summarise(file: ParsedSyntaxTree): Record<string, unknown> {
  return {
    path: file.path,
    language: file.language,
    complete: file.complete,
    text: file.text,
    root: file.root.type,
    children: file.root.namedChildren.map((child) => (child === null ? '' : child.type)),
    names: file.captures('(identifier) @name').map((capture) => `${capture.name}:${file.text.slice(capture.node.startIndex, capture.node.endIndex)}`),
  };
}

const ORDER_SERVICE = [
  "import { Order } from './order.js';",
  '',
  'export interface Deps {',
  '  readonly orders: Map<string, Order>;',
  '}',
  '',
  'export class OrderService {',
  '  constructor(private readonly deps: Deps) {}',
  '',
  '  place(order: Order): string {',
  '    this.deps.orders.set(order.id, order);',
  '    return order.id;',
  '  }',
  '}',
  '',
].join('\n');

describe('one parse for every reader of one path', () => {
  test('four readers of one path cost one parse, and the pass holds the one tree', async () => {
    const tree = treeOf({ 'services/order.ts': ORDER_SERVICE });
    const session = openParseSession(tree);
    try {
      const readings: SyntaxTreeRead<Record<string, unknown>>[] = [];
      for (let reader = 0; reader < 4; reader++) readings.push(await session.read('services/order.ts', tree.read('services/order.ts'), summarise));
      expect(session.parses).toBe(1);
      expect(session.heldTrees).toBe(1);
      for (const reading of readings) expect(reading).toEqual(readings[0]!);
      expect(readings[0]!.read).toBe(true);
    } finally {
      session.close();
    }
  }, 20_000);

  test('the real readers of a pass share the pass session and make one parse', async () => {
    const tree = treeOf({ 'services/order.ts': ORDER_SERVICE });
    const session = openParseSession(tree);
    try {
      await session.run(async () => {
        const first = fileOf(tree, 'services/order.ts');
        const syntax = await extractFileSyntax(first.path, first.bytes);
        const resolution = await extractFileResolution(first.path, first.bytes);
        const walked = await readSyntaxTree(first.path, tree.read(first.path), summarise);
        const again = await extractFileSyntax(first.path, tree.read(first.path));
        expect(syntax.parsed).toBe(true);
        expect(resolution.parsed).toBe(true);
        expect(walked.read).toBe(true);
        expect(again).toEqual(syntax);
        expect(session.parses).toBe(1);
        expect(session.heldTrees).toBe(1);
      });
      // The store is the pass's own: no work outside it is inside the session.
      expect(currentParseSession()).toBeUndefined();
    } finally {
      session.close();
    }
  }, 20_000);
});

describe('the answer a reader gets', () => {
  test('a held tree answers a walk exactly as a tree made for the call does', async () => {
    const tree = treeOf({ 'services/order.ts': ORDER_SERVICE });
    const bytes = tree.read('services/order.ts');
    const alone = await readSyntaxTree('services/order.ts', bytes, summarise);
    const session = openParseSession(tree);
    try {
      const shared = await session.read('services/order.ts', bytes, summarise);
      expect(shared).toEqual(alone);
      // And what it walked is the file itself, not an empty or foreign tree.
      expect(shared.read).toBe(true);
      if (!shared.read) throw new Error('the session answered no tree for a file that parses');
      expect(shared.value['text']).toBe(ORDER_SERVICE);
      expect(shared.value['root']).toBe('program');
      expect(shared.value['complete']).toBe(true);
    } finally {
      session.close();
    }
  }, 20_000);

  test('a path with no grammar of the stage is unread again, and no parse is asked for', async () => {
    const tree = treeOf({ 'docs/guide.md': '# The guide\n' });
    const session = openParseSession(tree);
    try {
      const first = await session.read('docs/guide.md', tree.read('docs/guide.md'), summarise);
      const second = await session.read('docs/guide.md', tree.read('docs/guide.md'), summarise);
      expect(first).toEqual({ read: false, language: null, unread: [{ what: 'docs/guide.md', reason: 'unsupported' }] });
      expect(second).toEqual(first);
      expect(session.parses).toBe(0);
    } finally {
      session.close();
    }
  }, 20_000);
});

describe('a file that failed to parse', () => {
  // A file the parser reads as far as it can go: the class, the method and the
  // return are never closed, so the tree carries an error node.
  const BROKEN = 'export class OrderService {\n  place(order: Order): string {\n    return order.id;\n';

  test('a file the parser could not read whole answers the same gap twice, from one parse', async () => {
    const tree = treeOf({ 'services/order.ts': BROKEN });
    const session = openParseSession(tree);
    try {
      const first = await session.read('services/order.ts', tree.read('services/order.ts'), summarise);
      const second = await session.read('services/order.ts', tree.read('services/order.ts'), summarise);
      expect(first.read).toBe(true);
      expect(second).toEqual(first);
      expect(first.read && first.complete).toBe(false);
      // The stage's own reading of the same parse: the gap is the tree's, not a second failure.
      const syntax = await extractFileSyntax('services/order.ts', tree.read('services/order.ts'));
      expect(syntax.parsed).toBe(true);
      expect(syntax.unread).toEqual([{ what: 'services/order.ts', reason: 'error' }]);
      expect(session.parses).toBe(1);
    } finally {
      session.close();
    }
  }, 20_000);

  test('bytes that are not text are answered as the same failure, without a parse', async () => {
    const notText = new Uint8Array([0x2f, 0x2a, 0xff, 0xfe, 0x2a, 0x2f]);
    const tree: TreeReader = { paths: ['services/order.ts'], read: () => notText };
    const session = openParseSession(tree);
    try {
      const first = await session.read('services/order.ts', tree.read('services/order.ts'), summarise);
      const second = await session.read('services/order.ts', tree.read('services/order.ts'), summarise);
      expect(first).toEqual({ read: false, language: 'typescript', unread: [{ what: 'services/order.ts', reason: 'error' }] });
      expect(second).toEqual(first);
      // The same answer, not a second attempt at one.
      expect(second.read ? undefined : second.unread).toBe(first.read ? undefined : first.unread);
      expect(session.parses).toBe(0);
    } finally {
      session.close();
    }
  }, 20_000);
});

describe('one session reads one tree', () => {
  test('two trees through two sessions never share a tree', async () => {
    const firstTree = treeOf({ 'services/order.ts': ORDER_SERVICE });
    const secondTree = treeOf({ 'services/order.ts': "export const place = (id: string): string => id;\n" });
    const first = openParseSession(firstTree);
    const second = openParseSession(secondTree);
    try {
      const one = await first.read('services/order.ts', firstTree.read('services/order.ts'), summarise);
      const two = await second.read('services/order.ts', secondTree.read('services/order.ts'), summarise);
      expect(one.read && one.value.text).toBe(ORDER_SERVICE);
      expect(two.read && two.value.text).toBe("export const place = (id: string): string => id;\n");
      expect(first.parses).toBe(1);
      expect(second.parses).toBe(1);
      // Each session is its own tree's: the other tree's bytes of the same path are refused, by name.
      await expect(first.read('services/order.ts', secondTree.read('services/order.ts'), summarise)).rejects.toThrow('services/order.ts');
      expect(first.parses).toBe(1);
    } finally {
      first.close();
      second.close();
    }
  }, 20_000);

  test('close releases every tree and refuses a later use, naming the path', async () => {
    const tree = treeOf({ 'services/order.ts': ORDER_SERVICE });
    const bytes = tree.read('services/order.ts');
    const session = openParseSession(tree);
    expect(session.closed).toBe(false);
    await session.read('services/order.ts', bytes, summarise);
    expect(session.heldTrees).toBe(1);
    session.close();
    expect(session.closed).toBe(true);
    expect(session.heldTrees).toBe(0);
    // Closing again keeps the release it made, and costs nothing.
    session.close();
    expect(session.heldTrees).toBe(0);
    await expect(session.read('services/order.ts', bytes, summarise)).rejects.toThrow('services/order.ts');
    expect(() => session.run(() => 'work')).toThrow('close()');
  }, 20_000);
});
