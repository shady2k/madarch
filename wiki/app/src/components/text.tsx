/** The graph's Markdown, drawn in the reading column (decision 0036, section 7). */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { marked, type Tokens } from 'marked';
import { ReadingContent } from './ui/reading-content.js';
import { Paragraph } from './ui/typography.js';
import { at, localized } from './format.js';
import type { SectionContext } from './types.js';

/** The text a heading or a link is shown by, as the document wrote it. */
function inlineOf(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, tokens: Tokens.Generic[]): string {
  return this.parser.parseInline(tokens);
}

/** The anchor a heading answers to: its letters and digits, the spaces between words as one hyphen. */
function anchorOf(text: string): string {
  const kept: string[] = [];
  let gap = false;
  for (const character of text.toLowerCase()) {
    if (wordCharacter(character)) {
      kept.push(character);
      gap = false;
    } else if (!gap) {
      kept.push('-');
      gap = true;
    }
  }
  let start = 0;
  let end = kept.length;
  while (start < end && kept[start] === '-') start += 1;
  while (end > start && kept[end - 1] === '-') end -= 1;
  return kept.slice(start, end).join('');
}

/** Whether a character is a letter or a digit: ASCII, a cased script's letter, or an uncased one past ASCII. */
function wordCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  if (character.toLowerCase() !== character.toUpperCase()) return true;
  // CJK and the scripts that case nothing: a letter typographically, kept as its own character.
  return code >= 0x3400;
}

marked.use({
  gfm: true,
  breaks: false,
  // The product's own text is Markdown: a raw HTML block in it would be markup the page did not promise to draw.
  renderer: {
    html: () => '',
    // Every heading answers to an anchor, so a link to `#section` from the text or from another page finds it.
    heading(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token: Tokens.Heading): string {
      const shown = inlineOf.call(this, token.tokens);
      const anchor = anchorOf(token.text);
      return `<h${String(token.depth)} id="${anchor}">${shown}</h${String(token.depth)}>\n`;
    },
    // A link out of the product opens a new tab: the reader keeps the page they were reading.
    link(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token: Tokens.Link): string {
      const shown = inlineOf.call(this, token.tokens);
      const title = token.title === null ? '' : ` title="${token.title}"`;
      const outside = token.href.startsWith('http://') || token.href.startsWith('https://');
      const target = outside ? ' target="_blank" rel="noreferrer"' : '';
      return `<a href="${token.href}"${title}${target}>${shown}</a>`;
    },
  },
});

export function TextSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const value = at(context.data, context.section.params['path']);
  const source = typeof value === 'string' ? value : '';
  if (source.trim() === '') {
    return <Paragraph data-testid="text-empty">{localized(context.section.params['emptyText'], context.language) ?? t('knowledge.textEmpty')}</Paragraph>;
  }
  const html = marked.parse(source, { async: false });
  // The reading rules are scoped to `.reading`: the column's lead, its headings and its lists are the document's own.
  return <ReadingContent className="reading" data-testid="page-text" dangerouslySetInnerHTML={{ __html: html }} />;
}
