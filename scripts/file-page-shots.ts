/**
 * The file page's shots (madarch-u3vw.14, u3vw.16, j9ao.2.1): a filled product with a long Markdown file and a source
 * file of long lines, at 1150, 1920 and 390 px, light and dark, in Russian and English with the role card dismissed. Each PNG has
 * its visible text beside it; the rendered Markdown, the source and the soft-wrap switch are asserted.
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
import { makeProduct, writeSamplePages } from '../test/knowledge-fixture.js';
import { gitEnv } from '../test/git-env.js';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = resolve(values.out ?? join(tmpdir(), 'madarch-file-page-shots'));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'madarch-file-page-'));
const home = join(work, 'home');
const madarchHome = join(work, 'madarch-home');
mkdirSync(home, { recursive: true });
mkdirSync(madarchHome, { recursive: true });
writeFileSync(join(madarchHome, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }, null, 2));
const repo = join(work, 'repo');
mkdirSync(join(repo, 'docs'), { recursive: true });
mkdirSync(join(repo, 'src'), { recursive: true });
const long = 'A sentence that is deliberately long so the source view has to scroll sideways on a wide screen, and the Markdown source wraps only when the reader asks it to. '.repeat(4);
writeFileSync(join(repo, 'docs', 'long.md'), `# Long document\n\n${long}\n\n## A section\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`);
writeFileSync(join(repo, 'src', 'long.ts'), `export const veryLongIdentifier = "${'x'.repeat(320)}";\nexport const second = "${'y'.repeat(320)}";\n`);
writeFileSync(join(repo, 'package.json'), '{"name":"tiny","dependencies":{}}\n');
writeFileSync(join(repo, 'docs', 'product.md'), '---\nid: product:shop\nkind: product\ntitle: Shop\n---\n\nThe shop.\n');
mkdirSync(join(repo, 'docs', 'domains'), { recursive: true });
writeFileSync(join(repo, 'docs', 'domains', 'shop.md'), '---\nid: domain:shop\nkind: domain\ntitle: Shop\n---\n\nThe shop domain.\n');
const env = gitEnv({ GIT_AUTHOR_NAME: 'Shot Fixture', GIT_AUTHOR_EMAIL: 'shot@example.test', GIT_COMMITTER_NAME: 'Shot Fixture', GIT_COMMITTER_EMAIL: 'shot@example.test' });
const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, env }); };
git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'First commit');
writeFileSync(join(repo, 'src', 'long.ts'), `export const veryLongIdentifier = "${'x'.repeat(320)}";\nexport const second = "${'y'.repeat(320)}";\nexport const third = 3;\n`);
git('add', '-A'); git('commit', '-qm', 'Change the source');
const folder = makeProduct(home, 'shop', repo, 'tiny');
writeSamplePages(folder);
const storeRoot = join(home, '.madarch', 'knowledge');
const product = new KnowledgeProduct({ productFolder: folder, storeRoot });
if (!(await product.startFill()).started) throw new Error('the fixture fill did not start');
await product.settled();
if (product.fillState().state !== 'done') throw new Error(`the fixture fill did not finish: ${JSON.stringify(product.fillState())}`);
await product.close();
const server = await startServer({ productHome: home, knowledgeRoot: storeRoot, appFolder: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist'), port: 0, log: () => undefined, errorLog: (line: string) => console.error(line), env: { ...process.env, MADARCH_HOME: madarchHome } });
const status = await (await fetch(`${server.url}/products/shop/api/status`)).json() as { home: string | null; kinds: { kind: string; count: number }[]; filled: boolean; writer: { state: string } };
console.log('STATUS', JSON.stringify({ home: status.home, filled: status.filled, domain: status.kinds.find((kind) => kind.kind === 'domain')?.count, writer: status.writer.state }));
const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const textOf = async (page: puppeteer.Page): Promise<string> => await page.evaluate(() => {
  const part = (title: string, selector: string): string => `## ${title}\n${(document.querySelector(selector)?.innerText ?? '(absent)').trim()}`;
  return [part('top bar', '[data-testid="shell-fixed"]'), part('page', 'main')].join('\n\n');
});
const save = async (page: puppeteer.Page, name: string, width: number): Promise<void> => {
  const png = await page.screenshot({ fullPage: true });
  writeFileSync(join(out, `${name}.png`), png);
  writeFileSync(join(out, `${name}.txt`), `${await textOf(page)}\n`);
  const size = statSync(join(out, `${name}.png`)).size;
  const pngBytes = readFileSync(join(out, `${name}.png`));
  if (size < 10_000 || pngBytes.readUInt32BE(16) !== width) throw new Error(`${name}: the shot is not a page`);
};
try {
  for (const language of ['ru', 'en'] as const) {
  for (const width of [1150, 1920, 390] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: width >= 1000 ? 900 : 844, deviceScaleFactor: 1 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.evaluateOnNewDocument((language: string) => {
        try {
          localStorage.setItem('madarch-wiki-language', language);
          localStorage.setItem('madarch-file-view', 'rendered');
          localStorage.setItem('madarch-file-face', 'overview');
          localStorage.setItem('madarch-file-wrap', 'false');
        } catch { /* private context */ }
      }, language);
      const addressOf = (id: string): string => `${server.url}/products/shop/e/${encodeURIComponent(id).replace(/\.md$/u, '%2Emd')}`;
      const open = async (id: string, selector: string): Promise<void> => {
        await page.goto(addressOf(id), { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await page.waitForSelector(selector, { timeout: 120_000 });
        await new Promise((rest) => setTimeout(rest, 400));
      };
      // The Markdown file: rendered first; the reader's stored view/face are reset so every shot starts at Overview/Rendered.
      try { await open('code.file:tiny/docs/long.md', '[data-testid=file-page]'); } catch (error) { console.error('PAGE', await page.evaluate(() => document.body.innerText.slice(0, 1200))); throw error; }
      await page.waitForSelector('[data-testid=file-overview] h1', { timeout: 60_000 });
      const controls = await page.evaluate(() => [...document.querySelectorAll('input, select')].map((node) => ({
        tag: node.tagName, type: node.getAttribute('type'), placeholder: node.getAttribute('placeholder'), text: node.textContent,
      })));
      if (!controls.some((control) => control.type === 'text' && control.placeholder === (language === 'ru' ? 'ГГГГ-ММ-ДД' : 'YYYY-MM-DD')) || controls.some((control) => control.type === 'date')) throw new Error(`date language ${language}: ${JSON.stringify(controls)}`);
      writeFileSync(join(out, `controls-${language}-${String(width)}-${scheme}.json`), JSON.stringify(controls, null, 2));
      await page.type('[data-testid=history-date]', '2026-02-31');
      await page.waitForSelector('[data-testid=history-date][aria-invalid="true"]');
      if (await page.$('a[href*="at=2026-02-31"]') !== null) throw new Error('an invalid date offered a history address');
      await page.$eval('[data-testid=history-date]', (input) => { const field = input as HTMLInputElement; field.select(); });
      await page.keyboard.press('Backspace');
      const markdownName = `file-markdown-${language}-${String(width)}-${scheme}`;
      await save(page, markdownName, width);
      const rendered = await page.evaluate(() => ({ heading: document.querySelector('[data-testid=file-overview] h1')?.textContent ?? null, document: document.documentElement.scrollWidth, viewport: window.innerWidth, language: document.querySelector('[data-testid=file-header-language]')?.textContent ?? null }));
      if (rendered.heading !== 'Long document' || rendered.document > rendered.viewport) throw new Error(`${markdownName}: ${JSON.stringify(rendered)}`);
      await page.evaluate(() => { try { localStorage.setItem('madarch-file-wrap', 'false'); } catch { /* private */ } });
      await (await page.$('[data-testid=file-view-source]'))!.click();
      await page.waitForSelector('[data-testid=file-source]', { timeout: 60_000 });
      if (await page.evaluate(() => document.querySelector('[data-testid=source-code]')?.getAttribute('data-wrap')) === 'true') await (await page.$('[data-testid=file-wrap]'))!.click();
      await save(page, `file-markdown-source-${language}-${String(width)}-${scheme}`, width);
      const markdownSource = await page.evaluate(() => { const frame = document.querySelector('[data-testid=file-source]'); return { scroll: frame?.scrollWidth ?? 0, client: frame?.clientWidth ?? 0, document: document.documentElement.scrollWidth, viewport: window.innerWidth, wrap: document.querySelector('[data-testid=source-code]')?.getAttribute('data-wrap') }; });
      if (markdownSource.document > markdownSource.viewport || markdownSource.wrap !== 'false') throw new Error(`markdown source ${markdownName}: ${JSON.stringify(markdownSource)}`);
      await (await page.$('[data-testid=file-wrap]'))!.click();
      if (await page.evaluate(() => document.querySelector('[data-testid=source-code]')?.getAttribute('data-wrap')) !== 'true') throw new Error(`${markdownName}: soft wrap did not turn on`);
      // The source file: long lines, a sideways scroll, then soft wrap.
      await page.evaluate(() => { try { localStorage.setItem('madarch-file-wrap', 'false'); } catch { /* private */ } });
      await open('code.file:tiny/src/long.ts', '[data-testid=file-page]');
      await page.waitForSelector('[data-testid=file-source]', { timeout: 60_000 });
      const sourceName = `file-source-${language}-${String(width)}-${scheme}`;
      await save(page, sourceName, width);
      const source = await page.evaluate(() => { const frame = document.querySelector('[data-testid=file-source]'); const pre = document.querySelector('[data-testid=source-code]'); return { scroll: pre?.scrollWidth ?? 0, client: pre?.clientWidth ?? 0, frame: frame?.clientWidth ?? 0, document: document.documentElement.scrollWidth, viewport: window.innerWidth, wrap: pre?.getAttribute('data-wrap') }; });
      if (source.document > source.viewport || source.scroll <= source.client || source.wrap !== 'false') throw new Error(`${sourceName}: ${JSON.stringify(source)}`);
      for (const face of ['history', 'cochange'] as const) {
        await (await page.$(`[data-testid=file-tab-${face}]`))!.click();
        await page.waitForSelector(`[data-testid=file-${face}]`, { timeout: 60_000 });
        await save(page, `file-${face}-${language}-${String(width)}-${scheme}`, width);
        const bounds = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
        if (bounds.document > bounds.viewport) throw new Error(`file ${face}: ${JSON.stringify(bounds)}`);
      }
      await (await page.$('[data-testid=file-tab-overview]'))!.click();
      await (await page.$('[data-testid=file-wrap]'))!.click();
      const wrapped = await page.evaluate(() => { const frame = document.querySelector('[data-testid=file-source]'); return { document: document.documentElement.scrollWidth, viewport: window.innerWidth, wrap: document.querySelector('[data-testid=source-code]')?.getAttribute('data-wrap') }; });
      if (wrapped.document > wrapped.viewport || wrapped.wrap !== 'true') throw new Error(`${sourceName} wrap: ${JSON.stringify(wrapped)}`);
      await page.close();
      console.log(`${markdownName}, file-markdown-source-${String(width)}-${scheme}, ${sourceName}: ${JSON.stringify({ rendered, markdownSource, source, wrapped })}`);
    }
  }
  }
} finally {
  await browser.close();
  await server.stop().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
