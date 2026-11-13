/** Startup publishes the product's templates without needing a content-writing fill (madarch-64o5.29). */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedServer } from '../src/server/http.js';
import { makeProduct, withoutPluginTurns, commitProduct, SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { gitEnv } from './git-env.js';
import { startPreparedServer } from './prepared-server.js';
import { fillInProcess } from './fill-inline.js';
import { createManifestWatch } from '../src/product/manifest-watch.js';
import { publishValidatedManifests, validateProductManifests } from '../src/graph/manifest-publication.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { declaredKindReads, graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { ensureVertex, journalFor, publishOpinion, writeJournal } from '../src/graph/write.js';
import { generatedTableName } from '../src/graph/contract.js';
import { parseDocument } from 'yaml';
import { createServer } from 'node:net';

let work = '';
let server: StartedServer | undefined;
let product = '';
let home = '';
let app = '';

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-startup-templates-'));
  const repository = join(work, 'source');
  mkdirSync(join(repository, 'src'), { recursive: true });
  writeFileSync(join(repository, 'src', 'sample.ts'), 'export const sample = 1;\n');
  const env = gitEnv(SAMPLE_IDENTITY);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Create fixture source']]) {
    execFileSync('git', args, { cwd: repository, env });
  }
  home = join(work, 'products');
  mkdirSync(home);
  product = makeProduct(home, 'sample', repository, 'source');
  writeFileSync(join(product, 'madarch', 'workflows.yaml'), 'workflows:\n  first-fill:\n    status: implemented\n    stages: [repository-tree, repository-history]\n');
  withoutPluginTurns(product);
  commitProduct(product, 'Run only native file inventory and history');
  app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>Fixture wiki</title>');
  // Start before filling: no test helper publishes template opinions into the graph.
  server = await startPreparedServer({ productFolder: product, appFolder: app, port: 0, log: () => {}, errorLog: () => {} });
  const status = await fetch(`${server.url}/api/status`);
  expect(status.status, await status.text()).toBe(200);
  await fillInProcess(product, home);
}, 120_000);

afterAll(async () => {
  await server?.stop();
  if (work !== '') rmSync(work, { recursive: true, force: true });
}, 60_000);

for (const [id, expectedBlock] of [
  ['code.file:source/src/sample.ts', 'filePage'],
  ['code.directory:source/src', 'folder'],
  ['code.repository:source', 'repository'],
] as const) {
  test(`startup templates render ${id} after a files-only fill`, async () => {
    const response = await fetch(`${server!.url}/api/page?id=${encodeURIComponent(id)}&full=1`);
    const page = await response.json() as { blocks?: { type: string }[]; findings?: unknown[] };
    expect(response.status, JSON.stringify(page)).toBe(200);
    expect(page.blocks?.map((block) => block.type), JSON.stringify(page)).toContain(expectedBlock);
    expect(page.blocks?.filter((block) => block.type === 'problem'), JSON.stringify(page)).toEqual([]);
    expect(page.findings, JSON.stringify(page)).toEqual([]);
  }, 30_000);
}

test('a live template edit publishes without Fill and an invalid edit retains the last valid opinion', async () => {
  const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(product, knowledgeRootOf(home))), connectOnly: true });
  const reports: string[] = [];
  const watcher = createManifestWatch([product], async (value) => { await publishValidatedManifests(owner, value); }, (line) => reports.push(line));
  const template = join(product, 'templates', 'file.liquid');
  const original = await Bun.file(template).text();
  const manifest = readKinds(product);
  if (!manifest.present) throw new Error(`${product}/madarch/catalog.yaml:1: fixture manifest absent`);
  const graph = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, declaredKindReads(manifest.manifest));
  const until = async (ready: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${template}:1: template watcher did not publish within 10000 ms; ${reports.join('; ')}`);
  };
  try {
    // This uses the production watcher refresh path; it never publishes test-owned TemplatePart nodes.
    writeFileSync(template, 'Live template marker\n{% file-page %}\n');
    await until(async () => String(JSON.stringify((await graph.find('template:templates/file.liquid'))[0]?.properties['template_parts'])).includes('Live template marker'));
    const changed = await graph.find('template:templates/file.liquid');
    expect(changed.length).toBe(1);
    expect(JSON.stringify(changed[0]!.properties['template_parts'])).toContain('Live template marker');
    const partial = join(product, 'templates', 'partials', 'startup-live.liquid');
    writeFileSync(partial, 'Initial nested marker\n');
    writeFileSync(template, 'Live template marker\n{% render "./partials/startup-live.liquid" %}\n{% file-page %}\n');
    await until(async () => String(JSON.stringify((await graph.find('template:templates/file.liquid'))[0]?.properties['template_parts'])).includes('Initial nested marker'));
    writeFileSync(partial, 'Changed nested marker\n');
    await until(async () => String(JSON.stringify((await graph.find('template:templates/file.liquid'))[0]?.properties['template_parts'])).includes('Changed nested marker'));
    const parts = (await graph.find('template:templates/file.liquid'))[0]!.properties['template_parts'];
    writeFileSync(template, '{% unknown-startup-block %}\n');
    await until(async () => reports.some((line) => line.includes(`${template}:1:`)));
    expect(reports.some((line) => line.includes(`${template}:1:`)), reports.join('\n')).toBe(true);
    expect((await graph.find('template:templates/file.liquid'))[0]!.properties['template_parts']).toEqual(parts);
  } finally {
    writeFileSync(template, original);
    await watcher.refresh(product);
    watcher.stop();
    await owner.close();
  }
}, 30_000);

test('startup refuses an invalid template with its full file path and line before listening', async () => {
  const template = join(product, 'templates', 'file.liquid');
  const original = await Bun.file(template).text();
  const port = await new Promise<number>((resolve) => {
    const listener = createServer();
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (address === null || typeof address === 'string') throw new Error('fixture listener has no port');
      listener.close(() => resolve(address.port));
    });
  });
  mkdirSync(join(app, 'dist'), { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'true' } }));
  writeFileSync(join(app, 'dist', 'index.html'), '<!doctype html><title>Fixture wiki</title>');
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    writeFileSync(template, '{% unknown-startup-block %}\n');
    const validated = validateProductManifests(product);
    expect(validated.ok).toBe(false);
    if (validated.ok) throw new Error('startup validation accepted an unknown template block');
    expect(validated.findings).toContainEqual(expect.objectContaining({ file: template, line: 1 }));
    const started = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'scripts', 'madarch.ts'), 'start', '--home', home, '--port', String(port)], {
      env: { ...process.env, MADARCH_HOME: work, MADARCH_APP: app, MADARCH_OWN_WIKI: 'off' }, stdout: 'pipe', stderr: 'pipe',
    });
    child = started;
    const [code, out, err] = await Promise.all([started.exited, new Response(started.stdout).text(), new Response(started.stderr).text()]);
    expect(code, out + err).not.toBe(0);
    expect(out + err).toContain(`${template}:1:`);
    await expect(fetch(`http://127.0.0.1:${port}/products/sample/api/status`)).rejects.toThrow();
  } finally {
    child?.kill();
    writeFileSync(template, original);
  }
}, 120_000);

test('legacy explicit agent bindings for templates never enter catalogue agent outputs', () => {
  const file = join(product, 'madarch', 'kinds', 'common', 'schema', 'template.yaml');
  // The old product-owned form must remain readable, but it must not schedule an agent for deterministic templates.
  const text = readFileSync(file, 'utf8');
  const yaml = parseDocument(text);
  yaml.set('fields', [
    { name: 'path', type: 'text', binding: { agent: 'Read templates/**/*.liquid paths' } },
    { name: 'template_parts', type: 'json', binding: { agent: 'Interpret templates/**/*.liquid into structured parts' } },
  ]);
  try {
    writeFileSync(file, yaml.toString());
    const read = readKinds(product);
    if (!read.present) throw new Error(`${file}:1: fixture manifest absent`);
    expect(read.manifest.findings).toEqual([]);
    const agents = [...read.manifest.plugins!.values()].filter((plugin) => plugin.contract?.agent?.catalogue === true);
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) expect(agent.outputs).not.toContain('template');
  } finally { writeFileSync(file, text); }
});

test('publication retires legacy agent template opinions and then remains idempotent', async () => {
  const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(product, knowledgeRootOf(home))), connectOnly: true });
  try {
    const read = readKinds(product);
    if (!read.present) throw new Error(`${product}/madarch/catalog.yaml:1: fixture manifest absent`);
    const contract = graphContractOf(read.manifest);
    await owner.transaction('write', async (tx) => {
      const journal = journalFor('agent@1');
      const node = await ensureVertex(tx, contract, { kind: 'template', key: { path: 'templates/file.liquid' } }, 1, journal);
      await publishOpinion(tx, contract, { kind: 'template', nodeId: node.nodeId, producer: 'agent', producerVersion: '1', values: { template_parts: [{ type: 'text', text: 'Obsolete agent interpretation', line: 1 }] } }, 1, journal);
      await writeJournal(tx, journal);
    });
    const validated = validateProductManifests(product);
    if (!validated.ok || validated.value === undefined) throw new Error('fixture template validation failed');
    await publishValidatedManifests(owner, validated.value);
    const table = generatedTableName('template', 'vertex');
    const rows = await owner.run((tx) => tx.query<{ said_by: string; state: string }>(`SELECT said_by, state FROM "${table}" WHERE split_part(said_by, '@', 1) = 'agent'`));
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.filter((row) => row.state === 'open')).toEqual([]);
    expect(await publishValidatedManifests(owner, validated.value)).toBe(0);
  } finally { await owner.close(); }
}, 30_000);
