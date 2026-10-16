/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from '../scripts/chromium.js';
import { startServer, type StartedServer } from '../src/index.js';
import { gitEnv } from './git-env.js';

const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, 'wiki', 'app', 'dist');
const enabled = process.env.MADARCH_WIKI_E2E === '1';
const runDescribe = enabled ? describe.serial : describe.skip;
if (!enabled) console.info('Wiki discussion E2E skipped: set MADARCH_WIKI_E2E=1 after building wiki/app.');

runDescribe('first comment on a served product wiki', () => {
  let scratch: string;
  let product: string;
  let remote: string;
  let server: StartedServer;
  let browser: Browser;
  let page: Page;
  const env = gitEnv({ GIT_AUTHOR_NAME: 'Discussion Fixture', GIT_AUTHOR_EMAIL: 'discussion@example.test', GIT_COMMITTER_NAME: 'Discussion Fixture', GIT_COMMITTER_EMAIL: 'discussion@example.test' });
  const git = (cwd: string, args: string[]): string => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}${result.stdout}`);
    return result.stdout.trim();
  };
  beforeAll(async () => {
    if (!existsSync(join(APP, 'index.html'))) throw new Error(`Built wiki app is missing: ${join(APP, 'index.html')}`);
    scratch = mkdtempSync(join(tmpdir(), 'madarch-discussion-e2e-'));
    product = join(scratch, 'Fieldnote'); remote = join(scratch, 'remote.git');
    mkdirSync(join(product, 'docs'), { recursive: true });
    writeFileSync(join(product, 'workspace.yaml'), 'schemaVersion: 1\nid: fixture\nname: Fieldnote\n');
    writeFileSync(join(product, 'docs', 'vision.md'), '# Reader vision\n\nA page with one clear heading.\n');
    git(product, ['init', '--quiet', '--initial-branch=main']);
    git(product, ['config', 'user.name', 'Discussion Fixture']);
    git(product, ['config', 'user.email', 'discussion@example.test']);
    git(product, ['add', '--', 'workspace.yaml', 'docs/vision.md']);
    git(product, ['commit', '--quiet', '-m', 'fixture']);
    git(scratch, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    git(product, ['remote', 'add', 'origin', remote]);
    git(product, ['push', '--quiet', '-u', 'origin', 'HEAD']);
    server = await startServer({ productFolder: product, appFolder: APP, port: 0, host: '127.0.0.1', log: () => {}, errorLog: (line) => console.error(line) });
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 30000);
  afterAll(async () => { await browser?.close(); await server?.stop(); if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true }); });

  test('selects, saves, pushes, reloads and displays the anchored comment', async () => {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${server.url}/p/docs/vision.md`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.reading p');
    await page.evaluate(() => {
      const paragraph = document.querySelector('.reading p')!;
      const text = paragraph.firstChild!;
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.textContent!.length);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.waitForSelector('[data-testid="discussion-composer"]');
    await page.type('[data-testid="discussion-body"]', 'A useful first comment.');
    await page.click('[data-testid="discussion-save"]');
    await page.waitForSelector('[data-testid="discussion-margin"] .discussion-card');
    const pushed = git(remote, ['rev-parse', 'refs/heads/main']);
    expect(pushed).toBe(git(product, ['rev-parse', 'HEAD']));
    expect(git(product, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="discussion-margin"] .discussion-card');
    expect(await page.$eval('[data-testid="discussion-margin"]', (node) => node.textContent)).toContain('A useful first comment.');
    expect(await page.evaluate(() => CSS.highlights.has('discussion-anchor'))).toBe(true);
    expect(await page.$eval('.reading', (node) => node.textContent)).toContain('A page with one clear heading.');
    await page.close();
  }, 30000);

  test('page-level comments persist and discussion cards use the narrow-screen panel', async () => {
    page = await browser.newPage(); await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${server.url}/p/docs/vision.md`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=discussion-page-comment]');
    await page.click('[data-testid=discussion-page-comment]');
    await page.type('[data-testid=discussion-body]', 'A page-level note.');
    await page.$eval('[data-testid=discussion-save]', (node) => { (node as HTMLButtonElement).click(); });
    await page.waitForFunction(() => document.querySelector('[data-testid=discussion-composer]') === null, { timeout: 15000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-thread]')].some((node) => node.textContent?.includes('A page-level note.')), { timeout: 15000 });
    const pageThread = await page.$eval('[data-thread]', (node) => node.getAttribute('data-thread'));
    expect(pageThread).toBeTruthy();
    const actions = await page.evaluate(async (thread) => {
      const reply = await fetch('/api/discussions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: 'docs/vision.md', action: 'reply', thread, body: 'A browser reply.' }) });
      const resolve = await fetch('/api/discussions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: 'docs/vision.md', action: 'resolve', thread }) });
      return [reply.status, resolve.status];
    }, pageThread);
    expect(actions).toEqual([201, 201]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=discussion-toggle-resolved]');
    expect(await page.$(`[data-thread="${pageThread}"]`)).toBeNull();
    await page.click('[data-testid=discussion-toggle-resolved]');
    await page.waitForSelector(`[data-thread="${pageThread}"]`);
    const anchor = await page.$eval(`[data-thread="${pageThread}"]`, (node) => node.getAttribute('data-anchor-lost'));
    expect(anchor).toBe('false');
    await page.setViewport({ width: 390, height: 844 });
    expect(await page.$eval('[data-testid=discussion-margin]', (node) => getComputedStyle(node).position)).toBe('fixed');
    await page.close();
  }, 30000);
});
