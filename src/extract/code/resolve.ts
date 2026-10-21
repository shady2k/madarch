/**
 * The plain-name resolution of the fill (`resolutionFacts`) run over the
 * extractor's symbols. The fill's resolver speaks in fact ids, so each symbol
 * key is given a stable id (`symbol:` and the digest of the key) for the
 * resolver and translated back; nothing of the fill's fact store is touched.
 * The result is the resolver's own: occurrences, folded call, reference and
 * inheritance edges, and the names it could not tie to a symbol.
 */
import { createHash } from 'node:crypto';
import { repositoryPath } from '../../fill/facts.js';
import { resolutionFacts, type ResolutionSymbolRow } from '../../fill/stages/resolution-facts.js';
import type { ExtractedFileResolution } from '../../fill/stages/resolution-extract.js';
import type { SyntaxSpan } from '../../fill/stages/syntax-extract.js';
import { fileKey } from './keys.js';
import type { FileSymbol } from './symbols.js';

const COMMIT = '0'.repeat(40);

export function idOfKey(key: string): string {
  return `symbol:${createHash('sha256').update(key).digest('hex')}`;
}

export interface ResolvedOccurrence {
  readonly to: string;
  readonly roles: readonly string[];
  readonly span: SyntaxSpan;
}

export interface ResolvedEdge {
  readonly kind: 'call' | 'reference' | 'inherits';
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly form: string;
  readonly span: SyntaxSpan;
}

export interface FileResolution {
  readonly occurrences: readonly ResolvedOccurrence[];
  readonly edges: readonly ResolvedEdge[];
  /** What the resolver could not tie down, as a reader sees it, with no coverage noise. */
  readonly unresolved: readonly string[];
}

export function resolveFile(
  path: string,
  findings: ExtractedFileResolution,
  files: readonly string[],
  symbolsByFile: ReadonlyMap<string, readonly FileSymbol[]>,
  lines: number,
): FileResolution {
  const rows = (symbols: readonly FileSymbol[], file: string): ResolutionSymbolRow[] =>
    symbols.map((symbol) => ({
      id: idOfKey(symbol.key),
      file: repositoryPath(file),
      qualifiedName: symbol.qualifiedName,
      symbolKind: symbol.symbolKind,
      range: { startLine: symbol.span.startLine, startColumn: symbol.span.startColumn, endLine: symbol.span.endLine, endColumn: symbol.span.endColumn },
    }));
  const keyById = new Map<string, string>();
  const readSymbols = new Map<string, readonly ResolutionSymbolRow[]>();
  for (const [file, symbols] of symbolsByFile) {
    readSymbols.set(file, rows(symbols, file));
    for (const symbol of symbols) keyById.set(idOfKey(symbol.key), symbol.key);
  }
  // The file itself holds what stands outside every declaration (a test callback, a script's top-level
  // statements): without a holder the resolver drops the name, and the site would be lost.
  const fileId = idOfKey(fileKey(path));
  keyById.set(fileId, fileKey(path));
  readSymbols.set(path, [
    ...(readSymbols.get(path) ?? []),
    { id: fileId, file: repositoryPath(path), qualifiedName: '', symbolKind: 'module', range: { startLine: 1, startColumn: 0, endLine: lines + 1, endColumn: 1_000_000 } },
  ]);
  const spanAt = new Map<string, SyntaxSpan>();
  for (const mention of findings.mentions) spanAt.set(`${mention.span.startLine}:${mention.span.startColumn}`, mention.span);
  const result = resolutionFacts({
    repository: 'repository',
    commit: COMMIT,
    path: repositoryPath(path),
    findings,
    files,
    fileSymbols: readSymbols.get(path) ?? [],
    readSymbols,
    index: new Map(),
    indexAnswered: false,
  });
  const occurrences: ResolvedOccurrence[] = [];
  const edges: ResolvedEdge[] = [];
  for (const fact of result.facts) {
    const range = fact.provenance.place?.range;
    const span = range === undefined ? undefined : spanAt.get(`${range.startLine}:${range.startColumn}`);
    if (span === undefined) continue;
    if (fact.kind === 'occurrence') {
      const value = fact.value as { symbol: string; roles: readonly string[] };
      const to = keyById.get(value.symbol);
      if (to !== undefined) occurrences.push({ to, roles: value.roles, span });
    } else if (fact.kind === 'call' || fact.kind === 'reference' || fact.kind === 'inherits') {
      const value = fact.value as { from: string; to: string; count?: number; form?: string };
      const from = keyById.get(value.from);
      const to = keyById.get(value.to);
      if (from !== undefined && to !== undefined) edges.push({ kind: fact.kind, from, to, count: value.count ?? 1, form: value.form ?? '', span });
    }
  }
  const unresolved = result.coverage.unread
    .map((gap) => gap.what)
    .filter((what) => !what.includes('names a package outside this repository') && !what.startsWith('a compiler index of'));
  return { occurrences, edges, unresolved };
}
