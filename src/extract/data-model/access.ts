/**
 * Which function reads or writes which table (madarch-o0eq.2): the sites a
 * code file holds - SQL string literals passed to `database/sql` calls, Prisma
 * client calls, and raw SQL built for `$queryRawUnsafe` - each attributed to
 * the innermost function region that holds it, with the byte span of the site
 * itself. Pure over the file's bytes and the symbol spans the pure syntax
 * reader (`src/fill/stages/syntax-extract.ts`) found; this module imports that
 * reader and edits none of it.
 *
 * Nothing here reads a pattern of a file's characters (madarch-mwhd.3). The
 * strings (every literal the grammar delimits: single and double quotes, and
 * TypeScript's template strings), the calls and the `const` functions come from
 * the file's own tree; a literal's SQL comes from PostgreSQL's parser, and
 * where a literal is only a fragment of a statement - the legacy report builds
 * its SQL by `+` from `' FROM payments p'` and `' LEFT JOIN ...'` - from
 * PostgreSQL's own lexer, which is the authority on the clause keywords and the
 * names that follow them.
 *
 * The file is parsed once more than the syntax stage parses it: that stage
 * answers the symbols of `extractFileSyntax`, whose tree it does not lend, and
 * this reader walks a tree of its own for the strings, the calls and the `const`
 * bodies. One parse for both would need the stage to hand its tree out.
 *
 * The regions are the syntax reader's declarations of function, method,
 * constant and variable kind. A TypeScript `const name = async (...) => {...}`
 * the syntax reader does not declare (an anonymous function expression holds
 * it) is found by the tree's own `const` declarators, so the legacy report's
 * builders are not a silence. A SQL literal or a Prisma call that no region
 * holds is reported with no region; the caller decides what carries it, and
 * never drops it silently.
 */
import {scan, type ScanToken} from 'libpg-query';
import type {Node as SyntaxNode} from 'web-tree-sitter';
import {extractFileSyntax, readSyntaxTree, type ExtractedFileSyntax, type ParsedSyntaxTree, type SyntaxSpan} from '../../fill/stages/syntax-extract.js';
import {parsePostgres, type ParseResult} from '../../parsers/postgres.js';
import type {SourceSpan} from '../records.js';
import {ByteText} from './text-scan.js';

/** The languages whose files this reader scans for table access. */
export type AccessLanguage = 'go' | 'javascript' | 'tsx' | 'typescript';

export interface FunctionRegion {
  /** The name a reader sees, qualified by what holds it (`OrderRepository.Create`). */
  readonly qualifiedName: string;
  /** The symbol kind the syntax reader gave it (`method`, `function`, `constant`). */
  readonly symbolKind: string;
  readonly language: AccessLanguage;
  /** The whole declaration's span, in the file's own bytes. */
  readonly span: SourceSpan;
}

/** One table access at one place: the verb, the table's name as written, and the site. */
export interface AccessSite {
  readonly table: string;
  readonly verb: 'read' | 'write';
  readonly via: 'sql' | 'prisma-client';
  /** The model name a Prisma call went through, where the access is a Prisma client call. */
  readonly model?: string;
  /** The region that holds the site, by its qualified name. */
  readonly region: string;
  /** The site's own span: the SQL literal's content or the call expression. */
  readonly span: SourceSpan;
}

/** One CREATE TABLE a code literal declares (the migration runner's schema_migrations, say). */
export interface CodeTableDeclaration {
  readonly table: string;
  readonly span: SourceSpan;
}

/** What one file's scan found: its regions, its access sites and the DDL its literals declare. */
export interface FileAccess {
  readonly path: string;
  readonly language: AccessLanguage | null;
  readonly regions: readonly FunctionRegion[];
  readonly sites: readonly AccessSite[];
  readonly tableDeclarations: readonly CodeTableDeclaration[];
  /** What could not be read, from the syntax reader's own gaps. */
  readonly unread: readonly {readonly what: string; readonly reason: string}[];
}

/** The Prisma client operations that write, in code point order. */
const PRISMA_WRITE_OPS = new Set(['create', 'createMany', 'delete', 'deleteMany', 'update', 'updateMany', 'upsert']);
/** The Prisma client operations that read, in code point order. */
const PRISMA_READ_OPS = new Set(['aggregate', 'count', 'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow', 'groupBy']);

const REGIONS_OF_INTEREST = new Set(['function', 'method', 'constant', 'variable']);

/** The grammar's nodes whose own range is delimited by the string's quotes, template strings included. */
const STRING_NODES = new Set(['interpreted_string_literal', 'raw_string_literal', 'string', 'template_string']);

/** The expressions a `const`'s value may be and still be read as a function region. */
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'generator_function']);

/**
 * Reads one file's bytes for table access. `path` names the file in every
 * span; the file's own tree and PostgreSQL's own syntax decide everything else.
 */
export async function extractFileAccess(path: string, input: Uint8Array): Promise<FileAccess> {
  const syntax = await extractFileSyntax(path, input);
  const language = languageOfPath(path);
  if (language === null) {
    return {path, language: null, regions: [], sites: [], tableDeclarations: [], unread: gapsOf(syntax.unread)};
  }
  const unread = gapsOf(syntax.unread);
  const read = await readSyntaxTree(path, input, (file) => readCodeTree(file, language));
  if (!read.read) {
    // A file with no readable tree has no strings, calls or `const` bodies of
    // its own: the syntax reader's own gap says why, and the caller publishes it.
    return {path, language, regions: collectRegions(path, language, syntax), sites: [], tableDeclarations: [], unread};
  }
  const code = read.value;
  const bytes = new ByteText(code.text);
  const regions = withConstRegions(collectRegions(path, language, syntax), code.constRegions, path, bytes, language);
  const regionOf = regionFinder(regions);
  const sites: AccessSite[] = [];
  const tableDeclarations: CodeTableDeclaration[] = [];
  for (const literal of code.strings) {
    const facts = await sqlFactsOf(code.text.slice(literal.start, literal.end));
    if (facts.inserts.length === 0 && facts.updates.length === 0 && facts.deletes.length === 0
      && facts.reads.length === 0 && facts.declarations.length === 0) continue;
    // A literal no function region holds keeps the empty region name: the
    // caller attributes it to the file itself, and never drops it.
    const holder = regionOf(bytes.byteAt(literal.start), bytes.byteAt(literal.end));
    const regionName = holder?.qualifiedName ?? '';
    // The call a SQL literal stands in (`tx.ExecContext(ctx, \`INSERT INTO
    // outbox ...)\``) is the site the access cites; a literal no call holds is
    // cited where it stands.
    const call = enclosingCall(code.calls, literal.start, literal.end);
    const byteStart = bytes.byteAt(call === undefined ? literal.start : call.start);
    const byteEnd = bytes.byteAt(call === undefined ? literal.end : call.end);
    const span: SourceSpan = {path, byteStart, byteEnd, lineStart: bytes.lineOf(byteStart), lineEnd: bytes.lineOf(byteEnd)};
    for (const site of sqlSites(facts, span, regionName)) sites.push(site);
    for (const declaration of sqlDeclarations(facts, span)) tableDeclarations.push(declaration);
  }
  // Prisma client calls: `this.prisma.<model>.<op>(...)` or `prisma.<model>.<op>(...)`.
  for (const call of code.prisma) {
    const verb = PRISMA_WRITE_OPS.has(call.op) ? 'write' : PRISMA_READ_OPS.has(call.op) ? 'read' : undefined;
    if (verb === undefined) continue;
    const byteStart = bytes.byteAt(call.start);
    const byteEnd = bytes.byteAt(call.end);
    const holder = regionOf(byteStart, byteEnd);
    sites.push({
      table: call.model,
      verb,
      via: 'prisma-client',
      model: call.model,
      region: holder?.qualifiedName ?? '',
      span: {path, byteStart, byteEnd, lineStart: bytes.lineOf(byteStart), lineEnd: bytes.lineOf(byteEnd)},
    });
  }
  return {
    path,
    language,
    regions,
    sites: sites.sort((left, right) => left.span.byteStart - right.span.byteStart || byCodePointOf(left.region, right.region)),
    tableDeclarations,
    unread,
  };
}

function gapsOf(unread: readonly {readonly what: string; readonly reason: string}[]): readonly {readonly what: string; readonly reason: string}[] {
  return [...unread].sort((left, right) => byCodePointOf(left.what, right.what) || byCodePointOf(left.reason, right.reason));
}

function languageOfPath(path: string): AccessLanguage | null {
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
  if (extension === '.go') return 'go';
  if (extension === '.ts' || extension === '.mts' || extension === '.cts') return 'typescript';
  if (extension === '.tsx') return 'tsx';
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs' || extension === '.jsx') return 'javascript';
  return null;
}

// ---- what the file's tree holds -------------------------------------------

/** A character range of the file's text, as the grammar counts it. */
interface CharSpan {
  readonly start: number;
  readonly end: number;
}

/** One call expression: the whole invocation, and the argument list its parens delimit. */
interface CallSpan extends CharSpan {
  readonly argsStart: number;
  readonly argsEnd: number;
}

/** One Prisma client call: the model and operation names the grammar read, and the span the reader cites. */
interface PrismaCall extends CharSpan {
  readonly model: string;
  readonly op: string;
}

/** One `const <name> = <function>` the syntax reader did not declare, at the name and the body's close. */
interface ConstRegion extends CharSpan {
  readonly name: string;
}

/** Everything this reader takes from one file's tree, as plain data: no node outlives the walk. */
interface CodeTree {
  readonly text: string;
  readonly strings: readonly CharSpan[];
  readonly calls: readonly CallSpan[];
  readonly prisma: readonly PrismaCall[];
  readonly constRegions: readonly ConstRegion[];
}

/** Visits a node and every node below it, pre-order. */
function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child !== null) walk(child, visit);
  }
}

function readCodeTree(file: ParsedSyntaxTree, language: AccessLanguage): CodeTree {
  const strings: CharSpan[] = [];
  const calls: CallSpan[] = [];
  const prisma: PrismaCall[] = [];
  const constRegions: ConstRegion[] = [];
  walk(file.root, (node) => {
    // A string's content is strictly between its quotes, in every grammar here.
    if (STRING_NODES.has(node.type) && node.endIndex >= node.startIndex + 2) {
      strings.push({start: node.startIndex + 1, end: node.endIndex - 1});
    }
    // An invocation's own range is the site a literal inside its arguments is
    // cited at; `new Error(...)` invokes where its constructor stands, so the
    // citation starts at the name a reader sees.
    if (node.type === 'call_expression' || node.type === 'new_expression') {
      const args = node.childForFieldName('arguments');
      if (args !== null) {
        const invoked = node.type === 'new_expression' ? node.childForFieldName('constructor') ?? node : node;
        calls.push({start: invoked.startIndex, end: node.endIndex, argsStart: args.startIndex, argsEnd: args.endIndex});
        const called = node.type === 'call_expression' ? prismaCallOf(node, args.startIndex) : undefined;
        if (called !== undefined) prisma.push(called);
      }
    }
    // A `const name = (...) => {...}` the syntax reader does not declare: the
    // legacy report's report builders. The grammar says what the value is, so
    // no spelling of it is read.
    if (language !== 'go' && node.type === 'variable_declarator') {
      const region = constFunctionOf(node);
      if (region !== undefined) constRegions.push(region);
    }
  });
  return {text: file.text, strings, calls, prisma, constRegions};
}

/** The name a member expression reads off, where the grammar wrote it as a plain name. */
function propertyName(member: SyntaxNode): string | undefined {
  const property = member.childForFieldName('property');
  if (property === null) return undefined;
  if (property.type === 'property_identifier' || property.type === 'identifier') return property.text;
  return undefined;
}

/**
 * The Prisma client call `prisma.<model>.<op>(` / `this.prisma.<model>.<op>(`
 * a call expression makes, or `undefined` where it makes none. The client, the
 * model and the operation are the grammar's own members; the span the reader
 * cites runs from the client to the opening paren, as the site always has.
 */
function prismaCallOf(call: SyntaxNode, argsStart: number): PrismaCall | undefined {
  const callee = call.childForFieldName('function');
  if (callee === null || callee.type !== 'member_expression') return undefined;
  const op = propertyName(callee);
  const model = callee.childForFieldName('object');
  if (op === undefined || model === null || model.type !== 'member_expression') return undefined;
  const name = propertyName(model);
  const client = model.childForFieldName('object');
  if (name === undefined || client === null || !isPrismaClient(client)) return undefined;
  return {model: name, op, start: call.startIndex, end: argsStart + 1};
}

/** Whether an expression is the Prisma client: the bare `prisma`, or `this.prisma`. */
function isPrismaClient(node: SyntaxNode): boolean {
  if (node.type === 'identifier') return node.text === 'prisma';
  if (node.type !== 'member_expression' || propertyName(node) !== 'prisma') return false;
  const object = node.childForFieldName('object');
  return object !== null && object.type === 'this';
}

/** The region a `const <name> = <function> {...}` declares, where its value is a function body. */
function constFunctionOf(declarator: SyntaxNode): ConstRegion | undefined {
  const declaration = declarator.parent;
  if (declaration === null || declaration.type !== 'lexical_declaration') return undefined;
  if (declaration.child(0)?.type !== 'const') return undefined;
  const name = declarator.childForFieldName('name');
  const value = declarator.childForFieldName('value');
  if (name === null || name.type !== 'identifier' || value === null || !FUNCTION_VALUES.has(value.type)) return undefined;
  const body = value.childForFieldName('body');
  if (body === null || body.type !== 'statement_block') return undefined;
  return {name: name.text, start: name.startIndex, end: body.endIndex};
}

/** The innermost call whose argument list holds the character range: the call a literal stands in. */
function enclosingCall(calls: readonly CallSpan[], start: number, end: number): CallSpan | undefined {
  let innermost: CallSpan | undefined;
  for (const call of calls) {
    if (!(call.argsStart < start && end < call.argsEnd)) continue;
    if (innermost === undefined || call.argsStart > innermost.argsStart) innermost = call;
  }
  return innermost;
}

// ---- the SQL one literal holds -------------------------------------------

/**
 * The table accesses and the CREATE TABLE declarations one SQL text holds, by
 * statement kind, each list in the order the text writes them.
 */
interface SqlFacts {
  readonly inserts: readonly string[];
  readonly updates: readonly string[];
  readonly deletes: readonly string[];
  readonly reads: readonly string[];
  readonly declarations: readonly string[];
}

const NO_FACTS: SqlFacts = {inserts: [], updates: [], deletes: [], reads: [], declarations: []};

/**
 * The SQL one literal's content holds. PostgreSQL's parser answers a statement,
 * with its own reading of quoting, case folding and statement boundaries. A
 * literal that is only a fragment of a statement has no statement to parse -
 * and no reader can make one out of `' FROM payments p'` - so PostgreSQL's
 * lexer answers its clause keywords and the names that follow them instead.
 */
async function sqlFactsOf(content: string): Promise<SqlFacts> {
  let tokens: readonly ScanToken[];
  try {
    tokens = (await scan(content)).tokens;
  } catch {
    // Bytes the lexer cannot read are no SQL this reader claims.
    return NO_FACTS;
  }
  if (!holdsClause(tokens)) return NO_FACTS;
  let parsed: ParseResult;
  try {
    parsed = await parsePostgres(content);
  } catch {
    return fragmentFacts(tokens);
  }
  return statementFacts(parsed);
}

/** Whether a lexer token is the SQL keyword `name`: the lexer says a keyword, and its spelling is that keyword. */
function keyword(token: ScanToken | undefined, name: string): boolean {
  return token !== undefined && token.keywordKind !== 0 && token.text.toUpperCase() === name;
}

/**
 * Whether a lexer token is a name: an identifier, or a word the lexer read as a
 * keyword - a table may carry a keyword's spelling (`FROM method`), and the
 * grammar that reads the statement accepts it there.
 */
function nameToken(token: ScanToken | undefined): boolean {
  if (token === undefined) return false;
  return token.tokenName === 'IDENT' || token.keywordKind !== 0;
}

/**
 * Whether a token stream names a statement's verb or a clause that reads a
 * table: the seven shapes the reader answers, so a literal that holds none of
 * them is no SQL literal and costs no parse.
 */
function holdsClause(tokens: readonly ScanToken[]): boolean {
  for (let at = 0; at < tokens.length; at++) {
    if (keyword(tokens[at], 'SELECT') || keyword(tokens[at], 'FROM') || keyword(tokens[at], 'JOIN')) return true;
    if (keyword(tokens[at], 'INSERT') && keyword(tokens[at + 1], 'INTO')) return true;
    if (keyword(tokens[at], 'UPDATE') && nameToken(tokens[at + 1]) && keyword(tokens[at + 2], 'SET')) return true;
    if (keyword(tokens[at], 'DELETE') && keyword(tokens[at + 1], 'FROM')) return true;
    if (keyword(tokens[at], 'CREATE') && keyword(tokens[at + 1], 'TABLE')) return true;
  }
  return false;
}

/** The name a name token holds, without the quotes the grammar wrote around it. */
function tokenName(token: ScanToken | undefined): string | undefined {
  if (token === undefined || !nameToken(token)) return undefined;
  const text = token.text;
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') return text.slice(1, -1);
  return text;
}

/**
 * The facts of a literal that is a fragment of a statement: the clauses the
 * lexer's keywords open, and the names its identifiers write after them. The
 * FROM of a DELETE is that delete, never a read of its own.
 */
function fragmentFacts(tokens: readonly ScanToken[]): SqlFacts {
  const inserts: string[] = [];
  const updates: string[] = [];
  const deletes: string[] = [];
  const reads: string[] = [];
  const declarations: string[] = [];
  const deletedFrom = new Set<number>();
  for (let at = 0; at < tokens.length; at++) {
    if (keyword(tokens[at], 'INSERT') && keyword(tokens[at + 1], 'INTO')) {
      const table = tokenName(tokens[at + 2]);
      if (table !== undefined) inserts.push(table);
      continue;
    }
    if (keyword(tokens[at], 'UPDATE') && nameToken(tokens[at + 1]) && keyword(tokens[at + 2], 'SET')) {
      const table = tokenName(tokens[at + 1]);
      if (table !== undefined) updates.push(table);
      continue;
    }
    if (keyword(tokens[at], 'DELETE') && keyword(tokens[at + 1], 'FROM')) {
      const table = tokenName(tokens[at + 2]);
      if (table !== undefined) deletes.push(table);
      deletedFrom.add(at + 1);
      continue;
    }
    if (keyword(tokens[at], 'CREATE') && keyword(tokens[at + 1], 'TABLE')) {
      const table = declaredTable(tokens, at + 2);
      if (table !== undefined) declarations.push(table);
    }
  }
  for (let at = 0; at < tokens.length; at++) {
    if (keyword(tokens[at], 'FROM') && !deletedFrom.has(at)) {
      const table = tokenName(tokens[at + 1]);
      if (table !== undefined) reads.push(table);
      continue;
    }
    if (keyword(tokens[at], 'JOIN')) {
      const table = tokenName(tokens[at + 1]);
      if (table !== undefined) reads.push(table);
    }
  }
  return {inserts, updates, deletes, reads, declarations};
}

/**
 * The table a `CREATE TABLE` names, from the token after TABLE: `IF NOT
 * EXISTS` is skipped, a schema qualification is dropped (the reader cites the
 * table's own name), and the declaration's column list must follow.
 */
function declaredTable(tokens: readonly ScanToken[], from: number): string | undefined {
  let at = from;
  if (keyword(tokens[at], 'IF') && keyword(tokens[at + 1], 'NOT') && keyword(tokens[at + 2], 'EXISTS')) at += 3;
  let table = tokenName(tokens[at]);
  if (table === undefined) return undefined;
  if (tokens[at + 1]?.text === '.') {
    table = tokenName(tokens[at + 2]);
    at += 2;
  }
  return tokens[at + 3]?.text === '(' ? table : undefined;
}

/** The facts of a statement PostgreSQL parsed: the tables its own nodes name. */
function statementFacts(parsed: ParseResult): SqlFacts {
  const inserts: {readonly table: string; readonly at: number}[] = [];
  const updates: {readonly table: string; readonly at: number}[] = [];
  const deletes: {readonly table: string; readonly at: number}[] = [];
  const reads: {readonly table: string; readonly at: number}[] = [];
  const declarations: string[] = [];
  const named = (entries: readonly {readonly table: string; readonly at: number}[]): string[] =>
    [...entries].sort((left, right) => left.at - right.at).map((entry) => entry.table);
  const target = (value: unknown, into: {readonly table: string; readonly at: number}[]): void => {
    const range = record(value);
    const table = string(range?.relname);
    if (range !== undefined && table !== undefined) into.push({table, at: locationOf(range)});
  };
  // A source of a FROM clause is a table (`{RangeVar: ...}`), a join of two
  // sources, or something else (a subquery, a function call) whose own
  // statements the walk below meets.
  const source = (value: unknown): void => {
    const node = record(value);
    if (node === undefined) return;
    const join = record(node.JoinExpr);
    if (join !== undefined) {
      source(join.larg);
      source(join.rarg);
      return;
    }
    target(node.RangeVar, reads);
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = record(value);
    if (node === undefined) return;
    const insert = record(node.InsertStmt);
    if (insert !== undefined) target(insert.relation, inserts);
    const update = record(node.UpdateStmt);
    if (update !== undefined) target(update.relation, updates);
    const remove = record(node.DeleteStmt);
    if (remove !== undefined) target(remove.relation, deletes);
    const create = record(node.CreateStmt);
    if (create !== undefined) {
      const table = string(record(create.relation)?.relname);
      if (table !== undefined) declarations.push(table);
    }
    const select = record(node.SelectStmt);
    if (select !== undefined) for (const item of list(select.fromClause)) source(item);
    for (const child of Object.values(node)) visit(child);
  };
  for (const statement of parsed.stmts ?? []) visit(statement.stmt);
  return {inserts: named(inserts), updates: named(updates), deletes: named(deletes), reads: named(reads), declarations};
}

type RecordNode = {[key: string]: unknown};
const record = (value: unknown): RecordNode | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordNode : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
/** Where a node stands in the text PostgreSQL read; a node the parser wrote at 0 omits its place. */
const locationOf = (node: RecordNode): number => typeof node['location'] === 'number' ? node['location'] : 0;

/** The table accesses one SQL text holds, each at the literal's own span, named once. */
function sqlSites(facts: SqlFacts, span: SourceSpan, region: string): readonly AccessSite[] {
  const sites = new Map<string, AccessSite>();
  const push = (table: string, verb: 'read' | 'write'): void => {
    if (table === '' || beginsWithDigit(table)) return;
    const key = `${verb} ${table}`;
    if (!sites.has(key)) sites.set(key, {table, verb, via: 'sql', region, span});
  };
  for (const table of facts.inserts) push(table, 'write');
  for (const table of facts.updates) push(table, 'write');
  for (const table of facts.deletes) push(table, 'write');
  for (const table of facts.reads) push(table, 'read');
  return [...sites.values()];
}

/** The CREATE TABLE declarations one SQL text holds, at the literal's own span. */
function sqlDeclarations(facts: SqlFacts, span: SourceSpan): readonly CodeTableDeclaration[] {
  return facts.declarations.map((table) => ({table, span}));
}

function beginsWithDigit(name: string): boolean {
  const code = name.charCodeAt(0);
  return code >= 0x30 && code <= 0x39;
}

// ---- the regions ----------------------------------------------------------

/**
 * The innermost function or method whose span holds the byte range, or
 * `undefined` where none does. A `const` the syntax reader declares inside a
 * method (`const row = await this.prisma...`) holds the call site but is no
 * function: the access belongs to the method that declares it.
 */
function regionFinder(regions: readonly FunctionRegion[]): (byteStart: number, byteEnd: number) => FunctionRegion | undefined {
  const functions = regions.filter((region) => region.symbolKind === 'function' || region.symbolKind === 'method');
  return (byteStart, byteEnd) => {
    let best: FunctionRegion | undefined;
    let bestWidth = Number.MAX_SAFE_INTEGER;
    for (const region of functions) {
      if (region.span.byteStart <= byteStart && byteEnd <= region.span.byteEnd) {
        const width = region.span.byteEnd - region.span.byteStart;
        if (width < bestWidth) {
          best = region;
          bestWidth = width;
        }
      }
    }
    return best;
  };
}

/** Collects the regions this reader attributes access to, from the syntax reader's declarations. */
function collectRegions(path: string, language: AccessLanguage, syntax: ExtractedFileSyntax): FunctionRegion[] {
  const regions: FunctionRegion[] = [];
  for (const symbol of syntax.symbols) {
    if (!REGIONS_OF_INTEREST.has(symbol.symbolKind)) continue;
    regions.push({qualifiedName: symbol.qualifiedName, symbolKind: symbol.symbolKind, language, span: sourceSpan(path, symbol.span)});
  }
  return regions.sort((left, right) => left.span.byteStart - right.span.byteStart || byCodePointOf(left.qualifiedName, right.qualifiedName));
}

/**
 * The syntax reader's regions with the `const` function bodies it declares
 * nowhere: a region is added where no declaration already holds its span, and
 * the whole list is answered in the order every reader sorts it.
 */
function withConstRegions(
  regions: readonly FunctionRegion[],
  candidates: readonly ConstRegion[],
  path: string,
  bytes: ByteText,
  language: AccessLanguage,
): readonly FunctionRegion[] {
  const merged = [...regions];
  for (const candidate of candidates) {
    const byteStart = bytes.byteAt(candidate.start);
    const byteEnd = bytes.byteAt(candidate.end);
    if (merged.some((region) => region.span.byteStart <= byteStart && byteEnd <= region.span.byteEnd)) continue;
    // The region holds a function body (an arrow or a function expression),
    // whatever keyword declares it.
    merged.push({qualifiedName: candidate.name, symbolKind: 'function', language, span: {
      path, byteStart, byteEnd, lineStart: bytes.lineOf(byteStart), lineEnd: bytes.lineOf(byteEnd),
    }});
  }
  return merged.sort((left, right) => left.span.byteStart - right.span.byteStart || byCodePointOf(left.qualifiedName, right.qualifiedName));
}

/** The syntax reader's span is byte-based already (SyntaxSpan.startByte); only the path is added. */
function sourceSpan(path: string, span: SyntaxSpan): SourceSpan {
  return {path, byteStart: span.startByte, byteEnd: span.endByte, lineStart: span.startLine, lineEnd: span.endLine};
}

function byCodePointOf(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
