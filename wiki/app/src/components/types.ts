/**
 * What a page component is handed (decision 0036, section 7): the section of the template, the data the graph answered
 * under its alias, and the page's own runtime — where a press walks, how a table asks for its next page, and how the
 * reader's language and role are spelled.
 */
import type { ReactNode } from 'react';
import type { ComposedSection } from '../../../../src/page-contract/index.js';

export interface SectionContext {
  readonly section: ComposedSection;
  readonly data: unknown;
  readonly language: string;
  readonly base: string;
  readonly busy: boolean;
  readonly open: (path: string) => void;
  /** The same page, asked again with the variables the press named (a table's page, a filter, a sort). */
  readonly reload: (variables: Record<string, unknown>) => void;
  /** One section of this page drawn by its own component: what a `tabs` section shows inside its tab. */
  readonly renderSection: (id: string) => ReactNode;
}
