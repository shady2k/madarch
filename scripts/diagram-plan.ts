/** Exact identity checks for the fixed diagram acceptance plan. No subset is a completed walk. */
export function sameKeys(expected: readonly string[], actual: readonly string[], label: string): void {
  if (new Set(expected).size !== expected.length || new Set(actual).size !== actual.length || JSON.stringify([...expected].sort()) !== JSON.stringify([...actual].sort())) throw new Error(`${label}: missing ${JSON.stringify(expected.filter(key => !actual.includes(key)))}; unexpected ${JSON.stringify(actual.filter(key => !expected.includes(key)))}; expected/actual ${expected.length}/${actual.length}; duplicates ${actual.length - new Set(actual).size}`);
}

export type AdjacentView = { spec: { type: string }; elements: readonly { id: string }[]; fullElements?: readonly { id: string }[]; edges: readonly { step?: number; from: string; to: string; label: string; href?: string | null }[] };
export function adjacentKeys(view: AdjacentView): string[] {
  return view.spec.type === 'sequence' ? view.edges.map(edge => JSON.stringify([edge.step ?? null, edge.from, edge.to, edge.label, edge.href ?? null])) : (view.fullElements ?? view.elements).map(element => element.id);
}
export function requireHint(expected: string, actual: string, language: string): void {
  const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ');
  if (normalize(actual) !== normalize(expected)) throw new Error(`reading hint ${language}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`);
}
