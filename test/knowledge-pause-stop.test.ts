/**
 * Pause and stop (madarch-m38l.17): «Пауза» lets the page being written finish and stops before the next one, «Продолжить»
 * takes the next page up, and the pause stands a server's restart; «Остановить» ends the run now, after a confirmation that
 * names the pages this run already rewrote and keeps the page in progress as it was before the run. The fill's own stage
 * stops at its next commit and is taken up again where it stopped. The product, the fill and its checks are the real ones;
 * the agent is scripted (no model), and the test holds the unit it reads while it is being written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { AgentFactory } from '../src/knowledge/product.js';
import type { FromWorker, ToWorker, WorkerStart } from '../src/knowledge/fill-protocol.js';
import { runFillWorker } from '../src/knowledge/fill-worker.js';
import type { ToolClient, UnitAgent, UnitRequest } from '../src/writer/index.js';
import type { Journal } from '../src/writer/journal.js';
import { gitEnv } from './git-env.js';
import { makeProduct, recordKey, SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { SCRIPTED_GUIDE_PATH, SCRIPTED_GUIDE_SOURCE, verifyScriptedGuide, writeScriptedGuide } from './scripted-guide-agent.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

const A_TS = ['export function leaf(): number {', '  return 1;', '}', '', 'export function root(): number {', '  return leaf() + 1;', '}', ''].join('\n');
const FILE = recordKey('code.file', 'src/a.ts');
const PRODUCT_FILE = 'docs/product.md';
const DOMAIN_FILE = 'docs/domains/numbers.md';

const PRODUCT_PAGE_RU = [
  '---', 'id: product:tiny', 'kind: product', 'title: Крошечный продукт', 'relates:', `  - ${FILE}`, 'producer: agent', 'sources: []', '---', '',
  '## Что это за продукт', '',
  'Крошечный продукт считает числа с помощью листовой и корневой функций.[^1]', '',
  '## Домены', '',
  `- [Числа](madarch:domain:numbers) считаются в [исходном файле](madarch:${FILE}).[^2]`, '',
  `[^1]: [a.ts](madarch:${FILE})`, `[^2]: [a.ts](madarch:${FILE})`,
].join('\n');
const DOMAIN_PAGE_RU = [
  '---', 'id: domain:numbers', 'kind: domain', 'title: Числа', 'relates:', `  - ${FILE}`, 'producer: agent', 'sources: []', '---', '',
  '## Как считаются числа', '',
  'Корневая функция прибавляет единицу к значению, которое возвращает листовая функция, т.е. считает на единицу больше.[^1]', '',
  `[^1]: [a.ts](madarch:${FILE})`,
].join('\n');

/** The agent a fill runs, with the close the filler calls when a unit is done. */
type AgentWithClose = UnitAgent & { close(): Promise<void> };

let work: string;
let home: string;
let app: string;
let server: StartedServer;
/** The product's store folder, read from the first status: `<work>/store/<product id>`. */
let store: string;
/** The holds the test queues: a held unit waits on one until the test opens it. */
const opens: (() => void)[] = [];
const waits: Promise<void>[] = [];
function hold(): void { let open!: () => void; waits.push(new Promise<void>((resolve) => { open = resolve; })); opens.push(open); }
/** Opens the hold queued first, so the held page is written and the run goes on. */
function release(): void { opens.shift()?.(); }
function releaseAll(): void { for (const open of opens.splice(0)) open(); }
/** Which units the run holds open, and what the test has seen asked. */
let holdProduct = false;
let holdDomain = false;
let productCalls = 0;
const seen: string[] = [];

const agent: AgentWithClose = {
  async run(request: UnitRequest): Promise<void> {
    if (request.id.startsWith('guide-proof:')) {
      await verifyScriptedGuide(request.prompt, (tool, args) => request.tools.call(tool, args));
      return;
    }
    seen.push(request.id);
    if (request.id === 'administrator-guide:main' || request.id === 'user-guide:main') {
      await writeScriptedGuide(request.prompt, (tool, args) => request.tools.call(tool, args));
      return;
    }
    const wait = (): Promise<void> => waits.shift() ?? Promise.resolve();
    if (request.id === 'product:tiny') {
      productCalls += 1;
      if (holdProduct) await wait();
      const written = await request.tools.call('write_page', {
        markdown: PRODUCT_PAGE_RU,
        domains: [{ slug: 'numbers', title: 'Числа', summary: 'Числа считают листовая и корневая функции.', evidence: [FILE] }],
      });
      if (written.isError) throw new Error(`the product page was refused: ${JSON.stringify(written.answer)}`);
      return;
    }
    if (request.id === 'domain:numbers') {
      if (holdDomain) await wait();
      const written = await request.tools.call('write_page', { markdown: DOMAIN_PAGE_RU });
      if (written.isError) throw new Error(`the domain page was refused: ${JSON.stringify(written.answer)}`);
      return;
    }
    throw new Error(`the scripted agent was asked for ${request.id}, which this fixture does not write`);
  },
  async close(): Promise<void> {},
};

/** The agent for one fill, with the run's journal (the writer asks for one whether or not a page's journal keeps it). */
const agentFactory: AgentFactory = (_agentId: string, journal: Journal) => {
  void journal;
  return agent;
};

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/tiny${path}`);
  return { status: response.status, body: await response.json() };
};
const post = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/tiny${path}`, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, tries = 600): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((rest) => setTimeout(rest, 250));
  }
  throw new Error(`gave up waiting for ${what}`);
}
const writtenUnits = (body: any): number => body.writer.units.filter((unit: { state: string }) => unit.state === 'written').length;
/** The state of one unit of the status, or the words that it is not there: the tests read both as sentences. */
const stateOf = (body: any, id: string): string =>
  (body.writer.units as { unit: string; state: string; title?: string }[]).find((unit) => unit.unit === id)?.state ?? 'no such unit';
const unitOf = (body: any, id: string): { state: string; title?: string } | undefined => body.writer.units.find((unit: { unit: string }) => unit.unit === id);

/** A server over the fixture's home and store: the same one twice is how a restart is read. */
async function startFixtureServer(): Promise<StartedServer> {
  return await startServer({
    productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined,
    env: { ...process.env, HOME: join(work, 'user'), MADARCH_HOME: join(work, 'user', 'madarch'), PATH: join(work, 'bin') },
    knowledgeAgentFactory: agentFactory,
  });
}

describe('pause and stop of a run that writes pages', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'madarch-pause-stop-'));
    const repository = join(work, 'repo');
    mkdirSync(join(repository, 'src'), { recursive: true });
    git(repository, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repository, 'src', 'a.ts'), A_TS);
    writeFileSync(join(repository, 'package.json'), '{"name":"tiny","dependencies":{}}\n');
    mkdirSync(join(repository, 'docs'));
    writeFileSync(join(repository, SCRIPTED_GUIDE_PATH), SCRIPTED_GUIDE_SOURCE);
    git(repository, 'add', '.');
    git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the leaf and the root', '--date', '2026-03-01T10:00:00Z');
    home = join(work, 'home');
    mkdirSync(home);
    makeProduct(home, 'tiny', repository, 'tiny');
    app = join(work, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
    // The machine the agent runs on: an adapter that is installed (a script that exits), and no npm and no network use.
    const bin = join(work, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude-agent-acp'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'claude-agent-acp'), 0o755);
    mkdirSync(join(work, 'user'));
    server = await startFixtureServer();
    expect((await post('/api/k/agent', { agent: 'claude-code', install: false })).status).toBe(200);
    store = join(work, 'store', (await get('/api/k/status')).body.product.id);
    expect(store.startsWith(join(work, 'store'))).toBe(true);
  }, 120_000);

  afterAll(async () => {
    releaseAll();
    await server?.stop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  });

  test('an English run finishes whole before the pages are switched to Russian', async () => {
    expect((await post('/api/k/fill', { agent: 'claude-code', language: 'en' })).status).toBe(202);
    const ended = await until('the English run to end', async () => (await get('/api/k/status')).body, (body) => body.writer.state === 'done' || body.writer.state === 'failed');
    expect(ended.writer.state).toBe('done');
    expect(stateOf(ended, 'product:tiny')).toBe('written');
    expect(stateOf(ended, 'domain:numbers')).toBe('written');
    expect(seen.filter((unit) => unit === 'product:tiny')).toHaveLength(1);
    expect(readFileSync(join(home, 'tiny', PRODUCT_FILE), 'utf8')).toContain('id: product:tiny');
    expect(JSON.parse(readFileSync(join(store, 'pages-language.json'), 'utf8'))).toEqual({ language: 'en' });
  }, 300_000);

  test('a pause lets the page being written finish, and the next one is never taken up', async () => {
    const askedBefore = seen.length;
    holdDomain = true;
    hold();
    expect((await post('/api/k/fill', { agent: 'claude-code', language: 'ru' })).status).toBe(202);
    await until('the domain page to be writing', async () => (await get('/api/k/status')).body, (body) => stateOf(body, 'domain:numbers') === 'writing');
    // The press: the page being written is finished, and the run stands before the next one.
    expect((await post('/api/k/pause')).status).toBe(200);
    holdDomain = false;
    release();
    const paused = await until('the run to stand paused', async () => (await get('/api/k/status')).body, (body) => body.writer.state === 'paused');
    // The page the run held is written whole, and the page after it was never taken up.
    expect(readFileSync(join(home, 'tiny', PRODUCT_FILE), 'utf8')).toContain('id: product:tiny');
    expect(readFileSync(join(home, 'tiny', DOMAIN_FILE), 'utf8')).toContain('id: domain:numbers');
    expect(seen.slice(askedBefore)).toContain('domain:numbers');
    expect(seen.slice(askedBefore)).not.toContain('administrator-guide:main');
    expect(stateOf(paused, 'administrator-guide:main')).toBe('no such unit');
    // The block counts what is written of what the run means to write: the product page, its domain page, and two guides.
    expect(stateOf(paused, 'product:tiny')).toBe('written');
    expect(stateOf(paused, 'domain:numbers')).toBe('written');
    expect(writtenUnits(paused)).toBe(2);
    expect(paused.writer.total).toBe(4);
    expect(paused.writer.current).toBeUndefined();
    // The pause is kept beside the store, so a server that starts again shows the same run.
    expect(existsSync(join(store, 'pause.json'))).toBe(true);
  }, 300_000);

  test('the pause stands a restart, and «Продолжить» takes the next page, not the pages that are written', async () => {
    await server.stop();
    server = await startFixtureServer();
    const kept = (await get('/api/k/status')).body;
    expect(kept.writer.state).toBe('paused');
    expect(kept.writer.total).toBe(4);
    expect(writtenUnits(kept)).toBe(2);
    expect(stateOf(kept, 'product:tiny')).toBe('written');
    expect(stateOf(kept, 'domain:numbers')).toBe('written');
    // The pages are named as they were, so the block shows the same sentences as before the restart.
    expect(unitOf(kept, 'product:tiny')?.title).toBe('Крошечный продукт');
    expect(unitOf(kept, 'domain:numbers')?.title).toBe('Числа');
    // The pages completed before the pause: «Продолжить» must not take any of them up again.
    const productAsked = seen.filter((unit) => unit === 'product:tiny').length;
    const domainAsked = seen.filter((unit) => unit === 'domain:numbers').length;
    // «Продолжить» is the fill's own press: it starts a run, which takes the next page up.
    expect((await post('/api/k/fill', { agent: 'claude-code', language: 'ru' })).status).toBe(202);
    const ended = await until('the resumed run to end', async () => (await get('/api/k/status')).body, (body) => body.writer.state === 'done' || body.writer.state === 'failed');
    expect(ended.writer.state).toBe('done');
    // No page written before the pause was written again: the agent was asked for each of them once, in the run that wrote
    // them, and this run went on with the two guides the pause had left.
    expect(seen.filter((unit) => unit === 'product:tiny')).toHaveLength(productAsked);
    expect(seen.filter((unit) => unit === 'domain:numbers')).toHaveLength(domainAsked);
    expect(productCalls).toBe(2);
    expect(stateOf(ended, 'administrator-guide:main')).toBe('written');
    expect(stateOf(ended, 'user-guide:main')).toBe('written');
    expect(readFileSync(join(home, 'tiny', DOMAIN_FILE), 'utf8')).toContain('id: domain:numbers');
    expect(existsSync(join(store, 'pause.json'))).toBe(false);
  }, 300_000);

  test('«Остановить» asks first, naming the pages already rewritten, and then leaves the page in progress as it was', async () => {
    const before = readFileSync(join(home, 'tiny', DOMAIN_FILE), 'utf8');
    holdDomain = true;
    hold();
    // The pages' language changes, so every page is written again: one page stands before the one the run holds.
    expect((await post('/api/k/fill', { agent: 'claude-code', language: 'en' })).status).toBe(202);
    await until('the domain page to be writing', async () => (await get('/api/k/status')).body, (body) => stateOf(body, 'domain:numbers') === 'writing');
    const writing = (await get('/api/k/status')).body;
    expect(stateOf(writing, 'product:tiny')).toBe('written');
    expect(productCalls).toBe(3);
    // A stop without the confirmation is refused, and says how many pages this run rewrote and that they stay.
    const refused = await post('/api/k/stop', {});
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe('stopping ends the run now: 1 page has already been rewritten by this run and stays as it is; the page being written now stays as it was before the run');
    // The press that confirms it ends the run now.
    expect((await post('/api/k/stop', { confirm: true })).status).toBe(200);
    const stopped = await until('the run to stop', async () => (await get('/api/k/status')).body, (body) => body.writer.state === 'stopped');
    expect(stopped.fill.state).toBe('stopped');
    // The page in progress is not written: its bytes are what they were before the run.
    expect(readFileSync(join(home, 'tiny', DOMAIN_FILE), 'utf8')).toBe(before);
    expect(stateOf(stopped, 'domain:numbers')).not.toBe('written');
    // A run that stopped is not a failure, and nothing stays paused on disk.
    expect(stopped.writer.code).toBeUndefined();
    expect(existsSync(join(store, 'pause.json'))).toBe(false);
    // There is nothing left to pause: the run is over.
    expect((await post('/api/k/pause')).status).toBe(409);
    // Let the agent the stop interrupted end, so the next test's fill is not told the previous run is still closing.
    holdDomain = false;
    release();
  }, 300_000);

  test('a stop confirmed after a pause is a stop, and leaves nothing resumable behind', async () => {
    holdProduct = true;
    hold();
    // The test is about the two presses, not the language: say the standing pages are English and translate to Russian,
    // so the first page is surely one this run takes up.
    writeFileSync(join(store, 'pages-language.json'), `${JSON.stringify({ language: 'en' })}\n`, 'utf8');
    expect((await post('/api/k/fill', { agent: 'claude-code', language: 'ru' })).status).toBe(202);
    await until('the product page to be writing', async () => (await get('/api/k/status')).body, (body) => stateOf(body, 'product:tiny') === 'writing');
    // The person pauses, then confirms a stop before the page in progress ends: both presses are heard, and the stop wins.
    expect((await post('/api/k/pause')).status).toBe(200);
    expect((await post('/api/k/stop', { confirm: true })).status).toBe(200);
    holdProduct = false;
    release();
    const ended = await until('the run to end', async () => (await get('/api/k/status')).body, (body) => body.writer.state === 'stopped' || body.writer.state === 'paused');
    expect(ended.writer.state).toBe('stopped');
    expect(ended.fill.state).toBe('stopped');
    expect(existsSync(join(store, 'pause.json'))).toBe(false);
  }, 300_000);
});

/** The lines a worker reads: the test pushes one at a time, as the server sends them. */
class Lines implements AsyncIterable<string> {
  private readonly queue: string[] = [];
  private readonly waiting: ((result: IteratorResult<string>) => void)[] = [];
  private ended = false;
  push(line: string): void {
    const waiter = this.waiting.shift();
    if (waiter !== undefined) waiter({ done: false, value: line });
    else this.queue.push(line);
  }
  end(): void {
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) waiter({ done: true, value: undefined as never });
  }
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value !== undefined) return Promise.resolve({ done: false as const, value });
        if (this.ended) return Promise.resolve({ done: true as const, value: undefined as never });
        return new Promise<IteratorResult<string>>((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

describe('pause of the fill\'s own stage', () => {
  let workerWork: string;
  let graphPath: string;
  let readRoot: string;
  let repository: string;

  beforeAll(async () => {
    workerWork = mkdtempSync(join(tmpdir(), 'madarch-pause-fill-'));
    repository = join(workerWork, 'repo');
    mkdirSync(join(repository, 'src'), { recursive: true });
    git(repository, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repository, 'src', 'a.ts'), A_TS);
    git(repository, 'add', '.');
    git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the leaf', '--date', '2026-03-01T10:00:00Z');
    writeFileSync(join(repository, 'src', 'a.ts'), `${A_TS}\nexport function twice(): number {\n  return root() * 2;\n}\n`);
    git(repository, 'add', '.');
    git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add twice', '--date', '2026-03-02T10:00:00Z');
    writeFileSync(join(repository, 'src', 'a.ts'), `${A_TS}\nexport function twice(): number {\n  return root() * 2;\n}\n\nexport function thrice(): number {\n  return root() * 3;\n}\n`);
    git(repository, 'add', '.');
    git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add thrice', '--date', '2026-03-03T10:00:00Z');
    const home = join(workerWork, 'home');
    mkdirSync(home);
    makeProduct(home, 'tiny', repository, 'tiny');
    graphPath = join(workerWork, 'store', 'graph');
    readRoot = join(workerWork, 'store', 'read');
  }, 60_000);

  afterAll(() => {
    if (workerWork !== undefined) rmSync(workerWork, { recursive: true, force: true });
  });

  /** The pins of the store: how many commits the history holds, and how many of them the fill read. */
  const pinsOf = async (): Promise<{ commits: number; filledCommits: number }> => {
    const owner = createPGliteDatabaseOwner({ path: graphPath });
    try {
      await owner.ready;
      const rows = (await owner.run((tx) => tx.query<{ commits: number; filled_commits: number }>('SELECT commits, filled_commits FROM knowledge_fill'))).rows;
      expect(rows).toHaveLength(1);
      return { commits: Number(rows[0]!['commits']), filledCommits: Number(rows[0]!['filled_commits']) };
    } finally {
      await owner.close();
    }
  };

  /** The fill's end messages of a run, in order, said the way the worker said them. */
  const ends = (sent: FromWorker[]): { state: string; paused?: boolean }[] =>
    sent.flatMap((message) => (message.type === 'fill' ? [{ state: message.state, ...(message.state === 'stopped' && message.paused === true ? { paused: true } : {}) }] : []));

  /** One worker run over the same store; `pauseAt` asks for a pause at the first commit the fill reports. */
  const run = async (pauseAt: boolean): Promise<FromWorker[]> => {
    const sent: FromWorker[] = [];
    const lines = new Lines();
    const start: WorkerStart = {
      type: 'start', productFolder: join(workerWork, 'home', 'tiny'), productName: 'tiny', graphPath, readRoot,
      repositories: [{ name: 'training', path: repository }], writer: false, language: 'ru', languageChanged: false, snapshotMs: 8_000,
    };
    const paused = { asked: false };
    lines.push(JSON.stringify(start));
    const code = await runFillWorker({
      lines,
      send: (message) => {
        sent.push(message);
        // The person presses «Пауза» while the code is being read: the next commit is not read.
        if (pauseAt && message.type === 'progress' && !paused.asked) { paused.asked = true; lines.push(JSON.stringify({ type: 'pause' } as ToWorker)); }
      },
    });
    expect(code).toBe(0);
    return sent;
  };

  test('«Пауза» stops the fill at its next commit, and the run after it reads the commits that were left', async () => {
    // The first fill reads the three commits: with nothing paused, the store is whole and no rebuild is staged.
    const first = await run(false);
    expect(ends(first)).toEqual([{ state: 'done' }]);
    expect(await pinsOf()).toEqual({ commits: 3, filledCommits: 3 });
    // A commit arrives that the fill has not read.
    writeFileSync(join(repository, 'src', 'a.ts'), `${A_TS}\n\nexport const four = 4;\n`);
    git(repository, 'add', '.');
    git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add four', '--date', '2026-03-04T10:00:00Z');
    // Paused while it reads: it ends at the next commit, and says it is paused, not stopped.
    const second = await run(true);
    expect(ends(second)).toEqual([{ state: 'stopped', paused: true }]);
    expect(await pinsOf()).toEqual({ commits: 4, filledCommits: 3 });
    // The press on «Продолжить» is the fill's own press: the run reads the commits that were left and ends.
    const resumed = await run(false);
    expect(ends(resumed)).toEqual([{ state: 'done' }]);
    expect(await pinsOf()).toEqual({ commits: 4, filledCommits: 4 });
  }, 300_000);
});

describe('a stop that arrives while a page is being written', () => {
  test('the write is fenced, its in-flight tool call is drained, and no page is published after the stop', async () => {
    const work = mkdtempSync(join(tmpdir(), 'madarch-stop-write-'));
    try {
      const repository = join(work, 'repo');
      mkdirSync(join(repository, 'src'), { recursive: true });
      git(repository, 'init', '--quiet', '--initial-branch=main');
      writeFileSync(join(repository, 'src', 'a.ts'), A_TS);
      writeFileSync(join(repository, 'package.json'), '{"name":"tiny","dependencies":{}}\n');
      git(repository, 'add', '.');
      git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the leaf and the root', '--date', '2026-03-01T10:00:00Z');
      const home = join(work, 'home');
      mkdirSync(home);
      const productFolder = makeProduct(home, 'tiny', repository, 'tiny');
      const lines = new Lines();
      const sent: FromWorker[] = [];
      const start: WorkerStart = {
        type: 'start', productFolder, productName: 'tiny', graphPath: join(work, 'store', 'graph'), readRoot: join(work, 'store', 'read'),
        repositories: [{ name: 'training', path: repository }], writer: true, language: 'en', languageChanged: false, snapshotMs: 0,
      };
      lines.push(JSON.stringify(start));
      const code = await runFillWorker({
        lines,
        send: (message) => {
          sent.push(message);
          if (message.type === 'agent-wanted') lines.push(JSON.stringify({ type: 'agent-ready' } as ToWorker));
          if (message.type === 'unit' && message.id === 'product:tiny') {
            // The agent's write_page is handed to the worker, and the person's stop stands behind it in the same queue:
            // the tool call is in flight when the worker reads the stop.
            lines.push(JSON.stringify({ type: 'tool', callId: 1, unit: 'product:tiny', name: 'write_page', args: {
              markdown: PRODUCT_PAGE_RU,
              domains: [{ slug: 'numbers', title: 'Числа', summary: 'Числа считают листовая и корневая функции.', evidence: [FILE] }],
            } } as ToWorker));
            lines.push(JSON.stringify({ type: 'stop' } as ToWorker));
          }
        },
      });
      expect(code).toBe(0);
      expect(sent.some((message) => message.type === 'writer' && message.state === 'stopped')).toBe(true);
      expect(sent.some((message) => message.type === 'writer' && message.state === 'paused')).toBe(false);
      // The stop is reported only after the in-flight write_page has answered: its fence refuses publication, and the
      // answer stands before the stopped message rather than being left to finish after the worker is gone.
      const answered = sent.findIndex((message) => message.type === 'tool-result' && message.callId === 1);
      const stopped = sent.findIndex((message) => message.type === 'writer' && message.state === 'stopped');
      expect(answered).toBeGreaterThanOrEqual(0);
      expect(answered).toBeLessThan(stopped);
      expect(existsSync(join(productFolder, PRODUCT_FILE))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 300_000);
});
