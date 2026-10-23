/**
 * What the writer enforces in code, not only in its prompts (madarch-m38l.13), from the owner's walk of 0.2.2:
 * a subject is asked once, both sides of a contradiction stay on the page, a ground is shown by the entity's own name,
 * a link is not a ground, routes and operations are links, and a question's headings are in the wiki's language.
 * The graph here is a stub that answers the few questions the checks ask; the real graph is walked by
 * `test/writer.test.ts` and `test/loop-training.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { checkPage, type GroundResolver, type MadarchTarget, type PageExpectation } from '../src/writer/format.js';
import { fixedPart, otherQuestionsPart, productPrompt } from '../src/writer/prompts.js';
import { memorySink } from '../src/writer/run.js';
import { overlap, subjectOf, UnitTools, type UnitSpec } from '../src/writer/tools.js';
import type { GraphView } from '../src/writer/view.js';
import { parseQuestion, QUESTION_HEADINGS, renderQuestion, type Question } from '../src/loop/entities.js';

// ---- a stub of the graph -------------------------------------------------------------------

const KEYS: Record<string, string> = {
  'code.service:payments': 'payments',
  'code.service:orders': 'orders',
  'code.symbol:services/payments/pay.ts#withTimeout': 'withTimeout',
  'code.symbol:services/payments/refund.ts#refund': 'refund',
  'code.symbol:services/orders/tax.ts#taxFor': 'taxFor',
  'code.symbol:services/orders/discount.ts#discountFor': 'discountFor',
  'code.symbol:services/orders/discount.ts#roundDiscount': 'roundDiscount',
  'code.route:services/payments/routes.ts#POST:/pay': 'POST /pay',
  'code.file:services/orders/retention.ts': 'services/orders/retention.ts',
};
const SECTIONS: Record<string, string> = {
  'docs/requirements.md#uc-2': 'UC-2',
  'docs/vision.md#users': 'Users',
  'README.md#retention': 'Retention',
  'README.md#tax': 'Tax',
};

const resolver: GroundResolver = {
  graphKey: async (key) => key in KEYS,
  docSection: async (path, anchor) => `${path}#${anchor}` in SECTIONS,
  sourceName: async () => true,
  nameOf: async (target: MadarchTarget) => (target.type === 'graph' ? KEYS[target.key] : target.type === 'doc' ? SECTIONS[`${target.path}#${target.anchor}`] : undefined),
  uniqueRoute: async (method, routePath) => (method === 'POST' && routePath === '/pay' ? 'code.route:services/payments/routes.ts#POST:/pay' : undefined),
  uniqueSymbol: async (name) => Object.keys(KEYS).find((key) => key.startsWith('code.symbol:') && KEYS[key] === name),
};

const stubView = resolver as unknown as GraphView;

const expectation: PageExpectation = { id: 'domain:payments', kind: 'domain', domains: ['payments', 'ordering'], mustLinkDomains: false };
const front = ['---', 'id: domain:payments', 'kind: domain', 'title: Payments', 'relates:', '  - code.service:payments', 'producer: agent', 'sources: []', '---'].join('\n');
const page = async (body: string, resolverToUse: GroundResolver = resolver) => checkPage(`${front}\n\n${body}\n`, expectation, resolverToUse);

describe('a ground is shown by the entity\'s own name', () => {
  test('the label the agent wrote is replaced by the function\'s name and the section\'s heading', async () => {
    const verdict = await page([
      'A call to the card network waits a bounded time.[^wait]', '',
      'The first release serves shoppers.[^users] The same page cites a use case.[^uc]', '',
      '[^wait]: [Ожидание](madarch:code.symbol:services/payments/pay.ts#withTimeout)',
      '[^users]: [who buys](madarch:doc:docs/vision.md#users)',
      '[^uc]: [the second use case](madarch:doc:docs/requirements.md#uc-2)',
    ].join('\n'));
    expect(verdict.ok, verdict.ok ? '' : JSON.stringify(verdict.refusals)).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.page.markdown).toContain('[^wait]: [withTimeout](madarch:code.symbol:services/payments/pay.ts#withTimeout)');
    expect(verdict.page.markdown).toContain('[Users](madarch:doc:docs/vision.md#users)');
    expect(verdict.page.markdown).toContain('[UC-2](madarch:doc:docs/requirements.md#uc-2)');
    expect(verdict.page.markdown).not.toContain('Ожидание');
  });

  test('a graph without names leaves the agent\'s label alone', async () => {
    const verdict = await page(['Payments are taken.[^a]', '', '[^a]: [mine](madarch:code.service:payments)'].join('\n'), { ...resolver, nameOf: undefined });
    expect(verdict.ok && verdict.page.markdown.includes('[mine](madarch:code.service:payments)')).toBe(true);
  });
});

describe('a link names an entity; it is not a ground', () => {
  test('a sentence grounded only on the service it names is refused, with the rule and the line', async () => {
    const verdict = await page(['Payments are taken by the [payments service](madarch:code.service:payments).[^a]', '', '[^a]: [payments](madarch:code.service:payments)'].join('\n'));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusals.map((r) => r.rule)).toEqual(['link-is-not-a-ground']);
    expect(verdict.refusals[0]!.line).toBe(11);
    expect(verdict.refusals[0]!.message).toContain('code.service:payments');
  });

  test('the same sentence grounded on the document that says it, or on code that does it, passes', async () => {
    const verdict = await page(['Payments are taken by the [payments service](madarch:code.service:payments).[^a] It waits for the network.[^b]', '', '[^a]: [x](madarch:doc:docs/requirements.md#uc-2)', '[^b]: [x](madarch:code.symbol:services/payments/pay.ts#withTimeout), [x](madarch:code.service:payments)'].join('\n'));
    expect(verdict.ok, verdict.ok ? '' : JSON.stringify(verdict.refusals)).toBe(true);
  });
});

describe('routes and operations are written as links', () => {
  test('a code span that names the one route or the one operation becomes a link to it', async () => {
    const verdict = await page([
      'A shopper pays through `POST /pay`, which calls `refund()` only on a request to undo it.[^a]', '',
      'A span that names nothing, like `fetch /x`, or something ambiguous stays as it is.[^b]', '',
      '[^a]: [x](madarch:doc:docs/requirements.md#uc-2)', '[^b]: [x](madarch:doc:docs/vision.md#users)',
    ].join('\n'));
    expect(verdict.ok, verdict.ok ? '' : JSON.stringify(verdict.refusals)).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.page.markdown).toContain('[POST /pay](madarch:code.route:services/payments/routes.ts#POST:/pay)');
    expect(verdict.page.markdown).toContain('[refund](madarch:code.symbol:services/payments/refund.ts#refund)');
    expect(verdict.page.markdown).toContain('`fetch /x`');
    expect(verdict.page.links).toContain('code.route:services/payments/routes.ts#POST:/pay');
  });

  test('headings, footnote lines and what is already a link are left alone', async () => {
    const verdict = await page([
      '## About `POST /pay`', '',
      'See the [route `POST /pay`](madarch:code.route:services/payments/routes.ts#POST:/pay).[^a]', '',
      '[^a]: [x](madarch:doc:docs/requirements.md#uc-2)',
    ].join('\n'));
    expect(verdict.ok, verdict.ok ? '' : JSON.stringify(verdict.refusals)).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.page.markdown).toContain('## About `POST /pay`');
    expect(verdict.page.markdown).toContain('[route `POST /pay`](madarch:code.route:services/payments/routes.ts#POST:/pay)');
  });
});

// ---- the question tool -----------------------------------------------------------------------

const UNIT = (slug: string): UnitSpec => ({ kind: 'domain', id: `domain:${slug}`, path: `docs/domains/${slug}.md`, domain: { slug, title: slug, summary: 'x', evidence: ['code.service:payments'] }, productId: 'product:shop' });
const DOMAINS = [{ slug: 'payments', title: 'Payments', summary: 'x', evidence: ['code.service:payments'] }, { slug: 'ordering', title: 'Ordering', summary: 'x', evidence: ['code.service:orders'] }];

/** Tools over a shared sink, as consecutive units of one run see the product: each ask reads the questions written so far. */
function sessions(language = 'en') {
  const sink = memorySink();
  const questions = async (): Promise<Question[]> => {
    const out: Question[] = [];
    for (const file of (await sink.list!('docs/questions'))) out.push(parseQuestion(file, await sink.read(file)));
    return out;
  };
  const open = (slug: string) => new UnitTools(stubView, UNIT(slug), sink, DOMAINS, undefined, [], { language, questions });
  return { sink, open, questions };
}

const ask = (title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'contradiction', title, question: 'Which one is meant?', why: 'A shopper is told one number and charged another.',
  sides: [
    { claim: 'The README says retention is ninety days.', grounds: ['doc:README.md#retention'] },
    { claim: 'The code deletes orders after six hours.', grounds: ['code.file:services/orders/retention.ts'] },
  ],
  ...extra,
});

describe('a subject is asked once', () => {
  test('a second question on the same entities adds its page to the first instead of saving another', async () => {
    const { sink, open } = sessions();
    const orders = open('ordering');
    const first = await orders.call('ask_question', ask('How long are orders kept?'));
    expect(first.answer).toMatchObject({ asked: true, id: 'question:how-long-orders-kept' });
    const payments = open('payments');
    const again = await payments.call('ask_question', ask('What is the retention period of an order?', { question: 'Is it ninety days or six hours?' }));
    expect(again.isError).toBe(false);
    expect(again.answer).toMatchObject({ asked: false, merged: true, id: 'question:how-long-orders-kept' });
    expect([...sink.pages.keys()]).toEqual(['docs/questions/how-long-orders-kept.md']);
    const kept = parseQuestion('docs/questions/how-long-orders-kept.md', sink.pages.get('docs/questions/how-long-orders-kept.md')!);
    expect(kept.about).toContain('domain:ordering');
    expect(kept.about).toContain('domain:payments');
    expect(kept.askedIn).toBe('domain:ordering');
    expect(kept.title).toBe('How long are orders kept?');
    expect(payments.outcome()).toMatchObject({ questions: [], merged: ['question:how-long-orders-kept'] });
    expect(orders.outcome().questions).toEqual(['question:how-long-orders-kept']);
  });

  test('the question\'s about is what the agent named and its page: the sides\' grounds are compared, not copied into it', async () => {
    const { sink, open } = sessions();
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    const kept = parseQuestion('docs/questions/how-long-orders-kept.md', sink.pages.get('docs/questions/how-long-orders-kept.md')!);
    expect(kept.about).toEqual(['domain:ordering']);
  });

  test('two questions that share one document section but differ in the rest are two questions', async () => {
    const { sink, open } = sessions();
    await open('ordering').call('ask_question', ask('Which tax rate applies?', { sides: [{ claim: 'The README says eight percent.', grounds: ['doc:README.md#retention'] }, { claim: 'The code reads the rate from a table.', grounds: ['code.symbol:services/orders/tax.ts#taxFor'] }] }));
    const other = await open('ordering').call('ask_question', ask('How is the discount rounded?', { sides: [{ claim: 'The README says nothing.', grounds: ['doc:README.md#retention'] }, { claim: 'The code rounds down.', grounds: ['code.symbol:services/orders/discount.ts#roundDiscount'] }] }));
    expect(other.answer).toMatchObject({ asked: true });
    expect(sink.pages.size).toBe(2);
  });

  test('a different subject, or a different type of question, is its own question', async () => {
    const { sink, open } = sessions();
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    const other = await open('payments').call('ask_question', ask('Which tax rate applies?', { sides: [{ claim: 'The README says eight percent.', grounds: ['doc:README.md#tax'] }, { claim: 'The code reads the rate from the tax table.', grounds: ['code.symbol:services/orders/tax.ts#taxFor'] }] }));
    expect(other.answer).toMatchObject({ asked: true });
    const kind = await open('payments').call('ask_question', ask('What does retention cover?', { type: 'undocumented' }));
    expect(kind.answer).toMatchObject({ asked: true });
    expect(sink.pages.size).toBe(3);
  });

  test('an answered question is not asked again: the agent is given the answer and the id to stand on', async () => {
    const { sink, open } = sessions();
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    const path = 'docs/questions/how-long-orders-kept.md';
    const asked = parseQuestion(path, sink.pages.get(path)!);
    sink.pages.set(path, renderQuestion({ ...asked, status: 'answered', answer: { text: 'Ninety days.', by: { name: 'A', email: 'a@example.test', verified: 'local, not verified' }, at: '2026-10-23T12:00:00.000Z' } }));
    const again = await open('payments').call('ask_question', ask('Retention once more'));
    expect(again.answer).toMatchObject({ asked: false, answered: true, id: 'question:how-long-orders-kept', answer: 'Ninety days.' });
    expect(sink.pages.size).toBe(1);
    // No obligation comes of an answered question: the page may stand on the answer alone.
    const written = await open('payments').call('write_page', { markdown: `${front}\n\nOrders are deleted after six hours.[^a]\n\n[^a]: [x](madarch:doc:README.md#tax)\n` });
    expect(written.isError, JSON.stringify(written.answer)).toBe(false);
  });

  test('broad containers and page ids are not a subject: two questions about one service stay two', () => {
    expect([...subjectOf(['domain:payments', 'code.service:payments', 'code.module:a', 'product:shop'], [{ grounds: ['code.service:payments'] }])]).toEqual([]);
    expect(overlap(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBeCloseTo(2 / 3);
    expect(overlap(new Set(['a', 'x']), new Set(['a', 'y']))).toBeCloseTo(1 / 3);
    expect(overlap(new Set(), new Set(['a']))).toBe(0);
    expect([...subjectOf(['domain:payments#a-statement', 'doc:README.md#tax'], [{ grounds: ['madarch:code.symbol:a.ts#f'] }])].sort()).toEqual(['code.symbol:a.ts#f', 'doc:README.md#tax']);
  });

  test('the prompt lists the other pages\' questions with the entities they are about', () => {
    const question = { slug: 'how-long', status: 'open', type: 'contradiction', title: 'How long?', about: ['domain:ordering', 'doc:README.md#retention'], askedIn: 'domain:ordering' } as unknown as Question;
    const lines = otherQuestionsPart('domain:payments', [question]).join('\n');
    expect(lines).toContain('## Questions already asked elsewhere in this product');
    expect(lines).toContain('question:how-long (open, contradiction): How long? [about doc:README.md#retention]');
    expect(otherQuestionsPart('domain:ordering', [question])).toEqual([]);
  });
});

describe('a contradiction keeps both of its sides on the page', () => {
  const body = (grounds: string[]): string => ['Orders are deleted after six hours.[^a]', '', `[^a]: ${grounds.map((g) => `[x](madarch:${g})`).join(', ')}`].join('\n');
  const header = `${front}\n\n`;

  test('a page that states only the document\'s side is refused, naming the side that is missing and where to ground it', async () => {
    const { open } = sessions();
    const tools = open('payments');
    expect((await tools.call('ask_question', ask('How long are orders kept?'))).isError).toBe(false);
    const refused = await tools.call('write_page', { markdown: header + body(['doc:README.md#retention']) });
    expect(refused.isError).toBe(true);
    const rules = (refused.answer as { refused: { rule: string; message: string }[] }).refused;
    expect(rules.map((r) => r.rule)).toEqual(['contradiction-side-missing']);
    expect(rules[0]!.message).toContain('question:how-long-orders-kept');
    expect(rules[0]!.message).toContain('The code deletes orders after six hours.');
    expect(rules[0]!.message).toContain('code.file:services/orders/retention.ts');
    expect(rules[0]!.message).not.toContain('The README says retention');
  });

  test('a page that grounds both sides, each on its own source, is written', async () => {
    const { open, sink } = sessions();
    const tools = open('payments');
    await tools.call('ask_question', ask('How long are orders kept?'));
    const markdown = `${header}Orders are deleted after six hours.[^code]\n\nThe README promises ninety days; see the question.[^readme]\n\n[^code]: [x](madarch:code.file:services/orders/retention.ts)\n[^readme]: [x](madarch:doc:README.md#retention)\n`;
    const written = await tools.call('write_page', { markdown });
    expect(written.isError, JSON.stringify(written.answer)).toBe(false);
    expect(sink.pages.has('docs/domains/payments.md')).toBe(true);
  });

  test('a ground in the same file as a side\'s ground counts: a function and its file are one place', async () => {
    const { open } = sessions();
    const tools = open('payments');
    await tools.call('ask_question', ask('How long are orders kept?', { sides: [{ claim: 'The README says ninety days.', grounds: ['doc:README.md#retention'] }, { claim: 'The code keeps six hours.', grounds: ['code.symbol:services/orders/discount.ts#discountFor'] }] }));
    const markdown = `${header}Rounding happens here.[^a]\n\nThe README promises ninety days.[^b]\n\n[^a]: [x](madarch:code.symbol:services/orders/discount.ts#roundDiscount)\n[^b]: [x](madarch:doc:README.md#retention)\n`;
    const written = await tools.call('write_page', { markdown });
    expect(written.isError, JSON.stringify(written.answer)).toBe(false);
  });

  test('a unit that asked a gap, or nothing, is not held to it', async () => {
    const { open } = sessions();
    const tools = open('payments');
    await tools.call('ask_question', ask('Something we could not ground', { type: 'gap', sides: [{ claim: 'Nothing says.', grounds: ['doc:README.md#retention'] }] }));
    const written = await tools.call('write_page', { markdown: `${header}${body(['doc:README.md#tax'])}` });
    expect(written.isError, JSON.stringify(written.answer)).toBe(false);
  });

  test('the prompt asks for both sides, once per subject, links and the comparison of neighbouring operations', () => {
    const text = fixedPart('en');
    for (const part of ['keep BOTH sides on the page', 'is not asked again', 'A link is not a ground', 'as links to their graph entities, never as code spans', 'Compare how neighbouring operations of a domain handle failure', 'replaced by the entity\'s own name']) expect(text).toContain(part);
  });
});

describe('a question\'s headings are in the wiki\'s language', () => {
  test('a Russian wiki gets Russian headings, and the file reads back with its language', async () => {
    const { sink, open } = sessions('ru');
    await open('ordering').call('ask_question', ask('Сколько хранятся заказы?'));
    const path = [...sink.pages.keys()][0]!;
    const text = sink.pages.get(path)!;
    for (const heading of Object.values({ q: QUESTION_HEADINGS.ru.question, w: QUESTION_HEADINGS.ru.why, s: QUESTION_HEADINGS.ru.sources })) expect(text).toContain(`## ${heading}`);
    expect(text).not.toContain('## Question');
    expect(text).not.toContain('## Why it matters');
    expect(text).not.toContain('## What the sources say');
    const read = parseQuestion(path, text);
    expect(read.language).toBe('ru');
    expect(read.question).toBe('Which one is meant?');
    expect(read.sides).toHaveLength(2);
    // Answering rewrites the file in the language it is in.
    const answered = renderQuestion({ ...read, status: 'answered', answer: { text: 'Девяносто дней.', by: { name: 'A', email: 'a@example.test', verified: 'local, not verified' }, at: '2026-10-23T12:00:00.000Z' } });
    expect(answered).toContain('## Ответ');
    expect(answered).toContain('Ответил(а) A <a@example.test>');
    expect(parseQuestion(path, answered).answer?.text).toBe('Девяносто дней.');
  });

  test('an English wiki, and a file written before the headings were localized, keep the English ones', async () => {
    const { sink, open } = sessions('en');
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    const text = [...sink.pages.values()][0]!;
    expect(text).toContain('## Question');
    expect(text).toContain('## What the sources say');
    expect(parseQuestion('docs/questions/how-long-orders-kept.md', text).language).toBe('en');
  });
});

describe('the product prompt', () => {
  test('carries the questions asked elsewhere', async () => {
    const view = { at: 'abc', overview: async () => ({ kinds: [], relations: [], documents: [] }), find: async () => ({ nodes: [], next: null }) } as unknown as GraphView;
    const question = { slug: 'how-long', status: 'open', type: 'contradiction', title: 'How long?', about: ['doc:README.md#retention'], askedIn: 'domain:ordering', resolvedBy: [] } as unknown as Question;
    const prompt = await productPrompt(view, { kind: 'product', id: 'product:shop', path: 'docs/product.md', name: 'Shop' }, 'en', { questions: [question] });
    expect(prompt).toContain('## Questions already asked elsewhere in this product');
  });
});
