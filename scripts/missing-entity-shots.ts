/**
 * The missing entity page's shot (madarch-moo8): a filled product, an id in the old form the graph does not hold, in
 * Russian, with the role card dismissed. The page names the id, searches the graph for its last segment and links the
 * result; the agent's offer is not on it. Each PNG has its visible text beside it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { startServer } from '../src/server/http.js';
import { makeProduct } from '../test/knowledge-fixture.js';
import { gitEnv } from '../test/git-env.js';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = resolve(values.out ?? join(tmpdir(), 'madarch-missing-entity-shots'));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'madarch-missing-entity-'));
const home = join(work, 'home');
const madarchHome = join(work, 'madarch-home');
mkdirSync(home, { recursive: true });
mkdirSync(madarchHome, { recursive: true });
writeFileSync(join(madarchHome, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }, null, 2));
const repo = join(work, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'src', 'a.ts'), 'export function leaf(): number {\n  return 1;\n}\n');
writeFileSync(join(repo, 'package.json'), '{"name":"tiny","dependencies":{}}\n');
const env = gitEnv({ GIT_AUTHOR_NAME: 'Shot Fixture', GIT_AUTHOR_EMAIL: 'shot@example.test', GIT_COMMITTER_NAME: 'Shot Fixture', GIT_COMMITTER_EMAIL: 'shot@example.test' });
for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'First commit']]) execFileSync('git', args, { cwd: repo, env });
const folder = makeProduct(home, 'shop', repo, 'tiny');
const storeRoot = join(home, '.madarch', 'knowledge');
const product = new KnowledgeProduct({ productFolder: folder, storeRoot });
if (!(await product.startFill()).started) throw new Error('the fixture fill did not start');
await product.settled();
if (product.fillState().state !== 'done') throw new Error(`the fixture fill did not finish: ${JSON.stringify(product.fillState())}`);
await product.close();
const server = await startServer({ productHome: home, knowledgeRoot: storeRoot, appFolder: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist'), port: 0, log: () => undefined, errorLog: (line: string) => console.error(line), env: { ...process.env, MADARCH_HOME: madarchHome } });
const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const id = 'code.file:src/a.ts';
  for (const width of [1150, 390] as const) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: width >= 1000 ? 900 : 844, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('madarch-wiki-language', 'ru'); } catch { /* private context */ } });
    await page.goto(`${server.url}/products/shop/e/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForSelector('[data-testid=missing-entity-search]', { timeout: 120_000 });
    await page.waitForSelector('[data-testid=missing-entity-result]', { timeout: 120_000 });
    await new Promise((rest) => setTimeout(rest, 300));
    const name = `missing-entity-${String(width)}`;
    const png = await page.screenshot({ fullPage: true });
    writeFileSync(join(out, `${name}.png`), png);
    const text = await page.evaluate(() => {
      const part = (title: string, selector: string): string => `## ${title}\n${(document.querySelector(selector)?.innerText ?? '(absent)').trim()}`;
      return [part('top bar', '[data-testid="shell-fixed"]'), part('page', 'main')].join('\n\n');
    });
    writeFileSync(join(out, `${name}.txt`), `${text}\n`);
    const measured = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      title: document.querySelector('[data-testid=page-error]')?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
      id: document.querySelector('[data-testid=missing-entity-id]')?.textContent ?? '',
      query: document.querySelector('[data-testid=missing-entity-query]')?.textContent ?? '',
      results: [...document.querySelectorAll('[data-testid=missing-entity-result]')].map((row) => ({ entity: row.getAttribute('data-entity'), text: row.textContent?.replace(/\s+/gu, ' ').trim() ?? '' })),
      agentOffer: document.querySelector('[data-testid=fill-card]') !== null || /Поручите агенту|Let an agent/.test(document.body.innerText ?? ''),
      russian: /[А-Яа-я]/u.test(document.querySelector('main')?.innerText ?? ''),
    }));
    const size = statSync(join(out, `${name}.png`)).size;
    console.log(`${name}: ${JSON.stringify({ ...measured, bytes: size })}`);
    if (measured.document > measured.viewport || measured.id !== id || measured.query !== 'a.ts' || measured.results.length === 0 || measured.agentOffer || !measured.russian || size < 10_000 || readFileSync(join(out, `${name}.png`)).readUInt32BE(16) !== width) {
      console.error(`${name}: not the missing entity page it should be`);
      process.exitCode = 1;
    }
    await page.close();
  }
} finally {
  await browser.close();
  await server.stop().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
