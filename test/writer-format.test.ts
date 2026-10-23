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

  const FACTORY = 'code.symbol\u003aservices/payments/src/providers/factory.ts#PaymentClientFactory';

  test('is written in one canonical form: one named footnote per statement listed last, front matter in the format\'s key order', async () => {
    const first = await checkPage(good(body), expectation, resolver);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const lines = first.page.markdown.split('\n');
    expect(lines.slice(0, 10)).toEqual(['---', 'id: domain:payments', 'kind: domain', 'title: "Payment"', 'relates:', '  - "code.service:payments"', 'producer: agent', 'sources:', '  - "UC-2"', '  - "docs/vision.md"']);
    // a numbered footnote becomes the readable name of its statement; a footnote two sentences shared becomes one per sentence
    expect(lines.filter((l) => l.startsWith('[^'))).toEqual([
      `[^payments-charged-through-two]: [PaymentClientFactory](madarch:${FACTORY}), [UC-2](madarch:doc:docs/requirements.md#uc-2)`,
      '[^refund-checked-before-made]: [BR-4](madarch:doc:docs/requirements.md#br-4)',
      `[^payments-service-takes-charge]: [PaymentClientFactory](madarch:${FACTORY}), [UC-2](madarch:doc:docs/requirements.md#uc-2)`,
    ]);
    expect(first.page.markdown).toContain('configuration.[^payments-charged-through-two]\nA refund is checked before it is made.[^refund-checked-before-made]');
    expect(first.page.markdown).toContain('takes the charge.[^payments-service-takes-charge]');
    // Checking the canonical form again changes nothing.
    const again = await checkPage(first.page.markdown, expectation, resolver);
    expect(again.ok && again.page.markdown === first.page.markdown).toBe(true);
  });

  test('a name the agent chose is kept, and the page is the same whatever number a footnote had', async () => {
    const named = good(body.replace(/\[\^1\]/g, '[^b]').replace(/\[\^2\]/g, '[^a]'));
    const verdict = await checkPage(named, expectation, resolver);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    // [^b] was shared by two sentences: the first keeps it, the second is made unique by a slug
    expect(verdict.page.markdown).toContain('configuration.[^b]');
    expect(verdict.page.markdown).toContain('before it is made.[^a]');
    expect(verdict.page.markdown).toContain('takes the charge.[^payments-service-takes-charge]');
  });

  test('a sentence that stands keeps the name it had in the page it replaces; a sentence that changed gets a new one', async () => {
    const named = body.replace('takes the charge.[^1]', 'takes the charge.[^charge-step]').replace('[^2]: [BR-4]', `[^charge-step]: [PaymentClientFactory](madarch:${FACTORY})\n[^2]: [BR-4]`);
    const first = await checkPage(good(named), expectation, resolver);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.page.markdown).toContain('takes the charge.[^charge-step]');
    // the agent writes the page again with every footnote numbered and one sentence reworded
    const names = [...first.page.markdown.matchAll(/^\[\^([^\]]+)\]:/gm)].map((m) => m[1]!);
    let renumbered = first.page.markdown.replace('A refund is checked before it is made.', 'A refund is checked twice before it is made.');
    names.forEach((name, index) => { renumbered = renumbered.replaceAll(`[^${name}]`, `[^${index + 1}]`); });
    const without = await checkPage(renumbered, expectation, resolver);
    const withPrevious = await checkPage(renumbered, { ...expectation, previous: first.page.markdown }, resolver);
    expect(without.ok && withPrevious.ok).toBe(true);
    if (!without.ok || !withPrevious.ok) return;
    expect(without.page.markdown).toContain('takes the charge.[^payments-service-takes-charge]');
    expect(withPrevious.page.markdown).toContain('configuration.[^payments-charged-through-two]');
    expect(withPrevious.page.markdown).toContain('takes the charge.[^charge-step]');
    expect(withPrevious.page.markdown).toContain('it is made.[^refund-checked-twice-before]');
    expect(withPrevious.page.markdown).not.toContain('refund-checked-before-made');
  });

  test('a page that was written with numbered footnotes is renamed when it is written again', async () => {
    // the replaced page still has numbers: they are no names, so the new page gets readable ones
    const oldNumbered = `${front()}\n\nPayments are charged through one of two providers chosen by configuration.[^7]\n\n[^7]: [UC-2](madarch:doc:docs/requirements.md#uc-2)\n`;
    const again = await checkPage(good('Payments are charged through one of two providers chosen by configuration.[^1]\n\n[^1]: [UC-2](madarch:doc:docs/requirements.md#uc-2)'), { ...expectation, previous: oldNumbered }, resolver);
    expect(again.ok && again.page.markdown.includes('configuration.[^payments-charged-through-two]')).toBe(true);
  });

  test('the repositories a page was written from are recorded in its front matter, and what an agent writes there is replaced', async () => {
    const writtenAt = [{ repository: 'training', commit: '0123456789abcdef0123456789abcdef01234567', branch: 'main', origin: 'git@github.com:acme/shop.git' }];
    const withOwn = good(body).replace('sources: [docs/vision.md, UC-2]', 'sources: [docs/vision.md, UC-2]\nwritten-at: [{ repository: x, commit: abc1234 }]');
    const verdict = await checkPage(withOwn, { ...expectation, writtenAt }, resolver);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.page.markdown).toContain('written-at:\n  - repository: "training"\n    commit: 0123456789abcdef0123456789abcdef01234567\n    branch: "main"\n    origin: "git@github.com:acme/shop.git"\n---');
    expect(verdict.page.markdown).not.toContain('abc1234');
    expect(verdict.page.frontMatter.writtenAt).toEqual(writtenAt);
    const none = await checkPage(good(body), expectation, resolver);
    expect(none.ok && !none.page.markdown.includes('written-at')).toBe(true);
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

  test('a statement does not hide behind a See also line: only a few words beside links are connecting text', async () => {
    expect(await refusedRules(good(`See also payments are free of charge for every shopper.${foot}`))).toContain('ungrounded-statement');
    expect(await refusedRules(good(`See also the [payments service](madarch:code.service:payments) and the [orders service](madarch:code.service:orders).\n\nPayments run.[^1]${foot}`))).toEqual([]);
  });

  test('a statement does not hide in a link label, behind See also in a longer paragraph, or in a long heading', async () => {
    expect(await refusedRules(good('- [Cards are stored in plaintext by the payments service](madarch:code.service:payments)\n\nPayments run in one service.[^1]' + foot))).toEqual(['ungrounded-statement']);
    expect(await refusedRules(good(`See also the orders page. Card numbers are logged to stdout.\n\nPayments run in one service.[^1]${foot}`))).toContain('ungrounded-statement');
    expect(await refusedRules(good(`## The payments service stores every card number unencrypted in the database\n\nPayments run in one service.[^1]${foot}`))).toEqual(['heading-statement']);
    expect(await refusedRules(good(`## Payments[^9]\n\nPayments run in one service.[^1]${foot}`))).toEqual(['heading-footnote']);
  });

  test('a sentence cannot be glued to the next grounded one by a closing quote, an ellipsis or an abbreviation', async () => {
    for (const glued of ['The service said "cards are kept forever." Payments use one provider.[^1]', 'We keep cards, tokens, etc. Payments use one provider.[^1]', 'Cards are kept\u2026 Payments use one provider.[^1]']) {
      expect(await refusedRules(good(`${glued}${foot}`))).toEqual(['ungrounded-statement']);
    }
  });

  test('only madarch links are links: an outside address or an image is refused', async () => {
    expect(await refusedRules(good(`Payments are described [elsewhere](https://example.test/p).[^1]${foot}`))).toEqual(['link-scheme']);
    expect(await refusedRules(good(`Payments run in one service.[^1] ![x](https://example.test/p.png)${foot}`))).toContain('link-scheme');
  });

  test('a domain page may link its product page', async () => {
    const withProduct: PageExpectation = { ...expectation, productId: 'product:shop' };
    expect(await refusedRules(good(`The domain belongs to [the shop](madarch:product:shop).[^1]${foot}`), withProduct)).toEqual([]);
    expect(await refusedRules(good(`The domain belongs to [the shop](madarch:product:shop).[^1]${foot}`))).toEqual(['link-outside-graph']);
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
