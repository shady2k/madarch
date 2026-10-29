/// <reference lib="dom" />
/**
 * The fill as a reader meets it, against the production-built wiki app and its real server (madarch-m38l.23): the badge
 * in the top bar that counts the pages an agent has taken up, the short popover it opens — which must stay inside a
 * 390 px viewport — the pulsing dot that stands still when motion is reduced, and the fill page itself with the pages
 * named by their kind and title, their links, their journal and the engineer's details. The product is a small factory
 * fixture built in a scratch folder; the agent is scripted and holds the run open while the browser reads it.
 * Run with MADARCH_WIKI_E2E=1 after building wiki/app.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { AgentFactory } from '../src/knowledge/product.js';
import type { Journal } from '../src/writer/journal.js';
import type { ToolClient, UnitAgent, UnitRequest } from '../src/writer/index.js';
import { gitEnv } from './git-env.js';
import { SCRIPTED_GUIDE_PATH, SCRIPTED_GUIDE_SOURCE, verifyScriptedGuide, writeScriptedGuide } from './scripted-guide-agent.js';
import { makeProduct, recordKey, SAMPLE_IDENTITY } from './knowledge-fixture.js';

const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('Fill viewport Chromium E2E tests skipped: set MADARCH_WIKI_E2E=1 after building wiki/app.');

const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
/** The shots this task hands back, in the repository's out folder. */
const SHOTS = join(ROOT, 'out', 'shots-m38l23');
const WIDTH = 390;
const NARROW = { width: WIDTH, height: 844 };
const WIDE = { width: 1150, height: 900 };

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
const A_TS = ['export function leaf(): number {', '  return 1;', '}', '', 'export function root(): number {', '  return leaf() + 1;', '}', ''].join('\n');
const FILE = recordKey('code.file', 'src/a.ts');
const GLOSSARY = '# Glossary\n\n- **Tiny account** - An account that holds the number results from a completed calculation.\n- **Tiny ledger** - A ledger that lists every number a completed calculation produced.\n- **Tiny note** - A short note about the numbers.\n';
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

let work: string;
let server: StartedServer;
let browser: Browser;
let page: Page;

/** The holds the test queues: the agent's next held unit waits on one until the test opens it. */
const opens: (() => void)[] = [];
const waits: Promise<void>[] = [];
/** The first document unit is held once, so the fill stays under way while the browser reads it. */
let heldOne = false;

const script: AgentWithClose = {
  async run(request: UnitRequest): Promise<void> {
    if (request.id.startsWith('guide-proof:')) {
      await verifyScriptedGuide(request.prompt, (tool, argumentsValue) => request.tools.call(tool, argumentsValue));
      return;
    }
    if (request.id === 'administrator-guide:main' || request.id === 'user-guide:main') {
      await writeScriptedGuide(request.prompt, (tool, argumentsValue) => request.tools.call(tool, argumentsValue));
      return;
    }
    const wait = (): Promise<void> => waits.shift() ?? Promise.resolve();
    if (request.id.startsWith('localized-source:')) {
      if (!heldOne) { heldOne = true; await wait(); }
      const written = await request.tools.call('write_localized_source', { statement: 'Счет, в котором хранится результат завершенного вычисления.' });
      if (written.isError) throw new Error(`the localized source was refused: ${JSON.stringify(written.answer)}`);
      return;
    }
    if (request.id === 'product:tiny') {
      const written = await request.tools.call('write_page', {
        markdown: PRODUCT_PAGE_RU,
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

/** The scripted agent with its calls written to the run's journal, as the agent layer writes a real agent's. */
function journaled(unit: AgentWithClose, journal: Journal): AgentWithClose {
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
      await unit.run({ ...request, tools });
    },
    close: () => unit.close(),
  };
}

const agentFactory: AgentFactory = (_agentId: string, journal: Journal) => journaled(script, journal);


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

const open = async (path: string): Promise<void> => {
  await page.goto(`${server.url}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=knowledge-app]', { timeout: 20000 });
};
const capture = async (name: string): Promise<void> => { await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };
/** The screen as the reader has it, for a shot of something anchored to it (a full-page shot moves a fixed popover). */
const captureScreen = async (name: string): Promise<void> => { await page.screenshot({ path: join(SHOTS, name) }); };
/** Hit-test the visible element, then send an actual mouse click at its center: the toolbar must not swallow it. */
const clickAt = async (selector: string): Promise<void> => {
  const hit = await page.$eval(selector, (element) => {
    element.scrollIntoView({ block: 'center' });
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { width: box.width, height: box.height, receivesClick: top === element || (top !== null && element.contains(top)) };
  });
  expect(hit.width).toBeGreaterThan(0);
  expect(hit.height).toBeGreaterThan(0);
  expect(hit.receivesClick).toBe(true);
  const box = await page.$eval(selector, (element) => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

runDescribe('the fill a reader meets', () => {
  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`Built wiki app is missing: ${join(APP, 'index.html')}`);
    mkdirSync(SHOTS, { recursive: true });
    work = mkdtempSync(join(tmpdir(), 'madarch-fill-viewport-'));
    const repository = join(work, 'repo');
    mkdirSync(join(repository, 'src'), { recursive: true });
    git(repository, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repository, 'src', 'a.ts'), A_TS);
    writeFileSync(join(repository, 'package.json'), '{"name":"tiny","dependencies":{}}\n');
    mkdirSync(join(repository, 'docs'));
    writeFileSync(join(repository, SCRIPTED_GUIDE_PATH), SCRIPTED_GUIDE_SOURCE);
    git(repository, 'add', '.');
    git(repository, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the leaf and the root', '--date', '2026-03-01T10:00:00Z');
    const home = join(work, 'home');
    mkdirSync(home);
    const productFolder = makeProduct(home, 'tiny', repository, 'tiny');
    mkdirSync(join(productFolder, 'docs'), { recursive: true });
    writeFileSync(join(productFolder, 'docs', 'glossary.md'), GLOSSARY);
    const bin = join(work, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude-agent-acp'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'claude-agent-acp'), 0o755);
    mkdirSync(join(work, 'user'));
    server = await startServer({
      productHome: home, appFolder: APP, port: 0, knowledgeRoot: join(work, 'store'), log: () => undefined, errorLog: () => undefined,
      env: { ...process.env, HOME: join(work, 'user'), MADARCH_HOME: join(work, 'user', 'madarch'), PATH: bin },
      knowledgeAgentFactory: agentFactory,
    });
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    // The reader speaks Russian: the interface language, as the language control would keep it.
    await page.evaluateOnNewDocument(() => { try { globalThis.localStorage.setItem('madarch-wiki-language', 'ru'); } catch { /* the browser still speaks its own */ } });
    expect((await post('/api/k/agent', { agent: 'claude-code', install: false })).status).toBe(200);
    // The reader has already chosen: the role card does not stand over the page.
    expect((await post('/api/k/settings', { role: 'everything' })).status).toBe(200);
    opens.length = 0;
    waits.length = 0;
    heldOne = false;
    // The domain unit is held: the product page is written and the domain's page is being written while the browser reads.
    let release!: () => void;
    waits.push(new Promise<void>((resolve) => { release = resolve; }));
    opens.push(release);
    expect((await post('/api/k/fill', { agent: 'claude-code', language: 'ru' })).status).toBe(202);
    await until('the domain unit to be writing', async () => (await get('/api/k/status')).body, (body) => body.writer.units.some((unit: { unit: string; state: string }) => unit.unit === 'domain:numbers' && unit.state === 'writing'));
    heldOne = true;
  }, 120_000);

  afterAll(async () => {
    for (const release of opens.splice(0)) release();
    try { if (page !== undefined) await page.close(); } catch { /* the run is over */ }
    try { if (browser !== undefined) await browser.close(); } finally {
      try { await server?.stop(); } finally { if (work !== undefined) rmSync(work, { recursive: true, force: true }); }
    }
  }, 120_000);

  test('the top bar says the agent writes the pages, counts them, and its popover stays inside a 390 px viewport', async () => {
    await page.setViewport(NARROW);
    await open('/products/tiny/k');
    await page.waitForSelector('[data-testid=fill-chip]', { timeout: 20000 });
    const chip = await page.$eval('[data-testid=fill-chip]', (element) => element.textContent?.trim());
    // The denominator is the number of pages the run means to write, told by the writer itself, not the two it has
    // taken up: the reader sees how much is left.
    const counted = (await get('/api/k/status')).body.writer;
    expect(typeof counted.total).toBe('number');
    expect(counted.total).toBeGreaterThanOrEqual(counted.units.length);
    expect(chip).toBe(`Агент пишет страницы · 1/${counted.total}`);
    // The home page says the same in one line, with no paths and no list of pages.
    const line = await page.$eval('[data-testid=writer-line-words]', (element) => element.textContent ?? '');
    expect(line).toContain(`пишет страницы: записано 1 из ${counted.total}`);
    expect(line).toContain(`сейчас — Домен ${LONG_TITLE}`);
    expect(line).not.toContain('docs/');
    expect(await page.$$eval('[data-testid=writer-unit]', (elements) => elements.length)).toBe(0);
    await capture('during-390-light.png');
    await clickAt('[data-testid=fill-chip]');
    await page.waitForSelector('[data-testid=fill-menu]', { timeout: 5000 });
    const box = await page.$eval('[data-testid=fill-menu]', (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(WIDTH);
    // And it stands inside the screen's height too, not below it: a short popover under the badge.
    const vertical = await page.$eval('[data-testid=fill-menu]', (element) => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; });
    expect(vertical.top).toBeGreaterThanOrEqual(0);
    expect(vertical.bottom).toBeLessThanOrEqual(844);
    // Its content wraps instead of running off the edge.
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    // One line saying what is being written, a link to the fill page, and the language choice: no paths.
    const live = await page.$eval('[data-testid=fill-menu-live]', (element) => element.textContent ?? '');
    expect(live).toContain(`Пишется: Домен ${LONG_TITLE}`);
    expect(live).toContain('Открыть заполнение');
    expect(live).not.toContain('docs/');
    expect(await page.$('[data-testid=menu-language]')).not.toBeNull();
    // Nothing on the page scrolls sideways because of the popover.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(WIDTH);
    await captureScreen('during-390-popover-light.png');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=fill-chip]', { timeout: 20000 });
    await clickAt('[data-testid=fill-chip]');
    await page.waitForSelector('[data-testid=fill-menu]', { timeout: 5000 });
    const dark = await page.$eval('[data-testid=fill-menu]', (element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });
    expect(dark.left).toBeGreaterThanOrEqual(0);
    expect(dark.right).toBeLessThanOrEqual(WIDTH);
    await captureScreen('during-390-popover-dark.png');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  }, 120_000);

  test('the dot pulses while the agent writes and stands still when motion is reduced', async () => {
    await page.setViewport(NARROW);
    await open('/products/tiny/k');
    await page.waitForSelector('[data-testid=fill-chip-dot]', { timeout: 20000 });
    const moving = await page.$eval('[data-testid=fill-chip-dot]', (element) => getComputedStyle(element).animationName);
    expect(moving).not.toBe('none');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const still = await page.$eval('[data-testid=fill-chip-dot]', (element) => getComputedStyle(element).animationName);
    expect(still).toBe('none');
    await page.emulateMediaFeatures([]);
  }, 60_000);

  test('the fill page names each page by its kind and title, links the written page and its journal and keeps the path for the engineer', async () => {
    await page.setViewport(WIDE);
    await open('/products/tiny/k/fill');
    await page.waitForSelector('[data-testid=fill-units]', { timeout: 20000 });
    expect(await page.$eval('[data-testid=fill-title]', (element) => element.textContent?.trim())).toBe('Заполнение');
    // Counted against the pages the run means to write, the same total the badge shows.
    expect(await page.$eval('[data-testid=fill-progress-text]', (element) => element.textContent?.trim())).toBe(`Записано 1 из ${(await get('/api/k/status')).body.writer.total}`);
    const rows = await page.$$eval('[data-testid=fill-unit]', (elements) => elements.map((element) => ({
      unit: element.getAttribute('data-unit'), state: element.getAttribute('data-state'),
      name: element.querySelector('[data-testid=fill-unit-page], [data-testid=fill-unit-name]')?.textContent ?? '',
      page: element.querySelector('[data-testid=fill-unit-page]')?.getAttribute('href') ?? null,
      journal: element.querySelector('[data-testid=fill-unit-journal]')?.getAttribute('href') ?? null,
    })));
    expect(rows).toEqual([
      { unit: 'product:tiny', state: 'written', name: 'Продукт Крошечный продукт', page: '/products/tiny/k/e/product%3Atiny', journal: '/products/tiny/k/journal?id=product%3Atiny' },
      { unit: 'domain:numbers', state: 'writing', name: `Домен ${LONG_TITLE}`, page: null, journal: null },
    ]);
    // The path and the call counts stand under «Подробности для инженера», shut.
    const engineer = await page.$eval('[data-testid=fill-unit-engineer]', (element) => ({ summary: element.querySelector('summary')?.textContent ?? '', path: element.querySelector('code')?.textContent ?? '', open: element.hasAttribute('open') }));
    expect(engineer).toEqual({ summary: 'Подробности для инженера', path: 'docs/product.md', open: false });
    await capture('during-1150-fill-light.png');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=fill-units]', { timeout: 20000 });
    await capture('during-1150-fill-dark.png');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  }, 120_000);

  test('the journal link opens the page\'s journal, and only a written page has one', async () => {
    await page.setViewport(WIDE);
    await open('/products/tiny/k/fill');
    await page.waitForSelector('[data-testid=fill-unit-journal]', { timeout: 20000 });
    expect(await page.$$eval('[data-testid=fill-unit-journal]', (elements) => elements.length)).toBe(1);
    await clickAt('[data-testid=fill-unit-journal]');
    await page.waitForSelector('[data-testid=journal-page]', { timeout: 20000 });
    expect(new URL(page.url()).pathname).toBe('/products/tiny/k/journal');
    expect(new URL(page.url()).searchParams.get('id')).toBe('product:tiny');
  }, 120_000);

  test('after the run the fill page stands as it ended, and the home page carries its one line no more', async () => {
    for (const release of opens.splice(0)) release();
    await until('the writer to end', async () => (await get('/api/k/status')).body, (body) => body.writer.state === 'done' || body.writer.state === 'failed');
    await page.setViewport(NARROW);
    await open('/products/tiny/k/fill');
    await page.waitForSelector('[data-testid=fill-page]', { timeout: 20000 });
    await capture('after-390-fill-light.png');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=fill-page]', { timeout: 20000 });
    await capture('after-390-fill-dark.png');
    await page.setViewport(WIDE);
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=fill-page]', { timeout: 20000 });
    await capture('after-1150-fill-light.png');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=fill-page]', { timeout: 20000 });
    await capture('after-1150-fill-dark.png');
    // The home page has no line saying an agent writes while none does.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await open('/products/tiny/k');
    expect(await page.$('[data-testid=writer-line]')).toBeNull();
  }, 120_000);
});
