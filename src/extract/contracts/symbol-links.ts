/** Shared code identities for contract sites. Named declarations stay owned by code. */
import {extractCode} from '../code/index.js';
import {callbackName, symbolKey} from '../code/keys.js';
import type {ExtractedNode, Extraction, SourceSpan, TreeReader} from '../records.js';

const FUNCTION_KINDS = new Set(['function', 'method', 'constructor']);
const contains = (outer: SourceSpan, inner: SourceSpan): boolean => outer.path === inner.path && outer.byteStart <= inner.byteStart && inner.byteEnd <= outer.byteEnd;

export class ContractSymbols {
  private readonly symbols: readonly ExtractedNode[];
  constructor(private readonly code: Extraction, private readonly own: ExtractedNode[]) {
    this.symbols = code.nodes.filter((node) => node.kind === 'code.symbol');
  }

  /** The actual smallest function declaration containing the call, never a guessed file/name key. */
  enclosing(span: SourceSpan): string | undefined {
    return [...this.symbols, ...this.own.filter((node) => node.kind === 'code.symbol')]
      .filter((node) => node.span !== undefined && contains(node.span, span) && FUNCTION_KINDS.has(String(node.properties['symbolKind'])))
      .sort((a, b) => (a.span!.byteEnd - a.span!.byteStart) - (b.span!.byteEnd - b.span!.byteStart))[0]?.key;
  }

  handler(span: SourceSpan, inline: boolean, route: string): string | undefined {
    if (inline) {
      // Code owns normal named and inline declarations before ordinary occurrence attribution.
      // Only an unavailable code reading can use the legacy contract-side fallback.
      const existing = this.symbols.find((node) => node.span !== undefined && node.span.path === span.path && node.span.byteStart === span.byteStart && node.span.byteEnd === span.byteEnd && FUNCTION_KINDS.has(String(node.properties['symbolKind'])));
      if (existing !== undefined) return existing.key;
      const codeFile = this.code.nodes.find((node) => node.key === `code.file:${span.path}`);
      if (codeFile?.properties['parsed'] === true) return undefined;
      const enclosing = this.enclosing(span)?.split('#').slice(1).join('#');
      const qualifiedName = callbackName(enclosing, route, span.lineStart, span.byteStart);
      const key = symbolKey(span.path, qualifiedName);
      if (!this.own.some((node) => node.key === key)) this.own.push({key, kind: 'code.symbol', label: qualifiedName, properties: {path: span.path, name: qualifiedName, qualifiedName, symbolKind: 'function', language: span.path.endsWith('.go') ? 'go' : 'typescript', inline: true}, span});
      return key;
    }
    const targets = [...new Set(this.code.edges.filter((edge) => edge.type === 'code.occurrence' && edge.span !== undefined && contains(span, edge.span)).map((edge) => edge.to))]
      .filter((key) => this.symbols.some((node) => node.key === key && FUNCTION_KINDS.has(String(node.properties['symbolKind']))));
    return targets.length === 1 ? targets[0] : undefined;
  }
}

export async function contractSymbols(reader: TreeReader, nodes: ExtractedNode[], code?: Extraction): Promise<ContractSymbols> {
  if (code !== undefined) return new ContractSymbols(code, nodes);
  return new ContractSymbols(await extractCode(reader), nodes);
}
