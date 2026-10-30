/// <reference lib="dom" />
/**
 * A person's pause and stop in the browser (madarch-m38l.17): on the fill page a run under way offers «Пауза» and
 * «Остановить» in one row, the press of «Пауза» leaves the run standing with its figures, and «Остановить» asks first in
 * words that count the pages this run rewrote; in the top bar the badge says the run stands paused and its one popover
 * carries the same presses. The row and the question must stay inside a 390 px screen and a 1150 px one, on one line.
 * The product is a small factory fixture; the agent is scripted and holds the domain page open while the browser reads.
 * Run with MADARCH_WIKI_E2E=1 after building wiki/app.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import type { AgentFactory } from '../src/knowledge/product.js';
import type { Journal } from '../src/writer/journal.js';
import type { ToolClient, UnitAgent, UnitRequest } from '../src/writer/index.js';
import { gitEnv } from './git-env.js';
import { SCRIPTED_GUIDE_PATH, SCRIPTED_GUIDE_SOURCE, writeScriptedGuide } from './scripted-guide-agent.js';
import { makeProduct, recordKey, SAMPLE_IDENTITY } from './knowledge-fixture.js';

const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('Pause/stop Chromium E2E tests skipped: set MADARCH_WIKI_E2E=1 after building wiki/app.');

const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
/** The shots this task hands back, in the repository's out folder. */
const SHOTS = join(ROOT, 'out', 'shots-m38l17');
const NARROW = { width: 390, height: 844 };
const WIDE = { width: 1150, height: 900 };

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
const A_TS = ['export function leaf(): number {', '  return 1;', '}', '', 'export function root(): number {', '  return leaf() + 1;', '}', ''].join('\n');
const FILE = recordKey('code.file', 'src/a.ts');
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

/** The holds the test queues: the held domain unit waits on one until the test opens it. */
const opens: (() => void)[] = [];
const waits: Promise<void>[] = [];

/** The agent a fill runs, with the close the filler calls when a unit is done. */
type AgentWithClose = UnitAgent & { close(): Promise<void> };

const script: AgentWithClose = {
  async run(request: UnitRequest): Promise<void> {
    if (request.id === 'product:tiny') {
      const written = await request.tools.call('write_page', {
        markdown: PRODUCT_PAGE_RU,
        domains: [{ slug: 'numbers', title: 'Числа', summary: 'Числа считают листовая и корневая функции.', evidence: [FILE] }],
      });
      if (written.isError) throw new Error(`the product page was refused: ${JSON.stringify(written.answer)}`);
      return;
    }
    if (request.id === 'administrator-guide:main' || request.id === 'user-guide:main') {
      await writeScriptedGuide(request.prompt, (tool, argumentsValue) => request.tools.call(tool, argumentsValue));
      return;
    }
    // The domain page is written after the test opens the hold: the run is under way while the browser reads it.
    await (waits.shift() ?? Promise.resolve());
    const written = await request.tools.call('write_page', { markdown: DOMAIN_PAGE_RU });
    if (written.isError) throw new Error(`the domain page was refused: ${JSON.stringify(written.answer)}`);
  },
  async close(): Promise<void> {},
};

const agentFactory: AgentFactory = (_agentId: string, journal: Journal) => {
  // The scripted agent with its calls written to the run's journal, as the agent layer writes a real agent's.
  const tools = (request: UnitRequest): ToolClient => ({
    definitions: request.tools.definitions,
    finished: () => request.tools.finished(),
    call: async (tool: string, argumentsValue: unknown) => {
      const startedAt = new Date();
      const answer = await request.tools.call(tool, argumentsValue);
      journal.record({ run: journal.run, unit: request.id, agent: 'claude-code', model: null, session: null }, { kind: 'tool-call', tool, arguments: argumentsValue, response: JSON.stringify(answer.answer ?? null), isError: answer.isError, outcome: answer.isError ? 'refused' : 'ok', reason: answer.isError ? JSON.stringify(answer.answer ?? null) : null, startedAt, durationMs: Date.now() - startedAt.getTime() });
      return answer;
    },
  });
  return {
    async run(request: UnitRequest): Promise<void> { await script.run({ ...request, tools: tools(request) }); },
    close: () => script.close(),
  };
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

const open = async (path: string): Promise<void> => {
  await page.goto(`${server.url}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=knowledge-app]', { timeout: 20000 });
};
/** Waits until no animation that ends is still running, so a shot shows what a reader reads rather than a frame of a
 * menu's fade-in; a pulse that never ends is no reason to wait. */
const settled = async (): Promise<void> => {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => {
    const timing = animation.effect?.getComputedTiming();
    return animation.playState === 'running' && timing !== undefined && timing.iterations !== Infinity;
  }).map((animation) => Promise.race([animation.finished.catch(() => undefined), new Promise((rest) => setTimeout(rest, 400))]))));
};
const capture = async (name: string): Promise<void> => { await settled(); await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };
/** The screen as the reader has it, for a shot of something anchored to it (a full-page shot moves a fixed popover). */
const captureScreen = async (name: string): Promise<void> => { await settled(); await page.screenshot({ path: join(SHOTS, name) }); };
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

/** The controls as a reader has them: the words of each press, whether they stand on one line, and whether the row fits. */
const controlsAt = async (width: number) => page.$eval('[data-testid=run-controls]', (element, limit) => {
  const buttons = [...element.querySelectorAll('button')];
  const tops = new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
  const row = element.getBoundingClientRect();
  return {
    state: element.getAttribute('data-state'),
    labels: buttons.map((button) => (button.textContent ?? '').trim()),
    oneLine: tops.size === 1,
    nowrap: getComputedStyle(element).flexWrap,
    inside: row.left >= 0 && row.right <= limit,
    fits: (element as HTMLElement).scrollWidth <= (element as HTMLElement).clientWidth + 1,
  };
}, width);

/** The top bar at a phone's width: its height, and where each control it holds stands — one line means one centre. */
const barAt = async (): Promise<{ height: number; centers: number[] }> => page.evaluate(() => {
  const header = document.querySelector('.shell-toolbar') as HTMLElement;
  const centers = [...header.querySelectorAll<HTMLElement>('button, a[href]')]
    .filter((element) => element.closest('[data-testid=fill-menu]') === null && element.closest('[data-testid=sync-result]') === null)
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => rect.top + rect.height / 2);
  return { height: Math.round(header.getBoundingClientRect().height), centers };
});

/** The badge as the window shows it: its words, its count and its state's mark, and which of them take room. */
const badgeAt = async (): Promise<{ words: string | null; count: string | null; mark: string | null; name: string | null; visible: { words: number; count: number; mark: number } }> => page.$eval('[data-testid=fill-chip]', (element) => {
  const words = element.querySelector('.fill-chip-words');
  const count = element.querySelector('.fill-chip-count');
  const mark = element.querySelector('[data-testid=fill-chip-dot], [data-testid=fill-chip-pause], [data-testid=fill-chip-stop]');
  const width = (node: Element | null): number => (node === null ? 0 : Math.round(node.getBoundingClientRect().width));
  return { words: words?.textContent ?? null, count: count?.textContent ?? null, mark: mark?.getAttribute('data-testid') ?? null, name: element.getAttribute('aria-label'), visible: { words: width(words), count: width(count), mark: width(mark) } };
});

/** The stop question in Russian for a count, asked of the locale's own plural family rather than spelled here. */
const ruStopWords = (count: number): string => {
  const file = join(ROOT, 'wiki', 'app', 'src', 'locales', 'ru.json');
  const family = JSON.parse(readFileSync(file, 'utf8'))['knowledge']['fillPage'] as Record<string, string>;
  const form = `stopWords_${new Intl.PluralRules('ru').select(count)}`;
  const sentence = family[form];
  if (sentence === undefined) throw new Error(`the Russian stop question has no ${form} in ${file}`);
  return sentence.replace('{{count}}', String(count));
};

runDescribe('a person pauses and stops the run', () => {
  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`Built wiki app is missing: ${join(APP, 'index.html')}`);
    mkdirSync(SHOTS, { recursive: true });
    work = mkdtempSync(join(tmpdir(), 'madarch-pause-stop-shot-'));
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
    makeProduct(home, 'tiny', repository, 'tiny');
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
    expect((await post('/api/k/settings', { role: 'everything' })).status).toBe(200);
    opens.length = 0;
    waits.length = 0;
    // The domain unit is held: the product page is written and the domain's page is being written while the browser reads.
    let release!: () => void;
    waits.push(new Promise<void>((resolve) => { release = resolve; }));
    opens.push(release);
    expect((await post('/api/k/fill', { agent: 'claude-code', language: 'ru' })).status).toBe(202);
    await until('the domain unit to be writing', async () => (await get('/api/k/status')).body, (body) => body.writer.units.some((unit: { unit: string; state: string }) => unit.unit === 'domain:numbers' && unit.state === 'writing'));
  }, 120_000);

  afterAll(async () => {
    for (const release of opens.splice(0)) release();
    try { if (page !== undefined) await page.close(); } catch { /* the run is over */ }
    try { if (browser !== undefined) await browser.close(); } finally {
      try { await server?.stop(); } finally { if (work !== undefined) rmSync(work, { recursive: true, force: true }); }
    }
  }, 120_000);

  test('at 390 and 1150 a run under way offers «Пауза» and «Остановить» in one row, and the press leaves it standing with its figures', async () => {
    await page.setViewport(NARROW);
    await open('/products/tiny/k/fill');
    await page.waitForSelector('[data-testid=run-controls]', { timeout: 20000 });
    const narrow = await controlsAt(390);
    expect(narrow.state).toBe('live');
    expect(narrow.labels).toEqual(['Пауза', 'Остановить']);
    expect(narrow.oneLine).toBe(true);
    expect(narrow.nowrap).toBe('nowrap');
    expect(narrow.inside).toBe(true);
    expect(narrow.fits).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // The top bar stands in one row at 390, and the badge is its mark and its count there: the whole sentence is its
    // name, and the second row a wrapped bar would take the badge to is not there.
    const runningBar = await barAt();
    expect(runningBar.height).toBeLessThanOrEqual(59);
    expect(Math.max(...runningBar.centers) - Math.min(...runningBar.centers)).toBeLessThanOrEqual(1);
    const runningBadge = await badgeAt();
    expect(runningBadge.mark).toBe('fill-chip-dot');
    expect(runningBadge.visible.mark).toBeGreaterThan(0);
    expect(runningBadge.visible.count).toBeGreaterThan(0);
    expect(runningBadge.visible.words).toBe(0);
    await capture('running-390-light.png');
    await page.setViewport(WIDE);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=run-controls]', { timeout: 20000 });
    const wide = await controlsAt(1150);
    expect(wide.labels).toEqual(['Пауза', 'Остановить']);
    expect(wide.oneLine).toBe(true);
    expect(wide.inside).toBe(true);
    await capture('running-1150-light.png');
    // The press: the page being written is finished, and the run stands before the next one.
    await page.setViewport(NARROW);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=run-pause]', { timeout: 20000 });
    await clickAt('[data-testid=run-pause]');
    for (const release of opens.splice(0)) release();
    const paused = await until('the writer to stand paused', async () => (await get('/api/k/status')).body, (body) => body.writer.state === 'paused');
    const written = paused.writer.units.filter((unit: { state: string }) => unit.state === 'written').length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=fill-run]', { timeout: 20000 });
    expect(await page.$eval('[data-testid=fill-run-words]', (element) => element.textContent?.trim())).toBe(`На паузе: записано ${written} из ${paused.writer.total}`);
    const standing = await controlsAt(390);
    expect(standing.state).toBe('paused');
    expect(standing.labels).toEqual(['Продолжить', 'Остановить']);
    expect(standing.oneLine).toBe(true);
    expect(standing.inside).toBe(true);
    expect(standing.fits).toBe(true);
    // The line over the product's pages is the run under way; a paused run stands nowhere but its page and the top bar.
    expect(await page.$('[data-testid=writer-line]')).toBeNull();
    // A held run keeps the bar in one row too: the badge is its pause mark and «2/4», its sentence its name.
    const pausedBar = await barAt();
    expect(pausedBar.height).toBeLessThanOrEqual(59);
    expect(Math.max(...pausedBar.centers) - Math.min(...pausedBar.centers)).toBeLessThanOrEqual(1);
    const pausedBadge = await badgeAt();
    expect(pausedBadge.mark).toBe('fill-chip-pause');
    expect(pausedBadge.visible.mark).toBeGreaterThan(0);
    expect(pausedBadge.words).toBe(`На паузе: записано ${written} из ${paused.writer.total}`);
    expect(pausedBadge.count).toBe(`${written}/${paused.writer.total}`);
    expect(pausedBadge.visible.count).toBeGreaterThan(0);
    expect(pausedBadge.visible.words).toBe(0);
    expect(pausedBadge.name).toBe(`На паузе: записано ${written} из ${paused.writer.total}`);
    await capture('paused-390-light.png');
  }, 180_000);

  test('at 1150 the top bar says the run stands paused, its popover carries the same row and the stop question, both inside the screen', async () => {
    await page.setViewport(WIDE);
    await open('/products/tiny/k');
    await page.waitForSelector('[data-testid=fill-chip]', { timeout: 20000 });
    const paused = (await get('/api/k/status')).body;
    const written = paused.writer.units.filter((unit: { state: string }) => unit.state === 'written').length;
    const sentence = `На паузе: записано ${written} из ${paused.writer.total}`;
    // Above a phone's width the badge is the whole sentence, and the figures stay in it: the count that stands alone
    // below one takes no room here.
    const wideBadge = await badgeAt();
    expect(wideBadge.words).toBe(sentence);
    expect(wideBadge.name).toBe(sentence);
    expect(wideBadge.count).toBe(`${written}/${paused.writer.total}`);
    expect(wideBadge.visible.words).toBeGreaterThan(0);
    expect(wideBadge.visible.count).toBe(0);
    expect(await page.$('[data-testid=fill-chip-dot]')).toBeNull();
    await capture('paused-1150-light.png');
    await clickAt('[data-testid=fill-chip]');
    await page.waitForSelector('[data-testid=fill-menu-paused]', { timeout: 5000 });
    // One badge, one popover, and one row of presses in it.
    expect(await page.$$eval('[data-testid=fill-menu]', (elements) => elements.length)).toBe(1);
    expect(await page.$$eval('[data-testid=run-controls]', (elements) => elements.length)).toBe(1);
    expect(await page.$eval('[data-testid=fill-menu-total]', (element) => element.textContent?.trim())).toBe(sentence);
    const row = await controlsAt(1150);
    expect(row.state).toBe('paused');
    expect(row.labels).toEqual(['Продолжить', 'Остановить']);
    expect(row.oneLine).toBe(true);
    expect(row.inside).toBe(true);
    await page.waitForFunction(() => {
      const menu = document.querySelector('[data-testid=fill-menu]');
      return menu !== null && getComputedStyle(menu).opacity === '1';
    }, { timeout: 5000 });
    await captureScreen('paused-1150-popover-light.png');
    // «Остановить» asks first, in the same popover, in words that count the pages this run rewrote and say that they stay.
    await clickAt('[data-testid=run-stop]');
    await page.waitForSelector('[data-testid=stop-dialog]', { timeout: 5000 });
    expect(await page.$$eval('[data-testid=stop-dialog]', (elements) => elements.length)).toBe(1);
    expect(await page.$eval('[data-testid=stop-dialog]', (element) => element.getAttribute('role'))).toBe('dialog');
    const words = await page.$eval('[data-testid=stop-dialog-words]', (element) => element.textContent?.trim() ?? '');
    expect(words).toBe(ruStopWords(written));
    expect(words.endsWith('останется такой, какой была до запуска.')).toBe(true);
    // The question and the popover that holds it stand inside the screen, and the words wrap instead of running off it.
    const box = await page.$eval('[data-testid=fill-menu]', (element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }; });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(1150);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(900);
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    const dialog = await page.$eval('[data-testid=stop-dialog]', (element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; });
    expect(dialog.left).toBeGreaterThanOrEqual(0);
    expect(dialog.right).toBeLessThanOrEqual(1150);
    expect(dialog.top).toBeGreaterThanOrEqual(0);
    expect(dialog.bottom).toBeLessThanOrEqual(900);
    await captureScreen('stop-1150-light.png');
    // «Не останавливать» closes the question and leaves the run standing.
    await clickAt('[data-testid=stop-cancel]');
    await page.waitForFunction(() => document.querySelector('[data-testid=stop-dialog]') === null, { timeout: 5000 });
    expect((await get('/api/k/status')).body.writer.state).toBe('paused');
  }, 180_000);

  test('at 390 the stop question fits the screen and its second press ends the run, the pages it rewrote staying', async () => {
    await page.setViewport(NARROW);
    await open('/products/tiny/k/fill');
    await page.waitForSelector('[data-testid=run-stop]', { timeout: 20000 });
    const before = (await get('/api/k/status')).body;
    const written = before.writer.units.filter((unit: { state: string }) => unit.state === 'written').length;
    await clickAt('[data-testid=run-stop]');
    await page.waitForSelector('[data-testid=stop-dialog]', { timeout: 5000 });
    const dialog = await page.$eval('[data-testid=stop-dialog]', (element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; });
    expect(dialog.left).toBeGreaterThanOrEqual(0);
    expect(dialog.right).toBeLessThanOrEqual(390);
    expect(dialog.top).toBeGreaterThanOrEqual(0);
    expect(dialog.bottom).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await captureScreen('stop-390-light.png');
    await clickAt('[data-testid=stop-confirm]');
    const stopped = await until('the run to end', async () => (await get('/api/k/status')).body, (body) => body.writer.state === 'stopped' && body.fill.state === 'stopped');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=fill-run-words]', { timeout: 20000 });
    expect(await page.$eval('[data-testid=fill-run-words]', (element) => element.textContent?.trim())).toBe(`Остановлено: записано ${written} из ${stopped.writer.total}; эти страницы остаются`);
    // Nothing stands to be paused or stopped: the run is over.
    expect(await page.$('[data-testid=run-controls]')).toBeNull();
    // An ended run keeps the bar in one row: the badge is its stop mark and the count, its sentence its name.
    const stoppedBar = await barAt();
    expect(stoppedBar.height).toBeLessThanOrEqual(59);
    expect(Math.max(...stoppedBar.centers) - Math.min(...stoppedBar.centers)).toBeLessThanOrEqual(1);
    const stoppedBadge = await badgeAt();
    expect(stoppedBadge.mark).toBe('fill-chip-stop');
    expect(stoppedBadge.visible.mark).toBeGreaterThan(0);
    expect(stoppedBadge.count).toBe(`${written}/${stopped.writer.total}`);
    expect(stoppedBadge.visible.count).toBeGreaterThan(0);
    expect(stoppedBadge.visible.words).toBe(0);
    expect(stoppedBadge.name).toBe(`Остановлено: записано ${written} из ${stopped.writer.total}; эти страницы остаются`);
    await capture('stopped-390-light.png');
  }, 180_000);
});
