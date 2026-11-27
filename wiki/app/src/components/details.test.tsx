import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { setWikiLanguage } from '../i18n.js';
import { DetailsSection } from './details.js';
import type { SectionContext } from './types.js';

test('the journal names the source and the person it represents when their identities differ', async () => {
  await setWikiLanguage('en');
  const person = { id: 'person-id', label: 'Acceptance Person' };
  const agent = { id: 'agent-id', label: 'Local MCP agent' };
  const journal = (source: typeof person) => {
    const context: SectionContext = {
      section: { id: 'details', alias: 'details', component: 'details', params: {}, on: 'subject', replace: false, line: 1 },
      data: { details: [{ name: 'title', value: 'A note', assertions: [{ selected: true, source, author: person }] }] },
      language: 'en', base: '', busy: false, variables: {}, reload: () => {}, open: () => {}, renderSection: () => null,
      navigation: { product: 'Sample', groups: [], purposes: [], kinds: [] }, product: 'Sample', pageName: null,
    };
    return renderToStaticMarkup(<DetailsSection context={context} />);
  };
  expect(journal(person)).toContain('>Stated by Acceptance Person<');
  expect(journal(agent)).toContain('>Stated by Local MCP agent for Acceptance Person<');
});
