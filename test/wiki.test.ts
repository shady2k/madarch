import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFERENCE_SYSTEM } from '../scripts/render-views.js';
import { wikiCacheRoot } from '../src/wiki/cache.js';
import { Repo } from './model-check-repo.js';

/**
 * The wiki command end to end (docs/changes/wiki/capabilities/wiki.md,
 * requirements engine, links and result): exit codes 0, 1 and 2, what each
 * refuses to write, the engine choice from --engine, then
 * MADARCH_WIKI_ENGINE, then zensical, and the link check of the built
 * site — a link leading nowhere after the writer's own validation fails
 * the build naming every one of them, and a site the checker cannot read
 * is an unreadable input. The engines' own builds are faked by the fixtures
 * under test/fixtures/wiki/ (fake uv/uvx for Zensical, fake bun for
 * Starlight) so the regular suite needs neither uv nor bun to build; the
 * real builds of both engines are gated at the bottom, because CI has
 * neither uv nor a warmed bun cache and the owner has decided real engine
 * builds run only under MADARCH_WIKI_E2E=1.
 */

/**
 * Every temporary folder this file makes, removed after each test and on
 * exit with whatever is left, pass or fail: a run of the suite leaves the
 * system temporary folder as it found it.
 */
const made: string[] = [];

function tempFolder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const removeMadeFolders = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
};

afterEach(removeMadeFolders);
process.on('exit', removeMadeFolders);

const SCRIPT = fileURLToPath(new URL('../scripts/wiki.ts', import.meta.url));
const FAKE_BIN = fileURLToPath(new URL('./fixtures/wiki/fake-uvx', import.meta.url));
const FAILING_BIN = fileURLToPath(new URL('./fixtures/wiki/failing-uvx', import.meta.url));
const BROKEN_BIN = fileURLToPath(new URL('./fixtures/wiki/broken-site-uvx', import.meta.url));
const UNREADABLE_BIN = fileURLToPath(new URL('./fixtures/wiki/unreadable-site-uvx', import.meta.url));
const FAKE_BUN = fileURLToPath(new URL('./fixtures/wiki/fake-bun', import.meta.url));
const FAILING_INSTALL_BUN = fileURLToPath(new URL('./fixtures/wiki/failing-install-bun', import.meta.url));
const FAILING_BUILD_BUN = fileURLToPath(new URL('./fixtures/wiki/failing-build-bun', import.meta.url));
const BROKEN_SITE_BUN = fileURLToPath(new URL('./fixtures/wiki/broken-site-bun', import.meta.url));
const DOCUMENTS_FIXTURE = fileURLToPath(new URL('./fixtures/wiki/documents-repo', import.meta.url));
const FAKE_BUN_LOG = join(FAKE_BUN, 'invocations.log');
const FAKE_LOG = join(FAKE_BIN, 'invocations.log');

function outFolder(): string {
  return join(tempFolder('madarch-wiki-'), 'out');
}

/**
 * The wiki cache root for one script run, moved off the machine's: the
 * script tests run a fake toolchain, and what it installs must never sit
 * where a real build looks for a real one.
 */
function scriptCache(): { MADARCH_WIKI_CACHE: string } {
  return { MADARCH_WIKI_CACHE: join(tempFolder('madarch-wiki-cache-'), 'cache') };
}

/**
 * Runs the wiki script with `path` as the child's whole PATH. The fake
 * bins come first so they are the `uv`/`uvx` the script finds, with the
 * real system kept behind them for the fakes' own commands; a PATH of one
 * empty dir (the no-uv case) strips everything.
 */
function runWiki(args: readonly string[], path: string = `${FAKE_BIN}:${process.env.PATH ?? ''}`, extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: path, ...extraEnv } });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

function combined(run: { stdout: string; stderr: string }): string {
  return `${run.stdout}\n${run.stderr}`;
}

/** Every file under `root`, by path relative to it. */
function walkFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(full.slice(root.length + 1), readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files;
}

describe('scripts/wiki.ts', () => {
  test('builds the reference system: exit 0, the site path printed, source and site written', () => {
    rmSync(FAKE_LOG, { force: true });
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out]);
    expect(run.status).toBe(0);
    const site = resolve(out, 'site');
    expect(run.stdout).toContain(site);
    expect(readFileSync(join(site, 'index.html'), 'utf8')).toContain('fake zensical site');

    const index = readFileSync(join(out, 'source', 'docs', 'index.md'), 'utf8');
    expect(index).toContain('# Home');
    expect(index).toContain('The model holds 70 elements, 51 interfaces and 109 relations.');
    expect(index).toContain('| broker | 1 |');
    expect(index).toContain('| domain | 6 |');
    expect(index).toContain('| external | 3 |');
    expect(index).toContain('| module | 4 |');
    expect(index).toContain('| person | 2 |');
    expect(index).toContain('| service | 29 |');
    expect(index).toContain('| store | 25 |');
    expect(index).toContain('| [Catalog](domains/catalog.md) | 12 |');
    expect(index).toContain('| [Fulfilment](domains/fulfilment.md) | 8 |');
    expect(index).toContain('| [Ordering](domains/ordering.md) | 15 |');
    expect(index).toContain('| [Payments](domains/payments.md) | 8 |');
    expect(index).toContain('| [Platform](domains/platform.md) | 7 |');
    expect(index).toContain('| [Storefront](domains/storefront.md) | 10 |');

    const ordering = readFileSync(join(out, 'source', 'docs', 'domains', 'ordering.md'), 'utf8');
    expect(ordering).toContain('# Ordering');
    expect(ordering).toContain('The Ordering domain holds 15 elements.');
    expect(ordering).toContain('| [Checkout](../elements/checkout-api.md) | service | TypeScript, NestJS |');

    const domainFiles = readdirSync(join(out, 'source', 'docs', 'domains'));
    expect(domainFiles.sort()).toEqual(['catalog.md', 'fulfilment.md', 'ordering.md', 'payments.md', 'platform.md', 'storefront.md']);

    const elementFiles = readdirSync(join(out, 'source', 'docs', 'elements'));
    expect(elementFiles.length).toBe(64);
    const checkout = readFileSync(join(out, 'source', 'docs', 'elements', 'checkout-api.md'), 'utf8');
    expect(checkout).toContain('# Checkout');
    expect(checkout).toContain('| service | TypeScript, NestJS | [Internal network](../zones/internal.md) | [Ordering](../domains/ordering.md) |');
    expect(checkout).toContain('| [Payments](../domains/payments.md) | takes payment | — | — | — |');
    expect(readFileSync(join(out, 'source', 'docs', 'interfaces.md'), 'utf8')).toContain('## grpc');
    const zonesIndex = readFileSync(join(out, 'source', 'docs', 'zones.md'), 'utf8');
    expect(zonesIndex).toContain('[Internal network](zones/internal.md)');
    const zonePage = readFileSync(join(out, 'source', 'docs', 'zones', 'internal.md'), 'utf8');
    expect(zonePage).toContain('# Internal network');
    expect(zonePage).toContain('| [Checkout](../elements/checkout-api.md) | service |');
    const categoriesIndex = readFileSync(join(out, 'source', 'docs', 'data-categories.md'), 'utf8');
    expect(categoriesIndex).toContain('[Personal data](data-categories/personal.md)');
    expect(readFileSync(join(out, 'source', 'docs', 'data-categories', 'personal.md'), 'utf8')).toContain('# Personal data');
    expect(readFileSync(join(out, 'source', 'zensical.toml'), 'utf8')).toContain('"Ordering" = "domains/ordering.md"');
    expect(readFileSync(join(out, 'source', 'zensical.toml'), 'utf8')).toContain('{ "Internal network" = "zones/internal.md" }');
    // The zones and the data categories sit in one group each, their index
    // page first — never a nested group of the same name (Zones → Zones →
    // Zones), which the stage 1 review flagged.
    const nav = readFileSync(join(out, 'source', 'zensical.toml'), 'utf8');
    expect(nav).toContain('{ "Zones" = [{ "Zones" = "zones.md" }, { "Demilitarised zone" = "zones/dmz.md" }');
    expect(nav).toContain('{ "Data categories" = [{ "Data categories" = "data-categories.md" }, { "Order data" = "data-categories/order.md" }');
    expect(nav).not.toContain('= [{ "Zones" = [{');
    expect(readFileSync(FAKE_LOG, 'utf8')).toContain('zensical==0.0.66 build');
  }, { timeout: 60_000 });

  test('--engine hugo exits 2 naming the value and the allowed engines, and writes nothing', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out, '--engine', 'hugo']);
    expect(run.status).toBe(2);
    const said = combined(run);
    expect(said).toContain('hugo');
    expect(said).toContain('zensical');
    expect(said).toContain('starlight');
    expect(existsSync(out)).toBe(false);
  });

  test('the engine comes from MADARCH_WIKI_ENGINE, and --engine wins over it', () => {
    const refused = outFolder();
    expect(runWiki([REFERENCE_SYSTEM, '--out', refused], undefined, { MADARCH_WIKI_ENGINE: 'hugo' }).status).toBe(2);
    expect(existsSync(refused)).toBe(false);

    const built = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', built, '--engine', 'zensical'], undefined, { MADARCH_WIKI_ENGINE: 'hugo' });
    expect(run.status).toBe(0);
    expect(existsSync(join(built, 'site', 'index.html'))).toBe(true);
  }, { timeout: 60_000 });

  test('--engine starlight builds through the template install and the fake engine, and the source project is complete', () => {
    rmSync(FAKE_BUN_LOG, { force: true });
    const cache = scriptCache();
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out, '--engine', 'starlight'], `${FAKE_BUN}:${process.env.PATH ?? ''}`, cache);
    expect(run.status).toBe(0);
    const site = resolve(out, 'site');
    expect(run.stdout).toContain(site);
    expect(readFileSync(join(site, 'index.html'), 'utf8')).toContain('fake starlight site');
    // The project: the template's own files, the generated pages and the
    // sidebar module, and none of the engine's build byproducts.
    expect(existsSync(join(out, 'source', 'astro.config.mjs'))).toBe(true);
    const home = readFileSync(join(out, 'source', 'src', 'content', 'docs', 'index.md'), 'utf8');
    expect(home).toContain('title: "Home"');
    expect(home).toContain('<likec4-view view-id="index"></likec4-view>');
    expect(existsSync(join(out, 'source', 'src', 'content', 'docs', 'zones', 'internal.md'))).toBe(true);
    expect(readFileSync(join(out, 'source', 'src', 'generated', 'site.mjs'), 'utf8')).toContain('"label": "Zones"');
    expect(existsSync(join(out, 'source', 'node_modules'))).toBe(false);
    // The exact invocations, in order: the template install, then the build.
    const log = readFileSync(FAKE_BUN_LOG, 'utf8');
    expect(log.indexOf('install --frozen-lockfile')).toBeGreaterThan(-1);
    expect(log.indexOf('run build')).toBeGreaterThan(log.indexOf('install --frozen-lockfile'));
    // The cache install the removed link pointed at survives the build:
    // the link is unlinked, never followed.
    const installed = readdirSync(cache.MADARCH_WIKI_CACHE).some((name) => existsSync(join(cache.MADARCH_WIKI_CACHE, name, 'node_modules', 'fake-installed')));
    expect(installed).toBe(true);
  }, { timeout: 60_000 });

  test('a build keeps the machine cache root untouched: its install goes to the folder MADARCH_WIKI_CACHE names', () => {
    rmSync(FAKE_BUN_LOG, { force: true });
    const real = wikiCacheRoot(process.env);
    const before = existsSync(real) ? readdirSync(real).sort() : null;
    const cache = scriptCache();
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out, '--engine', 'starlight'], `${FAKE_BUN}:${process.env.PATH ?? ''}`, cache);
    expect(run.status).toBe(0);
    // The install the script made sits in the moved cache...
    expect(readdirSync(cache.MADARCH_WIKI_CACHE).some((name) => existsSync(join(cache.MADARCH_WIKI_CACHE, name, 'node_modules', 'fake-installed')))).toBe(true);
    // ...and the real cache root is exactly as the run found it: no fake
    // install of this run where a real build would look for a real one.
    expect(existsSync(real) ? readdirSync(real).sort() : null).toEqual(before);
  }, { timeout: 60_000 });

  test('the starlight engine comes from MADARCH_WIKI_ENGINE, and --engine wins over it', () => {
    const byEnv = outFolder();
    const byEnvRun = runWiki([REFERENCE_SYSTEM, '--out', byEnv], `${FAKE_BUN}:${process.env.PATH ?? ''}`, { MADARCH_WIKI_ENGINE: 'starlight', ...scriptCache() });
    expect(byEnvRun.status).toBe(0);
    expect(existsSync(join(byEnv, 'site', 'index.html'))).toBe(true);

    const byFlag = outFolder();
    const byFlagRun = runWiki([REFERENCE_SYSTEM, '--out', byFlag, '--engine', 'zensical'], `${FAKE_BIN}:${FAKE_BUN}:${process.env.PATH ?? ''}`, { MADARCH_WIKI_ENGINE: 'starlight' });
    expect(byFlagRun.status).toBe(0);
    expect(readFileSync(join(byFlag, 'site', 'index.html'), 'utf8')).toContain('fake zensical site');
  }, { timeout: 60_000 });

  test('without bun on PATH the starlight engine exits 2 naming how to install bun, and writes nothing', () => {
    const out = outFolder();
    const empty = tempFolder('madarch-wiki-nobun-');
    const run = runWiki([REFERENCE_SYSTEM, '--out', out, '--engine', 'starlight'], empty);
    expect(run.status).toBe(2);
    const said = combined(run);
    expect(said).toContain('bun');
    expect(said).toContain('bun.sh');
    expect(existsSync(out)).toBe(false);
  }, { timeout: 60_000 });

  test('a failed starlight template install exits 2 naming the cause, and writes nothing', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out, '--engine', 'starlight'], `${FAILING_INSTALL_BUN}:${process.env.PATH ?? ''}`, scriptCache());
    expect(run.status).toBe(2);
    const said = combined(run);
    expect(said).toContain('could not be installed');
    expect(said).toContain('bun install exploded');
    expect(existsSync(out)).toBe(false);
  }, { timeout: 60_000 });

  test('a failing starlight build exits 1 and prints the engine output', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out, '--engine', 'starlight'], `${FAILING_BUILD_BUN}:${process.env.PATH ?? ''}`, scriptCache());
    expect(run.status).toBe(1);
    const said = combined(run);
    expect(said).toContain('astro exploded');
    expect(said).toContain('starlight build failed');
    expect(existsSync(join(out, 'site'))).toBe(false);
    expect(existsSync(join(out, 'source', 'src', 'content', 'docs', 'index.md'))).toBe(true);
  }, { timeout: 60_000 });

  test('a starlight site whose link leads nowhere after the writer exits 1 naming every broken link', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out, '--engine', 'starlight'], `${BROKEN_SITE_BUN}:${process.env.PATH ?? ''}`, scriptCache());
    expect(run.status).toBe(1);
    const said = combined(run);
    expect(said).toContain('the built site carries broken links');
    expect(said).toContain('index.html: "./ghost/"');
    expect(said).toContain('real/index.html: "also-gone/"');
  }, { timeout: 60_000 });

  test('without uv on PATH it exits 2 naming how to install uv, and writes nothing', () => {
    const out = outFolder();
    const empty = tempFolder('madarch-wiki-nouvp-');
    const run = runWiki([REFERENCE_SYSTEM, '--out', out], empty);
    expect(run.status).toBe(2);
    const said = combined(run);
    expect(said).toContain('uv');
    expect(said).toContain('astral.sh');
    expect(existsSync(out)).toBe(false);
  }, { timeout: 60_000 });

  test('a failing engine build exits 1 and prints the engine output', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out], `${FAILING_BIN}:${process.env.PATH ?? ''}`);
    expect(run.status).toBe(1);
    const said = combined(run);
    expect(said).toContain('zensical exploded');
    expect(said).toContain('zensical build failed');
    expect(existsSync(join(out, 'site'))).toBe(false);
    expect(existsSync(join(out, 'source', 'docs', 'index.md'))).toBe(true);
  }, { timeout: 60_000 });

  test('a site whose link leads nowhere after the writer exits 1 naming every broken link, sorted by code point', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out], `${BROKEN_BIN}:${process.env.PATH ?? ''}`);
    expect(run.status).toBe(1);
    const said = combined(run);
    expect(said).toContain('the built site carries broken links');
    // Every one of them, each with its page (site-relative) and the link as
    // written; code-point order: "." (46) before "Z" (90) before "a" (97),
    // a locale sort would put "apple" before "Zebra".
    const ghost = said.indexOf('index.html: "./ghost/"');
    const script = said.indexOf('index.html: "./missing.js"');
    const zebra = said.indexOf('index.html: "Zebra/"');
    const apple = said.indexOf('index.html: "apple/"');
    const second = said.indexOf('real/index.html: "also-gone/"');
    expect(ghost).toBeGreaterThan(-1);
    expect(script).toBeGreaterThan(ghost);
    expect(zebra).toBeGreaterThan(script);
    expect(apple).toBeGreaterThan(zebra);
    expect(second).toBeGreaterThan(apple);
  }, { timeout: 60_000 });

  test('a site the checker cannot read exits 2 naming the file, never a silent pass', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out], `${UNREADABLE_BIN}:${process.env.PATH ?? ''}`);
    expect(run.status).toBe(2);
    expect(combined(run)).toContain(join(out, 'site', 'index.html'));
  }, { timeout: 60_000 });

  test('a model naming an unknown parent exits 2 with the error file and line, and builds nothing', () => {
    const repo = new Repo();
    made.push(repo.path);
    repo.writeModel(
      'model.yaml',
      ['version: 1', '', 'elements:', '  - id: orphan', '    kind: service', '    name: Orphan', '    parent: nobody', ''].join('\n'),
    );
    const line = repo.lineOf('model.yaml', 'parent: nobody');
    const out = outFolder();
    const run = runWiki([repo.path, '--out', out]);
    expect(run.status).toBe(2);
    expect(combined(run)).toContain(`madarch/model.yaml:${line}`);
    expect(existsSync(out)).toBe(false);
  });

  test('two runs over the same repository write byte-identical page sources', () => {
    const first = outFolder();
    const second = outFolder();
    expect(runWiki([REFERENCE_SYSTEM, '--out', first]).status).toBe(0);
    expect(runWiki([REFERENCE_SYSTEM, '--out', second]).status).toBe(0);
    const left = walkFiles(join(first, 'source'));
    const right = walkFiles(join(second, 'source'));
    const entries = (files: Map<string, string>): [string, string][] => [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(entries(left)).toEqual(entries(right));
  }, { timeout: 120_000 });

  test('usage errors exit 2 with the usage line', () => {
    expect(runWiki([]).status).toBe(2);
    expect(combined(runWiki([]))).toContain('usage: bun scripts/wiki.ts');
    expect(runWiki([REFERENCE_SYSTEM]).status).toBe(2);
    expect(runWiki([REFERENCE_SYSTEM, '--out']).status).toBe(2);
    expect(runWiki([REFERENCE_SYSTEM, '--out', outFolder(), '--bogus']).status).toBe(2);
  });

  test('--out= and --out "" exit 2 with the usage and leave the current directory alone', () => {
    const cases: readonly string[][] = [
      [REFERENCE_SYSTEM, '--out='],
      [REFERENCE_SYSTEM, '--out', ''],
    ];
    for (const args of cases) {
      const cwd = tempFolder('madarch-wiki-emptyout-');
      mkdirSync(join(cwd, 'source'));
      writeFileSync(join(cwd, 'source', 'marker.txt'), 'kept');
      const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd, env: { ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}` } });
      expect(run.status).toBe(2);
      expect(`${run.stderr ?? ''}\n${run.stdout ?? ''}`).toContain('usage: bun scripts/wiki.ts');
      expect(readFileSync(join(cwd, 'source', 'marker.txt'), 'utf8')).toBe('kept');
      expect(existsSync(join(cwd, 'site'))).toBe(false);
    }
  }, { timeout: 120_000 });

  test('every home, domain and element page carries one diagram, the LikeC4 tab first by default', () => {
    const out = outFolder();
    expect(runWiki([REFERENCE_SYSTEM, '--out', out]).status).toBe(0);
    const source = join(out, 'source', 'docs');
    const ordering = readFileSync(join(source, 'domains', 'ordering.md'), 'utf8');
    expect(ordering).toContain('data-first="likec4"');
    expect(ordering).toContain('<likec4-view view-id="ordering"></likec4-view>');
    expect(ordering).toContain('data-panel="mermaid" hidden');
    // Checkout's service page shows the view of checkout-api, its nearest
    // ancestor that has one; the cart module the same; a top-level person
    // and the home page the landscape.
    expect(readFileSync(join(source, 'elements', 'checkout-api.md'), 'utf8')).toContain('<likec4-view view-id="checkout-api"></likec4-view>');
    expect(readFileSync(join(source, 'elements', 'checkout-cart.md'), 'utf8')).toContain('<likec4-view view-id="checkout-api"></likec4-view>');
    expect(readFileSync(join(source, 'elements', 'customer.md'), 'utf8')).toContain('<likec4-view view-id="index"></likec4-view>');
    expect(readFileSync(join(source, 'index.md'), 'utf8')).toContain('<likec4-view view-id="index"></likec4-view>');
    // The archify tab is the third: hidden by default, its iframe pointing
    // at the view's archify page the build ships, from the page's own depth.
    expect(ordering).toContain('data-tab="archify"');
    expect(ordering).toContain('data-panel="archify" hidden');
    expect(ordering).toContain('src="/assets/archify/ordering.html"');
    expect(readFileSync(join(source, 'index.md'), 'utf8')).toContain('src="/assets/archify/landscape.html"');
    expect(readFileSync(join(source, 'elements', 'checkout-api.md'), 'utf8')).toContain('src="/assets/archify/checkout-api.html"');
    // The Mermaid tab carries madarch's diagram and its relation table, not the source text.
    expect(ordering).toContain('class="mermaid"');
    expect(ordering).toContain('flowchart LR');
    expect(ordering).toContain('<table class="wiki-relations">');
    expect(ordering).toContain('<th>Relations</th>');
    expect(ordering).not.toContain('```mermaid');
    // Exactly one diagram per home, domain and element page; none on the rest.
    for (const file of ['index.md', ...readdirSync(join(source, 'domains')).map((name) => `domains/${name}`), ...readdirSync(join(source, 'elements')).map((name) => `elements/${name}`)]) {
      const text = readFileSync(join(source, ...file.split('/')), 'utf8');
      expect(text.split('class="wiki-diagram"').length - 1).toBe(1);
    }
    for (const file of [
      'interfaces.md',
      'zones.md',
      'data-categories.md',
      ...readdirSync(join(source, 'zones')).map((name) => `zones/${name}`),
      ...readdirSync(join(source, 'data-categories')).map((name) => `data-categories/${name}`),
    ]) {
      expect(readFileSync(join(source, ...file.split('/')), 'utf8')).not.toContain('wiki-diagram');
    }
  }, { timeout: 60_000 });

  test('MADARCH_WIKI_DIAGRAM=mermaid shows the Mermaid tab first, LikeC4 hidden', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out], undefined, { MADARCH_WIKI_DIAGRAM: 'mermaid' });
    expect(run.status).toBe(0);
    const ordering = readFileSync(join(out, 'source', 'docs', 'domains', 'ordering.md'), 'utf8');
    expect(ordering).toContain('data-first="mermaid"');
    expect(ordering).toContain('data-panel="likec4" hidden');
    expect(ordering).toContain('data-panel="archify" hidden');
    expect(ordering).not.toContain('data-panel="mermaid" hidden');
  }, { timeout: 60_000 });

  test('MADARCH_WIKI_DIAGRAM=archify shows the archify tab first, LikeC4 and Mermaid hidden', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out], undefined, { MADARCH_WIKI_DIAGRAM: 'archify' });
    expect(run.status).toBe(0);
    const ordering = readFileSync(join(out, 'source', 'docs', 'domains', 'ordering.md'), 'utf8');
    expect(ordering).toContain('data-first="archify"');
    expect(ordering).not.toContain('data-panel="archify" hidden');
    expect(ordering).toContain('data-panel="likec4" hidden');
    expect(ordering).toContain('data-panel="mermaid" hidden');
    // The Ordering page embeds the Ordering view's archify page; the
    // component of the element with a view below links to that page, and
    // the element's own page does not link to itself.
    const page = readFileSync(join(out, 'source', 'docs', 'assets', 'archify', 'ordering.html'), 'utf8');
    expect(page).toContain('data-node-id="cordering_dcheckout-api"');
    expect(page).toContain('<a href="checkout-api.html" data-wiki-view="cordering_dcheckout-api">');
    // The Checkout page links the elements of its own that carry views
    // (storefront, catalog, payments, ...), but never the view's own
    // scope element: that would lead back to the same page.
    const ownPage = readFileSync(join(out, 'source', 'docs', 'assets', 'archify', 'checkout-api.html'), 'utf8');
    expect(ownPage).toContain('data-wiki-view="cstorefront"');
    expect(ownPage).not.toContain('data-wiki-view="cordering_dcheckout-api"');
  }, { timeout: 60_000 });

  test('an unknown MADARCH_WIKI_DIAGRAM exits 2 naming the value and the three allowed, and writes nothing', () => {
    const out = outFolder();
    const run = runWiki([REFERENCE_SYSTEM, '--out', out], undefined, { MADARCH_WIKI_DIAGRAM: 'graphviz' });
    expect(run.status).toBe(2);
    const said = combined(run);
    expect(said).toContain('graphviz');
    expect(said).toContain('likec4');
    expect(said).toContain('mermaid');
    expect(said).toContain('archify');
    expect(existsSync(out)).toBe(false);
  });

  test('without node on PATH the build exits 2 naming how to get node, and writes nothing', () => {
    const out = outFolder();
    // Only the fake uv/uvx on PATH: no node for the archify renderer.
    const run = runWiki([REFERENCE_SYSTEM, '--out', out], FAKE_BIN);
    expect(run.status).toBe(2);
    const said = combined(run);
    expect(said).toContain('node was not found on PATH');
    expect(said).toContain('archify');
    expect(existsSync(out)).toBe(false);
  });

  test('the LikeC4 web component and the Mermaid runtime ship inside the project', () => {
    const out = outFolder();
    expect(runWiki([REFERENCE_SYSTEM, '--out', out]).status).toBe(0);
    const assets = join(out, 'source', 'docs', 'assets');
    expect(statSync(join(assets, 'likec4-view.js')).size).toBeGreaterThan(1_000_000);
    expect(existsSync(join(assets, 'mermaid', 'mermaid.esm.min.mjs'))).toBe(true);
    expect(existsSync(join(assets, 'mermaid', 'chunks', 'mermaid.esm.min'))).toBe(true);
    // One archify page per view: the landscape and one per element view.
    const archifyPages = readdirSync(join(assets, 'archify')).sort();
    expect(archifyPages).toEqual(['catalog.html', 'checkout-api.html', 'fulfilment.html', 'landscape.html', 'ordering.html', 'payments.html', 'platform.html', 'storefront.html']);
    expect(readFileSync(join(assets, 'archify', 'landscape.html'), 'utf8')).toContain('<svg');
    expect(existsSync(join(out, 'source', 'docs', 'stylesheets', 'wiki.css'))).toBe(true);
    expect(existsSync(join(out, 'source', 'docs', 'javascripts', 'wiki-diagram.mjs'))).toBe(true);
    const toml = readFileSync(join(out, 'source', 'zensical.toml'), 'utf8');
    expect(toml).toContain('extra_css = ["stylesheets/wiki.css"]');
    expect(toml).toContain('{ path = "assets/likec4-view.js", type = "module" }');
    expect(toml).toContain('{ path = "javascripts/wiki-diagram.mjs", type = "module" }');
  }, { timeout: 60_000 });

  test('the LikeC4 scratch lives in the moved cache root, never in the shared temporary folder', () => {
    const cache = scriptCache();
    const out = outFolder();
    expect(runWiki([REFERENCE_SYSTEM, '--out', out], undefined, cache).status).toBe(0);
    // The scratch — the rendered model and its archify pages — stays in
    // the private cache root the run named, kept there as a cache: the
    // root is the user's alone, and regenerating it costs a tool run. It
    // is private in its own right, not only behind the root.
    const scratchName = readdirSync(cache.MADARCH_WIKI_CACHE).find((name) => name.startsWith('likec4-'))!;
    const scratch = join(cache.MADARCH_WIKI_CACHE, scratchName);
    expect(existsSync(join(scratch, 'model.c4'))).toBe(true);
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
    // And no predictable scratch of the old shape is created in /tmp.
    expect(readdirSync(tmpdir()).some((name) => name.startsWith('madarch-wiki-likec4-'))).toBe(false);
  }, { timeout: 60_000 });

  test('the documents fixture becomes pages on both engines, links rewritten and images copied', () => {
    // Zensical: relative links, the image under docs/assets, folders in the nav.
    const zensical = outFolder();
    expect(runWiki([DOCUMENTS_FIXTURE, '--out', zensical]).status).toBe(0);
    const docs = join(zensical, 'source', 'docs');
    expect(existsSync(join(docs, 'index.md'))).toBe(true);
    expect(existsSync(join(docs, 'domains', 'ordering.md'))).toBe(true);
    const architecture = readFileSync(join(docs, 'documents', 'docs', 'architecture.md'), 'utf8');
    expect(architecture).toContain('# Architecture');
    expect(architecture).toContain('[the decision record](decisions/0001-use-grpc.md)');
    expect(architecture).toContain('[the README](../README.md#documents-fixture)');
    expect(architecture).toContain('![Overview](/assets/documents/docs/img/overview.png)');
    expect(architecture).toContain('<div class="mermaid">');
    expect(architecture).toContain('flowchart LR');
    expect(architecture).toContain('{a, b}');
    expect(architecture).toContain('&lt;T>');
    // A repository's markup is text in the built page, never elements.
    expect(architecture).toContain('&lt;script>alert("wiki")&lt;/script>');
    expect(architecture).toContain('&lt;img src=x onerror="alert(1)">');
    expect(architecture.includes('<script')).toBe(false);
    expect(architecture.includes('<img')).toBe(false);
    const decision = readFileSync(join(docs, 'documents', 'docs', 'decisions', '0001-use-grpc.md'), 'utf8');
    expect(decision.startsWith('# 0001-use-grpc\n\n')).toBe(true);
    expect(decision).toContain('not a link: [fake](also-missing.md)');
    expect(readFileSync(join(docs, 'documents', 'README.md'), 'utf8')).toContain('# Documents fixture');
    expect(readFileSync(join(docs, 'documents', 'madarch', 'review.md'), 'utf8')).toContain('# Architecture review');
    expect(existsSync(join(docs, 'assets', 'documents', 'docs', 'img', 'overview.png'))).toBe(true);
    const toml = readFileSync(join(zensical, 'source', 'zensical.toml'), 'utf8');
    expect(toml).toContain('{ "Documents" = [{ "Documents fixture" = "documents/README.md" }');
    expect(toml).toContain('{ "docs" = [{ "Architecture" = "documents/docs/architecture.md" }, { "decisions" = [{ "0001-use-grpc" = "documents/docs/decisions/0001-use-grpc.md" }] }] }');
    expect(toml).toContain('{ "madarch" = [{ "Architecture review" = "documents/madarch/review.md" }] }');

    // Starlight: root-relative routes slugged the engine's way, the image
    // under public/assets, the sidebar entries the loader slugs the same way.
    const cache = scriptCache();
    const starlight = outFolder();
    expect(runWiki([DOCUMENTS_FIXTURE, '--out', starlight, '--engine', 'starlight'], `${FAKE_BUN}:${process.env.PATH ?? ''}`, cache).status).toBe(0);
    const sdocs = join(starlight, 'source', 'src', 'content', 'docs');
    expect(readFileSync(join(sdocs, 'documents', 'README.md'), 'utf8')).toContain('title: "Documents fixture"');
    const sArchitecture = readFileSync(join(sdocs, 'documents', 'docs', 'architecture.md'), 'utf8');
    expect(sArchitecture).toContain('[the decision record](/documents/docs/decisions/0001-use-grpc/)');
    expect(sArchitecture).toContain('[the README](/documents/readme/#documents-fixture)');
    expect(sArchitecture).toContain('![Overview](/assets/documents/docs/img/overview.png)');
    expect(existsSync(join(starlight, 'source', 'public', 'assets', 'documents', 'docs', 'img', 'overview.png'))).toBe(true);
    const sidebar = readFileSync(join(starlight, 'source', 'src', 'generated', 'site.mjs'), 'utf8');
    expect(sidebar).toContain('"documents/readme"');
    expect(sidebar).toContain('"documents/docs/decisions/0001-use-grpc"');
  }, { timeout: 60_000 });

  test('a document linking a missing document fails the build naming both, before anything is written', () => {
    const root = tempFolder('madarch-wiki-broken-doc-');
    cpSync(DOCUMENTS_FIXTURE, root, { recursive: true });
    writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n\n[Missing](missing.md)\n');
    const out = outFolder();
    const run = runWiki([root, '--out', out]);
    expect(run.status).toBe(1);
    const said = combined(run);
    expect(said).toContain('docs/guide.md');
    expect(said).toContain('docs/missing.md');
    expect(existsSync(join(out, 'source'))).toBe(false);
  }, { timeout: 60_000 });

  test('two documents one starlight route would serve are refused with exit 2, before anything is written', () => {
    const root = tempFolder('madarch-wiki-routecoll-');
    cpSync(DOCUMENTS_FIXTURE, root, { recursive: true });
    writeFileSync(join(root, 'docs', 'A.md'), '# Uppercase\n');
    writeFileSync(join(root, 'docs', 'a.md'), '# Lowercase\n');
    const out = outFolder();
    const run = runWiki([root, '--out', out, '--engine', 'starlight'], `${FAKE_BUN}:${process.env.PATH ?? ''}`, scriptCache());
    expect(run.status).toBe(2);
    const said = combined(run);
    expect(said).toContain('docs/A.md and docs/a.md');
    expect(said).toContain('/documents/docs/a/');
    expect(existsSync(join(out, 'source'))).toBe(false);
  }, { timeout: 60_000 });

  test('the same repository builds under zensical, both documents keeping a page of their own', () => {
    const root = tempFolder('madarch-wiki-routecoll-');
    cpSync(DOCUMENTS_FIXTURE, root, { recursive: true });
    writeFileSync(join(root, 'docs', 'A.md'), '# Uppercase\n');
    writeFileSync(join(root, 'docs', 'a.md'), '# Lowercase\n');
    const out = outFolder();
    expect(runWiki([root, '--out', out]).status).toBe(0);
    expect(existsSync(join(out, 'source', 'docs', 'documents', 'docs', 'A.md'))).toBe(true);
    expect(existsSync(join(out, 'source', 'docs', 'documents', 'docs', 'a.md'))).toBe(true);
  }, { timeout: 60_000 });

  test('a document that is a symlink out of the repository is refused with exit 2, naming the file and where it points', () => {
    const root = tempFolder('madarch-wiki-symlink-');
    cpSync(DOCUMENTS_FIXTURE, root, { recursive: true });
    const outside = tempFolder('madarch-wiki-outside-');
    writeFileSync(join(outside, 'elsewhere.md'), 'stolen\n');
    rmSync(join(root, 'README.md'));
    symlinkSync(join(outside, 'elsewhere.md'), join(root, 'README.md'));
    const out = outFolder();
    const run = runWiki([root, '--out', out]);
    expect(run.status).toBe(2);
    const said = combined(run);
    expect(said).toContain(join(root, 'README.md'));
    expect(said).toContain(join(outside, 'elsewhere.md'));
    expect(existsSync(out)).toBe(false);
  }, { timeout: 60_000 });

  test('a referenced image is copied as file content, never as a link in the built tree', () => {
    const root = tempFolder('madarch-wiki-imglink-');
    cpSync(DOCUMENTS_FIXTURE, root, { recursive: true });
    writeFileSync(join(root, 'docs', 'img', 'real-extra.png'), readFileSync(join(root, 'docs', 'img', 'overview.png')));
    symlinkSync('real-extra.png', join(root, 'docs', 'img', 'extra.png'));
    const doc = join(root, 'docs', 'architecture.md');
    writeFileSync(doc, readFileSync(doc, 'utf8').replace('![Overview](img/overview.png)', '![Overview](img/overview.png)\n\n![Extra](img/extra.png)\n'));
    const out = outFolder();
    expect(runWiki([root, '--out', out]).status).toBe(0);
    const copied = join(out, 'source', 'docs', 'assets', 'documents', 'docs', 'img', 'extra.png');
    expect(lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(statSync(copied).isFile()).toBe(true);
    expect(readFileSync(copied)).toEqual(readFileSync(join(root, 'docs', 'img', 'real-extra.png')));
  }, { timeout: 60_000 });
});

describe('scripts/wiki.ts with a real Zensical build', () => {
  test.skipIf(!process.env.MADARCH_WIKI_E2E)(
    'builds the reference system into a real static site',
    () => {
      const out = outFolder();
      const run = runWiki([REFERENCE_SYSTEM, '--out', out], process.env.PATH ?? '');
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(resolve(out, 'site'));
      expect(existsSync(join(out, 'site', 'index.html'))).toBe(true);
      expect(existsSync(join(out, 'source', 'docs', 'index.md'))).toBe(true);
    },
    { timeout: 180_000 },
  );

  test.skipIf(!process.env.MADARCH_WIKI_E2E)(
    'two real builds of the same repository give byte-identical source trees, and the built site passes the link check',
    () => {
      const first = outFolder();
      const second = outFolder();
      // Exit 0 is itself the link check passing on a real built site.
      expect(runWiki([REFERENCE_SYSTEM, '--out', first], process.env.PATH ?? '').status).toBe(0);
      expect(runWiki([REFERENCE_SYSTEM, '--out', second], process.env.PATH ?? '').status).toBe(0);
      const entries = (files: Map<string, string>): [string, string][] =>
        [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      expect(entries(walkFiles(join(first, 'source')))).toEqual(entries(walkFiles(join(second, 'source'))));
    },
    { timeout: 300_000 },
  );
});

describe('scripts/wiki.ts with a real Starlight build', () => {
  const REAL_PATH = process.env.PATH ?? '';

  test.skipIf(!process.env.MADARCH_WIKI_E2E)(
    'builds the reference system into a real Starlight site, tabs and assets shipped',
    () => {
      // The real build installs into this run's own moved cache: nothing
      // of it ever sits where a real developer's install lives.
      const cache = scriptCache();
      const out = outFolder();
      const run = runWiki([REFERENCE_SYSTEM, '--out', out, '--engine', 'starlight'], REAL_PATH, cache);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(resolve(out, 'site'));
      expect(existsSync(join(out, 'site', 'index.html'))).toBe(true);
      // The diagram tab contract in the built HTML, with the module and the
      // runtimes the site ships beside it.
      const ordering = readFileSync(join(out, 'site', 'domains', 'ordering', 'index.html'), 'utf8');
      expect(ordering).toContain('class="wiki-diagram"');
      expect(ordering).toContain('<likec4-view view-id="ordering"></likec4-view>');
      expect(ordering).toContain('/wiki-diagram.mjs');
      expect(existsSync(join(out, 'site', 'assets', 'likec4-view.js'))).toBe(true);
      expect(existsSync(join(out, 'site', 'assets', 'mermaid', 'mermaid.esm.min.mjs'))).toBe(true);
      expect(existsSync(join(out, 'site', 'wiki-diagram.mjs'))).toBe(true);
    },
    { timeout: 300_000 },
  );

  test.skipIf(!process.env.MADARCH_WIKI_E2E)(
    'two real Starlight builds give byte-identical source trees',
    () => {
      const first = outFolder();
      const second = outFolder();
      const cache = scriptCache();
      expect(runWiki([REFERENCE_SYSTEM, '--out', first, '--engine', 'starlight'], REAL_PATH, cache).status).toBe(0);
      expect(runWiki([REFERENCE_SYSTEM, '--out', second, '--engine', 'starlight'], REAL_PATH, cache).status).toBe(0);
      const entries = (files: Map<string, string>): [string, string][] =>
        [...files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      expect(entries(walkFiles(join(first, 'source')))).toEqual(entries(walkFiles(join(second, 'source'))));
    },
    { timeout: 300_000 },
  );

  test.skipIf(!process.env.MADARCH_WIKI_E2E)(
    'both engines write the same pages',
    () => {
      const zensical = outFolder();
      const starlight = outFolder();
      expect(runWiki([REFERENCE_SYSTEM, '--out', zensical], REAL_PATH).status).toBe(0);
      const samePagesCache = scriptCache();
      expect(runWiki([REFERENCE_SYSTEM, '--out', starlight, '--engine', 'starlight'], REAL_PATH, samePagesCache).status).toBe(0);
      const docFiles = (root: string): string[] =>
        [...walkFiles(root).keys()].filter((file) => file.endsWith('.md')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(docFiles(join(starlight, 'source', 'src', 'content', 'docs'))).toEqual(docFiles(join(zensical, 'source', 'docs')));
      // Starlight names the page by its frontmatter title once: the body
      // carries the invisible title anchor, not a second heading.
      const starlightHome = readFileSync(join(starlight, 'source', 'src', 'content', 'docs', 'index.md'), 'utf8');
      expect(starlightHome).toContain('title: "Home"');
      expect(starlightHome).toContain('<span id="home"></span>');
      expect(starlightHome).not.toContain('# Home');
      expect(readFileSync(join(zensical, 'source', 'docs', 'index.md'), 'utf8')).toContain('# Home');
    },
    { timeout: 300_000 },
  );
});

describe('scripts/wiki.ts with real builds over the documents fixture', () => {
  const REAL_PATH = process.env.PATH ?? '';

  test.skipIf(!process.env.MADARCH_WIKI_E2E)(
    'the zensical wiki holds the documents and passes the link check',
    () => {
      const out = outFolder();
      // Exit 0 is the link check passing on the real built site.
      expect(runWiki([DOCUMENTS_FIXTURE, '--out', out], REAL_PATH).status).toBe(0);
      const site = join(out, 'site');
      expect(existsSync(join(site, 'documents', 'docs', 'architecture', 'index.html'))).toBe(true);
      expect(existsSync(join(site, 'documents', 'docs', 'decisions', '0001-use-grpc', 'index.html'))).toBe(true);
      // Zensical serves a README.md as its folder's index, the way mkdocs does.
      expect(existsSync(join(site, 'documents', 'index.html'))).toBe(true);
      expect(existsSync(join(site, 'documents', 'madarch', 'review', 'index.html'))).toBe(true);
      expect(existsSync(join(site, 'assets', 'documents', 'docs', 'img', 'overview.png'))).toBe(true);
      const built = readFileSync(join(site, 'documents', 'docs', 'architecture', 'index.html'), 'utf8');
      expect(built).toContain('<div class="mermaid"');
      expect(built).toContain('src="/assets/documents/docs/img/overview.png"');
    },
    { timeout: 300_000 },
  );

  test.skipIf(!process.env.MADARCH_WIKI_E2E)(
    'no script or event handler of a document reaches the built site as markup, on either engine',
    () => {
      for (const [engine, env] of [['zensical', {}], ['starlight', scriptCache()]] as const) {
        const out = outFolder();
        expect(runWiki([DOCUMENTS_FIXTURE, '--out', out, ...(engine === 'zensical' ? [] : ['--engine', 'starlight'])], REAL_PATH, env).status).toBe(0);
        // The document's markup is on the page, as characters:
        const built = readFileSync(join(out, 'site', 'documents', 'docs', 'architecture', 'index.html'), 'utf8');
        expect(built).toContain('alert(');
        // ...and nowhere in the site does it stand as an element: no
        // document-authored script block or event handler survived. Only
        // the HTML files are parsed as markup — the site's own bundles
        // carry the characters '<script' inside program strings.
        for (const [file, body] of walkFiles(join(out, 'site'))) {
          expect(/<script[^>]*>[^<]*alert\(/.test(body)).toBe(false);
          if (file.endsWith('.html')) {
            expect(body.replace(/<script[\s\S]*?<\/script>/g, '').includes('<script')).toBe(false);
            expect(/<(?:img|svg|iframe|body)[^>]*onerror/.test(body)).toBe(false);
          }
        }
      }
    },
    { timeout: 600_000 },
  );

  test.skipIf(!process.env.MADARCH_WIKI_E2E)(
    'the starlight wiki holds the documents and passes the link check',
    () => {
      const cache = scriptCache();
      const out = outFolder();
      expect(runWiki([DOCUMENTS_FIXTURE, '--out', out, '--engine', 'starlight'], REAL_PATH, cache).status).toBe(0);
      const site = join(out, 'site');
      // The engine slugs the file names onto routes: README.md is readme.
      expect(existsSync(join(site, 'documents', 'docs', 'architecture', 'index.html'))).toBe(true);
      expect(existsSync(join(site, 'documents', 'readme', 'index.html'))).toBe(true);
      expect(existsSync(join(site, 'documents', 'madarch', 'review', 'index.html'))).toBe(true);
      expect(existsSync(join(site, 'assets', 'documents', 'docs', 'img', 'overview.png'))).toBe(true);
    },
    { timeout: 300_000 },
  );
});
