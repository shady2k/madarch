/**
 * The fill as a page of its own (madarch-m38l.23): the units of the agent stage named the way a reader knows them, the
 * pages the running fill has taken up absent from the problems until the run ends, and a page's journal named by the
 * runs that hold it. The product, the fill and its checks are the real ones; the agent is scripted (no model), and the
 * test holds the domain unit and the first document unit open to read the status while they are being written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { AgentFactory } from '../src/knowledge/product.js';
import type { ToolClient, UnitAgent, UnitRequest } from '../src/writer/index.js';
import type { Journal } from '../src/writer/journal.js';
import { detectDocumentLanguage, localizedSourcePath } from '../src/writer/localized-source.js';
import { readDocEntities } from '../src/knowledge/doc-entities.js';
import { parseKinds } from '../src/knowledge/kinds.js';
import { gitEnv } from './git-env.js';
import { makeProduct, recordKey, SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { SCRIPTED_GUIDE_PATH, SCRIPTED_GUIDE_SOURCE, verifyScriptedGuide, writeScriptedGuide } from './scripted-guide-agent.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

const A_TS = ['export function leaf(): number {', '  return 1;', '}', '', 'export function root(): number {', '  return leaf() + 1;', '}', ''].join('\n');
const FILE = recordKey('code.file', 'src/a.ts');
const GLOSSARY = '# Glossary\n\n- **Tiny account** - An account that holds the number results from a completed calculation.\n- **Tiny ledger** - A ledger that lists every number a completed calculation produced.\n- **X** - X.\n';

// The home page is written from its eight fields (madarch-ztyq.7), not from Markdown: the core renders the sections,
// their headings in the wiki's language and the sentence a part says when nothing was found. Only the sections this
// fixture needs are given; the others are drawn as their own gap sentences.
const PRODUCT_FIELDS_RU = {
  title: 'Крошечный продукт',
  whatItIs: [{ text: 'Крошечный продукт считает числа с помощью листовой и корневой функций.', grounds: [FILE] }],
  domains: [{ target: 'domain:numbers', text: 'Числа считаются в исходном файле.', grounds: [FILE] }],
};
const DOMAIN_PAGE_RU = [
  '---', 'id: domain:numbers', 'kind: domain', 'title: Числа', 'relates:', `  - ${FILE}`, 'producer: agent', 'sources: []', '---', '',
  '## Как считаются числа', '',
  'Корневая функция прибавляет единицу к значению, которое возвращает листовая функция, т.е. считает на единицу больше.[^1]', '',
  `[^1]: [a.ts](madarch:${FILE})`,
].join('\n');

let work: string;
let home: string;
let server: StartedServer;
/** The holds the test queues: the agent's next held unit waits on one until the test opens it. */
const opens: (() => void)[] = [];
const waits: Promise<void>[] = [];
function hold(): void { let open!: () => void; waits.push(new Promise<void>((resolve) => { open = resolve; })); opens.push(open); }
/** Opens the hold the agent queued first: the domain unit, then the first document unit. */
function release(): void { opens.shift()?.(); }
/** Opens every hold left, so a failing test does not leave the agent waiting. */
function releaseAll(): void { for (const open of opens.splice(0)) open(); }
/** The document unit the run may not write: the page it would write stays a problem after the run, as it was before. */
let skip: string | null = null;
/** Set when the test has held one document unit; only the first one that may be written is held. */
let heldOne = false;
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
    if (request.id.startsWith('localized-source:')) {
      // The page the test names is left unwritten, so it is still a problem when the run ends.
      if (request.id === skip) return;
      // The first document unit the run takes up is held, so its page is read while it is being written.
      if (!heldOne) { heldOne = true; await wait(); }
      const written = await request.tools.call('write_localized_source', { statement: 'Счет, в котором хранится результат завершенного вычисления.' });
      if (written.isError) throw new Error(`the localized source was refused: ${JSON.stringify(written.answer)}`);
      return;
    }
    if (request.id === 'product:tiny') {
      const written = await request.tools.call('write_page', {
        fields: PRODUCT_FIELDS_RU,
        domains: [{ slug: 'numbers', title: LONG_TITLE, summary: 'Числа считают листовая и корневая функции.', evidence: [FILE] }],
      });
      if (written.isError) throw new Error(`the product page was refused: ${JSON.stringify(written.answer)}`);
      return;
    }
    await wait();
    const written = await request.tools.call('write_page', { markdown: DOMAIN_PAGE_RU });
    if (written.isError) throw new Error(`the domain page was refused: ${JSON.stringify(written.answer)}`);
  },
  async close(): Promise<void> {},
};

/**
 * The scripted agent with its calls written to the run's journal, as the agent layer writes a real agent's: a record per
 * allowed call, so the page can name the runs that hold it. A unit that made no call leaves no record and no journal.
 */
function journaled(script: AgentWithClose, journal: Journal): AgentWithClose {
  return {
    async run(request: UnitRequest): Promise<void> {
      const context = { run: journal.run, unit: request.id, agent: 'claude-code', model: null, session: null };
      const tools: ToolClient = {
        definitions: request.tools.definitions,
        finished: () => request.tools.finished(),
        call: async (tool: string, argumentsValue: unknown) => {
          const startedAt = new Date();
          const answer = await request.tools.call(tool, argumentsValue);
          const reply = JSON.stringify(answer.answer ?? null);
          journal.record(context, { kind: 'tool-call', tool, arguments: argumentsValue, response: reply, isError: answer.isError, outcome: answer.isError ? 'refused' : 'ok', reason: answer.isError ? reply : null, startedAt, durationMs: Date.now() - startedAt.getTime() });
          return answer;
        },
      };
      await script.run({ ...request, tools });
    },
    close: () => script.close(),
  };
}

/** The agent for one fill: the script, and the journal of the run it writes into. */
const agentFactory: AgentFactory = (_agentId: string, journal: Journal) => journaled(agent, journal);


/** A title long enough to test that a line about the page in the top bar stays inside a narrow screen. */
const LONG_TITLE = 'Числа, суммы и другие величины, которые считают листовая и корневая функции';

/** The agent a fill runs, with the close the filler calls when a unit is done. */
type AgentWithClose = UnitAgent & { close(): Promise<void> };

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

/**
 * Every document entity of the glossary, in the order the writer takes them up: each is a page the run takes up, whether
 * or not its language is known. The one whose language is unknown is still a page the run means to write.
 */
function documentPages(): { id: string; title: string; kind: string; file: string; text: string }[] {
  const productFolder = join(home, 'tiny');
  const kindsFile = join(productFolder, 'madarch', 'kinds.yaml');
  const kinds = parseKinds(readFileSync(kindsFile, 'utf8'), kindsFile, productFolder);
  const text = readFileSync(join(productFolder, 'docs', 'glossary.md'), 'utf8');
  return readDocEntities([{ repo: null, path: 'docs/glossary.md', text }], kinds).entities
    .map((entity) => ({ id: entity.id, title: entity.title, kind: entity.kind, file: localizedSourcePath(entity), text: entity.text }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** The document entities read as English, each a page the Russian fill writes. */
function localizedPages(): { id: string; title: string; kind: string; file: string }[] {
  return documentPages().filter((page) => detectDocumentLanguage(page.text) === 'en');
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-fill-page-'));
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
  const productFolder = makeProduct(home, 'tiny', repository, 'tiny');
  mkdirSync(join(productFolder, 'docs'), { recursive: true });
  writeFileSync(join(productFolder, 'docs', 'glossary.md'), GLOSSARY);
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  // The machine the agent runs on: an adapter that is installed (a script that exits), and no npm and no network use.
  const bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude-agent-acp'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'claude-agent-acp'), 0o755);
  mkdirSync(join(work, 'user'));
  server = await startServer({
    productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined,
    env: { ...process.env, HOME: join(work, 'user'), MADARCH_HOME: join(work, 'user', 'madarch'), PATH: bin },
    knowledgeAgentFactory: agentFactory,
  });
  await fetch(`${server.url}/products/tiny/api/k/status`);
}, 60_000);

afterAll(async () => {
  releaseAll();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('a fill read while it writes', () => {
  test('names each unit by the kind the manifest declares and the page\'s title, and keeps the path for the engineer', async () => {
    expect((await post('/api/k/agent', { agent: 'claude-code', install: false })).status).toBe(200);
    const pages = localizedPages();
    expect(pages.length).toBeGreaterThan(1);
    skip = `localized-source:${pages[pages.length - 1]!.id}`;
    hold(); // the domain unit
    expect((await post('/api/k/fill', { agent: 'claude-code', language: 'ru' })).status).toBe(202);
    // The product page is written; the domain unit is held open, so the domain's page does not stand yet.
    const writing = await until('the domain unit to be writing', async () => (await get('/api/k/status')).body, (body) => body.writer.units.some((unit: { unit: string; state: string }) => unit.unit === 'domain:numbers' && unit.state === 'writing'));
    expect(writing.writer.units.map((unit: { unit: string; kind?: string; title?: string; page?: string }) => [unit.unit, unit.kind, unit.title, unit.page])).toEqual([
      ['product:tiny', 'product', 'Крошечный продукт', 'product:tiny'],
      // The declaration the product page made names the domain before its page exists.
      ['domain:numbers', 'domain', LONG_TITLE, 'domain:numbers'],
    ]);
    // The path stays for the engineer, beside the reader's name.
    expect(writing.writer.units[1].path).toBe('docs/domains/numbers.md');
    hold(); // the first document unit
    release(); // the domain unit
    const document = await until('the first document unit to be writing', async () => (await get('/api/k/status')).body, (body) => body.writer.units.some((unit: { unit: string; state: string }) => unit.unit.startsWith('localized-source:') && unit.state === 'writing'));
    const held = document.writer.units.find((unit: { unit: string; state: string }) => unit.unit.startsWith('localized-source:') && unit.state === 'writing') as { unit: string; kind?: string; title?: string; page?: string; path: string };
    const page = pages.find((candidate) => `localized-source:${candidate.id}` === held.unit)!;
    // A document's page is named by the document entity's kind and title: «Термин Tiny account», never by the writer's word for its work.
    expect([held.kind, held.title, held.page]).toEqual([page.kind, page.title, page.id]);
    expect(page.kind).toBe('doc.term');
    expect(held.path.startsWith('docs/sources/')).toBe(true);
  }, 300_000);

  test('a page the running fill has taken up is not a problem until the run ends, and then only if it is still unwritten', async () => {
    const pages = localizedPages();
    const running = await get('/api/k/status');
    expect(running.body.writer.state).toBe('running');
    // The denominator is what the run means to write in total, told before its first unit: the product page, the
    // domain page it declared, the three document pages (one of them with a language the run cannot name) and the two
    // guides. What it has taken up so far is not it.
    expect(documentPages().length).toBe(3);
    expect(running.body.writer.total).toBe(1 + 1 + documentPages().length + 2);
    expect(running.body.writer.total).toBeGreaterThanOrEqual(running.body.writer.units.length);
    expect(running.body.writer.total).toBeGreaterThanOrEqual(running.body.writer.units.filter((unit: { state: string }) => unit.state === 'written').length);
    // The pages of the documents this run writes are being written now, so none of them is a problem yet.
    expect(running.body.findings.filter((finding: { file: string }) => pages.some((page) => page.file === finding.file))).toEqual([]);
    // The problems page reads its own listing: an unwritten page is not there either while the run stands.
    const problems = await get('/api/k/problems');
    expect(problems.status).toBe(200);
    expect(problems.body.problems.filter((problem: { file: string }) => pages.some((page) => page.file === problem.file))).toEqual([]);
    // Read again and again while the rest of the run goes on: the denominator never falls below what stands written.
    const samples: { total?: number; units: number; written: number }[] = [];
    release();
    const done = await until('the writer to end', async () => {
      const body = (await get('/api/k/status')).body;
      samples.push({ total: body.writer.total, units: body.writer.units.length, written: body.writer.units.filter((unit: { state: string }) => unit.state === 'written').length });
      return body;
    }, (body) => body.writer.state === 'done' || body.writer.state === 'failed');
    expect(samples.length).toBeGreaterThan(1);
    for (const sample of samples) {
      expect(typeof sample.total).toBe('number');
      expect(sample.total!).toBeGreaterThanOrEqual(sample.units);
      expect(sample.total!).toBeGreaterThanOrEqual(sample.written);
    }
    expect(done.writer.state).toBe('failed');
    // The one the run left unwritten is a problem again, with the file it waits for; the ones it wrote are not.
    const after = done.findings.filter((finding: { file: string }) => pages.some((page) => page.file === finding.file));
    expect(after.map((finding: { file: string }) => finding.file)).toEqual([pages[pages.length - 1]!.file]);
    // And it comes back to the problems page, so the exclusion is the run's and not a loss.
    const listed = await get('/api/k/problems');
    expect(listed.body.problems.filter((problem: { file: string }) => pages.some((page) => page.file === problem.file)).map((problem: { file: string }) => problem.file)).toContain(pages[pages.length - 1]!.file);
  }, 300_000);

  test('says which runs hold a page\'s journal only where one holds it', async () => {
    const pages = localizedPages();
    const written = await get(`/api/k/page?id=${encodeURIComponent('product:tiny')}`);
    expect(written.status).toBe(200);
    expect(Array.isArray(written.body.journal)).toBe(true);
    expect(written.body.journal.length).toBeGreaterThan(0);
    // A page whose unit wrote nothing has no journal, and says none.
    const unwritten = await get(`/api/k/page?id=${encodeURIComponent(pages[pages.length - 1]!.id)}`);
    expect(unwritten.status).toBe(200);
    expect(unwritten.body.journal).toBeUndefined();
    // The journal of a document's page is the localized source's own: asked by the page's id, it answers with the records.
    const writtenPage = pages.find((page) => `localized-source:${page.id}` !== skip)!;
    const journal = await get(`/api/k/journal?id=${encodeURIComponent(writtenPage.id)}`);
    expect(journal.status).toBe(200);
    expect(journal.body.run).not.toBeNull();
    expect(journal.body.records.length).toBeGreaterThan(0);
    const none = await get('/api/k/journal?id=question%3Anone');
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ run: null, runs: [], records: [], problems: [], totals: { sourceBytes: { served: 0, repeated: 0 }, evidence: 0, unresolvedJoins: 0, produced: { pages: 0, statements: 0, grounds: 0, links: 0, questions: 0 } } });
  }, 120_000);
});
