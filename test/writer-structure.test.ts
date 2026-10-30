/** The writer reads question references, raw ids and code spans from the Markdown tree (madarch-ztyq.12). */
import { describe, expect, test } from 'bun:test';
import { checkPage, type GroundResolver, type PageExpectation } from '../src/writer/format.js';

const expected: PageExpectation = {
  id: 'domain:orders', kind: 'domain', domains: ['orders'], mustLinkDomains: false,
  language: 'en', questions: ['question:delivery'],
};
const header = '---\nid: domain:orders\nkind: domain\ntitle: Orders\nrelates: []\nproducer: agent\nsources: []\n---\n\n';
const grounds = '\n\n[^policy]: [Source](madarch:code.symbol:src/a.ts#deliver)';
const fact = 'The source gives the delivery time.[^policy]';
const question = 'Which delivery time applies?';

function resolverWith(prefixes: readonly string[], route?: { method: string; path: string; key: string }): GroundResolver {
  return {
    graphKey: async (key) => key === 'code.symbol:src/a.ts#deliver' || key === route?.key,
    docSection: async () => false,
    sourceName: async () => false,
    keyPrefixes: async () => prefixes,
    uniqueRoute: async (method, path) => route !== undefined && method === route.method && path === route.path ? route.key : undefined,
  };
}

const resolver = resolverWith(['question', 'domain', 'code.symbol']);

async function rules(body: string, pageResolver: GroundResolver = resolver) {
  const checked = await checkPage(header + body, expected, pageResolver);
  return checked.ok ? [] : checked.refusals.map((refusal) => refusal.rule);
}

describe('question references are read from the link target', () => {
  test('a human-readable label needs no localized question prefix', async () => {
    expect(await rules(`${fact} [${question}](madarch:question:delivery)${grounds}`)).toEqual([]);
  });

  test('the label is not language-checked by a hardcoded prefix', async () => {
    const checked = await checkPage(header + `${fact} [Какой срок доставки?](madarch:question:delivery)${grounds}`, { ...expected, language: 'ru' }, resolver);
    expect(checked.ok ? [] : checked.refusals.map((refusal) => refusal.rule)).toEqual([]);
  });

  test('a heading that is only such a link is still a reference, not a topic', async () => {
    expect(await rules(`## [${question}](madarch:question:delivery)\n\n${fact}${grounds}`)).toContain('reference-heading');
  });

  test('plain words that look like an old reference opening are a topic heading, not a vocabulary match', async () => {
    expect(await rules(`## See question\n\n${fact}${grounds}`)).not.toContain('reference-heading');
    expect(await rules(`## См. вопрос\n\n${fact}${grounds}`)).not.toContain('reference-heading');
  });
});

describe('raw entity ids are tokens matched against graph key prefixes', () => {
  test('a token with a graph prefix is refused in prose', async () => {
    const checked = await checkPage(`${header}${fact}\n\nA raw widget:alpha id.${grounds}`, expected, resolverWith(['widget', 'question', 'code.symbol']));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    const refusal = checked.refusals.find((entry) => entry.rule === 'raw-entity-id');
    expect(refusal?.line).toBe(12);
    expect(refusal?.message).toContain('widget:alpha');
  });

  test('a raw id in a code span is found from the tree, not a line regex', async () => {
    const checked = await checkPage(`${header}${fact}\n\nA raw \`widget:alpha\` id.${grounds}`, expected, resolverWith(['widget', 'question', 'code.symbol']));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.refusals.some((entry) => entry.rule === 'raw-entity-id')).toBe(true);
  });

  test('punctuation around a token stays outside the reported id', async () => {
    const checked = await checkPage(`${header}${fact}\n\nСсылка: question:delivery.${grounds}`, expected, resolverWith(['question', 'code.symbol']));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    const refusal = checked.refusals.find((entry) => entry.rule === 'raw-entity-id');
    expect(refusal?.message).toContain('question:delivery');
    expect(refusal?.message).not.toContain('question:delivery.');
  });

  test('a link target is structure, not a raw id in prose', async () => {
    expect(await rules(`${fact}\n\n[Delivery](madarch:domain:orders).${grounds}`)).toEqual([]);
  });
});

describe('code spans are replaced from the tree', () => {
  test('an inline code span across a line break can name a route', async () => {
    const route = { method: 'POST', path: '/pay', key: 'code.route:src/a.ts#POST:/pay' };
    const pageResolver = resolverWith(['question', 'domain', 'code.symbol', 'code.route'], route);
    const checked = await checkPage(`${header}${fact}\n\nPay with \`POST\n/pay\` now.[^pay]${grounds}\n\n[^pay]: [Route](madarch:code.route:src/a.ts#POST:/pay)\n`, expected, pageResolver);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.page.markdown).toContain('[POST /pay](madarch:code.route:src/a.ts#POST:/pay)');
  });
});
