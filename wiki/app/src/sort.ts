/**
 * A code point comparison, smaller first (the same rule src/wiki/pages.ts
 * and the shell's own order keep): UTF-16 `<` orders surrogate pairs
 * wrongly, so the comparison runs over code points.
 */
export function byCodePoint(a: string, b: string): number {
  const ca = [...a].map((ch) => ch.codePointAt(0) ?? 0);
  const cb = [...b].map((ch) => ch.codePointAt(0) ?? 0);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i] as number, y = cb[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (ca.length === cb.length) return 0;
  return ca.length < cb.length ? -1 : 1;
}
