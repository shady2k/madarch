/**
 * The loop that closes the wiki on the generated training repository
 * (madarch-m38l.7), through the production path: the server, the fill worker
 * and a fake ACP agent behind an adapter executable on the PATH. The agent
 * asks a question for each item of the answer key where documents and code
 * disagree or the code is not documented; a person answers one in the wiki;
 * the next refresh edits only the page the answer touches, grounded in the
 * answer, and the question shows as closed by that rewrite. No model runs.
 *
 * The fill of the training repository takes minutes; the suite fills once.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { ORDERS_SERVICE, domainFields, fieldsCall } from './knowledge-agent-script.js';
import { PAY, SAMPLE_IDENTITY, ROOT, generateTrainingRepository, makeProduct, withoutEnrichmentKind } from './knowledge-fixture.js';
import { slugOf } from '../src/writer/names.js';
import { ANSWER_TEXT, LOOP_QUESTIONS, contradictionSides, firstRunScript, questionSlug, refreshScript } from './loop-agent-script.js';
import { SCRIPTED_GUIDE_PATH, SCRIPTED_GUIDE_SOURCE } from './scripted-guide-agent.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv(SAMPLE_IDENTITY), encoding: 'utf8' }).trim();
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The sentence of the ordering page the retention decision's first side stands on, and what a person says the code does. */
const READMES_KEEP_ORDERS = 'The root README and the orders README say orders are retained indefinitely.';
const REMOVED_AFTER_NINETY_DAYS = 'Orders that were not shipped are removed ninety days after they were placed, as the retention job does.';

/**
 * The ordering page's fields as the first run wrote them: the unit's own statements, then one grounded sentence for
 * each side of every contradiction it asked (madarch-m38l.13). `corrected` stands where the retention decision's
 * first side — the README one — stood.
 */
function orderingFields(corrected?: string): Record<string, unknown> {
  const fields = domainFields('en', 'ordering', ORDERS_SERVICE, ['doc:docs/requirements.md#uc-2', PAY]);
  return { ...fields, whatCanGoWrong: contradictionSides('ordering', 'en', corrected === undefined ? undefined : { item: 'contradiction.retention', index: 0, text: corrected }) };
}

interface KeyItem { id: string; location?: { path: string }; locations?: { path: string }[] }
const KEY = JSON.parse(readFileSync(join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8')) as { items: KeyItem[] };

let work: string;
let product: string;
let server: StartedServer;
let scriptFile: string;
const base = '/products/training-shop';

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}${base}${path}`);
  return { status: response.status, body: await response.json() };
};
const post = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}${base}${path}`, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, tries = 3000): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((rest) => setTimeout(rest, 500));
  }
  throw new Error(`gave up waiting for ${what}`);
}
const settled = (): Promise<any> => until('the fill and the agent stage to end', async () => (await get('/api/k/status')).body, (status) => status.fill.state !== 'running' && status.writer.state !== 'running' && status.writer.state !== 'waiting');

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-loop-training-'));
  const repository = generateTrainingRepository(join(work, 'repo'));
  writeFileSync(join(repository, SCRIPTED_GUIDE_PATH), SCRIPTED_GUIDE_SOURCE);
  git(repository, 'add', '--', SCRIPTED_GUIDE_PATH);
  git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Document the held readiness fixture');
  const home = join(work, 'home');
  mkdirSync(home);
  product = makeProduct(home, 'training-shop', repository);
  // The scripted agent writes the product and domain pages and no enrichment: the kind is dropped from the fixture, and
  // `test/writer-structured-entities.test.ts` is the one that scripts the enrichments.
  withoutEnrichmentKind(product);
  git(product, 'config', 'user.name', 'Ada Reader');
  git(product, 'config', 'user.email', 'ada@example.test');
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  // The agent is the fake ACP agent behind an adapter executable found by its name on the PATH, the way a real adapter is.
  const bin = join(work, 'bin');
  mkdirSync(bin);
  scriptFile = join(work, 'agent-script.json');
  writeFileSync(scriptFile, JSON.stringify(firstRunScript()));
  writeFileSync(join(bin, 'claude-agent-acp'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(ROOT, 'test/fixtures/acp-fake-agent/acp-fake-agent.ts'))} --scenario script --script ${JSON.stringify(scriptFile)}\n`);
  chmodSync(join(bin, 'claude-agent-acp'), 0o755);
  mkdirSync(join(work, 'user'));
  const env = { ...process.env, HOME: join(work, 'user'), MADARCH_HOME: join(work, 'user', 'madarch'), PATH: `${bin}:${process.env.PATH ?? ''}` };
  server = await startServer({ productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined, env });
  await fetch(`${server.url}${base}/api/k/status`);
}, 120_000);

afterAll(async () => {
  await server?.stop();
  rmSync(work, { recursive: true, force: true });
}, 120_000);

describe('the agent asks, a person answers, the refresh edits one page', () => {
  test('the first run: the agent files a question for each item of the answer key where documents and code disagree, and the pages are written', async () => {
    expect((await post('/api/k/agent', { agent: 'claude-code', install: false })).status).toBe(200);
    const started = await post('/api/k/fill', { agent: 'claude-code' });
    expect(started.status).toBe(202);
    const status = await settled();
    expect(status.fill.state).toBe('done');
    expect(status.writer.state).toBe('done');
    // Before the agent started, the wiki was told which pages the run touches: the product page did not exist yet.
    expect(status.writer.plan.pages.map((p: { path: string; reasons: { kind: string }[] }) => [p.path, p.reasons.map((r) => r.kind)])).toEqual([['docs/product.md', ['missing']]]);
    expect(status.writer.asked).toBe(LOOP_QUESTIONS.length);
    // Two retention paraphrases run through ACP too; the complete listing below still has one file for that decision.
    expect(status.loop).toEqual({ questionsOpen: LOOP_QUESTIONS.length, questionsAnswered: 0, correctionsOpen: 0 });
    expect(readdirSync(join(product, 'docs/questions')).sort()).toEqual(LOOP_QUESTIONS.map((q) => `${questionSlug(q, 'en')}.md`).sort());
    for (const page of ['docs/product.md', 'docs/domains/ordering.md', 'docs/domains/payments.md', 'docs/guides/administrator.md', 'docs/guides/user.md']) expect(existsSync(join(product, page))).toBe(true);
    for (const id of ['administrator-guide:main', 'user-guide:main']) {
      const guidePage = await get(`/api/k/page?id=${encodeURIComponent(id)}`);
      expect(guidePage.status).toBe(200);
      const guide = guidePage.body.blocks.find((block: { type: string }) => block.type === 'guide');
      expect(guide.data.guide.id).toBe(id);
      expect(guide.data.guide.procedures[0].steps[0].instruction.content).toBe('node -e "console.log(7)"');
      expect(guide.data.guide.procedures[0].steps[0].grounds.some((ground: { path: string }) => ground.path === SCRIPTED_GUIDE_PATH)).toBe(true);
      expect(guide.data.walk.status).toBe('not-walked');
      expect(guide.data.guide.gaps.length).toBeGreaterThan(0);
      expect(guide.data.coverage).toBe('procedures');
    }

  }, 3_000_000);

  test('every question is about the places the answer key names for its item, grounded in them, and none is a guess: each ground resolves', async () => {
    const listing = (await get('/api/k/questions')).body;
    expect(listing).toMatchObject({ open: LOOP_QUESTIONS.length, answered: 0, closed: 0, problems: [] });
    for (const loop of LOOP_QUESTIONS) {
      const item = KEY.items.find((candidate) => candidate.id === loop.item);
      if (item === undefined) throw new Error(`the answer key has no item ${loop.item}`);
      const paths = (item.locations ?? (item.location === undefined ? [] : [item.location])).map((place) => place.path);
      const detail = (await get(`/api/k/question?id=${questionSlug(loop, 'en')}`)).body;
      expect(detail).toMatchObject({ state: 'open', type: loop.type, askedIn: `domain:${loop.unit}` });
      const grounds: string[] = detail.sides.flatMap((side: { grounds: string[] }) => side.grounds);
      const groundPaths = grounds.map((ground) => ground.replace(/^code\.file:/, '').replace(/^doc:/, '').replace(/#.*$/, ''));
      for (const path of paths) expect({ item: loop.item, path, grounded: groundPaths.includes(path) }).toEqual({ item: loop.item, path, grounded: true });
      for (const ground of grounds) expect({ ground, state: detail.resolutions[ground]?.state }).toEqual({ ground, state: 'ok' });
    }
    expect(listing.rows.map((row: { title: string }) => row.title).sort()).toEqual(LOOP_QUESTIONS.map((q) => q.text.en.title).sort());
  }, 120_000);

  test('nothing the agent wrote names a place that is not there', async () => {
    const problems = (await get('/api/k/problems')).body;
    // The pages the agent scripted ground on the services of the repository; nothing it wrote names a place that is not there.
    expect(problems.problems.filter((p: { kind: string }) => p.kind === 'broken-link' || p.kind === 'unreadable-file')).toEqual([]);
  }, 120_000);

  test('a person answers one question in the wiki; the answer is a file of the product, committed as the person, and the plan names the one page it touches', async () => {
    const payment = LOOP_QUESTIONS.find((q) => q.item === 'term.payment-token')!;
    const slug = questionSlug(payment, 'en');
    const done = await post('/api/k/answer', { question: slug, text: ANSWER_TEXT.en });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ committed: true, state: 'answered', by: { name: 'Ada Reader', email: 'ada@example.test', verified: 'local, not verified' } });
    expect(git(product, 'log', '-1', '--format=%an <%ae>|%s')).toBe(`Ada Reader <ada@example.test>|Answer the question ${slug}`);
    expect(readFileSync(join(product, `docs/questions/${slug}.md`), 'utf8')).toContain(`> ${ANSWER_TEXT.en}`);
    const plan = (await get('/api/k/refresh-plan')).body;
    expect(plan.available).toBe(true);
    expect(plan.plan.pages.map((p: { path: string; reasons: { kind: string; question?: string }[] }) => [p.path, p.reasons.map((r) => `${r.kind}:${r.question ?? ''}`)])).toEqual([['docs/domains/payments.md', [`answer:${slug}`]]]);
    expect(plan.plan.unchanged).toEqual(['docs/domains/ordering.md', 'docs/product.md']);
    expect((await get('/api/k/status')).body.loop).toEqual({ questionsOpen: LOOP_QUESTIONS.length - 1, questionsAnswered: 1, correctionsOpen: 0 });
  }, 120_000);

  test('the next refresh edits only that page, grounded in the answer, and the question shows as closed by the rewrite', async () => {
    const payment = LOOP_QUESTIONS.find((q) => q.item === 'term.payment-token')!;
    const slug = questionSlug(payment, 'en');
    const before = { product: sha(join(product, 'docs/product.md')), ordering: sha(join(product, 'docs/domains/ordering.md')), payments: readFileSync(join(product, 'docs/domains/payments.md'), 'utf8') };
    writeFileSync(scriptFile, JSON.stringify(refreshScript('en')));
    expect((await post('/api/k/fill', { agent: 'claude-code' })).status).toBe(202);
    const status = await settled();
    expect({ fill: status.fill.state, writer: status.writer.state, message: status.writer.message }).toMatchObject({ fill: 'done', writer: 'done' });
    // One unit ran, the payments one; the other pages cost no agent run.
    expect(status.writer.units.filter((unit: { calls?: number }) => (unit.calls ?? 0) > 0).map((unit: { unit: string }) => unit.unit)).toEqual(['domain:payments']);
    expect(status.writer.plan.pages.map((p: { path: string }) => p.path)).toEqual(['docs/domains/payments.md']);
    expect(status.writer.asked).toBe(0);
    expect(readdirSync(join(product, 'docs/questions'))).toHaveLength(LOOP_QUESTIONS.length);
    expect(sha(join(product, 'docs/product.md'))).toBe(before.product);
    expect(sha(join(product, 'docs/domains/ordering.md'))).toBe(before.ordering);
    const after = readFileSync(join(product, 'docs/domains/payments.md'), 'utf8');
    // The sentence that stood keeps its text and its footnote name — the whole line is the same in both pages — and
    // the rule the answer settles stands on the answer.
    const charged = 'Payments are charged through one of two providers chosen by configuration.';
    const lineIn = (markdown: string, sentence: string): string | undefined => markdown.split('\n').find((line) => line.includes(sentence));
    expect(lineIn(before.payments, charged)).toBeDefined();
    expect(lineIn(after, charged)).toBe(lineIn(before.payments, charged));
    expect(after).toContain('The payment token the documents mention is the CardToken, the vault reference to a card, as a person decided.');
    expect(after).toContain(`(madarch:question:${slug})`);
    const detail = (await get(`/api/k/question?id=${slug}`)).body;
    expect(detail).toMatchObject({ state: 'closed', closedBy: ['domain:payments'], answer: { text: ANSWER_TEXT.en } });
    expect(detail.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const listing = (await get('/api/k/questions')).body;
    expect([listing.open, listing.answered, listing.closed]).toEqual([LOOP_QUESTIONS.length - 1, 0, 1]);
    // A refresh now has nothing to do: no page, no agent.
    const next = (await get('/api/k/refresh-plan')).body;
    expect(next.plan.pages).toEqual([]);
    expect(next.plan.unchanged).toEqual(['docs/domains/ordering.md', 'docs/domains/payments.md', 'docs/product.md']);
    // The answer and the rewrite are in the graph: what stands on the answer is the new sentence.
    const problems = (await get('/api/k/problems')).body;
    expect(problems.problems.filter((p: { kind: string }) => p.kind === 'broken-link')).toEqual([]);
  }, 3_000_000);
});

describe('an answer scopes a task, marks only what it reaches, fixes those pages and closes on its commit', () => {
  const retention = LOOP_QUESTIONS.find((question) => question.item === 'contradiction.retention')!;
  const slug = questionSlug(retention, 'en');
  const answer = 'Orders that were not shipped are removed ninety days after they were placed; the README says they are kept, and the code is right.';
  const taskSlug = slugOf(`Update the documents: ${retention.text.en.title}`);
  let proposed: any;

  test('the answer proposes a task whose scope is the two README sections the question names, not their files', async () => {
    expect((await post('/api/k/answer', { question: slug, text: answer })).status).toBe(200);
    const proposal = await post('/api/k/task-propose', { question: slug, choice: 'code' });
    expect(proposal.status).toBe(200);
    proposed = proposal.body;
    // «Прав код, документ устарел»: the documents the answer names, each as the section that is wrong.
    expect(proposed.title).toBe(`Update the documents: ${retention.text.en.title}`);
    expect(proposed.scope).toEqual([
      { type: 'section', path: 'README.md', anchor: 'what-it-does' },
      { type: 'section', path: 'services/orders/README.md', anchor: 'orders-service' },
    ]);
    expect(proposed.grounds).toEqual(['code.file\u003aservices/orders/internal/application/order_service.go', 'doc:README.md#what-it-does', 'doc:services/orders/README.md#orders-service']);
    // The impact is read through the graph: the ordering page's sentences that stand on the two sections.
    expect(proposed.impact.pages.map((page: { id: string }) => page.id)).toContain('domain:ordering');
    expect(proposed.impact.statements.length).toBeGreaterThan(0);
    // One sentence stands on both README sections: it is listed once, naming every ground that reached it.
    expect([...new Set(proposed.impact.statements.flatMap((statement: { grounds: string[] }) => statement.grounds))].sort())
      .toEqual(['doc:README.md#what-it-does', 'doc:services/orders/README.md#orders-service']);
    // The sections are also stated on the question pages the agent wrote: they are reached as well.
    const onOrdering = proposed.impact.statements.filter((statement: { page: string }) => statement.page === 'domain:ordering');
    expect(onOrdering.length).toBeGreaterThan(0);
    for (const statement of proposed.impact.statements) expect(statement.page).toMatch(/^(domain|product|question|correction):/);
    // Nothing is written before the reader confirms.
    expect(readdirSync(join(product, 'docs')).includes('tasks')).toBe(false);
  }, 120_000);

  test('confirming writes the task as the reader, and only the sections and statements it reaches are marked', async () => {
    const created = await post('/api/k/task-create', { question: slug, title: proposed.title, grounds: proposed.grounds, scope: proposed.scope });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: 'created', committed: true, task: { id: `task:${taskSlug}`, file: `docs/tasks/${taskSlug}.md`, status: 'open' } });
    expect(git(product, 'log', '-1', '--format=%an <%ae>|%s')).toBe(`Ada Reader <ada@example.test>|Plan the task ${taskSlug}`);
    const file = readFileSync(join(product, `docs/tasks/${taskSlug}.md`), 'utf8');
    for (const line of ['id: task:', 'kind: task', 'status: open', `question: question:${slug}`, `answer: answer:${slug}`, 'type: section', 'path: README.md', 'anchor: what-it-does']) expect(file).toContain(line);

    const listing = (await get('/api/k/tasks')).body;
    expect(listing).toMatchObject({ open: 1, closed: 0, problems: [] });
    expect(listing.tasks[0]).toMatchObject({ id: `task:${taskSlug}`, status: 'open', closedBy: null, impact: { pages: proposed.impact.counts.pages, statements: proposed.impact.counts.statements } });

    // The badge stands on the two sections and nowhere else in the documents.
    const readme = (await get(`/api/k/document?repo=training&path=${encodeURIComponent('README.md')}`)).body;
    expect(readme.planned).toEqual([{ anchor: 'what-it-does', lines: null, how: 'scope', task: { id: `task:${taskSlug}`, slug: taskSlug, title: proposed.title, file: `docs/tasks/${taskSlug}.md` } }]);
    const orders = (await get(`/api/k/document?repo=training&path=${encodeURIComponent('services/orders/README.md')}`)).body;
    expect(orders.planned.map((mark: { anchor: string }) => mark.anchor)).toEqual(['orders-service']);
    for (const path of ['docs/requirements.md', 'docs/adr/0002-outbox.md', 'docs/architecture.md']) {
      const other = (await get(`/api/k/document?repo=training&path=${encodeURIComponent(path)}`)).body;
      expect({ path, planned: other.planned }).toEqual({ path, planned: [] });
    }
    // The statements that stand on those sections say their ground will change; the payments page stands on neither.
    const ordering = (await get('/api/k/page?id=' + encodeURIComponent('domain:ordering'))).body;
    expect(ordering.planned.entity).toMatchObject({ how: 'impact', task: { id: `task:${taskSlug}` } });
    expect(ordering.planned.statements.map((mark: { sentence: string; how: string }) => mark.how)).toEqual(ordering.planned.statements.map(() => 'impact'));
    expect(ordering.planned.statements.length).toBe(proposed.impact.statements.filter((statement: { page: string }) => statement.page === 'domain:ordering').length);
    const payments = (await get('/api/k/page?id=' + encodeURIComponent('domain:payments'))).body;
    expect(payments.planned.statements).toEqual([]);
  }, 120_000);

  test('«Поправить страницы сейчас» runs the scripted agent over exactly the impacted page and rewrites nothing else', async () => {
    const before = {
      product: sha(join(product, 'docs/product.md')),
      payments: sha(join(product, 'docs/domains/payments.md')),
      ordering: readFileSync(join(product, 'docs/domains/ordering.md'), 'utf8'),
    };
    // The agent's page: the ordering page's fields as the first run wrote them, with the sentence the README ground
    // reached now stating the code's rule.
    expect(before.ordering).toContain(READMES_KEEP_ORDERS);
    const written = orderingFields(REMOVED_AFTER_NINETY_DAYS);
    expect(JSON.stringify(written)).not.toContain(READMES_KEEP_ORDERS);
    writeFileSync(scriptFile, JSON.stringify({ byPrompt: [{ matches: `(madarch:task:${taskSlug})`, steps: [fieldsCall(written), { end: { stopReason: 'end_turn' } }] }], steps: [{ end: { stopReason: 'end_turn' } }] }));
    const started = await post('/api/k/task-run', { id: `task:${taskSlug}` });
    expect(started.status).toBe(202);
    expect(started.body.pages).toEqual(['docs/domains/ordering.md']);
    const status = await settled();
    expect({ writer: status.writer.state, message: status.writer.message }, JSON.stringify(status.writer.units)).toMatchObject({ writer: 'done' });
    expect(status.writer.plan.pages.map((page: { path: string; reasons: { kind: string }[] }) => [page.path, page.reasons.map((reason) => reason.kind)])).toEqual([['docs/domains/ordering.md', ['task']]]);
    expect(status.writer.units.filter((unit: { calls?: number }) => (unit.calls ?? 0) > 0).map((unit: { unit: string }) => unit.unit)).toEqual(['domain:ordering']);
    expect(sha(join(product, 'docs/product.md'))).toBe(before.product);
    expect(sha(join(product, 'docs/domains/payments.md'))).toBe(before.payments);
    const ordering = readFileSync(join(product, 'docs/domains/ordering.md'), 'utf8');
    expect(ordering).toContain(REMOVED_AFTER_NINETY_DAYS);
    expect(ordering).not.toContain(READMES_KEEP_ORDERS);
    // Every side of every contradiction the page kept still stands, with the question link at the end of its sentence.
    for (const question of LOOP_QUESTIONS.filter((held) => held.unit === 'ordering' && held.type === 'contradiction')) {
      const claims = question.item === 'contradiction.retention' ? [REMOVED_AFTER_NINETY_DAYS, question.text.en.claims[1]!] : question.text.en.claims;
      for (const claim of claims) expect(ordering).toContain(claim);
      expect(ordering).toContain(`(madarch:question:${questionSlug(question, 'en')})`);
    }
  }, 3_000_000);

  test('a commit closes the task only when it names the task and touches its scope', async () => {
    const repository = join(product, 'repos/training');
    const readme = (): string => readFileSync(join(repository, 'README.md'), 'utf8');
    const edit = (from: string, to: string): void => {
      const text = readme();
      if (!text.includes(from)) throw new Error(`${join(repository, 'README.md')}: the README no longer holds ${JSON.stringify(from)}, so this commit would change nothing`);
      writeFileSync(join(repository, 'README.md'), text.replace(from, to));
    };
    const commit = (message: string, path: string, change: () => void): string => {
      change();
      git(repository, 'add', '--', path);
      git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message);
      return git(repository, 'rev-parse', 'HEAD');
    };
    const codePath = 'services/orders/internal/application/order_service.go';
    const open = async (): Promise<any> => (await get('/api/k/tasks')).body.tasks[0];
    // It names another task: nothing closes, whatever the file.
    commit('Touch the README for another reason\n\nTask: some-other-task', 'README.md', () => edit('applies a 10% discount', 'applies a 10 per cent discount'));
    expect(await open()).toMatchObject({ status: 'open', closedBy: null });
    // It names this task but changes no file of its scope.
    const code = readFileSync(join(repository, codePath), 'utf8');
    commit(`A code change that is not in the task's scope\n\nTask: ${taskSlug}`, codePath, () => writeFileSync(join(repository, codePath), `${code}\n// A comment outside the task's scope.\n`));
    expect(await open()).toMatchObject({ status: 'open', closedBy: null });
    // It names the task and changes the same file, but another section of it: the scope is the section, not the file.
    commit(`A change to how the service is run\n\nTask: ${taskSlug}`, 'README.md', () => edit('Prerequisites: Go 1.22, Node 20, Docker Compose and psql.', 'Prerequisites: Go 1.22, Node 20, Docker Compose and psql 16.'));
    expect(await open()).toMatchObject({ status: 'open', closedBy: null });
    // It names the task and changes the section the task's scope names: the task closes with that commit.
    const closing = commit('Say what the retention job does\n\nTask: ' + taskSlug, 'README.md', () => edit('Orders are retained indefinitely.', 'Orders that were not shipped are removed ninety days after they were placed.'));
    const listed = (await get('/api/k/tasks')).body;
    expect(listed).toMatchObject({ open: 0, closed: 1 });
    expect(listed.tasks[0].closedBy).toEqual({ repository: 'training', commit: closing, at: expect.any(String), subject: 'Say what the retention job does' });
    // A closed task marks nothing: the sections are no longer planned changes.
    const after = (await get(`/api/k/document?repo=training&path=${encodeURIComponent('README.md')}`)).body;
    expect(after.planned).toEqual([]);
    // Closing it again, by hand, is refused: it is closed already.
    expect((await post('/api/k/task-close', { id: `task:${taskSlug}` })).status).toBe(409);
  }, 120_000);
});
