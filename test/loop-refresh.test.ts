/**
 * The loop that closes the wiki, end to end over a small generated repository
 * (madarch-m38l.7): the agent asks a question while it writes, a person
 * answers it in the wiki, the next refresh edits only the page the answer
 * touches and the question shows as closed by that rewrite; a changed ground
 * touches only the page that stands on it; a new language translates every
 * page. The agent is a script that reaches the graph only through the
 * writer's tools; the assertions judge what the core accepted and wrote.
 * Fixtures only: the repository and the product are made in a scratch folder.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS } from '../src/extract/driver/extractors.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { indexCounts, indexWorkerProduct, statementsRelyingOn } from '../src/knowledge/index/index.js';
import { answerQuestion, markResolved } from '../src/loop/answer.js';
import { readCorrections, readQuestions, renderCorrection, renderQuestion } from '../src/loop/entities.js';
import { applyReset, planReset } from '../src/knowledge/reset.js';
import { briefsFor, neededFrom, planRefresh } from '../src/loop/plan.js';
import { listProblems, listQuestions } from '../src/loop/views.js';
import { createDraft } from '../src/product/draft.js';
import { DEFAULT_UNIT_BOUNDS, GraphView, UnitTools, memorySink, runWriter, type ToolAnswer, type UnitAgent, type UnitRequest, type WriterReport } from '../src/writer/index.js';
import { slugOf } from '../src/writer/names.js';
import { gitEnv } from './git-env.js';

const README = `# Shop

## Overview

The shop prices and ships orders.

## Discounts

Every order gets a ten percent discount.

## Tax

Tax is a flat five percent.
`;
const PRICING = `export function discountFor(percent: number): number {
  return percent;
}

export function taxRate(): number {
  return 8;
}
`;
const REPOSITORY_NAME = 'shop-code';
const PERSON = { GIT_AUTHOR_NAME: 'Ada Reader', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Reader', GIT_COMMITTER_EMAIL: 'ada@example.test' };
const SEED = { GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 'seed@example.test', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 'seed@example.test' };
const dates = { next: '2020-01-01T10:00:00Z' };

let scratch: string;
let repository: string;
let productFolder: string;
let owner: DatabaseOwner;
let store: GraphStore;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', env: gitEnv({ ...SEED, GIT_AUTHOR_DATE: dates.next, GIT_COMMITTER_DATE: dates.next }) }).trim();
}

async function fill(): Promise<void> {
  await fillGraph({ owner, store, repository, extractors: TREE_EXTRACTORS, owners: OWNERS, history: HISTORY_EXTRACTOR, snapshots: {} });
}

async function keyOf(like: string): Promise<string> {
  const rows = (await owner.run((tx) => tx.query<{ key: string }>(`SELECT DISTINCT properties->>'recordKey' AS key FROM node_version WHERE properties->>'recordKey' LIKE $1 ORDER BY 1`, [like]))).rows;
  if (rows.length === 0) throw new Error(`the graph holds no key like ${like}`);
  return rows[0]!.key;
}

const read = (relative: string): string => readFileSync(path.join(productFolder, relative), 'utf8');

/** The index as the fill worker keeps it: after every page the writer writes. */
const afterWrite = async (): Promise<void> => { await indexWorkerProduct({ owner, store, productFolder, productId: 'loop-shop', repository: { name: REPOSITORY_NAME, path: repository } }); };

/** The problems a refused question lists, one per line. */
const problemsOf = (answer: unknown): string => ((answer as { error: { problems: string[] } }).error.problems).join('\n');

const call = async (request: UnitRequest, tool: string, args: Record<string, unknown>): Promise<ToolAnswer> => await request.tools.call(tool, args);

/** Runs the writer as the fill worker does: the plan decides which pages get a unit. */
async function refresh(agent: UnitAgent, language: { from: string | null; to: string; changed: boolean } = { from: 'en', to: 'en', changed: false }): Promise<{ report: WriterReport; plan: Awaited<ReturnType<typeof planRefresh>> }> {
  const head = git('rev-parse', 'HEAD');
  const planned = await planRefresh({ owner, productFolder, repository: { name: REPOSITORY_NAME, path: repository }, commit: head, language });
  const briefs = await briefsFor(planned);
  const report = await runWriter({
    owner, store, repository, output: productFolder, productName: 'Loop shop', agent, language: language.to, languageChanged: language.changed, repositoryName: REPOSITORY_NAME,
    needed: neededFrom(planned, briefs), resolved: async (used) => { await markResolved(productFolder, used); }, afterWrite,
  });
  return { report, plan: planned };
}

beforeAll(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), 'madarch-loop-refresh-'));
  repository = path.join(scratch, REPOSITORY_NAME);
  mkdirSync(path.join(repository, 'src'), { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repository, 'README.md'), README);
  writeFileSync(path.join(repository, 'src/pricing.ts'), PRICING);
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  const draft = createDraft({ home: path.join(scratch, 'home'), name: 'loop-shop', gitEnv: gitEnv(SEED) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  productFolder = draft.folder;
  owner = createPGliteDatabaseOwner({ btreeGist: true, path: path.join(scratch, 'store') });
  store = createGraphStore(owner);
  await owner.ready;
  await store.createSchema();
  await fill();
}, 300_000);

afterAll(async () => {
  await owner?.close();
  rmSync(scratch, { recursive: true, force: true });
}, 60_000);

const QUESTION_TITLE = 'Which discount does an order get?';
const QUESTION_SLUG = slugOf(QUESTION_TITLE);

/** The grounds the pricing page stands on: the README's sections and the one file the pricing lives in. */
const README_OVERVIEW = 'doc:README.md#overview';
const README_DISCOUNTS = 'doc:README.md#discounts';
const README_TAX = 'doc:README.md#tax';
const PRICING_FILE = 'code.file:src/pricing.ts';

/** The rule the discount decision turns into, once a person answered the question, as the page states it. */
const DECIDED_RULE = 'Every order gets ten percent, as a person decided.';

/**
 * The fields of the pricing page (madarch-ztyq.6): the business over the README and the one file the pricing lives
 * in, and the function the discount comes from in "developer", where a place of the code belongs. An open
 * contradiction keeps both of its sides: the README's promise stands in "what can go wrong" and the code's rule is
 * the domain's one developer note. `tax` is what the README's tax section says, and `answered` the slug of the
 * question a person answered, whose rule the page then states on that answer.
 */
function pricingFields(options: { readonly discountKey: string; readonly tax?: string; readonly answered?: string }): Record<string, unknown> {
  const rules: Record<string, unknown>[] = [{ text: options.tax ?? 'Tax is a flat five percent.', grounds: [README_TAX] }];
  if (options.answered !== undefined) rules.push({ text: DECIDED_RULE, grounds: [`question:${options.answered}`, README_DISCOUNTS] });
  return {
    title: 'Pricing',
    participants: [{ text: 'A shopper buys from the shop and is charged the price the pricing rules give.', grounds: [README_OVERVIEW] }],
    mainScenario: [{ text: 'The shop prices the order lines, takes the discount off them and adds the tax.', grounds: [README_OVERVIEW] }],
    rules,
    whatCanGoWrong: [{ text: 'The README promises a discount the code does not apply.', grounds: [README_DISCOUNTS] }],
    openPoints: [{ text: 'The pricing of an order lives in one file of the shop.', grounds: [PRICING_FILE] }],
    developer: { notes: [{ text: 'The discount function applies the percentage its caller passes and chooses none of its own.', grounds: [options.discountKey] }] },
  };
}

/** The fields of the pricing page in Russian: the same sections, the same grounds and the same place of the code. */
function pricingFieldsRu(discountKey: string): Record<string, unknown> {
  return {
    title: 'Цены',
    participants: [{ text: 'Покупатель покупает в магазине и платит цену, которую дают правила ценообразования.', grounds: [README_OVERVIEW] }],
    mainScenario: [{ text: 'Магазин считает цены строк заказа, вычитает скидку и добавляет налог.', grounds: [README_OVERVIEW] }],
    // The README the earlier cases left behind may no longer hold the tax section: the rule stands on the section
    // that is there, so the page of the translation is written and not refused on a ground a test removed.
    rules: [{ text: 'Налог плоский, восемь процентов.', grounds: [readFileSync(path.join(repository, 'README.md'), 'utf8').includes('## Tax') ? README_TAX : README_OVERVIEW] }],
    whatCanGoWrong: [{ text: 'README обещает скидку, которой код не применяет.', grounds: [README_DISCOUNTS] }],
    openPoints: [{ text: 'Цены живут в одном файле.', grounds: [PRICING_FILE] }],
    developer: { notes: [{ text: 'Функция скидки применяет процент, который передал вызывающий.', grounds: [discountKey] }] },
  };
}

describe('the loop, from the first question to a translation', () => {
  let discountKey: string;
  const prompts = new Map<string, string>();
  const seen: string[] = [];

  test('the agent asks a question where the README and the code disagree, and still writes its pages', async () => {
    discountKey = await keyOf('code.symbol\u003asrc/pricing.ts#discountFor');
    const agent: UnitAgent = {
      run: async (request) => {
        seen.push(request.id);
        prompts.set(`first:${request.id}`, request.prompt);
        if (request.id.startsWith('product:')) {
          const written = await call(request, 'write_page', {
            markdown: [
              '---', 'id: product:loop-shop', 'kind: product', 'title: Loop shop', 'relates:', '  - code.file\u003asrc/pricing.ts', 'producer: agent', 'sources: [README.md]', '---', '',
              '## What it is', '', 'The shop prices and ships orders.[^shop-prices-ships-orders]', '',
              '## Domains', '', '- [Pricing](madarch:domain:pricing) covers discounts and tax.[^pricing-covers-discounts-tax]', '',
              '[^shop-prices-ships-orders]: [README](madarch:doc:README.md#overview)',
              '[^pricing-covers-discounts-tax]: [pricing](madarch:code.file\u003asrc/pricing.ts)',
            ].join('\n'),
            domains: [{ slug: 'pricing', title: 'Pricing', summary: 'How an order is priced.', evidence: ['code.file\u003asrc/pricing.ts'] }],
          });
          expect(written.isError).toBe(false);
          return;
        }
        // A question with a ground that is not there, then the question as it should be asked.
        const refused = await call(request, 'ask_question', { type: 'contradiction', title: QUESTION_TITLE, question: 'Which is true?', why: 'A shopper is told one number and charged another.', sides: [{ claim: 'The README says so.', grounds: ['doc:README.md#nowhere'] }, { claim: 'The code differs.', grounds: [discountKey] }] });
        expect(refused.isError).toBe(true);
        expect(problemsOf(refused.answer)).toContain('sides[0].grounds "doc:README.md#nowhere" does not resolve in the graph at the last filled commit: the document README.md has no section "nowhere"');
        const oneSided = await call(request, 'ask_question', { type: 'contradiction', title: QUESTION_TITLE, question: 'Which is true?', why: 'Why.', sides: [{ claim: 'Only one side.', grounds: [discountKey] }] });
        expect(JSON.stringify(oneSided.answer)).toContain('a contradiction has at least two sides');
        const asked = await call(request, 'ask_question', {
          type: 'contradiction', title: QUESTION_TITLE, question: 'The README gives every order the same discount; the code applies whatever percentage its caller passes. Which does the shop mean?',
          why: 'A shopper is told one number and may be charged another.',
          sides: [{ claim: 'The README says every order gets a ten percent discount.', grounds: ['doc:README.md#discounts'] }, { claim: 'The code applies the percentage its caller passes.', grounds: [discountKey] }],
        });
        expect(asked.isError).toBe(false);
        expect(asked.answer).toMatchObject({ asked: true, id: `question:${QUESTION_SLUG}`, path: `docs/questions/${QUESTION_SLUG}.md` });
        const twice = await call(request, 'ask_question', { type: 'contradiction', title: QUESTION_TITLE, question: 'Which discount rule should the shop follow?', why: 'The same sources disagree about the discount.', sides: [{ claim: 'The code applies the percentage its caller passes.', grounds: [discountKey] }, { claim: 'The README says every order gets a ten percent discount.', grounds: ['doc:README.md#discounts'] }], comparison: [{ id: `question:${QUESTION_SLUG}`, same: true, reason: 'The scripted ask repeats the same README-versus-caller discount decision.' }] });
        // The same subject is asked once (madarch-m38l.13): this page is added to the question that exists.
        expect(twice.isError, JSON.stringify(twice.answer)).toBe(false);
        expect(twice.answer).toMatchObject({ asked: false, merged: true, id: `question:${QUESTION_SLUG}` });
        // The page is the business over the README, and the code's rule stands in its one section for the developer.
        const written = await call(request, 'write_page', { fields: pricingFields({ discountKey }) });
        expect(written.isError, JSON.stringify(written.answer)).toBe(false);
      },
    };
    const { report, plan } = await refresh(agent);
    expect(plan.plan.pages.map((p) => [p.path, p.reasons.map((r) => r.kind)])).toEqual([['docs/product.md', ['missing']]]);
    expect({ ok: report.ok, product: report.product.refusals, domains: report.domains.map((d) => d.refusals) }).toEqual({ ok: true, product: [], domains: [[]] });
    expect(report.units).toBe(2);
    expect(seen).toEqual(['product:loop-shop', 'domain:pricing']);
    expect(report.questions).toEqual([`question:${QUESTION_SLUG}`]);
    expect(report.domains[0]!.questions).toEqual([`question:${QUESTION_SLUG}`]);
    // The prompt tells the unit to look for disagreement and to ask.
    expect(prompts.get('first:domain:pricing')).toContain('## Look for disagreement, and ask');
    expect(prompts.get('first:domain:pricing')).toContain('Read the root README.md and the README of each service');
    const [question] = readQuestions(productFolder).items;
    expect(question).toMatchObject({ slug: QUESTION_SLUG, status: 'open', type: 'contradiction', askedIn: 'domain:pricing' });
    expect(question!.about).toEqual(['domain:pricing']);
    expect(question!.sides.map((side) => side.grounds)).toEqual([['doc:README.md#discounts'], [discountKey]]);
    expect(question!.writtenAt).toHaveLength(1);
    // The question is in the graph beside the pages: kind question with two statements, grounded on the README and the code.
    // The domain page holds the five sections the unit filled and its one note for the developer, one statement each.
    expect(await indexCounts(owner)).toEqual([{ kind: 'domain', pages: 1, statements: 6 }, { kind: 'product', pages: 1, statements: 2 }, { kind: 'question', pages: 1, statements: 2 }]);
    expect((await statementsRelyingOn(owner, discountKey)).map((s) => `${s.pageKind}:${s.page}`)).toEqual(['domain:domain:pricing', `question:question:${QUESTION_SLUG}`]);
    expect(listQuestions(productFolder)).toMatchObject({ open: 1, answered: 0, closed: 0 });
  }, 300_000);

  test('nothing changed: a refresh costs no agent run', async () => {
    const agent: UnitAgent = { run: async (request) => { throw new Error(`a unit ran for ${request.id}`); } };
    const { report, plan } = await refresh(agent);
    expect(plan.plan.pages).toEqual([]);
    expect(plan.plan.unchanged).toEqual(['docs/domains/pricing.md', 'docs/product.md']);
    expect(report.units).toBe(0);
    expect(report.ok).toBe(true);
  }, 120_000);

  test('a person answers in the wiki; the next refresh edits only the page the answer touches, grounded in the answer, and the question closes', async () => {
    const answered = await answerQuestion({ productFolder, slug: QUESTION_SLUG, text: 'Every order gets ten percent. The caller always passes ten.', now: () => new Date('2020-01-02T09:00:00Z'), env: { ...gitEnv(PERSON), HOME: '/nonexistent' } });
    expect(answered.committed).toBe(true);
    expect(execFileSync('git', ['log', '-1', '--format=%an <%ae>|%s'], { cwd: productFolder, encoding: 'utf8', env: gitEnv(SEED) }).trim()).toBe(`Ada Reader <ada@example.test>|Answer the question ${QUESTION_SLUG}`);
    const productBefore = read('docs/product.md');
    const productStat = statSync(path.join(productFolder, 'docs/product.md')).mtimeMs;
    const pricingBefore = read('docs/domains/pricing.md');
    seen.length = 0;
    const agent: UnitAgent = {
      run: async (request) => {
        seen.push(request.id);
        prompts.set(`answer:${request.id}`, request.prompt);
        // The page keeps its sentences word for word and stands one more rule on the answer a person gave.
        const fields = pricingFields({ discountKey, answered: QUESTION_SLUG });
        // A question that is not answered, or not asked, is no ground.
        const bad = await call(request, 'write_page', { fields: pricingFields({ discountKey, answered: 'never-asked' }) });
        expect(bad.isError).toBe(true);
        expect(JSON.stringify(bad.answer)).toContain('is no answered question and no correction of this product');
        const good = await call(request, 'write_page', { fields });
        expect(good.isError).toBe(false);
      },
    };
    const { report, plan } = await refresh(agent);
    expect(plan.plan.pages).toEqual([{ id: 'domain:pricing', path: 'docs/domains/pricing.md', reasons: [{ kind: 'answer', question: QUESTION_SLUG, title: QUESTION_TITLE }] }]);
    expect(seen).toEqual(['domain:pricing']);
    expect(report.units).toBe(1);
    expect(report.ok).toBe(true);
    // The unit was handed the page as it stood and the answer, and told to edit.
    const prompt = prompts.get(`answer:domain:pricing`)!;
    expect(prompt).toContain('## You are editing a page that exists');
    expect(prompt).toContain('Keep word for word every sentence, and its footnote name, whose grounds are not named in the changes below');
    expect(prompt).toContain(`A person ANSWERED your question "${QUESTION_TITLE}" (madarch:question:${QUESTION_SLUG}), Ada Reader <ada@example.test>`);
    expect(prompt).toContain('Every order gets ten percent. The caller always passes ten.');
    expect(prompt).toContain('local, not verified');
    expect(prompt).toContain('## The page as it stands');
    expect(prompt).toContain('Tax is a flat five percent.');
    expect(prompt).toContain('## Questions already asked about this page');
    // The product page was not touched at all, and the sentences that stand kept their names.
    expect(read('docs/product.md')).toBe(productBefore);
    expect(statSync(path.join(productFolder, 'docs/product.md')).mtimeMs).toBe(productStat);
    const pricing = read('docs/domains/pricing.md');
    // The sentences the page stood keep their words and their footnote names: the whole line is the same in both.
    const lineOf = (markdown: string, sentence: string): string | undefined => markdown.split('\n').find((line) => line.includes(sentence));
    for (const kept of ['Tax is a flat five percent.', 'The pricing of an order lives in one file of the shop.']) {
      expect(lineOf(pricingBefore, kept)).toBeDefined();
      expect(lineOf(pricing, kept)).toBe(lineOf(pricingBefore, kept));
    }
    // The rule the answer settles stands on the answer, and the page says so with a link to it.
    expect(pricing).toContain(DECIDED_RULE);
    expect(pricing).toContain(`(madarch:question:${QUESTION_SLUG})`);
    // The question shows as closed by the rewrite, and the index says what stands on the answer.
    const [question] = readQuestions(productFolder).items;
    expect(question).toMatchObject({ status: 'answered', resolvedBy: ['domain:pricing'] });
    expect(listQuestions(productFolder)).toMatchObject({ open: 0, answered: 0, closed: 1 });
    expect((await statementsRelyingOn(owner, `question:${QUESTION_SLUG}`)).map((s) => `${s.page}#${s.statement}`)).toEqual(['domain:pricing#order-gets-ten-percent']);
    const kinds = await indexCounts(owner);
    expect(kinds.map((k) => k.kind)).toEqual(['answer', 'domain', 'product', 'question']);
    // The very next refresh has nothing left to do.
    const again = await refresh({ run: async (request) => { throw new Error(`a unit ran for ${request.id}`); } });
    expect(again.plan.plan.pages).toEqual([]);
  }, 300_000);

  test('a changed ground touches only the page that stands on it, with the old and the new text in front of the unit', async () => {
    writeFileSync(path.join(repository, 'README.md'), README.replace('Tax is a flat five percent.', 'Tax is a flat eight percent.'));
    dates.next = '2020-01-03T10:00:00Z';
    git('add', '-A');
    git('commit', '-q', '-m', 'second');
    await fill();
    await afterWrite();
    seen.length = 0;
    const agent: UnitAgent = {
      run: async (request) => {
        seen.push(request.id);
        prompts.set(`ground:${request.id}`, request.prompt);
        // The tax sentence now says what the README says; the rest of the page stands, the answered rule included.
        const written = await call(request, 'write_page', { fields: pricingFields({ discountKey, tax: 'Tax is a flat eight percent.', answered: QUESTION_SLUG }) });
        expect(written.isError).toBe(false);
      },
    };
    const { report, plan } = await refresh(agent);
    // The statement as it stands on the page before the change: the plan names what the ground reached.
    expect(plan.plan.pages.map((p) => [p.path, p.reasons])).toEqual([['docs/domains/pricing.md', [{ kind: 'ground-changed', statement: slugOf('Tax is a flat five percent.'), ground: 'doc:README.md#tax' }]]]);
    expect(seen).toEqual(['domain:pricing']);
    expect(report.units).toBe(1);
    const prompt = prompts.get('ground:domain:pricing')!;
    expect(prompt).toContain('The ground doc:README.md#tax CHANGED. The statement [^tax-flat-five-percent] stands on it: "Tax is a flat five percent."');
    expect(prompt).toMatch(/Before:\n~~~\n## Tax\n\nTax is a flat five percent\.\n~~~/);
    expect(prompt).toMatch(/Now:\n~~~\n## Tax\n\nTax is a flat eight percent\.\n~~~/);
    expect(read('docs/domains/pricing.md')).toContain('Tax is a flat eight percent.');
    // The page was written from the new commit, so its grounds read as unchanged again and the question stays closed.
    const next = await refresh({ run: async (request) => { throw new Error(`a unit ran for ${request.id}`); } });
    expect(next.plan.plan.pages).toEqual([]);
    expect(listQuestions(productFolder).closed).toBe(1);
  }, 300_000);

  test('a ground that is gone is a problem the agent fixes, told in the problems list with who fixes it', async () => {
    writeFileSync(path.join(repository, 'README.md'), README.replace('Tax is a flat five percent.', 'Tax is a flat eight percent.').replace('## Tax\n\nTax is a flat eight percent.\n', ''));
    dates.next = '2020-01-04T10:00:00Z';
    git('add', '-A');
    git('commit', '-q', '-m', 'third');
    await fill();
    await afterWrite();
    const head = git('rev-parse', 'HEAD');
    const listing = await listProblems({
      productFolder, owner, repository: { name: REPOSITORY_NAME, path: repository, commit: head }, findings: [],
      resolve: async (url) => ({ state: 'ok', target: url, kind: 'document', label: url, href: null }),
    });
    const removed = listing.problems.filter((p) => p.kind === 'ground-removed');
    expect(removed.map((p) => [p.page, p.statement, p.target, p.fixer, p.file])).toEqual([['domain:pricing', slugOf('Tax is a flat eight percent.'), 'doc:README.md#tax', 'agent', 'docs/domains/pricing.md']]);
    expect(removed[0]!.sentence).toBe('Tax is a flat eight percent.');
    const { plan } = await refresh({ run: async () => undefined });
    expect(plan.plan.pages.map((p) => [p.path, p.reasons.map((r) => r.kind)])).toEqual([['docs/domains/pricing.md', ['ground-removed']]]);
  }, 300_000);

  test('a passage no reader decided is a problem the agent fixes, and it names both the identity and the file on this machine', async () => {
    // A document finding carries the kind a reader acts on and the file's place on disk (madarch-ztyq.3, the review of
    // finding 8): the Problems page must show both, so a person can open the file and know which passage it is about.
    const listing = await listProblems({
      productFolder, owner, findings: [
        { file: 'repos/training/docs/notes.md', line: 4, message: 'no kind of the manifest and no classifier read this passage, so no page shows it: «Rows are read in the order they were written»', kind: 'unread-passage', source: '/srv/checkouts/training/docs/notes.md' },
        { file: 'docs/domains/pricing.md', line: 2, message: 'the file cannot be read', source: '/srv/products/shop/docs/domains/pricing.md' },
      ],
      resolve: async (url) => ({ state: 'ok', target: url, kind: 'document', label: url, href: null }),
    });
    const byFile = new Map(listing.problems.map((problem) => [problem.file, problem]));
    expect(byFile.get('repos/training/docs/notes.md')).toMatchObject({ kind: 'unread-passage', fixer: 'agent', line: 4, source: '/srv/checkouts/training/docs/notes.md' });
    expect(byFile.get('docs/domains/pricing.md')).toMatchObject({ kind: 'unreadable-file', fixer: 'person', line: 2, source: '/srv/products/shop/docs/domains/pricing.md' });
  }, 120_000);

  test('a change of language is a translation of every page, with the page in front of the unit and the names kept', async () => {
    seen.length = 0;
    // The product page is Markdown, as its unit writes it; the domain page is the fields of its six sections.
    const russianProduct = [
      '---', 'id: product:loop-shop', 'kind: product', 'title: Магазин', 'relates:', '  - code.file\u003asrc/pricing.ts', 'producer: agent', 'sources: [README.md]', '---', '',
      '## Что это', '', 'Магазин считает цены и отправляет заказы.[^shop-prices-ships-orders]', '',
      '## Домены', '', '- [Цены](madarch:domain:pricing) отвечают за скидки и налог.[^pricing-covers-discounts-tax]', '',
      '[^shop-prices-ships-orders]: [README](madarch:doc:README.md#overview)',
      '[^pricing-covers-discounts-tax]: [pricing](madarch:code.file\u003asrc/pricing.ts)',
    ].join('\n');
    // The answers are collected and judged after the run: an assertion thrown inside the agent is caught by the
    // writer and shown as a failed unit, which would hide the refusal that caused it.
    const answers: string[] = [];
    const agent: UnitAgent = {
      run: async (request) => {
        seen.push(request.id);
        prompts.set(`ru:${request.id}`, request.prompt);
        const written = await call(request, 'write_page', request.id.startsWith('product:')
          ? { markdown: russianProduct, domains: [{ slug: 'pricing', title: 'Цены', summary: 'Как считается цена заказа.', evidence: ['code.file\u003asrc/pricing.ts'] }] }
          : { fields: pricingFieldsRu(discountKey) });
        answers.push(`${request.id}: ${JSON.stringify(written.answer)}`);
      },
    };
    const { report, plan } = await refresh(agent, { from: 'en', to: 'ru', changed: true });
    const outcomeOf = (unit: string) => report.graph.flatMap((kind) => kind.units).find((held) => held.unit === unit);
    // The writer catches what an agent throws and shows it as the unit's failure: assert the unit's own outcome so
    // the reason is in the message, never swallowed.
    expect(outcomeOf('domain:pricing')?.status, JSON.stringify(outcomeOf('domain:pricing'))).toBe('written');
    expect(answers, `the ru run asked two units`).toHaveLength(2);
    expect(answers.filter((answer) => answer.includes('refused')), answers.join('\n')).toEqual([]);
    expect(answers.filter((answer) => answer.includes('"written":true')), answers.join('\n')).toHaveLength(2);
    expect(plan.plan.languageChanged).toBe(true);
    expect(plan.plan.pages.map((p) => p.path)).toEqual(['docs/domains/pricing.md', 'docs/product.md']);
    expect(seen).toEqual(['product:loop-shop', 'domain:pricing']);
    expect(report.units).toBe(2);
    for (const id of ['product:loop-shop', 'domain:pricing']) {
      const prompt = prompts.get(`ru:${id}`)!;
      expect(prompt).toContain('Translate it into Russian, sentence for sentence. Keep every footnote name, every footnote line (the grounds) and every link target exactly as they are');
      expect(prompt).toContain('The pages are now written in ru, not en: translate this page.');
      expect(prompt).toContain('## The page as it stands');
    }
    expect(read('docs/domains/pricing.md')).toContain('Цены живут в одном файле.');
    expect(prompts.get('ru:product:loop-shop')).toContain('The domains the page declares now');
  }, 300_000);
});

describe('the question tool is bounded and checks what it is given', () => {
  async function session(): Promise<{ tools: UnitTools; sink: ReturnType<typeof memorySink> }> {
    const view = await GraphView.open(owner, store);
    const sink = memorySink();
    const tools = new UnitTools(view, { kind: 'domain', id: 'domain:pricing', path: 'docs/domains/pricing.md', domain: { slug: 'pricing', title: 'Pricing', summary: 'Pricing.', evidence: ['code.file\u003asrc/pricing.ts'] }, productId: 'product:loop-shop' }, sink, [{ slug: 'pricing', title: 'Pricing', summary: 'Pricing.', evidence: ['code.file\u003asrc/pricing.ts'] }], DEFAULT_UNIT_BOUNDS, []);
    return { tools, sink };
  }
  const good = (title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'gap', title, question: 'What is meant?', why: 'A reader cannot tell.', sides: [{ claim: 'The README is silent.', grounds: ['doc:README.md#discounts'] }], ...extra,
  });

  test('at most six questions per unit, each saved as a file of the product; the seventh is refused in words', async () => {
    const { tools, sink } = await session();
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    const comparison = (previous: readonly string[]) => previous.map((word) => ({ id: `question:${slugOf(`Question about ${word}`)}`, same: false, reason: 'Each fixture word names a distinct authored decision for the per-unit bound.' }));
    for (const [index, word] of words.entries()) expect((await tools.call('ask_question', good(`Question about ${word}`, { question: `Which policy applies to ${word}?`, comparison: comparison(words.slice(0, index)) }))).isError).toBe(false);
    const seventh = await tools.call('ask_question', good('Question about golf', { question: 'Which policy applies to golf?', comparison: comparison(words) }));
    expect(seventh.isError).toBe(true);
    expect(JSON.stringify(seventh.answer)).toContain('this unit asked its 6 new questions; reuse existing decisions or write your page with what you know');
    expect([...sink.pages.keys()]).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((word) => `docs/questions/${slugOf(`Question about ${word}`)}.md`));
    expect(tools.outcome().questions).toHaveLength(6);
    expect(tools.finished).toBe(false);
  });

  test('every problem is listed at once, with what is wrong', async () => {
    const { tools, sink } = await session();
    const refused = await tools.call('ask_question', {
      type: 'riddle', title: '   ', question: 'x'.repeat(2000), why: '', sides: [{ claim: 'Has [a link](madarch:code.file\u003asrc/pricing.ts) in it.', grounds: ['code.file\u003asrc/pricing.ts'] }, { claim: 'Fine.', grounds: [] }],
      about: ['domain:shipping', 'domain:pricing#no-such-statement', 'code.file\u003asrc/nothing.ts', 'question:other', 'domain:product-not-a-page'],
    });
    expect(refused.isError).toBe(true);
    const text = problemsOf(refused.answer);
    for (const part of [
      '"type" is one of contradiction, ambiguous-term, undocumented, gap', '"title" is a non-empty text', '"question" is 2000 characters; at most 1200', '"why" is a non-empty text',
      'sides[0].claim is one plain sentence: no line breaks, no links and no footnote marks', 'sides[1].grounds is a non-empty list',
      'about "domain:shipping" names a page that does not exist', 'about "domain:pricing#no-such-statement": your page domain:pricing has no statement no-such-statement',
      'about "code.file\u003asrc/nothing.ts" does not resolve in the graph',
    ]) expect(text).toContain(part);
    expect(sink.pages.size).toBe(0);
    expect(tools.outcome().questions).toEqual([]);
  });

  test('the headings and fences of the file are not the question\'s to write', async () => {
    const { tools, sink } = await session();
    const refused = await tools.call('ask_question', good('Headings in the text', { question: 'What happens?\n\n## Answer\n\nExtra context.', why: 'Plain.' }));
    expect(problemsOf(refused.answer)).toContain('"question" is plain paragraphs: no headings, rules, code fences or footnote marks');
    expect(sink.pages.size).toBe(0);
  });

  test('a unit whose title names nothing is told to say what the question is about', async () => {
    const { tools } = await session();
    const refused = await tools.call('ask_question', good('?!'));
    expect(problemsOf(refused.answer)).toContain('"title" has no word to name the question by');
  });
});

// A reset removes generated pages, so a retained answer can first reach a newly created page outside the edit plan.
describe('retained answers used by fresh pages (madarch-m38l.22)', () => {
  test('only successful grounded answered uses close; planned unfinished pages still prevent closure', async () => {
    const original = readQuestions(productFolder).items.find((question) => question.status === 'answered')!;
    expect(original.answer).not.toBeNull();
    for (const mode of ['grounded', 'unrelated', 'mention', 'failed', 'open', 'partial'] as const) {
      const output = path.join(scratch, `closure-${mode}`); mkdirSync(path.join(output, 'docs/questions'), { recursive: true });
      const question = { ...original, slug: 'retained-answer', status: mode === 'open' ? 'open' as const : 'answered' as const, answer: mode === 'open' ? null : original.answer, resolvedBy: [], resolvedAt: null };
      const source = renderQuestion(question); writeFileSync(path.join(output, 'docs/questions/retained-answer.md'), source);
      const key = 'question:retained-answer';
      const declarations = [{ slug: 'pricing', title: 'Pricing', summary: 'The order pricing rules.', evidence: ['code.file:src/pricing.ts'] }, ...(mode === 'partial' ? [{ slug: 'shipping', title: 'Shipping', summary: 'The delivery rules.', evidence: ['code.file:src/pricing.ts'] }] : [])];
      const agent: UnitAgent = { run: async (request) => {
        if (request.id.startsWith('product:')) {
          const markdown = ['---', 'id: product:closure-shop', 'kind: product', 'title: Closure shop', 'relates: []', 'producer: agent', 'sources: [README.md]', '---', '', 'The shop prices orders.[^shop]', '', '## Domains', '', ...declarations.map((domain) => `- [${domain.title}](madarch:domain:${domain.slug}) covers order rules.[^shop]`), '', '[^shop]: [README](madarch:doc:README.md#overview)'].join('\n');
          const result = await call(request, 'write_page', { markdown, domains: declarations }); expect(result.isError, JSON.stringify(result.answer)).toBe(false); return;
        }
        if (mode === 'failed' || request.id === 'domain:shipping') return;
        // The page's one rule stands on this mode's ground: the answer, or a README section — and in "mention" the
        // sentence only links the answer, which is no ground for it.
        const ground = mode === 'unrelated' || mode === 'mention' ? README_OVERVIEW : key;
        const fields = {
          title: 'Pricing',
          participants: [{ text: 'A shopper buys from the shop and is charged the price the policy gives.', grounds: [README_OVERVIEW] }],
          mainScenario: [{ text: 'The shop prices the order from the policy.', grounds: [README_OVERVIEW] }],
          rules: [{ text: `The policy is the rule a person chose.${mode === 'mention' ? ` [→ question: ${original.title}](madarch:${key})` : ''}`, grounds: [ground] }],
          whatCanGoWrong: [{ text: 'A change of the policy changes what a shopper pays.', grounds: [README_OVERVIEW] }],
          openPoints: [{ text: 'The documents say nothing more about the policy.', grounds: [README_OVERVIEW] }],
          developer: { notes: [] },
        };
        const result = await call(request, 'write_page', { fields }); expect(result.isError, JSON.stringify(result.answer)).toBe(mode === 'open');
      } };
      const closed: unknown[] = [];
      const answer = original.answer!;
      const report = await runWriter({ owner, store, repository, output, productName: 'Closure shop', agent, language: 'en',
        ...(mode === 'partial' ? { needed: () => ({ product: true, domain: () => true, brief: (file: string) => file.startsWith('docs/domains/') ? { current: null, notes: [{ kind: 'answer' as const, question: 'retained-answer', title: original.title, answer: answer.text, by: answer.by.name, at: answer.at, sides: original.sides }], omitted: 0 } : undefined }) } : {}),
        resolved: async (used) => { closed.push(used); await markResolved(output, used); },
      });
      expect(closed).toEqual(mode === 'grounded' ? [{ kind: 'question', slug: 'retained-answer', pages: ['domain:pricing'] }] : []);
      const kept = readQuestions(output).items[0]!; expect(kept.answer).toEqual(question.answer); expect(kept.resolvedBy).toEqual(mode === 'grounded' ? ['domain:pricing'] : []);
      if (mode === 'grounded' || mode === 'unrelated' || mode === 'mention') { expect(report.ok).toBe(true); expect(report.domains.find((domain) => domain.unit === 'domain:pricing')).toMatchObject({ status: 'written', writeAttempts: 1 }); }
      else expect(readFileSync(path.join(output, 'docs/questions/retained-answer.md'), 'utf8')).toBe(source);
    }
  }, 300_000);
});


// A pending correction is still input when reset removed the page that used it.
describe('retained corrections used by recreated pages (madarch-m38l.22)', () => {
  test('reset reopens the correction and a fresh unit receives and grounds it without changing human fields', async () => {
    for (const grounded of [true, false]) {
      const output = path.join(scratch, `correction-refill-${grounded}`);
      mkdirSync(path.join(output, 'docs/corrections'), { recursive: true });
      mkdirSync(path.join(output, 'docs/domains'), { recursive: true });
      const correction = {
        slug: 'caller-policy', title: 'Caller chooses the discount', status: 'applied' as const,
        about: 'domain:pricing#discount-policy', statement: 'The service chooses a fixed discount.',
        reason: 'The caller chooses the discount, not the pricing service.',
        by: { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' }, at: '2020-01-02T10:00:00Z',
        resolvedBy: ['domain:pricing'], resolvedAt: '2020-01-02T11:00:00Z',
      };
      const correctionFile = path.join(output, 'docs/corrections/caller-policy.md');
      writeFileSync(correctionFile, renderCorrection(correction));
      writeFileSync(path.join(output, 'docs/domains/pricing.md'), '---\nid: domain:pricing\nkind: domain\ntitle: Pricing\nproducer: agent\n---\n\nThe service chooses a fixed discount.[^discount-policy]\n\n[^discount-policy]: [README](madarch:doc:README.md#overview)\n');
      const preview = planReset(output, path.join(output, 'store'));
      applyReset(output, preview);
      const pending = readCorrections(output).items[0]!;
      expect(pending.status).toBe('open');
      expect(pending.resolvedBy).toEqual([]);
      const beforeBody = readFileSync(correctionFile, 'utf8').split('\n---\n')[1];
      const prompts = new Map<string, string>();
      const written: ToolAnswer[] = [];
      const closed: unknown[] = [];
      const agent: UnitAgent = { run: async (request) => {
        prompts.set(request.id, request.prompt);
        if (request.id.startsWith('product:')) {
          written.push(await call(request, 'write_page', {
            markdown: ['---', 'id: product:refill-policy', 'kind: product', 'title: Policy', 'relates: []', 'producer: agent', 'sources: [README.md]', '---', '', 'The shop prices orders.[^shop]', '', '- [Pricing](madarch:domain:pricing) covers order pricing.[^domain]', '', '[^shop]: [README](madarch:doc:README.md#overview)', '[^domain]: [pricing](madarch:code.file:src/pricing.ts)'].join('\n'),
            domains: [{ slug: 'pricing', title: 'Pricing', summary: 'The order pricing rules.', evidence: ['code.file:src/pricing.ts'] }],
          }));
        } else {
          // The recreated page states the correction's rule, grounded on the correction when the unit grounds it.
          written.push(await call(request, 'write_page', { fields: {
            title: 'Pricing',
            participants: [{ text: 'A shopper is charged the price the policy gives.', grounds: [README_OVERVIEW] }],
            mainScenario: [{ text: 'The shop prices the order from the policy.', grounds: [README_OVERVIEW] }],
            rules: [{ text: 'The caller chooses the discount.', grounds: grounded ? [README_OVERVIEW, 'correction:caller-policy'] : [README_OVERVIEW] }],
            whatCanGoWrong: [{ text: 'A wrong policy charges a shopper the wrong price.', grounds: [README_OVERVIEW] }],
            openPoints: [{ text: 'The documents say nothing more about the policy.', grounds: [README_OVERVIEW] }],
            developer: { notes: [] },
          } }));
        }
      } };
      const report = await runWriter({ owner, store, repository, output, productName: 'Refill policy', agent, language: 'en', resolved: async (used) => { closed.push(used); await markResolved(output, used); } });
      // Callback assertions are not evidence: runUnit catches them. Judge the accepted outcomes here.
      expect(report.ok).toBe(grounded);
      expect(report.loopProblems).toEqual(grounded ? [] : [`${correctionFile}:1: the recreated page domain:pricing does not ground its retained correction on madarch:correction:caller-policy; the correction stays open`]);
      expect(written).toHaveLength(2);
      expect(written.every((result) => !result.isError)).toBe(true);
      expect(report.domains[0]).toMatchObject({ unit: 'domain:pricing', status: 'written', writeAttempts: 1 });
      const prompt = prompts.get('domain:pricing')!;
      expect(prompt).toContain('## Retained corrections for this new page');
      expect(prompt).toContain('(madarch:correction:caller-policy)');
      expect(prompt).toContain(correction.statement);
      expect(prompt).toContain(correction.reason);
      expect(prompts.get('product:refill-policy')).not.toContain('(madarch:correction:caller-policy)');
      expect(closed).toEqual(grounded ? [{ kind: 'correction', slug: 'caller-policy', pages: ['domain:pricing'] }] : []);
      const after = readCorrections(output).items[0]!;
      expect([after.reason, after.statement, after.by, after.at]).toEqual([pending.reason, pending.statement, pending.by, pending.at]);
      expect(after.status).toBe(grounded ? 'applied' : 'open');
      expect(after.resolvedBy).toEqual(grounded ? ['domain:pricing'] : []);
      expect(readFileSync(correctionFile, 'utf8').split('\n---\n')[1]).toBe(beforeBody);
      if (grounded) {
        const markdown = readFileSync(path.join(output, 'docs/domains/pricing.md'), 'utf8');
        expect(markdown).toContain('The caller chooses the discount.');
        expect(markdown).toContain('(madarch:correction:caller-policy)');
        const appliedBytes = readFileSync(correctionFile, 'utf8');
        let rerunUnits = 0;
        const rerun = await runWriter({ owner, store, repository, output, productName: 'Refill policy', agent: { run: async () => { rerunUnits++; } }, resolved: async (used) => { closed.push(used); } });
        expect(rerun.ok).toBe(true);
        expect(rerunUnits).toBe(0);
        expect(closed).toHaveLength(1);
        expect(readFileSync(correctionFile, 'utf8')).toBe(appliedBytes);
      }
    }
  }, 300_000);
  test('notes omitted by the existing prompt budget stay open and report their full file paths', async () => {
    const output = path.join(scratch, 'correction-refill-budget');
    mkdirSync(path.join(output, 'docs/corrections'), { recursive: true });
    for (let index = 0; index < 12; index++) {
      const slug = `policy-${String.fromCharCode(97 + index)}`;
      writeFileSync(path.join(output, `docs/corrections/${slug}.md`), renderCorrection({
        slug, title: slug, status: 'open', about: 'product:budget-shop#policy', statement: 'The original policy is wrong.',
        reason: `${slug}: ${'A long explanation. '.repeat(190)}`, by: { name: 'Ada', email: 'ada@example.test', verified: 'local, not verified' },
        at: '2020-01-02T10:00:00Z', resolvedBy: [], resolvedAt: null,
      }));
    }
    const closed: string[] = [];
    let productPrompt = '';
    const report = await runWriter({ owner, store, repository, output, productName: 'Budget shop', agent: { run: async (request) => {
      if (!request.id.startsWith('product:')) return;
      productPrompt = request.prompt;
      // No write: even an included note must not close until its page is written with the ground.
    } }, resolved: async (used) => { closed.push(used.slug); } });
    const corrections = readCorrections(output).items;
    const included = corrections.filter((correction) => productPrompt.includes(`(madarch:${correction.id})`));
    const omitted = corrections.filter((correction) => !included.includes(correction));
    expect(included.length).toBeGreaterThan(0);
    expect(omitted.length).toBeGreaterThan(0);
    expect(productPrompt).toContain('more changes not listed here');
    expect(closed).toEqual([]);
    expect(corrections.every((correction) => correction.status === 'open' && correction.resolvedBy.length === 0)).toBe(true);
    expect(report.loopProblems).toEqual(omitted.map((correction) => `${path.join(output, correction.file)}:1: the retained correction for product:budget-shop exceeds the edit brief budget; it stays open for a later refresh`));
  }, 300_000);
});
