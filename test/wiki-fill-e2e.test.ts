
/**
 * The fill flow on the portal's kit, in a real browser (decision 0036, sections 7 and 8): a product is filled with the
 * disk and git plugins only, no agent and no model, the fill page is opened in Russian, a kind is checked and the run is
 * pressed, and the run page is read once the run ends. The screenshots — 1440 px wide, the reference's width — are
 * written under MADARCH_WIKI_SHOTS (default /work/shots). Run with MADARCH_WIKI_E2E=1 after `bun run build` in
 * `wiki/app`, as an ordinary user, with MADARCH_PLUGIN_SANDBOX=off.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { parse, stringify } from 'yaml';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import type { StartedServer } from '../src/server/http.js';
import { createDraft } from '../src/product/draft.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, commitProduct } from './knowledge-fixture.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';

const ROOT = join(import.meta.dir, '..');
const APP = join(ROOT, 'wiki', 'app', 'dist');
const SHOTS = process.env['MADARCH_WIKI_SHOTS'] ?? '/work/shots';
const enabled = process.env['MADARCH_WIKI_E2E'] === '1';
const run = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('The fill flow walk is skipped: set MADARCH_WIKI_E2E=1 after building wiki/app to run it.');

let root = '';
let home = '';
let folder = '';
let server: StartedServer | undefined;
let planServer: StartedServer | undefined;
let emptyServer: StartedServer | undefined;
let browser: Browser | undefined;

/** The page's text, as a person reads it. */
async function textOf(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.textContent ?? '');
}

/** Answers the first-visit role question when this run opens a page on a fresh machine. */
async function settleRole(page: Page): Promise<void> {
  const dialog = await page.waitForSelector('[data-testid="role-first"]', { timeout: 8_000 }).catch(() => null);
  if (dialog === null) return;
  await page.click('[data-testid="role-first-continue"]');
  await page.waitForSelector('[data-testid="role-first"]', { hidden: true, timeout: 30_000 });
}

run('the fill flow on a product filled with disk and git', () => {
  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`the built app is missing: ${join(APP, 'index.html')}`);
    root = mkdtempSync(join(tmpdir(), 'madarch-fill-e2e-'));
    home = join(root, 'products');
    const draft = createDraft({ home, name: 'portal-fill', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    folder = draft.folder;
    // The owner's shape: the disk and git plugins only, no agent and no model.
    useFixturePlugins(folder, ['disk', 'git']);
    // The fixture keeps only the disk and git plugins, so a field no enabled plugin fills is dropped rather than left
    // unfillable: the planner's rule is that a fillable kind has a producer for every field or the agent for it.
    const fileKindFile = join(folder, 'madarch', 'kinds', 'code', 'structure', 'code.file.yaml');
    const fileKind = parse(readFileSync(fileKindFile, 'utf8')) as { fields: { name: string; producers?: string[]; binding?: { plugin?: string } | string }[] };
    const deterministic = (field: { producers?: string[]; binding?: { plugin?: string } | string }): boolean => (field.producers ?? []).some((producer) => producer === 'disk' || producer === 'git')
      || (typeof field.binding === 'string' && (field.binding.startsWith('disk') || field.binding.startsWith('git')))
      || (typeof field.binding === 'object' && field.binding !== null && (field.binding.plugin === 'disk' || field.binding.plugin === 'git'));
    fileKind.fields = fileKind.fields.filter(deterministic);
    writeFileSync(fileKindFile, stringify(fileKind));
    // A little code and a note for the fill to read.
    mkdirSync(join(folder, 'src'), { recursive: true });
    writeFileSync(join(folder, 'src', 'index.ts'), 'export const answer = 42;\n');
    // A file past the large-file rule's line bound, so the Problems page has a finding to group.
    writeFileSync(join(folder, 'src', 'large.ts'), Array.from({ length: 700 }, (_, at) => `export const value${String(at)} = ${String(at)};`).join('\n') + '\n');
    writeFileSync(join(folder, 'README.md'), '# Portal fill\n\nA product to fill with disk and git.\n');
    commitProduct(folder, 'A product to fill');
    server = await startPreparedServer({ productFolder: folder, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
    // A second product keeps the starter's agent plugin: its fill page is the one that shows a plan needing the agent.
    const planHome = join(root, 'agent-products');
    const planDraft = createDraft({ home: planHome, name: 'agent-plan', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (planDraft.outcome !== 'created') throw new Error(JSON.stringify(planDraft));
    commitProduct(planDraft.folder, 'A product whose plan needs the agent');
    planServer = await startPreparedServer({ productFolder: planDraft.folder, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
    // A product created from scratch and never filled: the owner's critical path from an empty graph.
    const emptyHome = join(root, 'empty-products');
    const emptyDraft = createDraft({ home: emptyHome, name: 'empty-start', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (emptyDraft.outcome !== 'created') throw new Error(JSON.stringify(emptyDraft));
    commitProduct(emptyDraft.folder, 'A product created from scratch');
    emptyServer = await startPreparedServer({ productFolder: emptyDraft.folder, appFolder: APP, port: 0, log: () => undefined, errorLog: () => undefined });
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await emptyServer?.stop();
    await planServer?.stop();
    await server?.stop();
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  test('the catalogue selects a kind, prepares the plan and runs it', async () => {
    mkdirSync(SHOTS, { recursive: true });
    const page = await browser!.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => { failures.push(String(error)); });
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    const shotAt = async (name: string, width: number, height: number): Promise<void> => {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page.screenshot({ path: join(SHOTS, `${name}-${String(width)}.png`) });
    };
    try {
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(() => { try { window.localStorage.setItem('madarch-wiki-language', 'ru'); } catch { /* no storage */ } });
      await page.goto(`${server!.url}/p/catalogue`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const roleDialog = await page.waitForSelector('[data-testid="role-first"]', { timeout: 15_000 }).catch(() => null);
      if (roleDialog !== null) {
        await shotAt('role-first', 1440, 900);
        await shotAt('role-first', 390, 844);
        await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
        await page.click('[data-testid="role-first-skip"]');
        await page.waitForSelector('[data-testid="role-first"]', { hidden: true, timeout: 30_000 });
      }
      await page.waitForSelector('[data-testid="catalogue-page"]', { timeout: 60_000 });
      await page.waitForSelector('[data-testid="catalogue-kind"]', { timeout: 60_000 });
      expect(await page.$('[data-testid="top-search"]')).not.toBeNull();
      expect(await page.$('[data-testid="fill-entry"]')).not.toBeNull();
      const reading = await textOf(page);
      expect(reading).toContain('Каталог сущностей');
      expect(reading).toContain('Выбрать для заполнения');
      expect(await page.$('[data-testid="catalogue-kind-check-code.file"]')).toBeNull();
      expect(reading).toContain('Заполнит:');
      await page.evaluate(() => { const column = document.querySelector('[data-testid="shell-content"]'); if (column !== null) column.scrollTop = 0; });
      await shotAt('catalogue-read', 1440, 900);
      await page.evaluate(() => { const column = document.querySelector('[data-testid="shell-content"]'); if (column !== null) column.scrollTop = 0; });
      await shotAt('catalogue-read', 390, 844);

      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.click('[data-testid="catalogue-select"]');
      await page.waitForSelector('[data-testid="catalogue-bottom"]', { timeout: 30_000 });
      await page.$eval('[data-testid="catalogue-kind-check-code.file"]', (element) => (element as HTMLInputElement).click());
      await page.waitForFunction(() => (document.querySelector('[data-testid="catalogue-selected-count"]')?.textContent ?? '').includes('Выбран 1 вид'), { timeout: 30_000 });
      const selected = await textOf(page);
      expect(selected).toContain('Нужно для');
      expect(selected).toContain('добавлено 2 зависимости');
      await page.click('[data-testid="catalogue-show-selected"]');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await page.evaluate(() => { const column = document.querySelector('[data-testid="shell-content"]'); if (column !== null) column.scrollTop = 0; });
      await shotAt('catalogue-select', 1440, 900);
      await page.evaluate(() => { const column = document.querySelector('[data-testid="shell-content"]'); if (column !== null) column.scrollTop = 0; });
      await shotAt('catalogue-select', 390, 844);

      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.click('[data-testid="catalogue-prepare"]');
      await page.waitForSelector('[data-testid="prepare-panel"]', { timeout: 60_000 });
      expect(await textOf(page)).toContain('Запустить заполнение');
      await page.click('[data-testid="prepare-run"]');
      await page.waitForFunction(() => window.location.pathname === '/p/run', { timeout: 60_000 });
      await page.waitForSelector('[data-testid="run-indicator"]', { timeout: 60_000 });
      await page.waitForFunction(() => /\d+ из [1-9]/u.test(document.querySelector('[data-testid="run-indicator"]')?.textContent ?? ''), { timeout: 60_000 });
      expect(await page.$eval('[data-testid="run-indicator"]', (element) => element.textContent ?? '')).toContain('Идёт заполнение');
      await shotAt('run-going', 1440, 900);
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.click('[data-testid="run-indicator"]');
      await page.waitForSelector('[data-testid="runs-page"]', { timeout: 30_000 });
      await page.waitForSelector('[data-testid="runs-run"]', { timeout: 30_000 });
      expect(await textOf(page)).toContain('Файлы');
      await shotAt('runs-live', 1440, 900);
      await shotAt('runs-live', 390, 844);

      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.click('[data-testid="runs-run"] a');
      await page.waitForSelector('[data-testid="fill-run-page"]', { timeout: 60_000 });
      await page.waitForFunction(() => {
        const state = document.querySelector('[data-testid="fill-run-page"]')?.getAttribute('data-state') ?? '';
        return state !== '' && !['created', 'planning', 'running', 'pausing', 'cancelling'].includes(state);
      }, { timeout: 300_000 });
      const result = await textOf(page);
      expect(result).not.toContain('/work/');
      expect(result).not.toMatch(/\b[0-9a-f]{40}\b/u);
      // The run is over: the live indicator is gone.
      await page.waitForFunction(() => document.querySelector('[data-testid="run-indicator"]') === null, { timeout: 30_000 });
      // The frame's navigation carries the kinds the run published, without a reload.
      await page.waitForFunction(() => {
        const labels = [...document.querySelectorAll('[data-testid="nav-kind"]')].map((one) => one.textContent ?? '');
        return labels.some((one) => one.includes('Файлы')) && labels.some((one) => one.includes('Папки'));
      }, { timeout: 30_000 });
      await page.screenshot({ path: join(SHOTS, 'run-ru.png') });
      // The home after the fill: the product's own name, its repositories and what the graph holds; no first-run card,
      // no separate search section and no raw kind table.
      await page.goto(`${server!.url}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="page-title"]', { timeout: 60_000 });
      await page.evaluate(() => { const column = document.querySelector('[data-testid="shell-content"]'); if (column !== null) column.scrollTop = 0; });
      expect(await page.$('[data-testid="first-run"]')).toBeNull();
      expect(await page.$('[data-testid="page-search"]')).toBeNull();
      await shotAt('home-filled', 1440, 900);
      await shotAt('home-filled', 390, 844);
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(`${server!.url}/p/runs`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="runs-run"]', { timeout: 60_000 });
      await shotAt('runs', 1440, 900);
      await shotAt('runs', 390, 844);

      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(`${server!.url}/p/problems`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="problems-page"]', { timeout: 60_000 });
      await page.waitForSelector('[data-testid="problem-category"]', { timeout: 60_000 });
      const sidebarCount = Number(await page.$eval('[data-testid="nav-problems-count"]', (element) => element.textContent ?? '').catch(() => '0'));
      const total = await page.$eval('[data-testid="problems-total"]', (element) => element.textContent ?? '');
      expect(sidebarCount).toBe(Number(/\d+/u.exec(total)?.[0] ?? '0'));
      await page.screenshot({ path: join(SHOTS, 'problems-ru.png') });
      await page.goto(`${server!.url}/p/sources`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="sources-page"]', { timeout: 60_000 });
      await page.screenshot({ path: join(SHOTS, 'sources-ru.png') });
      await page.goto(`${server!.url}/p/settings`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="settings-page"]', { timeout: 60_000 });
      await page.screenshot({ path: join(SHOTS, 'settings-ru.png') });
      // The top bar's search stays on a page and opens the search page with the text in its address; the home keeps no
      // second search section of its own.
      await page.goto(`${server!.url}/p/catalogue`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="top-search"]', { timeout: 60_000 });
      await page.click('[data-testid="top-search"]');
      await page.keyboard.type('index');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.location.pathname === '/p/search', { timeout: 30_000 });
      await page.waitForSelector('[data-testid="search-page-results"]', { timeout: 30_000 });
      expect(new URL(page.url()).searchParams.get('text')).toBe('index');
      expect(await page.$('[data-testid="page-search"]')).toBeNull();
      expect(await page.$('[data-testid="top-search"]')).not.toBeNull();
      expect(await page.$('[data-testid="fill-entry"]')).not.toBeNull();
      expect(failures.filter((one) => !one.includes('favicon')).join('\n')).toBe('');
    } finally {
      await page.close();
    }
  }, 900_000);

  test('the agent plan and a kind page open the same preparation panel', async () => {
    const page = await browser!.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => { failures.push(String(error)); });
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    const shotAt = async (name: string, width: number, height: number): Promise<void> => {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page.screenshot({ path: join(SHOTS, `${name}-${String(width)}.png`) });
    };
    try {
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(() => { try { window.localStorage.setItem('madarch-wiki-language', 'ru'); } catch { /* no storage */ } });
      await page.goto(`${planServer!.url}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await settleRole(page);
      await page.waitForSelector('[data-testid="first-run"]', { timeout: 60_000 });
      expect(await page.$eval('[data-testid="page-title"]', (element) => element.textContent?.trim() ?? '')).toBe('agent-plan');
      expect(await page.$('[data-testid="page-search"]')).toBeNull();
      expect(await textOf(page)).not.toContain('Aggregate');
      await shotAt('first-run', 1440, 900);
      await shotAt('first-run', 390, 844);
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.click('[data-testid="first-run-start"]');
      await page.waitForSelector('[data-testid="prepare-wizard"]', { timeout: 60_000 });
      await shotAt('wizard-prepare', 1440, 900);
      await shotAt('wizard-prepare', 390, 844);
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.goto(`${planServer!.url}/p/catalogue?select=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="catalogue-kind-check-code.file"]', { timeout: 60_000 });
      await page.$eval('[data-testid="catalogue-kind-check-code.file"]', (element) => (element as HTMLInputElement).click());
      await page.waitForFunction(() => (document.querySelector('[data-testid="catalogue-selected-count"]')?.textContent ?? '').includes('Выбран 1 вид'), { timeout: 30_000 });
      await page.click('[data-testid="catalogue-show-selected"]');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await page.evaluate(() => { const column = document.querySelector('[data-testid="shell-content"]'); if (column !== null) column.scrollTop = 0; });
      await shotAt('catalogue-select-agent', 1440, 900);
      await page.evaluate(() => { const column = document.querySelector('[data-testid="shell-content"]'); if (column !== null) column.scrollTop = 0; });
      await shotAt('catalogue-select-agent', 390, 844);
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.click('[data-testid="catalogue-prepare"]');
      await page.waitForSelector('[data-testid="prepare-plugins-only"]', { timeout: 60_000 });
      await page.waitForFunction(() => (document.querySelector('[data-testid="prepare-plugins-only"]') as HTMLInputElement).checked, { timeout: 60_000 });
      const planText = await textOf(page);
      expect(planText).toContain('Агент заполнит');
      expect(planText).toContain('Только плагины');
      expect(await page.$('[data-testid="prepare-unfilled"]')).not.toBeNull();
      expect((await page.$eval('[data-testid="prepare-run"]', (element) => (element as HTMLButtonElement).disabled))).toBe(false);
      await page.evaluate(() => { const column = document.querySelector('[data-testid="shell-content"]'); if (column !== null) column.scrollTop = 0; });
      await shotAt('prepare-top', 1440, 900);
      await shotAt('prepare-top', 390, 844);
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.evaluate(() => { document.querySelector('[data-testid="prepare-unfilled"]')?.scrollIntoView({ block: 'center' }); });
      await shotAt('prepare-no-agent', 1440, 900);
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.evaluate(() => { document.querySelector('[data-testid="prepare-unfilled"]')?.scrollIntoView({ block: 'center' }); });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page.screenshot({ path: join(SHOTS, 'prepare-no-agent-390.png') });
      // The agent view stays one press away: unchecking names the agent and its cap.
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.$eval('[data-testid="prepare-plugins-only"]', (element) => (element as HTMLInputElement).click());
      await page.waitForSelector('[data-testid="prepare-agent"]', { timeout: 60_000 });
      expect(await textOf(page)).toContain('Лимит считает токены');
      await page.evaluate(() => { document.querySelector('[data-testid="prepare-agent"]')?.scrollIntoView({ block: 'center' }); });
      await shotAt('prepare-agent', 1440, 900);
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.evaluate(() => { document.querySelector('[data-testid="prepare-cap"]')?.scrollIntoView({ block: 'center' }); });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page.screenshot({ path: join(SHOTS, 'prepare-agent-390.png') });
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.click('[data-testid="prepare-change"]');
      await page.waitForSelector('[data-testid="catalogue-bottom"]', { timeout: 30_000 });
      expect(await page.$eval('[data-testid="catalogue-kind-check-code.file"]', (element) => (element as HTMLInputElement).checked)).toBe(true);
      const found = await (await fetch(`${planServer!.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ catalogueEntity(name: "code.file") { id } }' }) })).json() as { data?: { catalogueEntity?: { id?: string } } };
      const id = found.data?.catalogueEntity?.id;
      expect(id).toBeString();
      await page.goto(`${planServer!.url}/e/catalogue/${encodeURIComponent(id!)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="fill-kind"]', { timeout: 60_000 });
      await shotAt('kind-fill', 1440, 900);
      await shotAt('kind-fill', 390, 844);
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.click('[data-testid="fill-kind"]');
      await page.waitForSelector('[data-testid="prepare-panel"]', { timeout: 60_000 });
      await page.waitForSelector('[data-testid="prepare-plugins-only"]', { timeout: 60_000 });
      await page.waitForFunction(() => (document.querySelector('[data-testid="prepare-plugins-only"]') as HTMLInputElement).checked, { timeout: 60_000 });
      expect(await page.$('[data-testid="prepare-unfilled"]')).not.toBeNull();
      expect((await page.$eval('[data-testid="prepare-run"]', (element) => (element as HTMLButtonElement).disabled))).toBe(false);
      expect(failures.filter((one) => !one.includes('favicon')).join('\n')).toBe('');
    } finally {
      await page.close();
    }
  }, 600_000);

  test('a product created from scratch fills from the wiki without an agent', async () => {
    const page = await browser!.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => { failures.push(String(error)); });
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
    const shotAt = async (name: string, width: number, height: number): Promise<void> => {
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page.screenshot({ path: join(SHOTS, `${name}-${String(width)}.png`) });
    };
    try {
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(() => { try { window.localStorage.setItem('madarch-wiki-language', 'ru'); } catch { /* no storage */ } });
      // The old fill address is the catalogue's selection mode, never the «being rebuilt» stub.
      await page.goto(`${emptyServer!.url}/p/fill`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await settleRole(page);
      await page.waitForSelector('[data-testid="catalogue-bottom"]', { timeout: 30_000 });
      expect(await textOf(page)).not.toContain('перестраивается');
      // The owner's first page: the top bar's «Заполнить…» opens the catalogue's selection mode.
      await page.goto(`${emptyServer!.url}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="fill-entry"]', { timeout: 60_000 });
      await shotAt('empty-home', 1440, 900);
      await page.click('[data-testid="fill-entry"]');
      await page.waitForSelector('[data-testid="catalogue-bottom"]', { timeout: 30_000 });
      expect(new URL(page.url()).pathname).toBe('/p/catalogue');
      expect(new URL(page.url()).searchParams.get('select')).toBe('1');
      await page.waitForSelector('[data-testid="catalogue-kind-check-code.file"]', { timeout: 60_000 });
      await page.$eval('[data-testid="catalogue-kind-check-code.file"]', (element) => (element as HTMLInputElement).click());
      await page.waitForFunction(() => (document.querySelector('[data-testid="catalogue-selected-count"]')?.textContent ?? '').includes('Выбран 1 вид'), { timeout: 30_000 });
      await page.click('[data-testid="catalogue-show-selected"]');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await shotAt('empty-catalogue', 1440, 900);
      await shotAt('empty-catalogue', 390, 844);

      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.click('[data-testid="catalogue-prepare"]');
      await page.waitForSelector('[data-testid="prepare-panel"]', { timeout: 60_000 });
      await page.waitForSelector('[data-testid="prepare-plugins-only"]', { timeout: 60_000 });
      await page.waitForFunction(() => (document.querySelector('[data-testid="prepare-plugins-only"]') as HTMLInputElement).checked, { timeout: 60_000 });
      expect(await textOf(page)).toContain('Только плагины');
      expect(await page.$('[data-testid="prepare-unfilled"]')).not.toBeNull();
      await shotAt('empty-prepare', 1440, 900);
      await shotAt('empty-prepare', 390, 844);
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.evaluate(() => { document.querySelector('[data-testid="prepare-unfilled"]')?.scrollIntoView({ block: 'center' }); });
      await shotAt('empty-prepare-controls', 1440, 900);
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.evaluate(() => { document.querySelector('[data-testid="prepare-unfilled"]')?.scrollIntoView({ block: 'center' }); });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page.screenshot({ path: join(SHOTS, 'empty-prepare-controls-390.png') });

      // The plugins-only press: the agent's fields stay unfilled, and the fill runs to its end.
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await page.click('[data-testid="prepare-run"]');
      await page.waitForFunction(() => window.location.pathname === '/p/run', { timeout: 60_000 });
      await page.waitForSelector('[data-testid="fill-run-page"]', { timeout: 60_000 });
      await page.waitForFunction(() => ['running', 'created', 'planning'].includes(document.querySelector('[data-testid="fill-run-page"]')?.getAttribute('data-state') ?? ''), { timeout: 60_000 });
      const firstState = await page.$eval('[data-testid="fill-run-page"]', (element) => element.getAttribute('data-state'));
      process.stdout.write(`EMPTY RUN FIRST STATE ${String(firstState)}\n`);
      const paused = await page.waitForFunction(() => {
        const state = document.querySelector('[data-testid="fill-run-page"]')?.getAttribute('data-state') ?? '';
        return state === 'running' || ['succeeded', 'completed_partial', 'failed', 'cancelled', 'blocked'].includes(state);
      }, { timeout: 60_000 }).then(() => true, () => false);
      expect(paused).toBe(true);
      await shotAt('empty-run', 1440, 900);
      await page.waitForFunction(() => {
        const state = document.querySelector('[data-testid="fill-run-page"]')?.getAttribute('data-state') ?? '';
        return state !== '' && !['created', 'planning', 'running', 'pausing', 'cancelling'].includes(state);
      }, { timeout: 600_000 });
      const end = await textOf(page);
      expect(end).not.toContain('/work/');
      expect(end).not.toMatch(/\b[0-9a-f]{40}\b/u);
      const state = await page.$eval('[data-testid="fill-run-page"]', (element) => element.getAttribute('data-state'));
      expect(['succeeded', 'completed_partial']).toContain(state ?? '');
      await page.waitForSelector('[data-testid="fill-entry"]', { timeout: 30_000 });
      await page.screenshot({ path: join(SHOTS, 'empty-end-1440.png') });
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page.screenshot({ path: join(SHOTS, 'empty-end-390.png') });
      expect(failures.filter((one) => !one.includes('favicon')).join('\n')).toBe('');
    } finally {
      await page.close();
    }
  }, 900_000);
});
