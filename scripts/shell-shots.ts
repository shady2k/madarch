/**
 * shell:shots — the acceptance walk of the reader shell (madarch-m38l.12), rendered the way a reader sees it:
 * the sources list (a title with its path under it, no AGENTS.md or CLAUDE.md), a statement whose ground is a
 * service (a card) beside one whose ground is a function (code), a drag across a sentence (opens nothing), a
 * page opened twice (its tab is focused), and the tab titles after load (none says "Loading"). Every picture is
 * taken in the interface language asked for, light and dark, at 1150 px and 390 px. The walk fails with the page
 * and the value when a check does not hold.
 *
 * Usage: bun scripts/shell-shots.ts [--lang ru|en] [--out <folder>] [--work <folder>] [--port <n>]
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer, { type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { SAMPLE_IDENTITY, generateTrainingRepository, makeProduct, writeSamplePages } from '../test/knowledge-fixture.js';
import { gitEnv } from '../test/git-env.js';

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}
const languages = argument('lang', 'en,ru').split(',');
const out = resolve(argument('out', 'shots-shell'));
const work = resolve(argument('work', '/tmp/madarch-shell-shots'));
rmSync(work, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const written: string[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv(SAMPLE_IDENTITY), encoding: 'utf8' });
const fail = (message: string): never => { throw new Error(message); };

const repository = generateTrainingRepository(join(work, 'repo'));
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
const shop = makeProduct(home, 'shop', repository);
writeSamplePages(shop);
// The harness files of a coding agent and a document with no heading: neither is listed as a source by its file name.
writeFileSync(join(shop, 'AGENTS.md'), '# Agent rules\n\nNot a source of the product.\n');
writeFileSync(join(shop, 'CLAUDE.md'), '@AGENTS.md\n');
appendFileSync(join(shop, 'docs', 'notes.md'), 'Notes with no heading.\n');
writeFileSync(join(shop, 'docs', 'long.md'), ['# A long document', '', ...Array.from({ length: 40 }, (_, index) => `## Section ${index + 1}\n\n${'A paragraph of the long document that fills the page. '.repeat(12)}\n`)].join('\n'));
git(shop, 'add', '.');
git(shop, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the sample pages and notes');

const env = { ...process.env, MADARCH_HOME: join(work, 'madarch'), MADARCH_OWN_WIKI: 'off', MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist') };
const port = Number(argument('port', '4311'));
const child = Bun.spawn(['bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', home, '--port', String(port)], { env, stdout: 'inherit', stderr: 'inherit' });
const base = `http://127.0.0.1:${port}`;
for (let tries = 0; ; tries += 1) {
  try {
    if ((await fetch(`${base}/`, { redirect: 'manual' })).status < 500) break;
  } catch {
    // not listening yet
  }
  if (tries > 120) fail(`the background server did not answer on port ${port}`);
  await new Promise((rest) => setTimeout(rest, 500));
}

const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, protocolTimeout: 1_600_000, args: ['--no-sandbox'] });
const encode = encodeURIComponent;
async function open(url: string, lang: string, scheme: 'light' | 'dark', width: number, height = 900): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((language) => { try { window.localStorage.setItem('madarch-wiki-language', language); } catch { /* the browser's own language */ } }, lang);
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  page.on('pageerror', (error) => console.error(`page error at ${url}: ${error.message}`));
  await page.goto(`${base}${url}`, { waitUntil: 'domcontentloaded' });
  return page;
}
async function shoot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await new Promise((rest) => setTimeout(rest, 400));
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  written.push(file);
}
const tabs = (page: Page): Promise<{ title: string; active: boolean }[]> => page.evaluate(() => [...document.querySelectorAll('[data-testid=tab]')].map((tab) => ({ title: tab.querySelector('[role=tab]')!.textContent ?? '', active: tab.getAttribute('data-active') === 'true' })));
const noLoading = async (page: Page, where: string): Promise<void> => {
  await page.waitForFunction(() => document.querySelector('[data-testid=tab-bar]') !== null);
  await new Promise((rest) => setTimeout(rest, 800));
  const titles = (await tabs(page)).map((tab) => tab.title);
  if (titles.some((title) => /Loading|Загрузка/.test(title) || title.trim() === '')) fail(`${where}: a tab is still titled as loading: ${JSON.stringify(titles)}`);
};

try {
  // The fill reads the training repository into the graph; it asks for no agent (the pages are the sample pages).
  const answer = await fetch(`${base}/products/shop/api/k/fill`, { method: 'POST' });
  if (!answer.ok) fail(`the fill was refused: ${answer.status} ${await answer.text()}`);
  const until = Date.now() + 900_000;
  for (;;) {
    const status = await (await fetch(`${base}/products/shop/api/k/status`)).json() as { fill: { state: string; message?: string } };
    if (status.fill.state === 'done') break;
    if (status.fill.state === 'failed') fail(`the fill failed: ${status.fill.message ?? ''}`);
    if (Date.now() > until) fail(`the fill did not finish in 15 minutes: ${JSON.stringify(status.fill)}`);
    await new Promise((rest) => setTimeout(rest, 3000));
  }
  const probe = await open('/products/shop/', 'en', 'light', 1150);
  await probe.waitForSelector('[data-testid=entity-page]', { timeout: 120_000 });
  if (process.argv.includes('--probe-only')) { console.log('the fill finished'); process.exit(0); }
  await probe.close();

  const SHOP_SENTENCE = 'The shop takes orders from shoppers and charges their cards through a payments service.';
  const PAY_SENTENCE = 'Checkout asks payments to authorize the card for the order\'s total.';
  const statementUrl = (id: string, sentence: string): string => `/products/shop/k/statement?id=${encode(id)}&sentence=${encode(sentence)}`;

  // The sidebar scrolls when its groups are open: its scrollbar, classic or overlay, never covers the counts.
  for (const mode of ['classic', 'overlay'] as const) {
    const bar = await puppeteer.launch({
      executablePath: resolveBrowserExecutable(), headless: true, protocolTimeout: 180_000,
      // Headless hides scrollbars by default: classic ones are asked for, overlay ones are the platform's own (macOS-like).
      ...(mode === 'classic' ? { ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--no-sandbox', '--disable-features=OverlayScrollbar'] } : { ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--no-sandbox', '--enable-features=OverlayScrollbar'] }),
    });
    try {
      for (const lang of languages) {
        for (const scheme of ['light', 'dark'] as const) {
          const page = await bar.newPage();
          await page.evaluateOnNewDocument((language) => { try { window.localStorage.setItem('madarch-wiki-language', language); } catch { /* the browser's own language */ } }, lang);
          await page.setViewport({ width: 1150, height: 420 });
          await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
          await page.goto(`${base}/products/shop/k/docs`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('[data-testid=nav-group]', { timeout: 120_000 });
          for (let round = 0; round < 12; round += 1) {
            const closed = await page.$('[data-testid=nav-group][aria-expanded=false]');
            if (closed === null) break;
            await closed.click();
          }
          const measured = await page.evaluate(() => {
            const nav = document.querySelector('[data-testid=nav-scroll]') as HTMLElement;
            const bar = nav.offsetWidth - nav.clientWidth;
            const edge = nav.getBoundingClientRect().right - bar;
            const counts = [...nav.querySelectorAll('[data-testid=nav-count], [data-testid=nav-group-count]')].map((count) => count.getBoundingClientRect().right);
            return { scrolls: nav.scrollHeight > nav.clientHeight, bar, worst: Math.max(...counts), edge, gutter: getComputedStyle(nav).scrollbarGutter, padding: getComputedStyle(nav).paddingRight };
          });
          console.log(`sidebar ${mode} ${lang} ${scheme}: ${JSON.stringify(measured)}`);
          if (!measured.scrolls) fail(`sidebar ${mode} ${lang} ${scheme}: the sidebar does not scroll, so the check proves nothing: ${JSON.stringify(measured)}`);
          // A count must end before the scrollbar's column; an overlay bar (no width) is kept off by the padding.
          const room = measured.bar > 0 ? measured.edge : measured.edge - 8;
          if (measured.worst > room + 0.5) fail(`sidebar ${mode} ${lang} ${scheme}: a count ends at ${measured.worst} px, under the scrollbar that starts at ${room} px: ${JSON.stringify(measured)}`);
          await page.evaluate(() => { const nav = document.querySelector('[data-testid=nav-scroll]') as HTMLElement; nav.scrollTop = nav.scrollHeight; });
          await shoot(page, `${lang}-${scheme}-nav-${mode}-scrollbar`);
          await page.close();
        }
      }
    } finally {
      await bar.close();
    }
  }

  for (const lang of languages) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const [width, height, size] of [[1150, 900, 'wide'], [390, 844, 'phone']] as const) {
        const tag = `${lang}-${scheme}-${size}`;
        console.log(`walk ${tag}`);
        // Sources: titles, paths under them, no harness files.
        const sources = await open('/products/shop/k/docs', lang, scheme, width, height);
        await sources.waitForSelector('[data-testid=document-row]', { timeout: 120_000 });
        const rows = await sources.evaluate(() => [...document.querySelectorAll('[data-testid=document-row]')].map((row) => [row.querySelector('a')!.textContent ?? '', row.querySelector('[data-testid=document-path]')!.textContent ?? '']));
        if (rows.some(([title, path]) => title === path || /\.md$/i.test(title ?? ''))) fail(`${tag}: a source is shown by its file name: ${JSON.stringify(rows)}`);
        if (rows.some(([, path]) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(path ?? ''))) fail(`${tag}: a harness file is listed: ${JSON.stringify(rows)}`);
        if (!rows.some(([title, path]) => title === 'notes' && path === 'docs/notes.md')) fail(`${tag}: the document with no heading is not titled by its file name: ${JSON.stringify(rows)}`);
        await noLoading(sources, `${tag} sources`);
        // The glossary terms are listed once: the top-level glossary, not again under the pages by kind.
        if (size === 'wide') {
          const kinds = await sources.evaluate(() => [...document.querySelectorAll('nav a[href*="/k/kind/"]')].map((link) => link.getAttribute('href') ?? ''));
          if (kinds.some((href) => decodeURIComponent(href).includes('doc.term'))) fail(`${tag}: the glossary terms are listed again under the pages by kind: ${JSON.stringify(kinds)}`);
        }
        await shoot(sources, `${tag}-01-sources`);
        await sources.close();
        // A ground that is a service is a card; a ground that is a function keeps its code.
        const card = await open(statementUrl('product:shop', SHOP_SENTENCE), lang, scheme, width, height);
        await card.waitForSelector('[data-excerpt=entity]', { timeout: 120_000 });
        // The ground is the service's card, not the manifest file it was read from: no code excerpt stands in it.
        const shown = await card.evaluate(() => {
          const grounds = document.querySelector('[data-testid=statement-grounds]')!;
          const entity = grounds.querySelector('[data-excerpt=entity]')!;
          return {
            code: grounds.querySelector('[data-excerpt=code]') !== null,
            kind: entity.querySelector('[data-testid=card-kind]')?.textContent ?? '',
            page: entity.querySelector('[data-testid=card-page] a')?.getAttribute('href') ?? '',
            facts: entity.querySelector('[data-testid=card-facts]')?.textContent ?? '',
            related: entity.querySelector('[data-testid=card-related]')?.textContent ?? '',
          };
        });
        if (shown.code) fail(`${tag}: the service ground also draws the manifest as code`);
        const kindWord = lang === 'ru' ? 'Сервис' : 'Service';
        if (!shown.kind.includes(kindWord)) fail(`${tag}: the service card does not name its kind «${kindWord}»: ${JSON.stringify(shown)}`);
        // The link carries the product's mount; the page it names is the service's.
        if (!shown.page.endsWith('/k/e/code.service%3Apayments')) fail(`${tag}: the service card links ${shown.page}, not its page`);
        if (!shown.facts.includes('language') || !shown.related.includes('payments')) fail(`${tag}: the service card does not show what the code says of it and what it is connected to: ${JSON.stringify(shown)}`);
        await noLoading(card, `${tag} card`);
        await shoot(card, `${tag}-02-service-ground-card`);
        await card.close();
        const code = await open(statementUrl('domain:payment', PAY_SENTENCE), lang, scheme, width, height);
        await code.waitForSelector('[data-excerpt=code]', { timeout: 120_000 });
        await shoot(code, `${tag}-03-function-ground-code`);
        await code.close();
      }

      // The page, a drag across a sentence, a page opened twice.
      const tag = `${lang}-${scheme}-wide`;
      const page = await open(`/products/shop/k/e/${encode('product:shop')}`, lang, scheme, 1150, 800);
      await page.waitForSelector('[data-testid=statement]', { timeout: 120_000 });
      await noLoading(page, `${tag} home`);
      const before = (await tabs(page)).length;
      const box = (await (await page.$('[data-testid=statement]'))!.boundingBox())!;
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await new Promise((rest) => setTimeout(rest, 500));
      const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
      if (selected.trim() === '') fail(`${tag}: the drag selected nothing`);
      const after = (await tabs(page)).length;
      if (after !== before) fail(`${tag}: a drag across a sentence opened a tab (${before} -> ${after})`);
      await shoot(page, `${tag}-04-selection-opens-nothing`);
      // A plain click opens the statement; opening it again focuses its tab.
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.click('[data-testid=statement]');
      await page.waitForFunction((count) => document.querySelectorAll('[data-testid=tab]').length === count, {}, before + 1);
      await page.evaluate(() => { history.back(); });
      await page.waitForFunction((count) => document.querySelectorAll('[data-testid=tab]').length === count, {}, before + 1);
      await page.click('[data-testid=statement]');
      await new Promise((rest) => setTimeout(rest, 600));
      const final = await tabs(page);
      if (final.length !== before + 1) fail(`${tag}: opening an open statement made a second tab: ${JSON.stringify(final)}`);
      if (!final[final.length - 1]!.active && !final.some((tab) => tab.active)) fail(`${tag}: no tab is in front: ${JSON.stringify(final)}`);
      await noLoading(page, `${tag} after the clicks`);
      await shoot(page, `${tag}-05-open-page-focused-not-duplicated`);
      await page.close();
    }
    // The bars stay while a long page scrolls, and an anchor lands below them.
    for (const [width, height, size] of [[1150, 700, 'wide'], [390, 800, 'phone']] as const) {
      const tag = `${lang}-light-${size}`;
      const long = await open('/products/shop/k/doc?path=docs%2Flong.md', lang, 'light', width, height);
      await long.waitForSelector('[data-testid=tab-bar]', { timeout: 120_000 });
      await long.waitForFunction(() => document.querySelectorAll('h2').length >= 20, { timeout: 60_000 });
      const barTop = (): Promise<number> => long.evaluate(() => Math.round(document.querySelector('[data-testid=tab-bar]')!.getBoundingClientRect().top));
      const before = await barTop();
      await long.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await new Promise((rest) => setTimeout(rest, 400));
      const scrolled = await long.evaluate(() => window.scrollY);
      const during = await barTop();
      if (scrolled < 300) fail(`${tag}: the long page did not scroll (${scrolled})`);
      if (during !== before) fail(`${tag}: the tab bar moved from ${before} to ${during} px when the page scrolled`);
      await shoot(long, `${tag}-06-tab-bar-stays-after-scroll`);
      // A section a link names lands below both bars.
      await long.evaluate(() => { window.scrollTo(0, 0); window.location.hash = '#section-18'; });
      await long.waitForFunction(() => window.scrollY > 300, { timeout: 10_000 });
      await new Promise((rest) => setTimeout(rest, 400));
      const below = await long.evaluate(() => { const bars = document.querySelector('[data-testid=shell-fixed]')!.getBoundingClientRect().bottom; const target = [...document.querySelectorAll('h2')].find((heading) => heading.textContent === 'Section 18')!.getBoundingClientRect().top; return { bars, target }; });
      if (below.target < below.bars - 1) fail(`${tag}: the section lands under the bars: ${JSON.stringify(below)}`);
      await shoot(long, `${tag}-07-anchor-below-the-bars`);
      await long.close();
    }
  }
} finally {
  child.kill('SIGTERM');
  await child.exited;
  await browser.close();
}
console.log(written.join('\n'));
