/**
 * One page drawn from its composition (decision 0036, sections 6 and 7): every section in the order the template put it,
 * each by the component it names, and a `tabs` section holding the sections it groups.
 */
import type { ReactElement } from 'react';
import { titleIn, type ComposedSection, type PageComposition } from '../../../src/page-contract/index.js';
import { PageArticle, PageSection, SectionTitle } from './components/ui/typography.js';
import { HeaderSection } from './components/header.js';
import { at } from './components/format.js';
import { edgesOf } from './components/connection.js';
import { FactsSection } from './components/facts.js';
import { TextSection } from './components/text.js';
import { RelationsSection } from './components/relations.js';
import { MentionsSection } from './components/mentions.js';
import { MentionsInSection } from './components/mentions-in.js';
import { TableSection } from './components/table.js';
import { BarsSection } from './components/bars.js';
import { DiagramSection } from './components/diagram.js';
import { SourceSection } from './components/source.js';
import { TabsSection } from './components/tabs.js';
import { SearchSection } from './components/search.js';
import { RunSection } from './components/run.js';
import { KindsSection } from './components/kinds.js';
import { CatalogueSection } from './components/catalogue.js';
import { PrepareSection } from './components/prepare.js';
import { RunsSection } from './components/runs.js';
import { FillKindSection } from './components/fill-kind.js';
import { FirstRunSection } from './components/first-run.js';
import { ProblemsSection } from './components/problems.js';
import { SourcesSection } from './components/sources.js';
import { ProductOverviewSection } from './components/overview.js';
import { RepositoriesSection } from './components/repositories.js';
import { SettingsSection } from './components/settings.js';
import type { SectionContext } from './components/types.js';
import type { Navigation } from './client.js';

export interface PageRuntime {
  readonly base: string;
  readonly language: string;
  readonly busy: boolean;
  /** The page's variables as the composition bound them (a `run` component reads its run from one). */
  readonly variables: Readonly<Record<string, unknown>>;
  readonly open: (path: string) => void;
  readonly reload: (variables: Record<string, unknown>) => void;
  /** The frame's own reading: the product's name and the kinds the sidebar lists. */
  readonly product: string | null;
  readonly navigation: Navigation | null;
  /** Applies a role the reader chose on this page and keeps it for the frame. */
  readonly onRole?: (role: string) => void;
  /** The frame page or template page the address names, when it names one; an entity's page trails its kind. */
  readonly pageName: string | null;
  /** Kinds a unit publication just changed: a page that shows them may highlight them. */
  readonly changedKinds?: ReadonlySet<string>;
}

/** The whole page: its sections in order, the ones a tab groups left to the tab. */
export function PageView({ composition, data, runtime }: { readonly composition: PageComposition; readonly data: Record<string, unknown>; readonly runtime: PageRuntime }): ReactElement {
  const tabbed = new Set<string>();
  for (const section of composition.sections) {
    if (section.component !== 'tabs') continue;
    const groups = Array.isArray(section.params['groups']) ? (section.params['groups'] as { sections?: unknown }[]) : [];
    const ids = [...(Array.isArray(section.params['sections']) ? section.params['sections'] : []), ...groups.flatMap((group) => (Array.isArray(group.sections) ? group.sections : []))];
    for (const id of ids) if (typeof id === 'string') tabbed.add(id);
  }
  // A section the data leaves empty is not drawn at all: an entity with no relations shows no empty relation box, and
  // no heading over nothing (madarch-64o5.83).
  const drawsNothing = (section: ComposedSection): boolean => {
    if (section.component === 'relations') return edgesOf(at(data[section.id], section.params['path'])).length === 0;
    // 0039 items 5 and 29: a page whose text leaves no name unlinked draws no mention section.
    if (section.component === 'mentions') {
      const path = typeof section.params['path'] === 'string' ? String(section.params['path']) : 'unlinkedMentions';
      const names = at(data[section.id], path);
      return !Array.isArray(names) || names.length === 0;
    }
    if (section.component === 'mentions-in') {
      const pages = at(data[section.id], 'mentionedIn');
      return !Array.isArray(pages) || pages.length === 0;
    }
    return false;
  };
  const render = (section: ComposedSection): ReactElement | null => {
    if (drawsNothing(section)) return null;
    const context: SectionContext = {
      section,
      data: data[section.id],
      language: runtime.language,
      base: runtime.base,
      busy: runtime.busy,
      variables: runtime.variables,
      open: runtime.open,
      reload: runtime.reload,
      renderSection: (id) => {
        const held = composition.sections.find((one) => one.id === id);
        return held === undefined ? null : render(held);
      },
      product: runtime.product,
      navigation: runtime.navigation,
      ...(runtime.onRole === undefined ? {} : { onRole: runtime.onRole }),
      pageName: runtime.pageName,
      ...(runtime.changedKinds === undefined ? {} : { changedKinds: runtime.changedKinds }),
    };
    // A header draws the page's own title, so it carries no section title above it.
    const title = section.component === 'header' ? undefined : titleIn(section.title, runtime.language);
    return (
      <PageSection key={section.id} data-section={section.id}>
        {title === undefined || title === '' ? null : <SectionTitle>{title}</SectionTitle>}
        {componentOf(section, context, composition.sections)}
      </PageSection>
    );
  };
  return <PageArticle data-testid="page">{composition.sections.filter((section) => !tabbed.has(section.id)).map(render)}</PageArticle>;
}

function componentOf(section: ComposedSection, context: SectionContext, sections: readonly ComposedSection[]): ReactElement {
  switch (section.component) {
    case 'header': return <HeaderSection context={context} />;
    case 'facts': return <FactsSection context={context} />;
    case 'text': return <TextSection context={context} />;
    case 'relations': return <RelationsSection context={context} />;
    case 'mentions': return <MentionsSection context={context} />;
    case 'mentions-in': return <MentionsInSection context={context} />;
    case 'table': return <TableSection context={context} />;
    case 'bars': return <BarsSection context={context} />;
    case 'diagram': return <DiagramSection context={context} />;
    case 'source': return <SourceSection context={context} />;
    case 'tabs': return <TabsSection context={context} sections={sections} />;
    case 'search': return <SearchSection context={context} />;
    case 'kinds': return <KindsSection context={context} />;
    case 'catalogue': return <CatalogueSection context={context} />;
    case 'prepare': return <PrepareSection context={context} />;
    case 'runs': return <RunsSection context={context} />;
    case 'first-run': return <FirstRunSection context={context} />;
    case 'fill-kind': return <FillKindSection context={context} />;
    case 'run': return <RunSection context={context} />;
    case 'problem-actions': return <ProblemsSection context={context} />;
    case 'settings-form': return <SettingsSection context={context} />;
    case 'sources': return <SourcesSection context={context} />;
    case 'product-overview': return <ProductOverviewSection context={context} />;
    case 'repositories': return <RepositoriesSection context={context} />;
  }
}
