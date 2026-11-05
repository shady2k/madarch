/**
 * The inline callbacks of one file, as the code extractor names them: a callable
 * boundary the file writes with no declaration of its own (an arrow function
 * passed to `router.post`, an inline handler in a Go registration) is a symbol
 * of the file named `<holder>.callback@<line>:<byte>`, at the boundary's own
 * span. The driver's `extractCodeWithFacts` and the fill's contracts stage both
 * need this reading, and both take it from here, so a route's handler resolves
 * to the same name in the two readings (decision 0033, items 5 and 14;
 * madarch-8bdc.2.4).
 *
 * The rule is the driver's own and unchanged: the boundaries are read largest
 * first, a boundary a declaration proves is that declaration's symbol (a named
 * function written as an arrow), a boundary with no symbol at all is a callback
 * named after the innermost kept symbol that holds it, and the symbols a
 * boundary folds into stay marked local so a later boundary finds the canonical
 * owner.
 *
 * The module stands beside the other static stage readers because a static
 * stage may not obtain a type from the code extractor's own module (decision
 * 0033, item 5): the reading is pure over one file's syntax findings.
 */
import type { ExtractedCallableBoundary, ExtractedFileSyntax, SyntaxSpan } from './syntax-extract.js';
import { callbackName, holderAt, indexSymbols, symbolKey, type FileSymbol } from './code-symbols.js';

/** What one file's callable boundaries answer: the symbols they fold into, and the callbacks they make. */
export interface IndexedCallbacks {
  /** The file's symbols after the boundaries folded into them: the array the driver's facts are read from. */
  readonly symbols: readonly FileSymbol[];
  /** Every callback symbol this pass made, in the pass's own order. */
  readonly callbacks: readonly { readonly qualifiedName: string; readonly span: SyntaxSpan }[];
  /** The spans of the boundaries that are a call's argument, which the code facts keep as callback values. */
  readonly argumentSpans: readonly SyntaxSpan[];
}

/** The size of a span in bytes. */
function sizeOf(span: SyntaxSpan): number {
  return span.endByte - span.startByte;
}

/** Whether a span is exactly another: two ends, both contained the other way. */
function same(left: SyntaxSpan, right: SyntaxSpan): boolean {
  return left.startByte === right.startByte && left.endByte === right.endByte;
}

/**
 * One file's callable boundaries folded into its symbols: the callback symbols
 * they make, and the symbols the boundaries prove or fold into. The array is a
 * copy; the caller's symbols are not changed.
 */
export function indexCallbacks(path: string, symbols: readonly FileSymbol[], callables: readonly ExtractedCallableBoundary[] | undefined): IndexedCallbacks {
  const held: FileSymbol[] = [...symbols];
  const callbacks: { qualifiedName: string; span: SyntaxSpan }[] = [];
  const argumentSpans: SyntaxSpan[] = [];
  const boundaries = [...(callables ?? [])].sort((left, right) => sizeOf(right.span) - sizeOf(left.span) || left.span.startByte - right.span.startByte);
  for (const boundary of boundaries) {
    const span = boundary.span;
    const declaration = boundary.declarationSpan;
    const declared = declaration === undefined ? [] : held.filter((symbol) => symbol.functionLike && same(symbol.span, declaration));
    const raw = held.filter((symbol) => symbol.functionLike && same(symbol.span, span));
    const canonical = declared.length === 1 ? declared[0] : raw.length === 1 ? raw[0] : undefined;
    if (canonical !== undefined) {
      for (const [index, symbol] of held.entries()) {
        if (symbol === canonical) held[index] = { ...symbol, local: false, keptKey: symbol.key };
        else if (declared.length === 1 && raw.includes(symbol)) held[index] = { ...symbol, local: true, keptKey: canonical.key };
      }
    } else if (declared.length === 0 && raw.length === 0) {
      const enclosing = holderAt(held, span.startByte);
      const name = callbackName(enclosing?.qualifiedName, 'anonymous', boundary.identity.startLine, boundary.identity.startByte);
      const key = symbolKey(path, name);
      held.push({ key, qualifiedName: name, name, symbolKind: 'function', span, definitionSpan: span, local: false, keptKey: key, functionLike: true });
      callbacks.push({ qualifiedName: name, span });
    }
    if (boundary.argument) argumentSpans.push(span);
  }
  return { symbols: held, callbacks, argumentSpans };
}

/**
 * The callbacks one file's syntax findings make, for a static stage: the same
 * reading the code extractor takes, over the findings the file pass already
 * holds. The top-level names the fold reads are the findings' own names that
 * stand at the file's level; the driver's reader takes them from the file's
 * declarations, and a name one of the two readings calls top-level and the other
 * does not is a non-callable symbol, which never names a callback.
 */
export function callbacksOfFile(path: string, findings: ExtractedFileSyntax): readonly { readonly qualifiedName: string; readonly span: SyntaxSpan }[] {
  const topNames = new Set(findings.symbols.filter((symbol) => !symbol.qualifiedName.includes('.')).map((symbol) => symbol.qualifiedName));
  return indexCallbacks(path, indexSymbols(path, findings.symbols, topNames), findings.callables).callbacks;
}
