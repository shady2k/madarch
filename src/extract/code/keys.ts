/**
 * The code-structure extractor's vocabulary (madarch-o0eq.6, decision 0028):
 * every kind and relation type stands under `code.`, and every key is built
 * from stable parts of the bytes it was read from, never from a run, a date or
 * a database id.
 *
 * One key shape names a symbol in every extractor: `code.symbol:<path>#<qualified
 * name>`. The data-model extractor keys the functions its table accesses start
 * from with the same builder (`functionKey`), and the contracts extractor names
 * the handler of a route by `handlerKey`, so a symbol that two extractors speak
 * of is one node.
 */

/** The producer id every record of this extractor carries. */
export const CODE_PRODUCER = 'code.extract.code' as const;

// ---- node kinds -----------------------------------------------------------

export const KIND_SYMBOL = 'code.symbol';
export const KIND_FILE = 'code.file';
export const KIND_MODULE = 'code.module';
export const KIND_PACKAGE = 'code.package';
export const KIND_TEST_CASE = 'code.test-case';
export const KIND_CYCLE = 'code.cycle';
/** A TODO or FIXME marker in a comment; the code section of the Problems page reads it (madarch-m38l.19). */
export const KIND_DEBT = 'code.debt';

// ---- relation types -------------------------------------------------------

/** A package contains modules, a module files, a file the symbols it declares. */
export const REL_CONTAINS = 'code.contains';
/** A file imports a file (TypeScript) or a package folder (Go) of the repository. */
export const REL_IMPORTS = 'code.imports';
/** A module depends on another: the imports of the first's files, aggregated. */
export const REL_DEPENDS_ON = 'code.depends-on';
/** A symbol calls a symbol: every call site of the pair, aggregated. */
export const REL_CALLS = 'code.calls';
/** A symbol mentions a symbol without calling it. */
export const REL_REFERENCES = 'code.references';
/** A resolved field, property, variable or constant is read at a use site. */
export const REL_READS = 'code.reads';
/** A resolved field, property or variable is written at a use site. */
export const REL_WRITES = 'code.writes';
/** A declaration or function uses a resolved repository type. */
export const REL_USES_TYPE = 'code.uses-type';
/** A symbol extends (inherits from) a symbol. */
export const REL_INHERITS = 'code.inherits';
/** A type implements an interface, by declaration or (Go) by its method set. */
export const REL_IMPLEMENTS = 'code.implements';
/** One place a symbol's name is read or written, positioned. */
export const REL_OCCURRENCE = 'code.occurrence';
/** A test case exercises a symbol of the code under test. */
export const REL_TESTS = 'code.tests';
/** A module or file takes part in an import cycle. */
export const REL_CYCLE_MEMBER = 'code.cycle-member';

// ---- key builders ---------------------------------------------------------

/** `code.symbol:<path>#<qualified name>` -- one declaration of a file. */
export const symbolKey = (path: string, qualifiedName: string): string => `${KIND_SYMBOL}:${path}#${qualifiedName}`;

/** The key the contracts extractor gives the handler of a route: the symbol's key. */
export const handlerKey = symbolKey;

/** `code.file:<path>` -- the data-model extractor's file key, shared. */
export const fileKey = (path: string): string => `${KIND_FILE}:${path}`;

/** `code.module:<folder>` -- a Go package or a TypeScript folder. */
export const moduleKey = (folder: string): string => `${KIND_MODULE}:${folder === '' ? '.' : folder}`;

/** `code.package:<folder>` -- the root of a go.mod or a package.json. */
export const packageKey = (folder: string): string => `${KIND_PACKAGE}:${folder === '' ? '.' : folder}`;

/** `code.test-case:<path>#<suite path> > <name>` -- one test case of a test file. */
export const testCaseKey = (path: string, name: string, ordinal: number): string => `${KIND_TEST_CASE}:${path}#${name}${ordinal === 0 ? '' : `~${ordinal}`}`;

/** `code.debt:<path>#<byte>` -- one TODO or FIXME marker, at the comment's first byte. */
export const debtKey = (path: string, byteStart: number): string => `${KIND_DEBT}:${path}#${byteStart}`;

/** `code.cycle:<level>/<member>+<member>...` -- one import cycle, its members in code point order. */
export const cycleKey = (level: 'module' | 'file', members: readonly string[]): string => `${KIND_CYCLE}:${level}/${members.join('+')}`;

/** An actual inline registration callback, named from its enclosing declaration and byte position. */
export const callbackName = (enclosing: string | undefined, route: string, line: number, byte: number): string => `${enclosing ?? route}.callback@${line}:${byte}`;
