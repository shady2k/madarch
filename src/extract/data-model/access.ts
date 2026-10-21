/**
 * Which function reads or writes which table (madarch-o0eq.2): the sites a
 * code file holds - SQL string literals passed to `database/sql` calls, Prisma
 * client calls, and raw SQL built for `$queryRawUnsafe` - each attributed to
 * the innermost function region that holds it, with the byte span of the site
 * itself. Pure over the file's bytes and the symbol spans the pure syntax
 * reader (`src/fill/stages/syntax-extract.ts`) found; this module imports that
 * reader and edits none of it.
 *
 * The regions are the syntax reader's declarations of function, method,
 * constant and variable kind. A TypeScript `const name = async (...) => {...}`
 * the syntax reader does not declare (an anonymous function expression holds
 * it) is found by a lexical fallback, so the legacy report's builders are not
 * a silence. A SQL literal or a Prisma call that no region holds is reported
 * with no region; the caller decides what carries it, and never drops it
 * silently.
 */
import type {SourceSpan} from '../records.js';
import {extractFileSyntax, type SyntaxSpan} from '../../fill/stages/syntax-extract.js';
import {scanGoText, scanTsLikeText} from './text-scan.js';

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

/**
 * Reads one file's bytes for table access. `path` names the file in every
 * span; the file's own bytes decide everything else.
 */
export async function extractFileAccess(path: string, bytes: Uint8Array): Promise<FileAccess> {
  const syntax = await extractFileSyntax(path, bytes);
  const language = languageOfPath(path);
  if (language === null) {
    return {path, language: null, regions: [], sites: [], tableDeclarations: [], unread: gapsOf(syntax.unread)};
  }
  const text = new TextDecoder().decode(bytes);
  const toByte = byteCounter(text);
  const regions = collectRegions(path, text, language, syntax, toByte);
  const sites: AccessSite[] = [];
  const tableDeclarations: CodeTableDeclaration[] = [];
  const strings = language === 'go' ? scanGoText(text) : scanTsLikeText(text);
  const regionOf = regionFinder(regions);
  // The call spans of the file, over text whose strings and comments are
  // spaces: the call a SQL literal stands in (`tx.ExecContext(ctx, \`INSERT
  // INTO outbox ...)\``) is the call site the access cites.
  const masked = maskText(text, language);
  // The call spans come from character offsets of the masked text; every span
  // this module hands out is a byte span (records.ts), so they are converted
  // once here, before they meet a literal's byte range.
  const callSpans = collectCallSpans(masked).map((call) => ({
    chainStart: toByte[call.chainStart]!,
    openParen: toByte[call.openParen]!,
    closeParen: toByte[call.closeParen]!,
  }));
  for (const literal of strings.strings) {
    if (insideAny(literal.byteStart, literal.byteEnd, strings.comments)) continue;
    const content = text.slice(charAt(toByte, literal.byteStart), charAt(toByte, literal.byteEnd));
    if (!looksLikeSql(content)) continue;
    // A literal no function region holds keeps the empty region name: the
    // caller attributes it to the file itself, and never drops it.
    const holder = regionOf(literal.byteStart, literal.byteEnd);
    const regionName = holder?.qualifiedName ?? '';
    const site = callSpans.filter((call) => call.openParen < literal.byteStart && literal.byteEnd < call.closeParen).sort((left, right) => right.openParen - left.openParen)[0];
    const byteStart = site !== undefined ? site.chainStart : literal.byteStart;
    const byteEnd = site !== undefined ? site.closeParen + 1 : literal.byteEnd;
    const span: SourceSpan = {
      path,
      byteStart,
      byteEnd,
      lineStart: lineOf(text, toByte, byteStart),
      lineEnd: lineOf(text, toByte, byteEnd),
    };
    for (const site of collectSqlSites(content, span, regionName)) sites.push(site);
    for (const declaration of collectCodeDdl(content, span)) tableDeclarations.push(declaration);
  }
  // Prisma client calls: `this.prisma.<model>.<op>(...)` or `prisma.<model>.<op>(...)`.
  const calls = /(?:this\s*\.\s*)?prisma\s*\.\s*([A-Za-z_]\w*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  for (let match = calls.exec(text); match !== null; match = calls.exec(text)) {
    const charStart = match.index;
    const charEnd = match.index + match[0].length;
    const byteStart = toByte[charStart]!;
    const byteEnd = toByte[charEnd]!;
    if (insideAny(byteStart, byteEnd, strings.comments)) continue;
    const holder = regionOf(byteStart, byteEnd);
    const regionName = holder?.qualifiedName ?? '';
    const op = match[2]!;
    const verb = PRISMA_WRITE_OPS.has(op) ? 'write' : PRISMA_READ_OPS.has(op) ? 'read' : undefined;
    if (verb === undefined) continue;
    sites.push({
      table: match[1]!,
      verb,
      via: 'prisma-client',
      model: match[1]!,
      region: regionName,
      span: {path, byteStart, byteEnd, lineStart: lineOf(text, toByte, byteStart), lineEnd: lineOf(text, toByte, byteEnd)},
    });
  }
  return {
    path,
    language,
    regions,
    sites: sites.sort((left, right) => left.span.byteStart - right.span.byteStart || byCodePointOf(left.region, right.region)),
    tableDeclarations,
    unread: gapsOf(syntax.unread),
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
function collectRegions(
  path: string,
  text: string,
  language: AccessLanguage,
  syntax: Awaited<ReturnType<typeof extractFileSyntax>>,
  toByte: readonly number[],
): FunctionRegion[] {
  const regions: FunctionRegion[] = [];
  for (const symbol of syntax.symbols) {
    if (!REGIONS_OF_INTEREST.has(symbol.symbolKind)) continue;
    regions.push({
      qualifiedName: symbol.qualifiedName,
      symbolKind: symbol.symbolKind,
      language,
      span: sourceSpan(path, symbol.span),
    });
  }
  if (language !== 'go') {
    // A `const name = (...) => {...}` the syntax reader does not declare: the
    // legacy report's report builders. The fallback is lexical and bounded: a
    // `const` whose value begins with `async`, `(` or `function`, and only
    // where no declaration already holds the span.
    for (const candidate of constFunctionRegions(text)) {
      const byteStart = toByte[candidate.start]!;
      const byteEnd = toByte[candidate.end]!;
      const held = regions.some((region) => region.span.byteStart <= byteStart && byteEnd <= region.span.byteEnd);
      if (held) continue;
      regions.push({
        qualifiedName: candidate.name,
        // The region holds a function body (an arrow or a function
        // expression), whatever keyword declares it.
        symbolKind: 'function',
        language,
        span: {
          path,
          byteStart,
          byteEnd,
          lineStart: lineOf(text, toByte, byteStart),
          lineEnd: lineOf(text, toByte, byteEnd),
        },
      });
    }
  }
  return regions.sort((left, right) => left.span.byteStart - right.span.byteStart || byCodePointOf(left.qualifiedName, right.qualifiedName));
}

interface CandidateRegion {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** Finds `const NAME ... = ... => {` / `= function ... {` regions by brace matching. */
function constFunctionRegions(text: string): readonly CandidateRegion[] {
  const found: CandidateRegion[] = [];
  const pattern = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?const\s+([A-Za-z_$][\w$]*)\s*/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const nameStart = match.index + match[0].indexOf(match[1]!);
    let index = match.index + match[0].length;
    // Skip a type annotation (`: ReportBuilder`) to the value's `=`.
    while (index < text.length && text[index] !== '=' && text[index] !== '\n') index++;
    if (text[index] !== '=') continue;
    index++;
    while (index < text.length && /\s/.test(text[index]!)) index++;
    const value = text.slice(index, index + 9);
    if (!/^async\b/.test(value) && !/^function\b/.test(value) && value[0] !== '(') continue;
    // The body: the first `{` of the value, matched to its own close.
    while (index < text.length && text[index] !== '{' && text[index] !== ';') index++;
    if (text[index] !== '{') continue;
    const close = matchingBrace(text, index);
    if (close === -1) continue;
    found.push({name: match[1]!, start: nameStart, end: close + 1});
  }
  return found;
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const character = text[index];
    if (character === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index = Math.min(text.length, index + 2);
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      index++;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === quote) break;
        index++;
      }
      index++;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}') {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return -1;
}

/**
 * Whether a string literal's content is worth an SQL reading. A fragment of a
 * concatenated statement (`\` FROM orders WHERE id = $1\``) carries only the
 * FROM clause, so the clause keywords count as much as the statement verbs.
 */
function looksLikeSql(content: string): boolean {
  return /\b(?:SELECT\b|FROM\b|JOIN\b|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+TABLE\b)/i.test(content);
}

/** The table accesses one SQL text holds, each at the literal's own span, named once. */
function collectSqlSites(content: string, span: SourceSpan, region: string): readonly AccessSite[] {
  const sites = new Map<string, AccessSite>();
  const push = (table: string, verb: 'read' | 'write'): void => {
    if (table === '' || /^\d/.test(table)) return;
    const key = `${verb} ${table}`;
    if (!sites.has(key)) sites.set(key, {table, verb, via: 'sql', region, span});
  };
  for (const match of content.matchAll(/\bINSERT\s+INTO\s+"?(\w+)"?/gi)) push(match[1]!, 'write');
  for (const match of content.matchAll(/\bUPDATE\s+"?(\w+)"?\s+SET\b/gi)) push(match[1]!, 'write');
  const deletes = [...content.matchAll(/\bDELETE\s+FROM\s+"?(\w+)"?/gi)];
  for (const match of deletes) push(match[1]!, 'write');
  // The FROM of a DELETE is that delete, not a read.
  const inDelete = (at: number): boolean => deletes.some((candidate) => candidate.index !== undefined && at >= candidate.index && at < candidate.index + candidate[0].length);
  for (const match of content.matchAll(/\bFROM\s+"?(\w+)"?/gi)) {
    if (inDelete(match.index ?? 0)) continue;
    push(match[1]!, 'read');
  }
  for (const match of content.matchAll(/\bJOIN\s+"?(\w+)"?/gi)) push(match[1]!, 'read');
  return [...sites.values()];
}

/** The CREATE TABLE declarations one SQL text holds, at the literal's own span. */
function collectCodeDdl(content: string, span: SourceSpan): readonly CodeTableDeclaration[] {
  const found: CodeTableDeclaration[] = [];
  for (const match of content.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?(\w+)"?)\.)?"?(\w+)"?\s*\(/gi)) {
    found.push({table: match[2]!, span});
  }
  return found;
}

/**
 * Replaces every string literal's content and every comment with spaces, so a
 * scan over the text never reads a string or a comment as code, and the
 * offsets of the text stay the same.
 */
function maskText(text: string, language: AccessLanguage): string {
  const scanned = language === 'go' ? scanGoText(text) : scanTsLikeText(text);
  const out = [...text];
  const toChar = charCounter(text);
  for (const span of [...scanned.comments, ...scanned.strings]) {
    const from = toChar[span.byteStart] ?? text.length;
    const to = toChar[span.byteEnd] ?? text.length;
    for (let at = from; at < to; at++) out[at] = ' ';
  }
  return out.join('');
}

/** The calls of one masked text: where each chain starts and where its arguments end. */
function collectCallSpans(masked: string): readonly {readonly chainStart: number; readonly openParen: number; readonly closeParen: number}[] {
  const found: {chainStart: number; openParen: number; closeParen: number}[] = [];
  for (const match of masked.matchAll(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const openParen = (match.index ?? 0) + match[0].length - 1;
    const closeParen = matchingParenOf(masked, openParen);
    if (closeParen !== -1) found.push({chainStart: match.index ?? 0, openParen, closeParen});
  }
  return found.sort((left, right) => left.openParen - right.openParen);
}

function matchingParenOf(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    if (masked[index] === '(') depth++;
    if (masked[index] === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The character offset of every byte, one entry past the end included. */
function charCounter(text: string): number[] {
  const offsets = new Array<number>(text.length + 1);
  let byte = 0;
  for (let index = 0; index < text.length; index++) {
    offsets[index] = byte;
    const codePoint = text.codePointAt(index)!;
    byte += codePoint > 0xffff ? 4 : codePoint > 0x7f ? (codePoint > 0x7ff ? 3 : 2) : 1;
    if (codePoint > 0xffff) index++;
  }
  offsets[text.length] = byte;
  return offsets;
}

// ---- byte/char bookkeeping ------------------------------------------------

/** The byte offset of every character of `text`, one entry past the end included. */
function byteCounter(text: string): number[] {
  const offsets = new Array<number>(text.length + 1);
  let byte = 0;
  for (let index = 0; index < text.length; index++) {
    offsets[index] = byte;
    const codePoint = text.codePointAt(index)!;
    byte += codePoint > 0xffff ? 4 : codePoint > 0x7f ? (codePoint > 0x7ff ? 3 : 2) : 1;
    if (codePoint > 0xffff) index++;
  }
  offsets[text.length] = byte;
  return offsets;
}

function charAt(offsets: readonly number[], byte: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle]! <= byte) low = middle;
    else high = middle - 1;
  }
  return low;
}

function lineOf(text: string, offsets: readonly number[], byte: number): number {
  const charIndex = charAt(offsets, byte);
  let line = 1;
  for (let index = 0; index < charIndex; index++) {
    if (text[index] === '\n') line++;
  }
  return line;
}

function insideAny(byteStart: number, byteEnd: number, spans: readonly {byteStart: number; byteEnd: number}[]): boolean {
  return spans.some((span) => byteStart >= span.byteStart && byteEnd <= span.byteEnd);
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
