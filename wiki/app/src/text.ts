/**
 * Word counting for the status bar. A word runs on whitespace, the same rule
 * the plain English tester and most editors use: the count is over the
 * document's own text (its Markdown) as the wiki holds it.
 */
export function wordCount(markdown: string): number {
  const found = markdown.match(/\S+/g);
  return found === null ? 0 : found.length;
}
