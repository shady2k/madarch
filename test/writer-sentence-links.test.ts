/** The sentence-question-links contract (madarch-m38l.22), without disk or an agent. */
import { describe, expect, test } from 'bun:test';
import { checkPage, type GroundResolver, type PageExpectation } from '../src/writer/format.js';
import { maskInline, sentencesOf, statementsOf, unmask } from '../src/writer/sentences.js';

const expected: PageExpectation = {
  id: 'domain:orders', kind: 'domain', domains: ['orders'], mustLinkDomains: false,
  language: 'ru', questions: ['question:delivery'],
  file: 'pages/domain/orders.md', fullPath: '/example/product/pages/domain/orders.md',
};
const resolver: GroundResolver = {
  graphKey: async (key) => key === 'code.symbol:src/a.ts#deliver' || key === 'code.symbol:src/b.ts#deliver',
  docSection: async () => false, sourceName: async () => false,
};
const header = '---\nid: domain:orders\nkind: domain\ntitle: Orders\nrelates: []\nproducer: agent\nsources: []\n---\n\n';
const grounds = '\n\n[^policy]: [First source](madarch:code.symbol:src/a.ts#deliver), [Second source](madarch:code.symbol:src/b.ts#deliver)';
const question = '[→ вопрос: Какой срок доставки верен?](madarch:question:delivery)';
const fact = 'Источники задают разные сроки доставки.[^policy]';
async function verdict(body: string, override: Partial<PageExpectation> = {}) {
  return checkPage(header + body, { ...expected, ...override }, resolver);
}
async function rules(body: string, override: Partial<PageExpectation> = {}) {
  const checked = await verdict(body, override);
  return checked.ok ? [] : checked.refusals.map((refusal) => refusal.rule);
}

describe('reader-facing entity references', () => {
  for (const raw of ['question:delivery', '`question:delivery`', 'domain:orders', '`code.symbol:src/a.ts#deliver`', 'madarch:question:delivery']) {
    test(`refuses a raw entity id ${raw} with a useful location and repair`, async () => {
      const checked = await verdict(`${fact}\n\nСсылка: ${raw}.${grounds}`);
      expect(checked.ok).toBe(false);
      if (checked.ok) return;
      const refusal = checked.refusals.find((entry) => entry.rule === 'raw-entity-id');
      expect(refusal).toBeDefined();
      expect(refusal?.line).toBe(12);
      expect(refusal?.message).toContain('pages/domain/orders.md');
      expect(refusal?.message).toContain('/example/product/pages/domain/orders.md');
      expect(refusal?.message).toContain('question');
      expect(refusal?.message).toContain('sentence');
    });
  }
  for (const heading of ['См. вопрос', 'See question', 'См. вопрос question:delivery', '[Доставка](madarch:domain:orders)', question]) {
    test(`refuses a reference-only heading: ${heading}`, async () => {
      expect(await rules(`## ${heading}\n\n${fact}${grounds}`)).toContain('reference-heading');
    });
  }
  test('a services navigation label adds no statement but cannot hide an assertion', async () => {
    expect(await rules(`${fact}\n\nSee also the services: [Delivery](madarch:domain:orders).${grounds}`)).toEqual([]);
    expect(await rules(`${fact}\n\nSee also the services: [Delivery](madarch:domain:orders) are free.${grounds}`)).toContain('ungrounded-statement');
  });
  test('keeps a normal descriptive heading and valid navigation links', async () => {
    expect(await rules(`## Сроки доставки\n\n${fact}\n\nСм. также [Доставка](madarch:domain:orders).${grounds}`)).toEqual([]);
  });
});

describe('localized sentence-end question links', () => {
  test('an open question follows one grounded sentence, stays a link, and never adds a statement', async () => {
    const checked = await verdict(`${fact} ${question}${grounds}`);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.page.links).toContain('question:delivery');
    expect(checked.page.grounds).toEqual(['code.symbol:src/a.ts#deliver', 'code.symbol:src/b.ts#deliver']);
    const statements = statementsOf(checked.page.markdown.slice(checked.page.markdown.indexOf('\n---\n') + 5), 10);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toBe('Источники задают разные сроки доставки.');
    expect(statements[0]?.grounds).toEqual(['code.symbol:src/a.ts#deliver', 'code.symbol:src/b.ts#deliver']);
    expect(checked.page.markdown).toContain(question);
    const again = await checkPage(checked.page.markdown, expected, resolver);
    expect(again.ok && again.page.markdown).toBe(checked.page.markdown);
  });
  test('the shared splitter attaches a question suffix and keeps the next fact separate', () => {
    const text = `${fact} ${question} Второй факт подтвержден.[^second]`;
    const sentences = sentencesOf(maskInline(text));
    expect(sentences.map((sentence) => unmask(sentence.text))).toEqual([`${fact} ${question}`, 'Второй факт подтвержден.[^second]']);
    const indexed = statementsOf(`${text}${grounds}\n[^second]: [Source](madarch:code.symbol:src/a.ts#deliver)`, 1);
    expect(indexed.map((statement) => statement.text)).toEqual(['Источники задают разные сроки доставки.', 'Второй факт подтвержден.']);
  });
  test('English uses the English label and leaves source grounds intact', async () => {
    const link = '[→ question: Which delivery time applies?](madarch:question:delivery)';
    expect(await rules(`The sources give different delivery times.[^policy] ${link}${grounds}`, { language: 'en' })).toEqual([]);
    expect(await rules(`${fact} ${link}${grounds}`)).toContain('question-link-language');
  });
  test('a question cannot replace a ground or be put in the middle of a claim', async () => {
    expect(await rules(`Источники задают разные сроки доставки. ${question}`)).toContain('ungrounded-statement');
    expect(await rules(`Источники ${question} задают разные сроки доставки.[^policy]${grounds}`)).toContain('question-link-position');
    expect(await rules(`${fact}\n\n${question}${grounds}`)).toContain('question-link-position');
    expect(await rules(`Источники задают разные сроки доставки.[^policy]\n\n[^policy]: ${question}`)).toContain('ground-shape');
  });
  test('a raw question label is not a human-readable localized reference', async () => {
    expect(await rules(`${fact} [question:delivery](madarch:question:delivery)${grounds}`)).toContain('question-link-label');
    expect(await rules(`${fact} [→ вопрос: delivery](madarch:question:missing)${grounds}`)).toContain('link-outside-graph');
  });
});

describe('abbreviations and navigation are not phantom claims', () => {
  for (const sentence of ['См. Доставку для подробностей.[^policy]', 'Срок задан явно, т. е. без задержки.[^policy]', 'Routes, e.g. delivery, are documented.[^policy]']) {
    test(`keeps abbreviation periods within one sentence: ${sentence}`, async () => {
      expect(sentencesOf(maskInline(sentence)).map((entry) => unmask(entry.text))).toEqual([sentence]);
      expect(await rules(`${sentence}${grounds}`)).toEqual([]);
    });
  }
  test('navigation-only См. также needs no ground but its targets must resolve', async () => {
    expect(await rules(`${fact}\n\nСм. также [Доставка](madarch:domain:orders).${grounds}`)).toEqual([]);
    expect(await rules(`${fact}\n\nСм. также [Неизвестное](madarch:domain:missing).${grounds}`)).toContain('link-outside-graph');
  });
  for (const assertion of ['См. также доставка бесплатна.', 'См. также [Доставка](madarch:domain:orders) бесплатна.', 'See also delivery is free.', 'See also [Delivery is free](madarch:domain:orders).']) {
    test(`does not exempt a factual assertion: ${assertion}`, async () => {
      expect(await rules(`${fact}\n\n${assertion}${grounds}`)).toContain('ungrounded-statement');
    });
  }
});
