/** The sentence reader: a Markdown tree and a language-aware segmenter (madarch-ztyq.11). */
import { describe, expect, test } from 'bun:test';
import { checkPage, type GroundResolver, type PageExpectation } from '../src/writer/format.js';
import { splitFrontMatter } from '../src/knowledge/markdown.js';
import { maskInline, plainSentence, sentencesOf, statementsOf, unmask } from '../src/writer/sentences.js';
import oldWriter from './fixtures/old-writer-pages.json';

describe('the shared sentence reader', () => {
  test('a dotted abbreviation the language knows is not a sentence end', () => {
    const text = 'The U.S. market is large.[^market] It stays open.';
    expect(sentencesOf(maskInline(text), 'en').map((sentence) => unmask(sentence.text))).toEqual([
      'The U.S. market is large.[^market]',
      'It stays open.',
    ]);
  });

  test('a question link after a grounded sentence is its suffix, and the next fact is separate', () => {
    const question = '[→ question: Which market?](madarch:question:market)';
    const text = `The U.S. market is large.[^market] ${question} It stays open.`;
    expect(sentencesOf(maskInline(text), 'en').map((sentence) => unmask(sentence.text))).toEqual([
      `The U.S. market is large.[^market] ${question}`,
      'It stays open.',
    ]);
    const adjacent = `The U.S. market is large.[^market]${question} It stays open.`;
    expect(sentencesOf(maskInline(adjacent), 'en').map((sentence) => unmask(sentence.text))).toEqual([
      `The U.S. market is large.[^market]${question}`,
      'It stays open.',
    ]);
  });

  test('a link label with terminal punctuation does not end the sentence it introduces', () => {
    const text = '[BR-5 Promotion cap. A promotion never takes off more than...](madarch:doc:docs/requirements.md#br-5-promotion-cap) — A promotion never takes off more than the subtotal.[^tax]';
    expect(sentencesOf(maskInline(text), 'en').map((sentence) => unmask(sentence.text))).toEqual([text]);
  });

  test('a referenced question suffix is left out of the statement key like an inline one', () => {
    const body = [
      'Orders ship tomorrow.[^a] [When?][q]',
      '',
      '[^a]: [A](madarch:code.symbol:src/a.ts#a)',
      '',
      '[q]: madarch:question:delivery',
    ].join('\n');
    expect(statementsOf(body, 1, 'en').map((statement) => statement.text)).toEqual(['Orders ship tomorrow.']);
  });

  test('the tree gives the same statements from a list, a quote and a paragraph', () => {
    const body = [
      'The first fact stands.[^a]',
      '',
      '- A listed fact stands.[^b]',
      '',
      '> A quoted fact stands.[^c]',
      '',
      '[^a]: [A](madarch:code.symbol:src/a.ts#a)',
      '[^b]: [B](madarch:code.symbol:src/b.ts#b)',
      '[^c]: [C](madarch:code.symbol:src/c.ts#c)',
    ].join('\n');
    expect(statementsOf(body, 10, 'en').map((statement) => [statement.text, statement.line, statement.grounds])).toEqual([
      ['The first fact stands.', 10, ['code.symbol:src/a.ts#a']],
      ['A listed fact stands.', 12, ['code.symbol:src/b.ts#b']],
      ['A quoted fact stands.', 14, ['code.symbol:src/c.ts#c']],
    ]);
  });

  test('a grounded sentence ending in a short word is not merged with the next one', () => {
    const body = [
      'The flag is on.[^a] Restart it.[^b]',
      '',
      '[^a]: [A](madarch:code.symbol:src/a.ts#a)',
      '[^b]: [B](madarch:code.symbol:src/b.ts#b)',
    ].join('\n');
    expect(statementsOf(body, 1, 'en').map((statement) => [statement.id, statement.text, statement.grounds])).toEqual([
      ['a', 'The flag is on.', ['code.symbol:src/a.ts#a']],
      ['b', 'Restart it.', ['code.symbol:src/b.ts#b']],
    ]);
  });

  test('a footnote-shaped literal inside inline code stays in the plain sentence', () => {
    expect(plainSentence('The token is `value[^x]`.[^a]')).toBe('The token is value[^x].');
  });
});

const resolver: GroundResolver = {
  graphKey: async (key) => key.startsWith('code.symbol:'),
  docSection: async () => false,
  sourceName: async () => false,
};

const header = (id: string, title: string): string => [
  '---',
  `id: ${id}`,
  'kind: domain',
  `title: ${title}`,
  'relates: []',
  'producer: agent',
  'sources: []',
  '---',
  '',
].join('\n');

const delivery: PageExpectation = { id: 'domain:delivery', kind: 'domain', domains: ['delivery'], mustLinkDomains: false, language: 'en' };

async function rules(markdown: string, expected: PageExpectation): Promise<string[]> {
  const checked = await checkPage(markdown, expected, resolver);
  return checked.ok ? [] : checked.refusals.map((refusal) => refusal.rule);
}

describe('the format validates what the tree says, not a word list in the text', () => {
  test('a claim hidden in a navigation link label is a statement, whatever verb it uses', async () => {
    expect(await rules(`${header('domain:delivery', 'Delivery')}Delivery takes two days.[^a]\n\nSee also [delivery takes two days](madarch:domain:delivery).\n\n[^a]: [A](madarch:code.symbol:src/a.ts#a)\n`, delivery))
      .toContain('ungrounded-statement');
  });

  test('a link label with terminal punctuation introduces one grounded sentence, not a statement of its own', async () => {
    const page = `${header('domain:delivery', 'Delivery')}Delivery takes two days.[^a]\n\n- [BR-5 Promotion cap. A promotion never takes off more than...](madarch:doc:docs/requirements.md#br-5-promotion-cap) — A promotion never takes off more than the subtotal.[^b]\n\n[^a]: [A](madarch:code.symbol:src/a.ts#a)\n[^b]: [Rules](madarch:doc:docs/requirements.md#br-5)\n`;
    const withDocs: GroundResolver = { ...resolver, docSection: async (path, anchor) => path === 'docs/requirements.md' && (anchor === 'br-5-promotion-cap' || anchor === 'br-5') };
    const checked = await checkPage(page, delivery, withDocs);
    expect(checked.ok).toBe(true);
  });

  test('a word between navigation links is a statement and needs grounds', async () => {
    const page = `${header('domain:delivery', 'Delivery')}Delivery takes two days.[^a]\n\nSee also [delivery](madarch:domain:delivery) is [free](madarch:domain:delivery).\n\n[^a]: [A](madarch:code.symbol:src/a.ts#a)\n`;
    expect(await rules(page, delivery)).toContain('ungrounded-statement');
  });

  test('a footnote-shaped literal inside inline code is no footnote when a page is canonicalized', async () => {
    const markdown = `${header('domain:delivery', 'Delivery')}The token is \`value[^x]\`.[^a]\n\n[^a]: [A](madarch:code.symbol:src/a.ts#a)\n`;
    const checked = await checkPage(markdown, delivery, resolver);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.page.markdown).toContain('`value[^x]`');
    const { body, bodyLine } = splitFrontMatter(checked.page.markdown);
    expect(statementsOf(body, bodyLine, 'en').map((statement) => [statement.text, statement.labels])).toEqual([
      ['The token is value[^x].', ['a']],
    ]);
  });
});

describe('pages written by the old writer keep their sentence keys through the new one', () => {
  for (const page of oldWriter.pages) {
    test(`${page.file} keeps its named keys, text and grounds`, async () => {
      const expectation = page.expectation as PageExpectation;
      const checked = await checkPage(page.markdown, { ...expectation, previous: page.markdown }, resolver);
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      const { body, bodyLine } = splitFrontMatter(checked.page.markdown);
      const before = splitFrontMatter(page.markdown);
      expect(body).toBe(before.body);
      const named = (entry: { id: string; labels: readonly string[]; text: string; grounds: readonly string[] }) => ({
        id: entry.id, labels: entry.labels, text: entry.text, grounds: entry.grounds,
      });
      expect(statementsOf(body, bodyLine, 'en').map(named)).toEqual(page.statements.map(named));
    });
  }

  test('an old canonical page keeps its names when one sentence is added', async () => {
    const page = oldWriter.pages[0]!;
    const expectation = page.expectation as PageExpectation;
    const before = splitFrontMatter(page.markdown);
    const closing = page.markdown.indexOf('\n---\n') + '\n---\n'.length;
    let body = before.body.replace('\n\n[^flag]:', '\n\nA new fact stands.[^3]\n\n[^flag]:');
    body = body.replace('\n[^restart]: [Restart](madarch:code.symbol:src/restart.ts#restart)', '\n[^restart]: [Restart](madarch:code.symbol:src/restart.ts#restart)\n[^3]: [New](madarch:code.symbol:src/new.ts#new)');
    const checked = await checkPage(page.markdown.slice(0, closing) + body, { ...expectation, previous: page.markdown }, resolver);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const { body: checkedBody, bodyLine } = splitFrontMatter(checked.page.markdown);
    expect(statementsOf(checkedBody, bodyLine, 'en').map((statement) => statement.labels)).toEqual([['flag'], ['restart'], ['new-fact-stands']]);
  });
});
