/**
 * A file's source highlighted by its language (madarch-u3vw.16): shiki draws the tokens, and the theme is the kit's own
 * tokens — every token colour is a CSS variable, so the same spans read in light and dark and nothing is baked into one
 * scheme. The wiki app carries no highlighter of its own; shiki is the one the kit's `SyntaxToken` was written for (its
 * `colors` and `fontStyle` are shiki's), and it is added as a dependency for this page's source only.
 */
import { bundledLanguagesInfo, type ThemedToken } from 'shiki';

/** One line of tokens, as the kit's file source draws it. */
export type HighlightedLine = readonly ThemedToken[];
/**
 * The grammars the highlighter can draw, read from shiki's own registry: the engine keeps no list of its own, and the words
 * a graph names a language by are the registry's ids and aliases.
 */
const GRAMMARS: readonly { readonly id: string; readonly aliases?: readonly string[] }[] = bundledLanguagesInfo;

/** The registry's grammar a word names: its id or one of its aliases, or undefined when no grammar claims the word. */
function grammarNamed(word: string): string | undefined {
  if (word === '') return undefined;
  return GRAMMARS.find((one) => one.id === word || (one.aliases ?? []).includes(word))?.id;
}

/**
 * The grammar one of the graph's language words names, or undefined when the shipped grammars carry none. A word the graph
 * does not name falls back to the file's extension, and the extension goes through the same registry.
 */
export function grammarOf(language: string | undefined, path?: string): string | undefined {
  const word = (language ?? '').trim().toLowerCase();
  const fromWord = grammarNamed(word);
  if (fromWord !== undefined) return fromWord;
  const held = path ?? '';
  const extension = held.includes('.') ? held.slice(held.lastIndexOf('.') + 1).toLowerCase() : '';
  return grammarNamed(extension);
}

/**
 * The theme, in the kit's tokens: a token's colour is the variable its kind names, so the scheme decides the ink. The
 * comments, strings, keywords, numbers, functions and types are the six the page's own tokens hold for both schemes.
 */
export const KIT_THEME: { readonly name: string; readonly type: 'light'; readonly settings: readonly { readonly settings: { readonly foreground?: string; readonly fontStyle?: string } }[]; readonly colors: Record<string, string> } = {
  name: 'madarch-kit',
  type: 'light',
  colors: { 'editor.background': 'transparent', 'editor.foreground': 'var(--text)' },
  settings: [
    { settings: { foreground: 'var(--text)' } },
    { settings: { foreground: 'var(--syntax-comment)', fontStyle: 'italic' } },
    { settings: { foreground: 'var(--syntax-string)' } },
    { settings: { foreground: 'var(--syntax-keyword)' } },
    { settings: { foreground: 'var(--syntax-number)' } },
    { settings: { foreground: 'var(--syntax-function)' } },
    { settings: { foreground: 'var(--syntax-type)' } },
  ],
};

/** The scope lists the kit theme's settings stand for, in the order `KIT_THEME.settings` holds them. */
const SCOPES: readonly (readonly string[])[] = [
  [],
  ['comment.line', 'comment.block', 'punctuation.definition.comment'],
  ['string', 'punctuation.definition.string', 'constant.character.escape'],
  ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control'],
  ['constant.numeric', 'constant.language', 'constant.other'],
  ['entity.name.function', 'support.function', 'meta.function-call'],
  ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class'],
];

/** The theme with its scope tables, as shiki takes one: a `settings` rule per scope list, built from `KIT_THEME`. */
function themeWithScopes(): Record<string, unknown> {
  return {
    ...KIT_THEME,
    tokenColors: SCOPES.map((scope, at) => ({ scope: [...scope], settings: KIT_THEME.settings[at]!.settings })),
    settings: undefined,
  };
}

/** The one highlighter this page opens, made on first use and kept for the page's life. */
let highlighter: Promise<{ codeToTokens: (text: string, options: { lang: string; theme: unknown }) => { tokens: ThemedToken[][] } }> | undefined;

async function highlighterOf(): Promise<NonNullable<Awaited<typeof highlighter>>> {
  highlighter ??= (async () => {
    const { createHighlighter } = await import('shiki');
    const created = await createHighlighter({ themes: [themeWithScopes() as never], langs: GRAMMARS.map((one) => one.id) });
    return { codeToTokens: (text: string, options: { lang: string; theme: unknown }) => created.codeToTokens(text, options as never) };
  })();
  return await highlighter;
}

/** One text as plain tokens, a line each: what a page draws before the highlighter has answered. */
export function plainLines(text: string): readonly HighlightedLine[] {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return lines.map((line) => [{ content: line, color: 'var(--text)', offset: 0 }]);
}

/** One text as tokens, line by line: the language's grammar, or every line one plain token when the grammars carry none. */
export async function highlightLines(text: string, language: string | undefined): Promise<readonly HighlightedLine[]> {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (language === undefined || text.trim() === '') return lines.map((line) => [{ content: line, color: 'var(--text)', offset: 0 }]);
  try {
    const engine = await highlighterOf();
    const tokens = engine.codeToTokens(text, { lang: language, theme: themeWithScopes() }).tokens;
    // A trailing newline ends the last line rather than starting an empty one, as the lines' own count does.
    if (text.endsWith('\n') && tokens.length > lines.length) return tokens.slice(0, lines.length);
    return tokens;
  } catch {
    return lines.map((line) => [{ content: line, color: 'var(--text)', offset: 0 }]);
  }
}
