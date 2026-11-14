/** A page's sections under their own tabs (decision 0036, section 7): the page draws the named section of the chosen tab. */
import { useState, type ReactElement } from 'react';
import type { ComposedSection } from '../../../../src/page-contract/index.js';
import { titleIn } from '../../../../src/page-contract/index.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.js';
import type { SectionContext } from './types.js';

export function TabsSection({ context, sections }: { readonly context: SectionContext; readonly sections: readonly ComposedSection[] }): ReactElement {
  const ids = Array.isArray(context.section.params['sections']) ? (context.section.params['sections'] as string[]).filter((one) => typeof one === 'string') : [];
  const held = ids.map((id) => sections.find((one) => one.id === id)).filter((one): one is ComposedSection => one !== undefined);
  const [active, setActive] = useState(held[0]?.id ?? '');
  return (
    <Tabs value={active} onValueChange={setActive}>
      <TabsList aria-label={titleIn(context.section.title, context.language) ?? context.section.id}>
        {held.map((section) => <TabsTrigger key={section.id} value={section.id}>{titleIn(section.title, context.language) ?? section.id}</TabsTrigger>)}
      </TabsList>
      {held.map((section) => (section.id === active ? <TabsContent key={section.id} value={section.id}>{context.renderSection(section.id)}</TabsContent> : null))}
    </Tabs>
  );
}
