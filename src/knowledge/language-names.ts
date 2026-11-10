/**
 * A language's name as a reader reads it (madarch-u3vw.15): the name the language classifier itself declares for
 * the language, never a list of ours. `linguist-languages` (MIT, the dataset the tree pass classifies with) names a
 * language and states its group; a group whose own declaration names no extension or file is only the umbrella name
 * of its variants (OpenAPI Specification v2), so that name is the one a reader reads, while a group that is itself a
 * detected language (TypeScript for TSX) leaves each variant its own name.
 *
 * The dataset is loaded on the first name asked for, not with this module: a command that never shows a language pays
 * nothing for the several megabytes the dataset weighs, and the command's own startup stays what it was.
 */
import { createRequire } from 'node:module';
import { byCodePoint } from '../model/order.js';

interface Declaration {
  readonly name?: string;
  readonly group?: string;
  readonly extensions?: readonly string[];
  readonly filenames?: readonly string[];
}

const load = createRequire(import.meta.url);
let dataset: Record<string, Declaration | undefined> | undefined;

/** The classifier's declaration of one language, the dataset read once on the first question about a name. */
function declarationOf(name: string): Declaration | undefined {
  dataset ??= load('linguist-languages') as Record<string, Declaration | undefined>;
  return dataset[name];
}

/** The name the classifier declares for one language, or the name itself when the dataset does not declare it. */
export function languageDisplayName(name: string): string {
  const entry = declarationOf(name);
  if (entry === undefined) return name;
  const group = entry.group;
  if (group !== undefined) {
    const parent = declarationOf(group);
    // A group with no extension and no file of its own is a name only: the declaration of a family, not a result the
    // classifier can answer for a path. Its variants read as that name; TSX keeps TSX, whose group TypeScript is a language.
    if (parent !== undefined && (parent.extensions ?? []).length === 0 && (parent.filenames ?? []).length === 0) return parent.name ?? group;
  }
  return entry.name ?? name;
}

/** One open opinion as the language read needs it: the fields it states. */
export interface LanguageOpinion {
  readonly values: Readonly<Record<string, unknown>>;
}

/**
 * Every language the open opinions of one file name, in code point order: the `languages` each states and the `lang`
 * of the text it was read in. Several opinions that name different languages therefore read as the candidates they
 * name, never as one of them picked (the one-graph amendment's rule).
 */
export function opinionLanguageCandidates(opinions: readonly LanguageOpinion[]): string[] {
  const candidates = new Set<string>();
  for (const opinion of opinions) {
    const languages = opinion.values['languages'];
    if (Array.isArray(languages)) for (const one of languages) if (typeof one === 'string') candidates.add(one);
    const lang = opinion.values['lang'];
    if (typeof lang === 'string') candidates.add(lang);
  }
  return [...candidates].sort(byCodePoint);
}

/** What one file's language claim reads as: its one name, or the candidates of an undetermined answer with no name. */
export interface LanguageWords {
  /** The one language's name, when the claim names one; null for an undetermined answer or no language at all. */
  readonly name: string | null;
  /** The candidates' names, in the classifier's own order; empty when no rule matched. */
  readonly candidates: readonly string[];
  /** Whether the classifier answered more than one language, so the page says the language is not determined. */
  readonly undetermined: boolean;
}

/**
 * One file's language claim in words: a resolved language reads as its one name; an `ambiguous` answer, or a claim
 * that holds several candidates and no language, reads as its candidates and is undetermined; `unknown` and no claim
 * read as nothing, which is the one case a page leaves empty.
 */
export function languageWords(language: string | null | undefined, candidates: readonly string[]): LanguageWords {
  const held = [...new Set(candidates.filter((one) => one !== '' && one !== 'unknown' && one !== 'ambiguous'))];
  if (language !== null && language !== undefined && language !== 'unknown' && language !== 'ambiguous') {
    const name = languageDisplayName(language);
    return { name, candidates: held.length === 0 ? [name] : held.map(languageDisplayName), undetermined: false };
  }
  if (held.length > 0) return { name: null, candidates: held.map(languageDisplayName), undetermined: true };
  return { name: null, candidates: [], undetermined: false };
}
