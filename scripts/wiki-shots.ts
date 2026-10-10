/**
 * wiki:shots — the side-by-side renderer for the mockup-fidelity acceptance:
 * for every screen of the wiki it renders OUR wiki (the built app in
 * wiki/app, serving the committed demo product wiki/demo) and, when a
 * --mockup dist folder is given, the mockup at the same width and colour
 * scheme, then puts the two shots of a pair into ONE image on a scratch
 * folder OUTSIDE the repository (default /tmp/madarch-wiki-shots, named with
 * --out) and prints the folder.
 *
 * The pairs cover the home and a document page carrying every element (the
 * demo wiki/demo/docs/vision.md) at 1440x900 dark and light, 1150x900 and
 * 390x844 light, and a tall 1440x1400 dark window; our run adds the home
 * page scrolled — the two shots the mockup does not hold render ours alone
 * and stay unpaired, named so in the output. Headless chrome at the
 * machine's path (CHROME names another) drives every window through
 * puppeteer-core; this script writes nothing in the repository.
 */
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startServer, type StartedServer } from '../src/index.js';

const here = new URL('.', import.meta.url).pathname;
const repo = resolvePath(here, '..');
const CHROME = process.env.CHROME ?? '/nix/store/6bg6ciwh50x38sca5x9zimdzqijkc8sq-playwright-chromium/chrome-linux64/chrome';

/** One screen of the wiki: the address on our server and the pair's name. */
const SCREENS = [
  { name: 'document', address: '/p/docs/vision.md' },
  { name: 'home', address: '/' },
] as const;

/** One window size, as the acceptance names them. */
const SIZES: Record<string, { width: number; height: number; scheme: 'dark' | 'light' }> = {
  '1440' : { width: 1440, height: 900, scheme: 'dark' },
  '1440-light': { width: 1440, height: 900, scheme: 'light' },
  '1150': { width: 1150, height: 900, scheme: 'light' },
  '390': { width: 390, height: 844, scheme: 'light' },
  'tall': { width: 1440, height: 1400, scheme: 'dark' },
  'tall-light' : { width: 1440, height: 1400, scheme: 'light' },
};

function argument(name: string, defaultValue: string): string {
  const at = process.argv.indexOf('--' + name);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1]! : defaultValue;
}

const outFolder = resolvePath(argument('out', '/tmp/madarch-wiki-shots'));
const mockupFolder = argument('mockup', '');
const mockupIndex = mockupFolder === '' ? undefined : join(mockupFolder, 'index.html');
if (mockupIndex !== undefined && !existsSync(mockupIndex)) {
  console.error(`no mockup at ${mockupIndex}: give --mockup <the dist folder of the mockup>, or run without it for our shots only`);
  process.exit(2);
}
mkdirSync(outFolder, { recursive: true });

type Shot = { file: string; width: number; height: number };
type Pair = { name: string; ours?: Shot; mockup?: Shot };

let server: StartedServer | undefined;
try {
  server = startServer({ productFolder: join(repo, 'wiki', 'demo'), port: 0 });
  const ours = server.url;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  try {
    const shotOf = async (address: string, size: string, sink: string): Promise<Shot | undefined> => {
      // A page per shot: every navigation closes its stream, and a page
      // that keeps nothing open keeps the shots deterministic.
      const page = await browser.newPage();
      const { width, height, scheme } = SIZES[size]!;
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      // `load` only: the wiki keeps one SSE stream open, so the network
      // never goes idle. The colour scheme is emulated after the load —
      // before it, this puppeteer build races the DevTools session — and
      // the settle lets the app ask its API and print.
      await page.goto(address, { waitUntil: 'load', timeout: 30_000 });
      const ready = await page.waitForSelector('main', { timeout: 20_000 });
      if (ready === null) throw new Error(`no document renders at ${address}`);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await new Promise((step) => setTimeout(step, 400));
      const file = join(outFolder, `${sink}-${size}.png`);
      await page.screenshot({ path: file });
      await page.close();
      return { file, width: width * 2, height: height * 2 };
    };

    const pairs: Pair[] = [];
    for (const size of Object.keys(SIZES)) {
      for (const screen of SCREENS) {
        const name = `${screen.name}-${size}`;
        pairs.push({
          name,
          ours: await shotOf(ours + screen.address, size, `${screen.name}-ours`),
          mockup: mockupIndex === undefined ? undefined : await shotOf('file://' + mockupIndex, size, `${screen.name}-mockup`),
        });
      }
    }
    // The phone menu: the navigation drawer opened over the 390 screen.
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.goto(ours + '/', { waitUntil: 'load', timeout: 30_000 });
      await page.waitForSelector('.shell-menu', { timeout: 15_000 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await page.click('.shell-menu');
      await new Promise((step) => setTimeout(step, 600));
      const file = join(outFolder, 'home-ours-390-menu-open.png');
      await page.screenshot({ path: file });
      pairs.push({ name: 'home-phone-menu-390-light', ours: { file, width: 780, height: 1688 } });
      await page.close();
    } catch (error) {
      console.log('the phone menu shot failed: ' + (error as Error).message);
    }

    // The scrolled home page: the only scrolling column at its bottom.
    {
      const { width, height, scheme } = SIZES['1440']!;
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.goto(ours + '/', { waitUntil: 'load', timeout: 30_000 });
      await page.waitForSelector('main', { timeout: 20_000 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.waitForSelector('main', { timeout: 15_000 });
      await page.evaluate(() => document.querySelector('.shell-scroll')?.scrollTo({ top: 1e6 }));
      await new Promise((step) => setTimeout(step, 300));
      const file = join(outFolder, 'home-ours-scrolled-1440.png');
      await page.screenshot({ path: file });
      await page.close();
      pairs.push({ name: 'home-scrolled-1440-dark', ours: { file, width: width * 2, height: height * 2 } });
    }

    // One image per pair: the two shots side by side on one ground, labels
    // naming which is which, a thin divider keeping the halves apart.
    const composed: string[] = [];
    for (const pair of pairs) {
      const { ours: l, mockup: r, name } = pair;
      if (l === undefined && r === undefined) continue;
      const span = (shot: Shot, label: string): string =>
        `<div style="position:relative"><img src="file://${shot.file}" style="display:block"><span style="position:absolute;top:6px;left:8px;font:16px system-ui;color:#fff;background:#0008;padding:2px 8px;border-radius:4px">${label}</span></div>`;
      const halves: string[] = [];
      if (l !== undefined) halves.push(span(l, 'OURS'));
      if (r !== undefined) halves.push(span(r, 'MOCKUP'));
      const totalWidth = (l?.width ?? 0) + (r?.width ?? 0) + 8;
      const height = Math.max(l?.height ?? r?.height ?? 0);
      const html = `<!doctype html><body style="margin:0;background:#333;height:${height}px;width:${totalWidth}px;display:flex;gap:8px">${halves.join('')}</body>`;
      const page2 = await browser.newPage();
      await page2.setViewport({ width: totalWidth, height, deviceScaleFactor: 1 });
      await page2.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html), { waitUntil: 'networkidle0' });
      await new Promise((step) => setTimeout(step, 200));
      const target = join(outFolder, `${name}-sbs.png`);
      await page2.screenshot({ path: target, fullPage: true });
      await page2.close();
      composed.push(target);
      console.log(`${r === undefined ? '(ours only; the mockup has no such shot) ' : '(pair) ' }${target}`);
    }
    await browser.close();
    console.log(outFolder);
  } finally {
    await browser.close();
  }
} finally {
  server?.stop();
}
