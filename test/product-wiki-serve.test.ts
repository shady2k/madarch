import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, setDefaultTimeout } from 'bun:test';
setDefaultTimeout(60_000);
import { serveWiki, type ServeResult } from '../src/product-wiki/serve.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { parseDocument } from 'yaml';
import { readKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { ensureVertex, journalFor, publishOpinion, writeJournal } from '../src/graph/write.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { prepareTestProduct } from './prepared-server.js';
import type { StartedServer } from '../src/server/http.js';

const folders: string[] = [];
const servers: StartedServer[] = [];
const preparationOwners: (() => Promise<void>)[] = [];

function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-product-wiki-serve-'));
  folders.push(folder);
  return folder;
}

function builtApp(base: string): string {
  const appFolder = join(base, 'app');
  mkdirSync(join(appFolder, 'dist'), { recursive: true });
  writeFileSync(join(appFolder, 'dist', 'index.html'), '<!doctype html><title>test app</title>');
  return appFolder;
}

function serving(result: ServeResult): Extract<ServeResult, { outcome: 'serving' }> {
  if (result.outcome !== 'serving') throw new Error(`expected a serving result, got ${result.outcome}: ${result.message}`);
  servers.push(result.server);
  return result;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const close of preparationOwners.splice(0)) await close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('serveWiki with a product or a manifestless directory', () => {
  test('a folder that is no product (no workspace.yaml) is served as the one app, which names the file it lacks, and nothing is written into it', async () => {
    const base = scratch();
    const folder = join(base, 'empty-home');
    mkdirSync(folder);
    const before = readdirSync(folder);
    const result = serving(await serveWiki({ cwd: folder, appFolder: builtApp(base), port: 0, open: false, print: () => {}, printError: () => {} }));
    const status = await fetch(`${result.url}/api/status`);
    expect(status.status).toBe(500);
    expect(JSON.stringify(await status.json())).toContain('workspace.yaml');
    // The one app answers some of those names now: the identity names the manifest it lacks, its
    // questions and its fill are its own. The documents app's other addresses answer nothing.
    expect((await fetch(`${result.url}/api/product`)).status).toBe(500);
    for (const old of ['/api/pages', '/api/stages', '/api/registry', '/api/architecture', '/api/repos', '/api/graph/pages']) {
      expect((await fetch(`${result.url}${old}`)).status, old).toBe(404);
    }
    expect(readdirSync(folder)).toEqual(before);
  });

  test('serves linked repository README through the documents the wiki lists as pages', async () => {
    const base = scratch(); const product = join(base, 'product'); const source = join(base, 'source');
    mkdirSync(product); mkdirSync(source);
    writeFileSync(join(product, 'workspace.yaml'), 'schemaVersion: 1\nid: linked-id\nname: Linked\nrepos:\n  - name: source\n    url: https://example.invalid/source.git\n');
    writeFileSync(join(source, 'README.md'), '# Linked source\n'); writeFileSync(join(source, 'src.ts'), 'export {}');
    const runIn = (cwd: string, args: string[]): void => { const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr)); };
    const run = (args: string[]): void => runIn(source, args);
    run(['init', '--quiet', '--initial-branch=main']); run(['add', '-A']); run(['commit', '--quiet', '-m', 'Source']);
    mkdirSync(join(product, 'repos')); symlinkSync(source, join(product, 'repos', 'source'), 'dir');
    // The product's own copy of the starter set: the engine knows no entities (decision 0034, item 24).
    seedStarterSet(product);
    const kindsFile = join(product, 'madarch/kinds/documentation/document/document.yaml');
    const manifest = parseDocument(readFileSync(kindsFile, 'utf8'));
    const documentKind = manifest.contents;
    const documentDeclaration = (documentKind as { toJSON(): Record<string, unknown> }).toJSON();
    manifest.setIn([], {
      ...documentDeclaration, source: 'graph', origin: 'person', key: ['title'], title: 'title',
      fields: [
        { name: 'title', type: 'text', producers: ['fixture'] },
        { name: 'repository', type: 'text', producers: ['fixture'] },
        { name: 'path', type: 'text', producers: ['fixture'] },
        { name: 'markdown', type: 'text', producers: ['fixture'] },
        { name: 'source_text', type: 'text', producers: ['fixture'] },
        { name: 'anchors', type: 'json', producers: ['fixture'] },
        { name: 'links', type: 'json', producers: ['fixture'] },
      ],
    });
    writeFileSync(kindsFile, manifest.toString());
    writeFileSync(join(product, 'madarch', 'workflows.yaml'), `workflows:
  first-fill:
    status: implemented
    stages: [repository-tree, repository-history]
`);
    runIn(product, ['init', '--quiet', '--initial-branch=main']); runIn(product, ['add', '-A']); runIn(product, ['commit', '--quiet', '-m', 'Product']);
    preparationOwners.push(await prepareTestProduct(product, base));
    const result = serving(await serveWiki({ productFolder: product, appFolder: builtApp(base), port: 0, open: false, print: () => {}, printError: () => {} }));
    // The documents are the graph's now: the files producer reads the checkout into the store first (decision 0035, item 9).
    const pressed = await fetch(`${result.url}/api/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(pressed.status).toBe(202);
    let finalStatus: { fill: { state: string; message?: string } } | undefined;
    for (let attempt = 0; attempt < 1200; attempt++) {
      finalStatus = await (await fetch(`${result.url}/api/status`)).json() as { fill: { state: string; message?: string } };
      if (finalStatus.fill.state !== 'running') break;
      await new Promise((rest) => setTimeout(rest, 100));
    }
    expect(finalStatus?.fill.state, JSON.stringify(finalStatus)).toBe('done');
    // Native stages store repository facts; this fixture supplies the document and source-text producer's structured answer.
    const read = readKinds(product);
    if (!read.present) throw new Error('the fixture document declaration is absent');
    const contract = graphContractOf(read.manifest);
    const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(product, knowledgeRootOf(base))), connectOnly: true });
    try {
      await owner.transaction('write', async (tx) => {
        const journal = journalFor('fixture@1');
        const node = await ensureVertex(tx, contract, { kind: 'document', key: { title: 'Linked source' } }, 1, journal);
        await publishOpinion(tx, contract, { kind: 'document', nodeId: node.nodeId, producer: 'fixture', producerVersion: '1', values: { repository: 'source', path: 'README.md', markdown: '# Linked source\n', source_text: '# Linked source\n', anchors: {}, links: [] } }, 1, journal);
        await writeJournal(tx, journal);
      });
    } finally { await owner.close(); }
    const listed = await (await fetch(`${result.url}/api/documents`)).json() as { documents: { repo: string | null; path: string; title: string }[] };
    expect(listed.documents).toContainEqual({ repo: 'source', path: 'README.md', title: 'Linked source' });
    const response = await fetch(`${result.url}/api/document?repo=source&path=README.md`);
    const page = await response.json() as { title: string; markdown: string };
    expect(response.status, JSON.stringify(page)).toBe(200);
    expect({ title: page.title, markdown: page.markdown }).toEqual({ title: 'Linked source', markdown: '# Linked source\n' });
    // The text is the graph's: the checkout may go, and the source view still answers it (decision 0035, item 24).
    rmSync(join(source, 'README.md'));
    const held = await fetch(`${result.url}/api/source?repo=source&path=README.md`);
    expect(held.status).toBe(200);
    expect((await held.json() as { text: string }).text).toBe('# Linked source\n');
  }, 60_000);

  test('a network bind names the address it listens on and prints no tunnel; a loopback bind over SSH prints one', async () => {
    const base = scratch();
    const folder = join(base, 'network-product');
    mkdirSync(folder);
    writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: network-id\nname: Network\n');
    const ssh = { SSH_CONNECTION: '203.0.113.9 50123 198.51.100.4 22', USER: 'ada' };
    const networkLines: string[] = [];
    const network = serving(await serveWiki({ productFolder: folder, appFolder: builtApp(base), port: 0, host: '0.0.0.0', open: false, env: ssh, print: (line) => networkLines.push(line), printError: () => {} }));
    expect(network.url).toContain('0.0.0.0');
    expect(networkLines).toContain(`Wiki: ${network.url}  (Ctrl+C stops it)`);
    expect(networkLines).toContain('Warning: this wiki is reachable from the network without a password.');
    expect(networkLines.some((line) => line.includes('ssh -L'))).toBe(false);
    expect(networkLines.some((line) => line.includes('localhost'))).toBe(false);

    const localLines: string[] = [];
    const local = serving(await serveWiki({ productFolder: folder, appFolder: builtApp(base), port: 0, host: '127.0.0.1', open: false, env: ssh, print: (line) => localLines.push(line), printError: () => {} }));
    expect(local.url).toContain('127.0.0.1');
    expect(localLines).toContain(`Wiki: ${local.url}  (Ctrl+C stops it)`);
    expect(localLines.some((line) => line.startsWith('  ssh -L') && line.includes(`:${local.server.port} `))).toBe(true);
  });

  test('preserves the manifest identity for a valid product', async () => {
    const base = scratch();
    const folder = join(base, 'valid-product');
    mkdirSync(folder);
    writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: manifest-id\nname: Manifest name\n');
    const result = serving(await serveWiki({ productFolder: folder, appFolder: builtApp(base), port: 0, open: false, print: () => {}, printError: () => {} }));
    const status = await (await fetch(`${result.url}/api/status`)).json() as { product: { id: string; name: string }; manifest: string; seeded?: string[] };
    expect(status.product).toEqual({ id: 'manifest-id', name: 'Manifest name' });
    // The wiki copies nothing into the folder: it lacks its kinds manifest, and the status names that file.
    expect(status.manifest).toBe('no-manifest');
    expect(status.seeded).toBeUndefined();
    const pressed = await fetch(`${result.url}/api/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(pressed.status).toBe(409);
    expect(JSON.stringify(await pressed.json())).toContain('madarch/catalog.yaml');
  }, 60_000);

  test('a product without a kinds manifest is given nothing by the wiki that serves it: the file is named and the folder stands as it is', async () => {
    const base = scratch();
    const folder = join(base, 'no-manifest');
    mkdirSync(join(folder, 'templates'), { recursive: true });
    writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: bare-id\nname: Bare\n');
    writeFileSync(join(folder, 'templates', 'domain.liquid'), 'my own template\n');
    // The product repository's commit is what a fill stores: git is given it here, as madarch's own commands do.
    const git = (args: string[]): void => { execFileSync('git', args, { cwd: folder, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }); };
    git(['init', '--quiet', '--initial-branch=main']);
    const before = readdirSync(folder).sort();
    const result = serving(await serveWiki({ productFolder: folder, appFolder: builtApp(base), port: 0, open: false, print: () => {}, printError: () => {} }));
    const first = await (await fetch(`${result.url}/api/status`)).json() as { manifest: string; seeded?: string[] };
    expect(first.manifest).toBe('no-manifest');
    expect(first.seeded).toBeUndefined();
    expect(readdirSync(folder).sort()).toEqual(before);
    expect(readFileSync(join(folder, 'templates', 'domain.liquid'), 'utf8')).toBe('my own template\n');
    const pressed = await fetch(`${result.url}/api/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(pressed.status).toBe(409);
    expect(JSON.stringify(await pressed.json())).toContain('madarch/catalog.yaml');
    expect(readdirSync(folder).sort()).toEqual(before);
  }, 60_000);

  test('does not fall back for a missing path, non-directory, invalid manifest or dangling manifest symlink', async () => {
    const base = scratch();
    const appFolder = builtApp(base);
    const missingPath = join(base, 'missing');
    const absent = await serveWiki({ productFolder: missingPath, appFolder, port: 0, open: false, print: () => {}, printError: () => {} });
    expect(absent.outcome).toBe('refused');
    if (absent.outcome === 'refused') {
      expect(absent.message).toContain(missingPath);
      expect(absent.message).toContain('workspace.yaml');
    }

    const file = join(base, 'file');
    writeFileSync(file, 'not a directory');
    expect((await serveWiki({ productFolder: file, appFolder, port: 0, open: false, print: () => {}, printError: () => {} })).outcome).toBe('refused');

    const invalid = join(base, 'invalid');
    mkdirSync(invalid);
    writeFileSync(join(invalid, 'workspace.yaml'), 'schemaVersion: 999\n');
    expect((await serveWiki({ productFolder: invalid, appFolder, port: 0, open: false, print: () => {}, printError: () => {} })).outcome).toBe('refused');

    const dangling = join(base, 'dangling');
    mkdirSync(dangling);
    symlinkSync(join(dangling, 'missing-target.yaml'), join(dangling, 'workspace.yaml'));
    expect((await serveWiki({ productFolder: dangling, appFolder, port: 0, open: false, print: () => {}, printError: () => {} })).outcome).toBe('refused');
  });
});
