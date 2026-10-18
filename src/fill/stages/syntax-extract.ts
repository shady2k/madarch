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
 * The grammars are the ones the landed `src/product/fill-index.ts` reads: the
 * same four wasm grammars of `tree-sitter-wasms` over the same runtime, so the
 * rebuild parses what the landed fill parsed (decision 0026 rebuilds that fill
 * rather than patching it).
 */
import goGrammar from 'tree-sitter-wasms/out/tree-sitter-go.wasm' with { type: 'file' };
import jsGrammar from 'tree-sitter-wasms/out/tree-sitter-javascript.wasm' with { type: 'file' };
import tsGrammar from 'tree-sitter-wasms/out/tree-sitter-typescript.wasm' with { type: 'file' };
import tsxGrammar from 'tree-sitter-wasms/out/tree-sitter-tsx.wasm' with { type: 'file' };
import treeSitterRuntime from 'web-tree-sitter/tree-sitter.wasm' with { type: 'file' };
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';
import { byCodePoint } from '../../model/order.js';
import type { CommentForm, CoverageGap, CoverageGapReason, EntryPointForm, SymbolKind } from '../facts.js';

// ---- the languages this stage reads ---------------------------------------

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

/** The extensions each language is written in, in the order a specifier is tried against them. */
const EXTENSIONS_IN_ORDER: readonly string[] = ['.cjs', '.cts', '.go', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'];

/** Every extension this stage's grammars read, for a caller resolving a specifier (code point order). */
export const SYNTAX_EXTENSIONS: readonly string[] = EXTENSIONS_IN_ORDER;

// ---- the findings ---------------------------------------------------------

/** Where one finding stands: the line and column span a fact cites, and the byte span the reader read. */
export interface SyntaxSpan {
  /** The first line, 1-based, as a reader counts lines. */
  readonly startLine: number;
  /** The first character's 0-based offset in `startLine`, in UTF-16 code units. */
  readonly startColumn: number;
  /** The last line, 1-based. */
  readonly endLine: number;
  /** The 0-based offset just past the last character in `endLine`. */
  readonly endColumn: number;
  /** The first byte of the span in the file's own bytes. */
  readonly startByte: number;
  /** The byte just past the span's last byte. */
  readonly endByte: number;
}

/** One symbol a file declares: what it is called, what kind of thing it is, and where it stands. */
export interface ExtractedSymbol {
  /** The name a reader sees, without its container (`create`). */
  readonly name: string;
  /** The name qualified by the declarations around it (`OrderService.create`). */
  readonly qualifiedName: string;
  readonly symbolKind: SymbolKind;
  /** The declaration's own span: where the symbol stands. */
  readonly span: SyntaxSpan;
  /** The name token's span: where the definition occurrence stands. */
  readonly definitionSpan: SyntaxSpan;
}

/** One comment a file carries. */
export interface ExtractedComment {
  /** The comment's text without its markers, as written. */
  readonly text: string;
  readonly form: CommentForm;
  readonly span: SyntaxSpan;
}

/** One way into the code that a file declares. */
export interface ExtractedEntryPoint {
  /** The name a caller knows it by: `main`, a command's name, a route's path. */
  readonly name: string;
  readonly form: EntryPointForm;
  readonly span: SyntaxSpan;
}

/** One test a file declares. */
export interface ExtractedTest {
  /** The test's own name, as its runner reports it. */
  readonly name: string;
  /** The runner that knows it (`bun-test`, `go-test`), where the file says which. */
  readonly framework?: string;
  readonly span: SyntaxSpan;
}

/** One module a file imports. */
export interface ExtractedImport {
  /** The specifier as written (`../model/order.js`, `fmt`), without its quotes. */
  readonly specifier: string;
  /** The specifier's own span: the place the import is read at. */
  readonly span: SyntaxSpan;
}

/** Everything this stage read in one file: what it found, and what it could not read. */
export interface ExtractedFileSyntax {
  /** The file's repository path, as it was given. */
  readonly path: string;
  /** The language the file was read as, or `null` where no grammar of this stage reads it. */
  readonly language: SyntaxLanguage | null;
  /** Whether a syntax tree was made and walked. */
  readonly parsed: boolean;
  readonly symbols: readonly ExtractedSymbol[];
  readonly comments: readonly ExtractedComment[];
  readonly entryPoints: readonly ExtractedEntryPoint[];
  readonly tests: readonly ExtractedTest[];
  readonly imports: readonly ExtractedImport[];
  /**
   * What this reader could not read in the file, each with the reason — the
   * scope's coverage gap (0004, 0026): a language no grammar of this stage
   * reads is `unsupported`, bytes that are not UTF-8 text or a file the parser
   * could not fully read are `error`. Empty means the whole file was read.
   */
  readonly unread: readonly CoverageGap[];
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

/**
 * Reads one file's bytes and answers everything this stage finds in it. Pure:
 * the two arguments decide the answer, and nothing else does.
 */
export async function extractFileSyntax(path: string, bytes: Uint8Array): Promise<ExtractedFileSyntax> {
  const language = syntaxLanguageOf(path);
  if (language === undefined) return emptyFindings(path, null, [{ what: path, reason: 'unsupported' }]);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Bytes that are not UTF-8 text have no syntax tree to walk: the file is
    // reported unread, with the reason, rather than read as something it is not.
    return emptyFindings(path, language, [{ what: path, reason: 'error' }]);
  }
  // The runtime is initialized before a parser is made: `Parser.init` loads the
  // wasm runtime the grammars run on, and a parser made before it is refused.
  const grammar = await grammarFor(language);
  const parser = new Parser();
  try {
    parser.setLanguage(grammar);
    const tree = parser.parse(text);
    if (tree === null) return emptyFindings(path, language, [{ what: path, reason: 'error' }]);
    try {
      const root = tree.rootNode;
      const findings = walk(path, text, root, language);
      // A file the parser could not read whole, and a declaration the walk could
      // not name, are both read as far as they went and said so: the findings
      // stand, and each gap carries what was not read and the reason.
      const unread = [...findings.unread];
      if (root.hasError) unread.push({ what: path, reason: 'error' });
      return { path, language, parsed: true, ...findings, unread: mergeGaps(unread) };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/**
 * What a file this stage did not read has: no finding at all, and the gap that
 * says why. A caller that knows the file's bytes are not source text — a
 * symbolic link holds the path it points at, a submodule stands in another
 * repository — uses this to publish the file's coverage without pretending it
 * was read.
 */
export function unreadFileSyntax(path: string, reason: CoverageGapReason): ExtractedFileSyntax {
  return emptyFindings(path, syntaxLanguageOf(path) ?? null, [{ what: path, reason }]);
}

/** The gaps one `what` once, in code point order of `what`, as the schema reads a coverage's list. */
function mergeGaps(gaps: readonly CoverageGap[]): CoverageGap[] {
  const byWhat = new Map<string, CoverageGap>();
  for (const gap of gaps) if (!byWhat.has(gap.what)) byWhat.set(gap.what, gap);
  return [...byWhat.keys()].sort(byCodePoint).map((what) => byWhat.get(what)!);
}

/** A file this reader found nothing in, with the gaps it must report. */
function emptyFindings(path: string, language: SyntaxLanguage | null, unread: readonly CoverageGap[]): ExtractedFileSyntax {
  return { path, language, parsed: false, symbols: [], comments: [], entryPoints: [], tests: [], imports: [], unread };
}

// ---- the walk -------------------------------------------------------------

/**
 * The node types that qualify the declarations inside them, by language: a
 * definition inside them is named by the container's name (`OrderService.create`,
 * `Worker.run`, `Handler.Serve`), the qualified name SCIP and the fact schema
 * both use.
 */
const TS_CONTAINERS: readonly string[] = [
  'abstract_class_declaration', 'arrow_function', 'class', 'class_declaration', 'enum_declaration',
  'function_declaration', 'function_expression', 'generator_function_declaration', 'interface_declaration',
  'internal_module', 'method_definition', 'module', 'type_alias_declaration',
];

/**
 * The expression kinds whose name is optional: a *named* one declares the name
 * it carries, and an anonymous one declares nothing — an anonymous class or
 * function expression that is nobody's default export is an expression, not a
 * declaration, and no gap either.
 */
const ANONYMOUS_EXPRESSIONS: readonly string[] = ['class', 'function_expression'];

/** The expression kinds whose own name is local to the expression, and no way into the module. */
const EXPRESSION_NAMES: readonly string[] = ['class', 'function_expression'];

const GO_CONTAINERS: readonly string[] = ['function_declaration', 'method_declaration', 'type_spec', 'field_declaration', 'const_spec', 'var_spec'];

/**
 * The TypeScript member signatures whose name is only a name *inside* something:
 * read where the declaration they belong to names them, and left out where an
 * anonymous type literal holds them. A `function_signature` is not one of them:
 * the ambient grammar writes a module's own function that way (`declare
 * function f(): void;`), and it stands wherever it is written.
 */
const MEMBER_SIGNATURES: readonly string[] = ['abstract_method_signature', 'method_signature', 'property_signature'];

/**
 * The signature's own holder, and the declarations that name a holder's
 * members: an interface's body belongs to the interface, a class's to the
 * class, and an *anonymous* `object_type` to a type alias — while an
 * `object_type` inside another signature, an annotation or a field belongs to
 * no named type, and its members are nobody's declaration of this file.
 */
const NAMED_TYPE_HOLDERS: Readonly<Record<string, readonly string[]>> = {
  class_body: ['abstract_class_declaration', 'class_declaration'],
  enum_body: ['enum_declaration'],
  interface_body: ['interface_declaration'],
  object_type: ['type_alias_declaration'],
};

/** The kind of symbol a TypeScript, TSX or JavaScript declaration is, by its node type. */
const TS_DECLARATIONS: Readonly<Record<string, SymbolKind>> = {
  'abstract_class_declaration': 'class',
  // A *named* function or class expression declares the name it carries
  // (`const f = function named() {}`); an anonymous one declares nothing and is
  // no gap either, which is what `ANONYMOUS_EXPRESSIONS` says below.
  'class': 'class',
  'function_expression': 'function',
  'abstract_method_signature': 'method',
  'class_declaration': 'class',
  'enum_assignment': 'enum-member',
  'enum_declaration': 'enum',
  'field_definition': 'field',
  'function_declaration': 'function',
  'function_signature': 'function',
  'generator_function_declaration': 'function',
  'interface_declaration': 'interface',
  'internal_module': 'namespace',
  'method_definition': 'method',
  'method_signature': 'method',
  'module': 'namespace',
  'property_signature': 'property',
  'public_field_definition': 'field',
  'type_alias_declaration': 'type-alias',
};

/** The call methods that name a route, and the one that names a command. */
const ROUTE_METHODS: readonly string[] = ['all', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'use'];
const COMMAND_METHOD = 'command';

/** The modifiers a test runner's own call may carry (`it.only('name', …)`); the named call is the test. */
const TEST_MODIFIERS: readonly string[] = ['concurrent', 'each', 'failing', 'only', 'skip', 'todo', 'when'];

/** The packages whose `test`/`it` a file's call is read as a test of, by the specifier it imports them from. */
const TEST_FRAMEWORKS: Readonly<Record<string, string>> = {
  '@jest/globals': 'jest',
  'bun:test': 'bun-test',
  'jest': 'jest',
  'vitest': 'vitest',
};

/** One file's findings, before they become facts: what the walk found, and what it could not read. */
interface Findings {
  symbols: readonly ExtractedSymbol[];
  comments: readonly ExtractedComment[];
  entryPoints: readonly ExtractedEntryPoint[];
  tests: readonly ExtractedTest[];
  imports: readonly ExtractedImport[];
  /** The places the walk had to leave out, each with the reason — a scope's coverage gap (0004). */
  unread: readonly CoverageGap[];
}

/** Walks one parsed file and collects its findings, each with the span it stands at. */
function walk(path: string, text: string, root: SyntaxNode, language: SyntaxLanguage): Findings {
  const lines = lineIndex(text);
  const spanOf = (node: SyntaxNode): SyntaxSpan => spanAt(lines, text, node.startIndex, node.endIndex);
  const symbols: ExtractedSymbol[] = [];
  const comments: ExtractedComment[] = [];
  const entryPoints: ExtractedEntryPoint[] = [];
  const tests: ExtractedTest[] = [];
  const imports: ExtractedImport[] = [];
  const unread: CoverageGap[] = [];
  const go = language === 'go';
  // The names a file exports by clause (`export { later as renamed }`): a
  // declaration the clause names is exported although no `export` stands on it.
  const exportedByClause = go ? new Set<string>() : exportedNamesByClause(root, text);
  // Which package each local name of a test runner came from, so the test's own
  // framework is the runner the file says it is, and nothing else.
  const runners = go ? emptyRunners() : testRunners(root, text);

  /** Records one import, or the gap of a specifier the schema cannot hold (an empty one names no module). */
  const recordImport = (specifier: string, at: SyntaxNode): void => {
    if (!named(specifier)) {
      unread.push({ what: droppedAt(path, positionAt(lines, at.startIndex), 'the module an import names'), reason: 'unsupported' });
      return;
    }
    imports.push({ specifier, span: spanOf(at) });
  };

  const record = (node: SyntaxNode, container: readonly string[]): void => {
    const type = node.type;
    if (!go && (type === 'property_identifier' || type === 'enum_assignment') && enumMemberBody(node) !== null) {
      // An enum's members are declared names of the enum's own scope: a member
      // written without a value is a bare identifier in the enum's body, and one
      // with a value is an `enum_assignment` naming it. A member name that is no
      // identifier (a string literal, a computed one) is the enum's gap.
      const memberNode = nameNodeOf(node) ?? node;
      const member = text.slice(memberNode.startIndex, memberNode.endIndex);
      if (IDENTIFIER.test(member)) {
        symbols.push({ name: member, qualifiedName: qualified(container, member), symbolKind: 'enum-member', span: spanOf(node), definitionSpan: spanOf(memberNode) });
      } else {
        const at = positionAt(lines, memberNode.startIndex);
        unread.push({ what: droppedAt(path, at, 'the name of the enum member'), reason: 'unsupported' });
      }
      return;
    }
    if (type === 'comment') {
      const written = text.slice(node.startIndex, node.endIndex);
      comments.push({ text: commentText(written), form: commentForm(written), span: spanOf(node) });
      return;
    }
    if (!go && (type === 'import_statement' || type === 'export_statement')) {
      const specifier = node.childForFieldName('source');
      if (specifier !== null) recordImport(stringValue(text, specifier), specifier);
      return;
    }
    if (go && type === 'import_spec') {
      const quoted = node.childForFieldName('path');
      if (quoted !== null) recordImport(stringValue(text, quoted), quoted);
      return;
    }
    if (!go && type === 'call_expression') {
      const callee = node.childForFieldName('function');
      const args = node.childForFieldName('arguments');
      if (callee === null) return;
      const calleeText = text.slice(callee.startIndex, callee.endIndex);
      if (calleeText === 'require' || calleeText === 'import') {
        // A CommonJS `require('x')` and a dynamic `import('x')` name a module
        // the file reads, exactly as an import statement does.
        const literal = firstStringArgument(args);
        if (literal !== null) recordImport(stringValue(text, literal), literal);
        return;
      }
      const literal = firstStringArgument(args);
      const call = literal === null ? undefined : testCall(callee, text, runners);
      if (literal !== null && call !== undefined) {
        // `test('name', ...)`, `it('name', ...)` and the runner's own modifiers
        // (`it.only('name', ...)`): the call's own name is the test's name, and
        // the framework is the one the file imported the runner from. A test the
        // schema cannot hold — one called with an empty name — is the file's
        // coverage gap, never a fact the schema refuses.
        const written = stringValue(text, literal);
        if (!named(written)) {
          unread.push({ what: droppedAt(path, positionAt(lines, literal.startIndex), 'the name of the test'), reason: 'unsupported' });
          return;
        }
        tests.push({ name: written, ...(call.framework === undefined ? {} : { framework: call.framework }), span: spanOf(node) });
        return;
      }
      if (callee.type !== 'member_expression' || literal === null) return;
      const method = callee.childForFieldName('property');
      const methodName = method === null ? '' : text.slice(method.startIndex, method.endIndex);
      const written = stringValue(text, literal);
      if (methodName === COMMAND_METHOD && !named(written)) {
        // A command whose name is blank names nothing a reader can call: the
        // call's place is the file's gap rather than an entry point.
        unread.push({ what: droppedAt(path, positionAt(lines, literal.startIndex), 'the name of the command'), reason: 'unsupported' });
      } else if (methodName === COMMAND_METHOD && named(written)) {
        entryPoints.push({ name: written, form: 'cli-command', span: spanOf(literal) });
      } else if (ROUTE_METHODS.includes(methodName) && written.startsWith('/')) {
        entryPoints.push({ name: written, form: 'http-route', span: spanOf(literal) });
      }
      return;
    }
    const kind = symbolKindOf(node, text, language);
    if (kind !== undefined && MEMBER_SIGNATURES.includes(type) && namedTypeHolds(node, language) === null) {
      // A member signature is a declaration of the type it is written in: an
      // interface's member, a type alias's, a class's, or — in the ambient
      // grammar — a function a module declares. One written in an *anonymous*
      // type (`{ name: string }` in a parameter's annotation, or a nested
      // literal inside a named type) is no declaration of this file's own, and
      // reading it would put a bare `name`, or a misleading `View.id`, beside a
      // real symbol's name.
      return;
    }
    if (kind === undefined) {
      // An anonymous default export is the one declaration without a kind this
      // stage still knows: a module's default export is a symbol by that name.
      const anonymous = anonymousDefaultKind(node, language);
      if (anonymous === undefined) return;
      symbols.push({ name: 'default', qualifiedName: 'default', symbolKind: anonymous, span: spanOf(node), definitionSpan: defaultDefinitionSpan(node, spanOf) });
      return;
    }
    // A Go method belongs to the type its receiver names: the receiver is what
    // makes it a method, and Go has no nesting to say it another way.
    const owned = go && type === 'method_declaration' ? [...container, ...receiverNames(node, text)] : container;
    // The `name` field repeats where the grammar repeats it and can carry the
    // separators of its own list (a Go `var a, b` names `a`, `,` and `b`), so
    // only the nodes that read as an identifier are names this stage declares.
    // A module declaration names itself by a string (`declare module 'x' { … }`)
    // where every other declaration names itself by an identifier, and a name of
    // neither shape (`declare module '*'`) is this declaration's gap.
    const moduleName = type === 'module' || type === 'internal_module' ? node.childForFieldName('name') : null;
    const nameNodes = moduleName !== null
      ? (stringNode(moduleName) !== null
        ? (IDENTIFIER.test(stringValue(text, moduleName)) ? [moduleName] : [])
        : (nestedName(text.slice(moduleName.startIndex, moduleName.endIndex)) !== undefined ? [moduleName] : []))
      : withEmbeddedField(nameNodesOf(node), node, text, go)
        .filter((candidate) => IDENTIFIER.test(text.slice(candidate.startIndex, candidate.endIndex)));
    if (nameNodes.length === 0) {
      // An anonymous default export is a declaration whose only name is the one
      // its statement gives it: a module's default export is the symbol
      // `default`, defined at the keyword.
      const anonymous = anonymousDefaultKind(node, language);
      if (anonymous !== undefined) {
        symbols.push({ name: 'default', qualifiedName: 'default', symbolKind: anonymous, span: spanOf(node), definitionSpan: defaultDefinitionSpan(node, spanOf) });
        return;
      }
      // A declaration of a kind this stage reads, with no name it can read: a
      // computed class member among them. Nothing is invented for it, and the
      // file's coverage says the place was not read — a dropped declaration
      // that left the coverage complete would be a silence. An anonymous
      // function or class *expression* is the one exception: it declares no
      // name to read.
      if (!ANONYMOUS_EXPRESSIONS.includes(type)) {
        unread.push({ what: droppedAt(path, positionAt(lines, node.startIndex), 'the name of the declaration'), reason: 'unsupported' });
      }
      return;
    }
    for (const nameNode of nameNodes) {
      const name = stringNode(nameNode) === null ? text.slice(nameNode.startIndex, nameNode.endIndex) : stringValue(text, nameNode);
      if (!named(name)) continue;
      symbols.push({
        name,
        qualifiedName: qualified(owned, name),
        symbolKind: kind,
        span: spanOf(node),
        definitionSpan: spanOf(nameNode),
      });
      // A module's export is a way into its code, which is what an entry point
      // of the form `library-export` is: a *top-level* declaration another
      // module may call, by a name it can reach. A method or a nested
      // declaration is no way in from outside the file.
      const exported = go ? /^\p{Lu}/u.test(name) : exportedByClause.has(name) || withinExport(node);
      // A name a *named expression* carries is local to that expression
      // (`export const C = class Named {…}` exports `C`, and `Named` is nobody
      // else's name), so it is no way into the module.
      const reachable = !EXPRESSION_NAMES.includes(type) && !defaultExportCarries(node);
      if (reachable && exported && owned.length === 0 && (go || !withinExportedValue(node))) {
        entryPoints.push({ name, form: 'library-export', span: spanOf(nameNode) });
      }
      if (go && kind === 'function' && name === 'main' && declaresMainPackage(root, text)) {
        entryPoints.push({ name: 'main', form: 'main', span: spanOf(node) });
      }
      if (!go && kind === 'function' && name === 'main' && container.length === 0) {
        // A program's own `main`: the file declares the function a runner
        // starts at, whether it is exported for another module or called at the
        // bottom.
        entryPoints.push({ name: 'main', form: 'main', span: spanOf(nameNode) });
      }
      if (go && kind === 'function' && isGoTestName(name) && path.endsWith('_test.go')) {
        tests.push({ name, framework: 'go-test', span: spanOf(node) });
      }
    }
  };

  const visit = (node: SyntaxNode, container: readonly string[]): void => {
    record(node, container);
    const name = declaredName(node, text) ?? holderName(node, text);
    const containers = go ? GO_CONTAINERS : TS_CONTAINERS;
    const inner = name !== undefined && name !== '' && containers.includes(node.type) ? [...container, name] : container;
    for (const child of node.namedChildren) {
      if (child !== null) visit(child, inner);
    }
  };
  visit(root, []);

  return {
    unread: [...unread].sort((left, right) => byCodePoint(left.what, right.what)),
    symbols: [...symbols].sort((left, right) => byCodePoint(left.qualifiedName, right.qualifiedName) || byCodePoint(left.symbolKind, right.symbolKind)),
    comments: [...comments].sort((left, right) => left.span.startByte - right.span.startByte),
    entryPoints: dedupeBy([...entryPoints].sort((left, right) => byCodePoint(left.form, right.form) || byCodePoint(left.name, right.name)), (entry) => `${entry.form}\u0000${entry.name}`),
    tests: dedupeBy([...tests].sort((left, right) => byCodePoint(left.name, right.name)), (one) => one.name),
    imports: [...imports].sort((left, right) => byCodePoint(left.specifier, right.specifier) || left.span.startByte - right.span.startByte),
  };
}

/** The kind of symbol one declaration is, by language; `undefined` where the node declares no symbol of this stage. */
function symbolKindOf(node: SyntaxNode, text: string, language: SyntaxLanguage): SymbolKind | undefined {
  if (language !== 'go') {
    if (node.type === 'variable_declarator') {
      const declaration = node.parent;
      const keyword = declaration?.children[0]?.type ?? '';
      const value = node.childForFieldName('value');
      if (value !== null && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function')) return 'function';
      if (keyword === 'const') return 'constant';
      return keyword === 'let' || keyword === 'var' ? 'variable' : undefined;
    }
    // A class's initializer is no method: the schema names the kind the class
    // itself writes, and a reader looks for a constructor among constructors.
    if (node.type === 'method_definition') {
      const named = node.childForFieldName('name');
      if (named !== null && text.slice(named.startIndex, named.endIndex) === 'constructor') return 'constructor';
    }
    return TS_DECLARATIONS[node.type];
  }
  switch (node.type) {
    case 'function_declaration': return 'function';
    case 'method_declaration': return 'method';
    case 'const_spec': return 'constant';
    case 'var_spec': return 'variable';
    case 'field_declaration': return 'field';
    // An interface's method set: `type I interface { Do() error }` names `Do` as
    // surely as a struct names its fields.
    case 'method_spec': return 'method';
    case 'type_alias': return 'type-alias';
    case 'type_spec': {
      const underlying = node.childForFieldName('type');
      if (underlying !== null && underlying.type === 'struct_type') return 'struct';
      if (underlying !== null && underlying.type === 'interface_type') return 'interface';
      return 'type';
    }
    default: return undefined;
  }
}

/**
 * Every name node a declaration binds: the `name` field — which repeats where
 * the grammar repeats it, a Go `var a, b = 1, 2` naming two — or the JavaScript
 * class field's `property`.
 */
function nameNodesOf(node: SyntaxNode): readonly SyntaxNode[] {
  const named = node.childrenForFieldName('name').filter((held): held is SyntaxNode => held !== null);
  // A destructuring declaration binds the names its pattern writes: `const { a,
  // b: c, ...rest } = order` declares `a`, `c` and `rest`.
  if (named.length === 1 && (named[0]!.type === 'object_pattern' || named[0]!.type === 'array_pattern')) return patternNames(named[0]!);
  if (named.length > 0) return named;
  const property = node.childForFieldName('property');
  return property !== null && (property.type === 'property_identifier' || property.type === 'private_property_identifier') ? [property] : [];
}

/**
 * The names a destructuring pattern binds, in the order it writes them: each
 * shorthand name (`{ a }`), each pattern's own name (`{ b: c }`, recursing into
 * a nested pattern), each element of an array pattern, and a rest element's
 * name. A pattern that binds nothing this walk can name contributes nothing.
 */
function patternNames(pattern: SyntaxNode): readonly SyntaxNode[] {
  const names: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
      names.push(node);
      return;
    }
    // `{ b: c }` and `{ a = 1 }` and `[x = 2]`: the binding is on the left, and
    // a default's own expression names nothing this declaration binds.
    const binding = node.type === 'pair_pattern' ? node.childForFieldName('value') : node.childForFieldName('left');
    if (binding !== null) visit(binding);
    if (node.type === 'pair_pattern' || node.type === 'assignment_pattern' || node.type === 'object_assignment_pattern') return;
    for (const child of node.namedChildren) if (child !== null) visit(child);
  };
  visit(pattern);
  const once: SyntaxNode[] = [];
  const seen = new Set<SyntaxNode>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    once.push(name);
  }
  return once;
}

/**
 * A Go struct field's names, with the one case the `name` field does not write:
 * an embedded field (`sync.Mutex`) declares no name of its own, and Go names it
 * after the type it embeds — the last identifier of that type. A field that
 * still names nothing is left to the caller's own gap.
 */
function withEmbeddedField(names: readonly SyntaxNode[], node: SyntaxNode, text: string, go: boolean): readonly SyntaxNode[] {
  if (names.length > 0 || !go || node.type !== 'field_declaration') return names;
  const embedded = node.childForFieldName('type');
  if (embedded === null) return names;
  const identifiers = descendantsOfType(embedded, 'type_identifier');
  const last = identifiers[identifiers.length - 1];
  return last === undefined ? names : [last];
}

/**
 * The enum body a member node stands in, or `null` where it stands in none: a
 * bare `property_identifier` is an enum member only inside an `enum_body`, and
 * an `enum_assignment` (a member written with a value) is one anywhere in the
 * enum's own body.
 */
function enumMemberBody(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'enum_assignment') return node.parent;
  return node.parent?.type === 'enum_body' ? node.parent : null;
}

/**
 * What was not read, as the *question* the reader could not answer, naming the
 * place a coverage's gap may hold beside a *path* and a *kind of file*: the name
 * of a declaration it could not read, or the module an import names. Two of them
 * on one line stand apart, since the column is part of what was not read.
 */
function droppedAt(path: string, at: { readonly line: number; readonly column: number }, what: string): string {
  return `${what} at ${path}:${at.line}:${at.column}`;
}

/** The declaration's own name node, where a caller reads one declaration as one symbol. */
function nameNodeOf(node: SyntaxNode): SyntaxNode | null {
  return nameNodesOf(node)[0] ?? null;
}

/**
 * The shape of an identifier in every language this stage reads: a letter or
 * `_` or `$` first, then letters, digits, `_` or `$`. `\p{ID_Start}` is
 * Unicode's own rule for what a letter is, so a declaration named `café` or
 * `Ω` is read as the symbol it is rather than left out of a file this stage
 * would otherwise call complete, and a private class member keeps the `#` its
 * language writes it with.
 */
const IDENTIFIER = /^#?[\p{ID_Start}_$][\p{ID_Continue}_$]*$/u;

/**
 * Whether a name is one the schema can hold: `factId` refuses an identity part
 * that is empty *after trimming and collapsing its inner whitespace*
 * (`identityName`), so a name of spaces is as empty as an empty name — and such
 * a finding is the file's coverage gap rather than a fact the schema throws out
 * of.
 */
function named(text: string): boolean {
  return text.trim() !== '';
}

/**
 * The name a declaration qualifies its members by, which is the name it binds:
 * an identifier for every declaration but a module, whose own name is the
 * string it names (`declare module 'x'`).
 */
function declaredName(node: SyntaxNode, text: string): string | undefined {
  const held = (node.type === 'module' || node.type === 'internal_module') ? node.childForFieldName('name') : null;
  if (held !== null && stringNode(held) !== null) {
    const name = stringValue(text, held);
    return IDENTIFIER.test(name) ? name : undefined;
  }
  if (held !== null) return nestedName(text.slice(held.startIndex, held.endIndex));
  return nameOf(node, text);
}

/** A dotted name as a module writes it (`namespace A.B`), or `undefined` where it is no such name. */
function nestedName(written: string): string | undefined {
  return /^[\p{ID_Start}_$][\p{ID_Continue}_$]*(\.[\p{ID_Start}_$][\p{ID_Continue}_$]*)*$/u.test(written) ? written : undefined;
}

/** The name one declaration binds, or `undefined` where it binds none this stage can name. */
function nameOf(node: SyntaxNode, text: string): string | undefined {
  const named = nameNodeOf(node);
  if (named === null) return undefined;
  const name = text.slice(named.startIndex, named.endIndex);
  return IDENTIFIER.test(name) ? name : undefined;
}

/**
 * The name that holds an anonymous expression (`const f = () => { … }`, a
 * class or function expression assigned to a variable, or a pair's value): the
 * declarations inside it are qualified by what the reader calls it, rather than
 * standing at the file's own scope under a name that exists nowhere.
 */
function holderName(node: SyntaxNode, text: string): string | undefined {
  if (node.type !== 'arrow_function' && !ANONYMOUS_EXPRESSIONS.includes(node.type)) return undefined;
  const held = node.parent;
  if (held === null) return undefined;
  if (held.type === 'variable_declarator') return nameOf(held, text);
  if (held.type === 'pair' || held.type === 'public_field_definition' || held.type === 'field_definition') {
    const key = held.childForFieldName('key') ?? held.childForFieldName('name');
    if (key === null) return undefined;
    const name = text.slice(key.startIndex, key.endIndex);
    return IDENTIFIER.test(name) ? name : undefined;
  }
  return undefined;
}

/**
 * The type names a Go method's receiver declares, so the method is qualified by
 * the type it is a method of (`Handler.Serve`). A receiver is one of
 * `(h Handler)`, `(h *Handler)`, `(Handler)` or a generic `(h Handler[T])`; a
 * receiver this walk cannot name contributes nothing rather than a guess.
 */
function receiverNames(node: SyntaxNode, text: string): string[] {
  const receiver = node.childForFieldName('receiver');
  if (receiver === null) return [];
  const names: string[] = [];
  for (const parameter of descendantsOfType(receiver, 'parameter_declaration')) {
    const declared = parameter.childForFieldName('type');
    if (declared === null) continue;
    const named = declared.type === 'type_identifier' ? declared : descendantsOfType(declared, 'type_identifier')[0];
    if (named === undefined) continue;
    const name = text.slice(named.startIndex, named.endIndex);
    if (name !== '' && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The kind of an anonymous default export (`export default function () {}`), `undefined` for anything else. */
function anonymousDefaultKind(node: SyntaxNode, language: SyntaxLanguage): SymbolKind | undefined {
  if (language === 'go') return undefined;
  if (!ANONYMOUS_DEFAULT_SHAPES.includes(node.type)) return undefined;
  // `export default (class {})`, `(class {})!`, `(class {}) as unknown` and
  // `(class {}) satisfies unknown` write the expression inside something: the
  // statement is looked for above each of them.
  let parent = node.parent;
  while (parent !== null && ANONYMOUS_DEFAULT_WRAPPERS.includes(parent.type)) parent = parent.parent;
  if (parent === null || parent.type !== 'export_statement') return undefined;
  // A named export's declaration stands in `declaration`; an anonymous one, which
  // is what this branch is for, stands in the statement's `value`.
  const held = parent.childForFieldName('declaration') ?? parent.childForFieldName('value');
  if (held === null || held.startIndex > node.startIndex || node.endIndex > held.endIndex) return undefined;
  return node.type === 'class' ? 'class' : 'function';
}

/** The shapes an anonymous default export is written in: an expression of one of these. */
const ANONYMOUS_DEFAULT_SHAPES: readonly string[] = ['arrow_function', 'class', 'function', 'function_expression', 'generator_function'];

/** The wrappers an anonymous default export may stand inside, each walked through. */
const ANONYMOUS_DEFAULT_WRAPPERS: readonly string[] = [
  'as_expression', 'non_null_expression', 'parenthesized_expression', 'satisfies_expression', 'type_assertion',
];

/** Where a module's default export is named: the statement's own `default` keyword, or the expression itself. */
function defaultDefinitionSpan(node: SyntaxNode, spanOf: (node: SyntaxNode) => SyntaxSpan): SyntaxSpan {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.type === 'export_statement') {
      const keyword = parent.children.find((child): child is SyntaxNode => child !== null && child.type === 'default');
      return keyword === undefined ? spanOf(node) : spanOf(keyword);
    }
    if (parent.type === 'program') break;
  }
  return spanOf(node);
}

/** A qualified name: the container's names and the declaration's own, one dot between them. */
function qualified(container: readonly string[], name: string): string {
  return container.length === 0 ? name : `${container.join('.')}.${name}`;
}

/** The named type whose member this signature is, or `null` where no named type holds it. */
function namedTypeHolds(node: SyntaxNode, language: SyntaxLanguage): SyntaxNode | null {
  if (language === 'go') return null;
  const holder = node.parent;
  if (holder === null) return null;
  const owners = Object.hasOwn(NAMED_TYPE_HOLDERS, holder.type) ? NAMED_TYPE_HOLDERS[holder.type] : undefined;
  if (owners === undefined) return null;
  const owner = holder.parent;
  return owner !== null && owners.includes(owner.type) ? owner : null;
}

/**
 * Whether a declaration stands inside the *value* an export statement carries
 * rather than being what the statement exports: `export const o = { b() {} }`
 * exports `o`, and `b` is a member of the object `o` holds — no name another
 * module can call, and no way into the file.
 */
function withinExportedValue(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.type === 'object' || parent.type === 'pair' || parent.type === 'array' || parent.type === 'arguments') return true;
    if (parent.type === 'class_body' || parent.type === 'enum_body') return true;
    if (parent.type === 'export_statement' || parent.type === 'program' || parent.type === 'statement_block') return false;
  }
  return false;
}

/**
 * Whether the export statement a declaration stands in is an `export default`:
 * the name such a declaration carries is a binding inside its own module, and
 * what another module reaches is the default, not that name.
 */
function defaultExportCarries(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.type === 'export_statement') {
      return parent.children.some((child) => child !== null && child.type === 'default');
    }
    if (parent.type === 'program' || parent.type === 'statement_block') return false;
  }
  return false;
}

/** Whether any of a declaration's ancestors is an `export` statement, which exports it. */
function withinExport(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.type === 'export_statement') return true;
    if (parent.type === 'program' || parent.type === 'statement_block') return false;
  }
  return false;
}

/** The names a file's `export { ... }` clauses name, so a declaration they list is exported too. */
function exportedNamesByClause(root: SyntaxNode, text: string): Set<string> {
  const names = new Set<string>();
  for (const statement of descendantsOfType(root, 'export_statement')) {
    for (const specifier of descendantsOfType(statement, 'export_specifier')) {
      const named = specifier.childForFieldName('name');
      if (named !== null) names.add(text.slice(named.startIndex, named.endIndex));
    }
  }
  return names;
}

/**
 * What a file's own imports say about its test runners: the local name each
 * runner was bound to (`import { test } from 'bun:test'`, `import { test as
 * check }`), and the local name of each test package a file imported as a
 * namespace (`import * as runner from 'vitest'`, whose `runner.test(…)` is that
 * package's runner). A file that calls `test` or `it` with no import at all is
 * read with no framework named: the file says nothing about which runner knows
 * it, and a guess would be an invention.
 */
interface TestRunners {
  /** The local name each runner function was bound to, by that name. */
  readonly named: ReadonlyMap<string, string>;
  /** The local name each test package was imported as a namespace, by that name. */
  readonly namespaces: ReadonlyMap<string, string>;
}

/** A file with no test import at all: no runner is known by name or as a namespace. */
function emptyRunners(): TestRunners {
  return { named: new Map(), namespaces: new Map() };
}

function testRunners(root: SyntaxNode, text: string): TestRunners {
  const named = new Map<string, string>();
  const namespaces = new Map<string, string>();
  for (const statement of descendantsOfType(root, 'import_statement')) {
    const source = statement.childForFieldName('source');
    if (source === null) continue;
    const framework = TEST_FRAMEWORKS[stringValue(text, source)];
    if (framework === undefined) continue;
    for (const specifier of descendantsOfType(statement, 'import_specifier')) {
      const held = specifier.childForFieldName('name');
      if (held === null) continue;
      const imported = text.slice(held.startIndex, held.endIndex);
      if (imported !== 'test' && imported !== 'it') continue;
      // The name the file calls the runner by: its alias where it renamed it.
      const local = specifier.childForFieldName('alias') ?? held;
      named.set(text.slice(local.startIndex, local.endIndex), framework);
    }
    for (const namespace of descendantsOfType(statement, 'namespace_import')) {
      const local = namespace.namedChildren.find((child) => child !== null && child.type === 'identifier');
      if (local === null || local === undefined) continue;
      namespaces.set(text.slice(local.startIndex, local.endIndex), framework);
    }
  }
  return { named, namespaces };
}

/**
 * The runner `test`/`it` a call names, or `undefined` where the call is no test:
 * the identifier itself, or one of the runner's own modifiers standing on it
 * (`it.only`, `test.skip`, `test.each`) — the modifier's own call carries the
 * name, and the inner `test.each([…])` call carries a table, not a name.
 */
function testCall(callee: SyntaxNode, text: string, runners: TestRunners): { readonly framework?: string } | undefined {
  // `test.each([…])('name', …)` calls what `test.each([…])` answered: the
  // runner stands one call deeper, and its own call carries the table.
  if (callee.type === 'call_expression') {
    const inner = callee.childForFieldName('function');
    return inner === null ? undefined : testCall(inner, text, runners);
  }
  const textOf = (node: SyntaxNode): string => text.slice(node.startIndex, node.endIndex);
  /** The framework a name was imported from, where the file says which one it is. */
  const frameworkOf = (from: ReadonlyMap<string, string>, name: string | undefined): { readonly framework?: string } => {
    const framework = name === undefined ? undefined : from.get(name);
    return framework === undefined ? {} : { framework };
  };
  /** A call of a runner itself: `test`/`it`, or the name a file bound them to. */
  const runner = (node: SyntaxNode): { readonly framework?: string } | undefined => {
    if (node.type !== 'identifier') return undefined;
    const name = textOf(node);
    if (name === 'test' || name === 'it') return frameworkOf(runners.named, name);
    // `import { test as check } from 'bun:test'`: the file calls it `check`.
    return runners.named.has(name) ? frameworkOf(runners.named, name) : undefined;
  };
  const direct = runner(callee);
  if (direct !== undefined) return direct;
  if (callee.type !== 'member_expression') return undefined;
  const object = callee.childForFieldName('object');
  const property = callee.childForFieldName('property');
  if (object === null || property === null) return undefined;
  const named = textOf(property);
  // `it.only('name', …)`: the runner, carrying one of its own modifiers.
  if (TEST_MODIFIERS.includes(named)) return runner(object);
  // `runner.test('name', …)`: the runner reached through the namespace a file
  // imported (`import * as runner from 'bun:test'`), whose framework is the
  // namespace's own package and not whatever a local `test` was imported from.
  if (object.type === 'identifier' && (named === 'test' || named === 'it') && runners.namespaces.has(textOf(object))) {
    return frameworkOf(runners.namespaces, textOf(object));
  }
  return undefined;
}

/** Whether the file declares `package main`, which is what makes its `main` the program's entry point. */
function declaresMainPackage(root: SyntaxNode, text: string): boolean {
  for (const clause of descendantsOfType(root, 'package_clause')) {
    if (text.slice(clause.startIndex, clause.endIndex).trim() === 'package main') return true;
  }
  return false;
}

/**
 * Whether a Go function's name is one `go test` reports as a test, a benchmark
 * or a fuzz target: the prefix, then anything but a lower-case letter (the
 * runner's own rule: `Test`, `Test_x` and `Benchmark_Helper` are run, `Testme`
 * is not). `TestMain` is the runner's own entry point, not a test it reports.
 */
function isGoTestName(name: string): boolean {
  if (name === 'TestMain') return false;
  for (const prefix of ['Benchmark', 'Fuzz', 'Test']) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (rest === '' || !/^[a-z]/u.test(rest)) return true;
  }
  return false;
}

/** Every node of one type below a node, in the order the walk meets them. */
function descendantsOfType(root: SyntaxNode, type: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === type) found.push(node);
    for (const child of node.namedChildren) if (child !== null) visit(child);
  };
  visit(root);
  return found;
}

/** The first argument of a call that is a literal string, or `null` where the call's first argument is not one. */
function firstStringArgument(args: SyntaxNode | null): SyntaxNode | null {
  const first = args?.namedChildren.find((child) => child !== null) ?? null;
  if (first === null) return null;
  return stringNode(first) === null ? null : first;
}

/** The literal a node is or wraps (`string`, a Go `interpreted_string_literal`), or `null`. */
function stringNode(node: SyntaxNode): SyntaxNode | null {
  return node.type === 'string' || node.type === 'interpreted_string_literal' || node.type === 'raw_string_literal' || node.type === 'template_string' ? node : null;
}

/** The text a string literal holds, without its quotes. */
function stringValue(text: string, node: SyntaxNode): string {
  const written = text.slice(node.startIndex, node.endIndex);
  const first = written[0];
  const last = written[written.length - 1];
  if ((first === '"' || first === "'" || first === '`') && last === first) return written.slice(1, -1);
  return written;
}

/** A comment's form, by the markers it is written with. */
function commentForm(written: string): CommentForm {
  if (written.startsWith('//')) return 'line';
  if (written.startsWith('/**')) return 'doc';
  return 'block';
}

/**
 * A comment's text without its markers, as written: the `//` or the `/* … *&#47;`
 * is dropped, and a block comment's continuation lines lose the `*` that lines
 * them up. Nothing else is rewritten — the comment text is what a later agent
 * stage reads intent from (0026's stage 11), so it stays as the author wrote it.
 */
function commentText(written: string): string {
  if (written.startsWith('//')) return written.replace(/^\/\/ ?/u, '').replace(/\s+$/u, '');
  const inner = written.replace(/^\/\*+/u, '').replace(/\*+\/$/u, '');
  const lines = inner.split('\n').map((line) => line.replace(/^\s*\*? ?/u, '').replace(/\s+$/u, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ---- spans ----------------------------------------------------------------

/**
 * Where the lines of one file start, in characters and in bytes: one pass over
 * the text, so a finding's line, column and byte offset are read without
 * rescanning the file for every finding (a repository's file may be large).
 */
interface LineIndex {
  /** The character offset of each line's first character; `starts[0]` is 0. */
  readonly starts: readonly number[];
  /** The byte offset of each line's first character, in the file's own bytes. */
  readonly byteStarts: readonly number[];
  /**
   * The last character offset a byte offset was measured at, and the byte
   * offset there: a walk moving forward measures the distance it moved and not
   * the whole line, which is what a minified file (one very long line, many
   * declarations) needs. A span behind the cursor is measured from its own
   * line's first character instead, and does not move the cursor — measured,
   * moving it made a nested walk measure far more text for the same time.
   */
  readonly cursor: { index: number; byte: number };
}

function lineIndex(text: string): LineIndex {
  const starts = [0];
  const byteStarts = [0];
  let bytes = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    bytes += Buffer.byteLength(text.slice(starts[starts.length - 1]!, at + 1), 'utf8');
    starts.push(at + 1);
    byteStarts.push(bytes);
  }
  return { starts, byteStarts, cursor: { index: 0, byte: 0 } };
}

/** The line and column a character offset stands at: 1-based lines, 0-based UTF-16 columns. */
function positionAt(lines: LineIndex, offset: number): { line: number; column: number } {
  let low = 0;
  let high = lines.starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lines.starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - lines.starts[low]! };
}

/**
 * The byte offset a character offset stands at. A walk that keeps moving
 * forward measures only the distance it moved; a span behind the cursor is read
 * from the line it is on, which costs that line and never the file.
 */
function byteAt(lines: LineIndex, text: string, offset: number): number {
  if (offset < lines.cursor.index) {
    // A span behind the cursor is read from the first character of the line it
    // stands on, and the cursor stays where it was: measured, moving the cursor
    // back with it made a walk in and out of nested declarations measure 800
    // times more text for the same wall time, and this way costs one line.
    const line = positionAt(lines, offset).line - 1;
    return lines.byteStarts[line]! + Buffer.byteLength(text.slice(lines.starts[line]!, offset), 'utf8');
  }
  lines.cursor.byte += Buffer.byteLength(text.slice(lines.cursor.index, offset), 'utf8');
  lines.cursor.index = offset;
  return lines.cursor.byte;
}

/** The span between two character offsets of one file, in lines, columns and bytes. */
function spanAt(lines: LineIndex, text: string, startIndex: number, endIndex: number): SyntaxSpan {
  const start = positionAt(lines, startIndex);
  const end = positionAt(lines, endIndex);
  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
    startByte: byteAt(lines, text, startIndex),
    endByte: byteAt(lines, text, endIndex),
  };
}

/** The findings as they are, with the entries one key names kept once, the first of each in order. */
function dedupeBy<T>(entries: readonly T[], key: (entry: T) => string): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const entry of entries) {
    const id = key(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    kept.push(entry);
  }
  return kept;
}
