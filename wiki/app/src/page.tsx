/**
 * One page drawn from its composition (decision 0036, sections 6 and 7): every section in the order the template put it,
 * each by the component it names, and a `tabs` section holding the sections it groups.
 */
import type { ReactElement } from 'react';
import { titleIn, type ComposedSection, type PageComposition } from '../../../src/page-contract/index.js';
import { Section, Stack } from './components/ui/layout.js';
import { HeaderSection } from './components/header.js';
import { FactsSection } from './components/facts.js';
import { TextSection } from './components/text.js';
import { RelationsSection } from './components/relations.js';
import { TableSection } from './components/table.js';
import { BarsSection } from './components/bars.js';
import { DiagramSection } from './components/diagram.js';
import { SourceSection } from './components/source.js';
import { TabsSection } from './components/tabs.js';
import { SearchSection } from './components/search.js';
import type { SectionContext } from './components/types.js';

export interface PageRuntime {
  readonly base: string;
  readonly language: string;
  readonly busy: boolean;
  readonly open: (path: string) => void;
  readonly reload: (variables: Record<string, unknown>) => void;
}

/** The whole page: its sections in order, the ones a tab groups left to the tab. */
export function PageView({ composition, data, runtime }: { readonly composition: PageComposition; readonly data: Record<string, unknown>; readonly runtime: PageRuntime }): ReactElement {
  const tabbed = new Set<string>();
  for (const section of composition.sections) {
    if (section.component !== 'tabs') continue;
    const ids = Array.isArray(section.params['sections']) ? section.params['sections'] : [];
    for (const id of ids) if (typeof id === 'string') tabbed.add(id);
  }
  const render = (section: ComposedSection): ReactElement => {
    const context: SectionContext = {
      section,
      data: data[section.id],
      language: runtime.language,
      base: runtime.base,
      busy: runtime.busy,
      open: runtime.open,
      reload: runtime.reload,
      renderSection: (id) => {
        const held = composition.sections.find((one) => one.id === id);
        return held === undefined ? null : render(held);
      },
    };
    return <Section key={section.id} title={titleIn(section.title, runtime.language)}>{componentOf(section, context, composition.sections)}</Section>;
  };
  return <Stack gap={4}>{composition.sections.filter((section) => !tabbed.has(section.id)).map(render)}</Stack>;
}

function componentOf(section: ComposedSection, context: SectionContext, sections: readonly ComposedSection[]): ReactElement {
  switch (section.component) {
    case 'header': return <HeaderSection context={context} />;
    case 'facts': return <FactsSection context={context} />;
    case 'text': return <TextSection context={context} />;
    case 'relations': return <RelationsSection context={context} />;
    case 'table': return <TableSection context={context} />;
    case 'bars': return <BarsSection context={context} />;
    case 'diagram': return <DiagramSection context={context} />;
    case 'source': return <SourceSection context={context} />;
    case 'tabs': return <TabsSection context={context} sections={sections} />;
    case 'search': return <SearchSection context={context} />;
  }
}
