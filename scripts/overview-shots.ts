/**
 * The home overview's shots (madarch-47vw.5): a filled training product's product page rendered in the built app at 1150
 * and 390 px, light and dark, in Russian with the role card dismissed. Each PNG has its visible text beside it; a
 * diagram, when the page draws one, is measured with scripts/diagram-measures.ts (title sizes, clipping, overlaps).
 *
 * Usage: bun scripts/overview-shots.ts [--out <folder>] [--work <folder>]
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { DIAGRAM_MEASURES } from './diagram-measures.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { startServer } from '../src/server/http.js';
import { generateTrainingRepository, makeProduct, writeSamplePages } from '../test/knowledge-fixture.js';

const { values } = parseArgs({ options: { out: { type: 'string' }, work: { type: 'string' } } });
const out = resolve(values.out ?? join(tmpdir(), 'madarch-overview-shots'));
const work = resolve(values.work ?? mkdtempSync(join(tmpdir(), 'madarch-overview-shots-')));
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const home = join(work, 'home');
const madarchHome = join(work, 'madarch-home');
mkdirSync(home, { recursive: true });
mkdirSync(madarchHome, { recursive: true });
// A returning reader: the role card is gone and the walk reads as everything.
writeFileSync(join(madarchHome, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }, null, 2));

const repository = generateTrainingRepository(join(work, 'repo'));
const folder = makeProduct(home, 'training-shop', repository);
writeSamplePages(folder);
const storeRoot = join(home, '.madarch', 'knowledge');
const product = new KnowledgeProduct({ productFolder: folder, storeRoot });
const started = await product.startFill();
if (!started.started) throw new Error(`the fixture fill did not start: ${started.message}`);
await product.settled();
if (product.fillState().state !== 'done') throw new Error(`the fixture fill did not finish: ${JSON.stringify(product.fillState())}`);
await product.close();

const server = await startServer({
  productHome: home,
  knowledgeRoot: storeRoot,
  appFolder: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist'),
  port: 0,
  log: () => undefined,
  errorLog: (line: string) => console.error(line),
  env: { ...process.env, MADARCH_HOME: madarchHome },
});
const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const written: string[] = [];
try {
  for (const width of [1150, 390] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: width >= 1000 ? 900 : 844, deviceScaleFactor: 1 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.evaluateOnNewDocument(() => { try { localStorage.setItem('madarch-wiki-language', 'ru'); } catch { /* private context */ } });
      const address = `${server.url}/products/training-shop/`;
      await page.goto(address, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForSelector('[data-block=overview]', { timeout: 120_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-block=overview]').length >= 6, { timeout: 120_000 });
      // Deferred diagrams ask for themselves after the page is drawn.
      await new Promise((rest) => setTimeout(rest, 1_500));
      const name = `home-${String(width)}-${scheme}`;
      const file = join(out, `${name}.png`);
      const shot = await page.screenshot({ fullPage: true });
      writeFileSync(file, shot);
      written.push(file);
      const png = readFileSync(file);
      const pngWidth = png.readUInt32BE(16);
      const pngHeight = png.readUInt32BE(20);
      if (statSync(file).size < 20_000 || pngWidth !== width || pngHeight < 400) {
        console.error(`${name}: the shot is not a page: ${statSync(file).size} bytes, ${pngWidth}x${pngHeight}`);
        process.exitCode = 1;
      }
      const text = await page.evaluate(() => {
        const part = (title: string, selector: string): string => `## ${title}\n${(document.querySelector(selector)?.innerText ?? '(absent)').trim()}`;
        return [part('top bar', '[data-testid="shell-fixed"]'), part('page', 'main')].join('\n\n');
      });
      writeFileSync(join(out, `${name}.txt`), `${text}\n`);
      const measured = await page.evaluate(() => {
        const rect = (element: Element): { top: number; left: number; width: number; height: number } => {
          const box = element.getBoundingClientRect();
          return { top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) };
        };
        return {
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          roleCard: document.querySelector('[data-testid="role-card"]') !== null,
          sections: [...document.querySelectorAll('[data-block=overview]')].map((element) => ({
            section: element.getAttribute('data-overview'),
            title: element.querySelector('h2')?.textContent?.trim() ?? '',
            text: (element.innerText ?? '').replace(/\s+/gu, ' ').trim().slice(0, 400),
            absent: element.querySelector('[data-testid=overview-absent]')?.textContent?.replace(/\s+/gu, ' ').trim() ?? null,
            rect: rect(element),
          })),
          diagrams: document.querySelectorAll('[data-diagram=views]').length,
          forbidden: {
            folder: document.querySelector('[data-block=folder], [data-block=repository], [data-block=history]') !== null,
            url: /https?:\/\//u.test(document.querySelector('main')?.innerText ?? ''),
          },
          russian: /[А-Яа-я]/u.test(document.querySelector('[data-block=overview] h2')?.textContent ?? ''),
        };
      });
      const diagramAt = [];
      for (let at = 0; at < measured.diagrams; at += 1) {
        const renderer = await page.evaluate((index) => {
          const block = document.querySelectorAll('[data-diagram=views]')[index];
          if (block === undefined || block === null) return null;
          if (block.querySelector('[data-testid=view-frame-likec4]') !== null) return 'likec4';
          if (block.querySelector('iframe[data-renderer=archify]') !== null) return 'archify';
          if (block.querySelector('[data-testid=view-picture] [data-testid=mermaid-diagram]') !== null) return 'mermaid';
          return null;
        }, at);
        diagramAt.push(renderer === null ? { blockAt: at, measurementStatus: 'no-renderer' } : { blockAt: at, renderer, ...(await page.evaluate(`(${DIAGRAM_MEASURES})(${JSON.stringify({ blockAt: at, renderer })})`)) });
      }
      const report = { name, address, ...measured, diagramAt };
      writeFileSync(join(out, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
      console.log(`${name}: ${JSON.stringify({ viewport: measured.viewport, document: measured.document, roleCard: measured.roleCard, sections: measured.sections.map((one) => `${one.section}:${one.title}`), diagrams: measured.diagrams, diagramAt: diagramAt.map((one) => ({ status: one.measurementStatus, minFontPx: (one as { minFontPx?: number }).minFontPx, overlaps: (one as { overlapCount?: number }).overlapCount, clipped: (one as { clippedTitleCount?: number }).clippedTitleCount })) })} -> ${file}`);
      if (measured.document > measured.viewport || measured.roleCard || !measured.russian || measured.sections.length < 6
        || measured.sections.some((section) => section.title === '' || (section.text === '' && section.absent === null))
        || measured.forbidden.folder || measured.forbidden.url) {
        console.error(`${name} is not the overview it should be: ${JSON.stringify(measured)}`);
        process.exitCode = 1;
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.stop().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
console.log(written.join('\n'));
