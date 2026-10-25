/**
 * settings:shots — the acceptance walk of madarch-m38l.11, rendered the way a reader sees it. A product made by madarch
 * 0.2.0 (its manifest and templates are the fixture `test/fixtures/product-0.2.0`) is served by the current madarch:
 * the wiki brings the files to the current starter set when it first reads them, and the walk shows the full grouping,
 * the roles, the use cases and the contract and route pages after a code fill. A second product whose manifest a person
 * edited is left as it is and its Problems page offers «Add». The settings page lists the agent, the model and the
 * reasoning level a fake ACP adapter reports (the fixture agent of the ACP tests, started as a real adapter is), the
 * language, the bounds and both local resets; «Start from scratch» is pressed and the walk checks that no page, no graph
 * and a current manifest are left, then fills again.
 *
 * Usage: bun scripts/settings-shots.ts --lang ru|en [--theme light|dark] [--out <folder>] [--work <folder>] [--port <n>]
 * Each page is taken at 1150 px and at 390 px.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// The questions-once acceptance mode always plans the full bilingual/theme/width matrix.
if (process.argv.includes('--questions-once')) {
  await import('./questions-once-shots.js');
  process.exit(0);
}
console.warn('Legacy partial walk: NOT the complete madarch-m38l.22 acceptance matrix; use --questions-once for that planned walk.');

import puppeteer, { type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { SAMPLE_IDENTITY, generateTrainingRepository, makeProduct } from '../test/knowledge-fixture.js';
import { gitEnv } from '../test/git-env.js';
import { STARTER_FILES, starterManifest } from '../src/knowledge/seed.js';

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}
const lang = argument('lang', 'en');
const theme = argument('theme', 'light');
const out = resolve(argument('out', 'shots-settings'));
const work = resolve(argument('work', `/tmp/madarch-settings-shots-${lang}-${theme}`));
const port = Number(argument('port', '4311'));
rmSync(work, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const written: string[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv(SAMPLE_IDENTITY), encoding: 'utf8' }).trim();
const FIXTURE = resolve(import.meta.dir, '..', 'test', 'fixtures', 'product-0.2.0');

/** A draft product turned into what madarch 0.2.0 left: the draft's first commit, then the working tree the questions loop changed. */
function oldProduct(home: string, name: string, repository: string): string {
  const folder = makeProduct(home, name, repository);
  rmSync(join(folder, 'templates'), { recursive: true, force: true });
  cpSync(join(FIXTURE, 'committed'), folder, { recursive: true });
  git(folder, 'add', '-A');
  git(folder, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--amend', '-m', 'Create the draft product');
  cpSync(join(FIXTURE, 'working'), folder, { recursive: true });
  return folder;
}

const repository = generateTrainingRepository(join(work, 'repo'));
const madarchHome = join(work, 'madarch');
const products = join(work, 'products');
mkdirSync(products, { recursive: true });
const shop = oldProduct(products, 'sample-product', repository);
const edited = oldProduct(products, 'sample-product-edited', repository);
writeFileSync(join(edited, 'madarch', 'kinds.yaml'), `# our own note: kinds are listed in the order we read them\n${readFileSync(join(edited, 'madarch', 'kinds.yaml'), 'utf8')}`);
git(edited, 'add', '-A');
git(edited, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Note in the manifest');
const editedBefore = readFileSync(join(edited, 'madarch', 'kinds.yaml'), 'utf8');

// The adapter: a program named like the real one that speaks ACP and reports a model and a reasoning level.
const bin = join(work, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'claude-agent-acp'), `#!/bin/sh\nexec ${process.execPath} ${resolve(import.meta.dir, '..', 'test', 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts')} --models\n`);
chmodSync(join(bin, 'claude-agent-acp'), 0o755);
const env = { ...process.env, HOME: join(work, 'user'), PATH: `${bin}:${process.env.PATH ?? ''}`, MADARCH_HOME: madarchHome, MADARCH_OWN_WIKI: 'off', MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist') };

async function serve(home: string, where: number): Promise<{ url: string; stop: () => Promise<void> }> {
  const child = Bun.spawn(['bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', home, '--port', String(where)], { env, stdout: 'inherit', stderr: 'inherit' });
  const url = `http://127.0.0.1:${where}`;
  for (let tries = 0; ; tries += 1) {
    try {
      if ((await fetch(`${url}/`, { redirect: 'manual' })).status < 500) break;
    } catch {
      // not listening yet
    }
    if (tries > 120) throw new Error(`the background server did not answer on port ${where}`);
    await new Promise((rest) => setTimeout(rest, 500));
  }
  return { url, stop: async () => { child.kill('SIGTERM'); await child.exited; } };
}

const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, protocolTimeout: 900_000, args: ['--no-sandbox'] });
async function open(base: string, url: string, width = 1150, height = 900): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((language) => { try { window.localStorage.setItem('madarch-wiki-language', language); } catch { /* the browser's own language */ } }, lang);
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  page.on('pageerror', (error) => console.error(`page error at ${url}: ${error.message}`));
  await page.goto(`${base}${url}`, { waitUntil: 'domcontentloaded' });
  return page;
}
async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await new Promise((rest) => setTimeout(rest, 600));
  const file = join(out, `${lang}-${theme}-${name}-${page.viewport()?.width ?? 0}.png`);
  await page.screenshot({ path: file, fullPage });
  written.push(file);
}
/** One page at the two widths the wiki is read at. */
async function both(base: string, url: string, name: string, ready: string, fullPage = false): Promise<void> {
  for (const [width, height] of [[1150, 900], [390, 800]] as const) {
    const page = await open(base, url, width, height);
    await page.waitForSelector(ready, { timeout: 180_000 });
    await shoot(page, name, fullPage);
    await page.close();
  }
}
const json = async (base: string, path: string, init?: RequestInit): Promise<any> => {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
};
const post = (base: string, path: string, body: unknown): Promise<any> => json(base, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const check = (holds: boolean, what: string): void => { if (!holds) throw new Error(`the walk found it untrue: ${what}`); console.log(`ok: ${what}`); };
async function settled(base: string, product: string): Promise<void> {
  for (let tries = 0; tries < 900; tries += 1) {
    const status = await json(base, `/products/${product}/api/k/status`);
    if (status.fill.state === 'done' || status.fill.state === 'failed') { check(status.fill.state === 'done', `the fill of ${product} ended done (${status.fill.message ?? ''})`); return; }
    await new Promise((rest) => setTimeout(rest, 2000));
  }
  throw new Error(`the fill of ${product} did not end`);
}

const server = await serve(products, port);
try {
  const base = server.url;
  // The reader's role is a machine setting shared by products. Answer the first-run prompt before any screenshot.
  await post(base, '/products/sample-product/api/k/settings', { role: 'everything' });
  // ---- the old product, read by the current madarch -----------------------------------------------
  const before = readFileSync(join(shop, 'madarch', 'kinds.yaml'), 'utf8');
  check(!before.includes('groups:'), 'the old manifest declares no groups (everything would fall into «Other»)');
  const first = await json(base, '/products/sample-product/api/k/status');
  check(first.findings.length === 0, 'no finding is left on the upgraded manifest');
  check(first.groups.length === 7, 'the upgraded manifest has the seven groups');
  check(Object.keys(first.roles).length === 6, 'the six roles are declared');
  check(readFileSync(join(shop, 'madarch', 'kinds.yaml'), 'utf8') === starterManifest('ru'), 'the manifest is the current starter set, in the product\'s language');
  await post(base, '/products/sample-product/api/k/fill', {});
  await settled(base, 'sample-product');
  const filled = await json(base, '/products/sample-product/api/k/status');
  const count = (kind: string): number => filled.kinds.find((entry: { kind: string; count: number }) => entry.kind === kind)?.count ?? 0;
  check(count('doc.use-case') > 0, `use cases are entities (${count('doc.use-case')})`);
  check(count('code.route') > 0, `routes are entities (${count('code.route')})`);
  check(count('code.contract') > 0 || count('code.operation') > 0, `contracts are entities (contracts ${count('code.contract')}, operations ${count('code.operation')})`);
  const route = (await json(base, '/products/sample-product/api/k/entities?kind=code.route&limit=1')).rows[0].id as string;
  const useCase = (await json(base, '/products/sample-product/api/k/entities?kind=doc.use-case&limit=1')).rows[0].id as string;
  const contract = (await json(base, `/products/sample-product/api/k/entities?kind=${count('code.contract') > 0 ? 'code.contract' : 'code.operation'}&limit=1`)).rows[0].id as string;
  await both(base, '/products/sample-product/k/catalogue', 'upgraded-catalogue', '[data-testid=catalogue], [data-nav-group]');
  await both(base, '/products/sample-product/k/kind/doc.use-case', 'upgraded-use-cases', '[data-testid=nav-group]');
  await both(base, `/products/sample-product/k/e/${encodeURIComponent(useCase)}`, 'upgraded-use-case-entity', '[data-testid=entity-page]');
  await both(base, `/products/sample-product/k/e/${encodeURIComponent(contract)}`, 'upgraded-contract-page', '[data-testid=entity-page]');
  await both(base, `/products/sample-product/k/e/${encodeURIComponent(route)}`, 'upgraded-route-page', '[data-testid=entity-page]');

  // ---- the product a person edited: untouched, and the Problems page offers «Add» -------------------
  const editedStatus = await json(base, '/products/sample-product-edited/api/k/status');
  check(readFileSync(join(edited, 'madarch', 'kinds.yaml'), 'utf8') === editedBefore, 'the edited manifest is byte for byte as it was');
  check(editedStatus.starterOffers > 0, `the Problems page has ${editedStatus.starterOffers} things to add`);
  await both(base, '/products/sample-product-edited/k/problems', 'edited-problems-offer-add', '[data-testid=problems-starter]', true);
  const offers = (await json(base, '/products/sample-product-edited/api/k/problems')).starter.map((offer: { id: string }) => offer.id) as string[];
  await post(base, '/products/sample-product-edited/api/k/starter', { ids: offers });
  const addedStatus = await json(base, '/products/sample-product-edited/api/k/status');
  check(addedStatus.findings.length === 0 && addedStatus.starterOffers === 0, 'after «Add all» the edited manifest reads clean and offers nothing more');
  check(readFileSync(join(edited, 'madarch', 'kinds.yaml'), 'utf8').startsWith('# our own note'), 'the person\'s comment is still the first line');

  // ---- the settings page ---------------------------------------------------------------------------
  await post(base, '/products/sample-product/api/k/agent', { agent: 'claude-code', install: false });
  await both(base, '/products/sample-product/k/settings', 'settings', '[data-testid=settings-model-select]', true);
  await post(base, '/products/sample-product/api/k/product-settings', { model: 'opus', reasoning: 'high' });
  const afterPick = await json(base, '/products/sample-product/api/k/product-settings');
  check(afterPick.chosenAgent.model === 'opus' && afterPick.chosenAgent.reasoning === 'high', 'the model and the reasoning level the adapter reported are saved beside the agent');
  const refusedModel = await fetch(`${base}/products/sample-product/api/k/product-settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-nine' }) });
  check(refusedModel.status === 400, 'a model the adapter does not report is refused');
  await both(base, '/products/sample-product/k/settings', 'settings-model-saved', '[data-testid=settings-model-select]', true);
  for (const [width, height] of [[1150, 900], [390, 800]] as const) {
    const page = await open(base, '/products/sample-product/k/settings', width, height);
    await page.waitForSelector('[data-testid=danger-fresh-open]', { timeout: 120_000 });
    await page.click('[data-testid=danger-fresh-open]');
    await page.waitForSelector('[data-testid=danger-dialog] [data-testid=danger-pages]', { timeout: 60_000 });
    await shoot(page, 'settings-start-from-scratch-asks');
    await page.close();
  }

  // ---- «Start from scratch» ------------------------------------------------------------------------
  const id = (await json(base, '/products/sample-product/api/k/product')).id as string;
  const store = join(products, '.madarch', 'knowledge', id);
  writeFileSync(join(shop, 'templates', 'domain.md'), 'a template we edited\n');
  const page = await open(base, '/products/sample-product/k/settings', 1150, 900);
  await page.waitForSelector('[data-testid=danger-fresh-open]', { timeout: 120_000 });
  await page.click('[data-testid=danger-fresh-open]');
  await page.waitForSelector('[data-testid=danger-confirm]', { timeout: 60_000 });
  await page.click('[data-testid=danger-confirm]');
  await page.waitForFunction(() => window.location.pathname.endsWith('/k'), { timeout: 120_000 });
  const files = (folder: string): string[] => (existsSync(folder) ? readdirSync(folder, { recursive: true }).map(String) : []);
  check(!existsSync(join(shop, 'docs', 'product.md')) && files(join(shop, 'docs', 'domains')).length === 0, 'no agent page is left');
  check(!existsSync(join(store, 'graph')) || files(join(store, 'graph')).length === 0 || (await json(base, '/products/sample-product/api/k/status')).fill.state === 'running', 'the old graph is gone (a fresh fill is writing a new one)');
  check(readFileSync(join(shop, 'madarch', 'kinds.yaml'), 'utf8') === starterManifest('ru'), 'the manifest is the current starter set');
  for (const starter of STARTER_FILES) check(readFileSync(join(shop, starter.path), 'utf8') === (starter.path === 'madarch/kinds.yaml' ? starterManifest('ru') : starter.content), `${starter.path} is the current starter file`);
  await shoot(page, 'after-start-from-scratch');
  await page.close();
  await settled(base, 'sample-product');
  const again = await json(base, '/products/sample-product/api/k/status');
  check(again.filled && again.kinds.find((entry: { kind: string; count: number }) => entry.kind === 'code.route')!.count > 0, 'the fill ran again: the graph holds the code once more');
  await both(base, '/products/sample-product/k/catalogue', 'refilled-catalogue', '[data-nav-group], [data-testid=nav-group]');
} finally {
  await server.stop();
  await browser.close();
}
console.log(written.join('\n'));
