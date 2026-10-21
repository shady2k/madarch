/**
 * The symbols of a file as nodes: which declarations are kept, which are
 * locals of a function (a variable or closure inside a body is no part of the
 * code's structure and is folded into the function that holds it), and the
 * innermost kept symbol that holds a place. The symbol reader names a Go
 * method's locals by the bare method name, so a local is told by where it
 * stands -- inside a function's span -- and not by its qualified name.
 */
import type { ExtractedSymbol, SyntaxSpan } from '../../fill/stages/syntax-extract.js';
import type { SymbolKind } from '../../fill/facts.js';
import { symbolKey } from './keys.js';

const FUNCTION_LIKE: ReadonlySet<SymbolKind> = new Set(['constructor', 'function', 'method']);

export interface FileSymbol {
  readonly key: string;
  readonly qualifiedName: string;
  readonly name: string;
  readonly symbolKind: SymbolKind;
  readonly span: SyntaxSpan;
  readonly definitionSpan: SyntaxSpan;
  /** Inside the span of a function-like symbol: folded into the outermost one. */
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

export function indexSymbols(path: string, symbols: readonly ExtractedSymbol[]): FileSymbol[] {
  const functions = symbols.filter((symbol) => FUNCTION_LIKE.has(symbol.symbolKind));
  const indexed: FileSymbol[] = [];
  for (const symbol of symbols) {
    const containers = functions
      .filter((candidate) => candidate !== symbol && holds(candidate.span, symbol.span))
      .sort((left, right) => sizeOf(right.span) - sizeOf(left.span));
    const outer = containers[0];
    const key = symbolKey(path, symbol.qualifiedName);
    indexed.push({
      key,
      qualifiedName: symbol.qualifiedName,
      name: symbol.name,
      symbolKind: symbol.symbolKind,
      span: symbol.span,
      definitionSpan: symbol.definitionSpan,
      local: outer !== undefined,
      keptKey: outer === undefined ? key : symbolKey(path, outer.qualifiedName),
      functionLike: FUNCTION_LIKE.has(symbol.symbolKind),
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
