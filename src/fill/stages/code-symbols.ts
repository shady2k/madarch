/**
 * The symbols of a file as nodes: which declarations are kept, which are
 * locals of a function (ordinary variables fold into their callable owner;
 * named local callables retain their own body identity), and the
 * innermost kept symbol that holds a place. The symbol reader names a Go
 * method's locals by the bare method name, so a local is told by where it
 * stands -- inside a function's span -- and not by its qualified name.
 */
import type { ExtractedFileSyntax, ExtractedSymbol, SyntaxSpan } from './syntax-extract.js';
import type { SymbolKind } from '../facts.js';
import type { SourceSpan } from '../../extract/records.js';

// ---- the keys one declaration is named by ---------------------------------

/** `code.symbol:<path>#<qualified name>` -- one declaration of a file. */
export const symbolKey = (path: string, qualifiedName: string): string => `code.symbol:${path}#${qualifiedName}`;

/** `code.file:<path>` -- the data-model extractor's file key, shared. */
export const fileKey = (path: string): string => `code.file:${path}`;

/** An actual inline registration callback, named from its enclosing declaration and byte position. */
export const callbackName = (enclosing: string | undefined, route: string, line: number, byte: number): string => `${enclosing ?? route}.callback@${line}:${byte}`;

/** The source one file's symbols are read from: its path, its bytes and the language of its grammar. */
export interface SymbolSource {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly language: 'go' | 'typescript';
}

const FUNCTION_LIKE: ReadonlySet<SymbolKind> = new Set(['constructor', 'function', 'method']);

export interface FileSymbol {
  readonly key: string;
  readonly qualifiedName: string;
  readonly name: string;
  readonly symbolKind: SymbolKind;
  readonly span: SyntaxSpan;
  readonly definitionSpan: SyntaxSpan;
  /** A non-callable local or an alternate name folded into its canonical owner. */
  readonly local: boolean;
  /** The key of the symbol a local folds into; the symbol's own key where it is kept. */
  readonly keptKey: string;
  readonly functionLike: boolean;
}

function holds(outer: SyntaxSpan, inner: SyntaxSpan): boolean {
  return outer.startByte <= inner.startByte && inner.endByte <= outer.endByte && (outer.startByte < inner.startByte || inner.endByte < outer.endByte);
}

function sizeOf(span: SyntaxSpan): number {
  return span.endByte - span.startByte;
}

function indexSymbols(path: string, symbols: readonly ExtractedSymbol[], topNames: ReadonlySet<string> | undefined): FileSymbol[] {
  const functions = symbols.filter((symbol) => FUNCTION_LIKE.has(symbol.symbolKind));
  const indexed: FileSymbol[] = [];
  for (const symbol of symbols) {
    const containers = functions
      .filter((candidate) => candidate !== symbol && holds(candidate.span, symbol.span))
      .sort((left, right) => sizeOf(right.span) - sizeOf(left.span));
    const outer = containers[0];
    const key = symbolKey(path, symbol.qualifiedName);
    // A name with no container that the file does not declare at its top is declared inside a block
    // (a test callback, a `describe` body): it is a local of the file, not a symbol of its structure.
    const functionLike = FUNCTION_LIKE.has(symbol.symbolKind);
    const blockLocal = !functionLike && outer === undefined && topNames !== undefined && !symbol.qualifiedName.includes('.') && !topNames.has(symbol.qualifiedName);
    indexed.push({
      key,
      qualifiedName: symbol.qualifiedName,
      name: symbol.name,
      symbolKind: symbol.symbolKind,
      span: symbol.span,
      definitionSpan: symbol.definitionSpan,
      local: !functionLike && (outer !== undefined || blockLocal),
      keptKey: functionLike ? key : blockLocal ? fileKey(path) : outer === undefined ? key : symbolKey(path, outer.qualifiedName),
      functionLike,
    });
  }
  return indexed;
}

/** The innermost kept symbol of a file whose span holds a byte offset, preferring a function-like one; undefined at the file's own level. */
export function holderAt(symbols: readonly FileSymbol[], byte: number): FileSymbol | undefined {
  let functionLike: FileSymbol | undefined;
  let any: FileSymbol | undefined;
  for (const symbol of symbols) {
    if (symbol.local || symbol.span.startByte > byte || byte >= symbol.span.endByte) continue;
    if (any === undefined || sizeOf(symbol.span) < sizeOf(any.span)) any = symbol;
    if (symbol.functionLike && (functionLike === undefined || sizeOf(symbol.span) < sizeOf(functionLike.span))) functionLike = symbol;
  }
  return functionLike ?? any;
}

/** What one file's declarations make of its symbols: the kept symbols and the callbacks named. */
export interface FileSymbolsRead {
  readonly symbols: readonly FileSymbol[];
  /** The spans of the callables written as an argument, which the values of a call may name. */
  readonly callbackValues: readonly SourceSpan[];
}

/** One syntax span as the extraction's own span: the path and the byte and line range. */
function spanOf(path: string, span: SyntaxSpan): SourceSpan {
  return { path, byteStart: span.startByte, byteEnd: span.endByte, lineStart: span.startLine, lineEnd: span.endLine };
}

/**
 * The symbols one file declares, from the syntax pass's own findings: the
 * declarations the syntax reader names, the callables it proves by their span
 * and the callbacks no declaration names, which this reader names by the
 * callable they stand in and the line and byte they start at — the extract
 * driver's own reading, one file at a time, so a static stage and the driver
 * name one declaration by one key.
 *
 * `topNames` is the file's top-level declarations, which tell a name declared in
 * a block from one the file declares: a caller that reads declarations passes
 * them, and a caller that needs only the callables leaves them out, because a
 * callable is never a block's local.
 */
export function fileSymbolsOf(source: SymbolSource, syntax: ExtractedFileSyntax, topNames?: ReadonlySet<string>): FileSymbolsRead {
  const symbols = indexSymbols(source.path, syntax.symbols, topNames);
  const callbackValues: SourceSpan[] = [];
  if (syntax.parsed) {
    // The syntax pass proves direct initializer ownership. One callable has
    // one canonical owner, even when its declaration and expression differ.
    // Raw evidence keeps async; callback keys retain their parameter position.
    for (const boundary of [...(syntax.callables ?? [])].sort((left, right) =>
      (right.span.endByte - right.span.startByte) - (left.span.endByte - left.span.startByte) || left.span.startByte - right.span.startByte)) {
      const span = boundary.span;
      const declaration = boundary.declarationSpan;
      const declared = declaration === undefined ? [] : symbols.filter((symbol) => symbol.functionLike &&
        symbol.span.startByte === declaration.startByte && symbol.span.endByte === declaration.endByte);
      const raw = symbols.filter((symbol) => symbol.functionLike && symbol.span.startByte === span.startByte && symbol.span.endByte === span.endByte);
      const canonical = declared.length === 1 ? declared[0] : raw.length === 1 ? raw[0] : undefined;
      if (canonical !== undefined) {
        for (const [index, symbol] of symbols.entries()) {
          if (symbol === canonical) symbols[index] = { ...symbol, local: false, keptKey: symbol.key };
          else if (declared.length === 1 && raw.includes(symbol)) symbols[index] = { ...symbol, local: true, keptKey: canonical.key };
        }
      } else if (declared.length === 0 && raw.length === 0) {
        const enclosing = holderAt(symbols, span.startByte);
        const name = callbackName(enclosing?.qualifiedName, 'anonymous', boundary.identity.startLine, boundary.identity.startByte);
        const key = symbolKey(source.path, name);
        symbols.push({ key, qualifiedName: name, name, symbolKind: 'function', span, definitionSpan: span, local: false, keptKey: key, functionLike: true });
      }
      if (boundary.argument) callbackValues.push(spanOf(source.path, span));
    }
  }
  for (const [index, symbol] of symbols.entries()) {
    if (!symbol.local || symbol.functionLike) continue;
    const holder = holderAt(symbols, symbol.span.startByte);
    if (holder !== undefined) symbols[index] = { ...symbol, keptKey: holder.key };
  }
  return { symbols, callbackValues };
}

/**
 * The field symbols a file's declarations add to the symbols its syntax pass
 * read: the declaration reader knows a member even where the syntax pass keeps
 * no symbol, and the resolver ties `this.field` to it and the type owns it by
 * `code.contains` (madarch-m38l.21).
 */
export function withFieldSymbols(path: string, symbols: FileSymbol[], fields: readonly { readonly qualifiedName: string; readonly name: string; readonly span: SyntaxSpan }[]): FileSymbol[] {
  for (const member of fields) {
    const key = symbolKey(path, member.qualifiedName);
    if (symbols.some((symbol) => symbol.key === key)) continue;
    symbols.push({ key, qualifiedName: member.qualifiedName, name: member.name, symbolKind: 'field', span: member.span, definitionSpan: member.span, local: false, keptKey: key, functionLike: false });
  }
  return symbols;
}
