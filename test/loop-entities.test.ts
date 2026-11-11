/**
 * The loop's files (madarch-m38l.7): a question and a correction are Markdown
 * files in the product repository; an answer and a correction are written by
 * a person in the wiki and committed with the person as author; the refresh
 * decides which pages need an agent unit. Fixtures only: a draft product made
 * by madarch's own creation code in a scratch home, with invented pages.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createDraft } from '../src/product/draft.js';
import { localIdentity } from '../src/loop/answer.js';
import { LoopFileError, parseQuestion, type Question } from './loop-entities-fixture.js';
import { renderQuestion } from './loop-entities-fixture.js';
import { questionFootnoteId } from './loop-ids-fixture.js';
import { decide } from '../src/loop/plan.js';
import { readQuestions } from '../src/loop/entities.js';
import { gitEnv } from './git-env.js';

const folders: string[] = [];
const scratch = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-loop-'));
  folders.push(folder);
  return folder;
};
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const SEED = { GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 'seed@example.test', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 'seed@example.test' };
const PERSON = { GIT_AUTHOR_NAME: 'Ada Reader', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Reader', GIT_COMMITTER_EMAIL: 'ada@example.test' };
/** An environment whose git has no configuration of its own: the identity is what the test gives it. */
const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...gitEnv(overrides), HOME: '/nonexistent' });

function product(): string {
  const draft = createDraft({ home: scratch(), name: 'loop-shop', gitEnv: gitEnv(SEED) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  return draft.folder;
}

const QUESTION: Omit<Question, 'file' | 'id'> = {
  slug: 'discount-percentage', title: 'Is the discount ten percent or what the caller passes?', type: 'contradiction', status: 'open',
  about: ['domain:orders', 'domain:orders#ten-percent-discount'], askedIn: 'domain:orders', askedAt: '2026-10-23T10:00:00.000Z',
  question: 'Which discount does an order get?', why: 'A shopper is told one number and charged another.',
  sides: [{ claim: 'The README says every order gets ten percent.', grounds: ['doc:README.md#discounts'] }, { claim: 'The code applies the percentage its caller passes.', grounds: ['code.symbol\u003asrc/pricing.ts#discountFor'] }],
  answer: null, resolvedBy: [], resolvedAt: null, writtenAt: [{ repository: 'shop', commit: 'a'.repeat(40), branch: 'main' }],
};

describe('a question file', () => {
  test('is the same bytes for the same question, reads back whole, and keeps both sides with their grounds', () => {
    const text = renderQuestion(QUESTION);
    expect(renderQuestion(QUESTION)).toBe(text);
    const read = parseQuestion('docs/questions/discount-percentage.md', text);
    expect(read).toMatchObject({ slug: 'discount-percentage', id: 'question:discount-percentage', status: 'open', type: 'contradiction', about: QUESTION.about, askedIn: 'domain:orders', answer: null });
    expect(read.sides).toEqual(QUESTION.sides);
    expect(read.writtenAt).toEqual(QUESTION.writtenAt);
    // The sides are statements of the page format: a sentence and a footnote that lists its grounds.
    expect(text).toContain(`- The README says every order gets ten percent.[^${questionFootnoteId(QUESTION.sides[0]!.claim, QUESTION.sides[0]!.grounds)}]`);
    expect(text).toContain('](madarch:doc:README.md#discounts)');
  });

  test('a file written before content hashes keeps its footnote names when it is rendered again', () => {
    const file = 'docs/questions/discount-percentage.md';
    const rendered = renderQuestion(QUESTION);
    const label = /\[\^([^\]]+)\]/.exec(rendered)![1]!;
    const text = rendered.replaceAll(`[^${label}]`, '[^old-readme-name]').replace(`${label}:`, 'old-readme-name:');
    const read = parseQuestion(file, text);
    const again = renderQuestion(read);
    expect(again).toContain('[^old-readme-name]');
    expect(again).toContain('[^old-readme-name]: [discounts](madarch:doc:README.md#discounts)');
  });

  test('carries the answer, who gave it and the mark, and reads it back', () => {
    const by = { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' };
    const text = renderQuestion({ ...QUESTION, status: 'answered', answer: { text: 'Ten percent.\n\n## Not a heading of the file\n--- nor a rule', by, at: '2026-10-23T11:00:00.000Z' }, resolvedBy: ['domain:orders'], resolvedAt: '2026-10-23T12:00:00.000Z' });
    const read = parseQuestion('docs/questions/discount-percentage.md', text);
    expect(read.status).toBe('answered');
    expect(read.answer).toEqual({ text: 'Ten percent.\n\n## Not a heading of the file\n--- nor a rule', by, at: '2026-10-23T11:00:00.000Z' });
    expect(read.resolvedBy).toEqual(['domain:orders']);
    expect(text).toContain('Answered by Ada Reader <ada@example.test> at 2026-10-23T11:00:00.000Z (local, not verified).');
  });

  test('a file that is not one names the file and the line', () => {
    const file = 'docs/questions/discount-percentage.md';
    const good = renderQuestion(QUESTION);
    expect(() => parseQuestion(file, 'no front matter\n')).toThrow(`${file}:1: the file has no front matter`);
    expect(() => parseQuestion(file, good.replace('status: open', 'status: pending'))).toThrow(`${file}:2: "status" is open or answered`);
    expect(() => parseQuestion(file, good.replace('id: question:discount-percentage', 'id: question:other'))).toThrow(`${file}:2: "id" is "question:discount-percentage" for this file name`);
    expect(() => parseQuestion(file, good.replace('type: contradiction', 'type: riddle'))).toThrow('"type" is one of contradiction, ambiguous-term, undocumented, gap');
    expect(() => parseQuestion(file, good.replace('status: open', 'status: answered'))).toThrow(/the status is answered but the file has no "## Answer" section/);
    expect(() => parseQuestion(file, good.replace('## What the sources say', '## Sources'))).toThrow(/has no "## What the sources say" section/);
    try { parseQuestion(file, good.replace('## Why it matters', '## Why')); } catch (error) { expect(error).toBeInstanceOf(LoopFileError); expect((error as LoopFileError).file).toBe(file); }
  });

  
  test('the retired Markdown listing fails explicitly', () => {
    expect(() => readQuestions(product())).toThrow('retired');
  });
});

describe('a person answers in the wiki', () => {
  test('git identity: the author variables win, then the configuration', async () => {
    const folder = product();
    expect(await localIdentity(folder, env(PERSON))).toEqual({ name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' });
    execFileSync('git', ['config', 'user.name', 'Configured'], { cwd: folder, env: gitEnv(SEED) });
    execFileSync('git', ['config', 'user.email', 'configured@example.test'], { cwd: folder, env: gitEnv(SEED) });
    expect((await localIdentity(folder, env())).name).toBe('Configured');
    expect((await localIdentity(folder, env(PERSON))).name).toBe('Ada Reader');
  });

});

describe('the refresh decides which pages need an agent unit', () => {
  const page = (id: string, file: string, statements: { id: string; grounds: string[]; text?: string }[], relates: string[] = []) => ({
    id, kind: id.split(':')[0]!, title: id, file, relates, sources: [], writtenAt: [{ repository: 'shop', commit: 'a'.repeat(40) }], producer: 'agent', mentions: [], digest: 'd',
    statements: statements.map((s, i) => ({ id: s.id, labels: [s.id], text: s.text ?? `Sentence ${s.id}.`, digest: 'x', line: 10 + i, mentions: [], grounds: s.grounds })),
  });
  const pages = [
    page('product:shop', 'docs/product.md', [{ id: 'takes-orders', grounds: ['code.service:orders'] }], ['code.service:orders', 'code.service:payments']),
    page('domain:orders', 'docs/domains/orders.md', [{ id: 'ten-percent-discount', grounds: ['doc:README.md#discounts'] }, { id: 'tax-at-checkout', grounds: ['doc:README.md#tax'] }], ['code.service:orders']),
    page('domain:payments', 'docs/domains/payments.md', [{ id: 'two-providers', grounds: ['code.symbol\u003asrc/pay.ts#Factory'] }], ['code.service:payments']),
  ];
  const ground = (pageId: string, statement: string, target: string, status: 'changed' | 'unchanged' | 'removed' | 'unknown') => ({ page: pageId, statement, text: 'x', line: 11, ground: target, status, method: 'section' as const, writtenCommit: 'a'.repeat(40), before: 'b', after: 'c' });
  const by = { name: 'Ada', email: 'ada@example.test', verified: 'local, not verified' };
  const answered = (change: Partial<Omit<Question, 'file' | 'id'>>): Question => ({ ...QUESTION, file: 'docs/questions/q.md', id: 'question:q', slug: 'q', status: 'answered', answer: { text: 'x', by, at: '2026-10-23T11:00:00.000Z' }, ...change });
  const base = { pages, grounds: [], questions: [], corrections: [], newServices: [], language: { from: 'en', to: 'en', changed: false } };

  test('nothing changed: no page is touched', () => {
    const plan = decide(base);
    expect(plan.pages).toEqual([]);
    expect(plan.unchanged).toEqual(['docs/domains/orders.md', 'docs/domains/payments.md', 'docs/product.md']);
  });

  test('a changed or removed ground touches the page of its statement and no other; unknown and unchanged touch nothing', () => {
    const plan = decide({ ...base, grounds: [
      ground('domain:orders', 'tax-at-checkout', 'doc:README.md#tax', 'changed'),
      ground('domain:payments', 'two-providers', 'code.symbol\u003asrc/pay.ts#Factory', 'unchanged'),
      ground('product:shop', 'takes-orders', 'code.service:orders', 'unknown'),
      ground('domain:orders', 'ten-percent-discount', 'doc:README.md#discounts', 'removed'),
    ] });
    expect(plan.pages.map((p) => [p.path, p.reasons.map((r) => r.kind)])).toEqual([['docs/domains/orders.md', ['ground-changed', 'ground-removed']]]);
    expect(plan.unchanged).toEqual(['docs/domains/payments.md', 'docs/product.md']);
  });

  test('an answered question touches the pages it is about, the page that asked and the pages that stand on what it names; an open or closed one touches none', () => {
    const plan = decide({ ...base, questions: [
      answered({ slug: 'q1', about: ['domain:orders#ten-percent-discount'], askedIn: null }),
      answered({ slug: 'q2', about: ['code.symbol\u003asrc/pay.ts#Factory'], askedIn: 'product:shop' }),
      answered({ slug: 'q3', status: 'open', answer: null, about: ['domain:orders'] }),
      answered({ slug: 'q4', about: ['domain:orders'], resolvedBy: ['domain:orders'] }),
    ] });
    expect(plan.pages.map((p) => [p.path, p.reasons.map((r) => (r.kind === 'answer' ? r.question : r.kind))])).toEqual([['docs/domains/orders.md', ['q1']], ['docs/domains/payments.md', ['q2']], ['docs/product.md', ['q2']]]);
  });

  test('a question or correction about no page is told, never dropped', () => {
    const plan = decide({ ...base, questions: [answered({ slug: 'lost', about: ['code.service:nowhere'], askedIn: null })], corrections: [{
      slug: 'c', id: 'correction:c', file: 'docs/corrections/c.md', title: 'c', status: 'open', about: 'domain:gone#s', statement: 'S.', reason: 'because', by, at: '2026-10-23T11:00:00.000Z', resolvedBy: [], resolvedAt: null,
    }] });
    expect(plan.pages).toEqual([]);
    expect(plan.unplaced.map((u) => `${u.kind}:${u.slug}`)).toEqual(['correction:c', 'question:lost']);
    expect(plan.unplaced[1]!.reason).toContain('docs/questions/q.md');
    expect(plan.unplaced[0]!.reason).toContain('docs/corrections/c.md');
  });

  test('an open correction touches the page of its statement; an applied one does not', () => {
    const correction = (slug: string, status: 'open' | 'applied') => ({ slug, id: `correction:${slug}`, file: `docs/corrections/${slug}.md`, title: slug, status, about: 'domain:payments#two-providers', statement: 'S.', reason: 'because', by, at: '2026-10-23T11:00:00.000Z', resolvedBy: [], resolvedAt: null }) as const;
    const plan = decide({ ...base, corrections: [correction('open-one', 'open'), correction('done-one', 'applied')] });
    expect(plan.pages).toEqual([{ id: 'domain:payments', path: 'docs/domains/payments.md', reasons: [{ kind: 'correction', correction: 'open-one', statement: 'domain:payments#two-providers' }] }]);
  });

  test('a service no page names touches the product page, which declares the domains', () => {
    const plan = decide({ ...base, newServices: ['code.service:shipping', 'code.service:notify'] });
    expect(plan.pages).toEqual([{ id: 'product:shop', path: 'docs/product.md', reasons: [{ kind: 'new-service', services: ['code.service:notify', 'code.service:shipping'] }] }]);
  });

  test('a change of language touches every page as a translation; without a product page the product is missing', () => {
    const translated = decide({ ...base, language: { from: 'en', to: 'ru', changed: true } });
    expect(translated.pages.map((p) => p.path)).toEqual(['docs/domains/orders.md', 'docs/domains/payments.md', 'docs/product.md']);
    expect(translated.pages.every((p) => p.reasons.some((r) => r.kind === 'language' && r.from === 'en' && r.to === 'ru'))).toBe(true);
    expect(translated.unchanged).toEqual([]);
    const first = decide({ ...base, pages: [] });
    expect(first.pages).toEqual([{ id: 'product:*', path: 'docs/product.md', reasons: [{ kind: 'missing' }] }]);
  });
});

describe('what a review of the first version found', () => {
  const by = { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' };

  test('an answer that looks like a source side is an answer, never a side; a claim with code marks survives an answer unchanged', () => {
    const claim = 'The code uses `foo_bar` for the key.';
    const answered = renderQuestion({ ...QUESTION, sides: [{ claim, grounds: ['doc:README.md#discounts'] }, QUESTION.sides[1]!], status: 'answered', answer: { text: 'They bypass the queue.[^readme-says-order-gets]\n- A bullet that is an answer.[^x]', by, at: '2026-10-23T11:00:00.000Z' } });
    const read = parseQuestion('docs/questions/discount-percentage.md', answered);
    expect(read.sides.map((side) => side.claim)).toEqual([claim, QUESTION.sides[1]!.claim]);
    expect(renderQuestion(read)).toBe(answered);
  });

  test('a product page that links a domain with no page makes the domain missing and the product page an edit', () => {
    const product = { id: 'product:shop', kind: 'product', title: 'Shop', file: 'docs/product.md', relates: [], sources: [], writtenAt: [], producer: 'agent', statements: [], mentions: ['domain:orders', 'domain:shipping'], digest: 'd' };
    const orders = { ...product, id: 'domain:orders', kind: 'domain', file: 'docs/domains/orders.md', mentions: [] };
    const plan = decide({ pages: [product, orders], grounds: [], questions: [], corrections: [], newServices: [], language: { from: 'en', to: 'en', changed: false } });
    expect(plan.pages.map((p) => [p.path, p.reasons.map((r) => r.kind)])).toEqual([['docs/domains/shipping.md', ['missing']], ['docs/product.md', ['missing-domain']]]);
  });
});
