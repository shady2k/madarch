/** A graph-held text file and this term's own definition ranges, not counted as mentions. */
export interface UsageSource {
  readonly repository: string;
  readonly path: string;
  readonly text: string;
  readonly definitions: readonly { lineStart: number; lineEnd: number }[];
}

/** Strings in Unicode code point order, independent of the machine's locale. */
function compare(left: string, right: string): number {
  const a = Array.from(left, (one) => one.codePointAt(0)!);
  const b = Array.from(right, (one) => one.codePointAt(0)!);
  for (let at = 0; at < Math.min(a.length, b.length); at++) {
    if (a[at] !== b[at]) return a[at]! - b[at]!;
  }
  return a.length - b.length;
}

/** Exact, case-insensitive whole-name mentions, one row per source line. */
export function usagesOf(term: { name: string; synonyms: readonly string[]; code: readonly string[] }, sources: readonly UsageSource[]): { repository: string; path: string; lineStart: number; lineEnd: number; count: number }[] {
  // Longer alternatives win, so a synonym containing the term counts as one mention, not two.
  const names = [...new Set([term.name, ...term.synonyms, ...term.code].filter((name) => name !== ''))]
    .sort((left, right) => right.length - left.length || compare(left, right));
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const mentions = new RegExp(`(?<![\\p{L}\\p{N}_$])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_$])`, 'giu');
  const usages: { repository: string; path: string; lineStart: number; lineEnd: number; count: number }[] = [];
  for (const source of sources) {
    const excluded = source.definitions;
    for (const [index, line] of source.text.split('\n').entries()) {
      const lineStart = index + 1;
      if (excluded.some((range) => lineStart >= range.lineStart && lineStart <= range.lineEnd)) continue;
      const count = [...line.matchAll(mentions)].length;
      if (count > 0) usages.push({ repository: source.repository, path: source.path, lineStart, lineEnd: lineStart, count });
    }
  }
  usages.sort((left, right) => compare(left.repository, right.repository) || compare(left.path, right.path) || left.lineStart - right.lineStart);
  return usages;
}
