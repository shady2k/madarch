/**
 * What a diagram request answers when the renderer cannot draw (madarch-64o5.97): one plain sentence in the reader's
 * language, never the server's JSON and never a path inside the bundle. The page is opened as a document — the archify
 * tab is an iframe — so it must read as prose where the picture would stand.
 */

/** The sentence per language; the renderer's name is a product name and stays as it is. */
const SENTENCES: Readonly<Record<string, (renderer: string) => string>> = {
  en: (renderer) => `${renderer} could not draw this diagram.`,
  ru: (renderer) => `${renderer} не смог нарисовать эту диаграмму.`,
};

/** The one sentence for a language the wiki serves; English stands in for a language it does not. */
export function diagramFailureSentence(renderer: string, language: string | undefined): string {
  const said = SENTENCES[language === 'ru' ? 'ru' : 'en']!;
  return said(renderer);
}

/** The escaped text of a page: a renderer name is data, never markup. */
function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** The page a failed diagram request answers: the sentence alone, in the wiki's own colours and the reader's language. */
export function diagramFailurePage(renderer: string, language: string | undefined): string {
  const lang = language === 'ru' ? 'ru' : 'en';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escape(renderer)}</title>
<style>
  :root { color-scheme: light dark; --page: #ffffff; --ink: #2e3034; }
  @media (prefers-color-scheme: dark) { :root { --page: #292929; --ink: #e5e5e5; } }
  html, body { margin: 0; min-height: 100%; background: var(--page); color: var(--ink); }
  body { display: flex; align-items: center; justify-content: center; padding: 24px; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  p { margin: 0; max-width: 42ch; text-align: center; }
</style>
</head>
<body><p>${escape(diagramFailureSentence(renderer, lang))}</p></body>
</html>
`;
}
