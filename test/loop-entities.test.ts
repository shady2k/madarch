/**
 * The loop's files (madarch-m38l.7): a question and a correction are Markdown
 * files in the product repository; an answer and a correction are written by
 * a person in the wiki and committed with the person as author; the refresh
 * decides which pages need an agent unit. Fixtures only: a draft product made
 * by madarch's own creation code in a scratch home, with invented pages.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createDraft } from '../src/product/draft.js';
import { readKnowledgePages } from '../src/knowledge/index/index.js';
import { ensureLoopKinds } from '../src/knowledge/seed.js';
import { readKinds } from '../src/knowledge/kinds.js';
import { LoopRefusal, answerQuestion, commitFiles, localIdentity, markResolved, recordCorrection } from '../src/loop/answer.js';
import { LoopFileError, parseCorrection, parseQuestion, readCorrections, readQuestions, renderCorrection, renderQuestion, freeSlug, type Question } from '../src/loop/entities.js';
import { decide } from '../src/loop/plan.js';
import { NOTES_CHARACTERS, includedNotes, type ChangeNote } from '../src/writer/edit.js';
import { symlinkSync } from 'node:fs';
import { listQuestions, rowOf } from '../src/loop/views.js';
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

const PAGE = `---
id: domain:orders
kind: domain
title: Orders
relates:
  - code.service:orders
producer: agent
sources: [README.md]
---
## How orders work

Orders get a ten percent discount.[^ten-percent-discount] Tax is added at checkout.[^tax-at-checkout]

[^ten-percent-discount]: [README](madarch:doc:README.md#discounts)
[^tax-at-checkout]: [README](madarch:doc:README.md#tax)
`;

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
    expect(text).toContain('- The README says every order gets ten percent.[^readme-says-order-gets]');
    expect(text).toContain('](madarch:doc:README.md#discounts)');
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

  test('a folder is read in code point order, and a file that is not a question is a problem, never left out', () => {
    const folder = product();
    mkdirSync(join(folder, 'docs/questions'), { recursive: true });
    writeFileSync(join(folder, 'docs/questions/b-second.md'), renderQuestion({ ...QUESTION, slug: 'b-second' }));
    writeFileSync(join(folder, 'docs/questions/A-upper.md'), renderQuestion({ ...QUESTION, slug: 'A-upper' }));
    writeFileSync(join(folder, 'docs/questions/c-broken.md'), 'not a question\n');
    const read = readQuestions(folder);
    // Code point order: a capital letter sorts before a lower-case one.
    expect(read.items.map((q) => q.slug)).toEqual(['A-upper', 'b-second']);
    expect(read.problems.map((p) => p.message)).toEqual(['docs/questions/c-broken.md:1: the file has no front matter: it starts with --- , its fields, ---']);
    expect(freeSlug(folder, 'docs/questions', 'b-second')).toBe('b-second-2');
    expect(freeSlug(folder, 'docs/questions', 'fresh')).toBe('fresh');
    const listing = listQuestions(folder);
    expect(listing.rows.map((row) => row.slug)).toEqual(['A-upper', 'b-second']);
    expect(listing.problems).toEqual(['docs/questions/c-broken.md:1: the file has no front matter: it starts with --- , its fields, ---']);
  });

  test('the listing puts open first, then answered, then closed, each by id', () => {
    const by = { name: 'Ada', email: 'ada@example.test', verified: 'local, not verified' };
    const folder = product();
    mkdirSync(join(folder, 'docs/questions'), { recursive: true });
    const put = (slug: string, change: Partial<Omit<Question, 'file' | 'id'>>): void => writeFileSync(join(folder, `docs/questions/${slug}.md`), renderQuestion({ ...QUESTION, slug, ...change }));
    put('z-open', {});
    put('a-closed', { status: 'answered', answer: { text: 'x', by, at: '2026-10-23T11:00:00.000Z' }, resolvedBy: ['domain:orders'], resolvedAt: '2026-10-23T12:00:00.000Z' });
    put('m-answered', { status: 'answered', answer: { text: 'x', by, at: '2026-10-23T11:00:00.000Z' } });
    put('b-open', {});
    const listing = listQuestions(folder);
    expect(listing.rows.map((row) => `${row.slug}:${row.state}`)).toEqual(['b-open:open', 'z-open:open', 'm-answered:answered', 'a-closed:closed']);
    expect([listing.open, listing.answered, listing.closed]).toEqual([2, 1, 1]);
    expect(rowOf(readQuestions(folder).items.find((q) => q.slug === 'a-closed')!).closedBy).toEqual(['domain:orders']);
  });
});

describe('a person answers in the wiki', () => {
  function withQuestion(): string {
    const folder = product();
    mkdirSync(join(folder, 'docs/questions'), { recursive: true });
    writeFileSync(join(folder, 'docs/questions/discount-percentage.md'), renderQuestion(QUESTION));
    execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(SEED) });
    execFileSync('git', ['commit', '-q', '-m', 'the agent asked'], { cwd: folder, env: gitEnv(SEED) });
    return folder;
  }
  const log = (folder: string, format: string): string => execFileSync('git', ['log', '-1', `--format=${format}`], { cwd: folder, encoding: 'utf8', env: gitEnv(SEED) }).trim();

  test('the answer lands in the question file and is committed with the person as author, marked local, not verified', async () => {
    const folder = withQuestion();
    const done = await answerQuestion({ productFolder: folder, slug: 'discount-percentage', text: '  Ten percent for every order.  ', now: () => new Date('2026-10-23T11:30:00Z'), env: env(PERSON) });
    expect(done.committed).toBe(true);
    expect(done.question.status).toBe('answered');
    const file = readFileSync(join(folder, 'docs/questions/discount-percentage.md'), 'utf8');
    const read = parseQuestion('docs/questions/discount-percentage.md', file);
    expect(read.answer).toEqual({ text: 'Ten percent for every order.', by: { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' }, at: '2026-10-23T11:30:00.000Z' });
    expect(read.sides).toEqual(QUESTION.sides);
    expect(log(folder, '%an <%ae>')).toBe('Ada Reader <ada@example.test>');
    expect(log(folder, '%s')).toBe('Answer the question discount-percentage');
    expect(log(folder, '%b')).toContain('local, not verified');
    expect(execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: folder, encoding: 'utf8', env: gitEnv(SEED) })).toContain('docs/questions/discount-percentage.md');
  });

  test('is refused in words: an empty answer, a question that is answered, one that is not there, no git identity', async () => {
    const folder = withQuestion();
    const ask = (slug: string, text: string, e: NodeJS.ProcessEnv): Promise<unknown> => answerQuestion({ productFolder: folder, slug, text, env: e });
    await expect(ask('discount-percentage', '   ', env(PERSON))).rejects.toThrow('the answer is empty');
    await expect(ask('nothing-here', 'x', env(PERSON))).rejects.toThrow('there is no question nothing-here: docs/questions/nothing-here.md is not in the product repository');
    await expect(ask('Bad Slug', 'x', env(PERSON))).rejects.toThrow('no question id');
    await expect(ask('discount-percentage', 'x', env())).rejects.toThrow(/git has no user\.name for .*, so the wiki cannot say who wrote this: run  git config --global user\.name/);
    expect(readFileSync(join(folder, 'docs/questions/discount-percentage.md'), 'utf8')).toBe(renderQuestion(QUESTION));
    await ask('discount-percentage', 'Ten percent.', env(PERSON));
    try {
      await ask('discount-percentage', 'Twelve.', env(PERSON));
      throw new Error('a second answer was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(LoopRefusal);
      expect((error as LoopRefusal).status).toBe(409);
      expect((error as LoopRefusal).message).toContain('already answered (by Ada Reader');
    }
  });

  test('two answers at once make one: the second finds the question answered', async () => {
    const folder = withQuestion();
    const results = await Promise.allSettled([
      answerQuestion({ productFolder: folder, slug: 'discount-percentage', text: 'First.', env: env(PERSON) }),
      answerQuestion({ productFolder: folder, slug: 'discount-percentage', text: 'Second.', env: env(PERSON) }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(parseQuestion('docs/questions/discount-percentage.md', readFileSync(join(folder, 'docs/questions/discount-percentage.md'), 'utf8')).answer!.text).toBe('First.');
  });

  test('a folder that is not a git repository gets the file written and says it was not committed', async () => {
    const folder = scratch();
    mkdirSync(join(folder, 'docs/questions'), { recursive: true });
    writeFileSync(join(folder, 'docs/questions/discount-percentage.md'), renderQuestion(QUESTION));
    const done = await answerQuestion({ productFolder: folder, slug: 'discount-percentage', text: 'Ten percent.', env: env(PERSON) });
    expect(done.committed).toBe(false);
    expect(done.note).toContain('is not a git repository, so the file was written but not committed');
    expect(parseQuestion('docs/questions/discount-percentage.md', readFileSync(join(folder, 'docs/questions/discount-percentage.md'), 'utf8')).status).toBe('answered');
  });

  test('git identity: the author variables win, then the configuration', async () => {
    const folder = product();
    expect(await localIdentity(folder, env(PERSON))).toEqual({ name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' });
    execFileSync('git', ['config', 'user.name', 'Configured'], { cwd: folder, env: gitEnv(SEED) });
    execFileSync('git', ['config', 'user.email', 'configured@example.test'], { cwd: folder, env: gitEnv(SEED) });
    expect((await localIdentity(folder, env())).name).toBe('Configured');
    expect((await localIdentity(folder, env(PERSON))).name).toBe('Ada Reader');
  });

  test('a commit that git refuses is told in the result, with the file still written', async () => {
    const folder = withQuestion();
    writeFileSync(join(folder, '.git/hooks/pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
    const done = await answerQuestion({ productFolder: folder, slug: 'discount-percentage', text: 'Ten percent.', env: env(PERSON) });
    expect(done.committed).toBe(false);
    expect(done.note).toContain('the file was written but git could not commit it');
    expect(done.note).toContain('hook says no');
    const committed = await commitFiles(folder, ['docs/questions/discount-percentage.md'], 'again', done.question.answer!.by, env(PERSON));
    expect(committed.committed).toBe(false);
  });
});

describe('a person corrects a statement', () => {
  function withPage(): string {
    const folder = product();
    mkdirSync(join(folder, 'docs/domains'), { recursive: true });
    writeFileSync(join(folder, 'docs/domains/orders.md'), PAGE);
    execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(SEED) });
    execFileSync('git', ['commit', '-q', '-m', 'a page'], { cwd: folder, env: gitEnv(SEED) });
    return folder;
  }

  test('is a new file with the sentence as it read, the reason and the person, committed as the person', async () => {
    const folder = withPage();
    const done = await recordCorrection({ productFolder: folder, statement: 'domain:orders#ten-percent-discount', reason: 'The discount is whatever the caller passes.\n\nThe README is out of date.', now: () => new Date('2026-10-23T11:45:00Z'), env: env(PERSON) });
    expect(done.committed).toBe(true);
    expect(done.correction.slug).toBe('ten-percent-discount-discount');
    expect(done.correction.file).toBe('docs/corrections/ten-percent-discount-discount.md');
    const read = parseCorrection(done.correction.file, readFileSync(join(folder, done.correction.file), 'utf8'));
    expect(read).toMatchObject({ status: 'open', about: 'domain:orders#ten-percent-discount', statement: 'Orders get a ten percent discount.', by: { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' }, at: '2026-10-23T11:45:00.000Z' });
    expect(read.reason).toBe('The discount is whatever the caller passes.\n\nThe README is out of date.');
    expect(execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: folder, encoding: 'utf8', env: gitEnv(SEED) }).trim()).toBe('Ada Reader <ada@example.test>');
    // Two corrections of one statement are two files.
    const again = await recordCorrection({ productFolder: folder, statement: 'domain:orders#ten-percent-discount', reason: 'The discount is whatever the caller passes.', env: env(PERSON) });
    expect(again.correction.slug).not.toBe(done.correction.slug);
    expect(readCorrections(folder).items).toHaveLength(2);
  });

  test('is refused in words: no reason, a statement the pages do not hold, a shape that is none', async () => {
    const folder = withPage();
    const correct = (statement: string, reason: string): Promise<unknown> => recordCorrection({ productFolder: folder, statement, reason, env: env(PERSON) });
    await expect(correct('domain:orders#ten-percent-discount', ' ')).rejects.toThrow('the correction has no reason');
    await expect(correct('domain:orders#no-such-statement', 'wrong')).rejects.toThrow('the product has no statement domain:orders#no-such-statement');
    await expect(correct('orders', 'wrong')).rejects.toThrow('a page id, a hash and the statement\'s name');
    expect(readCorrections(folder).items).toEqual([]);
  });

  test('is indexed with the questions: kinds question, answer and correction come from their files, with about as relates', async () => {
    const folder = withPage();
    mkdirSync(join(folder, 'docs/questions'), { recursive: true });
    const by = { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' };
    writeFileSync(join(folder, 'docs/questions/discount-percentage.md'), renderQuestion({ ...QUESTION, status: 'answered', answer: { text: 'Ten percent.', by, at: '2026-10-23T11:00:00.000Z' } }));
    writeFileSync(join(folder, 'docs/questions/open-one.md'), renderQuestion({ ...QUESTION, slug: 'open-one' }));
    const tax = await recordCorrection({ productFolder: folder, statement: 'domain:orders#tax-at-checkout', reason: 'Tax is added in the invoice.', env: env(PERSON) });
    expect(tax.correction.id).toBe('correction:tax-checkout-tax-added');
    const { pages, findings } = readKnowledgePages(folder);
    expect(findings).toEqual([]);
    expect(pages.map((page) => `${page.id}|${page.kind}`).sort()).toEqual([
      'answer:discount-percentage|answer', 'correction:tax-checkout-tax-added|correction', 'domain:orders|domain', 'question:discount-percentage|question', 'question:open-one|question',
    ]);
    const question = pages.find((page) => page.id === 'question:open-one')!;
    expect(question.relates).toEqual(['domain:orders', 'domain:orders#ten-percent-discount']);
    expect(question.statements.map((s) => s.id)).toEqual(['readme-says-order-gets', 'code-applies-percentage-caller']);
    expect(question.statements[0]!.grounds).toEqual(['doc:README.md#discounts']);
    const answer = pages.find((page) => page.id === 'answer:discount-percentage')!;
    expect(answer).toMatchObject({ kind: 'answer', producer: 'person', mentions: ['question:discount-percentage'], statements: [] });
    expect(pages.find((page) => page.kind === 'correction')!.relates).toEqual(['domain:orders#tax-at-checkout']);
  });

  test('a rewrite that used an answer or a correction closes it: the file says which pages', async () => {
    const folder = withPage();
    mkdirSync(join(folder, 'docs/questions'), { recursive: true });
    const by = { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' };
    writeFileSync(join(folder, 'docs/questions/discount-percentage.md'), renderQuestion({ ...QUESTION, status: 'answered', answer: { text: 'Ten percent.', by, at: '2026-10-23T11:00:00.000Z' } }));
    const corrected = await recordCorrection({ productFolder: folder, statement: 'domain:orders#tax-at-checkout', reason: 'Tax is added in the invoice.', env: env(PERSON) });
    await markResolved(folder, { kind: 'question', slug: 'discount-percentage', pages: ['domain:orders', 'product:loop-shop'], now: () => new Date('2026-10-23T13:00:00Z') });
    await markResolved(folder, { kind: 'correction', slug: corrected.correction.slug, pages: ['domain:orders'], now: () => new Date('2026-10-23T13:00:00Z') });
    const question = readQuestions(folder).items[0]!;
    expect([question.resolvedBy, question.resolvedAt]).toEqual([['domain:orders', 'product:loop-shop'], '2026-10-23T13:00:00.000Z']);
    expect(question.answer!.text).toBe('Ten percent.');
    expect(rowOf(question).state).toBe('closed');
    expect(readCorrections(folder).items[0]).toMatchObject({ status: 'applied', resolvedBy: ['domain:orders'] });
    expect(renderCorrection(readCorrections(folder).items[0]!)).toBe(readFileSync(join(folder, corrected.correction.file), 'utf8'));
  });
});

describe('a product made before the loop gets its two kinds', () => {
  test('the manifest gains question and correction with their templates, its comments kept, and a second call changes nothing', () => {
    const folder = product();
    const manifest = join(folder, 'madarch/kinds.yaml');
    const before = readFileSync(manifest, 'utf8');
    // What the draft's manifest declares about its documents, said by name: the general kind and the headings each
    // document kind is read by, and the four kinds `documents.expect` holds it to (madarch-ztyq.3).
    const drafted = readKinds(folder);
    if (!drafted.present) throw new Error('absent');
    expect(drafted.manifest.expect?.map((entry) => entry.kind)).toEqual(['doc.use-case', 'doc.rule', 'doc.requirement', 'doc.decision']);
    expect(drafted.manifest.kinds.get('doc.use-case')).toMatchObject({ semantics: 'scenario', headings: ['Use cases'] });
    expect(drafted.manifest.kinds.get('doc.rule')).toMatchObject({ semantics: 'rule', headings: ['Business rules'] });
    expect(drafted.manifest.kinds.get('doc.requirement')).toMatchObject({ semantics: 'quality', headings: ['Qualities', 'Non-functional requirements'] });
    expect(drafted.manifest.kinds.get('doc.decision')).toMatchObject({ semantics: 'decision', structure: ['Status', 'Context', 'Decision', 'Consequences'] });
    expect(drafted.manifest.findings).toEqual([]);
    // A product made before the loop declares neither the document kinds nor the expectation: an expectation whose kinds
    // are not declared is a finding of its own, so the two go together here, as an older manifest has neither.
    const old = before
      .replace(/  question:[\s\S]*?  code\.service:/, '  code.service:')
      .replace(/^  expect: \[[^\]]*\]\n/m, '');
    expect(old).not.toContain('question:');
    expect(old).not.toContain('expect: [');
    writeFileSync(manifest, old);
    rmSync(join(folder, 'templates/question.md'));
    rmSync(join(folder, 'templates/correction.md'));
    const added = ensureLoopKinds(folder);
    expect(added.sort()).toEqual(['madarch/kinds.yaml', 'templates/correction.md', 'templates/question.md']);
    const read = readKinds(folder);
    if (!read.present) throw new Error('absent');
    expect(read.manifest.findings).toEqual([]);
    expect(read.manifest.kinds.get('question')).toMatchObject({ folder: 'docs/questions', source: 'markdown' });
    expect(read.manifest.kinds.get('correction')).toMatchObject({ folder: 'docs/corrections' });
    expect(readFileSync(manifest, 'utf8')).toContain('# The kinds this product');
    expect(ensureLoopKinds(folder)).toEqual([]);
  });

  test('a manifest that cannot be read is an error naming the file and the line, not a silent skip', () => {
    const folder = product();
    writeFileSync(join(folder, 'madarch/kinds.yaml'), 'kinds:\n  product: [unclosed\n');
    expect(() => ensureLoopKinds(folder)).toThrow(/madarch\/kinds\.yaml:\d+: the manifest cannot be read/);
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

  test('a corrections folder or a question that is a link out of the product is not written through', async () => {
    const folder = product();
    const outside = scratch();
    mkdirSync(join(folder, 'docs'), { recursive: true });
    writeFileSync(join(outside, 'discount-percentage.md'), renderQuestion(QUESTION));
    symlinkSync(outside, join(folder, 'docs/questions'));
    await expect(answerQuestion({ productFolder: folder, slug: 'discount-percentage', text: 'Ten.', env: env(PERSON) })).rejects.toThrow(/is a link to .*, outside the product/);
    expect(readFileSync(join(outside, 'discount-percentage.md'), 'utf8')).toBe(renderQuestion(QUESTION));
  });

  test('two corrections at once, worded alike, are two files', async () => {
    const folder = product();
    mkdirSync(join(folder, 'docs/domains'), { recursive: true });
    writeFileSync(join(folder, 'docs/domains/orders.md'), PAGE);
    const both = await Promise.all([1, 2, 3].map(() => recordCorrection({ productFolder: folder, statement: 'domain:orders#tax-at-checkout', reason: 'Tax is added in the invoice.', env: env(PERSON) })));
    expect(new Set(both.map((done) => done.correction.slug)).size).toBe(3);
    expect(readCorrections(folder).items).toHaveLength(3);
  });

  test('the notes an answer closes are the ones the prompt carries, within its budget', () => {
    const note = (slug: string): ChangeNote => ({ kind: 'answer', question: slug, title: slug, answer: 'x'.repeat(2900), by: 'Ada', at: '2026-10-23T11:00:00.000Z', sides: [] });
    const notes = Array.from({ length: 20 }, (_, i) => note(`q${i}`));
    const shown = includedNotes({ current: 'page', notes, omitted: 0 });
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(20);
    expect(shown.length * 2900).toBeLessThanOrEqual(NOTES_CHARACTERS);
  });

  test('a product page that links a domain with no page makes the domain missing and the product page an edit', () => {
    const product = { id: 'product:shop', kind: 'product', title: 'Shop', file: 'docs/product.md', relates: [], sources: [], writtenAt: [], producer: 'agent', statements: [], mentions: ['domain:orders', 'domain:shipping'], digest: 'd' };
    const orders = { ...product, id: 'domain:orders', kind: 'domain', file: 'docs/domains/orders.md', mentions: [] };
    const plan = decide({ pages: [product, orders], grounds: [], questions: [], corrections: [], newServices: [], language: { from: 'en', to: 'en', changed: false } });
    expect(plan.pages.map((p) => [p.path, p.reasons.map((r) => r.kind)])).toEqual([['docs/domains/shipping.md', ['missing']], ['docs/product.md', ['missing-domain']]]);
  });
});
