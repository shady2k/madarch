/**
 * The knowledge page format (the vertical's shared formats, section 1) and the
 * writer's check of it, on small pages with a resolver that knows a few keys.
 * Expected behaviour comes from the format's text: a footnote of grounds ends
 * every statement sentence, every ground and link must resolve, a sentence
 * without grounds is refused, and a checked page has one canonical form.
 */
import { describe, expect, test } from 'bun:test';
import { checkPage, parseTarget, type GroundResolver, type PageExpectation } from '../src/writer/format.js';
import { documentAnchors, slugOf } from '../src/writer/view.js';

const KEYS = new Set(['code.service:payments', 'code.service:orders', 'code.symbol\u003aservices/payments/src/providers/factory.ts#PaymentClientFactory']);
const SECTIONS = new Set(['docs/requirements.md#uc-2', 'docs/requirements.md#br-4', 'docs/vision.md#journeys']);
const resolver: GroundResolver = {
  graphKey: async (key) => KEYS.has(key),
  docSection: async (path, anchor) => SECTIONS.has(`${path}#${anchor}`),
  sourceName: async (name) => name === 'docs/vision.md' || name === 'UC-2',
};
const expectation: PageExpectation = { id: 'domain:payments', kind: 'domain', domains: ['payments', 'ordering'], mustLinkDomains: false };

const front = (): string => [
  '---',
  'id: domain:payments',
  'kind: domain',
  'title: Payment',
  'relates:',
  '  - code.service:payments',
  'producer: agent',
  'sources: [docs/vision.md, UC-2]',
  '---',
].join('\n');

const good = (body: string): string => `${front()}\n\n${body}\n`;

async function refusedRules(markdown: string, expected = expectation): Promise<string[]> {
  const verdict = await checkPage(markdown, expected, resolver);
  return verdict.ok ? [] : verdict.refusals.map((r) => r.rule);
}

describe('a page that follows the format', () => {
  const body = [
    '## How payments work',
    '',
    'Payments are charged through one of two providers chosen by configuration.[^1]',
    'A refund is checked before it is made.[^2]',
    '',
    '- The [payments service](madarch:code.service:payments) takes the charge.[^1]',
    '',
    'See also [orders](madarch:domain:ordering).',
    '',
    '[^1]: [PaymentClientFactory](madarch:code.symbol\u003aservices/payments/src/providers/factory.ts#PaymentClientFactory), [UC-2](madarch:doc:docs/requirements.md#uc-2)',
    '[^2]: [BR-4](madarch:doc:docs/requirements.md#br-4)',
  ].join('\n');

  test('passes, and keeps its grounds and links in order of appearance', async () => {
    const verdict = await checkPage(good(body), expectation, resolver);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.page.grounds).toEqual([
      'code.symbol\u003aservices/payments/src/providers/factory.ts#PaymentClientFactory',
      'doc:docs/requirements.md#uc-2',
      'doc:docs/requirements.md#br-4',
    ]);
    expect(verdict.page.links).toEqual(['code.service:payments', 'domain:ordering']);
    expect(verdict.page.frontMatter.relates).toEqual(['code.service:payments']);
  });

  test('is written in one canonical form: footnotes numbered by first use and listed last, front matter in the format\'s key order', async () => {
    const swapped = good(body.replace(/\[\^1\]/g, '[^b]').replace(/\[\^2\]/g, '[^a]'));
    const first = await checkPage(good(body), expectation, resolver);
    const second = await checkPage(swapped, expectation, resolver);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.page.markdown).toBe(first.page.markdown);
    const lines = first.page.markdown.split('\n');
    expect(lines.slice(0, 10)).toEqual(['---', 'id: domain:payments', 'kind: domain', 'title: "Payment"', 'relates:', '  - "code.service:payments"', 'producer: agent', 'sources:', '  - "UC-2"', '  - "docs/vision.md"']);
    expect(lines.filter((l) => l.startsWith('[^'))).toEqual([
      '[^1]: [PaymentClientFactory](madarch:code.symbol\u003aservices/payments/src/providers/factory.ts#PaymentClientFactory), [UC-2](madarch:doc:docs/requirements.md#uc-2)',
      '[^2]: [BR-4](madarch:doc:docs/requirements.md#br-4)',
    ]);
    // Checking the canonical form again changes nothing.
    const again = await checkPage(first.page.markdown, expectation, resolver);
    expect(again.ok && again.page.markdown === first.page.markdown).toBe(true);
  });

  test('does not split a sentence at e.g. or at a dot inside a key or code', async () => {
    const verdict = await checkPage(good([
      'Providers (e.g. the card network) are chosen in `config.ts` and by [the factory](madarch:code.symbol\u003aservices/payments/src/providers/factory.ts#PaymentClientFactory).[^1]',
      '',
      '[^1]: [payments](madarch:code.service:payments)',
    ].join('\n')), expectation, resolver);
    expect(verdict.ok).toBe(true);
  });
});

describe('the refusals', () => {
  const foot = '\n\n[^1]: [payments](madarch:code.service:payments)';

  test('a statement sentence with no footnote is refused, naming the line and the sentence', async () => {
    const verdict = await checkPage(good(`Payments are charged through one provider.[^1] Refunds take thirty days.${foot}`), expectation, resolver);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusals).toHaveLength(1);
    expect(verdict.refusals[0]!.rule).toBe('ungrounded-statement');
    expect(verdict.refusals[0]!.message).toContain('Refunds take thirty days.');
    expect(verdict.refusals[0]!.line).toBe(11);
  });

  test('a whole paragraph or list item with no footnote is refused; headings and See also lines are not', async () => {
    expect(await refusedRules(good(`## Payments are central to the shop\n\nSee also the orders page.\n\n- Payments are charged by configuration${foot}`))).toEqual(['ungrounded-statement', 'unused-footnote']);
    expect(await refusedRules(good(`## Payments are central to the shop\n\nSee also the orders page.\n\n- Charges happen at checkout.[^1]${foot}`))).toEqual([]);
  });

  test('a footnote placed in the middle of a sentence does not ground its end', async () => {
    expect(await refusedRules(good(`Payments[^1] are charged at checkout${foot}`))).toContain('ungrounded-statement');
  });

  test('a ground that is not a key of the graph is refused', async () => {
    const rules = await refusedRules(good('Payments are charged by a provider.[^1]\n\n[^1]: [nothing](madarch:code.symbol\u003aservices/payments/src/nope.ts#Nothing)'));
    expect(rules).toEqual(['unresolved-ground']);
  });

  test('a ground that names a missing document section is refused, and so is a missing document', async () => {
    expect(await refusedRules(good('Payments are charged by a provider.[^1]\n\n[^1]: [UC-9](madarch:doc:docs/requirements.md#uc-9)'))).toEqual(['unresolved-ground']);
    expect(await refusedRules(good('Payments are charged by a provider.[^1]\n\n[^1]: [UC-2](madarch:doc:docs/missing.md#uc-2)'))).toEqual(['unresolved-ground']);
  });

  test('a footnote with no ground, with prose in it, or with a link that has no madarch: scheme is refused', async () => {
    expect(await refusedRules(good('Payments are charged by a provider.[^1]\n\n[^1]:'))).toEqual(['ungrounded-footnote']);
    expect(await refusedRules(good('Payments are charged by a provider.[^1]\n\n[^1]: see the code [payments](madarch:code.service:payments)'))).toEqual(['footnote']);
    expect(await refusedRules(good('Payments are charged by a provider.[^1]\n\n[^1]: [site](https://example.test/payments)'))).toEqual(['ground-scheme']);
  });

  test('a page link is not a ground', async () => {
    expect(await refusedRules(good('Payments are charged by a provider.[^1]\n\n[^1]: [payments](madarch:domain:payments)'))).toEqual(['ground-shape']);
  });

  test('a link in the text to a key outside the graph is refused', async () => {
    expect(await refusedRules(good(`The [missing service](madarch:code.service:missing) takes the charge.[^1]${foot}`))).toEqual(['link-outside-graph']);
  });

  test('a link to a domain nobody declared, and a link with another scheme, are refused', async () => {
    expect(await refusedRules(good(`The [shipping](madarch:domain:shipping) side is separate.[^1]${foot}`))).toEqual(['link-outside-graph']);
    expect(await refusedRules(good(`The [payments](services/payments/README.md) side is separate.[^1]${foot}`))).toEqual(['link-scheme']);
  });

  test('a footnote reference that is never defined, and a definition that is never used, are refused', async () => {
    expect(await refusedRules(good('Payments are charged by a provider.[^1]'))).toEqual(['undefined-footnote']);
    expect(await refusedRules(good(`Payments are charged by a provider.[^1]${foot}\n[^2]: [orders](madarch:code.service:orders)`))).toEqual(['unused-footnote']);
  });

  test('tables, fenced blocks and HTML are not part of the format', async () => {
    expect(await refusedRules(good(`| a | b |\n|---|---|\n\nPayments are charged.[^1]${foot}`))).toContain('table');
    expect(await refusedRules(good(`\`\`\`mermaid\ngraph LR\n\`\`\`\n\nPayments are charged.[^1]${foot}`))).toContain('fenced-code');
    expect(await refusedRules(good(`<div>x</div>\n\nPayments are charged.[^1]${foot}`))).toContain('html');
  });

  test('a page with no sentence at all states nothing', async () => {
    expect(await refusedRules(good('## Only a heading'))).toEqual(['empty']);
  });

  test('every problem of a page is reported at once, in line order', async () => {
    const verdict = await checkPage(good(`Payments are charged by a provider.\n\nThe [x](madarch:code.service:missing) side is separate.[^1]${foot}`), expectation, resolver);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusals.map((r) => r.rule)).toEqual(['ungrounded-statement', 'link-outside-graph']);
    expect(verdict.refusals.map((r) => r.line)).toEqual([...verdict.refusals.map((r) => r.line)].sort((a, b) => a - b));
  });
});

describe('the front matter', () => {
  const body = 'Payments are charged by a provider.[^1]\n\n[^1]: [payments](madarch:code.service:payments)';
  const withFront = (lines: string[]): string => `---\n${lines.join('\n')}\n---\n\n${body}\n`;
  const base = ['id: domain:payments', 'kind: domain', 'title: Payment', 'relates: []', 'producer: agent', 'sources: []'];

  test('a page without front matter, or with a key outside the format, is refused', async () => {
    expect(await refusedRules(body)).toEqual(['front-matter']);
    expect(await refusedRules(withFront([...base, 'owner: me']))).toEqual(['front-matter']);
  });

  test('the id, the kind and the producer must be the page\'s own', async () => {
    expect(await refusedRules(withFront(base.map((l) => (l.startsWith('id') ? 'id: domain:ordering' : l))))).toEqual(['front-matter']);
    expect(await refusedRules(withFront(base.map((l) => (l.startsWith('kind') ? 'kind: product' : l))))).toEqual(['front-matter']);
    expect(await refusedRules(withFront(base.map((l) => (l.startsWith('producer') ? 'producer: person' : l))))).toEqual(['front-matter']);
  });

  test('a relation or a source that does not resolve is refused', async () => {
    expect(await refusedRules(withFront(base.map((l) => (l.startsWith('relates') ? 'relates: [code.service:missing]' : l))))).toEqual(['unresolved-relation']);
    expect(await refusedRules(withFront(base.map((l) => (l.startsWith('sources') ? 'sources: [docs/missing.md]' : l))))).toEqual(['unresolved-source']);
  });

  test('a product page must link every declared domain', async () => {
    const product: PageExpectation = { id: 'product:shop', kind: 'product', domains: ['payments'], mustLinkDomains: true };
    const page = (text: string): string => `---\nid: product:shop\nkind: product\ntitle: Shop\nrelates: []\nproducer: agent\nsources: []\n---\n\n${text}\n\n[^1]: [payments](madarch:code.service:payments)\n`;
    expect(await refusedRules(page('The shop sells goods online.[^1]'), product)).toEqual(['domain-not-linked']);
    expect(await refusedRules(page('The shop sells goods and has [payments](madarch:domain:payments).[^1]'), product)).toEqual([]);
  });
});

describe('targets and document anchors', () => {
  test('a madarch target is a document section, a page or a graph key', () => {
    expect(parseTarget('doc:docs/requirements.md#UC-2')).toEqual({ type: 'doc', path: 'docs/requirements.md', anchor: 'uc-2' });
    expect(parseTarget('domain:payments')).toEqual({ type: 'page', id: 'domain:payments' });
    expect(parseTarget('code.symbol\u003aservices/payments/src/a.ts#A')).toEqual({ type: 'graph', key: 'code.symbol\u003aservices/payments/src/a.ts#A' });
    expect(parseTarget('doc:docs/a.md')).toBeUndefined();
    expect(parseTarget('nothing')).toBeUndefined();
  });

  test('a document\'s anchors are its heading slugs, its bold list phrases and their identifiers', () => {
    const anchors = documentAnchors([
      '# Requirements', '', '## Use cases', '', '- **UC-1 Place order.** A shopper submits a cart.', '1. **Pay** - the shopper pays.', '',
      '## Use cases', '', '```', '# not a heading', '```', '', '# ADR-0001 Broker',
    ].join('\n'));
    expect(anchors).toEqual(['adr-0001', 'adr-0001-broker', 'pay', 'requirements', 'uc-1', 'uc-1-place-order', 'use-cases', 'use-cases-1']);
    expect(slugOf('What the **value** is?')).toBe('what-the-value-is');
  });
});
