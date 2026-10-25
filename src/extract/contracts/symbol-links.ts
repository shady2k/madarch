/** Canonical code identities for contract sites. Missing inner proof is a tombstone. */
import {extractCodeWithFacts} from '../code/index.js';
import type {CodeFacts, CodeSymbolFact} from '../code/facts.js';
import {TreeText} from '../operations/source.js';
import {functionsOf} from '../operations/symbol-sites.js';
import type {ExtractedNode, Extraction, SourceSpan, TreeReader} from '../records.js';

const contains = (outer: SourceSpan, inner: SourceSpan): boolean => outer.path === inner.path && outer.byteStart <= inner.byteStart && inner.byteEnd <= outer.byteEnd;

export class ContractSymbols {
  constructor(private readonly source: TreeText) {}

  private valid(symbol: CodeSymbolFact): boolean {
    const facts = this.source.facts;
    return facts !== undefined && facts.symbols.filter((entry) => entry.key === symbol.key).length === 1 &&
      functionsOf(this.source, symbol.path).filter((site) => site.key === symbol.key && contains(site.span, symbol.span) && contains(symbol.span, site.span)).length === 1;
  }

  /** The innermost raw boundary owns the site, even when its metadata is missing. */
  enclosing(span: SourceSpan): string | undefined {
    const owners = (this.source.facts?.symbols ?? []).filter((symbol) => symbol.callable && symbol.path === span.path &&
      symbol.span.byteStart <= span.byteStart && span.byteStart < symbol.span.byteEnd)
      .sort((a, b) => (a.span.byteEnd - a.span.byteStart) - (b.span.byteEnd - b.span.byteStart));
    const owner = owners[0];
    if (owner === undefined) return undefined;
    if (owners[1] !== undefined && owner.span.byteStart === owners[1].span.byteStart && owner.span.byteEnd === owners[1].span.byteEnd ||
      !this.valid(owner) || owner.bodySpan === undefined || !contains(owner.bodySpan, span)) {
      this.source.factGap(span.path, `contracts: line ${span.lineStart}: innermost callable ${owner.key} has no unique valid body ownership (${span.path})`);
      return undefined;
    }
    return owner.key;
  }

  handler(span: SourceSpan, inline: boolean, _route: string): string | undefined {
    const facts = this.source.facts;
    if (facts === undefined) return undefined;
    const candidates = inline
      ? facts.symbols.filter((symbol) => symbol.callable && contains(span, symbol.span) && contains(symbol.span, span))
      : facts.symbols.filter((symbol) => symbol.callable && facts.sites.some((site) => contains(span, site.span) && site.to === symbol.key && site.use !== 'type'));
    const keys = [...new Set(candidates.map((symbol) => symbol.key))];
    if (keys.length !== 1 || candidates.length !== 1 || !this.valid(candidates[0]!)) return undefined;
    return keys[0];
  }
}

export async function contractSymbols(reader: TreeReader, _nodes: ExtractedNode[], code?: Extraction, facts?: CodeFacts, source?: TreeText): Promise<ContractSymbols> {
  if (source !== undefined) return new ContractSymbols(source);
  if (code === undefined && facts === undefined) {
    const shared = await extractCodeWithFacts(reader);
    return new ContractSymbols(new TreeText(reader, shared.extraction, shared.facts));
  }
  return new ContractSymbols(new TreeText(reader, code, facts));
}
