/**
 * The syntax stage's pure per-file extraction (madarch-tzte.21.3; decision
 * 0026's stage 3, "syntax (tree-sitter, per file)"). One repository path and
 * one file's bytes go in; the symbols the file declares, the position of each
 * declaration, its comments, its entry points, its tests and the modules it
 * imports come out, each with the byte span and the line span it stands at.
 *
 * The function is pure: it reads nothing but its two arguments — no clock, no
 * file system, no network, no database, no run — so the same bytes at the same
 * path answer the same findings on every machine and in every run. What the
 * findings become (facts of `src/fill/facts.ts`, with ids, provenance and the
 * place the entry stands at) is `syntaxFacts`'s business, and where the bytes
 * come from is the stage's (`SnapshotReader`, madarch-tzte.21.1).
 *
 * What is a symbol here, and what is not: this stage reads *declarations* — a
 * name a file binds to a definition: a function, a generator, a class, a
 * method, a field, an interface, a type alias, an enum, a namespace or module,
 * a constant, a variable, a Go type, a Go struct member. A parameter, a local
 * binding inside a body, a property access or a call is no declaration: those
 * are stage 4's symbols and occurrences (decision 0026), where a resolver
 * names them precisely. A declaration the walk cannot name (a computed class
 * member, an anonymous function expression that is nobody's default export) is
 * left out of the findings; a *file* the walk cannot read at all is a coverage
 * gap, never a silence (see `unread`).
 *
 * How a declaration is named: by what holds it (`OrderService.create`,
 * `handlers.save`, `Worker.run`), never at the file's own scope when it stands
 * inside something — a class, a function, a namespace, an interface, a type
 * alias, an enum, a named expression, or an object literal held by a value
 * (madarch-tzte.21.10). A name at the file's own scope is a name any bare
 * mention of the file can reach, which is why the object literal's members are
 * qualified by the value they stand in.
 *
 * The grammars are the ones the landed `src/product/fill-index.ts` reads: the
 * same four wasm grammars over the same runtime, so the rebuild parses what the
 * landed fill parsed (decision 0026 rebuilds that fill rather than patching it).
 * The TypeScript and TSX grammars come from the tree-sitter project's
 * `tree-sitter-typescript` 0.23.2, whose scanner reads a `-->` inside a regex
 * literal, where 0.20.5 took it for an HTML comment and left the line an error
 * (madarch-vtft); Go and JavaScript stay on `tree-sitter-wasms` 0.1.13, whose
 * node shapes the walk reads.
 */
import goGrammar from 'tree-sitter-wasms/out/tree-sitter-go.wasm' with { type: 'file' };
import jsGrammar from 'tree-sitter-wasms/out/tree-sitter-javascript.wasm' with { type: 'file' };
import tsGrammar from 'tree-sitter-typescript/tree-sitter-typescript.wasm' with { type: 'file' };
import tsxGrammar from 'tree-sitter-typescript/tree-sitter-tsx.wasm' with { type: 'file' };
import treeSitterRuntime from 'web-tree-sitter/tree-sitter.wasm' with { type: 'file' };
import { Language, Parser, Query, type Node as SyntaxNode } from 'web-tree-sitter';
import type { CoverageGap } from '../fill/facts.js';

// ---- the languages this stage reads ---------------------------------------

/** The languages a grammar of this stage parses, in code point order. */
const SYNTAX_LANGUAGES = ['go', 'javascript', 'tsx', 'typescript'] as const;

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











// ---- parsing --------------------------------------------------------------

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



/** One file parsed for a reader that walks the tree itself, stage 4's resolution beside stage 3's syntax. */
export interface ParsedSyntaxTree {
  /** The file's repository path, as it was given. */
  readonly path: string;
  /** The language the file was read as. */
  readonly language: SyntaxLanguage;
  /** The file's own text, decoded as UTF-8. */
  readonly text: string;
  /** The tree's root node; its own lifetime is the `walk` call's. */
  readonly root: SyntaxNode;
  /** Whether the parser read the file whole: a tree with an error node read as far as the parser could go. */
  readonly complete: boolean;
  /** Captured nodes are borrowed only inside this parsed-tree callback. */
  readonly captures: (source: string) => readonly { readonly name: string; readonly node: SyntaxNode }[];
}

/**
 * What reading one file for a walk of its tree answered: the walk's own answer
 * with what the tree was read as, or the gaps that say why there is no tree.
 * A file with no grammar, bytes that are not UTF-8 text, and a parser that
 * answered nothing are all `read: false` with the reason — never a silence.
 */
export type SyntaxTreeRead<T> =
  | { readonly read: true; readonly value: T; readonly language: SyntaxLanguage; readonly complete: boolean }
  | { readonly read: false; readonly language: SyntaxLanguage | null; readonly unread: readonly CoverageGap[] };

/**
 * Reads one file's bytes and hands its tree to a walk, which is how two
 * readers share one parse: the syntax stage's own extraction and stage 4's
 * resolution of the names the file mentions. The tree and the parser live no
 * longer than the call, so a walk cannot keep a node — it answers what it
 * read, and the answer outlives the tree.
 */
export async function readSyntaxTree<T>(path: string, bytes: Uint8Array, walk: (file: ParsedSyntaxTree) => T): Promise<SyntaxTreeRead<T>> {
  const language = syntaxLanguageOf(path);
  if (language === undefined) return { read: false, language: null, unread: [{ what: path, reason: 'unsupported' }] };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Bytes that are not UTF-8 text have no syntax tree to walk: the file is
    // reported unread, with the reason, rather than read as something it is not.
    return { read: false, language, unread: [{ what: path, reason: 'error' }] };
  }
  // The runtime is initialized before a parser is made: `Parser.init` loads the
  // wasm runtime the grammars run on, and a parser made before it is refused.
  const grammar = await grammarFor(language);
  const parser = new Parser();
  try {
    parser.setLanguage(grammar);
    const tree = parser.parse(text);
    if (tree === null) return { read: false, language, unread: [{ what: path, reason: 'error' }] };
    try {
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
      const value = walk({ path, language, text, root, complete, captures });
      return { read: true, value, language, complete };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}





// ---- the walk -------------------------------------------------------------
