/**
 * relations:shots — the acceptance walk of the relations block (madarch-j9ao.3.1): a filled product over the generated
 * training repository, and the commit, file and term pages that carry the block. Every renderer (LikeC4, Mermaid,
 * archify) is opened at 1150 px in headless Chromium, measured (smallest rendered label px, overlaps) and photographed;
 * the visible text and every measured label box are written beside the picture, because a shot nobody can read is no
 * evidence.
 *
 * Usage: bun scripts/relations-shots.ts [--out <folder>] [--work <folder>] [--port <n>]
 * Run through madarch-sandbox as an unprivileged account: the fill runs the glossary plugin in a cgroup.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { DIAGRAM_MEASURES } from './diagram-measures.js';
import { generateTrainingRepository, makeProduct, writeSamplePages } from '../test/knowledge-fixture.js';

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}
const out = resolve(argument('out', 'shots/relations'));
const work = resolve(argument('work', '/tmp/madarch-relations-shots'));
const port = Number(argument('port', '4295'));
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

const repository = generateTrainingRepository(join(work, 'repo'));
const home = join(work, 'home');
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));
const madarchHome = join(work, 'madarch-home');
mkdirSync(madarchHome, { recursive: true });
writeFileSync(join(madarchHome, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));
const shop = makeProduct(home, 'shop', repository);
writeSamplePages(shop);

// PostgreSQL refuses root, so the server is a process of the unprivileged account when this walk runs as root; the
// browser stays in this process (headless Chromium runs as root with --no-sandbox).
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
if (asRoot) execFileSync('chown', ['-R', '1000:1000', work]);
const serverCommand = asRoot
  ? ['/usr/local/bin/madarch-sandbox', 'env', 'HOME=/home/debian.guest', `MADARCH_HOME=${madarchHome}`, 'PATH=/usr/local/bin:/usr/bin:/bin', 'bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', home, '--port', String(port)]
  : ['bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', home, '--port', String(port)];
const child = Bun.spawn(serverCommand, {
  env: {
    ...process.env,
    ...(asRoot ? { HOME: '/home/debian.guest', MADARCH_SANDBOX_UID: '1000', MADARCH_SANDBOX_GID: '1000', PATH: '/usr/local/bin:/usr/bin:/bin' } : {}),
    MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist'),
    MADARCH_HOME: madarchHome,
  },
  stdout: 'ignore',
  stderr: 'inherit',
});
const base = `http://127.0.0.1:${port}`;
const stop = async (): Promise<void> => { child.kill('SIGTERM'); await child.exited; };
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
const failures: string[] = [];
const summary: Record<string, unknown>[] = [];

async function untilServer(): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    try { if ((await fetch(`${base}/`)).ok) return; } catch { /* not listening yet */ }
    if (tries > 240) throw new Error(`the server did not answer on ${base}`);
    await Bun.sleep(500);
  }
}

type PagePlan = { name: string; id: string };
/** A terminal .md is a format suffix in the app's address, so its dot is encoded (routes.ts addressName). */
const entityAddressOf = (id: string): string => `/e/${encodeURIComponent(id).replace(/\.md$/u, '%2Emd')}`;
const pages: PagePlan[] = [];

try {
  await untilServer();
  const started = await fetch(`${base}/products/shop/api/fill`, { method: 'POST' });
  if (!started.ok) throw new Error(`the fill did not start: ${started.status} ${await started.text()}`);
  for (const until = Date.now() + 900_000; ; ) {
    const status = (await (await fetch(`${base}/products/shop/api/status`)).json()) as { fill: { state: string; message?: string } };
    if (status.fill.state === 'done') break;
    if (status.fill.state === 'failed') throw new Error(`the fill failed: ${status.fill.message}`);
    if (Date.now() > until) throw new Error('the fill did not finish in 15 minutes');
    await Bun.sleep(500);
  }

  const entities = async (kind: string): Promise<{ id: string }[]> => {
    const response = await fetch(`${base}/products/shop/api/entities?${new URLSearchParams({ kind, limit: '500' })}`);
    if (!response.ok) throw new Error(`the ${kind} listing answered ${response.status}`);
    return ((await response.json()) as { rows: { id: string }[] }).rows;
  };
  const files = await entities('code.file');
  const commits = await entities('code.commit');
  const terms = await entities('doc.term');
  const glossary = files.find((file) => file.id.endsWith('/docs/glossary.md'));
  if (glossary === undefined) throw new Error(`no docs/glossary.md in ${files.map((file) => file.id).join(', ').slice(0, 800)}`);
  const hash = execFileSync('git', ['log', '-1', '--format=%H', '--', 'docs/glossary.md'], { cwd: repository, encoding: 'utf8' }).trim();
  const commit = commits.find((one) => one.id === `code.commit:${hash}`) ?? commits.find((one) => one.id.includes(hash));
  if (commit === undefined) throw new Error(`the glossary commit ${hash} is not a page: ${commits.map((one) => one.id).slice(0, 20).join(', ')}`);
  if (terms.length === 0) throw new Error('the fill published no doc.term page');
  const term = terms.find((one) => one.id === 'doc.term:Order') ?? terms[0]!;
  pages.push({ name: 'commit', id: commit.id }, { name: 'file', id: glossary.id }, { name: 'term', id: term.id });

  browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, protocolTimeout: 900_000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.log('PAGEERROR', error.message.slice(0, 800)));
  page.on('console', (message) => { if (message.type() === 'error') console.log('CONSOLE', message.text().slice(0, 800)); });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('madarch-wiki-language', 'en'); } catch { /* no storage */ } });
  await page.setViewport({ width: 1150, height: 900 });

  const blockAt = async (): Promise<number> => await page.evaluate(() => [...document.querySelectorAll('[data-diagram=views]')].indexOf(document.querySelector('[data-block=relations] [data-diagram=views]') as Element));
  const clickRenderer = async (renderer: string): Promise<void> => {
    await page.evaluate((name) => {
      const button = document.querySelector(`[data-block=relations] [data-testid=renderer-${name}]`);
      if (button instanceof HTMLElement) button.click();
    }, renderer);
  };
  const settle = async (renderer: string): Promise<void> => {
    await page.waitForFunction((name) => {
      const block = document.querySelector('[data-block=relations]');
      if (!block) return false;
      if (name === 'mermaid') return Boolean(block.querySelector('[data-testid=view-picture] svg'));
      if (name === 'likec4') {
        const frame = block.querySelector('[data-testid=view-frame-likec4]');
        if (!frame) return false;
        const deep = (root: Element): boolean => Boolean(root.querySelector('.react-flow__node, [data-node-id]')) || [...root.querySelectorAll('*')].some((node) => node.shadowRoot !== null && deep(node.shadowRoot as unknown as Element));
        return deep(frame);
      }
      const frame = block.querySelector('iframe[data-renderer=archify]') as HTMLIFrameElement | null;
      try { const doc = frame?.contentDocument; return Boolean(doc?.querySelector('svg') || doc?.querySelector('[data-frame-error]')); } catch { return false; }
    }, { timeout: 90_000 }, renderer);
    await Bun.sleep(1_200);
  };
  const measure = async (renderer: string): Promise<Record<string, unknown>> => {
    const at = await blockAt();
    const options = JSON.stringify({ blockAt: at, renderer });
    if (renderer !== 'archify') return await page.evaluate(`(${DIAGRAM_MEASURES})(${options})`) as Record<string, unknown>;
    const handles = await page.$$('[data-diagram=views]');
    const handle = await handles[at]?.$('iframe[data-renderer=archify]');
    const frame = await handle?.contentFrame();
    if (frame === null || frame === undefined) throw new Error('the archify iframe has no document');
    await frame.waitForSelector('.diagram-container svg', { timeout: 30_000 });
    const parentViewport = await handle!.evaluate((node) => {
      const r = node.getBoundingClientRect();
      let left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
      for (let cursor = node.parentElement; cursor !== null; cursor = cursor.parentElement) {
        const style = getComputedStyle(cursor), box = cursor.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
      const element = node as HTMLIFrameElement;
      const sx = r.width / element.offsetWidth, sy = r.height / element.offsetHeight;
      const x = r.left + element.clientLeft * sx, y = r.top + element.clientTop * sy;
      return { left: (left - x) / sx, top: (top - y) / sy, right: (right - x) / sx, bottom: (bottom - y) / sy };
    });
    return await frame.evaluate(`(${DIAGRAM_MEASURES})(${JSON.stringify({ blockAt: at, renderer, parentViewport })})`) as Record<string, unknown>;
  };
  const visible = async (): Promise<Record<string, unknown>> => await page.evaluate(() => {
    const block = document.querySelector('[data-block=relations]');
    const view = block?.querySelector('[data-testid=view]');
    const labels = [...(block?.querySelectorAll('svg text') ?? [])].map((node) => {
      const rect = node.getBoundingClientRect();
      return { text: (node.textContent ?? '').trim(), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), px: parseFloat(getComputedStyle(node).fontSize) };
    }).filter((label) => label.text !== '');
    return { renderer: view?.getAttribute('data-renderer') ?? null, text: (block?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000), labels };
  });

  for (const plan of pages) {
    await page.goto(`${base}/products/shop${entityAddressOf(plan.id)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-block=relations]', { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-diagram=deferred]').length === 0, { timeout: 90_000 });
    await Bun.sleep(800);
    await page.evaluate(() => document.querySelector('[data-block=relations]')?.scrollIntoView({ block: 'center' }));
    await Bun.sleep(500);
    for (const renderer of ['likec4', 'mermaid', 'archify']) {
      const key = `${plan.name}-${renderer}`;
      try {
        await clickRenderer(renderer);
        await settle(renderer);
        if (renderer === 'archify') { const frame = await (await page.$('[data-block=relations] iframe[data-renderer=archify]'))?.contentFrame(); const failed = frame ? await frame.evaluate(() => document.querySelector('[data-frame-error]')?.textContent ?? null).catch(() => null) : null; if (failed !== null && failed !== undefined) throw new Error(`archify answered: ${failed}`); }
        const measured = await measure(renderer);
        const body = await visible();
        const block = await page.$('[data-block=relations]');
        await block?.screenshot({ path: join(out, `${key}.png`) });
        await page.screenshot({ path: join(out, `${key}-page.png`), fullPage: true });
        const record = { page: plan.id, renderer, ...measured, visible: body };
        writeFileSync(join(out, `${key}.json`), `${JSON.stringify(record, null, 2)}\n`);
        summary.push({ key, smallestTitlePx: measured['smallestTitlePx'], minFontPx: measured['minFontPx'], overlaps: measured['overlapCount'], texts: measured['texts'], scale: measured['scale'], wholeFit: measured['wholeFit'] });
        const floor = Number(measured['smallestTitlePx']);
        if (!(floor >= 12)) failures.push(`${key}: smallest node title ${String(measured['smallestTitlePx'])} px < 12 px`);
        if (Number(measured['overlapCount']) !== 0) failures.push(`${key}: ${String(measured['overlapCount'])} label overlaps: ${JSON.stringify(measured['overlaps'])}`);
        if (Number(measured['texts']) === 0) failures.push(`${key}: the diagram drew no text`);
      } catch (error) {
        failures.push(`${key}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await browser?.close().catch(() => undefined);
  await stop().catch(() => undefined);
}

writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ pages: pages.map((page) => page.id), summary, failures }, null, 2)}\n`);
console.log(JSON.stringify({ summary, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
