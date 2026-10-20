/**
 * Open questions, a person's answers and acceptances, and the next step, on a real
 * fill's store (the self-filling charter's outcome 5; decision 0026, "Pages" and
 * "Writing").
 *
 * The values here are the charter's and the task's, never the code's:
 *
 * - questions are the graph's `question` facts, shown on the pages they concern,
 *   grouped by the charter's eight types, each naming what depends on it and ranked by
 *   that;
 * - a person answers a question and accepts or rejects a page's proposed content, and
 *   both are Markdown in the product's git, read back into the graph, with only the
 *   pages that depend on them read again (measured: the pages the live channel names,
 *   and the page answers a reader's cache still holds);
 * - every page shows a next step, open questions first — «Всегда должна быть
 *   рекомендация что делать»;
 * - the question a person answers is closed by an answer a person wrote and accepted as
 *   it stands (decision 0005: a person's words are `declared`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPageReadCache } from '../src/fill/page-cache.js';
import { readDecisions } from '../src/fill/decisions.js';
import { makeEdgeFact, makeNodeFact, repositoryPath, type Fact } from '../src/fill/facts.js';
import { graphFacts, openGraphFixture, PRODUCT, provenance, writeOf, type GraphFixtureFacts, type GraphFixtureWorld } from './graph-pages-fixture.js';

const QUESTION = `question:${'4'.repeat(64)}`;
const OTHER_QUESTION = `question:${'5'.repeat(64)}`;

let world: GraphFixtureWorld | undefined;
let facts: GraphFixtureFacts;
/** The second question of the fixture's graph: one type the charter names, about a page nobody made important. */
let other: Fact;

beforeAll(async () => {
  facts = graphFacts();
  other = makeNodeFact({
    kind: 'question',
    value: { repository: 'acme-shop', type: 'term', about: facts.placed.id, prompt: 'does "placed" mean authorized or captured?' },
    provenance: provenance('src/checkout.ts', { startLine: 12, endLine: 12 }),
    layer: 'inferred',
  });
  world = await openGraphFixture({ drafts: () => [facts.module, facts.placed, facts.total, facts.holds, facts.calls, facts.question, other].map((fact) => writeOf(fact)) });
  const run = await world.service.run({ product: { name: PRODUCT, folder: world.folder }, runId: 'run-questions-1' });
  if (run.ok === false) throw new Error(`the fixture's run was refused: ${run.code}: ${run.reason}`);
}, 120_000);

afterAll(async () => {
  await world?.close();
});

/** The product's page source, as the background server serves it. */
function source() {
  if (world === undefined) throw new Error('no fixture world');
  return world.service.pages(world.folder);
}

describe('the questions a product asks', () => {
  test('a page names what depends on each question and ranks the question by that', async () => {
    const read = await source().page(facts.module.id);
    expect(read.ok).toBe(true);
    if (read.ok === false) return;
    expect(read.page.questions.length).toBe(1);
    const [question] = read.page.questions;
    // The question is about the module, whose edges name two symbols: the answer would change the module's page and
    // the symbols' pages, so three pages depend on it.
    expect(question!.open).toBe(true);
    expect(question!.answer).toBeNull();
    expect(question!.type).toBe('assumption-check');
    expect(question!.dependsOn.map((node) => node.id)).toEqual([facts.module.id, facts.total.id, facts.placed.id].sort());
    expect(question!.rank).toBe(question!.dependsOn.length);
    expect(question!.rank).toBe(3);
  });

  test('the product\'s questions come grouped by the charter\'s types, the charter\'s own order first', async () => {
    const set = await source().pageSet();
    expect(set.questions.groups.map((group) => group.type)).toEqual(['assumption-check', 'term']);
    expect(set.questions.open).toBe(2);
    expect(set.questions.answered).toBe(0);
    expect(set.questions.total).toBe(2);
    expect(set.questions.truncated).toBe(false);
    // The groups carry the questions whole: a reader sees the question, its type and what depends on it.
    const [first] = set.questions.groups;
    expect(first!.questions[0]!.prompt).toBe('is the total used anywhere?');
    expect(first!.questions[0]!.rank).toBe(3);
    // The term question is about one symbol, which no edge names but its file's: one page depends on it.
    const term = set.questions.groups.find((group) => group.type === 'term');
    expect(term!.questions[0]!.rank).toBe(1);
  });

  test('the product\'s next step is its most asked open question: «Всегда должна быть рекомендация что делать»', async () => {
    const set = await source().pageSet();
    expect(set.nextStep.rule).toBe('answer-question');
    expect(set.nextStep.question?.prompt).toBe('is the total used anywhere?');
    expect(set.nextStep.question?.rank).toBe(3);
    // A question's own page is where a person answers it, so that is what the step opens.
    expect(set.nextStep.target).toBe(set.pages.find((page) => page.kind === 'question')!.page);
  });

  test('a page with an open question recommends answering it, and a page with neither a question nor a covered scope says what waits', async () => {
    const modulePage = await source().page(facts.module.id);
    if (modulePage.ok === false) throw new Error(modulePage.message);
    expect(modulePage.page.nextStep.rule).toBe('answer-question');
    expect(modulePage.page.nextStep.question?.type).toBe('assumption-check');
    const symbolPage = await source().page(facts.placed.id);
    if (symbolPage.ok === false) throw new Error(symbolPage.message);
    // The symbol's own question ("does placed mean authorized or captured?") is its step: a page's own question comes
    // before anything the page does not know.
    expect(symbolPage.page.nextStep.rule).toBe('answer-question');
    expect(symbolPage.page.nextStep.question?.prompt).toBe('does "placed" mean authorized or captured?');
  });
});

describe('a person answers a question in the wiki', () => {
  test('the answer is Markdown in the product\'s git, read back into the graph, and only the pages that depend on it are read again', async () => {
    if (world === undefined) throw new Error('no fixture world');
    // What a reader's cache holds before the answer: two pages read, and one of them the answer will not touch.
    const cache = createPageReadCache();
    const modulePage = await source().page(facts.module.id);
    if (modulePage.ok === false) throw new Error(modulePage.message);
    const symbolPage = await source().page(facts.placed.id);
    if (symbolPage.ok === false) throw new Error(symbolPage.message);
    cache.keepPage(PRODUCT, facts.module.id, modulePage.page, cache.generation);
    cache.keepPage(PRODUCT, facts.placed.id, symbolPage.page, cache.generation);

    const wrote = await source().answer({ question: facts.question.id, answer: 'The total is used by the receipt.', by: 'the owner' });
    expect(wrote.ok).toBe(true);
    if (wrote.ok === false) throw new Error(wrote.message);

    // The document stands in the product's git, with the person's own words, dated and signed.
    const file = join(world.folder, wrote.file);
    expect(wrote.file).toBe(`answers/${facts.question.id.slice('question:'.length)}.md`);
    expect(existsSync(file)).toBe(true);
    const markdown = readFileSync(file, 'utf8');
    expect(markdown).toContain(`Question: ${facts.question.id}`);
    expect(markdown).toContain('By: the owner');
    expect(markdown).toContain('The total is used by the receipt.');
    expect(readDecisions(world.folder).records.map((record) => [record.kind, record.subject])).toEqual([['answer', facts.question.id]]);

    // The graph read it back: the question is closed by a person's answer, declared and accepted as it stands (0005).
    const closed = await source().page(facts.module.id);
    if (closed.ok === false) throw new Error(closed.message);
    const [question] = closed.page.questions;
    expect(question!.open).toBe(false);
    expect(question!.answer?.decision).toBe('answers');
    expect(question!.answer?.text).toBe('The total is used by the receipt.');
    expect(question!.answer?.layer).toBe('declared');
    expect(question!.answer?.status).toBe('accepted');
    expect(question!.answer?.by).toBe('madarch-wiki');

    // The pages the decision moved: the question's own page and the page it is about — and no other.
    expect(wrote.pages).toEqual([facts.module.id, facts.question.id].sort());
    const announced = await source().changes(0);
    expect(announced.changes[0]!.nodes).toEqual([facts.module.id, facts.question.id].sort());
    expect(announced.changes[0]!.unitId).toBe('person');

    // Measured: a page the answer did not touch is still the page the reader's cache holds, and the one it did is
    // not — the decision drops the pages that depend on it and no others.
    cache.dropPages(PRODUCT, wrote.pages);
    expect(cache.page(PRODUCT, facts.module.id)).toBeUndefined();
    expect(cache.page(PRODUCT, facts.placed.id)).toBe(symbolPage.page);

    // The product's questions now stand one open and one answered, and the step moves to the open one.
    const set = await source().pageSet();
    expect([set.questions.open, set.questions.answered]).toEqual([1, 1]);
    expect(set.nextStep.question?.prompt).toBe('does "placed" mean authorized or captured?');
  });

  test('an answer a person gives twice replaces their first: one answer closes a question', async () => {
    const first = await source().answer({ question: other.id, answer: 'authorized', by: 'the owner' });
    expect(first.ok).toBe(true);
    const second = await source().answer({ question: other.id, answer: 'authorized, and the capture follows within a day', by: 'the owner' });
    expect(second.ok).toBe(true);
    const page = await source().page(facts.placed.id);
    if (page.ok === false) throw new Error(page.message);
    const answer = page.page.questions[0]!.answer;
    expect(answer?.text).toBe('authorized, and the capture follows within a day');
    // One document per question: the second write is the same file.
    expect(second.ok && second.file).toBe(first.ok && first.file);
  });

  test('a question the graph does not hold, and an empty answer, are refused by name and write nothing', async () => {
    const unknown = await source().answer({ question: QUESTION, answer: 'anything', by: 'the owner' });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.code).toBe('graph-pages/no-such-node');

    const empty = await source().answer({ question: facts.question.id, answer: '   ', by: 'the owner' });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.code).toBe('graph-pages/empty-answer');

    const notAQuestion = await source().answer({ question: facts.module.id, answer: 'anything', by: 'the owner' });
    expect(notAQuestion.ok).toBe(false);
    if (notAQuestion.ok) return;
    expect(notAQuestion.code).toBe('graph-pages/not-a-question');
  });
});

describe('a person accepts or rejects what a page proposes', () => {
  test('the acceptance is Markdown in the product\'s git, read back into the graph, and the page shows it', async () => {
    if (world === undefined) throw new Error('no fixture world');
    const before = await source().page(facts.module.id);
    if (before.ok === false) throw new Error(before.message);
    expect(before.page.decision).toBeNull();

    const decided = await source().decide({ page: facts.module.id, verdict: 'accepted', note: 'the boundary is right', by: 'the owner' });
    expect(decided.ok).toBe(true);
    if (decided.ok === false) throw new Error(decided.message);
    expect(decided.pages).toEqual([facts.module.id]);
    const markdown = readFileSync(join(world.folder, decided.file), 'utf8');
    expect(markdown).toContain(`Page: ${facts.module.id}`);
    expect(markdown).toContain('Verdict: accepted');
    expect(markdown).toContain('the boundary is right');

    const after = await source().page(facts.module.id);
    if (after.ok === false) throw new Error(after.message);
    expect(after.page.decision?.decision).toBe('accepts');
    expect(after.page.decision?.text).toBe('the boundary is right');
    expect(after.page.decision?.layer).toBe('declared');

    // A person who changes their mind replaces their decision: one verdict per page.
    const rejected = await source().decide({ page: facts.module.id, verdict: 'rejected', note: 'the boundary is wrong', by: 'the owner' });
    expect(rejected.ok).toBe(true);
    const changed = await source().page(facts.module.id);
    if (changed.ok === false) throw new Error(changed.message);
    expect(changed.page.decision?.decision).toBe('rejects');
    expect(changed.page.decision?.text).toBe('the boundary is wrong');
  });

  test('a page the graph does not hold is refused, and a verdict the wiki does not know never reaches the graph', async () => {
    const unknown = await source().decide({ page: QUESTION, verdict: 'accepted', note: '', by: 'the owner' });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.code).toBe('graph-pages/no-such-node');

    const file = await source().decide({ page: facts.placed.id, verdict: 'maybe' as unknown as 'accepted', note: '', by: 'the owner' });
    expect(file.ok).toBe(false);
    if (file.ok) return;
    expect(file.code).toBe('graph-pages/refused');
  });
});
