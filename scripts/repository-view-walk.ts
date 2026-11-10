#!/usr/bin/env bun
/**
 * The repository view's walk (madarch-8bdc.2.5, item 5): the built wiki app in
 * front of a generated fixture repository, driven by headless Chromium the way
 * a reader drives it — the empty wiki, the press, the progress, the end state,
 * the repository, a folder, a file, a commit and the run page.
 *
 * The screenshots are written to `--out` (`/work/out/view-shots` by default),
 * and every page is measured as it is taken: an overflowing page, a page with
 * no heading, a refused page or a page whose text is cut is a defect, named on
 * standard output and a non-zero exit.
 *
 * Usage: bun scripts/repository-view-walk.ts [--out <folder>] [--work <folder>] [--width <px>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { generateTrainingRepository, makeProduct } from '../test/knowledge-fixture.js';
import { gitEnv } from '../test/git-env.js';
import { SAMPLE_IDENTITY } from '../test/knowledge-fixture.js';

/** One value of one argument, or its fallback. */
function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}

const out = resolve(argument('out', '/work/out/view-shots'));
const work = resolve(argument('work', '/tmp/madarch-repository-view-walk'));
const width = Number(argument('width', '1440'));
const height = 900;
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const written: string[] = [];
const defects: string[] = [];

/** One page's measurement: what a reader must be able to read, and what must not spill. */
interface Reading {
  readonly name: string;
  readonly url: string;
  readonly title: string;
  readonly textLength: number;
  readonly headings: number;
  readonly overflowingWidth: number;
  readonly overflowing: readonly string[];
  readonly smallText: number;
  readonly cutText: number;
  readonly cut: readonly string[];
  readonly refused: boolean;
}

/** Every element whose own box is wider than the page's content column, and every text that is clipped. */
async function measure(page: Page, name: string): Promise<Reading> {
  const held = await page.evaluate(() => {
    const documentWidth = document.documentElement.clientWidth;
    // A table wider than a phone is the app's own pattern: it scrolls inside its .table-wrap, never
    // past the page. A box inside such a container, or the container itself, is not a spill.
    const scroller = (element: Element): boolean => {
      for (let at: Element | null = element; at !== null; at = at.parentElement) {
        const overflow = getComputedStyle(at).overflowX;
        if (overflow === 'auto' || overflow === 'scroll') return true;
      }
      return false;
    };
    const overflowing = [...document.querySelectorAll('body *')]
      .filter((element) => {
        if (scroller(element)) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.right > documentWidth + 1 || box.left < -1);
      })
      .map((element) => `${element.tagName.toLowerCase()}${element.className === '' ? '' : `.${String(element.className).split(' ')[0]}`}`)
      .slice(0, 8);
    const small = [...document.querySelectorAll('body *')]
      .filter((element) => element.children.length === 0 && (element.textContent ?? '').trim() !== '')
      .filter((element) => Number.parseFloat(getComputedStyle(element).fontSize) < 11)
      .map((element) => `${element.tagName.toLowerCase()} ${String(element.textContent).trim().slice(0, 30)}`)
      .slice(0, 8);
    const cut = [...document.querySelectorAll('body *')]
      .filter((element) => !scroller(element))
      .filter((element) => {
        // Four pixels are the bar's own rule (`span:last-child > *` may shrink) and a rounded
        // subpixel: a control three pixels narrower than its content is not a cut a reader meets.
        if (element.scrollWidth <= element.clientWidth + 4 || element.clientWidth <= 0) return false;
        const style = getComputedStyle(element);
        // An ellipsis is the page saying it cut a text: it is read as one, and the title carries the
        // whole. A box that simply hides its content is not.
        return style.textOverflow !== 'ellipsis';
      })
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).split(' ').filter(Boolean).join('.')}(${element.clientWidth}/${element.scrollWidth})`)
      .slice(0, 8);
    return {
      url: window.location.pathname + window.location.search,
      title: document.title,
      textLength: (document.body.innerText ?? '').trim().length,
      headings: document.querySelectorAll('h1, h2').length,
      overflowing,
      small,
      cut,
      refused: document.querySelector('[data-testid=repository-refused]') !== null,
    };
  });
  return {
    name, url: held.url, title: held.title, textLength: held.textLength, headings: held.headings,
    overflowingWidth: held.overflowing.length, overflowing: held.overflowing, smallText: held.small.length, cutText: held.cut.length, cut: held.cut, refused: held.refused,
  };
}

/** Waits until the page holds the selector, or names what it never came to. */
async function until(page: Page, selector: string, what: string, timeout = 120_000): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout });
  } catch {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 1200));
    throw new Error(`never came to ${what} (${selector}); the page holds: ${body}`);
  }
}

/** Waits for the page to stop moving: two frames and a moment, so a transition is not what is measured. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await new Promise((resolve) => setTimeout(resolve, 250));
}

/** One screenshot, measured before it is taken. */
async function shot(page: Page, name: string): Promise<void> {
  await settle(page);
  const reading = await measure(page, name);
  if (reading.refused) defects.push(`${name}: the page is a refusal (${reading.url})`);
  if (reading.headings === 0) defects.push(`${name}: the page has no heading (${reading.url})`);
  if (reading.textLength < 40) defects.push(`${name}: the page holds almost no text (${reading.textLength} characters, ${reading.url})`);
  if (reading.overflowingWidth > 0) defects.push(`${name}: ${reading.overflowingWidth} element(s) spill past the page width: ${reading.overflowing.join(', ')} (${reading.url})`);
  if (reading.cutText > 0) defects.push(`${name}: ${reading.cutText} element(s) clip their own content: ${reading.cut.join(', ')} (${reading.url})`);
  if (reading.smallText > 0) defects.push(`${name}: ${reading.smallText} text(s) smaller than 11 px (${reading.url})`);
  const file = join(out, `${name}.png`);
  // The page's words, beside its picture: what a reader reads, so a reviewer can read it too.
  const words = await page.evaluate(() => document.body.innerText);
  writeFileSync(join(out, `${name}.txt`), `${words}\n`, 'utf8');
  for (const wrong of ['undefined', 'NaN', '[object Object]', 'null (']) {
    if (words.includes(wrong)) defects.push(`${name}: the page shows ${JSON.stringify(wrong)} (${reading.url})`);
  }
  const hidden = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((element) => (element.textContent ?? '').trim() !== '' && ['hidden', 'collapse'].includes(getComputedStyle(element).visibility)).length);
  if (hidden > 0) defects.push(`${name}: ${hidden} element(s) with text are invisible (${reading.url})`);
  await page.screenshot({ path: file as `${string}.png`, fullPage: true });
  const bytes = statSync(file).size;
  if (bytes < 5_000) defects.push(`${name}: the screenshot is only ${bytes} bytes, which is no page`);
  written.push(`${file} (${bytes} bytes)`);
  console.log(`${name}: ${reading.textLength} characters, ${reading.headings} headings, ${reading.overflowingWidth} overflowing, ${reading.cutText} clipped, ${reading.smallText} small; ${reading.url}`);
}

const repository = generateTrainingRepository(join(work, 'repository'));
// The generated fixture grows by a page of its own notes: a tree big enough that the run's trace is
// written while the run is under way, so the walk photographs the progress the trace states rather
// than the first moment of the press. Nothing here names a folder or a file of the repository it is
// added to.
mkdirSync(join(repository, 'generated'), { recursive: true });
for (let index = 0; index < 400; index++) {
  writeFileSync(join(repository, 'generated', `note-${String(index).padStart(3, '0')}.txt`), `the generated note ${String(index)}\n`);
}
if (!existsSync(join(repository, '.git', 'index.lock'))) {
  try {
    execFileSync('git', ['add', '-A'], { cwd: repository, env: gitEnv(SAMPLE_IDENTITY), stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'the generated notes'], { cwd: repository, env: gitEnv(SAMPLE_IDENTITY), stdio: 'ignore' });
  } catch {
    // The notes are already committed (a second walk of one work folder): the revision stands.
  }
}
const home = join(work, 'products');
const madarchHome = join(work, 'madarch-home');
mkdirSync(madarchHome, { recursive: true });
writeFileSync(join(madarchHome, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }, null, 2));
// A walk is re-run on the same work folder: the product and its store are made afresh, the
// generated repository is kept as it is.
rmSync(join(home, 'view'), { recursive: true, force: true });
rmSync(join(home, '.madarch'), { recursive: true, force: true });
const productFolder = makeProduct(home, 'view', repository, 'training');
const appFolder = resolve(import.meta.dir, '..', 'wiki', 'app', 'dist');
if (!existsSync(join(appFolder, 'index.html'))) throw new Error(`${appFolder} holds no built wiki app: run "bun run build" in wiki/app first`);

const server: StartedServer = await startServer({
  productHome: home,
  appFolder,
  port: 0,
  env: { ...process.env, MADARCH_HOME: madarchHome },
  log: () => undefined,
  errorLog: (line) => console.error(`server: ${line}`),
});
let browser: Browser | undefined;
try {
  browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, protocolTimeout: 900_000, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  const base = `${server.url}/products/view/`;

  // 1. The empty wiki: what the page says before anything is read, and the press.
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await until(page, '[data-testid=fill-start]', 'the fill button');
  await shot(page, '01-empty');

  // 2. The press, and the fill as it runs: the card counts what the run's trace says it did.
  await page.click('[data-testid=fill-start]');
  await page.waitForFunction(() => document.querySelector('[data-testid=fill-card][data-state=running]') !== null, { timeout: 60_000 }).catch(() => undefined);
  // The card follows the run's trace: it is photographed once the trace has told it something.
  const told = await page.waitForFunction(() => document.querySelector('[data-testid=fill-progress-counts]') !== null || document.querySelector('[data-testid=fill-progress-last]') !== null, { timeout: 60_000 }).then(() => true).catch(() => false);
  if (!told) defects.push('02-progress: the running card never named what the run had done (its trace said nothing while it ran)');
  await shot(page, '02-progress');

  // 3. The end: the run is done and the home is the repository the fill read, with the counts and
  // the time the run took. A reload then shows the same page read from the store alone.
  await until(page, '[data-testid=repository-page]', 'the repository page', 300_000);
  // The tree stands under the facts: the page is photographed when its listing is there, never while
  // its skeleton still stands in its place.
  await until(page, '[data-testid=file-rows], [data-testid=repository-empty], [data-testid=repository-refused]', 'the repository tree');
  await shot(page, '03-end');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await until(page, '[data-testid=repository-page]', 'the repository page after a reload');
  await until(page, '[data-testid=file-rows], [data-testid=repository-empty], [data-testid=repository-refused]', 'the repository tree after a reload');
  await shot(page, '04-repository');

  // 4. A folder: the first folder that holds a file, found by opening the folders the repository
  // lists and then their own folders. The folder is photographed where the file is.
  const rootFolders = await page.evaluate(() => [...document.querySelectorAll('[data-testid=folder-link]')].map((link) => (link as HTMLAnchorElement).getAttribute('href')));
  if (rootFolders.length === 0) throw new Error('the repository page lists no folder, so the walk cannot go on');
  const queue = [...rootFolders];
  const seen = new Set<string>();
  let filePage: string | null = null;
  while (queue.length > 0 && filePage === null && seen.size < 40) {
    const href = queue.shift()!;
    if (href === null || seen.has(href)) continue;
    seen.add(href);
    await page.goto(new URL(href, server.url).toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await until(page, '[data-testid=folder-page]', 'the folder page');
    const held = await page.evaluate(() => ({
      file: (document.querySelector('[data-testid=file-link]') as HTMLAnchorElement | null)?.getAttribute('href') ?? null,
      folders: [...document.querySelectorAll('[data-testid=folder-link]')].map((link) => (link as HTMLAnchorElement).getAttribute('href')),
    }));
    if (held.file !== null) { filePage = held.file; break; }
    queue.push(...held.folders.filter((one): one is string => one !== null));
  }
  if (filePage === null) throw new Error('no folder the walk opened holds a file');
  await shot(page, '05-folder');

  // 5. The file that folder holds: every fact of it and its history.
  await page.goto(new URL(filePage, server.url).toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await until(page, '[data-testid=file-page]', 'the file page');
  await shot(page, '06-file');

  // 6. A commit: the first commit the file's history names, then the commit's own page.
  const commitHref = await page.evaluate(() => {
    const link = document.querySelector('[data-testid=history-commit]') as HTMLAnchorElement | null;
    return link === null ? null : link.getAttribute('href');
  });
  if (commitHref === null) throw new Error('the file page holds no commit, so the walk cannot show one');
  await page.goto(new URL(commitHref, server.url).toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await until(page, '[data-testid=commit-page]', 'the commit page');
  await shot(page, '07-commit');

  // 7. The run page: every step's time, its memory and its slowest names, from the trace.
  await page.goto(`${base}/run`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await until(page, '[data-testid=run-page]', 'the run page');
  await shot(page, '08-run');

  // 8. The same pages at a narrower width, where a table is most likely to spill.
  await page.setViewport({ width: 1024, height });
  await page.goto(`${base}/file?${filePage.split('?')[1] ?? ''}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await until(page, '[data-testid=file-page]', 'the file page at 1024 px');
  await shot(page, '09-file-narrow');

  // 9. The file page at a phone's width, where a table is most likely to spill.
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${base}/file?${filePage.split('?')[1] ?? ''}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await until(page, '[data-testid=file-page]', 'the file page at 390 px');
  await shot(page, '10-file-phone');
} finally {
  await browser?.close();
  await server.stop();
}

console.log('');
console.log(`screenshots: ${String(written.length)} in ${out}`);
for (const file of written) console.log(`  ${file}`);
if (defects.length > 0) {
  console.error('');
  for (const defect of defects) console.error(`defect: ${defect}`);
  process.exit(1);
}
console.log('every page was readable: a heading, text, nothing spilling past the width, nothing clipped, no text under 11 px');
