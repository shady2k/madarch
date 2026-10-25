/**
 * diagram:shots (madarch-m38l.9): the acceptance walk of the graph diagrams. The built app in wiki/app is served by the
 * engine's own server over a products home holding the generated training repository (filled once), and headless
 * Chromium takes each page that carries a diagram at 1150 px and at phone width, in light and dark. For each picture it
 * prints the sizes of the labels (the font size as rendered, after the diagram's scale) and the overlaps found between
 * labels of one diagram, so the numbers go into the change record beside the pictures.
 *
 * Usage: bun scripts/diagram-shots.ts [--out <folder>] [--work <folder>] [--port <n>] [--binary <compiled madarch>]
 * With --binary the server is the compiled binary (its embedded app), not this checkout.
 * Fixed acceptance pipeline: --phase prepare, --phase json, eight --phase matrix --matrix <1150-light-en|...>,
 * then --phase aggregate, all with the same --out/--work/--binary/--port. Prepare fills once and freezes the full plan.
 * Every phase refuses existing output, changed inputs, missing/duplicate/unplanned keys and strict numeric failures.
 * The frozen graph snapshot is retained; daemons reuse the same prepared home without another fill/reset.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import puppeteer, { type Page } from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { archifyFrame, likec4Model } from '../src/knowledge/view-frames.js';
import { adjacentKeys, requireHint, sameKeys, sameViews, type AdjacentView } from './diagram-plan.js';
import en from '../wiki/app/src/locales/en.json';
import ru from '../wiki/app/src/locales/ru.json';
import { diagramAcceptanceCases } from './diagram-acceptance-cases.js';
import { DIAGRAM_MEASURES } from './diagram-measures.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { generateTrainingRepository, makeProduct, writeSamplePages } from '../test/knowledge-fixture.js';

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}
const runPhase = argument('phase', 'all');
const matrix = argument('matrix', '');
const phaseNames = ['prepare', 'json', 'matrix', 'aggregate'];
if (runPhase !== 'all' && !phaseNames.includes(runPhase)) throw new Error(`unknown phase ${runPhase}`);
const evidenceRoot = resolve(argument('out', 'shots'));
const out = runPhase === 'all' ? evidenceRoot : join(evidenceRoot, runPhase === 'matrix' ? `matrix-${matrix}` : runPhase);
const preparedFile = join(evidenceRoot, 'prepare', 'prepared.json');
const work = resolve(argument('work', '/tmp/madarch-diagram-shots'));
const port = Number(argument('port', '4293'));
if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} [evidence output]: folder is not empty; preserve the earlier run and choose a new --out folder`);
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
const failures: { where: string; message: string }[] = [];
function atomicJson(file: string, value: unknown): void { writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2)); renameSync(`${file}.tmp`, file); }
function failure(where: string, message: string): void {
  const detail = { where: `${resolve(import.meta.dir, 'diagram-shots.ts')} [${where}]`, message };
  failures.push(detail); atomicJson(join(out, 'failures.json'), failures); console.error(`${detail.where}: ${message}`);
}
atomicJson(join(out, 'failures.json'), failures);

const home = join(work, 'home');

type PlannedView = { type: string; query: string; renderers: string[]; adjacentKeys: string[] };
type PlannedPage = { name: string; url: string; wait: string; lang: string; blocks: PlannedView[][]; fixture?: unknown };
type WalkPlan = { ids: string[]; pages: PlannedPage[]; images: string[]; matrices: string[] };
type Prepared = { name: string; port: number; binary: string; work: string; plan: WalkPlan; planHash: string; inputs: Record<string, string> };
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function treeHashes(folder: string, prefix: string, into: Record<string, string>): void {
  for (const name of readdirSync(folder).sort()) {
    if (['node_modules', '.git'].includes(name)) continue;
    const file = join(folder, name), key = `${prefix}/${name}`;
    if (statSync(file).isDirectory()) treeHashes(file, key, into);
    else into[key] = digest(readFileSync(file));
  }
}
function inputHashes(binary: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const path of ['src', 'scripts', 'vendor', 'wiki/app/src', 'wiki/app/dist', 'examples/training-repository']) treeHashes(resolve(import.meta.dir, '..', path), path, values);
  for (const path of ['package.json', 'bun.lock', 'own-wiki.lock', 'test/knowledge-fixture.ts']) values[path] = digest(readFileSync(resolve(import.meta.dir, '..', path)));
  if (binary !== '') values['binary'] = digest(readFileSync(binary));
  treeHashes(join(work, 'repo'), 'fixture', values);
  treeHashes(join(work, 'frozen-home', '.madarch', 'knowledge'), 'graph', values);
  return values;
}
let prepared: Prepared | undefined;
let frozenPlan: WalkPlan | undefined;

let name = 'shop';
let base = `http://127.0.0.1:${port}`;
let stop = async (): Promise<void> => undefined;
let closing: Promise<void> | undefined;
let closeBrowser = async (): Promise<void> => undefined;
const report: Record<string, unknown> = {};
const apiPages: Record<string, unknown>[] = [];
const startedAt = Date.now();
let phase = 'setup', phaseAt = startedAt;
const timings: Record<string, number> = {};
let expectedJson: number | null = null, expectedPageVariants: number | null = null, completedPages = 0;
let walkSucceeded = false;
let cleanupStatus = 'pending';
const imagePlan = new Set<string>(), completedImages = new Set<string>();
function completion(status: 'running' | 'failed' | 'incomplete' | 'complete', error?: string): void {
  atomicJson(join(out, 'completion.json'), { status, phase, planHash: prepared?.planHash ?? null, cleanup: cleanupStatus, error: error ?? null, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, phaseMs: { ...timings, [phase]: Date.now() - phaseAt }, json: { expected: expectedJson, completed: apiPages.length }, screenshots: { planComplete: completedPages === expectedPageVariants && expectedPageVariants !== null, planned: [...imagePlan].sort(), completed: [...completedImages].sort() }, pageVariants: { expected: expectedPageVariants, completed: completedPages }, failures: failures.length });
}
function enterPhase(next: string): void { timings[phase] = Date.now() - phaseAt; phase = next; phaseAt = Date.now(); completion('running'); }
const cleanup = (): Promise<void> => closing ??= (async () => {
  try { await closeBrowser(); } finally { await stop(); }
  cleanupStatus = 'complete';
})();
completion('running');
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  failure('signal', `walk interrupted by ${signal}; partial evidence is not acceptance`);
  completion('incomplete', `interrupted by ${signal}`);
  void cleanup().finally(() => process.exit(128 + (signal === 'SIGTERM' ? 15 : 2)));
});
try {
if (runPhase === 'prepare' && existsSync(preparedFile)) throw new Error('prepared state already exists; do not refill it');
if (runPhase !== 'all' && runPhase !== 'prepare') {
  prepared = JSON.parse(readFileSync(preparedFile, 'utf8')) as Prepared;
  if (prepared.work !== work || prepared.binary !== resolve(argument('binary', '')) || prepared.port !== port) throw new Error('prepared work, binary or port mismatch');
  if (digest(JSON.stringify(prepared.plan)) !== prepared.planHash) throw new Error('immutable plan hash mismatch');
  sameKeys(Object.entries(prepared.inputs).map(([key, hash]) => `${key}:${hash}`), Object.entries(inputHashes(prepared.binary)).map(([key, hash]) => `${key}:${hash}`), 'immutable source/app/binary/fixture/graph');
  frozenPlan = prepared.plan; name = prepared.name;
  const command = (verb: string) => {
    const result = spawnSync(prepared!.binary, [verb, '--home', home, ...(verb === 'start' ? ['--port', String(port)] : [])], { encoding: 'utf8', cwd: work, timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(`${verb}: ${result.error ?? result.stderr}${result.stdout}`);
  };
  if (runPhase !== 'aggregate') {
    // Restore the stopped prepared graph byte-for-byte at its ORIGINAL absolute store path.
    // PGlite reads can write physical housekeeping pages. A frozen-copy hash alone says nothing about the served store.
    // Product identity, manifest path, repository symlink and home never move; no fill/reset endpoint is called.
    const liveGraph = join(home, '.madarch', 'knowledge');
    rmSync(liveGraph, { recursive: true, force: true });
    cpSync(join(work, 'frozen-home', '.madarch', 'knowledge'), liveGraph, { recursive: true });
    const live: Record<string, string> = {}, frozen: Record<string, string> = {};
    treeHashes(liveGraph, 'graph', live);
    treeHashes(join(work, 'frozen-home', '.madarch', 'knowledge'), 'graph', frozen);
    sameKeys(Object.entries(frozen).map(([key, hash]) => `${key}:${hash}`), Object.entries(live).map(([key, hash]) => `${key}:${hash}`), 'served graph before daemon start');
    atomicJson(join(out, 'served-graph.json'), { originalHome: home, store: liveGraph, restoredFrom: join(work, 'frozen-home', '.madarch', 'knowledge'), verifiedBeforeStart: true, hashes: live });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));
    stop = async () => command('stop'); command('start');
  }
} else {
const repository = generateTrainingRepository(join(work, 'repo'));
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));
const binary = argument('binary', '');
if (binary === '') {
  const shop = makeProduct(home, name, repository);
  writeSamplePages(shop);
  const child = Bun.spawn(['bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', home, '--port', String(port)], {
    env: { ...process.env, MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki', 'app', 'dist') },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  stop = async () => { child.kill('SIGTERM'); await child.exited; };
} else {
  // The compiled binary makes the product itself, with its own embedded starter set, and serves it with its embedded app.
  stop = async () => { const result = spawnSync(resolve(binary), ['stop', '--home', home], { encoding: 'utf8', cwd: work, timeout: 30_000 }); if (result.error || result.status !== 0) throw new Error(`binary stop failed: ${result.error ?? result.stderr}`); };
  const created = spawnSync(resolve(binary), ['new', '--home', home, '--port', String(port), '--json', '--no-open'], { encoding: 'utf8', timeout: 120_000, cwd: work, env: { ...process.env, GIT_AUTHOR_NAME: 'Diagram Shots', GIT_AUTHOR_EMAIL: 'shots@example.invalid', GIT_COMMITTER_NAME: 'Diagram Shots', GIT_COMMITTER_EMAIL: 'shots@example.invalid' } });
  if (created.status !== 0) throw new Error(`the binary could not make the product: ${created.stderr}${created.stdout}`);
  const facts = JSON.parse(created.stdout.trim().split('\n').filter((line) => line.startsWith('{')).pop()!) as { folder: string; url: string };
  name = basename(facts.folder);
  base = new URL(facts.url).origin;
  const manifest = join(facts.folder, 'workspace.yaml');
  writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'training', linked: true }));
  symlinkSync(repository, join(facts.folder, 'repos', 'training'));
  writeSamplePages(facts.folder);

}
}
if (runPhase !== 'aggregate') for (let tries = 0; ; tries += 1) {
  try { if ((await fetch(`${base}/`)).ok) break; } catch { /* not listening yet */ }
  if (tries > 120) throw new Error(`the server did not answer on ${base}`);
  await new Promise((rest) => setTimeout(rest, 500));
}

// The first open asks which role the reader reads as, over every page: the walk answers it the way the file does, so
// no picture carries the dialog (the owner's review of 2026-10-24).
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));

if (runPhase === 'all' || runPhase === 'prepare') {
enterPhase('fill');
const started = await fetch(`${base}/products/${name}/api/k/fill`, { method: 'POST' });
if (!started.ok) throw new Error(`the fill did not start: ${started.status} ${await started.text()}`);
for (const until = Date.now() + 900_000; ; ) {
  const status = (await (await fetch(`${base}/products/${name}/api/k/status`)).json()) as { fill: { state: string; message?: string } };
  if (status.fill.state === 'done') break;
  if (status.fill.state === 'failed') throw new Error(`the fill failed: ${status.fill.message}`);
  if (Date.now() > until) throw new Error('the fill did not finish in 15 minutes');
  await new Promise((rest) => setTimeout(rest, 3000));
}

}
// Read every declared page through JSON before taking pictures. Keep every response and every failure, not a sample.
if (runPhase === 'all' || runPhase === 'prepare' || runPhase === 'json') {
enterPhase('json-discovery');
const statusResponse = await fetch(`${base}/products/${name}/api/k/status`);
if (!statusResponse.ok) throw new Error(`${resolve(import.meta.dir, 'diagram-shots.ts')} [status]: status HTTP ${statusResponse.status}`);
const wikiStatus = await statusResponse.json() as { kinds: { kind: string }[] };
const pageIds = new Set<string>(frozenPlan?.ids ?? []);
mkdirSync(join(out, 'pages'), { recursive: true });
for (const kind of (frozenPlan ? [] : [...wikiStatus.kinds]).sort((a,b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)) {
  let after: string | null = null;
  do {
    const query = new URLSearchParams({kind:kind.kind,limit:'500', ...(after === null ? {} : {after})});
    const listingResponse = await fetch(`${base}/products/${name}/api/k/entities?${query}`);
    if (!listingResponse.ok) throw new Error(`${resolve(import.meta.dir, 'diagram-shots.ts')} [entity-list]: kind ${kind.kind}: HTTP ${listingResponse.status}`);
    const listing = await listingResponse.json() as { rows: { id: string }[]; next: string | null };
    for (const row of listing.rows) { if (pageIds.has(row.id)) throw new Error(`duplicate discovered entity ${row.id} in ${kind.kind}`); pageIds.add(row.id); }
    if (listing.next === after && after !== null) throw new Error(`${resolve(import.meta.dir, 'diagram-shots.ts')} [entity-list-pagination]: kind ${kind.kind}: repeated pagination cursor ${after}`);
    after = listing.next;
  } while (after !== null);
}
expectedJson = pageIds.size * 2;
atomicJson(join(out, 'page-plan.json'), [...pageIds].sort());
if (runPhase === 'prepare') frozenPlan = { ids: [...pageIds].sort(), pages: [], images: [], matrices: [] };
if (runPhase !== 'prepare') {
enterPhase('json-pages');
for (const id of [...pageIds].sort()) for (const lang of ['en','ru']) {
      const response = await fetch(`${base}/products/${name}/api/k/page?${new URLSearchParams({id:id,lang,full:'1'})}`);
      const raw = await response.text();
      let body: { id?: string; blocks?: { type: string; file?: string; line?: number; message?: string }[]; message?: string };
      try { body = JSON.parse(raw); } catch (error) { writeFileSync(join(out, 'pages', `${String(apiPages.length).padStart(5, '0')}-${lang}-invalid.txt`), raw); throw new Error(`JSON page ${id} ${lang}: ${error instanceof Error ? error.stack : String(error)}`); }
      const file = `${String(apiPages.length).padStart(5,'0')}-${lang}.json`;
      writeFileSync(join(out,'pages',file),JSON.stringify(body,null,2));
      apiPages.push({id:id,lang,status:response.status,file:`pages/${file}`,blocks:body.blocks?.map(b=>b.type) ?? [],error:response.ok ? null : body.message ?? body});
      atomicJson(join(out,'page-walk.json'),apiPages);
      completion('running');
      if (!response.ok) failure('json-page', `${id} ${lang}: HTTP ${response.status}: ${JSON.stringify(body)}`);
      else if (body.id !== id || !Array.isArray(body.blocks)) failure('json-page-shape', `${id} ${lang}: expected matching id and blocks array: ${JSON.stringify(body)}`);
      else for (const block of body.blocks) if (block.type === 'problem') failure('json-page-problem', `${id} ${lang}: ${JSON.stringify(block)}; full response ${join(out, 'pages', file)}`);
      if (failures.length > 0) throw new Error(`JSON acceptance stopped at first failing page ${id} ${lang}`);
    }
console.log(`JSON page walk: ${apiPages.length} observations; ${apiPages.filter(p=>p['status']!==200).length} failures`);
sameKeys([...pageIds].flatMap(id => ['en', 'ru'].map(lang => JSON.stringify([id, lang]))), apiPages.map(row => JSON.stringify([row['id'], row['lang']])), 'JSON observations');
}
}

const encode = encodeURIComponent;
const at = (id: string): string => `/products/${name}/k/e/${encode(id)}`;
const key = (kind: string, rest: string): string => `${kind}:${rest}`;
const pages: { name: string; url: string; wait: string; fixture?: unknown }[] = [
  { name: 'home', url: `/products/${name}/k`, wait: '[data-diagram=views] [data-testid=view]' },
  // The domain list: the map of the domains with the services behind them (the owner's first ask).
  { name: 'domain-list', url: `/products/${name}/k/kind/domain`, wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'domain-payment', url: at('domain:payment'), wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'route-post-orders', url: at(key('code.route', 'services/orders/internal/api/router.go#POST:/orders')), wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'route-post-checkout', url: at(key('code.route', 'services/checkout/src/api/routes.ts#POST:/checkout')), wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'service-payments', url: at('code.service:payments'), wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'service-orders', url: at('code.service:orders'), wait: '[data-diagram=treemap] [data-testid=treemap-file]' },
  { name: 'file-order-go', url: at(key('code.file', 'services/orders/internal/domain/order.go')), wait: '[data-diagram=views] [data-testid=view]' },
  { name: 'function-pay', url: at(key('code.symbol', 'services/payments/src/domain/payment-service.ts#PaymentService.pay')), wait: '[data-diagram=neighborhood] [data-testid=hood-node]' },
  { name: 'table-orders', url: at(key('code.table', 'orders/public.orders')), wait: '[data-diagram=neighborhood] [data-testid=hood-node]' },
  { name: 'database-orders', url: at(key('code.database', 'orders')), wait: '[data-diagram=views] [data-testid=view]' },
];
if (runPhase === 'prepare') {
  // These named synthetic cases use the real app. They never replace any of the eleven training pages.
  const templateResponse = await fetch(`${base}/products/${name}/api/k/page?${new URLSearchParams({ id: 'code.database:orders', full: '1', lang: 'en' })}`);
  if (!templateResponse.ok) throw new Error(`fixture template: HTTP ${templateResponse.status}`);
  const template = await templateResponse.json() as Record<string, unknown>;
  for (const item of await diagramAcceptanceCases('en')) pages.push({ name: item.name, url: at('code.database:orders'), wait: '[data-diagram=views] [data-testid=view]', fixture: { ...template, blocks: [{ type: 'diagrams', title: item.name, renderer: 'likec4', views: item.views }] } });
} else if (frozenPlan) {
  for (const entry of frozenPlan.pages.filter(entry => entry.lang === 'en' && entry.fixture !== undefined)) pages.push({ name: entry.name, url: entry.url, wait: entry.wait, fixture: entry.fixture });
}
async function installFixture(page: Page, fixture: unknown): Promise<void> {
  if (fixture === undefined) return;
  const data = fixture as { blocks: { views: { query: string }[] }[]; acceptanceFrames: Record<string, { contentType: string; body: string }> };
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/api/k/page')) void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    else if (url.pathname.endsWith('/api/k/view-frame')) {
      const query = new URLSearchParams(url.search); const renderer = query.get('renderer'); query.delete('renderer'); query.delete('lang');
      const response = data.acceptanceFrames[`${query.toString()}|${renderer}`];
      if (!response) { failure('fixture-frame', `unplanned fixture frame ${url}`); void request.respond({ status: 500, body: `Unplanned fixture frame ${url}` }); }
      else void request.respond({ status: 200, ...response });
    } else void request.continue();
  });
}
const views = [{ tag: '1150-light', width: 1150, scheme: 'light' as const }, { tag: '1150-dark', width: 1150, scheme: 'dark' as const }, { tag: '390-light', width: 390, scheme: 'light' as const }, { tag: '390-dark', width: 390, scheme: 'dark' as const }];

expectedPageVariants = pages.length * views.length * 2;
atomicJson(join(out, 'screenshot-page-plan.json'), { pages, viewports: views, languages: ['en', 'ru'], expectedPageVariants });
enterPhase('screenshots');
const browser = (runPhase === 'all' || runPhase === 'prepare' || runPhase === 'matrix') ? await puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] }) : undefined;
closeBrowser = async () => { await browser?.close(); };
const plannedImages = (entry: PlannedPage, tag: string): string[] => [
  `${entry.name}-${tag}-${entry.lang}.png`,
  ...entry.blocks.flatMap((views, blockAt) => views.flatMap(view => view.renderers.flatMap(renderer => {
    const label = `${entry.name}-block${blockAt}-${view.type}-${renderer}-${tag}-${entry.lang}`;
    return [`${label}.png`, `${label}-full.png`];
  }))),
];
if (runPhase === 'prepare') {
  enterPhase('immutable-plan');
  for (const lang of ['en', 'ru']) for (const entry of pages) {
    const page = await browser!.newPage();
    let fixture = entry.fixture;
    if (fixture !== undefined) {
      const item = (await diagramAcceptanceCases(lang)).find(item => item.name === entry.name)!;
      const acceptanceFrames: Record<string, { contentType: string; body: string }> = {};
      for (const view of item.views) for (const renderer of view.renderers) {
        if (renderer === 'mermaid') continue;
        if (renderer === 'likec4') {
          const result = await likec4Model(view);
          if (!result.ok) throw new Error(`${item.name} ${lang} LikeC4 fixture: ${result.message}`);
          acceptanceFrames[`${view.query}|${renderer}`] = { contentType: 'application/json', body: JSON.stringify(result) };
        } else {
          const result = await archifyFrame(view, { ...process.env, MADARCH_APP_DIST: resolve(import.meta.dir, '..', 'wiki/app/dist') });
          if (!result.ok) throw new Error(`${item.name} ${lang} archify fixture: ${result.message}`);
          acceptanceFrames[`${view.query}|${renderer}`] = { contentType: 'text/html', body: result.html };
        }
      }
      fixture = { ...(fixture as Record<string, unknown>), acceptanceFrames, blocks: [{ type: 'diagrams', title: item.name, renderer: 'likec4', views: item.views }] };
    }
    await installFixture(page, fixture);
    try {
      await page.evaluateOnNewDocument(language => localStorage.setItem('madarch-wiki-language', language), lang);
      await page.setViewport({ width: 1150, height: 900 });
      const response = await page.goto(`${base}${entry.url}`, { waitUntil: 'domcontentloaded' });
      if (!response?.ok()) throw new Error(`plan ${entry.url}: HTTP ${response?.status()}`);
      await page.waitForSelector(entry.wait, { timeout: 90_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-diagram=deferred]').length === 0, { timeout: 90_000 });
      const originalViews = new Map<string, string[]>();
      let payloadViews: (AdjacentView & { query: string; renderers: string[] })[];
      if (entry.name === 'domain-list') {
        const response = await fetch(`${base}/products/${name}/api/k/view?${new URLSearchParams({ type: 'domain-map', subject: 'domain', lang })}`);
        if (!response.ok) throw new Error(`plan domain-map payload HTTP ${response.status}`);
        payloadViews = (await response.json() as { views: (AdjacentView & { query: string; renderers: string[] })[] }).views;
      } else {
        const status = entry.name === 'home' ? await (await fetch(`${base}/products/${name}/api/k/status`)).json() as { home: string | null } : null;
        const id = status?.home ?? decodeURIComponent(entry.url.split('/k/e/')[1] ?? '');
        const response = fixture === undefined ? await fetch(`${base}/products/${name}/api/k/page?${new URLSearchParams({ id, lang, full: '1' })}`) : null;
        if (response && !response.ok) throw new Error(`plan ${entry.name} payload HTTP ${response.status}`);
        const originalBlocks = fixture ?? await response!.json();
        payloadViews = (originalBlocks as { blocks?: { views?: (AdjacentView & { query: string; renderers: string[] })[] }[] }).blocks?.flatMap(block => block.views ?? []) ?? [];
      }
      for (const view of payloadViews) originalViews.set(view.query, adjacentKeys(view));
      const blocks: PlannedView[][] = [];
      const count = await page.$$eval('[data-diagram=views]', nodes => nodes.length);
      for (let blockAt = 0; blockAt < count; blockAt++) {
        const views: PlannedView[] = [];
        const tabs = await page.evaluate(at => Math.max(1, document.querySelectorAll('[data-diagram=views]')[at]!.querySelectorAll('[data-testid=view-tab]').length), blockAt);
        for (let viewAt = 0; viewAt < tabs; viewAt++) {
          await page.evaluate(([at, step]) => (document.querySelectorAll('[data-diagram=views]')[at]?.querySelectorAll('[data-testid=view-tab]')[step] as HTMLElement | undefined)?.click(), [blockAt, viewAt]);
          await page.waitForFunction(([at, step]) => {
            const block = document.querySelectorAll('[data-diagram=views]')[at];
            const tabs = block?.querySelectorAll('[data-testid=view-tab]');
            return Boolean(block?.querySelector('[data-testid=view]')) && (!tabs?.length || tabs[step]?.getAttribute('aria-selected') === 'true');
          }, {}, [blockAt, viewAt]);
          await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const plannedView = await page.evaluate(at => {
            const block = document.querySelectorAll('[data-diagram=views]')[at]!;
            return { type: block.querySelector('[data-testid=view]')!.getAttribute('data-view')!, query: block.querySelector('[data-testid=view]')!.getAttribute('data-view-query')!, renderers: [...block.querySelectorAll('[data-testid^=renderer-]')].map(node => node.getAttribute('data-testid')!.slice('renderer-'.length)) };
          }, blockAt);
          const keys = originalViews.get(plannedView.query);
          if (!keys) throw new Error(`missing payload adjacent identities ${entry.name} ${lang} ${plannedView.query}`);
          views.push({ ...plannedView, adjacentKeys: keys });
        }
        if (views.some(view => !view.type || view.renderers.length === 0)) throw new Error(`incomplete renderer plan ${entry.name} block${blockAt}`);
        blocks.push(views);
      }
      sameViews(payloadViews, blocks.flat(), `${entry.name} ${lang} payload/DOM`);
      frozenPlan!.pages.push({ ...entry, ...(fixture === undefined ? {} : { fixture }), lang, blocks });
    } finally { await page.close(); }
  }
  if (frozenPlan!.ids.length === 0 || frozenPlan!.pages.length !== 28) throw new Error(`prepare exact plan: expected 11 training +3 explicit cases in both languages; got ${frozenPlan!.pages.length}, IDs ${frozenPlan!.ids.length}`);
  frozenPlan!.matrices = ['en', 'ru'].flatMap(lang => views.map(view => `${view.tag}-${lang}`));
  frozenPlan!.images = frozenPlan!.pages.flatMap(entry => views.flatMap(view => plannedImages(entry, view.tag)));
  sameKeys(frozenPlan!.images, frozenPlan!.images, 'planned images');
  await cleanup();
  cpSync(home, join(work, 'frozen-home'), { recursive: true, errorOnExist: true, force: false });
  const binary = resolve(argument('binary', ''));
  if (argument('binary', '') === '') throw new Error('phased acceptance requires a compiled binary');
  prepared = { name, port, binary, work, plan: frozenPlan!, planHash: digest(JSON.stringify(frozenPlan)), inputs: inputHashes(binary) };
  atomicJson(preparedFile, prepared);
}

const checkpoint = (): void => atomicJson(join(out, 'measures.json'), report);

/** Rendered label sizes and overlaps of the SVG texts of each diagram on the page. */
async function measure(page: Page): Promise<unknown> {
  return await page.evaluate(() => {
    const result: Record<string, unknown> = {};
    document.querySelectorAll('[data-diagram]').forEach((diagram, index) => {
      const name = `${diagram.getAttribute('data-diagram')}#${index}`;
      const texts = [...diagram.querySelectorAll('svg text')].filter((node) => (node.textContent ?? '').trim() !== '') as SVGTextElement[];
      const boxes = texts.map((node) => ({ node, rect: node.getBoundingClientRect(), size: parseFloat(getComputedStyle(node).fontSize) * (typeof node.getScreenCTM === 'function' ? node.getScreenCTM()?.a ?? 1 : 1) }));
      const overlaps: string[] = [];
      for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!.rect; const b = boxes[j]!.rect;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left); const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1.5 && h > 1.5) overlaps.push(`${boxes[i]!.node.textContent} / ${boxes[j]!.node.textContent}`);
      }
      const frame = diagram.querySelector('svg')?.getBoundingClientRect();
      const clipped = frame === undefined ? [] : boxes.filter((box) => box.rect.width > 0 && (box.rect.right > frame.right + 1 && !diagram.querySelector('.dg-scroll'))).map((box) => box.node.textContent ?? '');
      result[name] = { texts: boxes.length, minFontPx: Math.round(Math.min(...boxes.map((box) => box.size)) * 10) / 10, overlaps: overlaps.slice(0, 8), clipped: clipped.slice(0, 5) };
    });
    return result;
  });
}

/**
 * Walks every views block of a page: each view tab, each renderer tab under it, and — for every one of them — the page's
 * own viewport as a reader sees it, plus the diagram in full screen. The tabs are re-read on every step (a step replaces
 * the block's state), and a renderer the tab does not offer is never asked for.
 */
async function walkViews(page: Page, entry: { name: string }, tag: string, lang: string): Promise<void> {
  const blocks = await page.evaluate(() => document.querySelectorAll('[data-diagram=views]').length);
  const planned = frozenPlan?.pages.find(item => item.name === entry.name && item.lang === lang);
  if (frozenPlan && (!planned || planned.blocks.length !== blocks)) throw new Error(`${entry.name} ${lang}: block plan mismatch`);
  for (let blockAt = 0; blockAt < blocks; blockAt += 1) {
    const viewTabs = await page.evaluate((at) => [...document.querySelectorAll('[data-diagram=views]')[at]!.querySelectorAll('[data-testid=view-tab]')].map((node) => (node.textContent ?? '').trim()), blockAt);
    const steps = Math.max(1, viewTabs.length);
    if (planned && planned.blocks[blockAt]!.length !== steps) throw new Error(`${entry.name}: view count mismatch`);
    for (let viewAt = 0; viewAt < steps; viewAt += 1) {
      await page.evaluate(([at, step]) => {
        const block = document.querySelectorAll('[data-diagram=views]')[at];
        const tab = block?.querySelectorAll('[data-testid=view-tab]')[step];
        if (tab instanceof HTMLElement) tab.click();
      }, [blockAt, viewAt]);
      await new Promise((rest) => setTimeout(rest, 400));
      const type = await page.evaluate((at) => document.querySelectorAll('[data-diagram=views]')[at]?.querySelector('[data-testid=view]')?.getAttribute('data-view') ?? 'view', blockAt);
      const renderers = await page.evaluate((at) => [...document.querySelectorAll('[data-diagram=views]')[at]!.querySelectorAll('[data-testid^=renderer-]')].map((node) => node.getAttribute('data-testid')!.slice('renderer-'.length)), blockAt);
      if (renderers.length === 0) throw new Error(`${entry.name} block ${blockAt} view ${type}: no offered renderer to walk`);
      if (planned) {
        const expected = planned.blocks[blockAt]![viewAt]!;
        const query = await page.evaluate(at => document.querySelectorAll('[data-diagram=views]')[at]?.querySelector('[data-testid=view]')?.getAttribute('data-view-query'), blockAt);
        if (expected.type !== type || expected.query !== query) throw new Error(`${entry.name}: planned type/query ${expected.type}/${expected.query}, actual ${type}/${query}`);
        const actualKeys = await page.evaluate(at => [...document.querySelectorAll('[data-diagram=views]')[at]!.querySelectorAll('[data-testid=view-elements] > li, [data-testid=view-steps] > li')].map(node => node.getAttribute('data-adjacent-key') ?? node.getAttribute('data-element') ?? ''), blockAt);
        sameKeys(expected.adjacentKeys, actualKeys, `${entry.name} ${lang} ${type} adjacent identities`);
        sameKeys(expected.renderers, renderers, `${entry.name} ${type} renderers`);
      }
      for (const renderer of renderers) {
        const observationAt = Date.now();
        await page.evaluate(([at, name]) => {
          const block = document.querySelectorAll('[data-diagram=views]')[at];
          const tab = block?.querySelector(`[data-testid=renderer-${name}]`);
          if (tab instanceof HTMLElement) tab.click();
        }, [blockAt, renderer]);
        let drawn = true;
        const rendererErrors: string[] = [];
        try {
          // Each renderer is waited for where it really appears: Mermaid draws in the page, LikeC4 draws its laid-out
          // model in the page, and the archify tab frames the page the server rendered.
          if (renderer === 'mermaid') await page.waitForFunction((at) => Boolean(document.querySelectorAll('[data-diagram=views]')[at]?.querySelector('[data-testid=view-picture] svg')), { timeout: 60_000 }, blockAt);
          else if (renderer === 'likec4') await page.waitForFunction((at) => {
            const frame = document.querySelectorAll('[data-diagram=views]')[at]?.querySelector('[data-testid=view-frame-likec4]');
            if (!frame) return false;
            const hasNode = (root) => {
              if (root.querySelector('.react-flow__node, [data-node-id]')) return true;
              return [...root.querySelectorAll('*')].some((node) => node.shadowRoot !== null && hasNode(node.shadowRoot));
            };
            return hasNode(frame) || frame.querySelector('[role=alert]') !== null;
          }, { timeout: 60_000 }, blockAt);
          else await page.waitForFunction((at) => {
            const block = document.querySelectorAll('[data-diagram=views]')[at];
            const frame = block?.querySelector<HTMLIFrameElement>('iframe[data-renderer=archify]');
            return Boolean(frame?.contentDocument?.querySelector('svg, [data-frame-error]')
              || block?.querySelector('[data-testid=renderer-fallback]'));
          }, { timeout: 60_000 }, blockAt);
          // A frame that answered with an error page is not a drawing: the walk says so instead of counting it.
          if (renderer === 'archify') {
            const blocks = await page.$$('[data-diagram=views]');
            const handle = await blocks[blockAt]?.$('iframe[data-renderer=archify]');
            const frame = await handle?.contentFrame();
            if (frame !== null && frame !== undefined) {
              const failed = await frame.evaluate(() => document.querySelector('[data-frame-error]') !== null).catch(() => false);
              if (failed) { drawn = false; rendererErrors.push('archify answered [data-frame-error]'); }
            }
          }
        } catch (error) { drawn = false; rendererErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)); }
        await new Promise((rest) => setTimeout(rest, 900));
        const label = `${entry.name}-block${blockAt}-${type}-${renderer}-${tag}-${lang}`;
        imagePlan.add(`${label}.png`); imagePlan.add(`${label}-full.png`); completion('running');
        // The picture is the reader's own column, not a crop of the block.
        await page.evaluate((at) => document.querySelectorAll('[data-diagram=views]')[at]?.scrollIntoView({ block: 'center' }), blockAt);
        await new Promise((rest) => setTimeout(rest, 200));
        if (planned?.fixture !== undefined) {
          const fixtureViews = (planned.fixture as { blocks: { views: { spec: { type: string }; elements: { columns?: unknown[] }[]; fullElements?: unknown[]; fullEdges?: unknown[] }[] }[] }).blocks[blockAt]!.views;
          const model = fixtureViews[viewAt]!;
          const facts = await page.evaluate(at => {
            const block = document.querySelectorAll('[data-diagram=views]')[at]!;
            const link = block.querySelector<HTMLAnchorElement>('[data-testid=view-full-list-link]');
            return { rows: block.querySelectorAll('[data-testid=view-elements] > li').length, relationships: block.querySelectorAll('[data-testid=view-full-relationships] > li').length, target: link ? document.getElementById(decodeURIComponent(link.hash.slice(1)))?.getAttribute('data-testid') : null, tableLinks: block.querySelectorAll('[data-testid=view-elements] a').length, text: block.textContent ?? '' };
          }, blockAt);
          const expectedRows = model.fullElements?.length ?? model.elements.length;
          if (facts.rows !== expectedRows || (model.fullElements && facts.target !== 'view-full-list') || (model.fullEdges && facts.relationships !== model.fullEdges.length)) throw new Error(`${entry.name}: full ALL-list/anchor/relationship mismatch ${JSON.stringify(facts)}`);
          if (model.spec.type === 'er' && (!facts.tableLinks || !facts.text.includes('column_0') || !facts.text.includes('column_63'))) throw new Error(`${entry.name}: ER64 under-picture columns/table links missing ${JSON.stringify(facts)}`);
          atomicJson(join(out, `${label}-list-facts.json`), facts);
        }
        const measures = await measureBlock(page, blockAt, renderer);
        await page.screenshot({ path: join(out, `${label}.png`) }); completedImages.add(`${label}.png`); completion('running');
        const selected = await page.evaluate((at) => document.querySelectorAll('[data-diagram=views]')[at]?.querySelector('[data-testid=view]')?.getAttribute('data-renderer'), blockAt);
        if (selected !== renderer) { drawn = false; rendererErrors.push(`requested ${renderer}, selected ${String(selected)}`); }
        if (renderer === 'archify' && (measures?.['texts'] === undefined || measures?.['texts'] === 0)) drawn = false;
        // Full screen: the same diagram over the whole window, which is how a dense view is read.
        let full = false;
        let fullscreenError = '';
        let fullMeasures: Record<string, unknown> | undefined;
        try {
          await page.evaluate((at) => {
            const block = document.querySelectorAll('[data-diagram=views]')[at];
            const button = block?.querySelector('[data-testid=fullscreen-button]');
            if (button instanceof HTMLElement) button.click();
          }, blockAt);
          await page.waitForFunction((at) => document.querySelectorAll('[data-diagram=views]')[at]?.querySelector('[data-testid=fullscreenable]')?.getAttribute('data-fullscreen') === 'true', { timeout: 10_000 }, blockAt);
          await new Promise((rest) => setTimeout(rest, 700));
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          full = true;
        } catch (error) { full = false; fullscreenError = error instanceof Error ? error.stack ?? error.message : String(error); }
        if (full) {
          fullMeasures = await measureBlock(page, blockAt, renderer);
          const hint = await page.evaluate(at => document.querySelectorAll('[data-diagram=views]')[at]!.querySelector('.dg-view-hint')?.textContent ?? '', blockAt);
          requireHint((lang === 'ru' ? ru : en).knowledge.views.readingHint, hint, lang);
          fullMeasures['hintLanguageMatched'] = lang;
          await page.screenshot({ path: join(out, `${label}-full.png`) }); completedImages.add(`${label}-full.png`); completion('running');
          fullMeasures['interaction'] = await exerciseControls(page, blockAt, renderer);
          await page.keyboard.press('Escape');
          await new Promise((rest) => setTimeout(rest, 300));
        }
        // Captions and edge labels are diagnostics, not the review's title-size acceptance floor.
        const valid = (value: Record<string, unknown> | undefined): boolean => value?.['measurementStatus'] === 'measured' && Number(value['totalTitles']) > 0 && typeof value['smallestTitlePx'] === 'number' && Number.isFinite(value['smallestTitlePx']) && value['smallestTitlePx'] > 0 && typeof value['wholeFit'] === 'boolean' && typeof value['scale'] === 'number' && Number.isFinite(value['scale']) && value['scale'] > 0;
        report[label] = { drawn: drawn && valid(measures), rendererErrors, full, measurementValid: valid(measures), ...(measures ?? {}), fullMeasurementValid: full && valid(fullMeasures), fullMeasures: fullMeasures ?? { measurementStatus: 'error', measurementError: `${resolve(import.meta.dir, 'diagram-shots.ts')} [fullscreen-observation]: ${label}: full-screen observation unavailable: ${fullscreenError}`, wholeFit: null, scale: null, smallestTitlePx: null, titlesVisibleInFull: null, clippedTitles: null, totalTitles: null } };
        const observation = report[label] as { drawn: boolean; measurementValid: boolean; fullMeasurementValid: boolean };
        const reading = (value: Record<string, unknown> | undefined, floor: number, overview: boolean): boolean => {
          if (!valid(value) || Number(value!['smallestTitlePx']) + 0.01 < floor || Number(value!['clippedTitleCount']) !== 0) return false;
          const visible = value!['titlesVisibleInFull'] as { count?: number } | undefined;
          if (overview && value!['wholeFit'] !== true) return false;
          if (value!['wholeFit'] !== true && (Number(visible?.count) < Math.min(2, Number(value!['totalTitles'])) || value!['readingWindowValid'] !== 'true' || value!['firstContentTitleVisible'] !== true)) return false;
          return renderer !== 'mermaid' || Number(value!['rightClippedEdgeLabels'] instanceof Array ? value!['rightClippedEdgeLabels'].length : NaN) === 0;
        };
        const phoneFullscreen = tag.startsWith('390-');
        const phoneWindow = fullMeasures?.['readingUi'] as { hintVisible?: boolean; completeAdjacentList?: boolean } | undefined;
        const phoneControls = fullMeasures?.['panAvailable'] === true && fullMeasures?.['zoomAvailable'] === true && phoneWindow?.hintVisible === true && phoneWindow?.completeAdjacentList === true;
        const initialAccepted = reading(measures, 11, false), fullscreenAccepted = full && reading(fullMeasures, 9, !phoneFullscreen) && (!phoneFullscreen || phoneControls);
        Object.assign(report[label]!, { initialAccepted, fullscreenAccepted, elapsedMs: Date.now() - observationAt });
        if (!observation.drawn || !initialAccepted || !fullscreenAccepted || rendererErrors.length > 0) failure('diagram-observation', `${label}: invalid observation: ${JSON.stringify(report[label])}`);
        checkpoint();
        if (failures.length > 0) throw new Error(`stopped at first failed diagram ${label}`);
      }
    }
  }
}

/** Real controls and gestures, after the immutable baseline pictures. Readiness is bounded, never a fixed sleep. */
async function exerciseControls(page: Page, blockAt: number, renderer: string): Promise<Record<string, unknown>> {
  const frameHandle = renderer === 'archify' ? await (await page.$$('[data-diagram=views]'))[blockAt]?.$('iframe[data-renderer=archify]') : null;
  const context = renderer === 'archify' ? await frameHandle?.contentFrame() : page;
  if (!context) throw new Error(`interaction ${renderer}: renderer document is absent`);
  const options = { blockAt, renderer };
  const setup = String.raw`(options => {
    const deep = (root, selector) => { const found = [...root.querySelectorAll(selector)]; for (const node of root.querySelectorAll('*')) if (node.shadowRoot) found.push(...deep(node.shadowRoot, selector)); return found; };
    const block = options.renderer === 'archify' ? document : document.querySelectorAll('[data-diagram=views]')[options.blockAt];
    const viewport = options.renderer === 'archify' ? document.querySelector('.diagram-container') : options.renderer === 'mermaid' ? block.querySelector('[data-testid=zoom-box]') : deep(block, '.react-flow')[0];
    const drawing = options.renderer === 'likec4' ? deep(block, '.react-flow__viewport')[0] : viewport.querySelector('svg');
    if (!viewport || !drawing) throw new Error('interaction viewport/drawing absent');
    const buttons = deep(block, 'button');
    const control = action => options.renderer === 'mermaid' ? block.querySelector('[data-testid=zoom-'+action+']') : options.renderer === 'archify' ? document.querySelector('.diagram-nav [data-view="'+action+'"]') : buttons.find(button => new RegExp('zoom[ -]?'+action,'i').test((button.getAttribute('aria-label') || '')+' '+(button.getAttribute('title') || '')));
    const state = () => { const r=drawing.getBoundingClientRect(); const m=options.renderer === 'likec4' ? new DOMMatrixReadOnly(getComputedStyle(drawing).transform) : drawing.getScreenCTM(); return {scale:Math.hypot(m.a,m.b),x:r.left,y:r.top,scrollX:viewport.scrollLeft,scrollY:viewport.scrollTop,maxX:viewport.scrollWidth-viewport.clientWidth,maxY:viewport.scrollHeight-viewport.clientHeight}; };
    const at=viewport.getBoundingClientRect();
    window.__diagramInteraction={state,control,viewport,baseline:state()};
    return { baseline:state(), point:{x:Math.max(1,at.left+at.width/2),y:Math.max(1,at.top+at.height/2)} };
  })`;
  const initial = await context.evaluate(`${setup}(${JSON.stringify(options)})`) as { baseline: { scale: number }; point: { x: number; y: number } };
  await context.evaluate(`(() => { const button=window.__diagramInteraction.control('in'); if(!button || button.disabled) throw new Error('zoom-in is unavailable'); button.click(); })()`);
  await context.waitForFunction(`window.__diagramInteraction.state().scale > window.__diagramInteraction.baseline.scale * 1.01`, { timeout: 5000, polling: 'raf' });
  const zoomed = await context.evaluate(`window.__diagramInteraction.state()`) as Record<string, number>;
  // Scroll renderers need a real overflow range. Bounded real zoom clicks create it for a small overview.
  if (renderer !== 'likec4') {
    for (let attempt = 0; attempt < 8; attempt++) {
      const range = await context.evaluate(`(() => { const s=window.__diagramInteraction.state(); return s.maxX+s.maxY; })()`) as number;
      if (range > 10) break;
      await context.evaluate(`(() => { const b=window.__diagramInteraction.control('in'); if(!b || b.disabled) throw new Error('zoom limit reached before a pan range'); window.__diagramInteraction.previous=window.__diagramInteraction.state().scale; b.click(); })()`);
      await context.waitForFunction(`window.__diagramInteraction.state().scale > window.__diagramInteraction.previous * 1.01`, { timeout: 5000, polling: 'raf' });
    }
  }
  const beforePan = await context.evaluate(`window.__diagramInteraction.state()`) as Record<string, number>;
  let point = initial.point;
  if (frameHandle) { const bounds = await frameHandle.boundingBox(); if (!bounds) throw new Error('interaction iframe has no box'); point = { x: point.x + bounds.x, y: point.y + bounds.y }; }
  await page.mouse.move(point.x, point.y);
  if (renderer === 'likec4') {
    await page.mouse.down(); await page.mouse.move(point.x + 55, point.y + 45, { steps: 5 }); await page.mouse.up();
  } else {
    const directionX = Number(beforePan['scrollX']) > 5 ? -80 : 80;
    const directionY = Number(beforePan['scrollY']) > 5 ? -80 : 80;
    await page.mouse.wheel({ deltaX: directionX, deltaY: directionY });
  }
  await context.waitForFunction(`(() => { const s=window.__diagramInteraction.state(), b=${JSON.stringify(beforePan)}; return Math.abs(s.x-b.x)+Math.abs(s.y-b.y)>2; })()`, { timeout: 5000, polling: 'raf' });
  const afterPan = await context.evaluate(`window.__diagramInteraction.state()`);
  return { zoomWorked: true, panWorked: true, baseline: initial.baseline, zoomed, beforePan, afterPan };
}

/** The actual browser geometry of one block, including titles outside its viewport. */
async function measureBlock(page: Page, blockAt: number, renderer: string): Promise<Record<string, unknown>> {
  try {
    const readingUi = await page.evaluate(at => {
      const block = document.querySelectorAll('[data-diagram=views]')[at]!;
      const hint = block.querySelector<HTMLElement>('.dg-view-hint');
      const rect = hint?.getBoundingClientRect();
      const expected = Number(block.querySelector('[data-testid=view]')?.getAttribute('data-adjacent-list-count'));
      const rows = block.querySelectorAll('[data-testid=view-elements] > li, [data-testid=view-steps] > li');
      return { hintVisible: Boolean(hint?.textContent?.trim() && rect && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight), completeAdjacentList: expected > 0 && rows.length === expected, expectedListRows: expected, listRows: rows.length };
    }, blockAt);
    const options = JSON.stringify({ blockAt, renderer });
    if (renderer !== 'archify') return { ...await page.evaluate(`(${DIAGRAM_MEASURES})(${options})`) as Record<string, unknown>, readingUi };
    const blocks = await page.$$('[data-diagram=views]');
    const handle = await blocks[blockAt]?.$('iframe[data-renderer=archify]');
    const frame = await handle?.contentFrame();
    if (frame === null || frame === undefined) throw new Error('the block-scoped archify iframe has no document');
    await frame.waitForSelector('.diagram-container svg', { timeout: 10_000 });
    const parentViewport = await handle!.evaluate((node) => {
      const r = node.getBoundingClientRect();
      let left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
      for (let at = node.parentElement; at !== null; at = at.parentElement) {
        const style = getComputedStyle(at), box = at.getBoundingClientRect();
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
      const frame = node as HTMLIFrameElement;
      const sx = r.width / frame.offsetWidth, sy = r.height / frame.offsetHeight;
      const x = r.left + frame.clientLeft * sx, y = r.top + frame.clientTop * sy;
      return { left: (left - x) / sx, top: (top - y) / sy, right: (right - x) / sx, bottom: (bottom - y) / sy };
    });
    return { ...await frame.evaluate(`(${DIAGRAM_MEASURES})(${JSON.stringify({ blockAt, renderer, parentViewport })})`) as Record<string, unknown>, readingUi };
  } catch (error) {
    return { measurementStatus: 'error', measurementError: `${resolve(import.meta.dir, 'diagram-measures.ts')} [measure-block]: [data-diagram=views] block ${blockAt}, renderer ${renderer}: ${error instanceof Error ? error.stack ?? error.message : String(error)}; observation caller: ${new Error().stack}`, texts: 0, minFontPx: null, wholeFit: null, scale: null, smallestTitlePx: null, titlesVisibleInFull: null, clippedTitles: null, totalTitles: null };
  }
}

if (runPhase === 'all' || runPhase === 'matrix') {
if (runPhase === 'matrix' && !frozenPlan!.matrices.includes(matrix)) throw new Error(`unknown fixed matrix ${matrix}`);
expectedPageVariants = runPhase === 'matrix' ? pages.length : pages.length * views.length * 2;
if (runPhase === 'matrix') for (const key of frozenPlan!.pages.filter(entry => matrix.endsWith(`-${entry.lang}`)).flatMap(entry => plannedImages(entry, matrix.slice(0, -3)))) imagePlan.add(key);
for (const lang of ['en', 'ru'] as const) {
  for (const view of views) {
    if (runPhase === 'matrix' && `${view.tag}-${lang}` !== matrix) continue;
    for (const entry of pages) {
      const page = await browser!.newPage();
      await installFixture(page, frozenPlan?.pages.find(item => item.name === entry.name && item.lang === lang)?.fixture ?? entry.fixture);
      await page.evaluateOnNewDocument((language) => { try { localStorage.setItem('madarch-wiki-language', language); } catch { /* storage off */ } }, lang);
      await page.setViewport({ width: view.width, height: 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: view.scheme }]);
      page.on('pageerror', (error) => failure('browser-pageerror', `${entry.url} ${lang}: ${error.message}`));
      const response = await page.goto(`${base}${entry.url}`, { waitUntil: 'domcontentloaded' });
      if (!response?.ok()) failure('browser-http', `${entry.url}: HTTP ${String(response?.status())}`);
      try {
        await page.waitForSelector(entry.wait, { timeout: 90_000 });
        await page.waitForFunction(() => document.querySelectorAll('[data-diagram=deferred]').length === 0, { timeout: 90_000 });
      } catch (error) {
        failure('browser-ready', `${entry.name} ${view.tag} ${lang}: ${entry.wait} never appeared: ${(error as Error).message}`);
      }
      await new Promise((rest) => setTimeout(rest, 800));
      // The page picture is the whole page in the reader's own column: the viewport is the width asked for, and the
      // capture takes its height, so the column never changes from one picture to the next.
      const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll('main, [data-testid=entity-page]')].map((element) => element.scrollHeight)));
      await page.setViewport({ width: view.width, height: Math.min(9000, Math.max(900, height)) });
      await new Promise((rest) => setTimeout(rest, 800));
      const pageImage = `${entry.name}-${view.tag}-${lang}.png`;
      imagePlan.add(pageImage); completion('running');
      await page.screenshot({ path: join(out, pageImage), fullPage: true }); completedImages.add(pageImage); completion('running');
      report[`${entry.name}-${view.tag}-${lang}`] = await measure(page);
      checkpoint();
      // The diagrams are walked in a plain viewport again: a window as tall as the page would stretch every frame.
      await page.setViewport({ width: view.width, height: 900 });
      await new Promise((rest) => setTimeout(rest, 500));
      await walkViews(page, entry, view.tag, lang);
      await page.close(); completedPages++; completion('running');
      if (failures.length > 0) throw new Error(`stopped at first failed page ${entry.name}`);
    }
  }
}
checkpoint();
if (frozenPlan) sameKeys(frozenPlan.pages.filter(entry => `${matrix}`.endsWith(`-${entry.lang}`)).flatMap(entry => plannedImages(entry, matrix.slice(0, -3))), [...completedImages], `matrix ${matrix}`);
}
if (runPhase === 'aggregate') {
  enterPhase('exact-aggregation');
  const read = (phase: string, file: string): any => JSON.parse(readFileSync(join(evidenceRoot, phase, file), 'utf8'));
  for (const phase of ['prepare', 'json', ...frozenPlan!.matrices.map(tag => `matrix-${tag}`)]) {
    const state = read(phase, 'completion.json');
    if (state.status !== 'complete' || state.failures !== 0 || state.cleanup !== 'complete' || state.planHash !== prepared!.planHash) throw new Error(`${phase}: not complete/clean on immutable plan ${prepared!.planHash}`);
  }
  const rows = read('json', 'page-walk.json') as Record<string, unknown>[];
  sameKeys(frozenPlan!.ids.flatMap(id => ['en', 'ru'].map(lang => JSON.stringify([id, lang]))), rows.map(row => JSON.stringify([row['id'], row['lang']])), 'aggregate JSON');
  for (const row of rows) {
    if (row['status'] !== 200 || row['error'] !== null || typeof row['file'] !== 'string') throw new Error(`aggregate JSON failed response ${JSON.stringify(row)}`);
    const body = read('json', row['file']) as { id: string; blocks?: { type: string }[] };
    if (body.id !== row['id'] || !Array.isArray(body.blocks) || body.blocks.some(block => block.type === 'problem')) throw new Error(`aggregate JSON unclassified problem ${JSON.stringify(row)}`);
  }
  const images = frozenPlan!.matrices.flatMap(tag => read(`matrix-${tag}`, 'completion.json').screenshots.completed as string[]);
  sameKeys(frozenPlan!.images, images, 'aggregate images');
  for (const tag of frozenPlan!.matrices) {
    const state = read(`matrix-${tag}`, 'completion.json');
    if (state.pageVariants.completed !== frozenPlan!.pages.filter(entry => tag.endsWith(`-${entry.lang}`)).length || state.pageVariants.completed !== state.pageVariants.expected) throw new Error(`${tag}: page variant completion mismatch`);
    if (read(`matrix-${tag}`, 'failures.json').length !== 0) throw new Error(`${tag}: raw failures present`);
    const observations = read(`matrix-${tag}`, 'measures.json') as Record<string, any>;
    const expected = frozenPlan!.pages.filter(entry => tag.endsWith(`-${entry.lang}`)).flatMap(entry => plannedImages(entry, tag.slice(0, -3))).filter(key => key.includes('-block') && !key.endsWith('-full.png')).map(key => key.slice(0, -4));
    sameKeys(expected, Object.keys(observations).filter(key => key.includes('-block')), `${tag} measurements`);
    for (const key of expected) if (observations[key].initialAccepted !== true || observations[key].fullscreenAccepted !== true || observations[key].drawn !== true) throw new Error(`${tag}/${key}: strict numeric acceptance failed`);
    for (const file of read(`matrix-${tag}`, 'completion.json').screenshots.completed) if (!existsSync(join(evidenceRoot, `matrix-${tag}`, file)) || statSync(join(evidenceRoot, `matrix-${tag}`, file)).size === 0) throw new Error(`missing/empty screenshot ${tag}/${file}`);
  }
  atomicJson(join(out, 'aggregate.json'), { planHash: prepared!.planHash, json: rows.length, images: images.length, matrices: frozenPlan!.matrices, status: 'numeric-complete', visualAcceptance: 'pending coordinator inspection' });
}
console.log(JSON.stringify(report, null, 1));
if (failures.length > 0) throw new Error(`${resolve(import.meta.dir, 'diagram-shots.ts')} [walk-completion]: ${failures.length} acceptance failures; see ${join(out, 'failures.json')}`);

if (((runPhase === 'all' || runPhase === 'json') && apiPages.length !== expectedJson) || ((runPhase === 'all' || runPhase === 'matrix') && (completedPages !== expectedPageVariants || completedImages.size !== imagePlan.size))) throw new Error(`walk incomplete: JSON ${apiPages.length}/${String(expectedJson)}, page variants ${completedPages}/${String(expectedPageVariants)}, images ${completedImages.size}/${imagePlan.size}`);
walkSucceeded = true;
} catch (error) {
  failure('uncaught-operation', error instanceof Error ? error.stack ?? error.message : String(error));
  completion('failed', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  try { await cleanup(); completion(walkSucceeded ? 'complete' : 'failed'); } catch (error) {
    failure('cleanup', error instanceof Error ? error.stack ?? error.message : String(error));
    completion('failed', 'resource cleanup failed');
    process.exitCode = 1;
  }
}
