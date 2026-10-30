/**
 * A pure answer, kept by the exact text it was computed from. A page's
 * language is read from its Markdown tree; asking again for the same text
 * (every page read of the same revision does) must not parse it again.
 *
 * The cache is bounded: the least recently used text is dropped first. A text
 * key is the document itself, so the bound is a bound on the revisions held,
 * never on how often a revision is asked for.
 */
export function memoByText<T>(compute: (text: string) => T, limit = 512): (text: string) => T {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`src/model/memo.ts: a text cache needs a positive whole limit, got ${limit}`);
  const held = new Map<string, T>();
  return (text: string): T => {
    if (held.has(text)) {
      const value = held.get(text) as T;
      held.delete(text);
      held.set(text, value);
      return value;
    }
    const value = compute(text);
    held.set(text, value);
    if (held.size > limit) {
      const oldest = held.keys().next().value;
      if (oldest !== undefined) held.delete(oldest);
    }
    return value;
  };
}
