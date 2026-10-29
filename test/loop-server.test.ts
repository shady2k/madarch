/**
 * The loop over HTTP (madarch-m38l.7): the questions, a question's page, a
 * person's answer and correction, the problems and the refresh plan, as the
 * wiki app asks for them. The repository is a tiny fixture built here; the
 * product's pages and questions are written here as an agent would.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderQuestion, type Question } from '../src/loop/entities.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

let work: string;
let server: StartedServer;
let folder: string;

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
  about: ['domain:orders'], askedIn: 'domain:orders', askedAt: '2026-10-23T10:00:00.000Z',
  question: 'Which discount does an order get?', why: 'A shopper is told one number and charged another.',
  sides: [{ claim: 'The README says every order gets ten percent.', grounds: ['doc:README.md#discounts'] }, { claim: 'The code applies the percentage its caller passes.', grounds: ['code.file\u003asrc/a.ts'] }],
  answer: null, resolvedBy: [], resolvedAt: null, writtenAt: [],
};

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/orders-shop${path}`);
  return { status: response.status, body: await response.json() };
};
const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/orders-shop${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-loop-server-'));
  const repository = join(work, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  git(repository, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repository, 'src', 'a.ts'), 'export function leaf(): number {\n  return 1;\n}\n');
  writeFileSync(join(repository, 'README.md'), '# Shop\n\n## Discounts\n\nEvery order gets ten percent.\n');
  git(repository, 'add', '.');
  git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'first', '--date', '2026-03-01T10:00:00Z');
  const home = join(work, 'home');
  mkdirSync(home);
  folder = makeProduct(home, 'orders-shop', repository, 'orders-code');
  git(folder, 'config', 'user.name', 'Ada Reader');
  git(folder, 'config', 'user.email', 'ada@example.test');
  mkdirSync(join(folder, 'docs/domains'), { recursive: true });
  mkdirSync(join(folder, 'docs/questions'), { recursive: true });
  writeFileSync(join(folder, 'docs/domains/orders.md'), PAGE);
  writeFileSync(join(folder, 'docs/questions/discount-percentage.md'), renderQuestion(QUESTION));
  git(folder, 'add', '-A');
  git(folder, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'the agent wrote');
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  server = await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined });
  await fetch(`${server.url}/products/orders-shop/api/k/status`);
}, 60_000);

afterAll(async () => {
  await server.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('the questions', () => {
  test('are listed from their files, and the status counts the ones waiting', async () => {
    const listing = await get('/api/k/questions');
    expect(listing.status).toBe(200);
    expect(listing.body).toMatchObject({ open: 1, answered: 0, closed: 0, problems: [] });
    expect(listing.body.rows).toEqual([{ slug: 'discount-percentage', id: 'question:discount-percentage', title: QUESTION.title, type: 'contradiction', state: 'open', askedIn: 'domain:orders', askedAt: '2026-10-23T10:00:00.000Z', about: ['domain:orders'], answeredBy: null, answeredAt: null, closedBy: [] }]);
    expect((await get('/api/k/status')).body.loop).toEqual({ questionsOpen: 1, questionsAnswered: 0, correctionsOpen: 0 });
  });

  test('a question comes with both sides, its grounds resolved against what the wiki holds, and the reason a ground does not resolve', async () => {
    const detail = await get('/api/k/question?id=discount-percentage');
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ slug: 'discount-percentage', state: 'open', file: 'docs/questions/discount-percentage.md', question: 'Which discount does an order get?', why: 'A shopper is told one number and charged another.', answer: null });
    expect(detail.body.sides.map((side: { claim: string }) => side.claim)).toEqual(['The README says every order gets ten percent.', 'The code applies the percentage its caller passes.']);
    // Nothing is filled yet: the graph key does not resolve, and the answer says why in words; the page it is about does.
    expect(detail.body.resolutions['code.file\u003asrc/a.ts']).toMatchObject({ state: 'broken' });
    expect(detail.body.resolutions['domain:orders']).toMatchObject({ state: 'ok', kind: 'domain', href: '/k/e/domain%3Aorders' });
  });

  test('a question that is not there is a 404 that names the file; an id that is none is a 400', async () => {
    const missing = await get('/api/k/question?id=no-such-question');
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe('there is no question no-such-question: docs/questions/no-such-question.md is not in the product repository');
    expect((await get('/api/k/question?id=Bad%20One')).status).toBe(400);
    expect((await get('/api/k/question')).status).toBe(400);
  });

  test('an answer lands in the file, is committed as the person, and is refused where it should be', async () => {
    const foreign = await post('/api/k/answer', { question: 'discount-percentage', text: 'Ten percent.' }, { 'sec-fetch-site': 'cross-site' });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.message).toContain('made from another site');
    expect((await post('/api/k/answer', 'not json')).status).toBe(400);
    expect((await post('/api/k/answer', { text: 'x' })).body.error.field).toBe('question');
    expect((await post('/api/k/answer', { question: 'discount-percentage' })).body.error.field).toBe('text');
    const plain = await fetch(`${server.url}/products/orders-shop/api/k/answer`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ question: 'discount-percentage', text: 'Ten.' }) });
    expect(plain.status).toBe(415);
    const empty = await post('/api/k/answer', { question: 'discount-percentage', text: '  ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toContain('the answer is empty');
    const done = await post('/api/k/answer', { question: 'discount-percentage', text: 'Ten percent for every order.' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ question: 'discount-percentage', state: 'answered', committed: true, by: { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' } });
    expect(git(folder, 'log', '-1', '--format=%an <%ae>|%s').trim()).toBe('Ada Reader <ada@example.test>|Answer the question discount-percentage');
    expect(readFileSync(join(folder, 'docs/questions/discount-percentage.md'), 'utf8')).toContain('> Ten percent for every order.');
    const again = await post('/api/k/answer', { question: 'discount-percentage', text: 'Twelve.' });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('already answered');
    const detail = await get('/api/k/question?id=discount-percentage');
    expect(detail.body).toMatchObject({ state: 'answered', answer: { text: 'Ten percent for every order.', by: { name: 'Ada Reader' } } });
    expect((await get('/api/k/status')).body.loop).toEqual({ questionsOpen: 0, questionsAnswered: 1, correctionsOpen: 0 });
  });
});

describe('the corrections and the problems', () => {
  test('a correction is a file of the product, committed as the person, and listed with who fixes it', async () => {
    expect((await post('/api/k/correction', { statement: 'domain:orders#ten-percent-discount', reason: 'x' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post('/api/k/correction', { reason: 'x' })).body.error.field).toBe('statement');
    expect((await post('/api/k/correction', { statement: 'domain:orders#ten-percent-discount' })).body.error.field).toBe('reason');
    const missing = await post('/api/k/correction', { statement: 'domain:orders#no-such-statement', reason: 'wrong' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toContain('the product has no statement domain:orders#no-such-statement');
    const done = await post('/api/k/correction', { statement: 'domain:orders#ten-percent-discount', reason: 'The discount is whatever the caller passes.' });
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ correction: 'ten-percent-discount-discount', id: 'correction:ten-percent-discount-discount', file: 'docs/corrections/ten-percent-discount-discount.md', committed: true, by: { name: 'Ada Reader' } });
    expect(git(folder, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Ada Reader <ada@example.test>');
    expect((await get('/api/k/status')).body.loop.correctionsOpen).toBe(1);
    const problems = await get('/api/k/problems');
    expect(problems.status).toBe(200);
    const correction = problems.body.problems.find((p: { kind: string }) => p.kind === 'correction');
    expect(correction).toMatchObject({ fixer: 'agent', closed: false, page: 'domain:orders', statement: 'ten-percent-discount', sentence: 'Orders get a ten percent discount.', reason: 'The discount is whatever the caller passes.', file: 'docs/corrections/ten-percent-discount-discount.md', by: { name: 'Ada Reader' } });
  });

  test('what the engine finds is listed beside them: a ground that names nothing, with the file, the line and who fixes it', async () => {
    const problems = (await get('/api/k/problems')).body;
    // Nothing is filled: the page stands on a service and a document section the graph does not hold yet.
    const broken = problems.problems.filter((p: { kind: string }) => p.kind === 'broken-link');
    expect(broken.length).toBeGreaterThan(0);
    expect(broken[0]).toMatchObject({ fixer: 'agent', closed: false, file: 'docs/domains/orders.md' });
    expect(typeof broken[0].line).toBe('number');
    expect(broken[0].reason.length).toBeGreaterThan(10);
    expect(problems.notes.join(' ')).toContain('single code repository');
    expect(problems.open).toBe(problems.problems.length);
  });


  test('the listing has the three sections, and every row carries its rule, Sonar kind, severity, place, entity and evidence', async () => {
    const problems = (await get('/api/k/problems')).body;
    expect(Object.keys(problems.sections).sort()).toEqual(['code', 'documents', 'wiki']);
    expect(problems.sections.documents).toBeGreaterThan(0);
    expect(problems.sections.wiki).toBeGreaterThan(0);
    for (const row of problems.problems) {
      expect(typeof row.id).toBe('string');
      expect(row.id).toContain('\u0000');
      expect(['code', 'documents', 'wiki']).toContain(row.section);
      expect(typeof row.rule).toBe('string');
      expect(['vulnerability', 'bug', 'code-smell', 'security-hotspot']).toContain(row.sonar);
      expect(['blocker', 'critical', 'major', 'minor', 'info']).toContain(row.severity);
      expect(row.reason.length).toBeGreaterThan(10);
      expect(row.place).not.toBeNull();
      expect(Array.isArray(row.evidence)).toBe(true);
    }
    const documents = problems.problems.filter((row: { section: string }) => row.section === 'documents');
    expect(documents.map((row: { rule: string }) => row.rule)).toContain('document.contradiction');
    expect(documents.find((row: { rule: string }) => row.rule === 'document.contradiction')).toMatchObject({
      kind: 'document-contradiction', sonar: 'bug', severity: 'major', file: 'docs/questions/discount-percentage.md', entity: { key: 'question:discount-percentage' },
    });
    const wiki = problems.problems.find((row: { rule: string }) => row.rule === 'wiki.broken-link');
    expect(wiki).toMatchObject({ section: 'wiki', kind: 'broken-link', sonar: 'bug', severity: 'major', page: 'domain:orders', fixer: 'agent', place: { key: 'domain:orders' }, entity: { key: 'domain:orders' } });
    expect(wiki.id).toBe('wiki.broken-link\u0000domain:orders\u0000ten-percent-discount\u0000doc:README.md#discounts');
    const onEntity = problems.problems.filter((row: { entity: { key: string } | null }) => row.entity?.key === 'domain:orders').length;
    expect(onEntity).toBeGreaterThan(0);
    const entityPage = (await get('/api/k/page?id=domain%3Aorders&lang=en')).body;
    expect(entityPage.problems).toBe(onEntity);
  });

  test('«Не проблема» writes the person\'s reason as a file of the product, commits it, and the listing leaves it out', async () => {
    const before = (await get('/api/k/problems')).body;
    const broken = before.problems.find((row: { rule: string }) => row.rule === 'wiki.broken-link');
    expect(broken).toBeDefined();
    const done = await post('/api/k/problem-dismiss', { id: broken.id, reason: 'The README section is written by the fill itself.' });
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({ committed: true });
    expect(done.body.file).toStartWith('docs/problems/');
    const text = readFileSync(join(folder, done.body.file), 'utf8');
    expect(text).toContain('kind: problem-dismissal');
    expect(text).toContain('rule: wiki.broken-link');
    expect(text).toContain('reason: The README section is written by the fill itself.');
    expect(git(folder, 'log', '-1', '--format=%s').trim()).toBe('Record that a problem is not one');
    const after = (await get('/api/k/problems')).body;
    expect(after.problems.some((row: { id: string }) => row.id === broken.id)).toBe(false);
    expect(after.dismissed).toBe(1);
    expect(after.sections.wiki).toBe(before.sections.wiki - 1);
    const again = await post('/api/k/problem-dismiss', { id: broken.id, reason: 'Still not a problem.' });
    expect(again.status).toBe(404);
    expect(again.body.error.message).toContain('there is no problem');
  });

  test('«Создать задачу» opens a task scoped to the place the problem names', async () => {
    const listing = (await get('/api/k/problems')).body;
    const contradiction = listing.problems.find((row: { rule: string }) => row.rule === 'document.contradiction');
    expect(contradiction.scope).toEqual({ type: 'file', path: 'docs/questions/discount-percentage.md' });
    const created = await post('/api/k/problem-task', { id: contradiction.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: 'created' });
    expect(created.body.task.slug).toStartWith('fix-document-contradiction');
    const tasks = (await get('/api/k/tasks')).body;
    const row = tasks.tasks.find((task: { slug: string }) => task.slug === created.body.task.slug);
    expect(row).toMatchObject({ title: 'Fix document.contradiction in docs/questions/discount-percentage.md:1' });
    expect(row.problemId).toBe(contradiction.id);
    expect(row.scope.map((one: { scope: { type: string; path?: string } }) => [one.scope.type, one.scope.path])).toEqual([['file', 'docs/questions/discount-percentage.md']]);
    const taskPage = (await get(`/api/k/task?id=${encodeURIComponent(created.body.task.id)}`)).body;
    expect(taskPage.problemId).toBe(contradiction.id);
    expect(taskPage.question).toBe('');
  });

  test('a file that cannot be read is a problem for a person, naming the file and the line', async () => {
    writeFileSync(join(folder, 'docs/questions/broken-one.md'), 'no front matter\n');
    try {
      const problems = (await get('/api/k/problems')).body;
      const unreadable = problems.problems.find((p: { kind: string; file: string }) => p.kind === 'unreadable-file' && p.file === 'docs/questions/broken-one.md');
      expect(unreadable).toMatchObject({ fixer: 'person', line: 1 });
      expect(unreadable.reason).toContain('the file has no front matter');
      expect((await get('/api/k/questions')).body.problems).toEqual(['docs/questions/broken-one.md:1: the file has no front matter: it starts with --- , its fields, ---']);
    } finally {
      rmSync(join(folder, 'docs/questions/broken-one.md'));
    }
  });
});

describe('the refresh plan', () => {
  test('before anything is read it says so; after the fill it says which pages the refresh will touch and why, and what it leaves alone', async () => {
    const before = await get('/api/k/refresh-plan');
    expect(before.body).toEqual({ available: false, reason: 'nothing has been read from the code yet: start the fill once to read it' });
    expect((await get('/api/k/refresh-plan?language=de')).status).toBe(400);
    expect((await post('/api/k/fill', {})).status).toBe(202);
    let status = (await get('/api/k/status')).body;
    for (let tries = 0; tries < 1200 && status.fill.state === 'running'; tries += 1) {
      await new Promise((rest) => setTimeout(rest, 100));
      status = (await get('/api/k/status')).body;
    }
    expect(status.fill.state).toBe('done');
    const after = await get('/api/k/refresh-plan');
    expect(after.status).toBe(200);
    expect(after.body.available).toBe(true);
    // There is no product page: it is missing. The domain page has a correction waiting and an answered question about it.
    expect(after.body.plan.pages.map((p: { path: string; reasons: { kind: string }[] }) => [p.path, p.reasons.map((r) => r.kind).sort()])).toEqual([
      ['docs/domains/orders.md', ['answer', 'correction']],
      ['docs/product.md', ['missing']],
    ]);
    expect(after.body.plan.unchanged).toEqual([]);
    expect(after.body.language).toEqual({ from: 'en', to: 'en', changed: false });
    expect(after.body.commitsNotRead).toBe(0);
    const russian = (await get('/api/k/refresh-plan?language=ru')).body;
    expect(russian.language).toEqual({ from: 'en', to: 'ru', changed: true });
    expect(russian.plan.pages.find((p: { path: string }) => p.path === 'docs/domains/orders.md').reasons.map((r: { kind: string }) => r.kind)).toContain('language');
  }, 300_000);
});
