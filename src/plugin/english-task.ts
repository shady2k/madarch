/**
 * What madarch sends an agent is English only (madarch-64o5.107): a kind's definition, its labels, a field's words and
 * every other locale map the manifest holds are resolved to their English text before the task and the output contract
 * are built. The reader's language is the people's alone — a page shows Russian to a Russian reader, and the agent is
 * sent one text once, never the same words twice in two languages.
 *
 * A locale map is an object whose every key is a two-letter language tag (`en`, `ru`, and a region or script behind a
 * dash), as the manifest declares them: `{ en: …, ru: … }` and the kind's `labels: { en: { one, many }, ru: { … } }`.
 * Its English value stands in its place, and a locale map with no `en` is left out rather than sent in another
 * language — the manifest refuses such a map where it is read, so the omission is the manifest's finding, not a silent
 * translation. Every other value — a name, a pattern, a path, a number, a type — is handed on as it is.
 */

/** The language an agent is given, always. */
export const AGENT_LANGUAGE = 'en';

/** A key a locale map names a language by: a two-letter tag, with a region or a script behind a dash when it has one. */
const LANGUAGE_TAG = /^[a-z]{2}(?:[-_][A-Za-z0-9]{1,8})*$/u;

/** Whether a value is a map of languages to texts: every key a language tag and at least one entry. */
export function isLocaleMap(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => LANGUAGE_TAG.test(key));
}

/**
 * One value as an agent is given it: every locale map resolved to its English text, recursively, and a map without an
 * English entry left out (the key it stood under is dropped rather than sent in another language). The value itself is
 * never changed: the answer is a copy.
 */
export function englishOnly<T>(value: T): T {
  const resolve = (held: unknown): { seen: boolean; value: unknown } => {
    if (Array.isArray(held)) return { seen: true, value: held.map((item) => resolve(item).value) };
    if (held === null || typeof held !== 'object') return { seen: true, value: held };
    if (isLocaleMap(held)) {
      const english = (held as Record<string, unknown>)[AGENT_LANGUAGE];
      return english === undefined ? { seen: false, value: undefined } : { seen: true, value: resolve(english).value };
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(held as Record<string, unknown>)) {
      const resolved = resolve(inner);
      if (resolved.seen) out[key] = resolved.value;
    }
    return { seen: true, value: out };
  };
  return resolve(value).value as T;
}
