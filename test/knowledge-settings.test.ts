/**
 * The product made by an earlier madarch, opened by this one, and the settings of a product (madarch-m38l.11): the
 * old manifest and templates are brought to the current starter set when the wiki first reads them (a file only madarch
 * wrote), an edited manifest is left byte for byte and the Problems page offers what it lacks, the model and reasoning
 * level are the agent's own to name, «Rewrite the pages» and «Start from scratch» do what they say and nothing more.
 * Fixtures only: a draft product, a tiny generated repository, an injected agent and fill worker.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct, type FillWorkerHandle } from '../src/knowledge/product.js';
import { STARTER_FILES, starterManifest } from '../src/knowledge/seed.js';
import { parseQuestion, renderQuestion } from '../src/loop/entities.js';
import type { AgentChoices } from '../src/fill/acp-choices.js';
import { createKnowledgePart } from '../src/server/knowledge.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';

const FIXTURE = join(import.meta.dir, 'fixtures', 'product-0.2.0');
let root: string | undefined;
const open: KnowledgeProduct[] = [];
afterEach(async () => {
  for (const product of open.splice(0)) await product.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const env = (): Record<string, string> => gitEnv(SAMPLE_IDENTITY);
const git = (folder: string, ...args: string[]): string => execFileSync('git', args, { cwd: folder, env: env(), encoding: 'utf8' }).trim();

/** A draft product with a linked repository, turned into what madarch 0.2.0 left: its first commit and the loop's working changes. */
function oldProduct(): { folder: string; store: string } {
  root = mkdtempSync(join(tmpdir(), 'madarch-settings-'));
  const repository = join(root, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  git(repository, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
  git(repository, 'add', '.');
  git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'one');
  const home = join(root, 'home');
  mkdirSync(home);
  const folder = makeProduct(home, 'tiny', repository, 'tiny');
  rmSync(join(folder, 'templates'), { recursive: true, force: true });
  cpSync(join(FIXTURE, 'committed'), folder, { recursive: true });
  git(folder, 'add', '-A');
  git(folder, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--amend', '-m', 'Create the draft product');
  cpSync(join(FIXTURE, 'working'), folder, { recursive: true });
  return { folder, store: join(root, 'store') };
}

/** A fill worker that ends at once: the press is counted, no code is read. */
function quickWorker(counter: { started: number }): () => FillWorkerHandle {
  return () => {
    counter.started += 1;
    return { send: () => undefined, lines: (async function* () { /* says nothing */ })(), exited: Promise.resolve(0), stderr: () => '', kill: () => undefined };
  };
}

function product(folder: string, store: string, extra: Partial<ConstructorParameters<typeof KnowledgeProduct>[0]> = {}): KnowledgeProduct {
  const held = new KnowledgeProduct({ productFolder: folder, storeRoot: store, env: { HOME: join(root!, 'user'), PATH: join(root!, 'none') }, ...extra });
  open.push(held);
  return held;
}

describe('a product made by an earlier madarch, opened by this one', () => {
  test('its manifest and templates are brought to the current set: every kind has its group, the roles are declared, the contracts and routes are there', async () => {
    const { folder, store } = oldProduct();
    const logged: string[] = [];
    const held = product(folder, store, { errorLog: (line) => logged.push(line) });
    const status = await held.status();
    expect(status.manifest).toBe('ok');
    // The product holds no document at all, and the manifest the wiki now has names the four kinds its documents must
    // hold: the wiki says what they lack, at the line that declares it, instead of showing a smaller wiki (decision 0032,
    // section 4). Its documents holding every kind is the training product's case, which reads with no finding.
    const manifestFile = join(folder, 'madarch', 'kinds.yaml');
    const expectLine = readFileSync(manifestFile, 'utf8').split('\n').findIndex((line) => line.trim().startsWith('expect: [')) + 1;
    expect(expectLine).toBeGreaterThan(1);
    expect(status.findings).toEqual([
      { file: manifestFile, line: expectLine, message: expect.stringContaining('the documents hold no entity of kind "doc.use-case" (a scenario)') },
      { file: manifestFile, line: expectLine, message: expect.stringContaining('the documents hold no entity of kind "doc.rule" (a rule)') },
      { file: manifestFile, line: expectLine, message: expect.stringContaining('the documents hold no entity of kind "doc.requirement" (a quality)') },
      { file: manifestFile, line: expectLine, message: expect.stringContaining('the documents hold no entity of kind "doc.decision" (a decision)') },
    ]);
    expect(status.language).toBe('ru');
    expect(status.groups.map((group) => group.group)).toEqual(['product', 'code', 'code.structure', 'code.analysis', 'contracts', 'data', 'operations', 'operations.configuration', 'operations.dependencies', 'operations.build-deploy', 'operations.ci-cd', 'operations.runtime', 'operations.newcomer', 'tests', 'history']);
    expect(Object.keys(status.roles).sort()).toEqual(['analyst', 'architect', 'developer', 'operations', 'product', 'tester']);
    const kinds = status.kinds.map((kind) => kind.kind);
    for (const kind of ['doc.use-case', 'doc.rule', 'doc.term', 'code.route', 'code.operation', 'code.contract', 'code.database', 'question', 'correction']) expect(kinds).toContain(kind);
    expect(status.kinds.find((kind) => kind.kind === 'code.route')?.group).toBe('contracts');
    expect(status.kinds.every((kind) => kind.group !== undefined)).toBe(true);
    expect(status.starterOffers).toBe(0);
    expect(readFileSync(join(folder, 'madarch', 'kinds.yaml'), 'utf8')).toBe(starterManifest('ru'));
    expect(logged.some((line) => line.includes('brought') && line.includes('madarch/kinds.yaml'))).toBe(true);
    // The route's page template is there, so a route page can be drawn.
    expect(readFileSync(join(folder, 'templates', 'route.md'), 'utf8')).toBe(STARTER_FILES.find((file) => file.path === 'templates/route.md')!.content);
  }, 90_000);

  test('a manifest a person edited is left byte for byte; the Problems page offers what the set holds, and adding one reads clean', async () => {
    const { folder, store } = oldProduct();
    writeFileSync(join(folder, 'madarch', 'kinds.yaml'), `# our own note\n${readFileSync(join(folder, 'madarch', 'kinds.yaml'), 'utf8')}`);
    git(folder, 'add', '-A');
    git(folder, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Note in the manifest');
    const before = readFileSync(join(folder, 'madarch', 'kinds.yaml'), 'utf8');
    const held = product(folder, store);
    const status = await held.status();
    expect(readFileSync(join(folder, 'madarch', 'kinds.yaml'), 'utf8')).toBe(before);
    expect(status.starterOffers).toBeGreaterThan(5);
    // `group: product` with no `groups:` is what made the questions and corrections findings.
    expect(status.findings.length).toBeGreaterThan(0);
    const problems = await held.problems();
    const ids = (problems.starter ?? []).map((offer) => offer.id);
    expect(ids).toContain('group:product');
    expect(ids).toContain('kind:code.route');
    const added = held.addStarter(['group:product', 'kind:code.route', 'roles']);
    expect(added).toEqual({ ok: true, written: ['madarch/kinds.yaml'] });
    expect(readFileSync(join(folder, 'madarch', 'kinds.yaml'), 'utf8').startsWith('# our own note\n')).toBe(true);
    const after = await held.status();
    expect(after.findings).toEqual([]);
    expect(after.kinds.map((kind) => kind.kind)).toContain('code.route');
    expect(after.starterOffers).toBeLessThan(status.starterOffers!);
    // Something the set does not offer now is refused in words, not written.
    const refused = held.addStarter(['kind:code.route']);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('kind:code.route is not offered');
  }, 90_000);
});

describe('the model and the reasoning level are the agent\'s own to name', () => {
  const choices: AgentChoices = {
    model: { configId: 'model', name: 'Model', current: 'sonnet', values: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }] },
    reasoning: { configId: 'effort', name: 'Effort', current: null, values: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  };

  test('only a value the agent reports is saved, beside the agent; null returns to the agent\'s own', async () => {
    const { folder, store } = oldProduct();
    let asked = 0;
    const held = product(folder, store, { choicesQuery: async () => { asked += 1; return { ok: true, choices }; } });
    expect(await held.agentChoices()).toEqual({ ok: false, message: 'no agent is chosen for this product: choose one to see the models it offers' });
    expect(await held.chooseModel('opus', undefined)).toMatchObject({ ok: false, status: 409 });
    const id = (held.product() as { id: string }).id;
    mkdirSync(join(store, id), { recursive: true });
    writeFileSync(join(store, id, 'writer.json'), '{"agent":"claude-code"}\n');
    expect(await held.agentChoices()).toMatchObject({ ok: true, agent: { id: 'claude-code' }, choices });
    expect(await held.agentChoices()).toMatchObject({ ok: true });
    expect(asked).toBe(1); // kept for a few minutes: the agent is started once
    const refused = await held.chooseModel('gpt-nine', undefined);
    expect(refused).toMatchObject({ ok: false, status: 400 });
    if (!refused.ok) expect(refused.message).toContain('which the agent does not report; it reports sonnet, opus');
    expect(JSON.parse(readFileSync(join(store, id, 'writer.json'), 'utf8'))).toEqual({ agent: 'claude-code' });
    const saved = await held.chooseModel('opus', 'high');
    expect(saved).toMatchObject({ ok: true, chosen: { id: 'claude-code', model: 'opus', reasoning: 'high' } });
    expect(JSON.parse(readFileSync(join(store, id, 'writer.json'), 'utf8'))).toEqual({ agent: 'claude-code', model: 'opus', reasoning: 'high' });
    expect(held.chosenAgent()).toMatchObject({ model: 'opus', reasoning: 'high' });
    const cleared = await held.chooseModel(null, undefined);
    expect(cleared).toMatchObject({ ok: true });
    expect(held.chosenAgent()?.model).toBeUndefined();
    expect(held.chosenAgent()?.reasoning).toBe('high');
  }, 60_000);

  test('an agent that cannot be asked is an answer in words, not a saved guess', async () => {
    const { folder, store } = oldProduct();
    const held = product(folder, store, { choicesQuery: async () => ({ ok: false, message: 'Claude Code could not tell its models: no adapter' }) });
    const id = (held.product() as { id: string }).id;
    mkdirSync(join(store, id), { recursive: true });
    writeFileSync(join(store, id, 'writer.json'), '{"agent":"claude-code"}\n');
    expect(await held.agentChoices()).toEqual({ ok: false, message: 'Claude Code could not tell its models: no adapter' });
    expect(await held.chooseModel('opus', undefined)).toMatchObject({ ok: false, status: 502 });
    expect(JSON.parse(readFileSync(join(store, id, 'writer.json'), 'utf8'))).toEqual({ agent: 'claude-code' });
  }, 60_000);
});

describe('the two local resets', () => {
  const page = (id: string, producer: string): string => `---\nid: ${id}\nkind: domain\ntitle: X\nrelates: []\nproducer: ${producer}\nsources: []\n---\n\nText.\n`;

  function withPages(folder: string, store: string, held: KnowledgeProduct): string {
    mkdirSync(join(folder, 'docs', 'domains'), { recursive: true });
    writeFileSync(join(folder, 'docs', 'product.md'), page('product:tiny', 'agent'));
    writeFileSync(join(folder, 'docs', 'domains', 'orders.md'), page('domain:orders', 'agent'));
    writeFileSync(join(folder, 'docs', 'domains', 'mine.md'), page('domain:mine', 'person'));
    const id = (held.product() as { id: string }).id;
    mkdirSync(join(store, id, 'graph'), { recursive: true });
    writeFileSync(join(store, id, 'graph', 'f'), 'x');
    writeFileSync(join(store, id, 'writer.json'), '{"agent":"claude-code","model":"opus"}\n');
    return id;
  }

  test('«Rewrite the pages» removes the agent\'s pages only, keeps the graph and a person\'s pages, and starts a fill with the chosen agent', async () => {
    const { folder, store } = oldProduct();
    const counter = { started: 0 };
    const held = product(folder, store, { workerFactory: quickWorker(counter) });
    const id = withPages(folder, store, held);
    const done = await held.rewritePages();
    expect(done.ok).toBe(true);
    expect(existsSync(join(folder, 'docs', 'product.md'))).toBe(false);
    expect(existsSync(join(folder, 'docs', 'domains', 'orders.md'))).toBe(false);
    expect(existsSync(join(folder, 'docs', 'domains', 'mine.md'))).toBe(true);
    expect(existsSync(join(store, id, 'graph', 'f'))).toBe(true);
    expect(JSON.parse(readFileSync(join(store, id, 'writer.json'), 'utf8')).model).toBe('opus');
    await held.settled();
    expect(counter.started).toBe(1);
  }, 90_000);

  test('«Rewrite the pages» with no agent removes nothing and says why', async () => {
    const { folder, store } = oldProduct();
    const counter = { started: 0 };
    const held = product(folder, store, { workerFactory: quickWorker(counter) });
    const id = withPages(folder, store, held);
    rmSync(join(store, id, 'writer.json'));
    const done = await held.rewritePages();
    expect(done).toMatchObject({ ok: false });
    if (!done.ok) expect(done.message).toContain('nothing was removed');
    expect(existsSync(join(folder, 'docs', 'product.md'))).toBe(true);
    expect(counter.started).toBe(0);
  }, 60_000);

  test('«Start from scratch» leaves no agent page and no graph, puts the manifest and templates at the current set, keeps a person\'s page and the agent, and fills again', async () => {
    const { folder, store } = oldProduct();
    writeFileSync(join(folder, 'templates', 'domain.md'), 'my own template\n');
    const counter = { started: 0 };
    const held = product(folder, store, { workerFactory: quickWorker(counter) });
    const id = withPages(folder, store, held);
    const plan = held.dangerPlan();
    expect(plan.fresh.agentPages).toEqual(['docs/product.md', 'docs/domains/orders.md']);
    expect(plan.fresh.editedStarterFiles).toContain('templates/domain.md');
    expect(plan.rewrite.keptPages).toEqual(['docs/domains/mine.md']);
    const done = await held.startFresh();
    expect(done.ok).toBe(true);
    expect(existsSync(join(folder, 'docs', 'product.md'))).toBe(false);
    expect(existsSync(join(folder, 'docs', 'domains', 'orders.md'))).toBe(false);
    expect(existsSync(join(folder, 'docs', 'domains', 'mine.md'))).toBe(true);
    expect(existsSync(join(store, id, 'graph', 'f'))).toBe(false);
    expect(readFileSync(join(folder, 'madarch', 'kinds.yaml'), 'utf8')).toBe(starterManifest('ru'));
    for (const starter of STARTER_FILES.filter((file) => file.path.startsWith('templates/'))) expect(readFileSync(join(folder, starter.path), 'utf8')).toBe(starter.content);
    expect(held.chosenAgent()).toMatchObject({ id: 'claude-code', model: 'opus' });
    await held.settled();
    expect(counter.started).toBe(1);
    // Nothing was committed: the reset is a change of files on this machine.
    expect(git(folder, 'log', '--format=%s')).not.toContain('starter');
  }, 90_000);

  test('the settings and reset routes carry exact counts; rewrite retains questions and fresh removes only unanswered agent questions', async () => {
    const { folder, store } = oldProduct();
    const counter = { started: 0 };
    const held = product(folder, store, { workerFactory: quickWorker(counter) });
    withPages(folder, store, held);
    mkdirSync(join(folder, 'docs/questions'), { recursive: true });
    const at = '2026-10-24T12:00:00Z';
    const author = { name: 'Reader', email: 'reader@example.test', verified: 'local, not verified' };
    for (const answered of [false, true]) {
      const slug = answered ? 'answered' : 'open';
      writeFileSync(join(folder, `docs/questions/${slug}.md`), renderQuestion({
        slug, title: 'Which duration?', type: 'gap', status: answered ? 'answered' : 'open', about: ['product:tiny'],
        askedIn: 'product:tiny', askedAt: at, question: 'Which retention duration applies?', why: 'The duration is not documented.',
        sides: [{ claim: 'The duration is not documented.', grounds: ['doc:README.md#retention'] }],
        answer: answered ? { text: 'Keep ninety days.', by: author, at } : null,
        resolvedBy: answered ? ['product:tiny'] : [], resolvedAt: answered ? at : null, writtenAt: [],
      }));
    }
    const makers = { json: (status: number, body: unknown) => Response.json(body, { status }), refused: (status: number, error: { message: string }) => ({ response: Response.json({ error }, { status }), refusal: error.message }), errorLog: () => undefined };
    const part = createKnowledgePart(makers as never, held, () => [], {});
    const preview = await (await part.productSettings(new Request('http://wiki.test/api/k/product-settings'))).response.json() as { danger: { fresh: { unansweredQuestions: string[]; keptAnswers: string[] } } };
    expect(preview.danger.fresh.unansweredQuestions).toEqual(['docs/questions/open.md']);
    expect(preview.danger.fresh.keptAnswers).toEqual(['docs/questions/answered.md']);
    const malformed = await part.startFresh(new Request('http://wiki.test/api/k/start-fresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preview: { unansweredQuestions: 'not a list' } }) }));
    expect(malformed.response.status).toBe(400);
    expect(existsSync(join(folder, 'docs/product.md'))).toBe(true);
    const stale = held.resetPlan();
    const openFile = join(folder, 'docs/questions/open.md');
    const openQuestion = parseQuestion(openFile, readFileSync(openFile, 'utf8'));
    writeFileSync(openFile, renderQuestion({ ...openQuestion, status: 'answered', answer: { text: 'A new answer after preview.', by: author, at } }));
    const refused = await part.startFresh(new Request('http://wiki.test/api/k/start-fresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preview: stale }) }));
    expect(refused.response.status).toBe(409);
    expect(JSON.stringify(await refused.response.json())).toContain('changed since the preview');
    expect(existsSync(join(folder, 'docs/product.md'))).toBe(true);
    expect(readFileSync(openFile, 'utf8')).toContain('A new answer after preview.');
    writeFileSync(openFile, renderQuestion(openQuestion));
    const rewrite = await part.rewritePages(new Request('http://wiki.test/api/k/rewrite-pages', { method: 'POST' }));
    expect(rewrite.response.status).toBe(202);
    expect((await rewrite.response.json() as { plan: { unansweredQuestions: string[] } }).plan.unansweredQuestions).toEqual([]);
    expect(existsSync(join(folder, 'docs/questions/open.md'))).toBe(true);
    const file = join(folder, 'docs/questions/answered.md');
    expect(parseQuestion(file, readFileSync(file, 'utf8')).resolvedBy).toEqual([]);
    await held.settled();
    const fresh = await part.startFresh(new Request('http://wiki.test/api/k/start-fresh', { method: 'POST' }));
    expect(fresh.response.status).toBe(202);
    expect((await fresh.response.json() as { plan: { unansweredQuestions: string[]; keptAnswers: string[] } }).plan).toMatchObject({ unansweredQuestions: ['docs/questions/open.md'], keptAnswers: ['docs/questions/answered.md'] });
    expect(existsSync(join(folder, 'docs/questions/open.md'))).toBe(false);
    expect(parseQuestion(file, readFileSync(file, 'utf8')).answer).toEqual({ text: 'Keep ninety days.', by: author, at });
    await held.settled();
  }, 90_000);

  test('both are refused while a fill runs, in words', async () => {
    const { folder, store } = oldProduct();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const worker = (): FillWorkerHandle => ({ send: () => undefined, lines: (async function* () { await hold; })(), exited: hold.then(() => 0), stderr: () => '', kill: () => undefined });
    const held = product(folder, store, { workerFactory: worker });
    expect((await held.startFill()).started).toBe(true);
    expect(await held.rewritePages()).toMatchObject({ ok: false, message: expect.stringContaining('running') });
    expect(await held.startFresh()).toMatchObject({ ok: false, message: expect.stringContaining('running') });
    release();
    await held.settled();
  }, 90_000);
});

describe('what only the wiki\'s own page may ask, and what a language change remembers', () => {
  const makers = {
    json: (status: number, body: unknown): Response => Response.json(body, { status }),
    refused: (status: number, error: { message: string }) => ({ response: Response.json({ error }, { status }), refusal: error.message }),
    errorLog: () => undefined,
  };

  test('another site\'s page cannot start the agent\'s adapter by asking for its models, nor reset the product', async () => {
    const { folder, store } = oldProduct();
    let asked = 0;
    const held = product(folder, store, { choicesQuery: async () => { asked += 1; return { ok: true, choices: { model: null, reasoning: null } }; } });
    const id = (held.product() as { id: string }).id;
    mkdirSync(join(store, id), { recursive: true });
    writeFileSync(join(store, id, 'writer.json'), '{"agent":"claude-code"}\n');
    const part = createKnowledgePart(makers as never, held, () => [], {});
    const foreignGet = new Request('http://wiki.test/api/k/agent-choices?fresh=1', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect((await part.agentChoices(foreignGet)).response.status).toBe(403);
    expect((await part.startFresh(new Request('http://wiki.test/api/k/start-fresh', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }))).response.status).toBe(403);
    expect(asked).toBe(0);
    const own = await part.agentChoices(new Request('http://wiki.test/api/k/agent-choices', { headers: { 'sec-fetch-site': 'same-origin' } }));
    expect(own.response.status).toBe(200);
    expect(asked).toBe(1);
  }, 60_000);

  test('two pages asking at once start one query', async () => {
    const { folder, store } = oldProduct();
    let asked = 0;
    const held = product(folder, store, { choicesQuery: async () => { asked += 1; await new Promise((rest) => setTimeout(rest, 100)); return { ok: true, choices: { model: null, reasoning: null } }; } });
    const id = (held.product() as { id: string }).id;
    mkdirSync(join(store, id), { recursive: true });
    writeFileSync(join(store, id, 'writer.json'), '{"agent":"claude-code"}\n');
    await Promise.all([held.agentChoices(true), held.agentChoices(true), held.agentChoices(true)]);
    expect(asked).toBe(1);
  }, 60_000);

  test('a pages written before their language was recorded are recorded in the language they are in before it changes', async () => {
    const { folder, store } = oldProduct();
    const held = product(folder, store);
    mkdirSync(join(folder, 'docs'), { recursive: true });
    writeFileSync(join(folder, 'docs', 'product.md'), '---\nid: product:tiny\nkind: product\ntitle: Tiny\nrelates: []\nproducer: agent\nsources: []\n---\n\nText.\n');
    await held.status(); // brings the manifest to the current set, language ru kept
    expect(held.setLanguage('en')).toEqual({ ok: true });
    const id = (held.product() as { id: string }).id;
    expect(JSON.parse(readFileSync(join(store, id, 'pages-language.json'), 'utf8'))).toEqual({ language: 'ru' });
    expect(readFileSync(join(folder, 'madarch', 'kinds.yaml'), 'utf8')).toContain('language: en');
    expect(held.setLanguage('klingon')).toMatchObject({ ok: false });
  }, 90_000);
});
