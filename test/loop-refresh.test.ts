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
import { readQuestions } from '../src/loop/entities.js';
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
        const written = await call(request, 'write_page', {
          markdown: [
            '---', 'id: domain:pricing', 'kind: domain', 'title: Pricing', 'relates:', '  - code.file\u003asrc/pricing.ts', 'producer: agent', 'sources: [README.md]', '---', '',
            '## How pricing works', '', 'Tax is a flat five percent.[^flat-five-percent-tax]', '', 'Pricing lives in one file.[^pricing-lives-one-file]', '',
            'The README promises ten percent for every order.[^readme-discount]', '', 'The code applies the percentage its caller passes.[^caller-discount]', '',
            '[^flat-five-percent-tax]: [README](madarch:doc:README.md#tax)',
            '[^pricing-lives-one-file]: [pricing](madarch:code.file\u003asrc/pricing.ts)',
            '[^readme-discount]: [README](madarch:doc:README.md#discounts)',
            `[^caller-discount]: [code](madarch:${discountKey})`,
          ].join('\n'),
        });
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
    expect(await indexCounts(owner)).toEqual([{ kind: 'domain', pages: 1, statements: 4 }, { kind: 'product', pages: 1, statements: 2 }, { kind: 'question', pages: 1, statements: 2 }]);
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
        const markdown = [
          '---', 'id: domain:pricing', 'kind: domain', 'title: Pricing', 'relates:', '  - code.file\u003asrc/pricing.ts', 'producer: agent', 'sources: [README.md]', '---', '',
          '## How pricing works', '', 'Tax is a flat five percent.[^flat-five-percent-tax]', '', 'Pricing lives in one file.[^pricing-lives-one-file]', '',
          `Every order gets ten percent, as a person decided.[^order-gets-ten-percent]`, '',
          '[^flat-five-percent-tax]: [README](madarch:doc:README.md#tax)',
          '[^pricing-lives-one-file]: [pricing](madarch:code.file\u003asrc/pricing.ts)',
          `[^order-gets-ten-percent]: [the answer](madarch:question:${QUESTION_SLUG}), [README](madarch:doc:README.md#discounts)`,
        ].join('\n');
        // A question that is not answered, or not asked, is no ground.
        const bad = await call(request, 'write_page', { markdown: markdown.replace(`madarch:question:${QUESTION_SLUG}`, 'madarch:question:never-asked') });
        expect(bad.isError).toBe(true);
        expect(JSON.stringify(bad.answer)).toContain('is no answered question and no correction of this product');
        const good = await call(request, 'write_page', { markdown });
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
    expect(prompt).toContain('Tax is a flat five percent.[^flat-five-percent-tax]');
    expect(prompt).toContain('## Questions already asked about this page');
    // The product page was not touched at all, and the sentences that stand kept their names.
    expect(read('docs/product.md')).toBe(productBefore);
    expect(statSync(path.join(productFolder, 'docs/product.md')).mtimeMs).toBe(productStat);
    const pricing = read('docs/domains/pricing.md');
    for (const kept of ['Tax is a flat five percent.[^flat-five-percent-tax]', 'Pricing lives in one file.[^pricing-lives-one-file]']) {
      expect(pricingBefore).toContain(kept);
      expect(pricing).toContain(kept);
    }
    expect(pricing).toContain('Every order gets ten percent, as a person decided.[^order-gets-ten-percent]');
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
        const written = await call(request, 'write_page', {
          markdown: [
            '---', 'id: domain:pricing', 'kind: domain', 'title: Pricing', 'relates:', '  - code.file\u003asrc/pricing.ts', 'producer: agent', 'sources: [README.md]', '---', '',
            '## How pricing works', '', 'Tax is a flat eight percent.[^flat-five-percent-tax]', '', 'Pricing lives in one file.[^pricing-lives-one-file]', '',
            `Every order gets ten percent, as a person decided.[^order-gets-ten-percent]`, '',
            '[^flat-five-percent-tax]: [README](madarch:doc:README.md#tax)',
            '[^pricing-lives-one-file]: [pricing](madarch:code.file\u003asrc/pricing.ts)',
            `[^order-gets-ten-percent]: [the answer](madarch:question:${QUESTION_SLUG}), [README](madarch:doc:README.md#discounts)`,
          ].join('\n'),
        });
        expect(written.isError).toBe(false);
      },
    };
    const { report, plan } = await refresh(agent);
    expect(plan.plan.pages.map((p) => [p.path, p.reasons])).toEqual([['docs/domains/pricing.md', [{ kind: 'ground-changed', statement: 'flat-five-percent-tax', ground: 'doc:README.md#tax' }]]]);
    expect(seen).toEqual(['domain:pricing']);
    expect(report.units).toBe(1);
    const prompt = prompts.get('ground:domain:pricing')!;
    expect(prompt).toContain('The ground doc:README.md#tax CHANGED. The statement [^flat-five-percent-tax] stands on it: "Tax is a flat five percent."');
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
    expect(removed.map((p) => [p.page, p.statement, p.target, p.fixer, p.file])).toEqual([['domain:pricing', 'flat-five-percent-tax', 'doc:README.md#tax', 'agent', 'docs/domains/pricing.md']]);
    expect(removed[0]!.sentence).toBe('Tax is a flat eight percent.');
    const { plan } = await refresh({ run: async () => undefined });
    expect(plan.plan.pages.map((p) => [p.path, p.reasons.map((r) => r.kind)])).toEqual([['docs/domains/pricing.md', ['ground-removed']]]);
  }, 300_000);

  test('a change of language is a translation of every page, with the page in front of the unit and the names kept', async () => {
    seen.length = 0;
    const russian: Record<string, string> = {
      'product:loop-shop': [
        '---', 'id: product:loop-shop', 'kind: product', 'title: Магазин', 'relates:', '  - code.file\u003asrc/pricing.ts', 'producer: agent', 'sources: [README.md]', '---', '',
        '## Что это', '', 'Магазин считает цены и отправляет заказы.[^shop-prices-ships-orders]', '',
        '## Домены', '', '- [Цены](madarch:domain:pricing) отвечают за скидки и налог.[^pricing-covers-discounts-tax]', '',
        '[^shop-prices-ships-orders]: [README](madarch:doc:README.md#overview)',
        '[^pricing-covers-discounts-tax]: [pricing](madarch:code.file\u003asrc/pricing.ts)',
      ].join('\n'),
      'domain:pricing': [
        '---', 'id: domain:pricing', 'kind: domain', 'title: Цены', 'relates:', '  - code.file\u003asrc/pricing.ts', 'producer: agent', 'sources: [README.md]', '---', '',
        '## Как считаются цены', '', 'Налог плоский, восемь процентов.[^flat-five-percent-tax]', '', 'Цены живут в одном файле.[^pricing-lives-one-file]', '',
        '[^flat-five-percent-tax]: [README](madarch:doc:README.md#overview)',
        '[^pricing-lives-one-file]: [pricing](madarch:code.file\u003asrc/pricing.ts)',
      ].join('\n'),
    };
    const agent: UnitAgent = {
      run: async (request) => {
        seen.push(request.id);
        prompts.set(`ru:${request.id}`, request.prompt);
        const written = await call(request, 'write_page', request.id.startsWith('product:')
          ? { markdown: russian[request.id], domains: [{ slug: 'pricing', title: 'Цены', summary: 'Как считается цена заказа.', evidence: ['code.file\u003asrc/pricing.ts'] }] }
          : { markdown: russian[request.id] });
        expect(JSON.stringify(written.answer)).not.toContain('refused');
        expect(written.isError).toBe(false);
      },
    };
    const { report, plan } = await refresh(agent, { from: 'en', to: 'ru', changed: true });
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
    expect(read('docs/domains/pricing.md')).toContain('Цены живут в одном файле.[^pricing-lives-one-file]');
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
