/**
 * The templates `madarch new` offers (decision 0035, item 1: the choice is offered as templates — everything, only
 * the tracker, others — with fine-grained inclusion later). This is starter content, not engine behaviour: the menu
 * lists whatever is declared here, in this order, and neither the engine nor the command names a template or a kind
 * (the architecture rule `starter-data-when-copying` and "the engine holds no product data").
 *
 * A template names the kinds its manifest declares. `madarch` narrows the starter catalogue to those kinds and writes
 * the templates, plugins and workflows they use, and nothing they do not: `src/knowledge/seed.ts` owns that writing.
 */
export interface StarterTemplateText {
  readonly en: string;
  readonly ru: string;
}

export interface StarterTemplate {
  /** The id `--template` takes and the menu shows; unique among the declared templates. */
  readonly id: string;
  /** The template's name, in one or two words. */
  readonly title: StarterTemplateText;
  /** One line for the menu: what the product is. */
  readonly description: StarterTemplateText;
  /** The kinds the manifest declares: `all` is the whole starter catalogue, `none` writes no manifest at all. */
  readonly kinds: 'all' | 'none' | readonly string[];
}

/** The templates the command offers, in the order it shows them. */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    id: 'everything',
    title: { en: 'Everything', ru: 'Всё' },
    description: {
      en: 'The whole starter catalogue: code, history, documents, the work loop and the data model, with the plugins that read them.',
      ru: 'Весь стартовый каталог: код, история, документы, рабочий цикл и модель данных, с плагинами, которые их читают.',
    },
    kinds: 'all',
  },
  {
    id: 'none',
    title: { en: 'Nothing', ru: 'Ничего' },
    description: {
      en: 'Start from scratch: no manifest; write your own, following the guide.',
      ru: 'Начать с нуля: манифеста нет; напишите свой по руководству.',
    },
    kinds: 'none',
  },
];

/** The template the command takes when a person chose none and the command has no terminal to ask: the whole set. */
export const DEFAULT_STARTER_TEMPLATE = 'everything';

/** The template with this id, or undefined when none is declared; `templates` defaults to the declared data. */
export function starterTemplateOf(id: string, templates: readonly StarterTemplate[] = STARTER_TEMPLATES): StarterTemplate | undefined {
  return templates.find((template) => template.id === id);
}

/** The ids the menu and `--template` accept, in their declared order. */
export function starterTemplateIds(templates: readonly StarterTemplate[] = STARTER_TEMPLATES): string[] {
  return templates.map((template) => template.id);
}

/** The menu's numbered lines, one per declared template, in their declared order: the data decides what is offered. */
export function templateMenuLines(templates: readonly StarterTemplate[] = STARTER_TEMPLATES): string[] {
  return templates.map((template, at) => `  ${at + 1}. ${template.title.en} — ${template.description.en}`);
}
