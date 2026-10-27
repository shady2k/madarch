/**
 * One parse per (tree, path) for a whole extraction pass (madarch-mwhd.3).
 *
 * A tree's pass reads the same code file through several readers: the syntax
 * stage's own extraction, stage 4's resolution, the declaration reader, the
 * member/use walk, the test catalogue, and beside them the contracts and
 * data-model extractors. Each of them parsed the file for itself — four to
 * eight parses of one file of one tree, each with a parser of its own.
 *
 * This module holds the parse those readers share. A session belongs to one
 * tree (the `TreeReader` it names) and one extraction pass: the first reader of
 * a path parses it, every later reader of that path walks the tree the session
 * keeps, and the pass's end releases every tree and every parser. What a reader
 * gets back is what `readSyntaxTree` answered before — the same walk callback,
 * the same captures, the same `unread` and `complete` reporting — so no reader
 * can tell a held tree from one made for its own call.
 *
 * **Why a pass, and not a cache of trees.** A syntax tree is a large object
 * (roughly ten times the source's size), and it is the pass's input as much as
 * the bytes are: the tree of one commit is not the tree of another, and a tree
 * kept beyond the fill of its own tree would answer a file the repository no
 * longer holds. The session therefore holds nothing across trees. `close()`
 * releases every tree it made, so a leaked tree is a tree of a tree nobody is
 * filling; what the pass pays is every parsed tree of one tree alive at once,
 * and no more (decision 0026's rebuild reads one commit's tree per pass).
 *
 * **How a later reader finds its pass's session.** The pass installs its session
 * with `run`, which keeps it in an `AsyncLocalStorage` for exactly the duration
 * of the pass's own work: `readSyntaxTree` asks `currentParseSession()` for it,
 * and a reader outside a pass gets a tree for its own call, as it always did.
 * Nothing is global: the store holds one session's reference while that pass
 * runs, and no session of another tree is reachable from it.
 *
 * **What is remembered, and what is refused.** A path answers once: a file the
 * parser could not read is remembered as that answer too, so a second reader
 * gets the same gap rather than a second failure. Each answer is kept with the
 * bytes it was read from, and a reader that asks for a path with other bytes is
 * refused by name: the bytes of one path are one tree's, and a session reads one
 * tree.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import goGrammar from 'tree-sitter-wasms/out/tree-sitter-go.wasm' with { type: 'file' };
import jsGrammar from 'tree-sitter-wasms/out/tree-sitter-javascript.wasm' with { type: 'file' };
import tsGrammar from 'tree-sitter-wasms/out/tree-sitter-typescript.wasm' with { type: 'file' };
import tsxGrammar from 'tree-sitter-wasms/out/tree-sitter-tsx.wasm' with { type: 'file' };
import treeSitterRuntime from 'web-tree-sitter/tree-sitter.wasm' with { type: 'file' };
import { Language, Parser, Query, type Node as SyntaxNode, type Tree } from 'web-tree-sitter';
import type { TreeReader } from '../../extract/records.js';
import type { CoverageGap } from '../facts.js';
import type { ParsedSyntaxTree, SyntaxTreeRead } from './syntax-extract.js';

// ---- what a grammar reads, and the parsers that read it -------------------

/** The languages a grammar of this stage parses, in code point order. */
export const SYNTAX_LANGUAGES = ['go', 'javascript', 'tsx', 'typescript'] as const;

/** One language this stage parses, as a file's extension names it. */
export type SyntaxLanguage = (typeof SYNTAX_LANGUAGES)[number];

/**
 * The language a repository path is written in, by its extension: the map the
 * landed walk used (`src/product/fill-index.ts`), where `.tsx` is its own
 * grammar and `.jsx` is read by the JavaScript grammar as the landed fill read
 * it. A path whose extension names no grammar of this stage has no language
 * here, and the stage reports it as a coverage gap rather than a silence.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SyntaxLanguage>> = {
  '.cjs': 'javascript',
  '.cts': 'typescript',
  '.go': 'go',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.mts': 'typescript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
};

/** The language a repository path is written in, or `undefined` where no grammar of this stage reads it. */
export function syntaxLanguageOf(path: string): SyntaxLanguage | undefined {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot <= slash) return undefined;
  return LANGUAGE_BY_EXTENSION[path.slice(dot).toLowerCase()];
}

const GRAMMAR_FILES: Readonly<Record<SyntaxLanguage, string>> = {
  go: goGrammar,
  javascript: jsGrammar,
  tsx: tsxGrammar,
  typescript: tsGrammar,
};

/**
 * The runtime's own initialization, once per process: `Parser.init` loads the
 * wasm runtime the grammars run on. A failed initialization is kept, so a
 * second call answers the same failure rather than starting a second load.
 */
let runtimeReady: Promise<void> | undefined;

/** The grammars loaded so far, one per language, in the order they were first needed. */
const loadedGrammars = new Map<SyntaxLanguage, Awaited<ReturnType<typeof Language.load>>>();

async function grammarFor(language: SyntaxLanguage): Promise<Awaited<ReturnType<typeof Language.load>>> {
  runtimeReady ??= Parser.init({ locateFile: () => treeSitterRuntime });
  await runtimeReady;
  const held = loadedGrammars.get(language);
  if (held !== undefined) return held;
  const loaded = await Language.load(GRAMMAR_FILES[language]);
  loadedGrammars.set(language, loaded);
  return loaded;
}

/** The decoder every parse of this module reads a file's bytes with: one file's bytes are text or they are not. */
const decoder = new TextDecoder('utf-8', { fatal: true });

// ---- one path's parse -----------------------------------------------------

/**
 * What one path's parse answered: the tree a reader walks, with the tree kept
 * beside it so its holder can release it, or the gaps that say why there is no
 * tree. A path answers this once per session, failed files included.
 */
type ParseAnswer =
  | { readonly read: true; readonly tree: Tree; readonly parsed: ParsedSyntaxTree }
  | { readonly read: false; readonly language: SyntaxLanguage; readonly unread: readonly CoverageGap[] };

/** One language's grammar and the parser that reads it: what a session holds for a language it parsed with. */
interface Reader {
  readonly grammar: Language;
  readonly parser: Parser;
}

/**
 * One file's bytes as text, or `undefined` where they are not UTF-8 text: such
 * a file has no syntax tree, and no grammar and parser are needed to say so.
 */
function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Parses one file's text with a parser that already reads its language, and
 * answers the tree a reader walks or the gaps that say why there is none. `made`
 * is called when the parser parsed the file, which is what a session counts.
 */
function parseWith(grammar: Language, parser: Parser, path: string, language: SyntaxLanguage, text: string, made: () => void): ParseAnswer {
  const tree = parser.parse(text);
  made();
  if (tree === null) return { read: false, language, unread: [{ what: path, reason: 'error' }] };
  const root = tree.rootNode;
  const complete = !root.hasError;
  const captures = (source: string): readonly { readonly name: string; readonly node: SyntaxNode }[] => {
    // A query is structural only. Disallow every predicate, including custom
    // predicates that would otherwise be silently ignored by the web binding.
    if (source.includes('#')) throw new Error('syntax query predicates are not permitted');
    const query = new Query(grammar, source);
    try {
      const found = query.captures(root, { matchLimit: 65_536 });
      if (query.didExceedMatchLimit()) throw new Error('syntax query exceeded its match limit');
      return found;
    } finally {
      query.delete();
    }
  };
  return { read: true, tree, parsed: { path, language, text, root, complete, captures } };
}

/**
 * Reads one file's bytes and hands its tree to a walk, for a reader with no pass
 * session: the parser and the tree live no longer than the walk, so a walk
 * cannot keep a node — it answers what it read, and the answer outlives the
 * tree. This is what `readSyntaxTree` did for every call before a pass held its
 * parses, and what it still does outside a pass.
 */
export async function readSyntaxTreeOnce<T>(path: string, language: SyntaxLanguage, bytes: Uint8Array, walk: (file: ParsedSyntaxTree) => T): Promise<SyntaxTreeRead<T>> {
  const text = decodeText(bytes);
  // Bytes that are not UTF-8 text have no syntax tree to walk: the file is
  // reported unread, with the reason, rather than read as something it is not.
  if (text === undefined) return { read: false, language, unread: [{ what: path, reason: 'error' }] };
  // The runtime is initialized before a parser is made: `Parser.init` loads the
  // wasm runtime the grammars run on, and a parser made before it is refused.
  const grammar = await grammarFor(language);
  const parser = new Parser();
  try {
    parser.setLanguage(grammar);
    const answer = parseWith(grammar, parser, path, language, text, () => undefined);
    if (!answer.read) return { read: false, language: answer.language, unread: answer.unread };
    try {
      const value = walk(answer.parsed);
      return { read: true, value, language, complete: answer.parsed.complete };
    } finally {
      answer.tree.delete();
    }
  } finally {
    parser.delete();
  }
}

// ---- the session of one tree's pass ---------------------------------------

/** One tree's parses, held for one extraction pass: the API of `openParseSession`. */
export interface ParseSession {
  /** The tree this session reads: one session belongs to one tree and to no other. */
  readonly tree: TreeReader;
  /**
   * Runs `work` with this session installed as its pass's session, so every
   * reader of the pass — `readSyntaxTree` itself — shares its parses. The store
   * is this pass's alone: it ends with `work`, and no other pass sees it.
   */
  run<T>(work: () => T): T;
  /**
   * One path's answer, walked: what `readSyntaxTree` answers, from at most one
   * parse for the whole pass. A path that failed to parse answers that failure
   * to every reader, and a path asked for with other bytes than the tree's is
   * refused by name.
   */
  read<T>(path: string, bytes: Uint8Array, walk: (file: ParsedSyntaxTree) => T): Promise<SyntaxTreeRead<T>>;
  /** The parses this session made: one per path it parsed, and none for a path it answered from a held tree. */
  readonly parses: number;
  /** The trees this session holds now: every parse of the pass until `close` releases them. */
  readonly heldTrees: number;
  /** Whether the session has released its trees and parsers. */
  readonly closed: boolean;
  /** Releases every tree and every parser this session made; a use after it is refused. */
  close(): void;
}

/** The session of the pass the current work runs in, if a pass installed one. */
const pass = new AsyncLocalStorage<ParseSession>();

/** The session of the pass this call runs in, or `undefined` where the work is no pass's. */
export function currentParseSession(): ParseSession | undefined {
  return pass.getStore();
}

/** The bytes two readers of one path were given: equal bytes are one tree's file, whatever array they came in. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * Opens the session of one tree's pass. The caller closes it when the pass ends
 * — in a `finally`, so a throw releases the trees the pass parsed with.
 */
export function openParseSession(tree: TreeReader): ParseSession {
  /** One answer per path, kept with the bytes it was read from; a promise, so two readers of one path parse once. */
  const answers = new Map<string, { readonly bytes: Uint8Array; readonly answer: Promise<ParseAnswer> }>();
  /** The reader of each language the pass parsed with, loading one the first time it is needed. */
  const readers = new Map<SyntaxLanguage, Promise<Reader>>();
  /** Every tree the pass holds until it ends. */
  const trees = new Set<Tree>();
  let made = 0;
  let released = false;

  const refusal = (path?: string): never => {
    throw new Error(
      `parse session: ${path === undefined ? 'the session' : `the path ${path}`} was used after close(), which released every tree and every parser this session made of its tree; a reader asks the session of its own pass, and this one is closed`,
    );
  };

  const readerFor = (language: SyntaxLanguage): Promise<Reader> => {
    const held = readers.get(language);
    if (held !== undefined) return held;
    const loading = (async (): Promise<Reader> => {
      const grammar = await grammarFor(language);
      const parser = new Parser();
      parser.setLanguage(grammar);
      return { grammar, parser };
    })();
    readers.set(language, loading);
    return loading;
  };

  const parse = async (path: string, language: SyntaxLanguage, bytes: Uint8Array): Promise<ParseAnswer> => {
    const text = decodeText(bytes);
    // Bytes that are not UTF-8 text have no tree: the answer is the gap, it is
    // remembered with the path, and no grammar or parser is asked for it.
    if (text === undefined) return { read: false, language, unread: [{ what: path, reason: 'error' }] };
    const reader = await readerFor(language);
    if (released) refusal(path);
    const answer = parseWith(reader.grammar, reader.parser, path, language, text, () => {
      made += 1;
    });
    if (!answer.read) return answer;
    // A close during the parse owns the tree it did not see: the pass is over,
    // and a tree made after it is the tree a leaked parse would hold.
    if (released) {
      answer.tree.delete();
      refusal(path);
    }
    trees.add(answer.tree);
    return answer;
  };

  const answerOf = async (path: string, language: SyntaxLanguage, bytes: Uint8Array): Promise<ParseAnswer> => {
    const held = answers.get(path);
    if (held !== undefined) {
      if (!sameBytes(held.bytes, bytes)) {
        throw new Error(`parse session: the path ${path} was parsed from other bytes than these; a session parses one tree, and the bytes of one path are that tree's`);
      }
      return held.answer;
    }
    const answer = parse(path, language, bytes);
    answers.set(path, { bytes, answer });
    try {
      return await answer;
    } catch (error) {
      // A parse that threw answered nothing: the next reader tries again
      // instead of inheriting a failure no tree of the pass produced.
      answers.delete(path);
      throw error;
    }
  };

  const session: ParseSession = {
    tree,
    run<T>(work: () => T): T {
      if (released) refusal();
      return pass.run(session, work);
    },
    async read<T>(path: string, bytes: Uint8Array, walk: (file: ParsedSyntaxTree) => T): Promise<SyntaxTreeRead<T>> {
      if (released) refusal(path);
      const language = syntaxLanguageOf(path);
      // No grammar reads this path: no parse is asked for, and the answer cannot differ between readers.
      if (language === undefined) return { read: false, language: null, unread: [{ what: path, reason: 'unsupported' }] };
      const answer = await answerOf(path, language, bytes);
      if (!answer.read) return { read: false, language: answer.language, unread: answer.unread };
      return { read: true, value: walk(answer.parsed), language, complete: answer.parsed.complete };
    },
    get parses(): number {
      return made;
    },
    get heldTrees(): number {
      return trees.size;
    },
    get closed(): boolean {
      return released;
    },
    close(): void {
      if (released) return;
      released = true;
      for (const held of trees) held.delete();
      trees.clear();
      // A parser whose grammar is still loading is released when it arrives, so
      // a session that is closed holds nothing a read in flight made: without
      // this, a close during the first parse of a language leaked its parser.
      for (const loading of readers.values()) void loading.then((reader) => reader.parser.delete(), () => undefined);
      readers.clear();
    },
  };
  return session;
}
