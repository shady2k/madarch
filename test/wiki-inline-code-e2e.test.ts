/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { makeProduct } from './knowledge-fixture.js';

/**
 * Reader acceptance for inline code inside a link (madarch-u3vw.13): a page with a linked hash draws one deliberate
 * mark — the chip's own continuous underline with no stray dashes under its padding — while a plain link keeps its
 * border and unlinked inline code keeps its chip, at 1150 and 390 px in both themes. Run with MADARCH_WIKI_E2E=1
 * after building wiki/app.
 */
const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('Wiki inline-code E2E tests skipped: set MADARCH_WIKI_E2E=1 after building wiki/app to run them.');

/** The document the page shows: a linked hash, a mixed link, a plain link and unlinked code. */
const DOCUMENT = [
  '# Linked code',
  '',
  'The commit [`04bcf3317972`](/k/commit?hash=04bcf3317972) is shown as inline code inside a link.',
  '',
  'A [mixed `code` link](https://example.invalid/mixed) carries both, and a [plain link](https://example.invalid/plain) stands beside it.',
  '',
  'Unlinked `inline code` keeps its chip.',
  '',
].join('\n');

function buildProduct(root: string): string {
  const repository = join(root, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  writeFileSync(join(repository, 'README.md'), '# Shop\n');
  writeFileSync(join(repository, 'src', 'pay.ts'), 'export function pay(): number { return 1; }\n');
  const env = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  for (const args of [['init', '--quiet', '--initial-branch=main'], ['add', '-A'], ['commit', '--quiet', '-m', 'Fixture']]) {
    execFileSync('git', args, { cwd: repository, env });
  }
  const product = makeProduct(root, 'shop', repository, 'shop');
  mkdirSync(join(product, 'docs'), { recursive: true });
  writeFileSync(join(product, 'docs', 'linked-code.md'), DOCUMENT);
  return product;
}

runDescribe('inline code in links (built app and Chromium)', () => {
  let root: string | undefined;
  let previousHome: string | undefined;
  let server: StartedServer | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`Built wiki app is missing: ${join(APP, 'index.html')}`);
    root = mkdtempSync(join(tmpdir(), 'madarch-inline-code-e2e-'));
    const product = buildProduct(root);
    const madarchHome = join(root, 'madarch-home');
    mkdirSync(madarchHome, { recursive: true });
    writeFileSync(join(madarchHome, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));
    previousHome = process.env.MADARCH_HOME;
    process.env.MADARCH_HOME = madarchHome;
    server = await startServer({
      productFolder: product,
      appFolder: APP,
      port: 0,
      host: '127.0.0.1',
      knowledgeRoot: join(root, 'store'),
      log: () => undefined,
      errorLog: (line) => console.error(line),
    });
    const seeded = await fetch(`${server.url}/api/k/status`);
    if (seeded.status !== 200) throw new Error(`the status answer was ${seeded.status}`);
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] });
  }, 120_000);

  afterAll(async () => {
    if (previousHome !== undefined) process.env.MADARCH_HOME = previousHome;
    await browser?.close();
    await server?.stop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  async function open(width: number, height: number, scheme: 'light' | 'dark'): Promise<Page> {
    const page = await browser!.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.evaluateOnNewDocument(() => localStorage.setItem('madarch-wiki-language', 'ru'));
    await page.goto(`${server!.url}/k/doc?path=docs%2Flinked-code.md`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=document-page]', { timeout: 30_000 });
    return page;
  }

  for (const [width, height] of [[1150, 900], [390, 844]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`a linked hash draws one mark over its chip at ${width} px, ${scheme}`, async () => {
        const page = await open(width, height, scheme);
        try {
          const marks = await page.evaluate(() => {
            const style = (element: Element | null | undefined) => {
              if (element === null || element === undefined) return null;
              const computed = getComputedStyle(element);
              return {
                decoration: computed.textDecorationLine,
                decorationColor: computed.textDecorationColor,
                borderBottom: computed.borderBottomWidth,
                background: computed.backgroundColor,
              };
            };
            const links = [...document.querySelectorAll('main a')];
            const linked = links.find((link) => link.querySelector('code') !== null)!;
            const plain = links.find((link) => link.querySelector('code') === null && (link.textContent ?? '').includes('plain link'))!;
            const mixed = links.find((link) => (link.textContent ?? '').includes('mixed'))!;
            const unlinked = [...document.querySelectorAll('main code')].find((code) => code.closest('a') === null)!;
            return {
              linkedCode: style(linked.querySelector('code')),
              linked: style(linked),
              mixed: { link: style(mixed), code: style(mixed.querySelector('code')) },
              plain: style(plain),
              unlinked: style(unlinked),
            };
          });
          // The linked chip carries the mark itself, one continuous line over its ground; the link has no border
          // left to show a stray dash under the chip's padding.
          expect(marks.linkedCode).not.toBeNull();
          expect(marks.linkedCode!.decoration).toBe('underline');
          expect(marks.linkedCode!.borderBottom).toBe('0px');
          expect(marks.linked!.borderBottom).toBe('0px');
          expect(marks.linked!.decoration).toBe('underline');
          // A link that only contains the code is marked the same way, and its code too.
          expect(marks.mixed.link!.decoration).toBe('underline');
          expect(marks.mixed.link!.borderBottom).toBe('0px');
          expect(marks.mixed.code!.decoration).toBe('underline');
          // A plain link keeps its underline, and unlinked code keeps its chip and no line.
          expect(marks.plain!.decoration).toBe('none');
          expect(marks.plain!.borderBottom).toBe('1px');
          expect(marks.unlinked!.decoration).toBe('none');
          expect(marks.unlinked!.background).not.toBe('rgba(0, 0, 0, 0)');
          const expected = scheme === 'dark' ? 'rgb(136, 136, 136)' : 'rgb(161, 161, 161)';
          expect(marks.linkedCode!.decorationColor).toBe(expected);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }
});
