/** The graph's Markdown, drawn in the reading column (decision 0036, section 7). */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ReadingContent } from './ui/reading-content.js';
import { renderMarkdown } from './markdown.js';
import { Paragraph } from './ui/typography.js';
import { at, localized } from './format.js';
import type { SectionContext } from './types.js';

export function TextSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const value = at(context.data, context.section.params['path']);
  const source = typeof value === 'string' ? value : '';
  if (source.trim() === '') {
    return <Paragraph data-testid="text-empty">{localized(context.section.params['emptyText'], context.language) ?? t('knowledge.textEmpty')}</Paragraph>;
  }
  // One sanitizing path for every Markdown the app draws (markdown.ts): raw HTML dropped, links held to http(s), mailto
  // and relative addresses.
  const html = renderMarkdown(source);
  // The reading rules are scoped to `.reading`: the column's lead, its headings and its lists are the document's own.
  return <ReadingContent className="reading" data-testid="page-text" dangerouslySetInnerHTML={{ __html: html }} />;
}
