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

/**
 * The vocabulary key of a relation name: the edge kind (`manifest.depends-on`) as the graph names it, from a field's
 * camelCase name (`manifestDependsOn`) as a relation row carries it (madarch-64o5.96).
 */
export function relationKey(name: string): string {
  if (name.includes('.') || name.includes('-')) return name;
  const parts = name.split(/(?=[A-Z])/u);
  const head = parts.shift() ?? name;
  const rest = parts.map((part) => part.toLowerCase()).join('-');
  return rest === '' ? name : `${head.toLowerCase()}.${rest}`;
}

/** Engine metadata words, or the unchanged identifier when a product supplies no translation. */
export function relationWords(edge: string, language: string, inverse: boolean): string {
  const code = language.startsWith('ru') ? 'ru' : 'en';
  const words = inverse ? INVERSE_LABELS[code] : RELATION_LABELS[code];
  return words[edge] ?? words[relationKey(edge)] ?? edge;
}
