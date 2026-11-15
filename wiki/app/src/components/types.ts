/**
 * What a page component is handed (decision 0036, section 7): the section of the template, the data the graph answered
 * under its alias, and the page's own runtime — where a press walks, how a table asks for its next page, how the
 * reader's language and role are spelled, and the product's names the frame read once.
 */
import type { ReactNode } from 'react';
import type { ComposedSection } from '../../../../src/page-contract/index.js';
import type { Navigation } from '../client.js';

export interface SectionContext {
  readonly section: ComposedSection;
  readonly data: unknown;
  readonly language: string;
  readonly base: string;
  readonly busy: boolean;
  /** The page's variables as the composition bound them: a command component reads the one its parameters name. */
  readonly variables: Readonly<Record<string, unknown>>;
  readonly open: (path: string) => void;
  /** The same page, asked again with the variables the press named (a table's page, a filter, a sort). */
  readonly reload: (variables: Record<string, unknown>) => void;
  /** One section of this page drawn by its own component: what a `tabs` section shows inside its tab. */
  readonly renderSection: (id: string) => ReactNode;
  /** The product's name and the kinds the frame's navigation read: what a page's own words come from. */
  readonly product: string | null;
  readonly navigation: Navigation | null;
  /** Applies a role the reader chose on this page and keeps it for the frame. */
  readonly onRole?: (role: string) => void;
  /** The frame page or template page the address names, when it names one; an entity's page trails its kind instead. */
  readonly pageName: string | null;
}
