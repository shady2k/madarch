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
 * demo wiki/demo/docs/vision.md) at the owner's 1000x700 light and dark size,
 * 1440x900 dark and light, 1150x900, 1110x900 and 390x844 light, plus tall
 * 1440x1400 windows. Ours-only shots include the phone drawer, language menu,
 * and scrolled home; the mockup has no counterparts. Headless chrome at the
 * machine's path (CHROME names another) drives every window through
 * puppeteer-core; this script writes nothing in the repository.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

/** The repositories' screens: the declared ones with a checkout built, the pristine manifest's declared-not-checked-out state. */
const REPOS_SCREENS = [
  { name: 'repositories', address: '/r' },
  { name: 'repositories-declared', address: '/r' },
] as const;

/**
 * Builds the demo product's own checkout fixture under wiki/demo/repos/ with
 * the machine's git in a sealed environment: one real repository, one
 * commit, a README with the elements the section renders. Writes only inside
 * the gitignored repos/ folder, and never inside anyone else's repository.
 */
function buildDemoCheckout(product: string): string {
  const target = join(product, 'repos', 'fieldnote-core');
  mkdirSync(join(target, 'src'), { recursive: true });
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fieldnote Fixture',
    GIT_AUTHOR_EMAIL: 'fieldnote-fixture@example.com',
    GIT_COMMITTER_NAME: 'Fieldnote Fixture',
    GIT_COMMITTER_EMAIL: 'fieldnote-fixture@example.com',
  };
  const run = (args: string[]): string => {
    const done = spawnSync('git', args, { cwd: target, encoding: 'utf8', env });
    if (done.status !== 0) throw new Error(`git ${args.join(' ')} failed at the demo checkout: ${done.stderr}${done.stdout}`);
    return done.stdout;
  };
  // A checkout a previous run built stands as it is: already a repository
  // with the seeded commit, so rebuilding would commit nothing.
  if (existsSync(join(target, '.git'))) return target;
  run(['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(target, 'README.md'), '# fieldnote-core\n\nThe demo product\'s core library, a checkout the wiki reads as it stands.\n\n## What lives here\n\n- the notes store and its formats\n- the reader\'s own sync, none for now\n');
  writeFileSync(join(target, 'src', 'store.ts'), 'export const store = 1;\n');
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'Seed the demo checkout: the store and its README']);
  return target;
}

/** One window size, as the acceptance names them. */
const SIZES: Record<string, { width: number; height: number; scheme: 'dark' | 'light' }> = {
  '1000': { width: 1000, height: 700, scheme: 'dark' },
  '1000-light': { width: 1000, height: 700, scheme: 'light' },
  '1440' : { width: 1440, height: 900, scheme: 'dark' },
  '1440-light': { width: 1440, height: 900, scheme: 'light' },
  '1150': { width: 1150, height: 900, scheme: 'light' },
  '1110': { width: 1110, height: 900, scheme: 'light' },
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
const uiLanguage = argument('language', 'en');
if (uiLanguage !== 'en' && uiLanguage !== 'ru') {
  console.error(`unknown UI language ${JSON.stringify(uiLanguage)}: choose en or ru`);
  process.exit(2);
}
const mockupIndex = mockupFolder === '' ? undefined : join(mockupFolder, 'index.html');
if (mockupIndex !== undefined && !existsSync(mockupIndex)) {
  console.error(`no mockup at ${mockupIndex}: give --mockup <the dist folder of the mockup>, or run without it for our shots only`);
  process.exit(2);
}
mkdirSync(outFolder, { recursive: true });

type Shot = { file: string; width: number; height: number };
type Pair = { name: string; ours?: Shot; mockup?: Shot };

let server: StartedServer | undefined;
let reposServer: StartedServer | undefined;
try {
  server = startServer({ productFolder: join(repo, 'wiki', 'demo'), port: 0 });
  const ours = server.url;
  // The repositories' own server: the demo product with its declared
  // checkout built under repos/, checked out, so the section shows the
  // checked-out state and the rendered README beside the row that stays
  // declared only.
  buildDemoCheckout(join(repo, 'wiki', 'demo'));
  reposServer = startServer({ productFolder: join(repo, 'wiki', 'demo'), port: 0 });
  const reposOurs = reposServer.url;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  try {
    const selectUiLanguage = async (page: import('puppeteer-core').Page): Promise<void> => {
      await page.evaluate((language: string) => {
        window.localStorage.setItem('madarch-wiki-language', language);
      }, uiLanguage);
      await page.reload({ waitUntil: 'load', timeout: 30_000 });
      await page.waitForSelector('main', { timeout: 20_000 });
    };
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
      if (sink.endsWith('-ours')) await selectUiLanguage(page);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await new Promise((step) => setTimeout(step, 400));
      if (sink === 'document-ours' && [1000, 1150, 1440].includes(width)) {
        const textWidth = await page.$eval('.shell-document > main', (node) => node.getBoundingClientRect().width);
        console.log(`[measure] ${uiLanguage} ${width}x${height} ${scheme}: ${textWidth.toFixed(1)} px text width`);
      }
      const file = join(outFolder, `${sink}-${size}.png`);
      await page.screenshot({ path: file });
      await page.close();
      return { file, width, height };
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
    // The repositories' pairs: the checked-out state with its rendered README
  // from the server whose demo holds the checkout, and the
  // declared-not-checked-out state from the pristine server, both themes at
  // 1000 and 1440.
  for (const size of ['1000', '1000-light', '1440', '1440-light']) {
    pairs.push({
      name: `repositories-${size}`,
      ours: await shotOf(reposOurs + '/r', size, 'repositories-ours'),
      mockup: mockupIndex === undefined ? undefined : await shotOf('file://' + mockupIndex, size, 'repositories-mockup'),
    });
    pairs.push({
      name: `repositories-declared-${size}`,
      ours: await shotOf(ours + '/r', size, 'repositories-declared-ours'),
      mockup: mockupIndex === undefined ? undefined : await shotOf('file://' + mockupIndex, size, 'repositories-declared-mockup'),
    });
  }

  // The phone menu: the navigation drawer opened over the 390 screen.
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.goto(ours + '/', { waitUntil: 'load', timeout: 30_000 });
      await page.waitForSelector('.shell-menu', { timeout: 15_000 });
      await selectUiLanguage(page);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await page.click('.shell-menu');
      await new Promise((step) => setTimeout(step, 600));
      const file = join(outFolder, 'home-ours-390-menu-open.png');
      await page.screenshot({ path: file });
      pairs.push({ name: 'home-phone-menu-390-light', ours: { file, width: 390, height: 844 } });
      await page.close();
    } catch (error) {
      console.log('the phone menu shot failed: ' + (error as Error).message);
    }

    // The language menu is an ours-only state: the mockup has no language picker.
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1110, height: 900, deviceScaleFactor: 1 });
      await page.goto(ours + '/', { waitUntil: 'load', timeout: 30_000 });
      await page.waitForSelector('main', { timeout: 20_000 });
      await selectUiLanguage(page);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
      await page.click('.shell-language');
      await page.waitForSelector('[role="menuitemradio"]', { timeout: 10_000 });
      const choices = await page.$$('[role="menuitemradio"]');
      const labels = await Promise.all(choices.map((choice) => choice.evaluate((item) => item.textContent ?? '')));
      const russianLabel = uiLanguage === 'ru' ? 'Русский' : 'Russian';
      const selectedLabel = uiLanguage === 'ru' ? 'Русский' : 'English';
      if (!labels[0]?.includes(russianLabel) || !labels[1]?.includes('English')) {
        throw new Error(uiLanguage + '-language menu has unexpected choices: ' + labels.join(' / '));
      }
      const checked = await page.$eval('[role="menuitemradio"][aria-checked="true"]', (item) => item.textContent ?? '');
      if (!checked.includes(selectedLabel)) throw new Error(uiLanguage + ' menu choice is not marked checked: ' + checked);
      const otherChoice = uiLanguage === 'ru' ? 1 : 0;
      await choices[otherChoice]?.click();
      const otherLanguage = uiLanguage === 'ru' ? 'en' : 'ru';
      await page.waitForFunction((language) => document.documentElement.lang === language, { timeout: 10_000 }, otherLanguage);
      await page.click('.shell-language');
      await page.waitForSelector('[role="menuitemradio"]', { timeout: 10_000 });
      const resetChoices = await page.$$('[role="menuitemradio"]');
      await resetChoices[uiLanguage === 'ru' ? 0 : 1]?.click();
      await page.waitForFunction((language) => document.documentElement.lang === language, { timeout: 10_000 }, uiLanguage);
      await page.click('.shell-language');
      await page.waitForSelector('[role="menuitemradio"]', { timeout: 10_000 });
      await new Promise((step) => setTimeout(step, 200));
      const file = join(outFolder, 'home-ours-language-menu-1110.png');
      await page.screenshot({ path: file });
      await page.close();
      pairs.push({ name: 'home-language-menu-1110-light', ours: { file, width: 1110, height: 900 } });
    }

    // The scrolled home page: the only scrolling column at its bottom.
    {
      const { width, height, scheme } = SIZES['1440']!;
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.goto(ours + '/', { waitUntil: 'load', timeout: 30_000 });
      await page.waitForSelector('main', { timeout: 20_000 });
      await selectUiLanguage(page);
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
      await page.waitForSelector('main', { timeout: 15_000 });
      await page.evaluate(() => document.querySelector('.shell-scroll')?.scrollTo({ top: 1e6 }));
      await new Promise((step) => setTimeout(step, 300));
      const file = join(outFolder, 'home-ours-scrolled-1440.png');
      await page.screenshot({ path: file });
      await page.close();
      pairs.push({ name: 'home-scrolled-1440-dark', ours: { file, width, height } });
    }

    // One image per pair. Embed checked PNGs as data URLs: a data document
    // cannot reliably load file:// images, which used to produce blank grey halves.
    const composed: string[] = [];
    const pngSize = (buffer: Buffer): { width: number; height: number } => {
      if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG' || buffer.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error('not a PNG with an IHDR');
      }
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    };
    const embedded = (shot: Shot, label: string): string => {
      if (!existsSync(shot.file)) throw new Error(`cannot compose ${label}: missing half ${shot.file}`);
      const bytes = readFileSync(shot.file);
      const size = pngSize(bytes);
      console.log(`compose ${label}: ${shot.file} ${size.width}x${size.height}`);
      if (size.width !== shot.width || size.height !== shot.height) {
        throw new Error(`cannot compose ${label}: ${shot.file} is ${size.width}x${size.height}, expected ${shot.width}x${shot.height}`);
      }
      const uri = `data:image/png;base64,${bytes.toString('base64')}`;
      return `<div style="position:relative;flex:none;width:${size.width}px;height:${size.height}px"><img src="${uri}" width="${size.width}" height="${size.height}" style="display:block;width:${size.width}px;height:${size.height}px"><span style="position:absolute;top:6px;left:8px;font:16px system-ui;color:#fff;background:#0009;padding:2px 8px;border-radius:4px">${label}</span></div>`;
    };
    for (const pair of pairs) {
      const { ours: left, mockup: right, name } = pair;
      if (left === undefined && right === undefined) continue;
      if (left === undefined || (mockupIndex !== undefined && right === undefined && !name.startsWith('home-phone-menu-') && !name.startsWith('home-scrolled-') && !name.startsWith('home-language-menu-'))) {
        throw new Error(`cannot compose ${name}: a required screenshot half is missing`);
      }
      const halves: string[] = [];
      if (left !== undefined) halves.push(embedded(left, 'OURS'));
      if (right !== undefined) halves.push(embedded(right, 'MOCKUP'));
      const totalWidth = (left?.width ?? 0) + (right?.width ?? 0) + (halves.length - 1) * 8;
      const height = Math.max(left?.height ?? 0, right?.height ?? 0);
      const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#333;width:${totalWidth}px;height:${height}px;display:flex;gap:8px;overflow:hidden">${halves.join('')}</body></html>`;
      const page2 = await browser.newPage();
      await page2.setViewport({ width: totalWidth, height, deviceScaleFactor: 1 });
      await page2.setContent(html, { waitUntil: 'load' });
      const target = join(outFolder, `${name}-sbs.png`);
      await page2.screenshot({ path: target, fullPage: true });
      await page2.close();
      composed.push(target);
      console.log(`${right === undefined ? '(ours only; the mockup has no such shot) ' : '(pair) '}${target}`);
    }
    await browser.close();
    console.log(outFolder);
  } finally {
    await browser.close();
  }
} finally {
  server?.stop();
  reposServer?.stop();
}
