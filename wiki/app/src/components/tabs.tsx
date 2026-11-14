/** A page's sections under their own tabs (decision 0036, section 7): the page draws the named section of the chosen tab. */
import { useState, type ReactElement } from 'react';
import type { ComposedSection } from '../../../../src/page-contract/index.js';
import { titleIn } from '../../../../src/page-contract/index.js';
import { Tabs } from './ui/controls.js';
import { Panel, Stack } from './ui/layout.js';
import type { SectionContext } from './types.js';

export function TabsSection({ context, sections }: { readonly context: SectionContext; readonly sections: readonly ComposedSection[] }): ReactElement {
  const ids = Array.isArray(context.section.params['sections']) ? (context.section.params['sections'] as string[]).filter((one) => typeof one === 'string') : [];
  const held = ids.map((id) => sections.find((one) => one.id === id)).filter((one): one is ComposedSection => one !== undefined);
  const [active, setActive] = useState(held[0]?.id ?? '');
  const tabs = held.map((section) => ({ id: section.id, label: titleIn(section.title, context.language) ?? section.id }));
  return (
    <Stack gap={3}>
      <Tabs tabs={tabs} active={active} onSelect={setActive} />
      {held.map((section) => (section.id === active ? <Panel key={section.id} role="tabpanel">{context.renderSection(section.id)}</Panel> : null))}
    </Stack>
  );
}
