/** The graph's Markdown, drawn as prose (decision 0036, section 7). */
import type { ReactElement } from 'react';
import { marked } from 'marked';
import { Prose } from './ui/typography.js';
import { at } from './format.js';
import type { SectionContext } from './types.js';

marked.use({
  gfm: true,
  breaks: false,
  // The product's own text is Markdown: a raw HTML block in it would be markup the page did not promise to draw.
  renderer: { html: () => '' },
});

export function TextSection({ context }: { readonly context: SectionContext }): ReactElement {
  const value = at(context.data, context.section.params['path']);
  const source = typeof value === 'string' ? value : '';
  const html = marked.parse(source, { async: false });
  return <Prose html={html} />;
}
