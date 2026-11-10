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
import { resolveBrowserExecutable } from './chromium.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { startServer } from '../src/server/http.js';

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
  const browser = await puppeteer.launch({ executablePath: resolveBrowserExecutable(), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const width of WIDTHS) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: width >= 1000 ? 900 : 844, deviceScaleFactor: 1 });
      await page.goto(`${server.url}/products/${draft.name}/catalogue`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForSelector('[data-testid="catalogue-panel"]', { timeout: 120_000 });
      await page.waitForSelector('[data-testid="catalogue-check-section-requirements"]', { timeout: 120_000 });
      await new Promise((rest) => setTimeout(rest, 400));
      const sizes = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="catalogue-panel"]')?.getBoundingClientRect();
        const fill = document.querySelector('[data-testid="catalogue-fill"]') as HTMLElement | null;
        const rows = document.querySelectorAll('[data-testid="catalogue-state"]').length;
        return {
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          panel: panel === undefined || panel === null ? null : { left: Math.round(panel.left), right: Math.round(panel.right), width: Math.round(panel.width), bottom: Math.round(panel.bottom) },
          fill: fill?.textContent ?? null,
          rows,
        };
      });
      const file = join(out, `catalogue-${String(width)}.png`);
      await page.screenshot({ path: file as `${string}.png`, fullPage: false });
      console.log(`catalogue at ${String(width)} px: ${JSON.stringify(sizes)} → ${file}`);
      if (sizes.document > sizes.viewport) console.log(`horizontal scroll at ${String(width)} px: document ${String(sizes.document)} > viewport ${String(sizes.viewport)}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  await server?.stop().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
