/**
 * wiki-walk-ci — the walk over a generated product as a ratchet (madarch-j6ho.1).
 *
 * CI has no filled product to point at, so this script makes one the way the
 * project's own fixtures do: the training repository is generated, a product
 * is made around it, a server fills its graph and answers, and every page is
 * walked in each interface language the manifest declares. The per-class counts
 * are held to a committed baseline (`scripts/wiki-walk-baseline.json`): a class
 * above its count, or a class the baseline does not name, fails the step; a
 * class below it is printed so the baseline can be lowered. The baseline may
 * only go down.
 *
 * The step is time-bounded by its caller (`timeout`), and the fill and walk
 * have their own ceilings here so a hung server fails rather than waits.
 *
 *   bun scripts/wiki-walk-ci.ts [--baseline <file>] [--json <file>] [--lang en,ru]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server/http.js';
import { generateTrainingRepository, makeProduct, writeSamplePages } from '../test/knowledge-fixture.js';
import { FINDING_CLASSES, compareToBaseline, formatBaseline, formatReport, parseBaseline, walkWiki } from './wiki-walk.js';

const PRODUCT = 'shop';
const FILL_MS = 600_000;

function argument(name: string, fallback: string | undefined): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
}

function integer(name: string, fallback: number): number {
  const raw = argument(name, undefined);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} is ${JSON.stringify(raw)}; it must be a whole number`);
  return parsed;
}

const baselineFile = resolve(argument('baseline', 'scripts/wiki-walk-baseline.json')!);
const jsonFile = argument('json', undefined);
// A maintainer's tool, never CI's: it writes the counts the walk just made so a
// baseline can be lowered after a fix. It prints the change, and refuses to
// raise a count.
const writeBaseline = argument('write-baseline', undefined);
const work = resolve(argument('work', '/tmp/wiki-walk')!);
const languages = argument('lang', undefined)?.split(',').map((language) => language.trim()).filter((language) => language !== '');
const maxFindings = integer('max-findings', 20);

// A fresh home, store and repository every run: a baseline measured against a
// half-filled store would hold the walk to the wrong counts.
rmSync(work, { recursive: true, force: true });
const repository = generateTrainingRepository(join(work, 'repo'));
// A remote, so a code place can name its page on the host (a node drawn
// without one would read as a fact with no evidence).
if (!execFileSync('git', ['remote'], { cwd: repository, encoding: 'utf8' }).includes('origin')) {
  execFileSync('git', ['remote', 'add', 'origin', ['https://github.com', 'example', 'shop.git'].join('/')], { cwd: repository });
}
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
const shop = makeProduct(home, PRODUCT, repository);
// The two pages an agent writes, so the walk reads a product a person does,
// with product-authored bodies and a domain page among the generated ones.
writeSamplePages(shop);
// The API answers without the app's built files; the server only needs a
// folder it can call the app's home.
const app = join(work, 'app');
mkdirSync(app, { recursive: true });
writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki-walk</title>\n');
const store = join(work, 'store');

const server = await startServer({
  productHome: home,
  appFolder: app,
  port: 0,
  knowledgeRoot: store,
  log: () => {},
  errorLog: (line) => console.error(line),
});
const endpoint = `${server.url}/products/${PRODUCT}`;

const status = async (): Promise<{ fill: { state: string; message?: string }; filled?: boolean }> => {
  const response = await fetch(`${endpoint}/api/k/status`);
  if (!response.ok) throw new Error(`${endpoint}/api/k/status: HTTP ${response.status}`);
  return await response.json() as { fill: { state: string; message?: string }; filled?: boolean };
};

try {
  console.log(`wiki-walk-ci: filling ${endpoint}`);
  const began = await fetch(`${endpoint}/api/k/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (began.status !== 202) throw new Error(`${endpoint}/api/k/fill: HTTP ${began.status}: ${await began.text()}`);
  const fillBegan = Date.now();
  const fillDeadline = fillBegan + FILL_MS;
  for (;;) {
    const state = await status();
    if (state.fill.state === 'done') break;
    if (state.fill.state === 'failed') throw new Error(`${endpoint}/api/k/status: the fill failed: ${state.fill.message ?? 'no reason given'}`);
    if (Date.now() > fillDeadline) throw new Error(`${endpoint}/api/k/status: the fill did not finish in ${FILL_MS / 1000} s (state ${state.fill.state})`);
    await Bun.sleep(500);
  }
  console.log(`wiki-walk-ci: filled in ${((Date.now() - fillBegan) / 1000).toFixed(1)} s; walking ${languages?.join(', ') ?? 'the manifest languages'}`);
  const result = await walkWiki({
    endpoint,
    product: PRODUCT,
    ...(languages === undefined || languages.length === 0 ? {} : { languages }),
  });
  console.log(formatReport(result, maxFindings));
  if (jsonFile !== undefined) await Bun.write(resolve(jsonFile), `${JSON.stringify(result, null, 2)}\n`);
  if (writeBaseline !== undefined) {
    // The first baseline is written from the walk; after that the file may
    // only go down, and a raise stops the write.
    if (existsSync(baselineFile)) {
      const previous = parseBaseline(await Bun.file(baselineFile).text(), baselineFile);
      const raised = compareToBaseline(result, previous).regressions;
      if (raised.length > 0) throw new Error(`--write-baseline would raise ${raised.map((entry) => `${entry.class} ${entry.baseline} → ${entry.count}`).join(', ')}; the baseline may only go down`);
    }
    const counts = Object.fromEntries(FINDING_CLASSES.map((name) => [name, result.byClass[name]]));
    const text = {
      product: PRODUCT,
      note: 'Per-class counts of the walk over the generated training product (madarch-j6ho.1). This file may only go down: a fix that lowers a count lowers the number here, and CI fails when a class is above it or a class it does not name appears.',
      counts,
    };
    await Bun.write(resolve(writeBaseline), `${JSON.stringify(text, null, 2)}\n`);
    console.log(`wiki-walk-ci: baseline written to ${resolve(writeBaseline)}: ${JSON.stringify(counts)}`);
    process.exitCode = 0;
  } else {
    const baseline = parseBaseline(await Bun.file(baselineFile).text(), baselineFile);
    const check = compareToBaseline(result, baseline);
    console.log(formatBaseline(check));
    process.exitCode = check.regressions.length === 0 ? 0 : 1;
  }
} finally {
  await server.stop();
}
