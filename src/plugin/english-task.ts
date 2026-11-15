/**
 * What madarch sends an agent is English only (madarch-64o5.107): the values the manifest *declares* localized — a kind's
 * or a field's `labels`, a kind's `description` and `definition` — are resolved to their English text before the task and
 * the output contract are built. The reader's language is the people's alone — a page shows Russian to a Russian reader,
 * and the agent is sent one text once.
 *
 * A value is a locale map only because the manifest declares that key localized (src/product/manifest/kinds.ts): its
 * value maps a language tag to a text. Nothing else is read as a translation — an object whose keys happen to be
 * two letters (`{values: {id, os}}`, a JSON schema's `properties: {en, ru}`) is ordinary data and passes untouched
 * (madarch-64o5.107, the review of this change).
 */

/** The language an agent is given, always. */
export const AGENT_LANGUAGE = 'en';

/** The keys the manifest declares localized: their values are locale maps and nothing else is. */
export const LOCALIZED_KEYS: readonly string[] = ['labels', 'description', 'descriptions', 'definition'];

/** A key a locale map names a language by: a two-letter tag, with a region or a script behind a dash when it has one. */
const LANGUAGE_TAG = /^[a-z]{2}(?:[-_][A-Za-z0-9]{1,8})*$/u;

/** Whether a *declared localized* value is a map of languages to texts: every key a language tag and at least one entry. */
export function isLocaleMap(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => LANGUAGE_TAG.test(key));
}

/** The English text of one declared locale map: its `en` value resolved, or undefined when it holds none. */
function englishOf(map: Readonly<Record<string, unknown>>): unknown {
  const english = map[AGENT_LANGUAGE];
  return english === undefined ? undefined : resolve(english);
}

/** One value as an agent is given it: declared localized keys resolved to their English text, everything else untouched. */
function resolve(held: unknown): unknown {
  if (Array.isArray(held)) return held.map(resolve);
  if (held === null || typeof held !== 'object') return held;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(held as Record<string, unknown>)) {
    if (LOCALIZED_KEYS.includes(key) && isLocaleMap(inner)) {
      const english = englishOf(inner);
      // A declared map with no English text is left out rather than sent in another language: the manifest refuses such
      // a map where it is read, so the omission is the manifest's finding, not a silent translation.
      if (english !== undefined) out[key] = english;
      continue;
    }
    out[key] = resolve(inner);
  }
  return out;
}

/**
 * One value as an agent is given it: the values the manifest declares localized are resolved to their English text,
 * recursively, and a declared map without an English entry is left out. Every other value — a name, a pattern, a path, a
 * number, an object whose keys only look like language tags — is handed on as it is. The answer is a copy.
 */
export function englishOnly<T>(value: T): T {
  return resolve(value) as T;
}
