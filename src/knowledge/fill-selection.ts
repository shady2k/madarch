/** Requested kinds and their transitive prerequisites, in deterministic prerequisite-first order.
 * Callers validate unknown kinds and cycles before starting a run.
 */
export function prerequisiteClosure(kinds: readonly { kind: string; derivesFrom?: readonly string[] }[], requested: readonly string[]): string[] {
  const byKind = new Map(kinds.map((kind) => [kind.kind, kind]));
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (id: string): void => {
    if (seen.has(id) || !byKind.has(id)) return;
    seen.add(id);
    for (const prerequisite of [...(byKind.get(id)?.derivesFrom ?? [])].sort()) visit(prerequisite);
    order.push(id);
  };
  for (const id of [...new Set(requested)].sort()) visit(id);
  return order;
}
