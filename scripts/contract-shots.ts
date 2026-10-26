/** Touched-page acceptance for madarch-m38l.16. No real agent, owner repo or external renderer assets.
 * Uses an exact-head CI artifact. Prepare the filled home once, then capture without any build or refill.
 * --mode prepare|capture --binary <artifact> --artifact <provenance.json> --head <sha>
 * --pages <JSON array file> selects only changed page ids (catalogue is the operations index).
 */
import {existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import puppeteer, {type Page} from 'puppeteer';
import {resolveBrowserExecutable} from './chromium.js';
import {generateTrainingRepository} from '../test/knowledge-fixture.js';
import {manifestWithRepo} from '../src/product/manifest.js';

const argument = (key: string, fallback: string): string => { const at = process.argv.indexOf(`--${key}`); return at < 0 ? fallback : process.argv[at + 1] ?? fallback; };
const out = resolve(argument('out', 'shots-contracts'));
const work = resolve(argument('work', '/tmp/madarch-contract-shots'));
const binary = resolve(argument('binary', ''));
const head = argument('head', '');
const mode = argument('mode', 'capture');
if (!['prepare', 'capture'].includes(mode) || !/^[a-f0-9]{40}$/u.test(head) || !argument('binary', '') || !argument('artifact', '')) throw new Error('contract-shots.ts:22: require --mode prepare|capture, --head <full sha>, --binary and --artifact provenance JSON');
const artifact = JSON.parse(readFileSync(resolve(argument('artifact', '')), 'utf8')) as {head: string; sha256: string; origin: string};
const binaryDigest = createHash('sha256').update(readFileSync(binary)).digest('hex');
if (artifact.head !== head || artifact.sha256 !== binaryDigest || !artifact.origin) throw new Error('contract-shots.ts:25: artifact head/hash/origin does not match the requested exact-head binary');
const sourceRoot = resolve(import.meta.dir, '..');
const graphPaths = ['src/extract', 'src/fill', 'src/graph', 'src/adapters', 'src/history', 'src/model', 'src/identity', 'src/vector', 'src/loop', 'src/writer', 'src/knowledge/fill-worker.ts', 'src/knowledge/fill-protocol.ts', 'src/knowledge/doc-entities.ts', 'src/knowledge/doc-sources.ts', 'src/knowledge/kinds.ts', 'src/knowledge/index', 'src/product/manifest.ts', 'schema', 'examples/training-repository', 'test/knowledge-fixture.ts', 'package.json', 'bun.lock'];
const checkedHead = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8', timeout: 30_000});
const changedInputs = spawnSync('git', ['status', '--porcelain', '--', ...graphPaths], {cwd: sourceRoot, encoding: 'utf8', timeout: 30_000});
if (checkedHead.status !== 0 || checkedHead.stdout.trim() !== head || changedInputs.status !== 0 || changedInputs.stdout.trim() !== '') throw new Error('contract-shots.ts:28: source checkout must match artifact head with clean fill-affecting inputs');
const listed = spawnSync('git', ['ls-files', '-z', ...graphPaths], {cwd: sourceRoot, encoding: 'utf8', timeout: 30_000});
if (listed.status !== 0) throw new Error(`contract-shots.ts:29: cannot inventory graph inputs: ${listed.stderr}`);
const graphHash = createHash('sha256');
for (const path of listed.stdout.split('\0').filter(Boolean).sort()) graphHash.update(path).update('\0').update(readFileSync(join(sourceRoot, path))).update('\0');
const graphInputDigest = graphHash.digest('hex');
const port = Number(argument('port', '4396'));
mkdirSync(out, {recursive: true}); mkdirSync(work, {recursive: true});
const provenanceFile = join(work, 'contract-fill.json');
type FillProvenance = {schema: 1; graphInputDigest: string; repositoryHead: string; product: string; configDigest: string; fillBinaryHead: string; fillBinarySha256: string};
const previous = existsSync(provenanceFile) ? JSON.parse(readFileSync(provenanceFile, 'utf8')) as FillProvenance : undefined;
if (mode === 'capture' && previous === undefined) throw new Error('contract-shots.ts:38: capture requires a prepared filled home and provenance; run --mode prepare once');
if (previous !== undefined && (previous.schema !== 1 || !/^[a-f0-9]{40}$/u.test(previous.repositoryHead) || !/^[a-f0-9]{40}$/u.test(previous.fillBinaryHead) || !/^[a-f0-9]{64}$/u.test(previous.fillBinarySha256) || !/^[a-f0-9]{64}$/u.test(previous.configDigest) || !/^[a-z0-9-]+$/u.test(previous.product))) throw new Error('contract-shots.ts:43: invalid fill provenance fields');
if (previous !== undefined && previous.graphInputDigest !== graphInputDigest) throw new Error('contract-shots.ts:39: graph inputs changed; use a new --work folder for one new preparation, never reuse this fill');
const repository = mode === 'prepare' && previous === undefined ? generateTrainingRepository(join(work, 'repository')) : join(work, 'repository');
const repoRevision = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8', timeout: 30_000});
if (repoRevision.status !== 0 || (previous !== undefined && previous.repositoryHead !== repoRevision.stdout.trim())) throw new Error('contract-shots.ts:42: generated repository revision differs from fill provenance');
const repositoryHead = repoRevision.stdout.trim();
const repositoryChanges = spawnSync('git', ['status', '--porcelain'], {cwd: repository, encoding: 'utf8', timeout: 30_000});
if (repositoryChanges.status !== 0 || repositoryChanges.stdout.trim() !== '') throw new Error('contract-shots.ts:49: generated fixture has uncommitted changes');
const home = join(work, 'products'); mkdirSync(home, {recursive: true});
const settings = join(work, 'madarch-home'); mkdirSync(settings, {recursive: true});
writeFileSync(join(settings, 'settings.json'), JSON.stringify({role: 'everything', roleAsked: true}));
const env = {...process.env, MADARCH_HOME: settings, MADARCH_OWN_WIKI: 'off'};
let product = previous?.product ?? 'catalogue';
let productFolder = previous === undefined ? '' : join(home, previous.product);
const fillConfigDigest = (): string => {
  const hash = createHash('sha256');
  for (const path of ['workspace.yaml', 'madarch/kinds.yaml']) hash.update(path).update('\0').update(readFileSync(join(productFolder, path))).update('\0');
  return hash.update(JSON.stringify({agent: null, ownWiki: 'off', repository: 'training', repositoryHead})).digest('hex');
};
if (previous !== undefined && fillConfigDigest() !== previous.configDigest) throw new Error('contract-shots.ts:57: cached product fill configuration differs from provenance');
let base = `http://127.0.0.1:${port}`;
let stop: () => Promise<void>;
if (previous === undefined) {
  const created = spawnSync(binary, ['new', '--home', home, '--port', String(port), '--json', '--no-open'], {cwd: work, env: {...env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test'}, encoding: 'utf8', timeout: 120_000});
  if (created.status !== 0) throw new Error(`contract-shots.ts:54 (${import.meta.filename}): binary new exited ${created.status}: ${created.stderr}${created.stdout}`);
  const facts = JSON.parse(created.stdout.trim().split('\n').filter((line) => line.startsWith('{')).pop()!) as {folder: string; url: string};
  product = basename(facts.folder); productFolder = facts.folder; base = new URL(facts.url).origin;
  const manifest = join(facts.folder, 'workspace.yaml');
  writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), {name: 'training', linked: true}));
  symlinkSync(repository, join(facts.folder, 'repos/training'));
  stop = async () => { const result = spawnSync(binary, ['stop', '--home', home], {cwd: work, env, encoding: 'utf8', timeout: 30_000}); if (result.status !== 0) throw new Error(`binary stop exited ${result.status}: ${result.stderr}`); };
} else {
  if (!existsSync(join(productFolder, 'workspace.yaml'))) throw new Error(`contract-shots.ts:63: cached product is absent: ${productFolder}`);
  const child = Bun.spawn([binary, 'daemon-serve', '--home', home, '--port', String(port)], {cwd: work, env, stdout: 'ignore', stderr: 'inherit'});
  stop = async () => { child.kill('SIGTERM'); await child.exited; };
}
const api = `${base}/products/${product}/api/k`;
async function get<T>(path: string): Promise<T> { const answer = await fetch(`${api}/${path}`, {signal: AbortSignal.timeout(120_000)}); if (!answer.ok) throw new Error(`${path}: HTTP ${answer.status}: ${await answer.text()}`); return await answer.json() as T; }
const wait = (milliseconds: number): Promise<void> => new Promise((done) => setTimeout(done, milliseconds));
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
const report = {artifact, graphInputDigest, repositoryHead, fill: previous, pages: [] as unknown[], pictures: [] as unknown[], externalRequests: [] as string[]};
const expectedText = new Map<string, string[]>();
try {
  for (const end = Date.now() + 120_000; ; ) { try { if ((await fetch(base, {signal: AbortSignal.timeout(2000)})).ok) break; } catch { /* server startup */ } if (Date.now() > end) throw new Error('server did not start'); await wait(200); }
  if (previous === undefined) {
    const filled = await fetch(`${api}/fill`, {method: 'POST'}); if (!filled.ok) throw new Error(`fill refused: ${filled.status} ${await filled.text()}`);
    for (const end = Date.now() + 900_000; ; ) { const status = await get<{fill: {state: string; message?: string}}>('status'); if (status.fill.state === 'done') break; if (status.fill.state === 'failed') throw new Error(status.fill.message ?? 'fill failed'); if (Date.now() > end) throw new Error('fill exceeded 900 seconds'); await wait(1000); }
    const provenance: FillProvenance = {schema: 1, graphInputDigest, repositoryHead, product, configDigest: fillConfigDigest(), fillBinaryHead: head, fillBinarySha256: binaryDigest};
    writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2)); report.fill = provenance;
  } else {
    const status = await get<{filled: boolean; incomplete: boolean; fill: {state: string}}>('status');
    if (!status.filled || status.incomplete || status.fill.state !== 'done') throw new Error('contract-shots.ts:83: cached fill is not complete; capture will not refill it');
  }
  if (mode === 'prepare') { console.log(JSON.stringify({prepared: true, provenanceFile, artifact, graphInputDigest, repositoryHead})); }
  else {
  type Ref = {id: string};
  const entities: {id: string; kind: string}[] = [];
  for (const kind of ['code.contract', 'code.operation']) {
    let after: string | null = null;
    do { const listing: {rows: Ref[]; next: string | null; total: number} = await get(`entities?kind=${kind}${after === null ? '' : `&after=${encodeURIComponent(after)}`}`); entities.push(...listing.rows.map((row) => ({id: row.id, kind}))); after = listing.next; } while (after !== null);
  }
  if (!entities.some((entity) => entity.kind === 'code.contract') || !entities.some((entity) => entity.kind === 'code.operation')) throw new Error('the training fixture must supply contracts and operations');
  type Definition = {type: string; format?: string; document?: {info?: {title?: string}; channels?: Record<string, unknown>}; protobuf?: {services: {name: string; methods: {name: string}[]}[]; messages: {name: string; fields: {name: string}[]}[]}; selection?: {method: string; path: string; operationId: string}; diagnostics?: unknown[]};
  const formats = new Set<string>();
  for (const lang of ['en', 'ru']) for (const entity of entities) {
    const page = await get<{blocks: ({type: string; block?: string; line?: number} & Definition)[]}>(`page?id=${encodeURIComponent(entity.id)}&lang=${lang}&defer=true`);
    const deferred = page.blocks.find((block) => block.type === 'deferred' && block.block === 'definition');
    if (deferred === undefined) throw new Error(`${entity.id} ${lang}: missing deferred Definition`);
    const definition = await get<Definition>(`block?id=${encodeURIComponent(entity.id)}&line=${deferred.line}&lang=${lang}`);
    if (definition.type !== 'definition' || (definition.diagnostics?.length ?? 0) > 0 || (definition.document === undefined && definition.protobuf === undefined)) throw new Error(`${entity.id} ${lang}: invalid Definition ${JSON.stringify(definition)}`);
    if (entity.kind === 'code.operation' && definition.format === 'openapi' && definition.selection === undefined) throw new Error(`${entity.id}: missing operation selection`);
    const words = definition.protobuf === undefined ? [definition.document?.info?.title, ...Object.keys(definition.document?.channels ?? {}), ...(definition.selection === undefined ? [] : [definition.selection.path])] : definition.protobuf.services.flatMap((service) => [service.name, ...service.methods.map((method) => method.name)]).concat(definition.protobuf.messages.flatMap((message) => message.fields.map((field) => field.name)));
    const present = words.filter((word): word is string => typeof word === 'string' && word.length > 0);
    if (present.length === 0) throw new Error(`${entity.id}: no fixture content to verify in renderer`);
    expectedText.set(entity.id, present);
    formats.add(definition.format!); report.pages.push({id: entity.id, lang, format: definition.format});
  }
  for (const format of ['openapi', 'asyncapi', 'proto']) if (!formats.has(format)) throw new Error(`training fixture is missing ${format} coverage`);
  browser = await puppeteer.launch({executablePath: resolveBrowserExecutable(), headless: true, protocolTimeout: 180_000, args: ['--no-sandbox']});
  const allCases = [{id: 'catalogue', url: `/products/${product}/k/kind/code.operation`, catalogue: true}, ...entities.map((entity) => ({...entity, url: `/products/${product}/k/e/${encodeURIComponent(entity.id)}`, catalogue: false}))];
  const selectionFile = argument('pages', '');
  const requested = selectionFile === '' ? allCases.map((entry) => entry.id) : JSON.parse(readFileSync(resolve(selectionFile), 'utf8')) as unknown;
  if (!Array.isArray(requested) || requested.length === 0 || requested.some((id) => typeof id !== 'string' || !allCases.some((entry) => entry.id === id)) || new Set(requested).size !== requested.length) throw new Error('contract-shots.ts:130: --pages must name distinct known changed page ids');
  const cases = allCases.filter((entry) => requested.includes(entry.id));
  // Every explicitly selected touched page, both languages, themes and widths. No silently smaller matrix.
  for (const lang of ['en', 'ru']) for (const theme of ['light', 'dark'] as const) for (const width of [1150, 390]) for (const entry of cases) {
    const page: Page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.setViewport({width, height: 900}); await page.emulateMediaFeatures([{name: 'prefers-color-scheme', value: theme}]);
    await page.evaluateOnNewDocument((language) => localStorage.setItem('madarch-wiki-language', language), lang);
    await page.setRequestInterception(true);
    page.on('request', (request) => { if (/^https?:/u.test(request.url()) && new URL(request.url()).origin !== new URL(base).origin) {report.externalRequests.push(request.url()); void request.abort();} else void request.continue(); });
    await page.goto(`${base}${entry.url}`, {waitUntil: 'domcontentloaded', timeout: 120_000});
    if (entry.catalogue) {
      await page.waitForSelector('[data-testid=operations-catalogue]', {timeout: 120_000});
      while (await page.$('[data-testid=kind-more]') !== null) { const count = await page.$$eval('[data-testid=operations-catalogue] [data-entity]', (rows) => rows.length); await page.click('[data-testid=kind-more]'); await page.waitForFunction((before) => document.querySelectorAll('[data-testid=operations-catalogue] [data-entity]').length > before, {timeout: 120_000}, count); }
    } else {
      await page.waitForSelector('[data-testid=contract-definition-disclosure]', {timeout: 120_000});
      const before = await page.$('[data-testid^=contract-][data-ready=true]'); if (before !== null) throw new Error(`${entry.id}: renderer loaded before Definition opened`);
      await page.click('[data-testid=contract-definition-disclosure] > summary');
      await page.waitForSelector('[data-testid^=contract-][data-ready=true]', {timeout: 120_000});
      await page.waitForFunction((words) => { const text = document.querySelector('[data-block=definition]')?.textContent ?? ''; return words.every((word) => text.includes(word)); }, {timeout: 120_000}, expectedText.get(entry.id) ?? []);
      const label = await page.$eval('[data-testid=contract-definition-disclosure] > summary', (node) => node.textContent);
      if (label !== (lang === 'ru' ? 'Определение' : 'Definition')) throw new Error(`${entry.id} ${lang}: wrong Definition language: ${label}`);
      if (await page.$('[data-contract-selected]') === null && entry.id.startsWith('code.operation:') && await page.$('[data-testid=contract-redoc]') !== null) throw new Error(`${entry.id}: selected OpenAPI operation is not positioned`);
    }
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const metrics = await page.evaluate(() => {
      const root = document.querySelector('[data-testid=operations-catalogue], [data-block=definition]')!;
      const text = [...root.querySelectorAll('h2,h3,h4,th,td,p,dt,dd')].filter((node) => node.getBoundingClientRect().width > 0 && node.textContent?.trim());
      return {dark: matchMedia('(prefers-color-scheme: dark)').matches, viewport: innerWidth, bodyWidth: document.documentElement.scrollWidth, minFontPx: Math.min(...text.map((node) => parseFloat(getComputedStyle(node).fontSize))), rows: root.querySelectorAll('[data-entity]').length, alerts: [...root.querySelectorAll('[role=alert]')].map((node) => node.textContent)};
    });
    if (errors.length || metrics.alerts.length || metrics.bodyWidth > width + 1 || metrics.minFontPx < 11 || metrics.dark !== (theme === 'dark') || (entry.catalogue && metrics.rows < entities.filter((entity) => entity.kind === 'code.operation').length)) throw new Error(`${entry.id} ${lang} ${theme} ${width}: ${JSON.stringify({errors, metrics})}`);
    const filename = `${entry.id.replace(/[^a-z0-9.-]/giu, '_')}-${lang}-${theme}-${width}.png`;
    await page.screenshot({path: join(out, filename), fullPage: true}); report.pictures.push({id: entry.id, lang, theme, width, filename, ...metrics}); await page.close();
  }
  if (report.pictures.length !== cases.length * 8 || report.pages.length !== entities.length * 2) throw new Error(`incomplete touched matrix: ${report.pictures.length} pictures, ${report.pages.length} API pages`);
  if (report.externalRequests.length > 0) throw new Error(`renderer attempted external requests: ${JSON.stringify(report.externalRequests)}`);
  writeFileSync(join(out, 'measures.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pages: report.pages.length, pictures: report.pictures.length, selected: requested, out}));
  }
} finally { await browser?.close(); await stop!(); }
