/**
 * Element ids made the identifiers of a text a frontend reads (Mermaid
 * node ids, LikeC4 names), kept unique. This module touches no Bun-specific
 * API.
 */
import { byCodePoint } from '../model/order.js';

/**
 * Each element id made safe by `safe` and kept unique among them: ids that
 * are safe as they stand keep themselves; the others, in code point order,
 * take their safe form or, after a clash, the first free `<safe>_2`,
 * `<safe>_3`, ...
 */
export function uniqueSafeIds(elementIds: readonly string[], safe: (id: string) => string): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const sorted = [...elementIds].sort(byCodePoint);
  for (const id of sorted.filter((id) => safe(id) === id)) {
    ids.set(id, id);
    used.add(id);
  }
  for (const id of sorted.filter((id) => safe(id) !== id)) {
    const base = safe(id);
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}_${n}`;
    ids.set(id, candidate);
    used.add(candidate);
  }
  return ids;
}
