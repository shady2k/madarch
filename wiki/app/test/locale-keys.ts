/**
 * Test support for the wiki's surfaces (madarch-stm0.6): a raw i18n key that reached the screen is a bug, not a word.
 * The keys are the English locale's own paths, flattened; a rendered token that is one of them is reported.
 */
import en from '../src/locales/en.json';

function flatten(value: unknown, prefix = '', into = new Set<string>()): Set<string> {
  if (value !== null && typeof value === 'object') {
    for (const [key, held] of Object.entries(value as Record<string, unknown>)) flatten(held, prefix === '' ? key : `${prefix}.${key}`, into);
  } else {
    into.add(prefix);
  }
  return into;
}

const KEYS = flatten(en);
const KEY_SHAPE = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/u;

/** The locale key a piece of rendered text shows as a token, or undefined when it shows none. */
export function localeKeyIn(text: string): string | undefined {
  for (const token of text.split(/[^A-Za-z0-9._-]+/u)) {
    if (KEY_SHAPE.test(token) && KEYS.has(token)) return token;
  }
  return undefined;
}

/** All text a reader can see or hear in a region: its text and the names and titles of its controls. */
export function renderedText(root: ParentNode): string {
  const parts = [root.textContent ?? ''];
  for (const node of root.querySelectorAll('[title], [aria-label], [placeholder]')) {
    for (const name of ['title', 'aria-label', 'placeholder']) {
      const value = node.getAttribute(name);
      if (value !== null) parts.push(value);
    }
  }
  return parts.join('\n');
}
