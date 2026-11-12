import type { CatalogKindView } from './types.js';

export function addedByDependency(kinds: readonly CatalogKindView[], checked: ReadonlySet<string>): Map<string, string> {
  const byKind = new Map(kinds.map((kind) => [kind.kind, kind] as const));
  const added = new Map<string, string>();
  const visit = (from: string, kind: string): void => {
    for (const dependency of byKind.get(kind)?.dependsOn ?? []) {
      if (checked.has(dependency) || added.has(dependency)) continue;
      added.set(dependency, from);
      visit(from, dependency);
    }
  };
  for (const kind of [...checked].sort()) if (byKind.has(kind)) visit(kind, kind);
  return added;
}

/**
 * What the fill page says one run costs: the selected kinds' measured volume times the per-unit figure their producers
 * declare. A figure no producer declares is unknown, and the sum is unknown with it — never a guess (madarch-stm0.6).
 */
export function estimateOf(kinds: readonly CatalogKindView[], checked: ReadonlySet<string>, added: ReadonlyMap<string, string>): { tokens: number | null; seconds: number | null; volume: number; unknown: number } {
  const chosen = new Set([...checked, ...added.keys()]);
  const held = kinds.filter((kind) => chosen.has(kind.kind));
  let tokens = 0;
  let seconds = 0;
  let unknown = 0;
  let volume = 0;
  for (const kind of held) {
    volume += kind.estimate?.volume ?? 0;
    if (kind.estimate === undefined || kind.estimate.tokens === null || kind.estimate.seconds === null) unknown += 1;
    else { tokens += kind.estimate.tokens; seconds += kind.estimate.seconds; }
  }
  return { tokens: unknown > 0 ? null : tokens, seconds: unknown > 0 ? null : seconds, volume, unknown };
}
