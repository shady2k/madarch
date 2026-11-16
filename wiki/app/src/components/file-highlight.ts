/**
 * A file's source highlighted by its language (madarch-u3vw.16): shiki draws the tokens, and the theme is the kit's own
 * tokens — every token colour is a CSS variable, so the same spans read in light and dark and nothing is baked into one
 * scheme. The wiki app carries no highlighter of its own; shiki is the one the kit's `SyntaxToken` was written for (its
 * `colors` and `fontStyle` are shiki's), and it is added as a dependency for this page's source only.
 */
import { bundledLanguagesInfo, createHighlighter, createJavaScriptRegexEngine, type ThemedToken } from 'shiki';

/** One line of tokens, as the kit's file source draws it. */
export type HighlightedLine = readonly ThemedToken[];
/**
 * The grammars the highlighter draws, named by the registry's own aliases and resolved to its ids: a fixed set, so a shiki
 * release that adds a grammar (or renames one) cannot change what a product's file is drawn as. The aliases are the file
 * extensions and the graph's language words; none of them is a word of the product catalogue, which the app may not spell.
 */
const WANTED_ALIASES: readonly string[] = ['ts', 'tsx', 'js', 'jsx', 'json', 'yaml', 'yml', 'md', 'mdx', 'sh', 'bash', 'sql', 'go', 'xml', 'html', 'css', 'py', 'rs', 'toml', 'diff'];

/** The registry's entries for those aliases: one entry a grammar, its aliases included, in code point order of its id. */
const GRAMMARS: readonly { readonly id: string; readonly aliases?: readonly string[] }[] = (() => {
  const found = new Map<string, { readonly id: string; readonly aliases?: readonly string[] }>();
  for (const alias of WANTED_ALIASES) {
    const held = bundledLanguagesInfo.find((one) => one.id === alias || (one.aliases ?? []).includes(alias));
    if (held !== undefined) found.set(held.id, held);
  }
  return [...found.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
})();

/** The grammar of the drawn set a word names: its id or one of its aliases, or undefined when the set holds none. */
function grammarNamed(word: string): string | undefined {
  if (word === '') return undefined;
  return GRAMMARS.find((one) => one.id === word || (one.aliases ?? []).includes(word))?.id;
}

/**
 * The grammar one of the graph's language words names, or undefined when the drawn grammars carry none. A word the graph
 * does not name falls back to the file's extension, and the extension is resolved through the same set.
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

/**
 * The one highlighter this page opens, made on first use and kept for the page's life. Its engine is named: shiki's
 * default is a WASM build whose load differs by architecture and by what a runner's install kept, and a page whose tokens
 * depend on that draws plain text on one machine and coloured text on another. The JavaScript regex engine is the same
 * code everywhere. The theme is loaded once, by name, so every call colours a token from it and never from a per-call
 * registration.
 */
const THEME_NAME = 'madarch-kit';

let highlighter: Promise<{ codeToTokens: (text: string, options: { lang: string }) => { tokens: ThemedToken[][] } }> | undefined;

async function highlighterOf(): Promise<NonNullable<Awaited<typeof highlighter>>> {
  highlighter ??= (async () => {
    const created = await createHighlighter({
      engine: createJavaScriptRegexEngine(),
      themes: [themeWithScopes() as never],
      langs: GRAMMARS.map((one) => one.id),
    });
    return { codeToTokens: (text: string, options: { lang: string }) => created.codeToTokens(text, { lang: options.lang as never, theme: THEME_NAME }) };
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
    const tokens = engine.codeToTokens(text, { lang: language }).tokens;
    // A trailing newline ends the last line rather than starting an empty one, as the lines' own count does.
    if (text.endsWith('\n') && tokens.length > lines.length) return tokens.slice(0, lines.length);
    return tokens;
  } catch {
    return lines.map((line) => [{ content: line, color: 'var(--text)', offset: 0 }]);
  }
}
