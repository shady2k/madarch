/**
 * The acceptance walk of a madarch checkout filled by the deterministic stages
 * (madarch-tzte.23.5; decision 0026, "Pages" and "Diagrams").
 *
 * The walk is one-time evidence, not a test: it makes a product of a shallow clone of
 * madarch at its default branch — a product repository holding `workspace.yaml` and
 * `docs/vision.md`, and the checkout declared as its code repository `engine` under
 * `repos/`, as `madarch new` and `madarch repo add` leave a product — runs the eight
 * deterministic stages over it through the orchestrator the background server owns
 * (decision 0027), serves that product's wiki from the same process, and opens the
 * pages a reader sees in headless Chromium at the owner's 1150x900 window:
 *
 *   - the graph's index and the pages of a repository, a module, a package and a
 *     symbol, with their facts, assumptions, relations and coverage, and their code
 *     places linked to the repository's host at the pinned commit;
 *   - every diagram type those pages draw, in every renderer tab that supports it,
 *     with the first tab following `MADARCH_WIKI_DIAGRAM`, the labels the browser
 *     drew, the boxes that overlap and the dashes the model carries;
 *   - the document page of a file of the product beside the graph's pages, and the
 *     refusal a file's own fact id gets (a file is a place, not a page: 0026's
 *     "Pages" reads a page as a page *about* a node);
 *   - and a page appearing in the open browser while a second run publishes, after a
 *     one-file commit in the code repository: the run reads its pins again, the new
 *     symbol's page joins the index, and the page the walk set a flag on was never
 *     reloaded.
 *
 * Usage (on the pod, through `madarch-sky-test --avx2 --cmd`):
 *
 *   cd wiki/app && bun install --frozen-lockfile && bun run build && cd ../..
 *   bun scripts/graph-pages-walk.ts --phase all --workers 8
 *
 * Phases: `first` makes the product and runs the first fill; `live` serves the store
 * that fill left and walks the browser; `all` does both; `probe` reads the store's
 * page set, one page and one diagram model and prints what each cost, which is how a
 * slow page of a real product is measured before a browser waits on it. The scratch
 * folder (`--root`, `/tmp/madarch-runtime/artifacts/walk23-5` by default) keeps the
 * product, the products home with the fill's store, the wiki cache and the
 * screenshots, so a second call resumes a phase a failed one left behind instead of
 * paying for the fill again. `--copy-into <folder>` copies the screenshots and the
 * report into the worktree, where `madarch-sky-test --fetch` can take them.
 *
 * Every number the walk reads is printed as a `STAGE23_WALK` line (JSON) and written
 * whole into `<root>/report.json`; the change record quotes them.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Frame, type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { countPublishedFactsByKind } from '../src/fill/fact-store.js';
import { PAGE_KINDS, PAGE_SET_FETCH, PAGE_SET_HELD_SQL, PAGE_SET_KINDS_SQL, pageAddress } from '../src/fill/graph-pages.js';
import { createFillOrchestratorService, fillDatabasePath, type FillOrchestratorService, type FillRunResult } from '../src/fill/orchestrator-host.js';
import { createStagesFill, type StagesFill } from '../src/product/fill-stages.js';
import { startServer, type StartedServer } from '../src/index.js';
import { LIKEC4_DRAWINGS_SOURCE } from '../src/product-wiki/likec4-drawings.js';
import { byCodePoint } from '../src/model/order.js';
import { buildFactStoreDiagram } from '../src/fill/diagrams.js';
import { answerGraphRead, type GraphRead } from '../src/fill/graph-reads.js';
import { FACT_EDGE_KINDS } from '../src/fill/facts.js';

/** This script's own name, in front of every error it raises (the project's rule for a message). */
const SELF = fileURLToPath(import.meta.url);

/** One error of the walk, naming this file and the step that raised it. */
/** The line of this script that raised one of its own errors, or '?' where the stack does not say. */
function callerLine(): string {
  const frames = (new Error().stack ?? '').split('\n').filter((line) => line.includes(SELF));
  const caller = frames[1] ?? frames[0] ?? '';
  return /:(\d+):\d+\)?$/u.exec(caller)?.[1] ?? '?';
}

function failedAt(where: string, message: string): Error {
  return new Error(`${SELF}:${callerLine()} (${where}): ${message}`);
}

// ---- the walk's own options -------------------------------------------------

interface WalkOptions {
  readonly phase: 'all' | 'first' | 'live' | 'probe' | 'speed' | 'explain';
  readonly root: string;
  readonly origin: string;
  readonly pin: string;
  readonly app: string;
  readonly workers: number;
  readonly copyInto: string | undefined;
  readonly firstRun: string;
  readonly secondRun: string;
  /** The madarch revision the app and the walk were built from, named by the caller: the pod's staged folder is no git checkout. */
  readonly revision: string;
}

const WORKTREE = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseOptions(argv: readonly string[]): WalkOptions {
  const flags = new Map<string, string>();
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]!;
    if (!arg.startsWith('--')) throw failedAt('the arguments', `unknown argument ${JSON.stringify(arg)}: every argument is --name value`);
    const value = argv[at + 1];
    if (value === undefined || value.startsWith('--')) throw failedAt('the arguments', `${arg} needs a value`);
    flags.set(arg.slice(2), value);
    at += 1;
  }
  const phase = flags.get('phase') ?? 'all';
  if (phase !== 'all' && phase !== 'first' && phase !== 'live' && phase !== 'probe' && phase !== 'speed' && phase !== 'explain') throw failedAt('the arguments', `--phase ${JSON.stringify(phase)} is none of all, first, live, probe, speed, explain`);
  const workers = Number(flags.get('workers') ?? '8');
  if (!Number.isInteger(workers) || workers < 1 || workers > 64) throw failedAt('the arguments', '--workers is a whole number from 1 to 64');
  const copyInto = flags.get('copy-into');
  // A folder of the worktree, never the worktree itself: the copy replaces what it
  // finds, and a mistyped `--copy-into .` would delete the checkout.
  const into = copyInto === undefined ? undefined : resolve(WORKTREE, copyInto);
  if (into !== undefined && (into === WORKTREE || !into.startsWith(WORKTREE + sep))) {
    throw failedAt('the arguments', `--copy-into ${JSON.stringify(copyInto)} is no folder inside ${WORKTREE}: the copy replaces the folder it names`);
  }
  // The run ids carry the moment, so a second call on one scratch folder plans a new
  // run rather than asking for one that already stands.
  const stamp = new Date().toISOString().replace(/[-:.]/gu, '').replace(/Z$/u, 'Z');
  return {
    phase,
    root: resolve(flags.get('root') ?? process.env.MADARCH_WALK_ROOT ?? '/tmp/madarch-runtime/artifacts/walk23-5'),
    origin: flags.get('origin') ?? process.env.MADARCH_WALK_ORIGIN ?? 'https://github.com/shady2k/madarch.git',
    pin: flags.get('pin') ?? 'main',
    app: resolve(flags.get('app') ?? join(WORKTREE, 'wiki', 'app', 'dist')),
    workers,
    copyInto: into,
    firstRun: flags.get('first-run') ?? `stage23-walk-first-${stamp}`,
    secondRun: flags.get('second-run') ?? `stage23-walk-second-${stamp}`,
    revision: flags.get('revision') ?? 'unnamed',
  };
}

// ---- what the walk reports --------------------------------------------------

const report: Record<string, unknown> = {};
const said: string[] = [];

/** One measured fact of the walk: printed as a `STAGE23_WALK` line and kept for the report. */
function measure(name: string, value: unknown): void {
  report[name] = value;
  const line = `STAGE23_WALK ${JSON.stringify({ name, value })}`;
  said.push(line);
  console.log(line);
}

/** One line of the walk's own progress, not a measurement (the log keeps it, the report does not). */
function say(line: string): void {
  console.log(`walk: ${line}`);
}

function writeReport(options: WalkOptions): void {
  mkdirSync(options.root, { recursive: true });
  writeFileSync(join(options.root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(options.root, 'report.txt'), `${said.join('\n')}\n`);
  say(`report: ${join(options.root, 'report.json')}`);
}

/** Copies what the coordinator reads into the worktree, where `--fetch` can take it. */
function copyResults(options: WalkOptions): void {
  writeReport(options);
  if (options.copyInto === undefined) return;
  rmSync(options.copyInto, { recursive: true, force: true });
  mkdirSync(options.copyInto, { recursive: true });
  const shots = join(options.root, 'shots');
  if (existsSync(shots)) cpSync(shots, join(options.copyInto, 'shots'), { recursive: true });
  for (const name of ['report.json', 'report.txt']) cpSync(join(options.root, name), join(options.copyInto, name));
  say(`copied the screenshots and the report into ${options.copyInto}`);
}

// ---- programs ---------------------------------------------------------------

/** One program's run, refused with the step, the command line and the program's own words. */
function run(step: string, command: readonly string[]): string {
  try {
    return execFileSync(command[0]!, command.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const held = error as { stderr?: Buffer | string; status?: number };
    throw failedAt(step, `${command.join(' ')} refused it (exit ${String(held.status ?? 'unknown')}): ${String(held.stderr ?? '').trim()}`);
  }
}

// ---- git --------------------------------------------------------------------

/** One git answer, refused with the command, the folder and git's own words. */
function git(folder: string, args: readonly string[], identity = false): string {
  const prefix = identity ? ['-c', 'user.name=stage-23-walk', '-c', 'user.email=stage-23-walk@example.invalid'] : [];
  try {
    return execFileSync('git', ['-C', folder, ...prefix, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const held = error as { stderr?: Buffer | string; status?: number };
    throw failedAt(`git ${args.join(' ')}`, `${folder} refused it (exit ${String(held.status ?? 'unknown')}): ${String(held.stderr ?? '').trim()}`);
  }
}

// ---- the product ------------------------------------------------------------

interface Product {
  /** The product repository: its manifest, its documents, and `repos/` untracked. */
  readonly folder: string;
  /** The code repository the walk's pages are about, cloned under the product. */
  readonly code: string;
  /** The name the manifest gives that code repository. */
  readonly codeName: string;
  readonly home: string;
}

/** The product's own document, so the walk opens a document page beside the graph's pages. */
const PRODUCT_VISION = '# Stage 23 product\n\nThe product the stage-23 acceptance walk fills: a madarch checkout, declared as its code repository.\n';

/**
 * The scratch product, shaped as `madarch new` and `madarch repo add` leave one: a
 * product repository holding `workspace.yaml` and `docs/vision.md` with `repos/`
 * untracked, and the code repository cloned under `repos/` at the pin. A product that
 * stands is reused, so a second phase pays for neither the product nor the clone.
 */
function prepareProduct(options: WalkOptions): Product {
  const folder = join(options.root, 'product');
  const home = join(options.root, 'home');
  const codeName = 'engine';
  const code = join(folder, 'repos', codeName);
  mkdirSync(home, { recursive: true });
  if (!existsSync(join(folder, '.git'))) {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    run('git init', ['git', 'init', '--initial-branch=main', folder]);
    // The manifest a draft product carries, plus the one code repository it spans.
    writeFileSync(join(folder, 'workspace.yaml'), [
      'schemaVersion: 1',
      `id: ${randomUUID()}`,
      'name: stage23-product',
      'repos:',
      `  - name: ${codeName}`,
      `    url: ${options.origin}`,
      // The repository's default branch, which is what the manifest declares; the
      // checkout itself stands at `--pin`, which may be a commit's forty digits.
      `    branch: ${/^[0-9a-f]{40}$/u.test(options.pin) ? 'main' : options.pin}`,
      '',
    ].join('\n'));
    writeFileSync(join(folder, '.gitignore'), 'repos/\n');
    mkdirSync(join(folder, 'docs'), { recursive: true });
    writeFileSync(join(folder, 'docs', 'vision.md'), PRODUCT_VISION);
    git(folder, ['add', 'workspace.yaml', '.gitignore', 'docs/vision.md'], true);
    git(folder, ['commit', '-m', 'The stage-23 walk makes this product', '--no-verify'], true);
  }
  if (!existsSync(join(code, '.git'))) {
    rmSync(code, { recursive: true, force: true });
    say(`cloning ${options.origin} at ${options.pin} into ${code}`);
    // A shallow fetch of the pin itself: a branch, a tag or the forty digits of a
    // commit, which `git clone --branch` cannot take.
    run('git init', ['git', 'init', '--initial-branch=main', code]);
    run('git remote add', ['git', '-C', code, 'remote', 'add', 'origin', options.origin]);
    run(`git fetch --depth 1 ${options.pin}`, ['git', '-C', code, 'fetch', '--depth', '1', 'origin', options.pin]);
    run('git checkout FETCH_HEAD', ['git', '-C', code, 'checkout', '--detach', 'FETCH_HEAD']);
  }
  const head = git(folder, ['rev-parse', 'HEAD']);
  const codeHead = git(code, ['rev-parse', 'HEAD']);
  const files = git(code, ['ls-files']).split('\n').filter((line) => line !== '').length;
  say(`the product stands on ${head}, its code repository ${codeName} on ${codeHead} (${String(files)} tracked files)`);
  return { folder, code, codeName, home };
}

// ---- the fill ---------------------------------------------------------------

interface Fill {
  readonly owner: DatabaseOwner;
  readonly stages: StagesFill;
  readonly service: FillOrchestratorService;
}

/**
 * The fill of one product in this process: the stages wiring madarch-tzte.21.8 landed,
 * the orchestrator service the background server owns (decision 0027), and the store
 * both read. The service is given the owner the process opened, so one process owns
 * the database and its pages are read without a second writer.
 */
async function openFill(options: WalkOptions, product: Product): Promise<Fill> {
  mkdirSync(join(product.home, '.madarch', 'fill'), { recursive: true });
  let started = Date.now();
  const owner = createPGliteDatabaseOwner({ path: fillDatabasePath(product.home) });
  const stages = await createStagesFill({ product: product.folder, database: owner });
  say(`the stages wiring stood in ${String(Date.now() - started)} ms`);
  const service = createFillOrchestratorService({
    home: product.home,
    owner,
    registry: stages.registry,
    wiring: () => stages.wiring,
    limits: { maxInFlight: options.workers },
    workers: options.workers,
    maxPasses: 100_000,
  });
  return { owner, stages, service };
}

async function closeFill(fill: Fill): Promise<void> {
  try {
    await fill.service.stop();
  } finally {
    await fill.owner.close();
  }
}

/** One fill run, awaited; the run's own numbers are recorded as the walk's. */
async function runFill(fill: Fill, name: string, runId: string): Promise<FillRunResult | null> {
  const started = Date.now();
  const result = await fill.service.run({ product: fill.stages.product, runId });
  const elapsedMs = Date.now() - started;
  if (result.ok === false) {
    measure(name, { refused: true, code: result.code, reason: result.reason, elapsedMs });
    return null;
  }
  const inherited = new Set(result.reused);
  const units = [...result.units].map((unit) => unit.unitId).sort(byCodePoint);
  const counts = await countPublishedFactsByKind(fill.owner);
  measure(name, {
    runId: result.runId,
    state: result.state,
    settled: result.settled,
    passes: result.passes,
    elapsedMs,
    units: units.length,
    executed: units.filter((unit) => !inherited.has(unit)).length,
    inherited: inherited.size,
    unitsByStage: countBy(units.map((unit) => unit.split('/')[0] ?? unit)),
    factsByKind: counts,
    foundNothing: [...result.foundNothing].sort(byCodePoint),
  });
  return result;
}

/** One list's counts, keyed by the string each item starts with, in code point order. */
function countBy(items: readonly string[]): Record<string, number> {
  const held: Record<string, number> = {};
  for (const item of items) held[item] = (held[item] ?? 0) + 1;
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(held).sort(byCodePoint)) sorted[key] = held[key]!;
  return sorted;
}

// ---- the browser ------------------------------------------------------------

/** A fresh page at the owner's window, with every failed answer and every script error named. */
async function newPage(browser: Browser, note: (line: string) => void): Promise<Page> {
  const opened = await browser.newPage();
  await opened.setViewport({ width: 1150, height: 900 });
  opened.on('response', (response) => {
    if (response.status() >= 400) note(`browser: ${String(response.status())} ${response.url()}`);
  });
  opened.on('pageerror', (error: unknown) => note(`browser error: ${error instanceof Error ? error.message : String(error)}`));
  opened.on('console', (message) => {
    if (message.type() === 'error') note(`console error: ${message.text()}`);
  });
  return opened;
}

/** One measurement of one renderer's drawing, as the browser computed it. */
interface Measured {
  readonly diagram: string;
  readonly renderer: string;
  readonly nodes: number;
  readonly width: number;
  readonly height: number;
  readonly labels: number;
  readonly smallestLabel: number;
  readonly overlaps: number;
  readonly texts: number;
}

/** What the browser computed for one drawing: its boxes, its label sizes and the boxes that overlap. */
async function measureDrawing(target: Page | Frame, scope: string | null, renderer: string, diagram: string): Promise<Measured> {
  const boxes = await target.evaluate((options: { scope: string | null; archify: boolean }) => {
    // A scope that is not there is a failure of the measurement, never the whole page.
    const scoped = options.scope === null ? null : document.querySelector(options.scope);
    if (options.scope !== null && scoped === null) throw new Error(`the drawing's own box ${options.scope} is not on the page`);
    const root: ParentNode = scoped ?? document.body;
    const area = (element: Element): number => {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    };
    const svg = [...root.querySelectorAll('svg')].sort((one, two) => area(two) - area(one))[0] ?? null;
    const box = svg === null ? { width: 0, height: 0 } : svg.getBoundingClientRect();
    const sizes = [...root.querySelectorAll('svg text, .nodeLabel, .edgeLabel')]
      .map((label) => Number.parseFloat(getComputedStyle(label).fontSize))
      .filter((size) => Number.isFinite(size) && size > 0);
    const nodes = [...root.querySelectorAll(options.archify ? 'g[id^="node-"]' : 'svg g.node')].map((node) => node.getBoundingClientRect());
    let overlaps = 0;
    for (let at = 0; at < nodes.length; at++) {
      for (let other = at + 1; other < nodes.length; other++) {
        const one = nodes[at]!;
        const two = nodes[other]!;
        if (one.width === 0 || two.width === 0) continue;
        if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) overlaps += 1;
      }
    }
    return {
      nodes: nodes.length,
      width: Math.round(box.width),
      height: Math.round(box.height),
      labels: sizes.length,
      smallestLabel: sizes.length === 0 ? 0 : Math.round(Math.min(...sizes) * 10) / 10,
      overlaps,
      texts: root.querySelectorAll('svg text').length,
    };
  }, { scope, archify: renderer === 'archify' });
  const line: Measured = { diagram, renderer, ...boxes };
  console.log(`STAGE23_WALK_DRAWING ${JSON.stringify(line)}`);
  return line;
}

/**
 * What a LikeC4 page holds: its drawings counted through the shadow roots, its labels,
 * and the page's own words when it could not draw. A page that says it drew nothing is
 * an answer, not a timeout: the walk records its words as the tab's result.
 */
async function likec4State(target: Page, id: string, type: string): Promise<{ svgs: number; texts: string[]; undrawn: string | null }> {
  const started = Date.now();
  let last: { svgs: number; texts: string[]; undrawn: string | null } | null = null;
  while (Date.now() - started < 60_000) {
    const frame = frameOf(target, 'likec4.html', id, type);
    if (frame !== undefined) {
      const held = await frame.evaluate((source: string) => {
        const element = [...document.querySelectorAll('*')].find((child) => child.tagName.toLowerCase().endsWith('-view')) as HTMLElement | undefined;
        const drawings = element === undefined ? [] : (new Function(`return (${source});`)() as (root: Element) => readonly Element[])(element);
        const texts: string[] = [];
        const collect = (root: ParentNode): void => {
          for (const node of root.querySelectorAll('*')) {
            const tag = node.tagName.toLowerCase();
            if (tag === 'style' || tag === 'script') continue;
            if (node.children.length === 0 && node.shadowRoot === null) {
              const text = (node.textContent ?? '').trim();
              if (text !== '') texts.push(text);
            }
            if (node.shadowRoot !== null) collect(node.shadowRoot);
          }
        };
        if (element !== undefined && element.shadowRoot !== null) collect(element.shadowRoot);
        return {
          svgs: drawings.length,
          texts: [...new Set(texts)],
          undrawn: document.querySelector('[data-likec4-undrawn]')?.getAttribute('data-likec4-undrawn') ?? null,
        };
      }, LIKEC4_DRAWINGS_SOURCE).catch(() => null);
      if (held !== null) {
        last = held;
        // A drawing with no sentence is the answer. The page says its sentence eight
        // seconds in and takes it back if a drawing arrives later, so a sentence is waited
        // out for a while before it is read as the page's final word.
        if (held.svgs > 0 && held.undrawn === null) return held;
        if (held.undrawn !== null) {
          const saidAt = Date.now();
          while (Date.now() - saidAt < 20_000) {
            await new Promise((rest) => setTimeout(rest, 500));
            const again = await frame.evaluate((source: string) => {
              const element = [...document.querySelectorAll('*')].find((child) => child.tagName.toLowerCase().endsWith('-view')) as HTMLElement | undefined;
              const drawings = element === undefined ? [] : (new Function(`return (${source});`)() as (root: Element) => readonly Element[])(element);
              return { svgs: drawings.length, undrawn: document.querySelector('[data-likec4-undrawn]')?.getAttribute('data-likec4-undrawn') ?? null };
            }, LIKEC4_DRAWINGS_SOURCE).catch(() => null);
            if (again !== null && again.svgs > 0 && again.undrawn === null) {
              const texts = await frame.evaluate((source: string) => {
                const element = [...document.querySelectorAll('*')].find((child) => child.tagName.toLowerCase().endsWith('-view')) as HTMLElement | undefined;
                const collected: string[] = [];
                const walk = (root: ParentNode): void => {
                  for (const node of root.querySelectorAll('*')) {
                    if (node.children.length === 0 && node.shadowRoot === null) {
                      const text = (node.textContent ?? '').trim();
                      if (text !== '') collected.push(text);
                    }
                    if (node.shadowRoot !== null) walk(node.shadowRoot);
                  }
                };
                if (element !== undefined && element.shadowRoot !== null) walk(element.shadowRoot);
                return [...new Set(collected)];
              }, LIKEC4_DRAWINGS_SOURCE).catch(() => [] as string[]);
              return { svgs: again.svgs, texts, undrawn: null };
            }
            if (again !== null) last = { ...last, ...again };
          }
          return last ?? held;
        }
      }
    }
    await new Promise((rest) => setTimeout(rest, 200));
  }
  return last ?? { svgs: 0, texts: [], undrawn: 'the LikeC4 page could not be read' };
}

/** The frame of one generated document, once the browser has it. */
function frameOf(page: Page, document: 'archify' | 'likec4.html', id: string, type: string): Frame | undefined {
  return page.frames().find((candidate) => {
    let held: string;
    try {
      held = decodeURIComponent(candidate.url());
    } catch {
      return false;
    }
    return held.includes('/api/graph/' + document) && held.includes(`id=${id}`) && held.includes(`type=${type}`);
  });
}

/** Waits for one generated document's frame and for it to draw something. */
async function waitForFrame(page: Page, document: 'archify' | 'likec4.html', id: string, type: string, timeoutMs = 120_000): Promise<Frame> {
  const started = Date.now();
  for (;;) {
    const frame = frameOf(page, document, id, type);
    if (frame !== undefined) {
      const drawn = await frame.evaluate(() => ({ ready: document.readyState, nodes: document.querySelectorAll('[data-node-id], g[id^="node-"], svg text').length })).catch(() => null);
      if (drawn !== null && drawn.ready === 'complete' && (document === 'likec4.html' || drawn.nodes > 0)) return frame;
    }
    if (Date.now() - started > timeoutMs) throw failedAt(`the ${document} page of ${type}`, `it never stood for ${id}: the frames are ${page.frames().map((candidate) => candidate.url()).join(', ')}`);
    await new Promise((rest) => setTimeout(rest, 200));
  }
}

/** One screenshot of the reader's own window, taken through a navigation race (the app moves pages on its own). */
async function shot(page: Page, path: string, options: { readonly fullPage?: boolean } = {}): Promise<void> {
  for (const attempt of [1, 2, 3]) {
    try {
      await page.screenshot({ path, fullPage: options.fullPage ?? false });
      return;
    } catch (error) {
      const raced = error instanceof Error && (error.message.includes('Execution context was destroyed') || error.message.includes('navigated or closed'));
      if (!raced || attempt === 3) throw error;
      await new Promise((rest) => setTimeout(rest, 300));
    }
  }
}

/**
 * One screenshot of one diagram's own frame — its tabs and the open panel — rather than
 * the window it happens to stand in: a reader checking a picture reads the drawing, and
 * a window shot of a long page shows whatever is at the top of it.
 */
async function shotPanel(page: Page, type: string, path: string): Promise<void> {
  const box = await page.evaluate((asked: string) => {
    const article = document.querySelector(`[data-diagram-type="${asked}"]`);
    if (article === null) return null;
    const parts = [article.querySelector('[data-testid="graph-diagram-tabs"]'), article.querySelector('[data-panel]')].filter((part) => part !== null);
    const rects = parts.map((part) => part.getBoundingClientRect());
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const top = Math.min(...rects.map((rect) => rect.top)) + window.scrollY;
    const bottom = Math.max(...rects.map((rect) => rect.bottom)) + window.scrollY;
    // The browser refuses a capture taller than its own bound; a diagram's frame is bounded by the same number.
    return { x: Math.max(0, left), y: Math.max(0, top), width: Math.max(1, right - left), height: Math.min(1600, Math.max(1, bottom - top)) };
  }, type);
  if (box === null) return;
  await page.screenshot({ path, clip: { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.floor(box.width), height: Math.floor(box.height) } });
}

/** The tabs one diagram offers and the one the app opened first; a diagram with no tab draws nothing. */
async function tabsOf(page: Page, type: string): Promise<{ offered: string[]; first: string; empty: string | null }> {
  return await page.evaluate((asked: string) => {
    const article = document.querySelector(`[data-diagram-type="${asked}"]`);
    const buttons = [...(article?.querySelectorAll('[data-testid="graph-diagram-tabs"] button') ?? [])];
    return {
      offered: buttons.map((button) => button.getAttribute('data-tab') ?? ''),
      first: buttons.find((button) => button.getAttribute('aria-selected') === 'true')?.getAttribute('data-tab') ?? '',
      empty: article?.querySelector('[data-testid="graph-diagram-empty"]')?.textContent?.trim() ?? null,
    };
  }, type);
}

/** One diagram's elements as the page lists them: what they are, their page, their place in code and how they stand. */
async function elementsOf(page: Page, type: string): Promise<unknown[]> {
  return await page.evaluate((asked: string) => {
    const rows = [...document.querySelectorAll(`[data-diagram-type="${asked}"] [data-testid="graph-diagram-elements"] li.graph-diagram-element`)];
    return rows.map((row) => ({
      label: row.querySelector('.graph-diagram-element-label')?.textContent ?? '',
      kind: row.querySelector('.graph-chip')?.textContent ?? '',
      evidence: row.querySelector('[data-testid="graph-diagram-evidence"]')?.textContent ?? '',
      element: row.getAttribute('data-element') ?? '',
      dashed: row.getAttribute('data-dashed') ?? '',
      page: row.querySelector('a.graph-diagram-element-label')?.getAttribute('href') ?? null,
      place: row.querySelector('[data-testid="graph-diagram-place"]')?.getAttribute('href') ?? null,
    }));
  }, type);
}

/** One diagram's arrows as the page lists them: their ends, how they stand and whether they are drawn dashed. */
async function edgesOf(page: Page, type: string): Promise<unknown[]> {
  return await page.evaluate((asked: string) => {
    const rows = [...document.querySelectorAll(`[data-diagram-type="${asked}"] [data-testid="graph-diagram-edges"] li.graph-diagram-edge`)];
    return rows.map((row) => ({
      ends: row.querySelector('.graph-diagram-edge-ends')?.textContent ?? '',
      label: row.querySelector('.graph-diagram-edge-label')?.textContent ?? '',
      evidence: row.querySelector('[data-testid="graph-diagram-edge-evidence"]')?.textContent ?? '',
      dashed: row.getAttribute('data-dashed') ?? '',
    }));
  }, type);
}

/** Opens one of a diagram's tabs and waits for that renderer to draw; answers how long it took. */
async function openTab(page: Page, id: string, type: string, renderer: 'archify' | 'likec4' | 'mermaid'): Promise<{ frame: Frame | undefined; elapsedMs: number; likec4?: { svgs: number; texts: string[]; undrawn: string | null } }> {
  const started = Date.now();
  await page.click(`[data-diagram-type="${type}"] button[data-tab="${renderer}"]`);
  if (renderer === 'mermaid') {
    await page.waitForSelector(`[data-diagram-type="${type}"] [data-testid="mermaid-diagram"] svg`, { timeout: 120_000 });
    return { frame: undefined, elapsedMs: Date.now() - started };
  }
  // A frame loads when it comes near the reader's window, so the page is scrolled to it first.
  await page.evaluate((asked: string) => document.querySelector(`[data-diagram-type="${asked}"] iframe`)?.scrollIntoView({ block: 'center' }), type);
  if (renderer === 'archify') {
    const frame = await waitForFrame(page, 'archify', id, type);
    return { frame, elapsedMs: Date.now() - started };
  }
  const held = await likec4State(page, id, type);
  return { frame: frameOf(page, 'likec4.html', id, type), elapsedMs: Date.now() - started, likec4: held };
}

/**
 * Opens one address and waits for a selector, three times: under the pod's load the
 * app's own document list is read under a five-second bound (23.3's app; 23.4's record
 * met the same line), and a reload is what a reader would do. A page that still does not
 * stand says what it shows instead.
 */
async function openUntil(page: Page, url: string, selector: string, what: string): Promise<number> {
  const started = Date.now();
  let held: unknown = null;
  for (const attempt of [1, 2, 3]) {
    // The time a page took is the time of the attempt that stood, not of the attempts a
    // failed load of the app's own document list cost before it.
    const attempted = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector(selector, { timeout: 60_000 });
      if (attempt > 1) say(`${what} stood on attempt ${String(attempt)} after ${String(Date.now() - started)} ms`);
      return Date.now() - attempted;
    } catch {
      held = await page.evaluate(() => ({
        url: window.location.pathname,
        title: document.title,
        body: (document.body?.innerText ?? '').replace(/\s+/gu, ' ').slice(0, 400),
        nodes: document.querySelectorAll('[data-testid="graph-node"],[data-testid="graph-node-missing"],[data-testid="graph-index"]').length,
      })).catch(() => null);
      say(`${what} did not stand on attempt ${String(attempt)}: ${JSON.stringify(held)}`);
      await new Promise((rest) => setTimeout(rest, 3000));
    }
  }
  throw failedAt(what, `${url} never stood in three attempts: ${JSON.stringify(held)}`);
}

/**
 * Waits for a node page's diagrams to settle: the app reads them after the page stands
 * (`useGraphDiagrams`), so a reader of `data-diagram-type` straight after the page is a
 * reader of nothing. Loading is not settled; a drawing, the page's own "no diagram"
 * words or a failed read is.
 */
async function waitDiagrams(page: Page, what: string): Promise<void> {
  try {
    await page.waitForFunction(() => {
      const section = document.querySelector('[data-testid="graph-diagrams"]');
      if (section === null) return false;
      if (section.querySelector('[data-testid="graph-diagrams-loading"]') !== null) return false;
      return section.querySelector('[data-testid="graph-diagram"]') !== null
        || section.querySelector('[data-testid="graph-diagram-none"]') !== null
        || section.querySelector('[data-testid="graph-diagrams-error"]') !== null;
    }, { timeout: 90_000 });
  } catch (error) {
    throw failedAt('the diagrams of a page', `${what} never settled its diagrams: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Opens one node's page and waits for it; answers how long the page took to stand. */
async function openNode(page: Page, base: string, id: string): Promise<number> {
  const started = await openUntil(page, `${base}${pageAddress(id)}`, '[data-testid="graph-node"]', `the page ${pageAddress(id)}`);
  await waitDiagrams(page, `the page ${pageAddress(id)}`);
  return started;
}

/** One node page's own numbers, as the reader sees them. */
async function pageNumbers(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const count = (selector: string): number => document.querySelectorAll(selector).length;
    const text = (selector: string): string => document.querySelector(selector)?.textContent?.trim() ?? '';
    const firstCodeLink = document.querySelector('[data-testid="graph-node"] a[href^="http"]')?.getAttribute('href') ?? null;
    // A code link is a place in code (`graph-place`, a fact's own provenance), not the
    // repository's origin link the page's fields carry: the walk counts places, and keeps
    // the origin link beside them so the two cannot be read as one.
    const places = [...document.querySelectorAll('[data-testid="graph-node"] a[data-testid="graph-place"][href], [data-testid="graph-node"] a[data-testid="graph-diagram-place"][href]')];
    const firstPlaceLink = places[0]?.getAttribute('href') ?? null;
    return {
      title: text('main#graph-node h1'),
      node: document.querySelector('main#graph-node')?.getAttribute('data-node') ?? null,
      fields: [...document.querySelectorAll('[data-testid="graph-node-fields"] > *')].map((row) => row.textContent?.trim() ?? ''),
      facts: count('[data-testid="graph-facts"] li.graph-fact'),
      assumptions: count('[data-testid="graph-assumptions"] li.graph-fact'),
      relations: count('[data-testid="graph-relations"] li.graph-relation'),
      relationsOut: count('[data-testid="graph-relations-out"] li.graph-relation'),
      relationsIn: count('[data-testid="graph-relations-in"] li.graph-relation'),
      coverage: count('[data-testid="graph-coverage"] li.graph-coverage'),
      questions: count('[data-testid="graph-questions"] li.graph-question'),
      drafts: count('[data-testid="graph-drafts"] li.graph-draft'),
      places: places.length,
      externalLinks: count('[data-testid="graph-node"] a[href^="http"]'),
      originLink: firstCodeLink,
      firstPlaceLink,
      placeLinks: places.map((link) => link.getAttribute('href') ?? '').slice(0, 5),
      diagrams: count('[data-testid="graph-diagram"]'),
      diagramsSlot: text('[data-testid="graph-diagram-none"]'),
      bodyText: (document.querySelector('main#graph-node')?.textContent ?? '').slice(0, 1500),
    };
  });
}

/** What one diagram's own frame holds right now: which renderer panel stands, and whether it drew. */
interface DiagramFrame {
  readonly type: string;
  /** The renderer whose panel is mounted, or null when the app holds the diagram back until it is in view. */
  readonly panel: string | null;
  /** Whether the panel's own drawing stands: a Mermaid drawing with a box or a label in it, or another renderer's frame. */
  readonly drawn: boolean;
  /** The diagram the graph answers with nothing: the page says so and draws no frame, which is no defect. */
  readonly empty: boolean;
  /** A renderer whose drawing failed: the page's own failure words, which is no empty frame either. */
  readonly failed: boolean;
  /** The app holding the drawing back until the reader comes near it, in its own words. */
  readonly deferred: boolean;
  /** The Mermaid drawing's own boxes, labels and size, as the browser computed them; null when no svg stands. */
  readonly nodes: number | null;
  readonly labels: number | null;
  readonly width: number | null;
  readonly height: number | null;
  /** The words the page stands in this diagram: its empty sentence, its failure, or its deferral; null when it drew. */
  readonly words: string | null;
}

/**
 * One pass down a long page, the way a reader scrolls it: every step moves the window
 * down a screenful and records what each diagram on the page holds. A diagram's frame
 * that stood before the reader reached it and an empty one are both read here, so a
 * page whose later diagrams draw no frame is named by its type rather than left to a
 * picture.
 */
async function scrollPass(page: Page, what: string, shots: string): Promise<Record<string, unknown>> {
  const size = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, viewport: window.innerHeight }));
  // The page as the reader's first screen finds it: nothing scrolled yet.
  const atTop = await readFrames(page);
  const firstDrawn = new Map<string, { top: number; waitedMs: number; frame: DiagramFrame }>();
  const step = 600;
  for (let top = 0; top < size.height; top += step) {
    await page.evaluate((y: number) => window.scrollTo(0, y), top);
    const inView = await page.evaluate(() => [...document.querySelectorAll('[data-testid="graph-diagram"]')]
      .filter((article) => {
        const rect = article.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      })
      .map((article) => article.getAttribute('data-diagram-type') ?? ''));
    // A frame the reader has just reached is given its own moment to draw, and the wait is bounded: a frame that
    // never draws is recorded as it stands rather than waited on for ever. An empty diagram and a failed renderer
    // are answers, not waits. The clock is the diagram's own, so the second diagram of one step reports its own wait.
    for (const type of inView) {
      const startedForType = Date.now();
      while (firstDrawn.has(type) === false && Date.now() - startedForType < 20_000) {
        const held = (await readFrames(page)).find((frame) => frame.type === type);
        if (held !== undefined && (held.drawn || held.empty || held.failed)) break;
        await new Promise((rest) => setTimeout(rest, 200));
      }
      const frame = (await readFrames(page)).find((each) => each.type === type);
      if (frame !== undefined && firstDrawn.has(type) === false) firstDrawn.set(type, { top, waitedMs: Date.now() - startedForType, frame });
    }
  }
  // The whole page scrolled, the reader at its foot: every diagram the page holds, as it stands.
  const afterScroll = await readFrames(page);
  // The window at the foot of a long page is mostly empty space, so the pass's own picture of "the reader has been
  // down it" is the page itself; the node pages are small enough to capture whole (the index's thousands of rows are
  // not, and are not captured here).
  await shot(page, join(shots, 'page-scrolled-to-the-foot.png'), { fullPage: true });
  const held: Record<string, unknown> = {
    pageHeight: size.height,
    viewport: size.viewport,
    steps: Math.ceil(size.height / step),
    atTop,
    firstDrawn: Object.fromEntries([...firstDrawn].map(([type, seen]) => [type, seen])),
    afterScroll,
    // A diagram that holds no drawing once the reader has been down the whole page is the defect this pass names.
    framesWithoutADrawing: afterScroll.filter((frame) => frame.drawn === false && frame.empty === false && frame.failed === false).map((frame) => frame.type),
  };
  console.log(`STAGE23_WALK_SCROLL ${JSON.stringify({ what, ...held })}`);
  return held;
}

/** Every diagram on the page and what its frame holds, in the page's own order. */
async function readFrames(target: Page | Frame): Promise<readonly DiagramFrame[]> {
  return await target.evaluate(() => [...document.querySelectorAll('[data-testid="graph-diagram"]')].map((article) => {
    const type = article.getAttribute('data-diagram-type') ?? '';
    const panel = article.querySelector('[data-panel]')?.getAttribute('data-panel') ?? null;
    const svg = article.querySelector('[data-testid="mermaid-diagram"] svg');
    const box = svg === null ? null : svg.getBoundingClientRect();
    const boxes = svg === null ? 0 : svg.querySelectorAll('g.node').length;
    const labels = svg === null ? 0 : svg.querySelectorAll('text, .nodeLabel').length;
    const empty = article.querySelector('[data-testid="graph-diagram-empty"]') !== null;
    const failed = article.querySelector('[data-testid="mermaid-error"]') !== null;
    const deferred = article.querySelector('[data-testid="graph-diagram-deferred"]') !== null;
    // The words a diagram stands in: the app holding it back until the reader comes near, the card saying what it is
    // waiting for, the renderer's failure, or the page's own answer for a model the graph cannot fill.
    const words = article.querySelector('[data-testid="graph-diagram-deferred"], [data-testid="mermaid-loading"], [data-testid="mermaid-error"], [data-testid="graph-diagram-empty"]')?.textContent?.trim() ?? null;
    return {
      type,
      panel,
      // A frame that stands empty is no drawing: an svg with no box and no label in it is the defect this pass
      // names, and another renderer's frame stands as a frame.
      drawn: article.querySelector('[data-testid="graph-diagram-archify"], [data-testid="graph-diagram-likec4"]') !== null || boxes + labels > 0,
      empty,
      failed,
      deferred,
      nodes: svg === null ? null : boxes,
      labels: svg === null ? null : labels,
      width: box === null ? null : Math.round(box.width),
      height: box === null ? null : Math.round(box.height),
      words,
    };
  }));
}

/** One diagram, in every renderer tab it offers. */
async function walkDiagram(page: Page, nodeId: string, type: string, shots: string): Promise<Record<string, unknown>> {
  const tabs = await tabsOf(page, type);
  if (tabs.offered.length === 0) {
    // A model the graph answers with nothing draws no frame and offers no tab: the
    // page's own words are the diagram's result, and there is nothing to click.
    await shot(page, join(shots, `diagram-${type}-empty.png`));
    return { tabs, empty: true, words: tabs.empty };
  }
  const held: Record<string, unknown> = { tabs };
  try {
    const mermaidTab = await openTab(page, nodeId, type, 'mermaid');
    const drawn = await measureDrawing(page, `[data-diagram-type="${type}"] [data-testid="mermaid-diagram"]`, 'mermaid', type);
    const labels = await page.evaluate((asked: string) => [...document.querySelectorAll(`[data-diagram-type="${asked}"] [data-testid="mermaid-diagram"] svg text, [data-diagram-type="${asked}"] [data-testid="mermaid-diagram"] .nodeLabel`)].map((node) => node.textContent ?? ''), type);
    held['mermaid'] = { ...drawn, elapsedMs: mermaidTab.elapsedMs, labels };
    await shotPanel(page, type, join(shots, `diagram-${type}-mermaid.png`));
    await shot(page, join(shots, `window-diagram-${type}-mermaid.png`));
  } catch (error) {
    // A renderer that does not draw is a defect of the diagram, not a reason to lose
    // the rest of the walk: it is recorded and the walk goes on.
    const words = await page.evaluate((asked: string) => document.querySelector(`[data-diagram-type="${asked}"] [data-testid="mermaid-error"]`)?.textContent ?? null, type).catch(() => null);
    held['mermaid'] = { failed: error instanceof Error ? error.message : String(error), words };
  }
  held['elements'] = await elementsOf(page, type);
  held['edges'] = await edgesOf(page, type);
  return held;
}

// ---- the phases -------------------------------------------------------------

/** The first fill: the product is made and the eight stages fill it, with no browser open. */
async function firstPhase(options: WalkOptions, product: Product): Promise<void> {
  const fill = await openFill(options, product);
  try {
    const result = await runFill(fill, 'firstRun', options.firstRun);
    if (result === null) throw failedAt('the first fill', 'the run was refused: see the STAGE23_WALK line');
    if (!result.settled || result.state !== 'succeeded') throw failedAt('the first fill', `the run ended ${result.settled ? result.state : 'without settling'}`);
    // The page set the fill left, read the way a client reads it.
    const started = Date.now();
    const set = await fill.service.pages(product.folder).pageSet();
    measure('firstRunPages', {
      readMs: Date.now() - started,
      product: set.product,
      total: set.total,
      byKind: Object.fromEntries(set.counts.map((count) => [count.kind, count.count])),
      kinds: [...new Set(set.pages.map((entry) => entry.kind))].sort(byCodePoint),
      changeSeq: set.changeSeq,
      message: set.message,
    });
  } finally {
    await closeFill(fill);
  }
}

/** What one read of the store costs, so a slow page of a real product is a number and not a guess. */
async function probePhase(options: WalkOptions, product: Product): Promise<void> {
  const fill = await openFill(options, product);
  try {
    const source = fill.service.pages(product.folder);
    let started = Date.now();
    const set = await source.pageSet();
    measure('probePageSet', { readMs: Date.now() - started, total: set.total, byKind: Object.fromEntries(set.counts.map((count) => [count.kind, count.count])) });
    const kinds = ['repository', 'module', 'package', 'symbol'] as const;
    for (const kind of kinds) {
      const chosen = set.pages.find((entry) => entry.kind === kind && (kind !== 'repository' || true));
      if (chosen === undefined) continue;
      started = Date.now();
      const read = await source.page(chosen.id);
      const pageMs = Date.now() - started;
      started = Date.now();
      const diagrams = await source.diagrams(chosen.id);
      measure(`probe_${kind}`, {
        id: chosen.id,
        label: chosen.label,
        pageMs,
        facts: read.ok ? read.page.facts.length : null,
        assumptions: read.ok ? read.page.assumptions.length : null,
        relations: read.ok ? read.page.relations.out.length + read.page.relations.in.length : null,
        diagramsMs: Date.now() - started,
        diagrams: diagrams.ok ? diagrams.diagrams.map((held) => ({ type: held.spec.type, elements: held.model.elements.length, edges: held.model.edges.length })) : diagrams.message,
      });
    }
  } finally {
    await closeFill(fill);
  }
}

/** One page of a kind the walk opens, chosen by its rank where the kind carries one. */
interface ChosenPage { readonly kind: string; readonly id: string; readonly label: string; readonly importance?: number }

function choosePages(pages: readonly { id: string; kind: string; label: string; importance?: number }[], codeName: string): Record<string, ChosenPage> {
  const chosen: Record<string, ChosenPage> = {};
  for (const kind of ['repository', 'package', 'module', 'symbol']) {
    const ofKind = pages.filter((page) => page.kind === kind);
    if (ofKind.length === 0) throw failedAt('choosing the pages', `the page set holds no "${kind}" page, and the task's DONE WHEN names one`);
    // A repository page is the code repository's, not the product repository's: it is
    // the one whose files the diagrams draw.
    const ranked = [...ofKind].sort((one, two) => {
      if (kind === 'repository') return Number(two.label === codeName) - Number(one.label === codeName) || (two.importance ?? 0) - (one.importance ?? 0);
      // The most important node of its kind (stage 5's rank), ties broken by label then id.
      return (two.importance ?? 0) - (one.importance ?? 0) || byCodePoint(one.label, two.label) || byCodePoint(one.id, two.id);
    });
    chosen[kind] = ranked[0] as ChosenPage;
  }
  return chosen;
}

/** The whole browser walk over one server's address: the pages, their diagrams and a run publishing under them. */
async function livePhase(options: WalkOptions, product: Product): Promise<void> {
  if (!existsSync(join(options.app, 'index.html'))) throw failedAt('the wiki app', `the built app is missing: ${join(options.app, 'index.html')} (build wiki/app first)`);
  const shots = join(options.root, 'shots');
  mkdirSync(shots, { recursive: true });
  const cache = join(options.root, 'wiki-cache');
  mkdirSync(cache, { recursive: true });
  const fill = await openFill(options, product);
  const services: StartedServer[] = [];
  let browser: Browser | undefined;
  let page: Page | undefined;
  const notes: string[] = [];
  let notesDropped = 0;
  const note = (line: string): void => {
    if (notes.length < 300) notes.push(line);
    else notesDropped += 1;
    console.error(`walk: ${line}`);
  };
  const serve = async (tab: string): Promise<StartedServer> => {
    const started = await startServer({
      productFolder: product.folder,
      appFolder: options.app,
      port: 0,
      host: '127.0.0.1',
      graphPages: (folder) => fill.service.pages(folder),
      env: { ...process.env, MADARCH_WIKI_DIAGRAM: tab, MADARCH_WIKI_CACHE: cache },
      log: () => undefined,
      errorLog: (line) => note(`server: ${line}`),
    });
    services.push(started);
    return started;
  };
  try {
    // The page set, read the way the app reads it, before the reader opens a page.
    const source = fill.service.pages(product.folder);
    let started = Date.now();
    const set = await source.pageSet();
    measure('pageSet', {
      readMs: Date.now() - started,
      product: set.product,
      total: set.total,
      byKind: Object.fromEntries(set.counts.map((count) => [count.kind, count.count])),
      kinds: [...new Set(set.pages.map((entry) => entry.kind))].sort(byCodePoint),
      changeSeq: set.changeSeq,
      message: set.message,
      pagesWithCode: set.pages.filter((entry) => entry.code !== undefined).length,
      pagesWithImportance: set.pages.filter((entry) => entry.importance !== undefined).length,
    });
    const chosen = choosePages(set.pages, product.codeName);
    measure('chosenPages', chosen);

    // The first server: the setting is Mermaid, so every diagram's first tab is Mermaid.
    const mermaidServer = await serve('mermaid');
    // The second: Archify first, which is what proves the setting's first tab.
    const archifyServer = await serve('archify');
    // The third: the setting's own default, LikeC4.
    const likec4Server = await serve('likec4');
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await newPage(browser, note);

    // ---- the index -------------------------------------------------------
    started = Date.now();
    await page.goto(`${mermaidServer.url}/p/graph`, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector('[data-testid="graph-index"]', { timeout: 300_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="graph-index"] .home-row').length > 0, { timeout: 600_000 });
    } catch (error) {
      console.error('BODY', (await page.evaluate(() => document.body.innerHTML)).slice(0, 3000).catch(() => 'unreadable'));
      throw error;
    }
    const indexElapsedMs = Date.now() - started;
    const indexNumbers = await page.evaluate(() => ({
      lead: document.querySelector('[data-testid="graph-lead"]')?.textContent ?? '',
      rows: document.querySelectorAll('[data-testid="graph-index"] .home-row').length,
      groups: [...document.querySelectorAll('[data-testid="graph-index"] .home-group')].map((group) => ({
        kind: group.getAttribute('data-graph-kind') ?? '',
        count: Number(group.querySelector('[data-testid="graph-kind-count"]')?.textContent ?? '0'),
      })),
      navNodes: document.querySelectorAll('[data-testid="graph-nav"] a[data-graph-node]').length,
    }));
    measure('index', { elapsedMs: indexElapsedMs, ...indexNumbers });
    await shot(page, join(shots, 'graph-index.png'));

    // ---- one page per kind ----------------------------------------------
    for (const kind of ['repository', 'package', 'module', 'symbol'] as const) {
      const chosenPage = chosen[kind];
      if (chosenPage === undefined) throw failedAt('the pages', `the page set holds no "${kind}" page`);
      const renderMs = await openNode(page, mermaidServer.url, chosenPage.id);
      const numbers = await pageNumbers(page);
      measure(`page_${kind}`, { id: chosenPage.id, label: chosenPage.label, renderMs, ...numbers, path: new URL(page.url()).pathname });
      await shot(page, join(shots, `page-${kind}.png`));
    }

    const documentPath = 'docs/vision.md';
    const documentStarted = Date.now();
    // The shell's document count stands only once the app's page list arrived, which is
    // the read that fails under load; the heading alone could be the error's own.
    await openUntil(page, `${mermaidServer.url}/p/${documentPath}`, '[data-testid="documents-count"]', `the document page ${documentPath}`);
    measure('documentPage', {
      path: documentPath,
      elapsedMs: Date.now() - documentStarted,
      title: await page.evaluate(() => document.querySelector('h1')?.textContent?.trim() ?? null),
      pathname: new URL(page.url()).pathname,
      bodyStart: (await page.evaluate(() => document.body.textContent ?? '')).replace(/\s+/gu, ' ').slice(0, 300),
      graphNav: await page.evaluate(() => document.querySelectorAll('[data-testid="graph-nav"] a[data-graph-node]').length),
    });
    await shot(page, join(shots, 'document-beside-graph.png'));

    // What a reader who lands on a file's own fact id sees: the app's refusal, in the
    // server's words, beside the graph's index — a file is where a node stands, not a
    // node a page is about.
    const fileStarted = Date.now();
    const fileAddress = `${mermaidServer.url}${pageAddress('file:' + '0'.repeat(64))}`;
    await openUntil(page, fileAddress, '[data-testid="graph-node-missing"]', 'the file refusal');
    measure('filePage', {
      address: pageAddress('file:' + '0'.repeat(64)),
      elapsedMs: Date.now() - fileStarted,
      pathname: new URL(page.url()).pathname,
      text: (await page.evaluate(() => document.querySelector('[data-testid="graph-node-missing"]')?.textContent ?? '')).replace(/\s+/gu, ' ').slice(0, 400),
    });
    await shot(page, join(shots, 'page-file-refusal.png'));

    // ---- a module that relates to another module of its level ------------
    // The page set's most important module is the repository's top one, which relates to nothing of its own level: a
    // page of a module that *does* have neighbours is what the task asks for beside its child modules, and the module
    // page is read here from an end of the repository page's own module-dependency arrows.
    const repository = chosen['repository']!;
    await openNode(page, mermaidServer.url, repository.id);
    await waitDiagrams(page, 'the repository page before the module pages');
    const neighboursModule = await page.evaluate(() => {
      const edge = document.querySelector('[data-diagram-type="module-dependency"] [data-testid="graph-diagram-edges"] li.graph-diagram-edge .graph-diagram-edge-ends');
      const held = edge?.textContent ?? '';
      const ends = held.split('→').map((end) => end.trim()).filter((end) => end.length > 0);
      // The arrow names its ends by label; the element rows carry the id and the page of each.
      const name = ends[0] ?? '';
      const row = [...document.querySelectorAll('[data-diagram-type="module-dependency"] [data-testid="graph-diagram-elements"] li.graph-diagram-element')]
        .find((element) => element.querySelector('.graph-diagram-element-label')?.textContent?.trim() === name);
      return { name, page: row?.querySelector('a.graph-diagram-element-label')?.getAttribute('href') ?? null, arrow: held };
    });
    if (neighboursModule.page === null) {
      // A page whose module-dependency arrows the walk could not read is said, never left as a missing key: the owner's
      // rule is that nothing is silently smaller.
      measure('neighboursModule', { skipped: true, why: 'the repository page named no module at an end of its module-dependency arrows', arrow: neighboursModule.arrow });
    }
    if (neighboursModule.page !== null) {
      const at = neighboursModule.page.indexOf('/p/graph/');
      const moduleId = at < 0 ? null : decodeURIComponent(neighboursModule.page.slice(at + '/p/graph/'.length));
      if (moduleId !== null) {
        const modulePageMs = await openNode(page, mermaidServer.url, moduleId);
        const numbers = await pageNumbers(page);
        measure('scrollPassModule', await scrollPass(page, `the module page of ${neighboursModule.name}`, shots));
        const moduleDiagrams: Record<string, unknown> = {};
        for (const type of await page.evaluate(() => [...document.querySelectorAll('[data-testid="graph-diagram"]')].map((article) => article.getAttribute('data-diagram-type') ?? ''))) {
          moduleDiagrams[type] = await walkDiagram(page, moduleId, type, shots);
        }
        measure('neighboursModule', { name: neighboursModule.name, arrow: neighboursModule.arrow, id: moduleId, renderMs: modulePageMs, diagrams: moduleDiagrams, numbers });
        await shot(page, join(shots, 'page-neighbours-module.png'));
      }
    }
    // ---- the diagrams of the repository page, in every renderer ----------
    await openNode(page, mermaidServer.url, repository.id);
    const types = await page.evaluate(() => [...document.querySelectorAll('[data-testid="graph-diagram"]')].map((article) => article.getAttribute('data-diagram-type') ?? ''));
    measure('repositoryDiagramTypes', types);
    // The reader arrives at the top of the page; the diagrams stand below the facts and relations, so the page is
    // scrolled to its foot one screenful at a time and every diagram's frame is read as it comes into view.
    measure('scrollPass', await scrollPass(page, 'the repository page', shots));
    const diagrams: Record<string, unknown> = {};
    for (const type of types) diagrams[type] = await walkDiagram(page, repository.id, type, shots);
    // Archify, on the server whose setting puts it first.
    await openNode(page, archifyServer.url, repository.id);
    for (const type of types) {
      const tabs = await tabsOf(page, type);
      if (!tabs.offered.includes('archify')) continue;
      const opened = await openTab(page, repository.id, type, 'archify');
      if (opened.frame === undefined) throw failedAt(`the archify page of ${type}`, 'it never stood');
      const drawn = await measureDrawing(opened.frame, null, 'archify', type);
      // The renderer's own dashed class on a component or an arrow; archify marks its
      // arrowheads with a `m-dashed` polygon whether or not the line is dashed, so the
      // count is of dashed lines and components, read off the drawing's text too.
      const dashed = await opened.frame.evaluate(() => [...document.querySelectorAll('[class*="dashed"]')].filter((node) => node.tagName.toLowerCase() !== 'polygon').length);
      const text = await opened.frame.evaluate(() => document.body.textContent ?? '');
      await shotPanel(page, type, join(shots, `diagram-${type}-archify.png`));
      await shot(page, join(shots, `window-diagram-${type}-archify.png`));
      diagrams[type] = { ...(diagrams[type] as Record<string, unknown>), archifyTabs: tabs, archify: { ...drawn, elapsedMs: opened.elapsedMs, dashed, text: text.slice(0, 400) } };
    }
    // LikeC4, on the server whose setting puts it first, for the types that offer it.
    await openNode(page, likec4Server.url, repository.id);
    for (const type of types) {
      const tabs = await tabsOf(page, type);
      if (!tabs.offered.includes('likec4')) continue;
      const opened = await openTab(page, repository.id, type, 'likec4');
      await shotPanel(page, type, join(shots, `diagram-${type}-likec4.png`));
      await shot(page, join(shots, `window-diagram-${type}-likec4.png`));
      diagrams[type] = { ...(diagrams[type] as Record<string, unknown>), likec4Tabs: tabs, likec4: { elapsedMs: opened.elapsedMs, ...(opened.likec4 ?? { svgs: 0, texts: [], undrawn: 'no state' }) } };
    }
    measure('diagrams', diagrams);

    // ---- a file: a document page, and the refusal a file's own fact id gets --
    // The store's own answer for the kinds with no page: a file and a document are
    // places, a directory and an occurrence are evidence (facts.ts, the registry's roles).
    const kindsWithoutPages: unknown[] = [];
    for (const kind of ['file', 'directory', 'document', 'occurrence']) {
      const read = await source.page(`${kind}:` + '0'.repeat(64));
      kindsWithoutPages.push({ kind, ok: read.ok, code: read.ok ? null : read.code, message: read.ok ? null : read.message.slice(0, 200) });
    }
    measure('kindsWithoutPages', kindsWithoutPages);

    // ---- a page appearing while a run publishes --------------------------
    started = Date.now();
    const before = await source.pageSet();
    say(`the page set was read again in ${String(Date.now() - started)} ms (${String(before.total)} pages)`);
    const beforeIds = new Set(before.pages.map((entry) => entry.id));
    // The reader sits on the graph's index; the flag it sets proves the page was never reloaded.
    await openUntil(page, `${mermaidServer.url}/p/graph`, '[data-testid="graph-index"] .home-row', 'the graph index before the run');
    await page.evaluate(() => {
      (window as unknown as { __stage23Walk?: number }).__stage23Walk = Date.now();
    });
    const beforeRows = await page.evaluate(() => document.querySelectorAll('[data-testid="graph-index"] .home-row').length);
    measure('liveBefore', { total: before.total, rows: beforeRows, changeSeq: before.changeSeq });

    // The one-file commit: a new folder, a file of its own, a symbol nothing else names,
    // and an import whose other end the graph does not hold (the dashed end 0026 asks for).
    const probeFolder = join(product.code, 'src', 'stage23walk');
    mkdirSync(probeFolder, { recursive: true });
    // The symbol's own name carries the moment, so a second walk commits a second symbol
    // and a second page rather than re-committing the one the first walk left.
    const probeSymbol = `stage23WalkProbe${new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 14)}`;
    writeFileSync(join(probeFolder, 'probe.ts'), [
      '// The probe the stage-23 walk commits to see a page appear (madarch-tzte.23.5).',
      "import { gone } from './probe-gone.js';",
      '',
      '/** The symbol whose page the walk watches appear. */',
      `export function ${probeSymbol}(): string {`,
      '  return gone;',
      '}',
      '',
    ].join('\n'));
    git(product.code, ['add', 'src/stage23walk/probe.ts'], true);
    git(product.code, ['commit', '-m', 'The stage-23 walk adds a page while a reader watches', '--no-verify'], true);
    const probeCommit = git(product.code, ['rev-parse', 'HEAD']);
    measure('probe', { symbol: probeSymbol, file: 'src/stage23walk/probe.ts', unresolvedImport: './probe-gone.js', commit: probeCommit });
    say(`the one-file commit is ${probeCommit}`);

    const startedRun = Date.now();
    const running = fill.service.run({ product: fill.stages.product, runId: options.secondRun });
    // While the run publishes, the reader's page must show the new page: the channel's
    // own change rows are read (cheap) rather than the whole page set, and the browser is
    // asked for the row that shows the page the change named.
    let appeared: { id: string; label: string; foundAfterMs: number; browserAfterMs: number } | undefined;
    let after = before.changeSeq;
    let candidate: { id: string; label: string; foundMs: number } | undefined;
    for (let attempt = 0; attempt < 1200; attempt++) {
      if (candidate === undefined) {
        // A read that fails while a publication holds the process's one connection is
        // waited out, not thrown: the loop reads again.
        try {
          const changes = await source.changes(after);
          for (const change of changes.changes) {
            for (const node of change.nodes) {
              if (candidate !== undefined || beforeIds.has(node) || !node.startsWith('symbol:')) continue;
              const read = await source.page(node);
              if (read.ok && read.page.node.label.includes('stage23WalkProbe')) candidate = { id: read.page.node.id, label: read.page.node.label, foundMs: Date.now() - startedRun };
            }
            after = Math.max(after, change.seq);
          }
          // A cut answer is read again from where it stopped; an uncut one can be trusted to its end.
          if (!changes.truncated) after = Math.max(after, changes.lastSeq);
        } catch (error) {
          note(`the page change read failed and is read again: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (candidate !== undefined) {
        const inBrowser = await page!.evaluate((id: string) => {
          const flag = (window as unknown as { __stage23Walk?: number }).__stage23Walk;
          const link = document.querySelector(`[data-testid="graph-index"] a[href$="${id}"]`);
          return { flag: flag ?? null, listed: link !== null, row: link?.textContent?.slice(0, 160) ?? null };
        }, candidate.id);
        if (inBrowser.listed) {
          appeared = { id: candidate.id, label: candidate.label, foundAfterMs: candidate.foundMs, browserAfterMs: Date.now() - startedRun };
          measure('liveBrowserRow', inBrowser);
          break;
        }
      }
      await new Promise((rest) => setTimeout(rest, 500));
    }
    const result = await running;
    const runNumbers = result.ok === false
      ? { refused: true, code: result.code, reason: result.reason }
      : { state: result.state, settled: result.settled, passes: result.passes, units: result.units.length, reused: result.reused.length, stoppedBecause: result.stoppedBecause ?? null, elapsedMs: Date.now() - startedRun };
    say(`the second run ended ${JSON.stringify(runNumbers)}`);
    if (appeared === undefined) {
      const after2 = await source.pageSet();
      measure('liveAfter', { appeared: false, run: runNumbers, total: after2.total });
      throw failedAt('the live run', 'no new page appeared in the open browser while the second run published (see the log for the pages the run published)');
    }
    started = Date.now();
    const after2 = await source.pageSet();
    const flagAfter = await page.evaluate(() => (window as unknown as { __stage23Walk?: number }).__stage23Walk ?? null);
    measure('liveAfter', {
      appeared: true,
      ...appeared,
      run: runNumbers,
      flagSurvived: flagAfter !== null,
      totalBefore: before.total,
      totalAfter: after2.total,
      pageSetReadMs: Date.now() - started,
      gainedPages: after2.pages.filter((entry) => !beforeIds.has(entry.id)).map((entry) => ({ kind: entry.kind, label: entry.label })),
      rowsBefore: beforeRows,
      rowsAfter: await page.evaluate(() => document.querySelectorAll('[data-testid="graph-index"] .home-row').length),
    });
    await shot(page, join(shots, 'graph-index-after-publish.png'));

    // The new page, opened from the row the reader watched appear.
    const newPageMs = await openNode(page, mermaidServer.url, appeared.id);
    measure('newPage', { id: appeared.id, label: appeared.label, renderMs: newPageMs, ...(await pageNumbers(page)) });
    await shot(page, join(shots, 'page-new-symbol.png'));

    // The repository page again: the diagrams that roll the new import up, and the end
    // the graph does not hold drawn dashed (0026: "assumptions or unresolved").
    await openNode(page, mermaidServer.url, repository.id);
    const afterTypes = await page.evaluate(() => [...document.querySelectorAll('[data-testid="graph-diagram"]')].map((article) => article.getAttribute('data-diagram-type') ?? ''));
    // The two views that roll the new import up must be there: an empty list here is the
    // race the section's own wait closes, so a walk that still sees none fails by name.
    for (const wanted of ['c4-component', 'module-dependency']) {
      if (!afterTypes.includes(wanted)) throw failedAt('the diagrams after the run', `the repository page drew ${JSON.stringify(afterTypes)}: ${wanted} is missing`);
    }
    const afterPublish: Record<string, unknown> = {};
    for (const type of afterTypes) {
      if (type !== 'c4-component' && type !== 'module-dependency') continue;
      const walked = await walkDiagram(page, repository.id, type, shots);
      const labels = (walked['mermaid'] as { labels?: string[] } | undefined)?.labels ?? [];
      const elements = (walked['elements'] ?? []) as { dashed?: string; label?: string }[];
      const edges = (walked['edges'] ?? []) as { dashed?: string; ends?: string }[];
      afterPublish[type] = {
        labels,
        unresolved: labels.filter((label) => label.includes('(unresolved)')),
        dashedElements: elements.filter((element) => element.dashed === 'true').length,
        dashedEdges: edges.filter((edge) => edge.dashed === 'true').length,
        elements: elements.length,
        edges: edges.length,
        walk: walked,
      };
      await shot(page, join(shots, `diagram-${type}-after-publish.png`));
    }
    measure('afterPublish', afterPublish);
    // A cap with no marker would read as the whole story: the dropped count is named.
    measure('browserNotes', { notes, dropped: notesDropped });
  } finally {
    try {
      if (browser !== undefined) await browser.close();
    } finally {
      for (const started of services) await started.stop();
      await closeFill(fill);
    }
  }
}

// ---- the speed of a page and of the index -----------------------------------

/** One read, as it cost and what it answered. */
interface Timed<T> { readonly ms: number; readonly value: T }

/** How long one read takes: the clock around the read, and the read's own answer. */
async function timed<T>(work: () => Promise<T>): Promise<Timed<T>> {
  const started = Date.now();
  const value = await work();
  return { ms: Date.now() - started, value };
}

/** One node page as the browser stood it: until the page was there, and until its diagrams had settled. */
async function standPage(page: Page, url: string): Promise<{ standMs: number; diagramsMs: number; settledMs: number; shown?: unknown }> {
  const started = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('[data-testid="graph-node"]', { timeout: 60_000 });
  } catch {
    // A page that never stands is a number of its own: the walk records what the page showed instead of failing.
    const shown = await page.evaluate(() => ({ path: window.location.pathname, text: (document.body?.textContent ?? '').replace(/\s+/gu, ' ').slice(0, 300) })).catch(() => null);
    return { standMs: -1, diagramsMs: -1, settledMs: -1, shown };
  }
  const standMs = Date.now() - started;
  await waitDiagrams(page, url);
  return { standMs, diagramsMs: Date.now() - started - standMs, settledMs: Date.now() - started };
}

/**
 * The speed of the graph's index and of one page per kind (madarch-tzte.23.8): what the
 * store's own reads cost, what the HTTP answers cost, and how long a headless Chromium at
 * the owner's 1150x900 window takes to stand the index and a repository's, a package's, a
 * module's and a symbol's page — cold, and again after the warm-up read the task names.
 *
 * It runs over a store a fill left (`--phase first`), on the page's own service, so the
 * numbers are the ones a reader's server pays and not a fixture's. Nothing here fixes or
 * changes anything: the record quotes what it prints.
 */
async function speedPhase(options: WalkOptions, product: Product): Promise<void> {
  if (!existsSync(join(product.home, '.madarch', 'fill', 'state.db'))) throw failedAt('the speed phase', `no fill's store stands in ${join(product.home, '.madarch', 'fill')}: run --phase first over this root first`);
  if (!existsSync(join(options.app, 'index.html'))) throw failedAt('the wiki app', `the built app is missing: ${join(options.app, 'index.html')} (build wiki/app first)`);
  const shots = join(options.root, 'shots-speed');
  mkdirSync(shots, { recursive: true });
  const cache = join(options.root, 'wiki-cache');
  mkdirSync(cache, { recursive: true });
  const fill = await openFill(options, product);
  const services: StartedServer[] = [];
  let browser: Browser | undefined;
  let page: Page | undefined;
  const notes: string[] = [];
  const note = (line: string): void => {
    if (notes.length < 200) notes.push(line);
    console.error(`walk: ${line}`);
  };
  try {
    const source = fill.service.pages(product.folder);
    // The page set, read the way a client reads it: once cold, once warm.
    const setCold = await timed(async () => await source.pageSet());
    const setWarm = await timed(async () => await source.pageSet());
    const set = setCold.value;
    measure('speedPageSet', {
      coldMs: setCold.ms,
      warmMs: setWarm.ms,
      total: set.total,
      byKind: Object.fromEntries(set.counts.map((count) => [count.kind, count.count])),
      changeSeq: set.changeSeq,
    });
    const chosen = choosePages(set.pages, product.codeName);
    const started = await startServer({
      productFolder: product.folder,
      appFolder: options.app,
      port: 0,
      host: '127.0.0.1',
      graphPages: (folder) => fill.service.pages(folder),
      env: { ...process.env, MADARCH_WIKI_DIAGRAM: 'mermaid', MADARCH_WIKI_CACHE: cache },
      log: () => undefined,
      errorLog: (line) => note(`server: ${line}`),
    });
    services.push(started);
    // The set over HTTP, cold and warm: the bytes a browser parses, not only the store's read.
    const httpCold = await timed(async () => await (await fetch(`${started.url}/api/graph/pages`)).text());
    const httpWarm = await timed(async () => await (await fetch(`${started.url}/api/graph/pages`)).text());
    measure('speedPageSetHttp', { coldMs: httpCold.ms, warmMs: httpWarm.ms, bytes: Buffer.byteLength(httpCold.value, 'utf8') });
    const reads: Record<string, unknown> = {};
    for (const kind of ['repository', 'package', 'module', 'symbol'] as const) {
      const chosenPage = chosen[kind]!;
      const pageCold = await timed(async () => await source.page(chosenPage.id));
      const pageWarm = await timed(async () => await source.page(chosenPage.id));
      const diagramsCold = await timed(async () => await source.diagrams(chosenPage.id));
      const diagramsWarm = await timed(async () => await source.diagrams(chosenPage.id));
      const diagrams = diagramsCold.value;
      reads[kind] = {
        id: chosenPage.id,
        label: chosenPage.label,
        pageColdMs: pageCold.ms,
        pageWarmMs: pageWarm.ms,
        diagramsColdMs: diagramsCold.ms,
        diagramsWarmMs: diagramsWarm.ms,
        facts: pageCold.value.ok ? pageCold.value.page.facts.length : null,
        relations: pageCold.value.ok ? pageCold.value.page.counts.out + pageCold.value.page.counts.in : null,
        diagrams: diagrams.ok ? diagrams.diagrams.map((held) => `${held.spec.type}: ${String(held.model.elements.length)} elements, ${String(held.model.edges.length)} edges`) : diagrams.message,
      };
    }
    measure('speedReads', reads);

    // What one page's own store reads cost, read by the page's own grammar: the statements a
    // page model makes, each on its own, so the record names where the time goes.
    const breakdown: Record<string, unknown> = {};
    for (const kind of ['repository', 'symbol'] as const) {
      const id = chosen[kind]!.id;
      const read = async (request: GraphRead): Promise<number> => (await timed(async () => await answerGraphRead({
        database: fill.owner,
        snapshot: { open: async (repository: string): Promise<never> => { throw new Error(`the speed walk opens no snapshot of ${repository}`); } },
      }, request))).ms;
      const scoped = (request: GraphRead): GraphRead => ({ ...request, product: set.product }) as GraphRead;
      breakdown[kind] = {
        id,
        nodeFactMs: await read(scoped({ read: 'fact', id })),
        claimsAboutMs: await read(scoped({ read: 'facts-with', kind: 'claim', field: 'subject.id', value: id })),
        claimsOfMs: await read(scoped({ read: 'facts-with', kind: 'claim', field: 'object.id', value: id })),
        rulesMs: await read(scoped({ read: 'facts-with', kind: 'rule', field: 'subject', value: id })),
        questionsMs: await read(scoped({ read: 'facts-with', kind: 'question', field: 'about', value: id })),
        adjacentMs: await read(scoped({ read: 'adjacent', id, kinds: FACT_EDGE_KINDS })),
      };
    }
    measure('speedReadBreakdown', breakdown);

    // The browser: the index that stands, and one page per kind — cold and warm.
    browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await newPage(browser, note);
    /** The index stands when its groups and the rows the page draws are there (23.8). */
    const standIndex = async (): Promise<{ standMs: number }> => {
      const at = Date.now();
      await page!.goto(`${started.url}/p/graph`, { waitUntil: 'domcontentloaded' });
      await page!.waitForSelector('[data-testid="graph-index"]', { timeout: 300_000 });
      await page!.waitForFunction(() => document.querySelectorAll('[data-testid="graph-index"] .home-row').length > 0, { timeout: 600_000 });
      return { standMs: Date.now() - at };
    };
    const indexCold = await standIndex();
    const indexRows = await page.evaluate(() => ({
      /** What the browser paid for each graph answer: its own duration, and the bytes it carried. */
      resources: performance.getEntriesByType('resource')
        .map((entry) => ({ path: new URL(entry.name).pathname, durationMs: Math.round(entry.duration), bytes: (entry as PerformanceResourceTiming).transferSize ?? 0 }))
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, 12),
      rows: document.querySelectorAll('[data-testid="graph-index"] .home-row').length,
      groups: document.querySelectorAll('[data-testid="graph-index"] .home-group').length,
      lead: document.querySelector('[data-testid="graph-lead"]')?.textContent ?? '',
      nodes: document.querySelectorAll('*').length,
      navNodes: document.querySelectorAll('[data-testid="graph-nav"] a[data-graph-node]').length,
    }));
    await shot(page, join(shots, 'graph-index.png'));
    const indexWarm = await standIndex();
    measure('speedIndex', { cold: indexCold, warm: indexWarm, ...indexRows });

    const stands: Record<string, unknown> = {};
    for (const kind of ['repository', 'package', 'module', 'symbol'] as const) {
      const chosenPage = chosen[kind]!;
      const address = `${started.url}${pageAddress(chosenPage.id)}`;
      const resources = async (): Promise<unknown> => await page!.evaluate(() => performance.getEntriesByType('resource')
        .filter((entry) => entry.name.includes('/api/graph/'))
        .map((entry) => ({ path: new URL(entry.name).pathname, durationMs: Math.round(entry.duration), bytes: (entry as PerformanceResourceTiming).transferSize ?? 0 })));
      const cold = await standPage(page, address);
      const numbers = await pageNumbers(page);
      const coldResources = await resources();
      await shot(page, join(shots, `page-${kind}.png`));
      const warm = await standPage(page, address);
      stands[kind] = { id: chosenPage.id, label: chosenPage.label, cold, coldResources, warm, warmResources: await resources(), facts: numbers['facts'], relations: numbers['relations'], diagrams: numbers['diagrams'] };
    }
    measure('speedStands', stands);
    measure('speedNotes', { notes });
  } finally {
    try {
      if (browser !== undefined) await browser.close();
    } finally {
      for (const server of services) await server.stop();
      await closeFill(fill);
    }
  }
}

// ---- what the store's own statements cost ------------------------------------

/** One statement's plan, as PostgreSQL names its nodes: the shapes a reader of the numbers needs. */
interface Explained {
  readonly ms: number;
  readonly rows: number;
  /** The plan's whole text, one line per node, so a seq scan and an index scan are told apart. */
  readonly plan: string;
}

/** Runs one statement under `EXPLAIN (ANALYZE)`, answering what it cost and how the database answered it. */
async function explained(executor: { query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> }, text: string, values: readonly unknown[], analyze: boolean): Promise<Explained> {
  const started = Date.now();
  const { rows } = await executor.query<Record<string, unknown>>(`EXPLAIN (${analyze ? 'ANALYZE, ' : ''}FORMAT JSON) ${text}`, values);
  const elapsed = Date.now() - started;
  // A driver answers `EXPLAIN (FORMAT JSON)` as a row holding the plan: a plain array, or `{"QUERY PLAN": [...]}`.
  const body = rows[0] as Record<string, unknown> | undefined;
  const answer = body === undefined ? undefined : (Array.isArray(body) ? body : (body['QUERY PLAN'] ?? body));
  const held = (Array.isArray(answer) ? answer[0] : answer) as { Plan?: Record<string, unknown> } | undefined;
  const plan = held?.Plan ?? {};
  const lines: string[] = [];
  const walk = (node: Record<string, unknown>, depth: number): void => {
    const name = String(node['Node Type'] ?? '?');
    const detail = node['Node Type'] === 'Seq Scan' || node['Node Type'] === 'Index Scan' || node['Node Type'] === 'Index Only Scan' || node['Node Type'] === 'Bitmap Index Scan'
      ? ` on ${String(node['Relation Name'] ?? node['Index Name'] ?? '')}`
      : '';
    const time = typeof node['Actual Total Time'] === 'number' ? ` ${String(Math.round((node['Actual Total Time'] as number) * 10) / 10)} ms` : '';
    const count = typeof node['Actual Rows'] === 'number' ? ` ${String(node['Actual Rows'])} rows` : '';
    lines.push(`${'  '.repeat(depth)}${name}${detail}${count}${time}`);
    for (const child of (node['Plans'] as Record<string, unknown>[] | undefined) ?? []) walk(child, depth + 1);
  };
  walk(plan, 0);
  return { ms: typeof plan['Actual Total Time'] === 'number' ? Math.round((plan['Actual Total Time'] as number) * 10) / 10 : elapsed, rows: typeof plan['Actual Rows'] === 'number' ? plan['Actual Rows'] : -1, plan: lines.join('\n') };
}

/**
 * What the graph's own statements cost on a filled store (madarch-tzte.23.8): the two
 * narrow reads a page set is made of, one batch of the facts it fetches, the whole read
 * the code makes, and the edges one page reads — each planned and each timed, so "the
 * product question was asked once per row" and "a page read every edge fact" are lines of
 * the record and not guesses. It changes nothing and leaves nothing behind.
 */
async function explainPhase(options: WalkOptions, product: Product): Promise<void> {
  if (!existsSync(join(product.home, '.madarch', 'fill', 'state.db'))) throw failedAt('the explain phase', `no fill's store stands in ${join(product.home, '.madarch', 'fill')}: run --phase first over this root first`);
  const fill = await openFill(options, product);
  try {
    const productName = fill.stages.product.name;
    // The store's own cost of being asked anything at all: an open, a checkpoint or a write-ahead log replayed, told
    // apart from the statement measured after it.
    const trivial = await timed(async () => await fill.owner.transaction('snapshot', async (executor) => await executor.query('SELECT 1')));
    measure('explainStoreAnswers', { firstStatementMs: trivial.ms });
    const run = async (text: string, values: readonly unknown[], analyze: boolean): Promise<Explained> =>
      await explained({ query: async (inner, params) => await fill.owner.transaction('snapshot', async (executor) => await executor.query(inner, params)) }, text, values, analyze);
    // The page set's own statements (madarch-tzte.23.8): the page-worthy facts by kind, the product's holdings, and
    // the facts by id that a batch of them fetches. Each is planned and then run bounded, so the numbers arrive in
    // seconds and a statement that only pays off at its end cannot hide behind the bound.
    const bounded = async (text: string, values: readonly unknown[]): Promise<Explained> => await run(`SELECT * FROM (${text}) AS held LIMIT 500`, values, true);
    measure('explainPageSetKinds', { plan: (await run(PAGE_SET_KINDS_SQL, [PAGE_KINDS], false)).plan, bounded: await bounded(PAGE_SET_KINDS_SQL, [PAGE_KINDS]) });
    measure('explainPageSetHeld', { plan: (await run(PAGE_SET_HELD_SQL, [productName], false)).plan, bounded: await bounded(PAGE_SET_HELD_SQL, [productName]) });
    // What each step of the read costs on its own: the two narrow reads and one batch of the facts, so the number
    // that dominates is a line and not a guess.
    const step = async (name: string, text: string, values: readonly unknown[]): Promise<void> => {
      const started = Date.now();
      const { rows } = await fill.owner.transaction('snapshot', async (executor) => await executor.query<Record<string, unknown>>(text, values));
      measure(`explainStep_${name}`, { ms: Date.now() - started, rows: rows.length });
    };
    await step('kinds', PAGE_SET_KINDS_SQL, [PAGE_KINDS]);
    await step('held', PAGE_SET_HELD_SQL, [productName]);
    const firstIds = (await fill.owner.transaction('snapshot', async (executor) => await executor.query<{ id: string }>(PAGE_SET_KINDS_SQL, [PAGE_KINDS]))).rows.slice(0, PAGE_SET_FETCH).map((row) => row.id);
    await step('fetch', `SELECT f.id, f.kind, f.schema_version, f.provenance, f.layer, f.status, f.value FROM fill_fact f WHERE f.id = ANY($1::text[])`, [firstIds]);
    // The read the code makes of the whole set, and the moment it costs: the number the fix has to move.
    const readStarted = Date.now();
    const set = await fill.service.pages(product.folder).pageSet();
    measure('explainPageSetRead', { ms: Date.now() - readStarted, total: set.total });
    // One page's edges, as the read grammar builds them: the statement a node's relations are read by.
    const symbol = set.pages.find((entry) => entry.kind === 'symbol');
    if (symbol !== undefined) {
      const startedAdjacent = Date.now();
      const read = await answerGraphRead({ database: fill.owner, snapshot: { open: async (): Promise<never> => { throw new Error('no snapshot'); } } }, { read: 'adjacent', id: symbol.id, kinds: FACT_EDGE_KINDS, product: productName });
      measure('explainAdjacentRead', { id: symbol.id, rows: read.length, ms: Date.now() - startedAdjacent });
    }
  } finally {
    await closeFill(fill);
  }
}

// ---- the run ----------------------------------------------------------------

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  say(`root ${options.root}, phase ${options.phase}, app ${options.app}`);
  // What this walk was built from: a staged folder carries no git, so the caller names the revision and the report
  // keeps it beside the numbers it read.
  measure('revision', { madarch: options.revision, app: options.app, pin: options.pin, phase: options.phase });
  mkdirSync(options.root, { recursive: true });
  try {
    if (options.phase === 'probe') {
      await probePhase(options, prepareProductForProbe(options));
    } else if (options.phase === 'speed') {
      await speedPhase(options, prepareProductForProbe(options));
    } else if (options.phase === 'explain') {
      await explainPhase(options, prepareProductForProbe(options));
    } else {
      const product = prepareProduct(options);
      if (options.phase !== 'live') await firstPhase(options, product);
      if (options.phase !== 'first') await livePhase(options, product);
    }
    return 0;
  } catch (error) {
    measure('failure', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 6) : [] });
    console.error(`walk failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  } finally {
    copyResults(options);
  }
}

/** The product a probe reads: one that already stands on disk (a probe never makes one). */
function prepareProductForProbe(options: WalkOptions): Product {
  const folder = join(options.root, 'product');
  if (!existsSync(join(folder, 'workspace.yaml'))) throw failedAt('the probe', `no product stands in ${folder}: run --phase first first`);
  const codeName = 'engine';
  return { folder, code: join(folder, 'repos', codeName), codeName, home: join(options.root, 'home') };
}

// The exit code is set, not exited with: `process.exit` can cut piped standard output, and
// a lost `STAGE23_WALK` line is a lost measurement.
process.exitCode = await main();
