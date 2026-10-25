/**
 * loop:shots — the acceptance walk of the loop that closes the wiki
 * (madarch-m38l.7), rendered the way a reader sees it: the built app in
 * wiki/app served by the background server over a products home holding the
 * generated training repository, driven by headless Chromium. The agent is the
 * fake ACP agent behind an adapter executable on the PATH (no model).
 *
 * One walk in the language of --lang (en or ru): the agent writes the pages and
 * asks its questions; the Questions page, a question and the form to answer; the
 * answer; the refresh menu showing which pages the refresh will touch and why;
 * the refresh running with its plan; the question closed by the rewrite; a
 * document changed in the repository and a correction made by a person, the plan
 * read before the press and after the code is read; the Problems page.
 *
 * Usage: bun scripts/loop-shots.ts --lang en|ru [--out <folder>] [--work <folder>]
 * The pictures are written to --out (shots/ by default) and listed on standard output.
 */
import { execFileSync } from 'node:child_process';

// The questions-once acceptance mode always plans the full bilingual/theme/width matrix.
if (process.argv.includes('--questions-once')) {
  await import('./questions-once-shots.js');
  process.exit(0);
}
console.warn('Legacy partial walk: NOT the complete madarch-m38l.22 acceptance matrix; use --questions-once for that planned walk.');

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer';
import { readKnowledgePages } from '../src/knowledge/index/index.js';
import { resolveBrowserExecutable } from './chromium.js';
import { ANSWER_TEXT, LOOP_QUESTIONS, firstRunScript, groundRefreshScript, questionSlug, refreshScript } from '../test/loop-agent-script.js';
import { generateTrainingRepository, makeProduct } from '../test/knowledge-fixture.js';
import { gitEnv } from '../test/git-env.js';

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}

const lang = argument('lang', 'en') as 'en' | 'ru';
if (lang !== 'en' && lang !== 'ru') throw new Error(`--lang is en or ru, got ${JSON.stringify(lang)}`);
const out = resolve(argument('out', 'shots'));
const work = resolve(argument('work', `/tmp/madarch-loop-shots-${lang}`));
rmSync(work, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const written: string[] = [];

const identity = { GIT_AUTHOR_NAME: 'Ada Reader', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Reader', GIT_COMMITTER_EMAIL: 'ada@example.test' };
const repository = generateTrainingRepository(join(work, 'repo'));
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
const product = makeProduct(home, 'training-shop', repository);
const gitIn = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv(identity), encoding: 'utf8' }).trim();
gitIn(product, 'config', 'user.name', 'Ada Reader');
gitIn(product, 'config', 'user.email', 'ada@example.test');

const bin = join(work, 'bin');
mkdirSync(bin, { recursive: true });
const scriptFile = join(work, 'agent-script.json');
const useScript = (script: unknown): void => { writeFileSync(scriptFile, JSON.stringify(script)); };
useScript(firstRunScript({ product: 1_500, ordering: 3_000, payments: 1_500 }));
writeFileSync(join(bin, 'claude-agent-acp'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dir, '..', 'test', 'fixtures', 'acp-fake-agent', 'acp-fake-agent.ts'))} --scenario script --script ${JSON.stringify(scriptFile)}\n`);
chmodSync(join(bin, 'claude-agent-acp'), 0o755);

const port = Number(argument('port', lang === 'en' ? '4293' : '4294'));
const child = Bun.spawn(['bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', home, '--port', String(port)], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist') },
  stdout: 'ignore',
  stderr: 'inherit',
});
const server = {
  url: `http://127.0.0.1:${port}`,
  async stop(): Promise<void> {
    child.kill('SIGTERM');
    await child.exited;
  },
};
for (let tries = 0; ; tries += 1) {
  try {
    if ((await fetch(`${server.url}/`)).ok) break;
  } catch {
    // not listening yet
  }
  if (tries > 120) throw new Error(`the background server did not answer on port ${port}`);
  await new Promise((rest) => setTimeout(rest, 500));
}
const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, protocolTimeout: 900_000, args: ['--no-sandbox'] });
const base = `${server.url}/products/training-shop`;
const api = (path: string): string => `${base}${path}`;
const json = async (path: string, init?: RequestInit): Promise<any> => {
  const response = await fetch(api(path), init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} answered ${response.status}: ${JSON.stringify(body)}`);
  return body;
};
const post = (path: string, body: unknown): Promise<any> => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function open(url: string, width = 1440, height = 900, scheme: 'light' | 'dark' = 'light'): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((language) => { try { window.localStorage.setItem('madarch-wiki-language', language); } catch { /* the browser's own language */ } }, lang);
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  page.on('pageerror', (error) => console.error(`page error at ${url}: ${error.message}`));
  await page.goto(`${server.url}${url}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function shoot(page: Page, name: string): Promise<void> {
  await new Promise((rest) => setTimeout(rest, 500));
  const file = join(out, `${lang}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  written.push(file);
}

/** Waits for a state of a page; a wait that fails says what the page and the server said, and keeps a picture. */
async function waited(page: Page, what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => '');
    const status = await fetch(api('/api/k/status')).then((response) => response.text()).catch((failure) => String(failure));
    await page.screenshot({ path: join(out, `failed-${lang}-${what.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
    console.error(`${what} did not happen: ${(error as Error).message}\npage: ${body}\nstatus: ${status.slice(0, 1500)}`);
    await browser.close();
    await server.stop();
    process.exit(1);
  }
}

const payment = LOOP_QUESTIONS.find((candidate) => candidate.item === 'term.payment-token')!;
const paymentSlug = questionSlug(payment, lang);
const idle = (): boolean => document.querySelector('[data-testid=writer-card]') === null && document.querySelector('[data-testid=fill-card]') === null && /\d/.test(document.querySelector('[data-testid=fill-chip]')?.textContent ?? '');

// ---- the first run: the agent writes the pages and asks its questions ---------------------------
{
  const page = await open('/products/training-shop/', 1440, 1300);
  await waited(page, 'the agent choice', () => page.waitForSelector('[data-testid=agent-claude-code]', { timeout: 60_000 }));
  await page.click('[data-testid=agent-claude-code] input');
  await page.click(`[data-testid=content-language-${lang}] input`);
  await page.click('[data-testid=fill-start]');
  await waited(page, 'the first run to end', () => page.waitForFunction(idle, { timeout: 3_000_000, polling: 2000 }));
  await page.close();
}
const status = await json('/api/k/status');
console.log(`${lang}: first run ${status.writer.state}: ${status.writer.message ?? ''}`);

// ---- the questions, one question, the answer ---------------------------------------------------
{
  const page = await open('/products/training-shop/k/questions', 1440, 1500);
  await waited(page, 'the questions', () => page.waitForSelector('[data-testid=question-row]', { timeout: 60_000 }));
  await shoot(page, '01-questions');
  await page.goto(`${server.url}/products/training-shop/k/questions/${paymentSlug}`, { waitUntil: 'domcontentloaded' });
  await page.setViewport({ width: 1440, height: 1500 });
  await waited(page, 'the question', () => page.waitForSelector('[data-testid=answer-form]', { timeout: 60_000 }));
  await shoot(page, '02-question-open');
  await page.type('[data-testid=answer-text]', ANSWER_TEXT[lang]);
  await page.click('[data-testid=answer-save]');
  await waited(page, 'the answer saved', () => page.waitForSelector('[data-testid=answer-waiting]', { timeout: 60_000 }));
  await shoot(page, '03-question-answered');
  await page.close();
}
console.log(`${lang}: the answer was committed as ${gitIn(product, 'log', '-1', '--format=%an <%ae>: %s')}`);

// ---- the refresh: the plan before the press, the plan while the units run, the question closed -----------
{
  useScript(refreshScript(lang, 6_000));
  const page = await open('/products/training-shop/k/questions', 1440, 1100);
  await waited(page, 'the fill chip', () => page.waitForSelector('[data-testid=fill-chip]', { timeout: 60_000 }));
  await page.click('[data-testid=fill-chip]');
  await waited(page, 'the plan before the press', () => page.waitForSelector('[data-testid=refresh-preview] [data-testid=plan-page]', { timeout: 60_000 }));
  await shoot(page, '04-refresh-preview');
  await page.click('[data-testid=refresh]');
  await page.keyboard.press('Escape');
  await waited(page, 'the plan while the agent works', () => page.waitForSelector('[data-testid=writer-card] [data-testid=writer-plan] [data-testid=plan-page]', { timeout: 600_000 }));
  await shoot(page, '05-refresh-running');
  await waited(page, 'the refresh to end', () => page.waitForFunction(idle, { timeout: 600_000, polling: 1000 }));
  await page.goto(`${server.url}/products/training-shop/k/questions/${paymentSlug}`, { waitUntil: 'domcontentloaded' });
  await waited(page, 'the question closed', () => page.waitForSelector('[data-testid=answer-closed]', { timeout: 60_000 }));
  await shoot(page, '06-question-closed');
  await page.goto(`${server.url}/products/training-shop/k/questions`, { waitUntil: 'domcontentloaded' });
  await waited(page, 'the questions after the rewrite', () => page.waitForSelector('[data-testid=questions-group][data-state=closed]', { timeout: 60_000 }));
  await shoot(page, '07-questions-after');
  await page.close();
}
console.log(`${lang}: the payments page after the refresh holds ${readFileSync(join(product, 'docs/domains/payments.md'), 'utf8').includes(`madarch:question:${paymentSlug}`) ? 'a sentence grounded in the answer' : 'NO sentence grounded in the answer'}`);

// ---- a document changes and a person corrects a sentence: the plan, the problems -------------------------
{
  const requirements = join(repository, 'docs', 'requirements.md');
  writeFileSync(requirements, readFileSync(requirements, 'utf8').replace('and the shopper is told why.', 'and the shopper is told why by e-mail.'));
  gitIn(repository, 'add', '-A');
  gitIn(repository, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'The shopper of a declined payment is told by e-mail');
  const ordering = readKnowledgePages(product).pages.find((candidate) => candidate.id === 'domain:ordering')!;
  const statement = ordering.statements[0]!;
  const corrected = await post('/api/k/correction', { statement: `domain:ordering#${statement.id}`, reason: lang === 'en' ? 'A declined payment also cancels the order; the sentence leaves it out.' : 'Отклонённый платёж ещё и отменяет заказ, а в предложении этого нет.' });
  console.log(`${lang}: the correction ${corrected.id} was committed: ${corrected.committed}`);
  const page = await open('/products/training-shop/k/problems', 1440, 1300);
  await waited(page, 'the problems', () => page.waitForSelector('[data-testid=problem-row]', { timeout: 60_000 }));
  await shoot(page, '08-problems-open');
  useScript(groundRefreshScript(lang, 5_000));
  await page.goto(`${server.url}/products/training-shop/k/questions`, { waitUntil: 'domcontentloaded' });
  await waited(page, 'the fill chip', () => page.waitForSelector('[data-testid=fill-chip]', { timeout: 60_000 }));
  await page.click('[data-testid=fill-chip]');
  await waited(page, 'the plan before the press', () => page.waitForSelector('[data-testid=refresh-preview] [data-testid=plan-commits]', { timeout: 60_000 }));
  await shoot(page, '09-refresh-preview-unread-commit');
  await page.click('[data-testid=refresh]');
  await page.keyboard.press('Escape');
  await waited(page, 'the plan once the code is read', () => page.waitForSelector('[data-testid=writer-card] [data-testid=writer-plan] [data-kind=ground-changed]', { timeout: 900_000 }));
  await shoot(page, '10-refresh-running-grounds');
  await waited(page, 'the refresh to end', () => page.waitForFunction(idle, { timeout: 600_000, polling: 1000 }));
  await page.goto(`${server.url}/products/training-shop/k/problems`, { waitUntil: 'domcontentloaded' });
  await waited(page, 'the problems after the rewrite', () => page.waitForSelector('[data-testid=problems-closed]', { timeout: 60_000 }));
  await shoot(page, '11-problems-fixed');
  await page.close();
}

// ---- the phone and the dark scheme ---------------------------------------------------------------------------
{
  const phone = await open(`/products/training-shop/k/questions/${paymentSlug}`, 390, 1700);
  await waited(phone, 'the question on a phone', () => phone.waitForSelector('[data-testid=question-page]', { timeout: 60_000 }));
  await shoot(phone, '12-question-phone');
  await phone.close();
  const dark = await open('/products/training-shop/k/questions', 1440, 1300, 'dark');
  await waited(dark, 'the questions in the dark scheme', () => dark.waitForSelector('[data-testid=question-row]', { timeout: 60_000 }));
  await shoot(dark, '13-questions-dark');
  await dark.close();
}

await browser.close();
await server.stop();
console.log(written.join('\n'));
if (!existsSync(out)) process.exit(1);
