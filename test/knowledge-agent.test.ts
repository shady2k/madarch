/**
 * The agent stage of the knowledge wiki (decision 0029; madarch-m38l.3): the
 * reader's choice of the agent, the single press that fills the graph and
 * flows into the writer inside the running server, and the pages that appear
 * as each unit writes them. The code repository is a two-commit fixture built
 * here; the fill, the writer and its checks are the real ones, and the agent
 * is a scripted one that answers through the unit's tools (no model). The
 * test holds the second unit open to prove the server keeps answering and
 * that the page of the first unit is served before the second unit ends.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ACP_ADAPTERS, acpAgentFolder } from '../src/fill/acp-probe.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { UnitAgent, UnitRequest } from '../src/writer/index.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct, recordKey } from './knowledge-fixture.js';
import { readDocEntities, docEntityId } from '../src/knowledge/doc-entities.js';
import { parseKinds } from '../src/knowledge/kinds.js';
import { SCRIPTED_GUIDE_PATH, SCRIPTED_GUIDE_SOURCE, verifyScriptedGuide, writeScriptedGuide } from './scripted-guide-agent.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

const A_TS = ['export function leaf(): number {', '  return 1;', '}', '', 'export function root(): number {', '  return leaf() + 1;', '}', ''].join('\n');
const FILE = recordKey('code.file', 'src/a.ts');

const PRODUCT_PAGE = [
  '---', 'id: product:tiny', 'kind: product', 'title: Tiny', 'relates:', `  - ${FILE}`, 'producer: agent', 'sources: []', '---', '',
  '## What the product is', '',
  'The tiny product computes numbers with a leaf function and a root function.[^1]', '',
  '## Domains', '',
  `- [Numbers](madarch:domain:numbers) are computed in the [source file](madarch:${FILE}).[^2]`, '',
  `[^1]: [a.ts](madarch:${FILE})`, `[^2]: [a.ts](madarch:${FILE})`,
].join('\n');
const DOMAIN_PAGE_RU = [
  '---', 'id: domain:numbers', 'kind: domain', 'title: Числа', 'relates:', `  - ${FILE}`, 'producer: agent', 'sources: []', '---', '',
  '## Как считаются числа', '',
  'Корневая функция прибавляет единицу к значению, которое возвращает листовая функция, т.е. считает на единицу больше.[^1]', '',
  'См. также [исходный файл](madarch:' + FILE + ').', '',
  `[^1]: [a.ts](madarch:${FILE})`,
].join('\n');
const DOMAIN_PAGE = [
  '---', 'id: domain:numbers', 'kind: domain', 'title: Numbers', 'relates:', `  - ${FILE}`, 'producer: agent', 'sources: []', '---', '',
  '## How numbers are computed', '',
  'The root function adds one to the value the leaf function returns.[^1]', '',
  `[^1]: [a.ts](madarch:${FILE})`,
].join('\n');

let work: string;
let home: string;
let server: StartedServer;
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
const seen: string[] = [];
let spoilDomain = false;
/** The prompts the agent was handed, in order: the language the pages are asked in is told to it. */
const prompts: string[] = [];
let serverEnv: Record<string, string | undefined>;
const agentFolder = (id: string): string => acpAgentFolder(ACP_ADAPTERS.find((entry) => entry.id === id)!, serverEnv);

/** The scripted agent: the product unit writes at once; the domain unit waits for the test's gate, then writes (or is refused). */
const agent: UnitAgent & { close(): Promise<void> } = {
  async run(request: UnitRequest): Promise<void> {
    if (request.id.startsWith('guide-proof:')) {
      await verifyScriptedGuide(request.prompt, (tool, args) => request.tools.call(tool, args));
      return;
    }
    seen.push(request.id);
    prompts.push(request.prompt);
    if (request.id === 'administrator-guide:main' || request.id === 'user-guide:main') {
      await writeScriptedGuide(request.prompt, (tool, args) => request.tools.call(tool, args));
      return;
    }
    if (request.id.startsWith('localized-source:')) {
      const written = await request.tools.call('write_localized_source', { statement: 'Счет, в котором хранится результат завершенного вычисления.' });
      if (written.isError) throw new Error(`the localized source was refused: ${JSON.stringify(written.answer)}`);
      return;
    }
    if (request.id === 'product:tiny') {
      const written = await request.tools.call('write_page', {
        markdown: PRODUCT_PAGE,
        domains: [{ slug: 'numbers', title: 'Numbers', summary: 'Numbers are what the leaf and root functions compute.', evidence: [FILE] }],
      });
      if (written.isError) throw new Error(`the product page was refused: ${JSON.stringify(written.answer)}`);
      return;
    }
    await gate;
    const russian = request.prompt.includes('in Russian');
    const markdown = spoilDomain ? `${russian ? DOMAIN_PAGE_RU : DOMAIN_PAGE}\n\nThe domain is very fast.` : russian ? DOMAIN_PAGE_RU : DOMAIN_PAGE;
    await request.tools.call('write_page', { markdown });
  },
  async close(): Promise<void> {},
};

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/tiny${path}`);
  return { status: response.status, body: await response.json() };
};
const post = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${server.url}/products/tiny${path}`, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, tries = 400): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((rest) => setTimeout(rest, 250));
  }
  throw new Error(`gave up waiting for ${what}`);
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-knowledge-agent-'));
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
  writeFileSync(join(productFolder, 'docs', 'glossary.md'), '# Glossary\n\n- **Tiny account** - An account that holds the number results from a completed calculation.\n- **X** - X.\n');
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
  // The machine the agent runs on: a home of its own and a PATH with no adapter and no npm, so nothing is fetched and nothing is run.
  const bin = join(work, 'bin');
  mkdirSync(bin);
  mkdirSync(join(work, 'user'));
  serverEnv = { ...process.env, HOME: join(work, 'user'), MADARCH_HOME: join(work, 'user', 'madarch'), PATH: bin };
  server = await startServer({
    productHome: home, appFolder: app, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined,
    env: serverEnv,
    knowledgeAgentFactory: () => agent,
  });
  // The first page of a product waits for its reader to start (a process of its own): the suite's first test does not.
  await fetch(`${server.url}/products/tiny/api/k/status`);
}, 60_000);

afterAll(async () => {
  release();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
});

describe('the choice of the agent', () => {
  test('the wiki offers Claude Code, Codex, OpenCode and omp (not Pi) with their state, states the bound in numbers, and has chosen none', async () => {
    const status = await get('/api/k/status');
    expect(status.body.chosenAgent).toBeNull();
    expect(status.body.bounds).toEqual({ turns: 30, minutes: 10, toolCalls: 80, writeAttempts: 5, maxDomains: 12 });
    expect(status.body.writer).toMatchObject({ state: 'idle', agent: null, units: [] });
    const agents = await get('/api/k/agents');
    expect(agents.body.chosen).toBeNull();
    expect(agents.body.agents.map((offer: { id: string; installed: boolean; install: { package: string; folder: string } | null }) => [offer.id, offer.installed, offer.install?.package])).toEqual([
      ['claude-code', false, '@agentclientprotocol/claude-agent-acp'],
      ['codex', false, '@agentclientprotocol/codex-acp'],
      ['opencode', false, 'opencode-ai'],
      ['omp', false, '@oh-my-pi/pi-coding-agent'],
    ]);
    expect(agents.body.agents[0].install.folder).toBe(agentFolder('claude-code'));
  });

  test('an agent that is not installed is refused without the reader\'s yes, and with it the install says why it could not run', async () => {
    const refused = await post('/api/k/agent', { agent: 'claude-code', install: false });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('Claude Code adapter is not installed');
    expect(refused.body.message).toContain(agentFolder('claude-code'));
    const failed = await post('/api/k/agent', { agent: 'claude-code', install: true });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.body.message).toContain('npm');
    expect((await get('/api/k/agents')).body.chosen).toBeNull();
    expect((await post('/api/k/agent', { agent: 'pi', install: true })).status).toBe(400);
    expect((await post('/api/k/agent', {})).status).toBe(400);
  });

  test('the choice is kept in the product\'s store folder, outside the product repository, and survives; null clears it', async () => {
    const bin = join(work, 'bin');
    writeFileSync(join(bin, 'claude-agent-acp'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'claude-agent-acp'), 0o755);
    const chosen = await post('/api/k/agent', { agent: 'claude-code', install: false });
    expect(chosen).toMatchObject({ status: 200, body: { chosen: { id: 'claude-code', label: 'Claude Code' } } });
    expect((await get('/api/k/status')).body.chosenAgent).toEqual({ id: 'claude-code', label: 'Claude Code' });
    const id = (await get('/api/k/status')).body.product.id;
    expect(JSON.parse(readFileSync(join(work, 'store', id, 'writer.json'), 'utf8'))).toEqual({ agent: 'claude-code' });
    expect(existsSync(join(home, 'tiny', 'writer.json'))).toBe(false);
    expect((await post('/api/k/agent', { agent: null })).status).toBe(200);
    expect((await get('/api/k/status')).body.chosenAgent).toBeNull();
  });
});

describe('a fill with no agent chosen', () => {
  test('reads the code, runs no agent and writes no page; the wiki then offers the agent', async () => {
    expect((await post('/api/k/fill')).status).toBe(202);
    const status = await until('the fill', async () => (await get('/api/k/status')).body, (body) => body.fill.state !== 'running');
    expect(status.fill.state).toBe('done');
    expect(status.writer).toMatchObject({ state: 'idle', units: [] });
    expect(seen).toEqual([]);
    expect(status.home).toBeNull();
    expect(existsSync(join(home, 'tiny', 'docs', 'product.md'))).toBe(false);
  }, 300_000);
});

describe('the consent of a press', () => {
  test('a request another site made through the reader\'s browser starts no fill and chooses nothing', async () => {
    const foreign = { 'sec-fetch-site': 'cross-site' };
    const fill = await fetch(`${server.url}/products/tiny/api/k/fill`, { method: 'POST', headers: foreign });
    expect(fill.status).toBe(403);
    expect(((await fill.json()) as { message: string }).message).toContain('another site');
    const choice = await fetch(`${server.url}/products/tiny/api/k/agent`, { method: 'POST', headers: { ...foreign, 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'codex', install: true }) });
    expect(choice.status).toBe(403);
    expect((await get('/api/k/status')).body.fill.state).toBe('done');
  });

  test('a press made for one agent is refused when another is saved, and runs nothing', async () => {
    expect((await post('/api/k/agent', { agent: 'claude-code', install: false })).status).toBe(200);
    const refused = await post('/api/k/fill', { agent: 'codex' });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('claude-code');
    expect(refused.body.message).toContain('codex');
    expect((await get('/api/k/status')).body.writer.state).toBe('idle');
    expect(seen).toEqual([]);
  });

  test('two choices made together leave one whole choice', async () => {
    const [first, second] = await Promise.all([post('/api/k/agent', { agent: 'claude-code', install: false }), post('/api/k/agent', { agent: null })]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await get('/api/k/status')).body.chosenAgent).toBeNull();
    expect((await post('/api/k/agent', { agent: 'claude-code', install: false })).status).toBe(200);
  });
});

describe('one press with an agent chosen', () => {
  test('flows into the agent: the product page is served at once, before the second unit ends, and the server answers meanwhile', async () => {
    expect((await post('/api/k/agent', { agent: 'claude-code', install: false })).status).toBe(200);
    const events: string[] = [];
    const stream = new AbortController();
    const reading = fetch(`${server.url}/products/tiny/api/events`, { signal: stream.signal }).then(async (response) => {
      const decoder = new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) events.push(decoder.decode(chunk));
    }).catch(() => undefined);
    expect((await post('/api/k/fill', { agent: 'claude-code' })).status).toBe(202);
    // The product unit writes; the domain unit is then held open by the test.
    const running = await until('the domain unit to be writing', async () => (await get('/api/k/status')).body, (body) => body.writer.units.some((unit: { unit: string; state: string }) => unit.unit === 'domain:numbers' && unit.state === 'writing'));
    expect(running.writer).toMatchObject({ state: 'running', agent: { id: 'claude-code' }, current: 'domain:numbers' });
    expect(running.writer.units.map((unit: { unit: string; state: string }) => [unit.unit, unit.state])).toEqual([['product:tiny', 'written'], ['domain:numbers', 'writing']]);
    expect(running.home).toBe('product:tiny');
    // The first page is served while the second unit is still open.
    const home = await get('/api/k/page?id=product%3Atiny');
    expect(home.status).toBe(200);
    const body = home.body.blocks.find((block: { type: string }) => block.type === 'body');
    expect(body.markdown).toContain('The tiny product computes numbers with a leaf function and a root function.');
    expect(body.ungrounded).toEqual([]);
    const sameLanguageGlossary = await get('/api/k/glossary');
    const sameLanguageTerm = sameLanguageGlossary.body.terms.find((term: { title: string }) => term.title === 'Tiny account');
    expect(sameLanguageTerm.definition).toContain('An account that holds the number results');
    expect(sameLanguageTerm.source).toBeUndefined();
    // The grounds resolve; the link to the domain whose page is not yet written is shown as broken until its unit writes it.
    const states = Object.entries(home.body.resolutions).map(([link, resolution]) => [link, (resolution as { state: string }).state]);
    expect(states.filter(([, state]) => state === 'broken').map(([link]) => link)).toEqual(['madarch:domain:numbers']);
    expect(readFileSync(join(work, 'home', 'tiny', 'docs', 'product.md'), 'utf8')).toContain('id: product:tiny');
    expect(existsSync(join(work, 'home', 'tiny', 'docs', 'domains', 'numbers.md'))).toBe(false);
    expect((await get('/api/k/entities?kind=code.symbol')).status).toBe(200);
    // The open stream was told a page was written.
    expect(events.join('')).toContain('event: change');
    release();
    const done = await until('the stage', async () => (await get('/api/k/status')).body, (value) => value.writer.state !== 'running');
    // A localized source is named by the passage's durable identity, so the expectation reads it from the document
    // rather than naming a minted number (madarch-ztyq.3).
    const productFolder = join(work, 'home', 'tiny');
    const kindsFile = join(productFolder, 'madarch', 'kinds.yaml');
    const kinds = parseKinds(readFileSync(kindsFile, 'utf8'), kindsFile, productFolder);
    const glossaryText = readFileSync(join(productFolder, 'docs', 'glossary.md'), 'utf8');
    const glossaryPage = readDocEntities([{ repo: null, path: 'docs/glossary.md', text: glossaryText }], kinds).entities.find((entity) => entity.anchor === 'x')!;
    expect(glossaryPage.id).toBe(docEntityId(null, 'docs/glossary.md', glossaryPage.stableId));
    expect(done.writer).toMatchObject({ state: 'done', units: [{ unit: 'product:tiny', state: 'written' }, { unit: 'domain:numbers', state: 'written' }, { unit: `localized-source:${glossaryPage.id}`, state: 'not-written', refusals: [{ rule: 'source-language' }] }, { unit: 'administrator-guide:main', state: 'written' }, { unit: 'user-guide:main', state: 'written' }] });
    expect(seen).toEqual(['product:tiny', 'domain:numbers', 'administrator-guide:main', 'user-guide:main']);
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

    const domain = await get('/api/k/page?id=domain%3Anumbers');
    expect(domain.status).toBe(200);
    expect(domain.body.blocks.find((block: { type: string }) => block.type === 'body').markdown).toContain('The root function adds one');
    const homeAfter = await get('/api/k/page?id=product%3Atiny');
    expect(Object.values(homeAfter.body.resolutions).every((resolution) => (resolution as { state: string }).state === 'ok')).toBe(true);
    stream.abort();
    await reading;
  }, 120_000);

  test('a second press with the pages in place runs no unit', async () => {
    // Every page is there and in the language asked: the fill reads the code again and the agent is not asked for anything.
    seen.length = 0;
    expect((await post('/api/k/fill')).status).toBe(202);
    await until('the refresh', async () => (await get('/api/k/status')).body, (value) => value.fill.state === 'done' && value.writer.state !== 'running' && value.writer.state !== 'waiting');
    expect(seen).toEqual([]);
  }, 120_000);

  test('a press that changes the language of the pages tells the agent, writes every page again, and a Russian page is accepted', async () => {
    seen.length = 0;
    prompts.length = 0;
    expect((await post('/api/k/fill', { agent: 'claude-code', language: 'ru' })).status).toBe(202);
    // The manifest holds the language now, and every unit's prompt tells the agent to write in it.
    expect(readFileSync(join(home, 'tiny', 'madarch', 'kinds.yaml'), 'utf8')).toContain('language: ru');
    const done = await until('the Russian run', async () => (await get('/api/k/status')).body, (value) => value.language === 'ru' && value.writer.state === 'done' && value.fill.state === 'done');
    expect(done.writer.units.map((unit: { state: string }) => unit.state)).toEqual(['written', 'written', 'written', 'not-written', 'written', 'written']);
    // The second glossary term says `X.` alone, which no language is read from: its unit is the one left unwritten.
    const skipped = done.writer.units.find((unit: { unit: string; state: string }) => unit.unit.startsWith('localized-source:doc:docs/glossary.md#') && unit.state === 'not-written');
    expect(skipped).toMatchObject({ state: 'not-written', refusals: [{ rule: 'source-language' }] });
    expect(seen).toEqual(['product:tiny', 'domain:numbers', expect.stringMatching(/^localized-source:doc:docs\/glossary\.md#/), 'administrator-guide:main', 'user-guide:main']);
    expect(prompts.filter((_, index) => !seen[index]!.startsWith('localized-source:') && !seen[index]!.endsWith('-guide:main')).every((prompt) => prompt.includes('Write every sentence and every heading of the page, and its title, in Russian'))).toBe(true);
    expect(prompts.filter((_, index) => seen[index]!.endsWith('-guide:main')).every((prompt) => prompt.includes(' in Russian from this complete bounded prepared context.'))).toBe(true);
    expect(prompts.at(-1)).toContain('in Russian');
    for (const id of ['administrator-guide:main', 'user-guide:main']) {
      const page = await get(`/api/k/page?id=${encodeURIComponent(id)}`);
      expect(page.body.blocks.find((block: { type: string }) => block.type === 'guide').data.guide.locale).toBe('ru');
    }
    expect(readFileSync(join(home, 'tiny', 'docs', 'domains', 'numbers.md'), 'utf8')).toContain('Как считаются числа');
    const glossary = await get('/api/k/glossary');
    const localizedTerm = glossary.body.terms.find((term: { title: string }) => term.title === 'Tiny account');
    // The file a localized source is kept in is named by the entity's durable identity, which the page id also names.
    const localizedPath = join(home, 'tiny', 'docs', 'sources', 'doc.term', createHash('sha256').update(localizedTerm.id).digest('hex') + '.md');
    expect(readFileSync(localizedPath, 'utf8')).toContain('Счет, в котором хранится результат завершенного вычисления.');
    expect(localizedTerm.definition).toBe('Счет, в котором хранится результат завершенного вычисления.');
    expect(localizedTerm.source).toMatchObject({ original: expect.stringContaining('An account that holds'), document: 'docs/glossary.md' });
    const entityPage = await get(`/api/k/page?id=${encodeURIComponent(localizedTerm.id)}`);
    expect(entityPage.status).toBe(200);
    const localizedBlock = entityPage.body.blocks.find((block: { type: string }) => block.type === 'term');
    expect(localizedBlock.definition).toBe('Счет, в котором хранится результат завершенного вычисления.');
    expect(localizedBlock.localized.original).toContain('An account that holds');
    writeFileSync(localizedPath, '---\nentity: another-entity\n---\n\n## Localized statement\n\nNo wrong text.\n\n## In the source\n\nA different source.\n');
    const invalidGlossary = await get('/api/k/glossary');
    const invalidTerm = invalidGlossary.body.terms.find((term: { title: string }) => term.title === 'Tiny account');
    expect(invalidTerm.definition).toBe('');
    expect(invalidGlossary.body.findings.some((finding: { file: string; line: number }) => finding.file === 'docs/sources/doc.term/' + createHash('sha256').update(localizedTerm.id).digest('hex') + '.md' && finding.line > 0)).toBe(true);
  }, 120_000);

  test('a unit the writer refused is shown with its line and rule', async () => {
    spoilDomain = true;
    seen.length = 0;
    expect((await post('/api/k/fill', { agent: 'claude-code', language: 'en' })).status).toBe(202);
    const done = await until('the second stage', async () => (await get('/api/k/status')).body, (value) => value.writer.state === 'failed');
    const domain = done.writer.units.find((unit: { unit: string }) => unit.unit === 'domain:numbers');
    expect(domain.state).toBe('failed');
    expect(domain.refusals.length).toBeGreaterThan(0);
    expect(domain.refusals[0]).toMatchObject({ rule: 'ungrounded-statement' });
    expect(domain.refusals[0].line).toBeGreaterThan(0);
    expect(done.writer.message).toContain('some pages were not written');
    // The product page of the run stays.
    expect(done.writer.units[0].state).toBe('written');
  }, 120_000);
});
