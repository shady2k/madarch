
/**
 * The links the core writes where an agent wrote a known name (madarch-ztyq.8; decision 0032, section 8).
 * The agent writes prose; the core turns every mention of an entity the product knows into a link to its
 * page, and leaves headings, code, existing links, addresses and footnote definitions as they are.
 *
 * The names are data: a document entity's identifier and title, a glossary term's synonyms, and the graph's
 * own labels. No product name is written in the engine, and these tests supply the names as a caller does.
 */
import { describe, expect, test } from 'bun:test';
import { checkPage, insertMentionLinks, type GroundResolver, type MentionName, type PageExpectation } from '../src/writer/index.js';

const KEYS = new Set(['code.service:orders', 'code.service:postgres', 'code.channel:kafka', 'code.table:outbox']);
const SECTIONS = new Set(['docs/requirements.md#uc-1', 'docs/requirements.md#br-3', 'docs/glossary.md#outbox', 'docs/glossary.md#capture']);
const resolver: GroundResolver = {
  graphKey: async (key) => KEYS.has(key),
  docSection: async (path, anchor) => SECTIONS.has(`${path}#${anchor}`),
  sourceName: async (name) => name === 'docs/vision.md',
};

const names: MentionName[] = [
  { name: 'Postgres', target: 'code.service:postgres' },
  { name: 'Kafka', target: 'code.channel:kafka' },
  { name: 'outbox', target: 'code.table:outbox' },
  { name: 'UC-1', target: 'doc:docs/requirements.md#uc-1', caseSensitive: true },
  { name: 'BR-3', target: 'doc:docs/requirements.md#br-3', caseSensitive: true },
  { name: 'Outbox', target: 'doc:docs/glossary.md#outbox', caseSensitive: true },
  { name: 'Capture', target: 'doc:docs/glossary.md#capture', caseSensitive: true },
];

const front = (): string => [
  '---',
  'id: domain:payments',
  'kind: domain',
  'title: Payment',
  'relates: []',
  'producer: agent',
  'sources: [docs/vision.md]',
  '---',
].join('\n');

const body = [
  '## Postgres',
  '',
  'The shop keeps orders in Postgres and publishes to Kafka through the outbox.[^stack]',
  'UC-1 and BR-3 are the rules, and the Outbox and Capture terms explain them.[^rules]',
  '',
  '`Postgres` is a code span.[^code]',
  '',
  'See also [Kafka](madarch:code.channel:kafka).',
  '',
  '[^stack]: [orders](madarch:code.service:orders)',
  '[^rules]: [UC-1](madarch:doc:docs/requirements.md#uc-1)',
  '[^code]: [orders](madarch:code.service:orders)',
];
const expectation: PageExpectation = { id: 'domain:payments', kind: 'domain', domains: ['payments'], mustLinkDomains: false };

describe('a checked page links the names the product knows', () => {
  test('the body links every plain mention, and leaves headings, code, existing links and footnotes alone', async () => {
    const verdict = await checkPage(`${front()}\n\n${body.join('\n')}\n`, expectation, resolver, names);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const page = verdict.page.markdown;
    expect(page).toContain('[Postgres](madarch:code.service:postgres)');
    expect(page).toContain('[Kafka](madarch:code.channel:kafka)');
    expect(page).toContain('[outbox](madarch:code.table:outbox)');
    expect(page).toContain('[UC-1](madarch:doc:docs/requirements.md#uc-1)');
    expect(page).toContain('[BR-3](madarch:doc:docs/requirements.md#br-3)');
    expect(page).toContain('[Outbox](madarch:doc:docs/glossary.md#outbox)');
    expect(page).toContain('[Capture](madarch:doc:docs/glossary.md#capture)');
    expect(verdict.page.links).toContain('code.service:postgres');
    expect(verdict.page.links).toContain('doc:docs/glossary.md#outbox');
    // The heading and the code span keep the text the agent wrote.
    expect(page).toContain('\n## Postgres\n');
    expect(page).toContain('`Postgres` is a code span');
    // The existing link to Kafka is not nested in another; the plain mention is a second link.
    expect(page.split('[Kafka](madarch:code.channel:kafka)').length - 1).toBe(2);
    expect(page).not.toContain('[[Kafka]]');
    // The footnote definition's link and the body's inserted link are two, not a link inside a link.
    expect(page.split('[UC-1](madarch:doc:docs/requirements.md#uc-1)').length - 1).toBe(2);
    // Checking the inserted page again changes nothing.
    const again = await checkPage(page, expectation, resolver, names);
    expect(again.ok && again.page.markdown === page).toBe(true);
  });

  test('a structural scan skips front matter, headings, fences, code, links, addresses and footnote definitions', () => {
    const page = [
      '---',
      'title: Postgres',
      '---',
      '# Postgres',
      '',
      'The `Postgres` name stays code; so does https://example.com/Postgres and <!-- Postgres -->.',
      '',
      '[Postgres](madarch:code.service:postgres) is already a link.',
      '',
      '```',
      'Postgres',
      '```',
      '',
      'The postgres service is named here.[^system-postgres]',
      '',
      '[^system-postgres]: [Postgres](madarch:code.service:postgres)',
    ].join('\n');
    const inserted = insertMentionLinks(page, names);
    expect(inserted.targets).toEqual(['code.service:postgres']);
    expect(inserted.markdown).toContain('The `Postgres` name stays code');
    expect(inserted.markdown).toContain('https://example.com/Postgres');
    expect(inserted.markdown).toContain('<!-- Postgres -->');
    expect(inserted.markdown).toContain('[Postgres](madarch:code.service:postgres) is already a link.');
    expect(inserted.markdown).toContain('```\nPostgres\n```');
    expect(inserted.markdown).toContain('[^system-postgres]: [Postgres](madarch:code.service:postgres)');
    // The reference's label is a slug, not prose: a name inside it is not linked.
    expect(inserted.markdown).toContain('The [postgres](madarch:code.service:postgres) service is named here.[^system-postgres]');
    // A name is matched without case unless its caller says otherwise.
    expect(inserted.markdown).toContain('The [postgres](madarch:code.service:postgres) service is named here.');
    expect(inserted.markdown).not.toContain('[Postgres](madarch:code.service:postgres)](madarch:');
    // An exact spelling wins over the same spelling in another case: a glossary term and a table keep their own pages.
    const cased = insertMentionLinks('Postgres and postgres', [
      { name: 'Postgres', target: 'code.service:postgres', caseSensitive: true },
      { name: 'postgres', target: 'code.table:outbox', caseSensitive: true },
    ]);
    expect(cased.markdown).toBe('[Postgres](madarch:code.service:postgres) and [postgres](madarch:code.table:outbox)');
  });
});
