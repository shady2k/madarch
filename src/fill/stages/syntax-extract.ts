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
      return {
        path,
        language,
        parsed: true,
        ...findings,
        // A file the parser could not read whole is read as far as it went and
        // said so: the findings stand, and the gap carries the reason.
        unread: root.hasError ? [{ what: path, reason: 'error' }] : [],
      };
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
  'abstract_class_declaration', 'class_declaration', 'enum_declaration', 'function_declaration',
  'generator_function_declaration', 'interface_declaration', 'internal_module', 'method_definition', 'module',
];

const GO_CONTAINERS: readonly string[] = ['function_declaration', 'method_declaration', 'type_spec', 'field_declaration', 'const_spec', 'var_spec'];

/** The kind of symbol a TypeScript, TSX or JavaScript declaration is, by its node type. */
const TS_DECLARATIONS: Readonly<Record<string, SymbolKind>> = {
  'abstract_class_declaration': 'class',
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

/** One file's findings, before they become facts. */
interface Findings {
  symbols: readonly ExtractedSymbol[];
  comments: readonly ExtractedComment[];
  entryPoints: readonly ExtractedEntryPoint[];
  tests: readonly ExtractedTest[];
  imports: readonly ExtractedImport[];
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
  const go = language === 'go';
  // The names a file exports by clause (`export { later as renamed }`): a
  // declaration the clause names is exported although no `export` stands on it.
  const exportedByClause = go ? new Set<string>() : exportedNamesByClause(root, text);
  // Which package each local name of `test`/`it` came from, so the test's own
  // framework is the runner the file says it is, and nothing else.
  const testNames = go ? new Map<string, string>() : testIdentifiers(root, text);

  const record = (node: SyntaxNode, container: readonly string[]): void => {
    const type = node.type;
    if (!go && type === 'property_identifier' && node.parent?.type === 'enum_body') {
      // An enum's members are declared names of the enum's own scope: a member
      // written without a value is a bare identifier in the enum's body.
      const member = text.slice(node.startIndex, node.endIndex);
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(member)) {
        symbols.push({ name: member, qualifiedName: qualified(container, member), symbolKind: 'enum-member', span: spanOf(node), definitionSpan: spanOf(node) });
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
      if (specifier !== null) imports.push({ specifier: stringValue(text, specifier), span: spanOf(specifier) });
      return;
    }
    if (go && type === 'import_spec') {
      const quoted = node.childForFieldName('path');
      if (quoted !== null) imports.push({ specifier: stringValue(text, quoted), span: spanOf(quoted) });
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
        if (literal !== null) imports.push({ specifier: stringValue(text, literal), span: spanOf(literal) });
        return;
      }
      const literal = firstStringArgument(args);
      const runner = literal === null ? undefined : testCallName(callee, text);
      if (literal !== null && runner !== undefined) {
        // `test('name', ...)`, `it('name', ...)` and the runner's own modifiers
        // (`it.only('name', ...)`): the call's own name is the test's name, and
        // the framework is the one the file imported the runner from.
        const framework = testNames.get(runner);
        tests.push({ name: stringValue(text, literal), ...(framework === undefined ? {} : { framework }), span: spanOf(node) });
        return;
      }
      if (callee.type !== 'member_expression' || literal === null) return;
      const method = callee.childForFieldName('property');
      const methodName = method === null ? '' : text.slice(method.startIndex, method.endIndex);
      const named = stringValue(text, literal);
      if (methodName === COMMAND_METHOD && named !== '') {
        entryPoints.push({ name: named, form: 'cli-command', span: spanOf(literal) });
      } else if (ROUTE_METHODS.includes(methodName) && named.startsWith('/')) {
        entryPoints.push({ name: named, form: 'http-route', span: spanOf(literal) });
      }
      return;
    }
    const kind = symbolKindOf(node, language);
    const name = nameOf(node, text);
    if (kind === undefined || name === undefined || name === '') {
      // An anonymous default export is the one declaration without a name this
      // stage still knows: a module's default export is a symbol by that name.
      const anonymous = anonymousDefaultKind(node, language);
      if (anonymous === undefined) return;
      const inner: readonly string[] = [];
      symbols.push({ name: 'default', qualifiedName: qualified(inner, 'default'), symbolKind: anonymous, span: spanOf(node), definitionSpan: spanOf(node) });
      return;
    }
    const nameNode = nameNodeOf(node);
    // A Go method belongs to the type its receiver names: the receiver is what
    // makes it a method, and Go has no nesting to say it another way.
    const owned = go && type === 'method_declaration' ? [...container, ...receiverNames(node, text)] : container;
    symbols.push({
      name,
      qualifiedName: qualified(owned, name),
      symbolKind: kind,
      span: spanOf(node),
      definitionSpan: spanOf(nameNode ?? node),
    });
    // A module's export is a way into its code, which is what an entry point
    // of the form `library-export` is: a *top-level* declaration another
    // module may call, by a name it can reach. A method or a nested
    // declaration is no way in from outside the file.
    const exported = go ? /^\p{Lu}/u.test(name) : exportedByClause.has(name) || withinExport(node);
    if (exported && owned.length === 0) {
      entryPoints.push({ name, form: 'library-export', span: spanOf(nameNode ?? node) });
    }
    if (go && kind === 'function' && name === 'main' && declaresMainPackage(root, text)) {
      entryPoints.push({ name: 'main', form: 'main', span: spanOf(node) });
    }
    if (!go && kind === 'function' && name === 'main' && container.length === 0) {
      // A program's own `main`: the file declares the function a runner starts
      // at, whether it is exported for another module or called at the bottom.
      entryPoints.push({ name: 'main', form: 'main', span: spanOf(nameNode ?? node) });
    }
    if (go && kind === 'function' && isGoTestName(name) && path.endsWith('_test.go')) {
      tests.push({ name, framework: 'go-test', span: spanOf(node) });
    }
  };

  const visit = (node: SyntaxNode, container: readonly string[]): void => {
    record(node, container);
    const name = nameOf(node, text);
    const containers = go ? GO_CONTAINERS : TS_CONTAINERS;
    const inner = name !== undefined && name !== '' && containers.includes(node.type) ? [...container, name] : container;
    for (const child of node.namedChildren) {
      if (child !== null) visit(child, inner);
    }
  };
  visit(root, []);

  return {
    symbols: [...symbols].sort((left, right) => byCodePoint(left.qualifiedName, right.qualifiedName) || byCodePoint(left.symbolKind, right.symbolKind)),
    comments: [...comments].sort((left, right) => left.span.startByte - right.span.startByte),
    entryPoints: dedupeBy([...entryPoints].sort((left, right) => byCodePoint(left.form, right.form) || byCodePoint(left.name, right.name)), (entry) => `${entry.form}\u0000${entry.name}`),
    tests: dedupeBy([...tests].sort((left, right) => byCodePoint(left.name, right.name)), (one) => one.name),
    imports: [...imports].sort((left, right) => byCodePoint(left.specifier, right.specifier) || left.span.startByte - right.span.startByte),
  };
}

/** The kind of symbol one declaration is, by language; `undefined` where the node declares no symbol of this stage. */
function symbolKindOf(node: SyntaxNode, language: SyntaxLanguage): SymbolKind | undefined {
  if (language !== 'go') {
    if (node.type === 'variable_declarator') {
      const declaration = node.parent;
      const keyword = declaration?.children[0]?.type ?? '';
      const value = node.childForFieldName('value');
      if (value !== null && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function')) return 'function';
      if (keyword === 'const') return 'constant';
      return keyword === 'let' || keyword === 'var' ? 'variable' : undefined;
    }
    return TS_DECLARATIONS[node.type];
  }
  switch (node.type) {
    case 'function_declaration': return 'function';
    case 'method_declaration': return 'method';
    case 'const_spec': return 'constant';
    case 'var_spec': return 'variable';
    case 'field_declaration': return 'field';
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

/** The declaration's own name node: the `name` field, the JavaScript class field's `property`, or the Go spec's first name. */
function nameNodeOf(node: SyntaxNode): SyntaxNode | null {
  const named = node.childForFieldName('name');
  if (named !== null) return named;
  const property = node.childForFieldName('property');
  if (property !== null && (property.type === 'property_identifier' || property.type === 'private_property_identifier')) return property;
  return null;
}

/** The name one declaration binds, or `undefined` where it binds none this stage can name. */
function nameOf(node: SyntaxNode, text: string): string | undefined {
  const named = nameNodeOf(node);
  if (named === null) return undefined;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(text.slice(named.startIndex, named.endIndex))) return undefined;
  return text.slice(named.startIndex, named.endIndex);
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
  if (node.type !== 'function_expression' && node.type !== 'arrow_function' && node.type !== 'function' && node.type !== 'class') return undefined;
  const parent = node.parent;
  if (parent === null || parent.type !== 'export_statement') return undefined;
  const declaration = parent.childForFieldName('declaration');
  if (declaration === null || declaration.startIndex !== node.startIndex) return undefined;
  return node.type === 'class' ? 'class' : 'function';
}

/** A qualified name: the container's names and the declaration's own, one dot between them. */
function qualified(container: readonly string[], name: string): string {
  return container.length === 0 ? name : `${container.join('.')}.${name}`;
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

/** Which local name each `test`/`it` of a file is, by the package the file imports it from. */
function testIdentifiers(root: SyntaxNode, text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const statement of descendantsOfType(root, 'import_statement')) {
    const source = statement.childForFieldName('source');
    if (source === null) continue;
    const framework = TEST_FRAMEWORKS[stringValue(text, source)];
    if (framework === undefined) continue;
    for (const specifier of descendantsOfType(statement, 'import_specifier')) {
      const named = specifier.childForFieldName('name');
      if (named === null) continue;
      const local = specifier.childForFieldName('alias') ?? named;
      const localName = text.slice(local.startIndex, local.endIndex);
      if (localName === 'test' || localName === 'it') found.set(localName, framework);
    }
  }
  // A file that calls `test` or `it` with no import at all is read with no
  // framework named: the file says nothing about which runner knows it, and a
  // guess would be an invention.
  return found;
}

/**
 * The runner `test`/`it` a call names, or `undefined` where the call is no test:
 * the identifier itself, or one of the runner's own modifiers standing on it
 * (`it.only`, `test.skip`, `test.each`) — the modifier's own call carries the
 * name, and the inner `test.each([…])` call carries a table, not a name.
 */
function testCallName(callee: SyntaxNode, text: string): string | undefined {
  // `test.each([…])('name', …)` calls what `test.each([…])` answered: the
  // runner stands one call deeper, and its own call carries the table.
  if (callee.type === 'call_expression') {
    const inner = callee.childForFieldName('function');
    return inner === null ? undefined : testCallName(inner, text);
  }
  const identifier = (node: SyntaxNode): string | undefined => {
    if (node.type !== 'identifier') return undefined;
    const name = text.slice(node.startIndex, node.endIndex);
    return name === 'test' || name === 'it' ? name : undefined;
  };
  const direct = identifier(callee);
  if (direct !== undefined) return direct;
  if (callee.type !== 'member_expression') return undefined;
  const object = callee.childForFieldName('object');
  const property = callee.childForFieldName('property');
  if (object === null || property === null) return undefined;
  const modifier = text.slice(property.startIndex, property.endIndex);
  return TEST_MODIFIERS.includes(modifier) ? identifier(object) : undefined;
}

/** Whether the file declares `package main`, which is what makes its `main` the program's entry point. */
function declaresMainPackage(root: SyntaxNode, text: string): boolean {
  for (const clause of descendantsOfType(root, 'package_clause')) {
    if (text.slice(clause.startIndex, clause.endIndex).trim() === 'package main') return true;
  }
  return false;
}

/** Whether a Go function's name is one the `testing` package runs: `Test…`, `Benchmark…` or `Fuzz…`. */
function isGoTestName(name: string): boolean {
  for (const prefix of ['Benchmark', 'Fuzz', 'Test']) {
    if (name.startsWith(prefix) && name.length > prefix.length && /[A-Z0-9_]/u.test(name[prefix.length]!) && !name.startsWith(`${prefix}_`)) return true;
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
  return { starts, byteStarts };
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

/** The byte offset a character offset stands at, read from the line it is on. */
function byteAt(lines: LineIndex, text: string, offset: number): number {
  const line = positionAt(lines, offset).line - 1;
  return lines.byteStarts[line]! + Buffer.byteLength(text.slice(lines.starts[line]!, offset), 'utf8');
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
