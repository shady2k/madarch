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
  // The tab a reader left a page on is the tab it opens with: the page's own address names the memory, and the first
  // section of a tab is what is remembered (a title changes with the language, a section id does not).
  const memory = (): string => {
    try { return window.localStorage.getItem(`madarch-wiki-tab:${window.location.pathname}${window.location.search}`) ?? ''; } catch { return ''; }
  };
  const firstIds = tabs.map((tab) => tab.ids[0] ?? '');
  const [active, setActive] = useState<string>(() => {
    const remembered = memory();
    return firstIds.includes(remembered) ? remembered : (firstIds[0] ?? '');
  });
  const held = tabs.find((tab) => (tab.ids[0] ?? '') === active) ?? tabs[0];
  const choose = (title: string): void => {
    const picked = tabs.find((tab) => tab.title === title);
    const id = picked?.ids[0] ?? '';
    setActive(id);
    try { window.localStorage.setItem(`madarch-wiki-tab:${window.location.pathname}${window.location.search}`, id); } catch { /* no storage */ }
  };
  return (
    <Tabs value={held?.title ?? ''} onValueChange={choose}>
      <TabsList aria-label={titleIn(context.section.title, context.language) ?? context.section.id}>
        {tabs.map((tab) => <TabsTrigger key={tab.title} value={tab.title}>{tab.title}</TabsTrigger>)}
      </TabsList>
      {tabs.map((tab) => (tab.title === held?.title
        ? <TabsContent key={tab.title} value={tab.title}>{tab.ids.map((id) => <div key={id}>{context.renderSection(id)}</div>)}</TabsContent>
        : null))}
    </Tabs>
  );
}
