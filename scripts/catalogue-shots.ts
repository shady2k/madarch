#!/usr/bin/env bun
/**
 * The catalogue page's shots (madarch-stm0.6): a draft product with a code repository and a glossary is created in a
 * scratch folder, filled once, served with the built app, and the catalogue page is rendered in headless Chromium at
 * 1280 px and at 390 px. Each shot is written to the output folder, and the page's own widths are printed — the
 * viewport, the document's scroll width and the body's — so a horizontal scroll at the phone width is a number and not a
 * picture somebody has to read.
 *
 *   bun scripts/catalogue-shots.ts --out /work/out/stm0.6
 *
 * The app must be built (`bun install --frozen-lockfile && bun run build` in wiki/app) and the machine must run the
 * plugin sandbox (the fill runs the product's glossary plugin); no agent runs: the fill names none.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer';
import { inflateSync } from 'node:zlib';
import { resolveBrowserExecutable } from './chromium.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { startServer } from '../src/server/http.js';


/**
 * What a shot holds, as numbers rather than a picture: the distinct colours and the share of pixels that are not the
 * page's own background. A blank page or one covered by a card reads differently from the catalogue, and the report can
 * say which of the two a shot is without somebody opening it. A PNG is read here: its IDAT stream is inflated and its
 * scanlines are unfiltered — no image library is added for one measurement.
 */
function inkOf(png: Uint8Array): { distinct: number; inkFraction: number; width: number; height: number } {
  const read = (at: number, length: number): number => { let value = 0; for (let index = 0; index < length; index += 1) value = (value << 8) | png[at + index]!; return value >>> 0; };
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  const idat: Uint8Array[] = [];
  while (at + 8 <= png.length) {
    const length = read(at, 4);
    const type = String.fromCharCode(...png.slice(at + 4, at + 8));
    const body = png.slice(at + 8, at + 8 + length);
    if (type === 'IHDR') { width = read(at + 8, 4); height = read(at + 12, 4); colourType = body[9]!; }
    if (type === 'IDAT') idat.push(body);
    at += 12 + length;
    if (type === 'IEND') break;
  }
  const joined = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of idat) { joined.set(part, offset); offset += part.length; }
  const raw = inflateSync(joined);
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 1;
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * channels);
  let previous = new Uint8Array(stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]!;
    const line = raw.slice(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
    const made = new Uint8Array(stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? made[index - channels]! : 0;
      const up = previous[index]!;
      const upLeft = index >= channels ? previous[index - channels]! : 0;
      const value = line[index]!;
      made[index] = filter === 0 ? value : filter === 1 ? (value + left) & 0xff : filter === 2 ? (value + up) & 0xff : filter === 3 ? (value + ((left + up) >> 1)) & 0xff : filter === 4 ? (value + paeth(left, up, upLeft)) & 0xff : value;
    }
    pixels.set(made, row * stride);
    previous = made;
  }
  const colours = new Set<number>();
  let ink = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const base = pixel * channels;
    const r = pixels[base]!;
    const g = channels === 1 ? r : pixels[base + 1]!;
    const b = channels === 1 ? r : pixels[base + 2]!;
    colours.add((r << 16) | (g << 8) | b);
    if (r + g + b < 720) ink += 1;
  }
  return { distinct: colours.size, inkFraction: Math.round((ink / (width * height)) * 1000) / 1000, width, height };
}

/** The PNG's Paeth predictor, as the specification states it. */
function paeth(left: number, up: number, upLeft: number): number {
  const guess = left + up - upLeft;
  const toLeft = Math.abs(guess - left);
  const toUp = Math.abs(guess - up);
  const toUpLeft = Math.abs(guess - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

const IDENTITY = { GIT_AUTHOR_NAME: 'Shot Fixture', GIT_AUTHOR_EMAIL: 'shot@example.test', GIT_COMMITTER_NAME: 'Shot Fixture', GIT_COMMITTER_EMAIL: 'shot@example.test' };

/** The widths the surfaces are rendered at: a desktop and a phone. */
const WIDTHS = [1280, 390] as const;

/** The glossary the fixture product holds, so the term kind is filled and its words stand. */
const GLOSSARY = `# Glossary

- **Fill** — the one run that reads a product's repositories and writes its graph.
- **Claim** — one producer's statement about a field, kept beside every other producer's.
- **Turn** — one kind's place in a fill: its plugins, then its agent part.
`;

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = resolve(values.out ?? join(tmpdir(), 'madarch-catalogue-shots'));
mkdirSync(out, { recursive: true });
const appFolder = join(import.meta.dir, '..', 'wiki', 'app', 'dist');
if (!existsSync(join(appFolder, 'index.html'))) {
  console.error(`${appFolder}:1: the app's built files are not there: run bun install --frozen-lockfile && bun run build in wiki/app`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'madarch-catalogue-shots-'));
const home = join(work, 'home');
let server: Awaited<ReturnType<typeof startServer>> | undefined;
try {
  const draft = createDraft({ home, name: 'shot-shop', gitEnv: IDENTITY });
  if (draft.outcome !== 'created') throw new Error(`the draft product was not made: ${JSON.stringify(draft)}`);
  const folder = draft.folder;
  const code = join(folder, 'repos', 'app');
  mkdirSync(code, { recursive: true });
  writeFileSync(join(code, 'README.md'), '# App\n');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: code, env: { ...process.env, ...IDENTITY } });
  execFileSync('git', ['add', 'README.md'], { cwd: code, env: { ...process.env, ...IDENTITY } });
  execFileSync('git', ['commit', '--quiet', '-m', 'First commit'], { cwd: code, env: { ...process.env, ...IDENTITY } });
  const manifest = join(folder, 'workspace.yaml');
  writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'app', linked: true }));
  writeFileSync(join(folder, 'docs', 'glossary.md'), GLOSSARY);
  for (const args of [['add', '-A'], ['commit', '--quiet', '-m', 'The glossary']]) execFileSync('git', args, { cwd: folder, env: { ...process.env, ...IDENTITY } });
  // One fill through the command a person runs, so the catalogue states what stands: the file kinds filled and the terms
  // read by their plugin. No agent is named, so no model runs.
  const filled = Bun.spawnSync(['bun', join(import.meta.dir, 'madarch.ts'), 'fill', '--product', folder, '--home', home], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  if (filled.exitCode !== 0) {
    console.error(`the fixture fill failed: ${new TextDecoder().decode(filled.stderr)}`);
    process.exit(1);
  }
  const storeRoot = join(home, '.madarch', 'knowledge');
  server = await startServer({ productHome: home, appFolder, port: 0, knowledgeRoot: storeRoot, log: () => undefined, errorLog: (line: string) => console.error(line) });
  // A returning reader's settings: the role is chosen ("everything") and the reader is not asked again, so the first-open
  // card does not cover the page the shot is of. This is the same request the app's own card makes.
  const settings = await fetch(`${server.url}/products/${draft.name}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'everything' }) });
  if (!settings.ok) {
    console.error(`the reader's role could not be set before the shot: ${String(settings.status)} ${await settings.text()}`);
    process.exit(1);
  }
  const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const width of WIDTHS) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: width >= 1000 ? 900 : 844, deviceScaleFactor: 1 });
      // The shots are of the Russian surfaces (the task asks for them in Russian): the app's own language key is set
      // before any script of the app runs, exactly as the language menu writes it.
      await page.evaluateOnNewDocument(() => { try { localStorage.setItem('madarch-wiki-language', 'ru'); } catch { /* a private context still renders */ } });
      const open = async (path: string, waits: string[]): Promise<void> => {
        await page.goto(`${server.url}/products/${draft.name}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        for (const selector of waits) await page.waitForSelector(selector, { timeout: 120_000 });
        await new Promise((rest) => setTimeout(rest, 300));
      };
      await open('/catalogue', ['[data-testid="catalogue-panel"]', '[data-testid="catalogue-check-section-requirements"]']);
      // Nothing covers the page: the first-open card is gone, and what stands at the top of the viewport and at its bottom
      // is the catalogue itself and its panel.
      const covered = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="role-card"]');
        const top = document.elementFromPoint(window.innerWidth / 2, 80);
        const bottom = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 20);
        const inside = (node: Element | null, testId: string): boolean => node?.closest(`[data-testid="${testId}"]`) !== null;
        const heading = document.querySelector('[data-testid="catalogue-page"] h1')?.getBoundingClientRect();
        const visibleRows = [...document.querySelectorAll('[data-testid="catalogue-page"] [data-kind]')].filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight && rect.height > 0;
        }).length;
        const seen = [...document.querySelectorAll('[data-testid="catalogue-page"] [data-kind]')].filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < window.innerHeight && rect.height > 0;
        });
        return {
          roleCard: card !== null,
          top: top === null ? 'none' : (top.closest('[data-testid]')?.getAttribute('data-testid') ?? top.tagName),
          bottom: bottom === null ? 'none' : (bottom.closest('[data-testid]')?.getAttribute('data-testid') ?? bottom.tagName),
          heading: heading === undefined || heading === null ? null : { top: Math.round(heading.top), height: Math.round(heading.height) },
          headingVisible: heading !== undefined && heading !== null && heading.top >= 0 && heading.bottom <= window.innerHeight && heading.height > 0,
          visibleRows,
          visibleNames: seen.slice(0, 6).map((row) => row.querySelector('[data-testid="catalogue-kind-name"], a')?.textContent?.trim() ?? ''),
          bottomIsPanel: inside(bottom, 'catalogue-panel'),
          panelText: (document.querySelector('[data-testid="catalogue-panel"]')?.innerText ?? '').replace(/\s+/gu, ' ').trim().slice(0, 240),
          russian: /[А-Яа-я]/u.test(document.querySelector('[data-testid="catalogue-page"] h1')?.textContent ?? ''),
          oldWords: /этапа пока нет|пишет человек|заполняет писатель|no stage yet|written by a person|filled by the writer/iu.test(document.body.innerText ?? ''),
          stages: [...document.querySelectorAll('[data-testid="catalogue-stage"]')].slice(0, 6).map((cell) => (cell.textContent ?? '').replace(/\s+/gu, ' ').trim()),
          text: (document.body.innerText ?? '').length,
        };
      });
      const sizes = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="catalogue-panel"]')?.getBoundingClientRect();
        const fill = document.querySelector('[data-testid="catalogue-fill"]') as HTMLElement | null;
        const rows = document.querySelectorAll('[data-testid="catalogue-state"]').length;
        return {
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          panel: panel === undefined || panel === null ? null : { left: Math.round(panel.left), right: Math.round(panel.right), width: Math.round(panel.width), top: Math.round(panel.top), bottom: Math.round(panel.bottom), height: Math.round(panel.height) },
          fill: fill?.textContent ?? null,
          rows,
          fit: (() => {
            const ctx = document.createElement('canvas').getContext('2d');
            const measure = (selector: string, text: string): number | null => {
              const node = document.querySelector<HTMLElement>(selector);
              if (node === null || ctx === null) return null;
              ctx.font = getComputedStyle(node).font;
              return Math.ceil(ctx.measureText(text).width);
            };
            const agent = document.querySelector<HTMLSelectElement>('[data-testid="catalogue-agent"]');
            const cap = document.querySelector<HTMLInputElement>('[data-testid="catalogue-token-cap"]');
            return {
              agentWidth: agent?.clientWidth ?? 0,
              agentText: agent === null || agent === undefined ? 0 : measure('[data-testid="catalogue-agent"]', agent.options[agent.selectedIndex]?.text ?? ''),
              capWidth: cap?.clientWidth ?? 0,
              capText: cap === null || cap === undefined ? 0 : measure('[data-testid="catalogue-token-cap"]', cap.getAttribute('placeholder') ?? ''),
            };
          })(),
        };
      });
      // The top bar's fill panel is the second surface: it opens from the right over the same page.
      const chip = await page.$('[data-testid="fill-chip"]');
      if (chip === null) {
        console.error(`the fill badge is not on the page at ${String(width)} px: the panel cannot be shot`);
        process.exitCode = 1;
      } else {
        await chip.click();
        await page.waitForSelector('[data-testid="fill-side-panel"]', { timeout: 60_000 });
        await page.waitForSelector('[data-testid="fill-side-press"]', { timeout: 60_000 });
        await new Promise((rest) => setTimeout(rest, 300));
        const panelShot = await page.screenshot({ fullPage: false });
        const panelFile = join(out, `fill-panel-${String(width)}.png`);
        writeFileSync(panelFile, panelShot);
        const panelSize = await page.evaluate(() => {
          const node = document.querySelector('[data-testid="fill-side-panel"]');
          const rect = node?.getBoundingClientRect();
          return {
            viewport: window.innerWidth,
            document: document.documentElement.scrollWidth,
            panel: rect === undefined || rect === null ? null : { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
            sections: document.querySelectorAll('[data-testid="fill-side-section"]').length,
            names: [...document.querySelectorAll('[data-testid="fill-side-section"]')].slice(0, 6).map((section) => section.querySelector('span')?.textContent?.replace(/\s+/gu, ' ').trim() ?? ''),
            panelText: (document.querySelector('[data-testid="fill-side-panel"]')?.innerText ?? '').replace(/\s+/gu, ' ').trim().slice(0, 400),
            russian: /[А-Яа-я]/u.test(document.querySelector('[data-testid="fill-side-panel"]')?.textContent ?? ''),
            fit: (() => {
              const ctx = document.createElement('canvas').getContext('2d');
              const measure = (selector: string, text: string): number | null => {
                const node = document.querySelector<HTMLElement>(selector);
                if (node === null || ctx === null) return null;
                ctx.font = getComputedStyle(node).font;
                return Math.ceil(ctx.measureText(text).width);
              };
              const agent = document.querySelector<HTMLSelectElement>('[data-testid="fill-side-agent"]');
              const cap = document.querySelector<HTMLInputElement>('[data-testid="fill-side-cap"]');
              return {
                agentWidth: agent?.clientWidth ?? 0,
                agentText: agent === null || agent === undefined ? 0 : measure('[data-testid="fill-side-agent"]', agent.options[agent.selectedIndex]?.text ?? ''),
                capWidth: cap?.clientWidth ?? 0,
                capText: cap === null || cap === undefined ? 0 : measure('[data-testid="fill-side-cap"]', cap.getAttribute('placeholder') ?? ''),
              };
            })(),
          };
        });
        const panelText = await page.evaluate(() => {
          const part = (title: string, selector: string): string => `## ${title}\n${(document.querySelector(selector)?.innerText ?? '(absent)').trim()}`;
          return [part('panel', '[data-testid="fill-side-panel"]'), part('page', '[data-testid="catalogue-page"]')].join('\n\n');
        });
        writeFileSync(join(out, `fill-panel-${String(width)}.txt`), `${panelText}\n`);
        const panelInk = inkOf(panelShot);
        console.log(`fill panel at ${String(width)} px: ${JSON.stringify({ ...panelSize, pixels: panelInk })} → ${panelFile}`);
        if (panelSize.document > panelSize.viewport || !panelSize.russian || panelSize.sections < 2 || panelSize.fit.agentText + 30 > panelSize.fit.agentWidth || panelSize.fit.capText + 24 > panelSize.fit.capWidth || panelInk.distinct < 20) {
          console.error(`the fill panel's shot at ${String(width)} px is not the panel it should be: ${JSON.stringify({ ...panelSize, pixels: panelInk })}`);
          process.exitCode = 1;
        }
        await page.keyboard.press('Escape');
      }
      const file = join(out, `catalogue-${String(width)}.png`);
      const shot = await page.screenshot({ fullPage: false });
      writeFileSync(file, shot);
      const catalogueText = await page.evaluate(() => {
        const part = (title: string, selector: string): string => `## ${title}\n${(document.querySelector(selector)?.innerText ?? '(absent)').trim()}`;
        return [part('top bar', '[data-testid="shell-fixed"]'), part('page', '[data-testid="catalogue-page"]'), part('panel', '[data-testid="catalogue-panel"]')].join('\n\n');
      });
      writeFileSync(join(out, `catalogue-${String(width)}.txt`), `${catalogueText}\n`);
      const ink = inkOf(shot);
      console.log(`catalogue at ${String(width)} px: ${JSON.stringify({ ...sizes, ...covered, pixels: ink })} → ${file}`);
      if (covered.roleCard || !covered.headingVisible || !covered.russian || covered.oldWords || covered.stages.length < 1 || covered.visibleRows < 1 || !covered.bottomIsPanel || sizes.fit.agentText + 30 > sizes.fit.agentWidth || sizes.fit.capText + 24 > sizes.fit.capWidth || ink.distinct < 20 || ink.inkFraction < 0.01) {
        console.error(`the shot at ${String(width)} px is not the catalogue page it should be: ${JSON.stringify(covered)} ${JSON.stringify(ink)}`);
        process.exitCode = 1;
      }
      if (sizes.document > sizes.viewport) console.log(`horizontal scroll at ${String(width)} px: document ${String(sizes.document)} > viewport ${String(sizes.viewport)}`);
      // The dependency graph is the third surface: the same product's entities in the order their declarations give.
      page.on('pageerror', (error) => console.error(`the dependency page raised in the browser: ${String(error).slice(0, 400)}`));
      // A page of its own for the graph: a reload of the app on one page proved flaky on this box (the catalogue's first
      // read and its panel raced the second load).
      const graphPage = await browser.newPage();
      await graphPage.setViewport({ width, height: width >= 1000 ? 900 : 844, deviceScaleFactor: 1 });
      await graphPage.evaluateOnNewDocument(() => { try { localStorage.setItem('madarch-wiki-language', 'ru'); } catch { /* a private context still renders */ } });
      graphPage.on('pageerror', (error) => console.error(`the dependency page raised in the browser: ${String(error).slice(0, 400)}`));
      await graphPage.goto(`${server.url}/products/${draft.name}/dependencies`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      try {
        await graphPage.waitForSelector('[data-testid="dependency-page"]', { timeout: 120_000 });
        await graphPage.waitForSelector('[data-testid="dependency-node"]', { timeout: 120_000 });
      } catch (error) {
        console.error(`the dependency page drew no entity: ${String((await graphPage.evaluate(() => document.body.innerText)).slice(0, 600))}`);
        throw error;
      }
      await new Promise((rest) => setTimeout(rest, 300));
      await new Promise((rest) => setTimeout(rest, 300));
      const graphShot = await graphPage.screenshot({ fullPage: false });
      const graphFile = join(out, `dependencies-${String(width)}.png`);
      writeFileSync(graphFile, graphShot);
      const graphText = await graphPage.evaluate(() => {
        const part = (title: string, selector: string): string => `## ${title}\n${(document.querySelector(selector)?.innerText ?? '(absent)').trim()}`;
        return [part('top bar', '[data-testid="shell-fixed"]'), part('page', '[data-testid="dependency-page"]')].join('\n\n');
      });
      writeFileSync(join(out, `dependencies-${String(width)}.txt`), `${graphText}\n`);
      const graphSize = await graphPage.evaluate(() => {
        const frame = document.querySelector('[data-testid="dependencies-graph"]');
        const heading = document.querySelector('[data-testid="dependency-page"] h1')?.getBoundingClientRect();
        const nodes = [...document.querySelectorAll('[data-testid="dependency-node"]')];
        const states: Record<string, number> = {};
        for (const node of nodes) states[node.getAttribute('data-state') ?? 'none'] = (states[node.getAttribute('data-state') ?? 'none'] ?? 0) + 1;
        return {
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          roleCard: document.querySelector('[data-testid="role-card"]') !== null,
          headingVisible: heading !== undefined && heading !== null && heading.top >= 0 && heading.bottom <= window.innerHeight && heading.height > 0,
          nodes: nodes.length,
          independentSections: document.querySelectorAll('[data-testid="dependencies-independent-section"]').length,
          independentOpen: [...document.querySelectorAll('[data-testid="dependencies-independent-section"]')].filter((node) => (node as HTMLDetailsElement).open).length,
          states,
          visible: nodes.filter((node) => { const rect = node.getBoundingClientRect(); return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth; }).slice(0, 10).map((node) => `${node.getAttribute('data-kind')}:${node.getAttribute('data-state')}`),
          total: document.querySelector('[data-testid="dependencies-total"]')?.textContent ?? null,
          russian: /[А-Яа-я]/u.test(document.querySelector('[data-testid="dependency-page"] h1')?.textContent ?? ''),
          frame: frame === null ? null : { scroll: frame.scrollWidth, client: frame.clientWidth },
          text: (document.body.innerText ?? '').length,
        };
      });
      const graphInk = inkOf(graphShot);
      console.log(`dependencies at ${String(width)} px: ${JSON.stringify({ ...graphSize, pixels: graphInk })} → ${graphFile}`);
      if (graphSize.document > graphSize.viewport || graphSize.roleCard || !graphSize.headingVisible || !graphSize.russian || graphSize.nodes < 3 || graphSize.independentSections < 1 || graphSize.independentOpen > 0 || Object.keys(graphSize.states).length < 1 || graphInk.distinct < 20 || graphInk.inkFraction < 0.01) {
        console.error(`the dependency page's shot at ${String(width)} px is not the graph it should be: ${JSON.stringify({ ...graphSize, pixels: graphInk })}`);
        process.exitCode = 1;
      }
      await graphPage.close();
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  await server?.stop().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
