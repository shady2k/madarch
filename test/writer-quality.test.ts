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
import { MAX_ABOUT, parseQuestion, QUESTION_HEADINGS, renderQuestion, type Question } from '../src/loop/entities.js';

// ---- a stub of the graph -------------------------------------------------------------------

const KEYS: Record<string, string> = {
  'code.service:payments': 'payments',
  'code.service:orders': 'orders',
  'code.symbol\u003aservices/payments/pay.ts#withTimeout': 'withTimeout',
  'code.symbol\u003aservices/payments/refund.ts#refund': 'refund',
  'code.symbol\u003aservices/orders/tax.ts#taxFor': 'taxFor',
  'code.symbol\u003aservices/orders/discount.ts#discountFor': 'discountFor',
  'code.symbol\u003aservices/orders/discount.ts#roundDiscount': 'roundDiscount',
  'code.route\u003aservices/payments/routes.ts#POST:/pay': 'POST /pay',
  'code.file\u003aservices/orders/retention.ts': 'services/orders/retention.ts',
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
  uniqueRoute: async (method, routePath) => (method === 'POST' && routePath === '/pay' ? 'code.route\u003aservices/payments/routes.ts#POST:/pay' : undefined),
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
      '[^wait]: [Ожидание](madarch:code.symbol\u003aservices/payments/pay.ts#withTimeout)',
      '[^users]: [who buys](madarch:doc:docs/vision.md#users)',
      '[^uc]: [the second use case](madarch:doc:docs/requirements.md#uc-2)',
    ].join('\n'));
    expect(verdict.ok, verdict.ok ? '' : JSON.stringify(verdict.refusals)).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.page.markdown).toContain('[^wait]: [withTimeout](madarch:code.symbol\u003aservices/payments/pay.ts#withTimeout)');
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
    const verdict = await page(['Payments are taken by the [payments service](madarch:code.service:payments).[^a] It waits for the network.[^b]', '', '[^a]: [x](madarch:doc:docs/requirements.md#uc-2)', '[^b]: [x](madarch:code.symbol\u003aservices/payments/pay.ts#withTimeout), [x](madarch:code.service:payments)'].join('\n'));
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
    expect(verdict.page.markdown).toContain('[POST /pay](madarch:code.route\u003aservices/payments/routes.ts#POST:/pay)');
    expect(verdict.page.markdown).toContain('[refund](madarch:code.symbol\u003aservices/payments/refund.ts#refund)');
    expect(verdict.page.markdown).toContain('`fetch /x`');
    expect(verdict.page.links).toContain('code.route\u003aservices/payments/routes.ts#POST:/pay');
  });

  test('headings, footnote lines and what is already a link are left alone', async () => {
    const verdict = await page([
      '## About `POST /pay`', '',
      'See the [route `POST /pay`](madarch:code.route\u003aservices/payments/routes.ts#POST:/pay).[^a]', '',
      '[^a]: [x](madarch:doc:docs/requirements.md#uc-2)',
    ].join('\n'));
    expect(verdict.ok, verdict.ok ? '' : JSON.stringify(verdict.refusals)).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.page.markdown).toContain('## About `POST /pay`');
    expect(verdict.page.markdown).toContain('[route `POST /pay`](madarch:code.route\u003aservices/payments/routes.ts#POST:/pay)');
  });
});

// ---- the question tool -----------------------------------------------------------------------

const UNIT = (slug: string): UnitSpec => ({ kind: 'domain', id: `domain:${slug}`, path: `docs/domains/${slug}.md`, domain: { slug, title: slug, summary: 'x', evidence: ['code.service:payments'] }, productId: 'product:shop' });
const DOMAINS = [{ slug: 'payments', title: 'Payments', summary: 'x', evidence: ['code.service:payments'] }, { slug: 'ordering', title: 'Ordering', summary: 'x', evidence: ['code.service:orders'] }];

/** Tools over a shared sink, as consecutive units of one run see the product: each ask reads the questions written so far. */
function sessions(language = 'en', scriptedComparison = true) {
  const sink = memorySink();
  const questions = async (): Promise<Question[]> => {
    const out: Question[] = [];
    for (const file of (await sink.list!('docs/questions'))) out.push(parseQuestion(file, await sink.read(file)));
    return out;
  };
  const open = (slug: string) => {
    const tools = new UnitTools(stubView, UNIT(slug), sink, DOMAINS, undefined, [], { language, questions });
    if (!scriptedComparison) return tools;
    const call = tools.call.bind(tools);
    tools.call = async (tool, value) => {
      if (tool !== 'ask_question') return call(tool, value);
      const args = value as Record<string, unknown>;
      const result = await call(tool, args);
      const answer = result.answer as { error?: { code: string }; candidates?: Question[] };
      if (answer.error?.code !== 'question-comparison-required' || answer.candidates === undefined) return result;
      const decisions: Record<string, string> = {
        'How long are orders kept?': 'retention-duration',
        'What is the retention period of an order?': 'retention-duration',
        'Retention once more': 'retention-duration',
        'Which tax rate applies?': 'tax-rate',
        'How is the discount rounded?': 'discount-rounding',
        'What does retention cover?': 'retention-scope',
      };
      const proposed = decisions[String(args['title'])];
      if (proposed === undefined) throw new Error('the legacy fixture has no authored semantic decision for this proposal');
      return call(tool, { ...args, comparison: answer.candidates.map((candidate) => {
        const held = decisions[candidate.title];
        if (held === undefined) throw new Error('the legacy fixture has no authored semantic decision for this candidate');
        return { id: candidate.id, same: proposed === held, reason: `The authored fixture decisions are ${proposed} and ${held}.` };
      }) });
    };
    return tools;
  };
  return { sink, open, questions };
}

const ask = (title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'contradiction', title, question: 'Which one is meant?', why: 'A shopper is told one number and charged another.',
  sides: [
    { claim: 'The README says retention is ninety days.', grounds: ['doc:README.md#retention'] },
    { claim: 'The code deletes orders after six hours.', grounds: ['code.file\u003aservices/orders/retention.ts'] },
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
    await open('ordering').call('ask_question', ask('Which tax rate applies?', { sides: [{ claim: 'The README says eight percent.', grounds: ['doc:README.md#retention'] }, { claim: 'The code reads the rate from a table.', grounds: ['code.symbol\u003aservices/orders/tax.ts#taxFor'] }] }));
    const other = await open('ordering').call('ask_question', ask('How is the discount rounded?', { sides: [{ claim: 'The README says nothing.', grounds: ['doc:README.md#retention'] }, { claim: 'The code rounds down.', grounds: ['code.symbol\u003aservices/orders/discount.ts#roundDiscount'] }] }));
    expect(other.answer).toMatchObject({ asked: true });
    expect(sink.pages.size).toBe(2);
  });

  test('different decisions stay separate, including different decisions with different types', async () => {
    const { sink, open } = sessions();
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    const other = await open('payments').call('ask_question', ask('Which tax rate applies?', { sides: [{ claim: 'The README says eight percent.', grounds: ['doc:README.md#tax'] }, { claim: 'The code reads the rate from the tax table.', grounds: ['code.symbol\u003aservices/orders/tax.ts#taxFor'] }] }));
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
    const payments = open('payments');
    const again = await payments.call('ask_question', ask('Retention once more'));
    expect(again.answer).toMatchObject({ asked: false, answered: true, id: 'question:how-long-orders-kept', answer: 'Ninety days.' });
    expect(sink.pages.size).toBe(1);
    // An answered contradiction may stand on the answer alone, without repeating an obsolete uncertainty.
    const written = await payments.call('write_page', { markdown: `${front}\n\nOrders are kept for ninety days.[^a]\n\n[^a]: [answer](madarch:question:how-long-orders-kept)\n` });
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
    expect(rules[0]!.message).toContain('code.file\u003aservices/orders/retention.ts');
    expect(rules[0]!.message).not.toContain('The README says retention');
  });

  test('a page that grounds both sides, each on its own source, is written', async () => {
    const { open, sink } = sessions();
    const tools = open('payments');
    await tools.call('ask_question', ask('How long are orders kept?'));
    const markdown = `${header}Orders are deleted after six hours.[^code]\n\nThe README promises ninety days; see the question.[^readme]\n\n[^code]: [x](madarch:code.file\u003aservices/orders/retention.ts)\n[^readme]: [x](madarch:doc:README.md#retention)\n`;
    const written = await tools.call('write_page', { markdown });
    expect(written.isError, JSON.stringify(written.answer)).toBe(false);
    expect(sink.pages.has('docs/domains/payments.md')).toBe(true);
  });

  test('a ground in the same file as a side\'s ground counts: a function and its file are one place', async () => {
    const { open } = sessions();
    const tools = open('payments');
    await tools.call('ask_question', ask('How long are orders kept?', { sides: [{ claim: 'The README says ninety days.', grounds: ['doc:README.md#retention'] }, { claim: 'The code keeps six hours.', grounds: ['code.symbol\u003aservices/orders/discount.ts#discountFor'] }] }));
    const markdown = `${header}Rounding happens here.[^a]\n\nThe README promises ninety days.[^b]\n\n[^a]: [x](madarch:code.symbol\u003aservices/orders/discount.ts#roundDiscount)\n[^b]: [x](madarch:doc:README.md#retention)\n`;
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
    await open('ordering').call('ask_question', ask('Сколько хранятся заказы?', { question: 'Какой срок хранения действует?', why: 'Читатель видит два разных срока хранения.', sides: [{ claim: 'Документ обещает девяносто дней.', grounds: ['doc:README.md#retention'] }, { claim: 'Код удаляет заказы через шесть часов.', grounds: ['code.file:services/orders/retention.ts'] }] }));
    const path = [...sink.pages.keys()][0]!;
    const text = sink.pages.get(path)!;
    for (const heading of Object.values({ q: QUESTION_HEADINGS.ru.question, w: QUESTION_HEADINGS.ru.why, s: QUESTION_HEADINGS.ru.sources })) expect(text).toContain(`## ${heading}`);
    expect(text).not.toContain('## Question');
    expect(text).not.toContain('## Why it matters');
    expect(text).not.toContain('## What the sources say');
    const read = parseQuestion(path, text);
    expect(read.language).toBe('ru');
    expect(read.question).toBe('Какой срок хранения действует?');
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


describe('semantic comparison before a question is accepted (madarch-m38l.22)', () => {
  const decision = (id: string, same: boolean) => ({ id, same, reason: same ? 'Both ask which retention period applies to orders.' : 'One asks retention duration; the other asks who configures it.' });

  test('all fresh questions must be compared; shared grounds alone do not merge decisions', async () => {
    const { open, questions } = sessions('en', false);
    const tools = open('ordering');
    await tools.call('ask_question', ask('How long are orders kept?'));
    const pending = await tools.call('ask_question', ask('Who configures order retention?'));
    expect(pending.isError).toBe(true);
    expect(pending.answer).toMatchObject({ error: { code: 'question-comparison-required' }, candidates: [{ id: 'question:how-long-orders-kept', question: 'Which one is meant?' }] });
    expect((await questions()).length).toBe(1);
    const different = await tools.call('ask_question', ask('Who configures order retention?', { comparison: [decision('question:how-long-orders-kept', false)] }));
    expect(different.answer).toMatchObject({ asked: true });
    const incomplete = await tools.call('ask_question', ask('How many hours?', { comparison: [decision('question:how-long-orders-kept', true)] }));
    expect(incomplete.isError).toBe(true);
    expect((await questions()).length).toBe(2);
  });

  test('three paraphrases with different grounds return one id across units and runs', async () => {
    const { open, questions } = sessions('en', false);
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    for (const title of ['When must order data be removed?', 'Ninety days or six hours?']) {
      const result = await open('payments').call('ask_question', ask(title, { sides: [{ claim: 'The sources leave retention unclear.', grounds: ['doc:README.md#tax'] }], type: 'gap', comparison: [decision('question:how-long-orders-kept', true)] }));
      expect(result.isError, JSON.stringify(result.answer)).toBe(false);
      expect(result.answer).toMatchObject({ asked: false, id: 'question:how-long-orders-kept' });
    }
    expect((await questions()).length).toBe(1);
  });

  test('a gap matched to an open contradiction keeps the retained sides, not only the new proposal grounds', async () => {
    const { open } = sessions('en', false);
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    const payments = open('payments');
    const reused = await payments.call('ask_question', ask('Which retention rule applies?', {
      type: 'gap', sides: [{ claim: 'The document states a duration.', grounds: ['doc:README.md#retention'] }],
      comparison: [decision('question:how-long-orders-kept', true)],
    }));
    expect(reused.answer).toMatchObject({ asked: false, id: 'question:how-long-orders-kept' });
    const refused = await payments.call('write_page', { markdown: `${front}

The README promises ninety days.[^readme]

[^readme]: [source](madarch:doc:README.md#retention)
` });
    expect(refused.isError).toBe(true);
    expect(refused.answer).toMatchObject({ refused: [{ rule: 'contradiction-side-missing' }] });
    expect(JSON.stringify(refused.answer)).toContain('code.file:services/orders/retention.ts');
    const accepted = await payments.call('write_page', { markdown: `${front}

The README promises ninety days.[^readme]

The code deletes orders after six hours.[^code]

[^readme]: [source](madarch:doc:README.md#retention)
[^code]: [source](madarch:code.file:services/orders/retention.ts)
` });
    expect(accepted.isError, JSON.stringify(accepted.answer)).toBe(false);
  });

  test('a gap matched to an answered contradiction uses its answer without reviving obsolete sides', async () => {
    const { open, sink } = sessions('en', false);
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    const file = 'docs/questions/how-long-orders-kept.md';
    const held = parseQuestion(file, await sink.read(file));
    await sink.write(file, renderQuestion({ ...held, status: 'answered', answer: { text: 'Ninety days.', by: { name: 'Reader', email: 'reader@example.test', verified: 'local, not verified' }, at: '2026-10-24T12:00:00Z' } }));
    const payments = open('payments');
    const reused = await payments.call('ask_question', ask('Which retention rule applies?', { type: 'gap', sides: [{ claim: 'The duration needs a decision.', grounds: ['doc:README.md#retention'] }], comparison: [decision(held.id, true)] }));
    expect(reused.answer).toMatchObject({ asked: false, answered: true, id: held.id, answer: 'Ninety days.' });
    const accepted = await payments.call('write_page', { markdown: `${front}

Orders are kept for ninety days.[^answer]

[^answer]: [answer](madarch:question:how-long-orders-kept)
` });
    expect(accepted.isError, JSON.stringify(accepted.answer)).toBe(false);
  });

  test('an already-used answer is returned, associated with this page, and must ground the rewrite', async () => {
    const { open, sink } = sessions('en', false);
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    const file = 'docs/questions/how-long-orders-kept.md';
    const held = parseQuestion(file, await sink.read(file));
    await sink.write(file, renderQuestion({ ...held, status: 'answered', answer: { text: 'Ninety days.', by: { name: 'Reader', email: 'reader@example.test', verified: 'local, not verified' }, at: '2026-10-24T12:00:00Z' }, resolvedBy: ['domain:ordering'], resolvedAt: '2026-10-24T13:00:00Z' }));
    const before = (await sink.read(file)).replace('producer: agent', 'producer: person');
    await sink.write(file, before);
    const humanBody = before.slice(before.indexOf('\n---\n') + 5);
    const tools = open('payments');
    const reused = await tools.call('ask_question', ask('Retention duration?', { comparison: [decision(held.id, true)] }));
    expect(reused.answer).toMatchObject({ asked: false, answered: true, id: held.id, answer: 'Ninety days.' });
    expect(parseQuestion(file, await sink.read(file)).about).toContain('domain:payments');
    const associated = await sink.read(file);
    expect(associated).toContain('producer: person');
    expect(associated.slice(associated.indexOf('\n---\n') + 5)).toBe(humanBody);
    const rejected = await tools.call('write_page', { markdown: `${front}

Orders are retained.[^retained]

[^retained]: [policy](madarch:doc:README.md#retention)
` });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.answer)).toContain('answer-not-used');
    const accepted = await tools.call('write_page', { markdown: `${front}

Orders are retained for ninety days.[^retained]

[^retained]: [answer](madarch:${held.id})
` });
    expect(accepted.isError, JSON.stringify(accepted.answer)).toBe(false);
  });

  test('wrong-language questions are refused before a file is saved', async () => {
    const { open, sink } = sessions('ru', false);
    const result = await open('payments').call('ask_question', ask('How long are orders kept?'));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.answer)).toContain('question-language');
    expect(sink.pages.size).toBe(0);
  });

  test('missing, duplicate, unknown and reasonless comparisons never save a question', async () => {
    const { open, questions } = sessions('en', false);
    const tools = open('ordering');
    await tools.call('ask_question', ask('How long are orders kept?'));
    const id = 'question:how-long-orders-kept';
    for (const comparison of [[], [decision('question:unknown', false)], [decision(id, true), decision(id, true)], [{ id, same: true, reason: '  ' }], [decision(id, true), decision('question:extra', false)]]) {
      const result = await tools.call('ask_question', ask('How many hours?', { comparison }));
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.answer)).toContain('question-comparison-required');
      expect((await questions()).length).toBe(1);
    }
  });

  test('a complete multi-candidate packet rejects each malformed decision without saving or associating', async () => {
    const { open, sink } = sessions('en', false);
    const ordering = open('ordering');
    await ordering.call('ask_question', ask('How long are orders kept?'));
    const first = 'question:how-long-orders-kept';
    await ordering.call('ask_question', ask('Who configures retention?', { comparison: [decision(first, false)] }));
    const second = 'question:who-configures-retention';
    const paths = ['docs/questions/how-long-orders-kept.md', 'docs/questions/who-configures-retention.md'];
    const before = await Promise.all(paths.map((path) => sink.read(path)));
    const malformed = [
      [decision(first, false), decision('question:unknown', false)],
      [decision(first, false), decision(first, false)],
      [decision(first, false), { id: second, same: 'false', reason: 'A different decision.' }],
      [decision(first, false), { id: second, reason: 'A different decision.' }],
      [decision(first, false), { id: second, same: false, reason: 17 }],
      [decision(first, false), { id: second, same: false }],
      [decision(first, false), { id: second, same: false, reason: '  ' }],
    ];
    for (const comparison of malformed) {
      const result = await open('payments').call('ask_question', ask('Which refund deadline applies?', { comparison }));
      expect(result.isError, JSON.stringify(comparison)).toBe(true);
      expect(result.answer).toMatchObject({ error: { code: 'question-comparison-required' } });
      expect(await sink.list!('docs/questions')).toEqual(paths);
      expect(await Promise.all(paths.map((path) => sink.read(path)))).toEqual(before);
    }
  });

  test('reusing an ordinary gap does not create a contradiction obligation for its new page', async () => {
    const { open } = sessions('en', false);
    await open('ordering').call('ask_question', ask('How long are orders kept?', { type: 'gap', sides: [{ claim: 'The README leaves the duration unclear.', grounds: ['doc:README.md#retention'] }] }));
    const payments = open('payments');
    expect((await payments.call('ask_question', ask('Which retention duration applies?', { type: 'gap', sides: [{ claim: 'The code leaves the policy unclear.', grounds: ['code.file:services/orders/retention.ts'] }], comparison: [decision('question:how-long-orders-kept', true)] }))).answer).toMatchObject({ asked: false, merged: true });
    const written = await payments.call('write_page', { markdown: `${front}

The tax document names the tax policy.[^tax]

[^tax]: [source](madarch:doc:README.md#tax)
` });
    expect(written.isError, JSON.stringify(written.answer)).toBe(false);
  });

  test('an incoming contradiction matched to a gap keeps both incoming sources for the rewrite', async () => {
    const { open } = sessions('en', false);
    const created = await open('ordering').call('ask_question', ask('How long are orders kept?', { type: 'gap', sides: [{ claim: 'The tax document leaves the policy unclear.', grounds: ['doc:README.md#tax'] }] }));
    expect(created.isError, JSON.stringify(created.answer)).toBe(false);
    const payments = open('payments');
    const reused = await payments.call('ask_question', ask('Which retention duration applies?', { comparison: [decision('question:how-long-orders-kept', true)] }));
    expect(reused.answer).toMatchObject({ asked: false, merged: true });
    const refused = await payments.call('write_page', { markdown: `${front}

The README promises ninety days.[^readme]

[^readme]: [source](madarch:doc:README.md#retention)
` });
    expect(refused.isError).toBe(true);
    expect(refused.answer).toMatchObject({ refused: [{ rule: 'contradiction-side-missing' }] });
    expect(JSON.stringify(refused.answer)).toContain('code.file:services/orders/retention.ts');
    const accepted = await payments.call('write_page', { markdown: `${front}

The README promises ninety days.[^readme]

The code deletes orders after six hours.[^code]

[^readme]: [source](madarch:doc:README.md#retention)
[^code]: [source](madarch:code.file:services/orders/retention.ts)
` });
    expect(accepted.isError, JSON.stringify(accepted.answer)).toBe(false);
  });

  test('concurrent units compare the fresh set after the earlier create completes', async () => {
    const { open, questions } = sessions('en', false);
    const [first, second] = await Promise.all([
      open('ordering').call('ask_question', ask('How long are orders kept?')),
      open('payments').call('ask_question', ask('Which retention period applies?')),
    ]);
    expect(first.answer).toMatchObject({ asked: true });
    expect(second.answer).toMatchObject({ error: { code: 'question-comparison-required' }, candidates: [{ id: 'question:how-long-orders-kept' }] });
    expect((await questions()).length).toBe(1);
  });

  test('one blocked product does not block another, and a failed write releases its queue', async () => {
    const blocked = memorySink(); const other = memorySink();
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const write = blocked.write;
    let firstWrite = true;
    blocked.write = async (path, source) => {
      if (firstWrite) { firstWrite = false; await gate; throw new Error('/fixture/docs/questions/pending.md:1: write refused'); }
      await write(path, source);
    };
    const slow = new UnitTools(stubView, UNIT('ordering'), blocked, DOMAINS);
    const independent = new UnitTools(stubView, UNIT('payments'), other, DOMAINS);
    const pending = slow.call('ask_question', ask('How long are orders kept?'));
    try {
      expect((await independent.call('ask_question', ask('Which retention period applies?'))).answer).toMatchObject({ asked: true });
    } finally { release(); }
    expect((await pending).isError).toBe(true);
    expect((await slow.call('ask_question', ask('How long are orders kept?'))).answer).toMatchObject({ asked: true });
  });

  test('adding a page never drops existing associations when the bound is full', async () => {
    const { open, sink } = sessions('en', false);
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    const file = 'docs/questions/how-long-orders-kept.md';
    const candidate = parseQuestion(file, await sink.read(file));
    await sink.write(file, renderQuestion({ ...candidate, about: Array.from({ length: MAX_ABOUT }, (_, index) => `domain:existing-${index}`) }));
    const before = await sink.read(file);
    const reused = await open('payments').call('ask_question', ask('Which retention duration applies?', { comparison: [decision(candidate.id, true)] }));
    expect(reused.answer).toMatchObject({ error: { code: 'question-association-limit' } });
    expect(await sink.read(file)).toBe(before);
  });

  test('malformed or unreadable live candidate files prevent creation with a full path and line', async () => {
    const sink = memorySink();
    await sink.write('docs/questions/broken.md', '---\nid: [broken\n---\n');
    const tools = new UnitTools(stubView, UNIT('payments'), sink, DOMAINS, undefined, [], { output: '/fixture/product' });
    const result = await tools.call('ask_question', ask('How long are orders kept?'));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.answer)).toContain('/fixture/product/docs/questions/broken.md:');
    expect(sink.pages.size).toBe(1);
  });

  test('an oversized complete comparison is refused without returning a smaller candidate packet', async () => {
    const { open, sink, questions } = sessions('en', false);
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    const candidate = (await questions())[0]!;
    const tools = new UnitTools(stubView, UNIT('payments'), sink, DOMAINS, undefined, [], {
      output: '/fixture/product', questions: async () => [{ ...candidate, question: 'retention '.repeat(13_000) }],
    });
    const result = await tools.call('ask_question', ask('Which retention duration applies?'));
    expect(result.answer).toMatchObject({ error: { code: 'question-comparison-limit', count: 1 } });
    expect(JSON.stringify(result.answer)).toContain('/fixture/product/docs/questions:1:');
    expect('candidates' in (result.answer as object)).toBe(false);
    expect((await questions()).length).toBe(1);
  });

  test('a parse failure releases the question queue without treating the broken candidate as absent', async () => {
    const { open, sink, questions } = sessions('en', false);
    await open('ordering').call('ask_question', ask('How long are orders kept?'));
    const candidate = (await questions())[0]!;
    let broken = true;
    const tools = new UnitTools(stubView, UNIT('payments'), sink, DOMAINS, undefined, [], { questions: async () => {
      if (broken) throw new Error('/fixture/product/docs/questions/broken.md:12: malformed');
      return [candidate];
    } });
    expect((await tools.call('ask_question', ask('Which retention duration applies?'))).isError).toBe(true);
    broken = false;
    const retry = await tools.call('ask_question', ask('Which retention duration applies?'));
    expect(retry.answer).toMatchObject({ error: { code: 'question-comparison-required' }, candidates: [{ id: candidate.id }] });
    expect((await questions()).length).toBe(1);
  });

  test('an unreadable candidate list is a refusal, never permission to create', async () => {
    const sink = memorySink();
    const tools = new UnitTools(stubView, UNIT('payments'), sink, DOMAINS, undefined, [], { questions: async () => { throw new Error('/fixture/product/docs/questions/broken.md:12: invalid question'); } });
    const result = await tools.call('ask_question', ask('How long are orders kept?'));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.answer)).toContain('/fixture/product/docs/questions/broken.md:12');
    expect(sink.pages.size).toBe(0);
  });
});
