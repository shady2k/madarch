/** Starter template menu and selection, read from the repository's bundled catalog/templates/*.yaml files. */
import { parseCatalogYaml } from '../product/manifest/kinds.js';
import { CATALOG_FILES } from './catalog-assets.js';
import { byCodePoint } from '../model/order.js';

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

/** Templates are repository data, embedded together with the catalogue for offline creation. */
const declaredTemplates = Object.entries(CATALOG_FILES)
  .filter(([path]) => /^templates\/[^/]+\.yaml$/.test(path))
  .map(([path, text]) => {
    const value: unknown = parseCatalogYaml(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`catalog/${path}:1: a starter template is a mapping`);
    const data = value as Record<string, unknown>;
    const id = path.slice('templates/'.length, -'.yaml'.length);
    for (const field of ['title', 'description']) {
      const words = data[field] as Record<string, unknown> | undefined;
      if (words === undefined || typeof words.en !== 'string' || typeof words.ru !== 'string') throw new Error(`catalog/${path}:1: ${field} names the template in en and ru`);
    }
    if (data.id !== id || typeof data.order !== 'number' || (data.kinds !== 'all' && data.kinds !== 'none' && (!Array.isArray(data.kinds) || !data.kinds.every((kind) => typeof kind === 'string')))) throw new Error(`catalog/${path}:1: a template declares its file's id, order and kinds (all, none, or kind names/folders)`);
    return { template: { id, title: data.title, description: data.description, kinds: data.kinds } as StarterTemplate, order: data.order, default: data.default === true };
  })
  .sort((a, b) => a.order - b.order || byCodePoint(a.template.id, b.template.id));

export const STARTER_TEMPLATES: readonly StarterTemplate[] = declaredTemplates.map((entry) => entry.template);
const defaults = declaredTemplates.filter((entry) => entry.default);
if (defaults.length !== 1) throw new Error('catalog/templates:1: exactly one starter template must declare default: true');
export const DEFAULT_STARTER_TEMPLATE = defaults[0]!.template.id;

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
