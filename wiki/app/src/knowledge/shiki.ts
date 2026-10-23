/**
 * Colored syntax highlighting with Shiki (the highlighter the shadcn ecosystem
 * uses), loaded on first use so a page without code does not carry it. The
 * grammars are fetched one by one when a language is first met, the regular
 * expressions run on the browser's own engine (no WebAssembly), and the colors
 * are a light and a dark theme at once: each token carries both as custom
 * properties and the stylesheet picks the pair that follows the system.
 */
import type { HighlighterCore, ThemedToken } from 'shiki/core';

/** One token of a colored line. */
export type ColoredToken = { text: string; style: Record<string, string>; fontStyle: number };

type Grammar = () => Promise<unknown>;

/** The wiki's language names (`languageOf` in the engine) and the grammar of each. */
const GRAMMARS: Record<string, { id: string; load: Grammar }> = {
  typescript: { id: 'typescript', load: () => import('shiki/langs/typescript.mjs') },
  javascript: { id: 'javascript', load: () => import('shiki/langs/javascript.mjs') },
  go: { id: 'go', load: () => import('shiki/langs/go.mjs') },
  sql: { id: 'sql', load: () => import('shiki/langs/sql.mjs') },
  protobuf: { id: 'proto', load: () => import('shiki/langs/proto.mjs') },
  yaml: { id: 'yaml', load: () => import('shiki/langs/yaml.mjs') },
  json: { id: 'json', load: () => import('shiki/langs/json.mjs') },
  markdown: { id: 'markdown', load: () => import('shiki/langs/markdown.mjs') },
  dockerfile: { id: 'dockerfile', load: () => import('shiki/langs/dockerfile.mjs') },
  shell: { id: 'shellscript', load: () => import('shiki/langs/shellscript.mjs') },
  toml: { id: 'toml', load: () => import('shiki/langs/toml.mjs') },
  makefile: { id: 'make', load: () => import('shiki/langs/make.mjs') },
  prisma: { id: 'prisma', load: () => import('shiki/langs/prisma.mjs') },
};

/** Texts longer than this keep the plain scanner: coloring a huge file would hold the page. */
export const COLOR_LIMIT_CHARACTERS = 300_000;

let loading: Promise<HighlighterCore> | undefined;
const loaded = new Set<string>();

async function core(): Promise<HighlighterCore> {
  loading ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark.mjs'),
    ]);
    return await createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return await loading;
}

/** Whether a language has a grammar. */
export const canColor = (language: string): boolean => GRAMMARS[language] !== undefined;

/**
 * The lines of a text as colored tokens, or `null` when the language has no grammar, the text is too long or the
 * grammar could not be loaded (the caller keeps the plain scanner's tokens then).
 */
export async function colorize(text: string, language: string): Promise<ColoredToken[][] | null> {
  const grammar = GRAMMARS[language];
  if (grammar === undefined || text.length > COLOR_LIMIT_CHARACTERS) return null;
  try {
    const highlighter = await core();
    if (!loaded.has(grammar.id)) {
      const module = (await grammar.load()) as { default: never };
      await highlighter.loadLanguage(module.default);
      loaded.add(grammar.id);
    }
    const result = highlighter.codeToTokens(text, { lang: grammar.id, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false });
    return result.tokens.map((line: ThemedToken[]) => line.map((token) => ({ text: token.content, style: (token.htmlStyle ?? {}) as Record<string, string>, fontStyle: token.fontStyle ?? 0 })));
  } catch (error) {
    console.error(`src/knowledge/shiki.ts: the ${language} text could not be colored (${error instanceof Error ? error.message : String(error)}); it is shown with the plain highlighter`);
    return null;
  }
}
