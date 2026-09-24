/**
 * The one comparator every deterministic sort in this package uses.
 * `String.prototype.localeCompare` depends on the running locale (ICU data,
 * the `ch`/`cz` collation rules of some locales, etc.), so two machines can
 * sort the same ids differently. Code-point comparison (plain `<`/`>`) never
 * does: the compiled model is the same bytes wherever it is built.
 */
export function byCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Returns a new array, sorted by `byCodePoint`. */
export function sortedByCodePoint(values: readonly string[]): string[] {
  return [...values].sort(byCodePoint);
}
