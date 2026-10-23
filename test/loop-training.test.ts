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
import { SAMPLE_IDENTITY, ROOT, generateTrainingRepository, makeProduct } from './knowledge-fixture.js';
import { ANSWER_TEXT, LOOP_QUESTIONS, firstRunScript, questionSlug, refreshScript } from './loop-agent-script.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv(SAMPLE_IDENTITY), encoding: 'utf8' }).trim();
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

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
  const home = join(work, 'home');
  mkdirSync(home);
  product = makeProduct(home, 'training-shop', repository);
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
    expect(status.writer.message).toContain(`The agent asked ${LOOP_QUESTIONS.length} questions`);
    expect(status.loop).toEqual({ questionsOpen: LOOP_QUESTIONS.length, questionsAnswered: 0, correctionsOpen: 0 });
    expect(readdirSync(join(product, 'docs/questions')).sort()).toEqual(LOOP_QUESTIONS.map((q) => `${questionSlug(q, 'en')}.md`).sort());
    for (const page of ['docs/product.md', 'docs/domains/ordering.md', 'docs/domains/payments.md']) expect(existsSync(join(product, page))).toBe(true);
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
    expect(sha(join(product, 'docs/product.md'))).toBe(before.product);
    expect(sha(join(product, 'docs/domains/ordering.md'))).toBe(before.ordering);
    const after = readFileSync(join(product, 'docs/domains/payments.md'), 'utf8');
    // The sentence that stood keeps its text and its footnote name; the new one stands on the answer.
    const kept = before.payments.split('\n').find((line) => /\[\^[\w-]+\]$/.test(line) && line.startsWith('Payments are charged'))!;
    expect(after).toContain(kept);
    expect(after).toContain('The payment token the documents mention is the CardToken, the vault reference to a card, as a person decided.[^payment-token-means-cardtoken]');
    expect(after).toContain(`[^payment-token-means-cardtoken]: [the answer](madarch:question:${slug})`);
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
