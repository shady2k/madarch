/** Structured page templates are graph opinions, never product-file text. */
import { createHash } from 'node:crypto';

/** The blocks the engine ships. */
export const BLOCK_NAMES = ['body', 'graph', 'relations', 'related', 'callers', 'callees', 'source', 'er', 'sequence', 'system', 'modules', 'treemap', 'files', 'history', 'definition', 'stated', 'implementedby', 'linkedfrom', 'properties', 'children', 'term', 'members', 'repository', 'folder', 'file', 'overview-about', 'overview-how', 'overview-data', 'overview-terms', 'overview-status', 'overview-reading'] as const;
type BlockName = (typeof BLOCK_NAMES)[number];

/** The languages a template may write a parameter in (`title-ru`): the wiki's interface languages. */
const TEMPLATE_LANGUAGES: readonly string[] = ['en', 'ru'];

/**
 * A block's parameters as the page reads them: a parameter the template wrote in the reader's language (`title-ru`,
 * `more-ru`) folds into its base name (`title`, `more`), and every other language's variant is dropped. The words of
 * an interface stay the template's; the block picks no language of its own.
 */
export function foldLanguageParams(params: Readonly<Record<string, string>>, lang: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    const cut = name.lastIndexOf('-');
    const suffix = cut < 0 ? '' : name.slice(cut + 1);
    if (!TEMPLATE_LANGUAGES.includes(suffix)) { out[name] = value; continue; }
    if (lang !== undefined && suffix === lang) out[name.slice(0, cut)] = value;
  }
  return out;
}

/** Literal text and attributes are separate nodes; the reader parses no interpolation syntax. */
export type TemplatePart =
  | { type: 'text'; text: string; line: number }
  | { type: 'attribute'; name: string; line: number }
  | { type: 'block'; name: BlockName; params: Readonly<Record<string, string>>; line: number }
  | { type: 'problem'; message: string; line: number };

/** Validate an opinion's structure without interpreting any product language. */
export function templatePartsOf(value: unknown): readonly TemplatePart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const part of value) {
    if (part === null || typeof part !== 'object' || !Number.isInteger(part.line) || part.line < 1) return undefined;
    if (part.type === 'text' && typeof part.text === 'string') continue;
    if (part.type === 'attribute' && typeof part.name === 'string') continue;
    if (part.type === 'problem' && typeof part.message === 'string') continue;
    if (part.type === 'block' && BLOCK_NAMES.includes(part.name) && part.params !== null && typeof part.params === 'object' && !Array.isArray(part.params) && Object.values(part.params).every((item) => typeof item === 'string')) continue;
    return undefined;
  }
  return value as TemplatePart[];
}

/**
 * The identity of a block of a page: its name and its parameters, never the line
 * it stands on, so a template edited above a block keeps the identity a reader's
 * own read of that block asks for (decision 0032 section 8).
 */
export function blockIdentity(name: string, params: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify(Object.keys(params).sort().map((key) => [key, params[key]]));
  return `${name}-${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
}

/** Escapes what Markdown would read as markup, so an attribute's value is shown as it is. */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]<>()#+!|~]/g, (char) => `\\${char}`).replace(/\n/g, ' ');
}
