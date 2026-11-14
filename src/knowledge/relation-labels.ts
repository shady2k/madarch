/** Words for engine-owned metadata relations only; product relations are graph declarations. */
const RELATION_LABELS: Readonly<Record<'en' | 'ru', Readonly<Record<string, string>>>> = {
  "en": {
    "manifest.depends-on": "depends on"
  },
  "ru": {
    "manifest.depends-on": "зависит от"
  }
};
const INVERSE_LABELS: Readonly<Record<'en' | 'ru', Readonly<Record<string, string>>>> = {
  "en": {
    "manifest.depends-on": "depended on by"
  },
  "ru": {
    "manifest.depends-on": "от него зависят"
  }
};

/** Engine metadata words, or the unchanged identifier when a product supplies no translation. */
export function relationWords(edge: string, language: string, inverse: boolean): string {
  const code = language.startsWith('ru') ? 'ru' : 'en';
  return (inverse ? INVERSE_LABELS[code][edge] : RELATION_LABELS[code][edge]) ?? edge;
}
