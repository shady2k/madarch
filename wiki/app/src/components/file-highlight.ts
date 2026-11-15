/**
 * A file's source highlighted by its language (madarch-u3vw.16): shiki draws the tokens, and the theme is the kit's own
 * tokens — every token colour is a CSS variable, so the same spans read in light and dark and nothing is baked into one
 * scheme. The wiki app carries no highlighter of its own; shiki is the one the kit's `SyntaxToken` was written for (its
 * `colors` and `fontStyle` are shiki's), and it is added as a dependency for this page's source only.
 */
import type { ThemedToken } from 'shiki';

/** One line of tokens, as the kit's file source draws it. */
export type HighlightedLine = readonly ThemedToken[];

/** The languages the shipped grammars cover; a language outside this set is drawn as plain text. */
export const HIGHLIGHT_LANGUAGES = ['typescript', 'javascript', 'tsx', 'jsx', 'json', 'yaml', 'markdown', 'shell', 'sql', 'go', 'xml', 'css', 'html'] as const;
export type HighlightLanguage = (typeof HIGHLIGHT_LANGUAGES)[number];

/** How a file's language from the graph reads in a grammar's name: the extensions the disk plugin decides. */
const BY_LANGUAGE: Readonly<Record<string, HighlightLanguage>> = {
  typescript: 'typescript', javascript: 'javascript', tsx: 'tsx', jsx: 'jsx', json: 'json', yaml: 'yaml', yml: 'yaml', markdown: 'markdown',
  shell: 'shell', bash: 'shell', sh: 'shell', sql: 'sql', go: 'go', xml: 'xml', html: 'html', css: 'css',
};

/** The grammar one of the graph's language words names, or undefined when the shipped grammars carry none. */
export function grammarOf(language: string | undefined, path?: string): HighlightLanguage | undefined {
  const held = (language ?? '').trim().toLowerCase();
  if (BY_LANGUAGE[held] !== undefined) return BY_LANGUAGE[held];
  const extension = (path ?? '').slice((path ?? '').lastIndexOf('.') + 1).toLowerCase();
  const byExtension: Readonly<Record<string, HighlightLanguage>> = { ts: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown', markdown: 'markdown', sh: 'shell', bash: 'shell', sql: 'sql', go: 'go', xml: 'xml', html: 'html', css: 'css' };
  return byExtension[extension];
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
  ['comment', 'punctuation.definition.comment'],
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
    const created = await createHighlighter({ themes: [themeWithScopes() as never], langs: [...HIGHLIGHT_LANGUAGES] });
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
export async function highlightLines(text: string, language: HighlightLanguage | undefined): Promise<readonly HighlightedLine[]> {
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
