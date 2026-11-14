/**
 * What every kind's words say (madarch-64o5.68): a kind's `definition` and the descriptions in each interface
 * language say what the thing is in the world, in plain words for a product engineer. They never say how madarch
 * comes by the thing, and they carry no notes addressed to us.
 *
 * The test holds the words themselves, not the manifest's schema: the catalog reader already refuses a kind without
 * a definition or a description. It reads the starter catalogue as it ships, so a kind added later is covered too.
 */
import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { byCodePoint } from '../src/model/order.js';

/** The words of a kind that describe how the product is made rather than what the thing is. */
const FORBIDDEN_ENGLISH = /(?<![A-Za-z])(?:extractors?|fills?|filled|filling|plugins?|producers?|graphs?|graphing|engines?|pages?|wikis?|madarch)(?![A-Za-z])/gi;
/** The same words in Russian, with the word forms a description may use. */
const FORBIDDEN_RUSSIAN = /(?<![а-яё])(?:извлекател(?:ь|я|ю|ем|е|и|ей|ям|ями|ях)|заполнени(?:е|я|ю|ем|и|й|ям|ями|ях)|плагин(?:а|у|ом|е|ы|ов|ам|ами|ах)?|граф(?:а|у|ом|е|ы|ов|ам|ами|ах)?|движ(?:ок|ка|ку|ком|ке|ки|ков|кам|ками|ках)|страниц(?:а|ы|е|у|ей|ам|ами|ах)?|вики)(?![а-яё])/gi;

/** One kind's words: its file, its definition and its descriptions by language. */
interface KindWords {
  readonly path: string;
  readonly definition: unknown;
  readonly descriptions: Readonly<Record<string, unknown>>;
}

/** Every kind of the starter catalogue, in code-point order of its file. */
function kinds(): KindWords[] {
  const words: KindWords[] = [];
  for (const path of Object.keys(CATALOG_FILES).sort(byCodePoint)) {
    if (path === 'catalog.yaml') continue;
    const declaration = parse(CATALOG_FILES[path]!) as Record<string, unknown>;
    if (declaration['id'] === undefined) continue;
    const descriptions = declaration['description'];
    words.push({
      path,
      definition: declaration['definition'],
      descriptions: descriptions !== null && typeof descriptions === 'object' && !Array.isArray(descriptions)
        ? descriptions as Record<string, unknown>
        : {},
    });
  }
  return words;
}

/** The texts a kind carries, by the field a finding names. */
function texts(kind: KindWords): [string, string | undefined][] {
  const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
  return [
    ['definition', text(kind.definition)],
    ['description.en', text(kind.descriptions['en'])],
    ['description.ru', text(kind.descriptions['ru'])],
  ];
}

describe('the words of every kind (madarch-64o5.68)', () => {
  test('say what the thing is, never how the product comes by it', () => {
    const findings: string[] = [];
    for (const kind of kinds()) {
      for (const [field, text] of texts(kind)) {
        if (text === undefined) continue;
        const found = new Set([
          ...[...text.matchAll(FORBIDDEN_ENGLISH)].map((match) => match[0].toLowerCase()),
          ...[...text.matchAll(FORBIDDEN_RUSSIAN)].map((match) => match[0].toLowerCase()),
        ]);
        for (const word of [...found].sort(byCodePoint)) findings.push(`${kind.path}: ${field} says "${word}"`);
      }
    }
    expect(findings).toEqual([]);
  });

  test('describe every kind in Russian', () => {
    const missing = kinds().filter((kind) => {
      const ru = kind.descriptions['ru'];
      return typeof ru !== 'string' || ru.trim() === '';
    }).map((kind) => kind.path);
    expect(missing).toEqual([]);
  });
});
