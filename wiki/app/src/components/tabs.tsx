/** A page's sections under their own tabs (decision 0036, section 7): the page draws the named section of the chosen tab. */
import { useState, type ReactElement } from 'react';
import type { ComposedSection } from '../../../../src/page-contract/index.js';
import { titleIn } from '../../../../src/page-contract/index.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.js';
import type { SectionContext } from './types.js';

/** One tab: its word and the sections it draws. */
interface TabGroup {
  readonly title?: unknown;
  readonly sections?: unknown;
}

export function TabsSection({ context, sections }: { readonly context: SectionContext; readonly sections: readonly ComposedSection[] }): ReactElement {
  const params = context.section.params;
  const groups: TabGroup[] = Array.isArray(params['groups'])
    ? (params['groups'] as TabGroup[])
    : (Array.isArray(params['sections']) ? (params['sections'] as unknown[]).filter((one): one is string => typeof one === 'string') : []).map((id) => ({ sections: [id] }));
  const tabs = groups.map((group) => {
    const ids = (Array.isArray(group.sections) ? group.sections : []).filter((one): one is string => typeof one === 'string');
    const first = sections.find((one) => one.id === ids[0]);
    const title = (typeof group.title === 'object' && group.title !== null ? titleIn(group.title as Record<string, string>, context.language) : undefined)
      ?? (first === undefined ? '' : titleIn(first.title, context.language))
      ?? ids[0]
      ?? '';
    return { title, ids };
  }).filter((tab) => tab.ids.length > 0);
  const [active, setActive] = useState(tabs[0]?.title ?? '');
  const held = tabs.find((tab) => tab.title === active) ?? tabs[0];
  return (
    <Tabs value={held?.title ?? ''} onValueChange={setActive}>
      <TabsList aria-label={titleIn(context.section.title, context.language) ?? context.section.id}>
        {tabs.map((tab) => <TabsTrigger key={tab.title} value={tab.title}>{tab.title}</TabsTrigger>)}
      </TabsList>
      {tabs.map((tab) => (tab.title === held?.title
        ? <TabsContent key={tab.title} value={tab.title}>{tab.ids.map((id) => <div key={id}>{context.renderSection(id)}</div>)}</TabsContent>
        : null))}
    </Tabs>
  );
}
