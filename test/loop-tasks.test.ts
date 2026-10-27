/**
 * The scoped tasks of answers over HTTP (madarch-m38l.14): the task an answer
 * proposes, the person's confirmation that writes it into the product and
 * commits it, the planned change it marks on the document it names, and the
 * commit that closes it again. One product serves the whole file and its tests
 * run in order — a task is proposed, confirmed, marked, then closed — as
 * test/loop-server.test.ts does; no fill runs, so the graph holds no statement.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { splitFrontMatter } from '../src/knowledge/markdown.js';
import { renderQuestion, type Question } from '../src/loop/entities.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
/** git in a fixture folder; `extra` sets the dates a commit that closes a task is read by. */
const git = (cwd: string, args: string[], extra: Record<string, string> = {}): string =>
  execFileSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });

const SHOP = 'orders-shop';
/** The code repository, as the manifest names it and as a task's closure names it. */
const CODE = 'orders-code';
/** The person the product repository commits as: git's own `user.name` and `user.email`, marked local (decision 0031). */
const READER = { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' };
/** The scopes this fixture's answers name. */
const DISCOUNT_SECTION = { type: 'section', path: 'README.md', anchor: 'discounts' };
const TAX_SECTION = { type: 'section', path: 'README.md', anchor: 'tax' };
const CODE_FILE = { type: 'file', path: 'src/a.ts' };
/** The grounds of the answered contradiction, in the code-point order the engine sorts them. */
const DISCOUNT_GROUNDS = ['code.file\u003asrc/a.ts', 'code.service:orders', 'doc:README.md#discounts'];

/** The code repository's README: two sections the answered questions name, and the Refunds section a closure is read on. */
const REFUNDS_README = [
  '# Shop',
  '',
  '## Discounts',
  '',
  'Every order gets ten percent.',
  '',
  '## Tax',
  '',
  'Tax is added at checkout.',
  '',
  '## Refunds',
  '',
  '- **Thirty days.** A refund is asked within thirty days of the capture.',
  '- **Full amount.** A refund never exceeds the captured total.',
  '',
  'Refunds are paid back to the card that was charged.',
  '',
].join('\n');
/** The section a task closes against: two bold items, then the unnamed paragraph its last line changes. */
const REFUND_SECTION = { type: 'section', path: 'README.md', anchor: 'refunds' };

/** The product page an agent wrote: two statements, one standing on each README section. */
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

const DISCOUNT_ANSWER = { text: 'Ten percent for every order.', by: { ...READER }, at: '2026-10-24T09:00:00.000Z' };

/** An answered contradiction: one side stands on a README section, the other on a code file. */
const DISCOUNT_QUESTION: Omit<Question, 'file' | 'id'> = {
  slug: 'discount-percentage',
  title: 'Is the discount ten percent or what the caller passes?',
  type: 'contradiction',
  status: 'answered',
  about: ['code.service:orders'],
  askedIn: 'domain:orders',
  askedAt: '2026-10-23T10:00:00.000Z',
  question: 'Which discount does an order get?',
  why: 'A shopper is told one number and charged another.',
  sides: [
    { claim: 'The README says every order gets ten percent.', grounds: ['doc:README.md#discounts'] },
    { claim: 'The code applies the percentage its caller passes.', grounds: ['code.file\u003asrc/a.ts'] },
  ],
  answer: DISCOUNT_ANSWER,
  resolvedBy: [],
  resolvedAt: null,
  writtenAt: [],
};

/** An open question: it proposes no task until a person answers it. */
const TAX_QUESTION: Omit<Question, 'file' | 'id'> = {
  slug: 'tax-timing',
  title: 'Is tax added at checkout or when the order is placed?',
  type: 'undocumented',
  status: 'open',
  about: [],
  askedIn: null,
  askedAt: '2026-10-23T11:00:00.000Z',
  question: 'When is tax added?',
  why: 'The README says checkout, and the code adds it when the order is placed.',
  sides: [{ claim: 'The README says tax is added at checkout.', grounds: ['doc:README.md#tax'] }],
  answer: null,
  resolvedBy: [],
  resolvedAt: null,
  writtenAt: [],
};

/** A second open question, about the section the regression closes: an answer proposes the task that changes it. */
const REFUND_QUESTION: Omit<Question, 'file' | 'id'> = {
  slug: 'refund-window',
  title: 'Is a refund asked for within thirty days of the capture?',
  type: 'undocumented',
  status: 'open',
  about: [],
  askedIn: null,
  askedAt: '2026-10-23T12:00:00.000Z',
  question: 'How long does a shopper have to ask for a refund?',
  why: 'The README says thirty days, and nothing in the code says when a refund is asked for.',
  sides: [{ claim: 'The README says a refund is asked within thirty days of the capture.', grounds: ['doc:README.md#refunds'] }],
  answer: null,
  resolvedBy: [],
  resolvedAt: null,
  writtenAt: [],
};

let work: string;
let folder: string;
let repository: string;
let server: StartedServer;
/** The task confirmed from the answered contradiction, as its answer names it. */
let discountTask!: { id: string; slug: string; title: string; file: string; at: string };
/** The task confirmed from the answered question about tax, whose scope is the README's tax section alone. */
let taxTask!: { id: string; slug: string; title: string; file: string; at: string };

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/${SHOP}${path}`);
  return { status: response.status, body: await response.json() };
};
const post = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/${SHOP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

/** The front matter of a file of the product, parsed; a file without one is an error naming it. */
const frontOf = (path: string): Record<string, unknown> => {
  const { front } = splitFrontMatter(readFileSync(path, 'utf8'));
  if (front === null) throw new Error(`${path}:1: the file has no front matter`);
  return parseYaml(front) as Record<string, unknown>;
};

/** One task of a listing, by its id. */
const taskRowOf = (listing: { body: any }, id: string): any => listing.body.tasks.find((row: { id: string }) => row.id === id);

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-loop-tasks-'));
  repository = join(work, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  git(repository, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(repository, 'src', 'a.ts'), 'export function discount(percent: number): number {\n  return percent;\n}\n');
  // The Refunds section is the regression of madarch-ztyq.3: it holds two bold items and then an unnamed paragraph, and
  // a commit that changes that last paragraph — its last line — must still touch the section's scope (src/loop/closure.ts).
  writeFileSync(join(repository, 'README.md'), REFUNDS_README);
  writeFileSync(join(repository, 'NOTES.md'), '# Notes\n\nNothing is planned here.\n');
  git(repository, ['add', '.']);
  git(repository, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'first']);
  const home = join(work, 'home');
  mkdirSync(home);
  folder = makeProduct(home, SHOP, repository, CODE);
  git(folder, ['config', 'user.name', 'Ada Reader']);
  git(folder, ['config', 'user.email', 'ada@example.test']);
  mkdirSync(join(folder, 'docs/domains'), { recursive: true });
  mkdirSync(join(folder, 'docs/questions'), { recursive: true });
  writeFileSync(join(folder, 'docs/domains/orders.md'), PAGE);
  writeFileSync(join(folder, 'docs/questions/discount-percentage.md'), renderQuestion(DISCOUNT_QUESTION));
  writeFileSync(join(folder, 'docs/questions/tax-timing.md'), renderQuestion(TAX_QUESTION));
  writeFileSync(join(folder, 'docs/questions/refund-window.md'), renderQuestion(REFUND_QUESTION));
  git(folder, ['add', '-A']);
  git(folder, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'the agent wrote']);
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  server = await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined });
  // The product's reader is a process of its own: the first ask pays for its start, so it is warmed here.
  const warmed = await fetch(`${server.url}/products/${SHOP}/api/k/tasks`);
  expect(warmed.status).toBe(200);
}, 120_000);

afterAll(async () => {
  await server.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('the task an answer proposes', () => {
  test('the answered question proposes the document side the answer says to change, as the section that is wrong', async () => {
    const before = await get('/api/k/tasks');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ tasks: [], open: 0, closed: 0, problems: [], notes: [] });
    const proposal = await post('/api/k/task-propose', { question: 'discount-percentage', choice: 'code' });
    expect(proposal.status).toBe(200);
    expect(proposal.body.choice).toBe('code');
    expect(proposal.body.title).toBe('Update the documents: Is the discount ten percent or what the caller passes?');
    // The grounds are the question's own and its sides', de-duplicated and in code-point order (src/loop/propose.ts:69).
    expect(proposal.body.grounds).toEqual(DISCOUNT_GROUNDS);
    // The choice says which side changes: «Прав код, документ устарел» changes the documents the answer names, and a
    // document ground with an anchor is that section, never the whole README (src/loop/propose.ts:79-91).
    expect(proposal.body.scope).toEqual([DISCOUNT_SECTION]);
    expect(proposal.body.question).toEqual({ slug: 'discount-percentage', title: 'Is the discount ten percent or what the caller passes?', file: 'docs/questions/discount-percentage.md' });
    expect(proposal.body.answer).toEqual({ text: 'Ten percent for every order.', by: 'Ada Reader <ada@example.test>', at: '2026-10-24T09:00:00.000Z' });
    // No statement stands on the grounds without a fill, so the graph answers nothing for the section: that is said,
    // not hidden. The page whose statement stands on the section is reached by the section's own key
    // (src/loop/impact.ts:127-135).
    expect(proposal.body.impact.unindexed).toEqual(['doc:README.md#discounts']);
    expect(proposal.body.impact.counts.statements).toBe(0);
    expect(proposal.body.impact.pages.map((page: { id: string; because: string }) => [page.id, page.because])).toContainEqual(['domain:orders', 'link']);
    // What a run would rewrite: the product's own pages, never the code (src/loop/impact.ts:137).
    expect(proposal.body.impact.writable).toEqual(['docs/domains/orders.md']);
    expect(proposal.body.impact.entities).toEqual(['doc:README.md#discounts']);
    // The grounds stay the answer's whole evidence, whichever side the task changes.
    expect(proposal.body.impact.grounds).toEqual(['doc:README.md#discounts']);
    // The other choice changes the code side, which is the file the answer names.
    const docs = await post('/api/k/task-propose', { question: 'discount-percentage', choice: 'docs' });
    expect(docs.status).toBe(200);
    expect(docs.body.title).toBe('Fix the code: Is the discount ten percent or what the caller passes?');
    expect(docs.body.choice).toBe('docs');
    expect(docs.body.scope).toEqual([CODE_FILE]);
    expect(docs.body.grounds).toEqual(DISCOUNT_GROUNDS);
    // A proposal writes nothing: the product still holds no task.
    expect((await get('/api/k/tasks')).body.tasks).toEqual([]);
  }, 60_000);

  test('a question nobody answered is a 409 naming its file, and a choice that is neither code nor docs is a 400 naming the field', async () => {
    const unanswered = await post('/api/k/task-propose', { question: 'tax-timing', choice: 'code' });
    expect(unanswered.status).toBe(409);
    expect(unanswered.body.error.field).toBe('question');
    expect(unanswered.body.error.message).toBe('docs/questions/tax-timing.md:1: the question tax-timing has no answer yet, so it proposes no task: answer it first');
    const other = await post('/api/k/task-propose', { question: 'discount-percentage', choice: 'other' });
    expect(other.status).toBe(400);
    expect(other.body.error.field).toBe('choice');
    expect(other.body.error.message).toBe('"choice" is code (the code is right, the documents are old) or docs (the documents are right, the code must change)');
  }, 30_000);
});

describe('confirming the proposal as a task', () => {
  test('the confirmed task is a file of the product, committed as the person, and listed open with its scope words', async () => {
    const proposal = await post('/api/k/task-propose', { question: 'discount-percentage', choice: 'code' });
    expect(proposal.status).toBe(200);
    const created = await post('/api/k/task-create', { question: 'discount-percentage', title: proposal.body.title, grounds: proposal.body.grounds, scope: proposal.body.scope });
    expect(created.status).toBe(201);
    const made = created.body.task;
    discountTask = { id: made.id, slug: made.slug, title: made.title, file: made.file, at: made.at };
    expect(created.body.state).toBe('created');
    expect(created.body.committed).toBe(true);
    expect(created.body.commit).toBe(git(folder, ['log', '-1', '--format=%H']).trim());
    // The file the task lives in is named by its slug, and its id by the task's (src/loop/tasks.ts:47-53, 98-102).
    expect(made.id).toBe(`task:${made.slug}`);
    expect(made.file).toBe(`docs/tasks/${made.slug}.md`);
    // Everything the answer carries but the moment it was written at (src/knowledge/product.ts:1535-1561).
    const { at, ...rest } = made;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rest).toEqual({
      slug: made.slug,
      id: `task:${made.slug}`,
      file: `docs/tasks/${made.slug}.md`,
      title: 'Update the documents: Is the discount ten percent or what the caller passes?',
      status: 'open',
      question: 'question:discount-percentage',
      answer: 'answer:discount-percentage',
      grounds: DISCOUNT_GROUNDS,
      scope: [DISCOUNT_SECTION],
      by: { ...READER },
      closedBy: null,
      closedAt: null,
    });
    // The product repository took the file with the person as its author (src/loop/answer.ts:65-76).
    expect(git(folder, ['log', '-1', '--format=%an <%ae>|%s']).trim()).toBe(`Ada Reader <ada@example.test>|Plan the task ${made.slug}`);
    expect(git(folder, ['status', '--porcelain']).trim()).toBe('');
    expect(frontOf(join(folder, `docs/tasks/${made.slug}.md`))).toEqual({
      id: `task:${made.slug}`,
      kind: 'task',
      title: 'Update the documents: Is the discount ten percent or what the caller passes?',
      status: 'open',
      question: 'question:discount-percentage',
      answer: 'answer:discount-percentage',
      grounds: DISCOUNT_GROUNDS,
      scope: [DISCOUNT_SECTION],
      producer: 'person',
      'created-by': { ...READER },
      'created-at': at,
    });
    const listing = await get('/api/k/tasks');
    expect(listing.status).toBe(200);
    expect(listing.body).toEqual({
      tasks: [{
        id: `task:${made.slug}`,
        slug: made.slug,
        title: 'Update the documents: Is the discount ten percent or what the caller passes?',
        status: 'open',
        file: `docs/tasks/${made.slug}.md`,
        question: 'question:discount-percentage',
        answer: 'answer:discount-percentage',
        at,
        by: { ...READER },
        grounds: DISCOUNT_GROUNDS,
        // The place as a reader says it (madarch-m38l.14, the owner's review): the section's heading and its document's
        // title, each a link; the stored words stay for a tooltip.
        scope: [{ scope: DISCOUNT_SECTION, words: 'README.md#discounts', place: { kind: 'section', label: 'Discounts', where: 'Shop', href: '/k/doc?repo=orders-code&path=README.md#discounts', path: 'README.md', words: 'README.md#discounts' } }],
        closedBy: null,
        impact: { pages: expect.any(Number), statements: 0 },
      }],
      open: 1,
      closed: 0,
      problems: [],
      notes: [],
    });
    expect(listing.body.tasks[0].impact.pages).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test('a task that already exists, and a confirmation with no scope, are refused with the file they name', async () => {
    const again = await post('/api/k/task-create', { question: 'discount-percentage', title: discountTask.title, grounds: DISCOUNT_GROUNDS, scope: [DISCOUNT_SECTION] });
    // A task that exists is a conflict the reader can act on: the route answers it as src/knowledge/product.ts's LoopRefusal says.
    expect(again.status).toBe(409);
    expect(again.body.message).toBe(`docs/tasks/${discountTask.slug}.md:1: a task with this id already exists`);
    const noScope = await post('/api/k/task-create', { question: 'discount-percentage', title: 'Update the documents: change nothing', grounds: ['doc:README.md#discounts'], scope: [] });
    expect(noScope.status).toBe(400);
    expect(noScope.body.message).toBe('docs/tasks:1: a confirmed task needs a scope: the section, lines, symbol or statement it changes');
    expect((await get('/api/k/tasks')).body.tasks.length).toBe(1);
  }, 30_000);
});

describe('where the planned change shows', () => {
  test('the document section the task names is marked as its scope, and a document no task names is marked nothing', async () => {
    const document = await get('/api/k/document?repo=orders-code&path=README.md');
    expect(document.status).toBe(200);
    expect(document.body.planned).toEqual([{
      anchor: 'discounts',
      lines: null,
      task: { id: `task:${discountTask.slug}`, slug: discountTask.slug, title: discountTask.title, file: `docs/tasks/${discountTask.slug}.md` },
      how: 'scope',
    }]);
    const unplanned = await get('/api/k/document?repo=orders-code&path=NOTES.md');
    expect(unplanned.status).toBe(200);
    expect(unplanned.body.planned).toEqual([]);
    // One task read whole: the section its scope names, and the graph nodes it marks — the section's own document key and
    // the pages the change reaches (src/loop/planned.ts:94-118).
    const detail = await get(`/api/k/task?id=${discountTask.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.marks.sections).toBe(1);
    expect(detail.body.marks.statements).toBe(detail.body.impact.statements.length);
    expect(detail.body.marks.entities).toBeGreaterThanOrEqual(1);
    expect(detail.body.writable).toEqual(['docs/domains/orders.md']);
    expect(detail.body.impact.counts.statements).toBe(0);
    expect(detail.body.impact.pages.map((page: { id: string }) => page.id)).toContain('domain:orders');
    const missing = await get('/api/k/task?id=task:no-such-task');
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe('there is no task task:no-such-task: docs/tasks/no-such-task.md is not in the product repository');
  }, 60_000);
});

describe('closing a task by a commit', () => {
  test('a commit that names the task and changes the file its scope names closes it; a commit that misses either does not', async () => {
    // A second task, from the same open question answered now: its scope is the README's tax section alone.
    const answered = await post('/api/k/answer', { question: 'tax-timing', text: 'Tax is added when the order is placed.' });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ question: 'tax-timing', state: 'answered', committed: true });
    const proposal = await post('/api/k/task-propose', { question: 'tax-timing', choice: 'code' });
    expect(proposal.status).toBe(200);
    expect(proposal.body.title).toBe('Update the documents: Is tax added at checkout or when the order is placed?');
    expect(proposal.body.grounds).toEqual(['doc:README.md#tax']);
    expect(proposal.body.scope).toEqual([TAX_SECTION]);
    const created = await post('/api/k/task-create', { question: 'tax-timing', title: proposal.body.title, grounds: proposal.body.grounds, scope: proposal.body.scope });
    expect(created.status).toBe(201);
    const made = created.body.task;
    taxTask = { id: made.id, slug: made.slug, title: made.title, file: made.file, at: made.at };

    /** A commit on the code repository's default branch, at a date after the task was written (git keeps whole seconds). */
    const commitCode = (path: string, text: string, message: string, date: string): string => {
      writeFileSync(join(repository, path), text);
      const dated = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
      git(repository, ['add', '--', path], dated);
      git(repository, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message], dated);
      return git(repository, ['rev-parse', 'HEAD']).trim();
    };
    const afterWriting = (seconds: number): string => new Date(Date.parse(taxTask.at) + seconds * 1000).toISOString();

    // 1. It names the task but changes only the code file: the scope is the README section, so nothing closes.
    commitCode('src/a.ts', 'export function discount(percent: number): number {\n  return percent / 100;\n}\n', `Divide the discount by a hundred\n\nTask: ${taxTask.slug}`, afterWriting(1));
    const namesOnly = await get('/api/k/tasks');
    expect(taskRowOf(namesOnly, taxTask.id).status).toBe('open');
    expect(taskRowOf(namesOnly, taxTask.id).closedBy).toBeNull();

    // 2. It changes the README but names no task: nothing closes either.
    commitCode('README.md', '# Shop\n\n## Discounts\n\nEvery order gets ten percent, as this README always said.\n\n## Tax\n\nTax is added at checkout.\n', 'Rewrite the discount section', afterWriting(2));
    const changesOnly = await get('/api/k/tasks');
    expect(taskRowOf(changesOnly, taxTask.id).status).toBe('open');
    expect(taskRowOf(changesOnly, taxTask.id).closedBy).toBeNull();

    // 3. It names the task and changes a line of the section its scope names — the README's tax paragraph, which stands
    // after the `## Tax` heading — so the change reaches the scope (src/loop/closure.ts:53-59 for the name, :105-117
    // for the change of the section's own lines, :147-161 for the newest commit that does both).
    const closing = commitCode('README.md', '# Shop\n\n## Discounts\n\nEvery order gets ten percent.\n\n## Tax\n\nTax is added once, when the order is placed.\n', `Say when tax is added\n\nTask: ${taxTask.slug}`, afterWriting(3));
    const recorded = git(repository, ['log', '-1', '--format=%H%x1f%cI%x1f%s']).trim().split('\x1f');
    expect(recorded.length).toBe(3);
    expect(recorded[0]).toBe(closing);
    const closed = await get('/api/k/tasks');
    const row = taskRowOf(closed, taxTask.id);
    expect(row.status).toBe('closed');
    expect(row.closedBy).toEqual({ repository: CODE, commit: closing, at: recorded[1], subject: 'Say when tax is added' });
    expect(row.scope).toEqual([{ scope: TAX_SECTION, words: 'README.md#tax', place: { kind: 'section', label: 'Tax', where: 'Shop', href: '/k/doc?repo=orders-code&path=README.md#tax', path: 'README.md', words: 'README.md#tax' } }]);
    // The other task is untouched by these commits: none of them names it.
    expect(taskRowOf(closed, discountTask.id).status).toBe('open');
  }, 60_000);

  test('a section that holds a bold item and an unnamed paragraph closes on a commit that changes its last line', async () => {
    // A section's scope is the whole section — from its heading to the line before the next heading — whatever named or
    // unnamed blocks it holds inside (madarch-ztyq.3). The reading that ended it at its next anchor cut it off at its
    // first bold item, so the commit below touched no scope and the task stayed open.
    const answered = await post('/api/k/answer', { question: 'refund-window', text: 'Thirty days from the capture.' });
    expect(answered.status).toBe(200);
    const proposal = await post('/api/k/task-propose', { question: 'refund-window', choice: 'code' });
    expect(proposal.status).toBe(200);
    expect(proposal.body.scope).toEqual([REFUND_SECTION]);
    const created = await post('/api/k/task-create', { question: 'refund-window', title: proposal.body.title, grounds: proposal.body.grounds, scope: proposal.body.scope });
    expect(created.status).toBe(201);
    const task: { id: string; slug: string; at: string } = created.body.task;
    const commitReadme = (text: string, message: string, date: string): string => {
      writeFileSync(join(repository, 'README.md'), text);
      const dated = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
      git(repository, ['add', '--', 'README.md'], dated);
      git(repository, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message], dated);
      return git(repository, ['rev-parse', 'HEAD']).trim();
    };
    // The last line of the section is the unnamed paragraph after its two bold items.
    const closing = commitReadme(
      REFUNDS_README.replace('Refunds are paid back to the card that was charged.', 'Refunds are paid back to the card that was charged, in full or in part.'),
      `Say how a refund is paid back\n\nTask: ${task.slug}`,
      new Date(Date.parse(task.at) + 4000).toISOString(),
    );
    const row = taskRowOf(await get('/api/k/tasks'), task.id);
    expect(row.status).toBe('closed');
    expect(row.closedBy).toEqual({ repository: CODE, commit: closing, at: expect.any(String), subject: 'Say how a refund is paid back' });
    expect(row.scope).toEqual([{
      scope: REFUND_SECTION,
      words: 'README.md#refunds',
      place: { kind: 'section', label: 'Refunds', where: 'Shop', href: '/k/doc?repo=orders-code&path=README.md#refunds', path: 'README.md', words: 'README.md#refunds' },
    }]);
  }, 60_000);
});

describe('closing a task by hand', () => {
  test('a person closes a task in the wiki; the file says closed, and closing it again is refused', async () => {
    const closed = await post('/api/k/task-close', { id: discountTask.id });
    expect(closed.status).toBe(200);
    expect(closed.body.state).toBe('closed');
    expect(closed.body.committed).toBe(true);
    expect(closed.body.task.status).toBe('closed');
    expect(typeof closed.body.task.closedAt).toBe('string');
    expect(git(folder, ['log', '-1', '--format=%an <%ae>|%s']).trim()).toBe(`Ada Reader <ada@example.test>|Close the task ${discountTask.slug} by hand`);
    expect(git(folder, ['status', '--porcelain']).trim()).toBe('');
    // The file says how it closed (closed-by: person and closed-at), so a later read of it lists the task closed.
    const front = frontOf(join(folder, discountTask.file));
    expect(front['status']).toBe('closed');
    expect(front['closed-by']).toBe('person');
    expect(typeof front['closed-at']).toBe('string');
    const row = taskRowOf(await get('/api/k/tasks'), discountTask.id);
    expect(row.status).toBe('closed');
    expect(row.closedBy).toEqual({ person: true, at: front['closed-at'] as string });
    const again = await post('/api/k/task-close', { id: discountTask.id });
    // Closing a closed task is a conflict the reader can act on.
    expect(again.status).toBe(409);
    expect(again.body.message).toBe(`docs/tasks/${discountTask.slug}.md:1: the task ${discountTask.slug} is already closed`);
    // A task closed by hand marks nothing, and the other one closed by its commit marks nothing either: the planned
    // change is gone from the document (src/loop/planned.ts:82-89).
    const document = await get('/api/k/document?repo=orders-code&path=README.md');
    expect(document.body.planned).toEqual([]);
  }, 60_000);
});
