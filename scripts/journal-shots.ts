/**
 * journal:shots — the agent's journal rendered the way a reader sees it (madarch-m38l.13): a product page with its
 * «Как агент писал эту страницу» link, and the journal page itself, light and dark, at 1150 px and at 390 px.
 *
 * The product is the generated training repository filled through the wiki; the journal's records are written the way
 * a run writes them (`fileJournal`, `recordOf`), from a fixed sequence of calls an agent makes while it writes the
 * payment page: reads, a question merged into an earlier one, two refused pages, a refused file read, a refused
 * permission and a tool that does not exist, then the page written. The tests prove that a real run writes the same
 * records (`test/writer-journal.test.ts`); this walk judges how they look.
 *
 * Usage: bun scripts/journal-shots.ts [--lang ru|en] [--out <folder>] [--work <folder>] [--port <n>]
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { SAMPLE_IDENTITY, generateTrainingRepository, makeProduct, writeSamplePages } from '../test/knowledge-fixture.js';
import { gitEnv } from '../test/git-env.js';
import { execFileSync } from 'node:child_process';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { fileJournal, journalFolder, newRunId, type JournalEntry } from '../src/writer/journal.js';

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}
const lang = argument('lang', 'ru');
const out = resolve(argument('out', 'shots-journal'));
const work = resolve(argument('work', `/tmp/madarch-journal-shots-${lang}`));
rmSync(work, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const written: string[] = [];

const repository = generateTrainingRepository(join(work, 'repo'));
const madarchHome = join(work, 'madarch');
const shopHome = join(work, 'home-shop');
mkdirSync(shopHome, { recursive: true });
const shop = makeProduct(shopHome, 'shop', repository);
writeSamplePages(shop);
execFileSync('git', ['add', '.'], { cwd: shop, env: gitEnv(SAMPLE_IDENTITY) });
execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the sample pages'], { cwd: shop, env: gitEnv(SAMPLE_IDENTITY) });

// The journal of a run that wrote the payment page, where the server reads it: the product's machine-local store.
const storeRoot = join(shopHome, '.madarch', 'knowledge');
const identity = new KnowledgeProduct({ productFolder: shop, storeRoot }).product();
if ('message' in identity) throw new Error(identity.message);
const when = new Date('2026-10-23T12:31:00.000Z');
const run = newRunId(when);
const journal = fileJournal(journalFolder(join(storeRoot, identity.id)), run);
const context = { run, unit: 'domain:payment', agent: 'claude-code', model: 'claude-sonnet-5-5', session: 'sess-7f3a91' };
let clock = when.getTime();
const call = (tool: string, args: unknown, response: unknown, ms: number, extra: Partial<JournalEntry> = {}): void => {
  clock += 4_000 + ms;
  const text = typeof response === 'string' ? response : JSON.stringify(response);
  journal.record(context, { kind: 'tool-call', tool, arguments: args, response: text, isError: false, outcome: 'ok', reason: null, startedAt: new Date(clock), durationMs: ms, ...extra });
};
const refusal = (method: string, args: unknown, message: string): void => {
  clock += 1_500;
  journal.record(context, { kind: 'refusal', tool: method, arguments: args, response: message, isError: true, outcome: 'rejected', reason: message, startedAt: new Date(clock), durationMs: 0 });
};
call('overview', {}, { atCommit: 'a1b2c3d', kinds: [{ kind: 'code.service', count: 4 }, { kind: 'code.symbol', count: 212 }], documents: ['README.md', 'docs/requirements.md', 'docs/architecture.md'] }, 38);
call('find_nodes', { kind: 'code.service' }, { nodes: [{ key: 'code.service\u003apayments', kind: 'code.service', label: 'payments' }], next: null }, 21);
call('read_file', { path: 'docs/requirements.md' }, { path: 'docs/requirements.md', totalLines: 64, startLine: 1, endLine: 64, text: '1: # Requirements\n2: ...', sectionAnchors: ['uc-2', 'br-4'] }, 17);
call('read_file', { path: 'services/payments/src/domain/payment-service.ts' }, { path: 'services/payments/src/domain/payment-service.ts', totalLines: 142, startLine: 1, endLine: 142, text: '1: export class PaymentService {\n2:   ...' }, 24);
call('neighbors', { key: 'code.symbol\u003aservices/payments/src/domain/payment-service.ts#PaymentService.pay', direction: 'out' }, { neighbors: [{ relation: 'code.calls', key: 'code.symbol\u003aservices/payments/src/providers/factory.ts#PaymentClientFactory', kind: 'code.symbol', label: 'PaymentClientFactory' }], next: null }, 29);
call('ask_question', { type: 'gap', title: 'Is it intended that refunds have no timeout or retry?', question: 'A charge is protected by a timeout and a retry; a refund calls the provider directly.', why: 'A slow provider can hold a refund request open.', sides: [{ claim: 'The payment service wraps the charge call in a timeout and a retry.', grounds: ['code.file\u003aservices/payments/src/domain/payment-service.ts'] }], about: ['code.symbol\u003aservices/payments/src/domain/payment-service.ts#PaymentService.refund'] },
  { asked: false, merged: true, id: 'question:refunds-no-timeout-retry', note: 'The same subject is already asked as question:refunds-no-timeout-retry ("Is it intended that refunds have no timeout or retry?"); your page domain:payment was added to it, so a person answers it once.' }, 33);
call('write_page', { markdown: '---\nid: domain:payment\nkind: domain\n---\nPayments are taken by the [payments service](madarch:code.service\u003apayments).[^taken]\n\n[^taken]: [payments](madarch:code.service\u003apayments)\n' },
  { written: false, refused: [{ line: 11, rule: 'link-is-not-a-ground', message: 'this sentence is grounded only on code.service\u003apayments, which it already names with a link; a link names an entity and a ground supports the sentence' }], attemptsLeft: 4, note: 'Nothing was written. Fix every listed problem and call write_page again with the whole page.' }, 61,
  { isError: true, outcome: 'refused', reason: 'line 11 link-is-not-a-ground: this sentence is grounded only on code.service\u003apayments, which it already names with a link; a link names an entity and a ground supports the sentence' });
refusal('fs/read_text_file', { sessionId: 'sess-7f3a91', path: '/srv/shop/services/payments/src/domain/payment-service.ts' }, 'the agent called fs/read_text_file, which madarch does not offer: code is read through the session\'s MCP server');
refusal('session/request_permission', { sessionId: 'sess-7f3a91', toolCall: { title: 'Run: grep -rn refund services/', kind: 'execute' } }, 'every permission request is answered cancelled: the agent works only through the session\'s MCP server');
refusal('shell', { command: 'grep -rn refund services/' }, '"shell" is no tool of this unit: the tools are overview, find_nodes, get_node, neighbors, read_file, write_page, ask_question');
call('write_page', { markdown: '---\nid: domain:payment\nkind: domain\n---\nOrders are deleted after six hours.[^code]\n\n[^code]: [x](madarch:code.file\u003aservices/orders/retention.ts)\n' },
  { written: false, refused: [{ line: 0, rule: 'contradiction-side-missing', message: 'you asked question:retention-period as a contradiction, and a question does not replace what the page knows: the page must keep every side as its own grounded sentence. Not on the page yet: "The README says ninety days." (ground it on doc:README.md#retention)' }], attemptsLeft: 3 }, 74,
  { isError: true, outcome: 'refused', reason: 'line 0 contradiction-side-missing: you asked question:retention-period as a contradiction, and a question does not replace what the page knows: the page must keep every side as its own grounded sentence. Not on the page yet: "The README says ninety days." (ground it on doc:README.md#retention)' });
call('write_page', { markdown: '---\nid: domain:payment\nkind: domain\ntitle: Payment\n---\n...the whole page...' }, { written: true, path: 'docs/domains/payment.md', grounds: 6, links: 5 }, 112);

const env = { ...process.env, MADARCH_HOME: madarchHome, MADARCH_OWN_WIKI: 'off', MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist') };
const port = Number(argument('port', '4311'));
const child = Bun.spawn(['bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', shopHome, '--port', String(port)], { env, stdout: 'inherit', stderr: 'inherit' });
const base = `http://127.0.0.1:${port}`;
for (let tries = 0; ; tries += 1) {
  try {
    if ((await fetch(`${base}/`, { redirect: 'manual' })).status < 500) break;
  } catch {
    // not listening yet
  }
  if (tries > 120) throw new Error(`the background server did not answer on port ${port}`);
  await new Promise((rest) => setTimeout(rest, 500));
}
const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, protocolTimeout: 900_000, args: ['--no-sandbox'] });
async function open(url: string, width: number, height: number, scheme: 'light' | 'dark'): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((language) => { try { window.localStorage.setItem('madarch-wiki-language', language); } catch { /* the browser's own language */ } }, lang);
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  page.on('pageerror', (error) => console.error(`page error at ${url}: ${error.message}`));
  await page.goto(`${base}${url}`, { waitUntil: 'domcontentloaded' });
  return page;
}
async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await new Promise((rest) => setTimeout(rest, 500));
  const file = join(out, `${lang}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  written.push(file);
}
try {
  // The role is chosen, so the first-run card does not stand in the pictures.
  const chosen = await fetch(`${base}/products/shop/api/k/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'everything' }) });
  if (!chosen.ok) throw new Error(`the role was not kept: ${await chosen.text()}`);
  // The product is filled through the wiki, as a person would (the page needs its graph).
  const probe = await open('/products/shop/', 1150, 900, 'light');
  await probe.waitForSelector('[data-testid=fill-start], [data-testid=entity-page]', { timeout: 120_000 });
  if ((await probe.$('[data-testid=fill-start]')) !== null) {
    await probe.click('[data-testid=fill-start]');
    await probe.waitForFunction(() => document.querySelector('[data-testid=fill-card]') === null, { timeout: 1_500_000, polling: 2000 });
  }
  await probe.close();
  for (const scheme of ['light', 'dark'] as const) {
    for (const [width, height, size] of [[1150, 900, 'wide'], [390, 800, 'phone']] as const) {
      const page = await open(`/products/shop/k/e/${encodeURIComponent('domain:payment')}`, width, height, scheme);
      await page.waitForSelector('[data-testid=journal-link]', { timeout: 120_000 });
      await shoot(page, `${scheme}-${size}-page-with-link`);
      await page.close();
      const journalPage = await open(`/products/shop/k/journal?id=${encodeURIComponent('domain:payment')}`, width, height, scheme);
      await journalPage.waitForSelector('[data-testid=journal-row]', { timeout: 60_000 });
      await shoot(journalPage, `${scheme}-${size}-journal`);
      // One refused row opened: its reason, arguments and response.
      await journalPage.evaluate(() => { for (const row of document.querySelectorAll('[data-testid=journal-row][data-outcome=refused] details')) (row as HTMLDetailsElement).open = true; });
      await shoot(journalPage, `${scheme}-${size}-journal-refusals-open`, true);
      await journalPage.close();
    }
  }
} finally {
  child.kill('SIGTERM');
  await child.exited;
  await browser.close();
}
console.log(written.join('\n'));
