/**
 * roles:shots — the acceptance walk of decision 0031, rendered the way a reader
 * sees it: madarch's own wiki on a clean machine (the role card, its home page,
 * its glossary, a term link, a term's page), then a filled product (the «?» in
 * the top bar, the role menu, one page read under two roles, the product's
 * glossary with its ambiguous term). The built app in wiki/app is served by the
 * products home's background server (`madarch daemon-serve`) and driven by
 * headless Chromium.
 *
 * madarch's own wiki is a repository: `--own` names where to take it from (a
 * folder or an address; the madarch product repository by default) and `--branch`
 * which branch; the walk installs it the way the first start does.
 *
 * Usage: bun scripts/roles-shots.ts --lang ru|en [--out <folder>] [--work <folder>] [--own <repo>] [--branch <name>]
 */
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer, { type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { PAY, SAMPLE_IDENTITY, generateTrainingRepository, makeProduct, writeSamplePages } from '../test/knowledge-fixture.js';
import { gitEnv } from '../test/git-env.js';

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}
const lang = argument('lang', 'en');
const out = resolve(argument('out', 'shots-roles'));
const work = resolve(argument('work', `/tmp/madarch-roles-shots-${lang}`));
const own = argument('own', 'https://github.com/shady2k/madarch-product.git');
const branch = argument('branch', 'main');
rmSync(work, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const written: string[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv(SAMPLE_IDENTITY), encoding: 'utf8' });

// madarch's own wiki: the repository the first start installs from, with the branch asked for as its main.
const ownRepository = join(work, 'own-repository');
execFileSync('git', ['clone', '--quiet', '--branch', branch, own, ownRepository], { stdio: ['ignore', 'ignore', 'inherit'] });
git(ownRepository, 'checkout', '--quiet', '-B', 'main');

const repository = generateTrainingRepository(join(work, 'repo'));
const madarchHome = join(work, 'madarch');
const cleanHome = join(work, 'home-clean');
const shopHome = join(work, 'home-shop');
mkdirSync(cleanHome, { recursive: true });
mkdirSync(shopHome, { recursive: true });
const shop = makeProduct(shopHome, 'shop', repository);
writeSamplePages(shop);
appendFileSync(join(shop, 'docs', 'domains', 'payment.md'), '\nCapture is the moment the money is taken, and the Outbox keeps the messages Payments will publish.[^3]\n\n[^3]: [UC-2](madarch:doc:docs/requirements.md#uc-2)\n');
mkdirSync(join(shop, 'docs', 'questions'), { recursive: true });
writeFileSync(join(shop, 'docs', 'questions', 'payment-token.md'), '# Payment token\n\n## Question {#question}\n\nDoes the document term "payment token" mean CardToken or PaymentToken?\n');
writeFileSync(join(shop, 'docs', 'glossary.md'), [
  '# Terms the agent found',
  '',
  '- **Payment token** - What the architecture document calls the value Checkout sends to Payments.',
  '  - Also called: payment tokens',
  '  - In code: `CardToken`, `PaymentToken`',
  '  - Ambiguous: the architecture says "payment token" for the card reference, while the code\'s `PaymentToken` is the provider\'s proof of capture; see [the open question](madarch:doc:docs/questions/payment-token.md#question)',
  '',
].join('\n'));
git(shop, 'add', '.');
git(shop, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Add the sample pages and the glossary');

const env = { ...process.env, MADARCH_HOME: madarchHome, MADARCH_OWN_WIKI: '', MADARCH_OWN_WIKI_REPOSITORY: ownRepository, MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist') };

async function serve(home: string, port: number): Promise<{ url: string; stop: () => Promise<void> }> {
  const child = Bun.spawn(['bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', home, '--port', String(port)], { env, stdout: 'inherit', stderr: 'inherit' });
  const url = `http://127.0.0.1:${port}`;
  for (let tries = 0; ; tries += 1) {
    try {
      if ((await fetch(`${url}/`, { redirect: 'manual' })).status < 500) break;
    } catch {
      // not listening yet
    }
    if (tries > 120) throw new Error(`the background server did not answer on port ${port}`);
    await new Promise((rest) => setTimeout(rest, 500));
  }
  return { url, stop: async () => { child.kill('SIGTERM'); await child.exited; } };
}

const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, protocolTimeout: 900_000, args: ['--no-sandbox'] });
async function open(base: string, url: string, width = 1440, height = 900): Promise<Page> {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((language) => { try { window.localStorage.setItem('madarch-wiki-language', language); } catch { /* the browser's own language */ } }, lang);
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  page.on('pageerror', (error) => console.error(`page error at ${url}: ${error.message}`));
  await page.goto(`${base}${url}`, { waitUntil: 'domcontentloaded' });
  return page;
}
async function shoot(page: Page, name: string): Promise<void> {
  await new Promise((rest) => setTimeout(rest, 500));
  const file = join(out, `${lang}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  written.push(file);
}
const encode = encodeURIComponent;

// ---- a clean machine: madarch's own wiki opens first ----------------------------------------
const clean = await serve(cleanHome, Number(argument('port', '4301')));
try {
  const page = await open(clean.url, '/');
  await page.waitForSelector('[data-testid=role-card]', { timeout: 120_000 });
  await shoot(page, '01-first-run-role-card');
  await page.click('[data-testid=role-skip]');
  await page.waitForFunction(() => document.querySelector('[data-testid=role-card]') === null);
  await page.waitForSelector('[data-testid=entity-page]', { timeout: 60_000 });
  await shoot(page, '02-own-wiki-home');
  await page.goto(`${clean.url}/products/madarch-wiki/k/e/${encode('domain:fill')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a.term-link', { timeout: 60_000 });
  await shoot(page, '03-a-page-with-term-links');
  await page.goto(`${clean.url}/products/madarch-wiki/k/glossary`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=glossary-term]', { timeout: 60_000 });
  await shoot(page, '04-own-glossary');
  await page.goto(`${clean.url}/products/madarch-wiki/k/e/${encode('doc:docs/glossary.md#основание')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-block=term]', { timeout: 60_000 });
  await shoot(page, '05-a-term-page');
  await page.close();
} finally {
  await clean.stop();
}

// ---- a filled product: the «?», the role, one page under two roles, the product's glossary ----
const busy = await serve(shopHome, Number(argument('port', '4301')) + 1);
try {
  const probe = await open(busy.url, '/products/shop/');
  await probe.waitForSelector('[data-testid=fill-start], [data-testid=entity-page]', { timeout: 120_000 });
  if ((await probe.$('[data-testid=fill-start]')) !== null) {
    await probe.click('[data-testid=fill-start]');
    await probe.waitForFunction(() => document.querySelector('[data-testid=fill-card]') === null, { timeout: 1_500_000, polling: 2000 });
  }
  await probe.close();
  const page = await open(busy.url, '/products/shop/k');
  await page.waitForSelector('[data-testid=help-link]', { timeout: 60_000 });
  await shoot(page, '06-product-with-help-icon');
  await page.click('[data-testid=role-menu]');
  await page.waitForSelector('[data-testid=role-choice]');
  await shoot(page, '07-role-menu');
  await page.keyboard.press('Escape');
  await page.click('[data-testid=help-link]');
  await page.waitForFunction(() => window.location.pathname.startsWith('/products/madarch-wiki'), { timeout: 60_000 });
  await page.waitForSelector('[data-testid=entity-page]', { timeout: 60_000 });
  await shoot(page, '08-help-icon-opens-the-documentation');
  const setRole = async (role: string): Promise<void> => {
    const answer = await fetch(`${busy.url}/products/shop/api/k/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
    if (!answer.ok) throw new Error(`the role ${role} was not kept: ${await answer.text()}`);
  };
  for (const [role, name] of [['developer', '09-function-as-developer'], ['product', '10-function-as-product']] as const) {
    await setRole(role);
    const view = await open(busy.url, `/products/shop/k/e/${encode(PAY)}`, 1440, 1700);
    await view.waitForSelector('[data-testid=entity-page]', { timeout: 120_000 });
    await view.waitForFunction((wanted) => document.querySelector('[data-testid=role-current]')?.textContent !== '' && wanted, {}, true);
    await shoot(view, name);
    await view.close();
  }
  await setRole('everything');
  const glossary = await open(busy.url, '/products/shop/k/glossary', 1440, 1500);
  await glossary.waitForSelector('[data-testid=glossary-term]', { timeout: 120_000 });
  await shoot(glossary, '11-product-glossary-with-ambiguous-term');
  await glossary.close();
  const domain = await open(busy.url, `/products/shop/k/e/${encode('domain:payment')}`, 1440, 1100);
  await domain.waitForSelector('a.term-link', { timeout: 120_000 });
  await shoot(domain, '12-term-links-in-a-product-page');
  await domain.close();
  await page.close();
} finally {
  await busy.stop();
  await browser.close();
}
console.log(written.join('\n'));
