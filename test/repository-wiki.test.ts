import { useFixturePlugins } from './enabled-plugins-fixture.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { byCodePoint } from '../src/model/order.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
/**
 * The repository pages of the wiki (madarch-8bdc.2.5, items 2, 3 and 4): an
 * empty product, the press, the progress, the end state, and then the
 * repository, a folder, a file, a commit and the run page — over HTTP, the way
 * the app reads them.
 *
 * The products are fixtures this test makes; the generated repository of the
 * walk is not needed to know that a page is the store's own answer. One case
 * writes two thousand files, because the repository page must open without
 * loading them all.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { symlinkSync } from 'node:fs';
import { runFill } from '../src/fill/run.js';
import { knowledgeRootOf, productStoreFolder } from '../src/product/store.js';
import type { FillStepView } from '../src/knowledge/model.js';
import type { StartedServer } from '../src/server/http.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import { parseDocument } from 'yaml';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

let root = '';
let home = '';
let app = '';

/** A product whose one repository is the folder named: the fixture writes the files, this makes the product. */
function product(name: string, write: (repository: string) => void, plugins: readonly string[] = ['disk', 'git']): { folder: string; repository: string } {
  const repository = join(root, `${name}-code`);
  mkdirSync(repository, { recursive: true });
  git(repository, 'init', '-q', '-b', 'main');
  write(repository);
  const folder = makeProduct(home, name, repository, `${name}-code`);
  useFixturePlugins(folder, plugins);
  nativeWorkflow(folder);
  git(folder, 'add', '-A');
  git(folder, 'commit', '-q', '--allow-empty', '-m', `the product ${name}`);
  return { folder, repository };
}

/** Repository views run the fixture's declared ordinary producers in the plugin stage. */
function nativeWorkflow(folder: string): void {
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), `workflows:
  first-fill:
    status: implemented
    stages: [plugin-turns]
`);
}

/** One page of a product, as the app reads it. */
const json = async (server: StartedServer, product: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const answer = await fetch(`${server.url}/products/${product}${path}`, { headers: { accept: 'application/json' } });
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
};


/** One entity page as the app reads it, its blocks already read. */
const pageOf = async (server: StartedServer, product: string, id: string, after?: string, full = true): Promise<{ status: number; body: Record<string, unknown> }> =>
  await json(server, product, `/api/page?id=${encodeURIComponent(id)}${full ? '&full=1' : ''}${after === undefined ? '' : `&after=${encodeURIComponent(after)}`}`);

/** The one block of a page with this type. */
const blockOf = (page: { body: Record<string, unknown> }, type: string): Record<string, unknown> & { data: Record<string, unknown>; sections?: unknown[]; rows?: unknown[] } => {
  const found = (page.body['blocks'] as { type: string }[]).find((block) => block.type === type);
  if (found === undefined) throw new Error(`no ${type} block in ${JSON.stringify(page.body).slice(0, 800)}`);
  return found as never;
};

/** Presses the fill and waits for the run to end; answers the status that says how it ended. */
async function press(server: StartedServer, name: string): Promise<Record<string, unknown>> {
  const pressed = await fetch(`${server.url}/products/${name}/api/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: null }) });
  expect(pressed.status).toBe(202);
  for (let attempt = 0; attempt < 1200; attempt++) {
    const status = await json(server, name, '/api/status');
    const fill = status.body['fill'] as Record<string, unknown> | undefined;
    if (fill === undefined) throw new Error(`/api/status answered ${String(status.status)} with no fill state: ${JSON.stringify(status.body).slice(0, 500)}`);
    if (fill['state'] !== 'running') {
      return status.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('the fill never ended');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-repository-wiki-'));
  home = join(root, 'products');
  app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
}, 120_000);

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the empty wiki, the press and the end state', () => {
  test('an empty product says nothing is read yet; the press fills it; the end state has the counts and the time', async () => {
    product('walk',(folder) => {
mkdirSync(join(folder,'src','nested'),{ recursive: true });
mkdirSync(join(folder,'assets'),{ recursive: true });
writeFileSync(join(folder,'README.md'),'# Walk\n\nA fixture.\n');
writeFileSync(join(folder,'src','a.ts'),'export const a = 1;\n');
writeFileSync(join(folder,'src','nested','b.ts'),'export const b = 2;\n');
writeFileSync(join(folder,'assets','picture.bin'),Uint8Array.from([0,1,2,0,255]));
git(folder,'add','-A');
git(folder,'commit','-qm','the tree is written');
git(folder,'mv','src/nested/b.ts','src/nested/c.ts');
git(folder,'commit','-qm','the nested file moves');
});
    const server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      // The empty state: the manifest reads, the store holds no repository and no trace.
      const empty = await json(server, 'walk', '/api/status');
      expect(empty.status).toBe(200);
      expect(empty.body['repository']).toBeUndefined();
      expect((empty.body['fill'] as Record<string, unknown>)['state']).toBe('idle');
      const noRepository = await json(server, 'walk', '/api/repository');
      expect(noRepository.status).toBe(404);
      expect(String(noRepository.body['message'])).toContain('no such path');

      const ended = await press(server, 'walk');
      expect((ended['fill'] as Record<string, unknown>)['state'], JSON.stringify(ended)).toBe('done');
      expect(ended['filled']).toBe(true);
      expect(ended['incomplete']).toBe(false);
      // The counts and the time: the store's own numbers, and the run's own wall clock.
      const repositoryFacts = ended['repository'] as Record<string, unknown>;
      expect(repositoryFacts['counts']).toEqual({ files: 4, commits: 2, folders: 3 });
      expect(repositoryFacts['steps']).toEqual({ 'tree': true, 'history': true });
      const fill = ended['fill'] as Record<string, unknown>;
      expect(fill['counts']).toEqual({ files: 4, commits: 2, folders: 3 });
      const run = fill['run'] as Record<string, unknown>;
      expect(typeof run['wallMs']).toBe('number');
      expect((run['wallMs'] as number)).toBeGreaterThan(0);
      const runSteps = run['steps'] as FillStepView[];
      // Every stage the fixture workflow enables reports its own measured work.
      expect(runSteps.map((step) => step.step).sort()).toEqual(['plugin-turns']);
      for (const step of runSteps) {
        expect(step.wallMs).toBeGreaterThan(0);
        expect(step.peakRssBytes).toBeGreaterThanOrEqual(step.startRssBytes);
        expect(step.slowest.length).toBeGreaterThan(0);
      }

      // The repository's entity page, its root listing, one folder, one file, one commit and the run.
      const repositoryPage = await pageOf(server, 'walk', 'code.repository:walk-code');
      expect(repositoryPage.status, JSON.stringify(repositoryPage.body)).toBe(200);
      const facts = blockOf(repositoryPage, 'repository').data as Record<string, unknown>;
      expect(facts['name']).toBe('walk-code');
      const rootModel = blockOf(repositoryPage, 'folder').data as Record<string, unknown>;
      expect((rootModel['folders'] as { path: string }[]).map((folder) => folder.path)).toEqual(['assets', 'src']);
      expect((rootModel['files'] as { path: string }[]).map((file) => file.path)).toEqual(['README.md']);
      const nested = await pageOf(server, 'walk', 'code.directory:walk-code/src/nested');
      expect(nested.status).toBe(200);
      const nestedModel = blockOf(nested, 'folder').data as Record<string, unknown>;
      expect((nestedModel['parent'] as { path: string }).path).toBe('src');
      expect((nestedModel['files'] as { path: string }[]).map((file) => file.path)).toEqual(['src/nested/c.ts']);
      const file = await pageOf(server, 'walk', 'code.file:walk-code/src/nested/c.ts');
      expect(file.status).toBe(200);
      const filePage = blockOf(file, 'filePage');
      const fileModel = filePage.data as Record<string, unknown>;
      expect(fileModel['form']).toBe('text');
      const history = (filePage as unknown as { history: { hash: string; change: string | null }[] }).history;
      expect([...history.map((row) => row.change)].sort()).toEqual(['added', 'renamed']);
      const renamed = history.find((row) => row.change === 'renamed')!;
      const hash = renamed.hash;
      const commit = await pageOf(server, 'walk', `code.commit:${hash}`);
      expect(commit.status).toBe(200);
      const commitProperties = blockOf(commit, 'properties').rows as { name: string; value: string }[];
      expect(commitProperties.find((row) => row.name === 'subject')!.value).toBe('the nested file moves');
      const author = commitProperties.find((row) => row.name === 'author');
      expect(author?.value).toBe('Fixture');
      const runPage = await json(server, 'walk', '/api/run');
      expect(runPage.status).toBe(200);
      const runModel = runPage.body['run'] as Record<string, unknown>;
      expect(runModel['runId']).toBe(run['runId'] as string);
      for (const step of runModel['steps'] as Record<string, unknown>[]) {
        expect(step['wallMs'] as number).toBeGreaterThan(0);
        expect(step['peakRssBytes'] as number).toBeGreaterThanOrEqual(step['startRssBytes'] as number);
        expect((step['slowest'] as unknown[]).length).toBeGreaterThan(0);
      }
    } finally {
      await server.stop();
    }
  }, 300_000);

  test('a repository of two thousand files opens without loading them all into a page', async () => {
    const { repository } = product('many', (folder) => {
      mkdirSync(join(folder, 'files', 'deep'), { recursive: true });
      for (let index = 0; index < 2000; index++) {
        const name = `f${String(index).padStart(4, '0')}.txt`;
        writeFileSync(join(folder, 'files', 'deep', name), `the file ${index}\n`);
      }
      git(folder, 'add', '-A');
      git(folder, 'commit', '-qm', 'two thousand files');
    });
    expect(git(repository, 'rev-list', '--count', 'HEAD')).toBe('1');
    const server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      const ended = await press(server, 'many');
      const facts = ended['repository'] as Record<string, unknown>;
      expect((facts['counts'] as Record<string, unknown>)['files']).toBe(2000);
      const root = await pageOf(server, 'many', 'code.repository:many-code');
      expect(root.status).toBe(200);
      const rootModel = blockOf(root, 'folder').data as Record<string, unknown>;
      expect((rootModel['folders'] as { path: string }[]).map((folder) => folder.path)).toEqual(['files']);
      // The root holds one folder and no file: the page is small whatever the tree holds.
      expect(rootModel['files']).toEqual([]);
      const deep = await pageOf(server, 'many', 'code.directory:many-code/files/deep');
      const deepModel = blockOf(deep, 'folder').data as Record<string, unknown>;
      const page = deepModel['files'] as unknown[];
      expect(page.length).toBe(100);
      expect(deepModel['nextHref']).toContain('after=files%2Fdeep%2Ff0099.txt');
      // The page a reader opens is a page, not the repository: its Files map and table are blocks of their own
      // (madarch-j9ao.1), asked for later by their identities, so the answer carries the place each stands at and never
      // the folder's two thousand cells.
      const deferred = await pageOf(server, 'many', 'code.directory:many-code/files/deep', undefined, false);
      expect(deferred.status).toBe(200);
      expect(JSON.stringify(deferred.body).length).toBeLessThan(60_000);
      const map = (deferred.body['blocks'] as { type: string }[]).find((block) => block.type === 'deferred' && (block as { block?: string }).block === 'treemap');
      expect(map).toBeDefined();
      const second = await pageOf(server, 'many', 'code.directory:many-code/files/deep', 'files/deep/f0099.txt');
      expect(((blockOf(second, 'folder').data as Record<string, unknown>)['files'] as { path: string }[])[0]!.path).toBe('files/deep/f0100.txt');
    } finally {
      await server.stop();
    }
  }, 300_000);

  test('the product\'s documents are never read at request time: the empty store lists declarations without entities, and a fill leaves the document kinds empty', async () => {
    const { folder } = product('docs', (repository) => {
      mkdirSync(join(repository, 'src'), { recursive: true });
      writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
      git(repository, 'add', '-A');
      git(repository, 'commit', '-qm', 'one file');
    });
    // A product whose own files hold a glossary and numbered use cases: the old reading answered from them with no fill.
    mkdirSync(join(folder, 'docs'), { recursive: true });
    writeFileSync(join(folder, 'docs', 'glossary.md'), [
      '# Glossary', '',
      '- **Capture** - The moment the money is taken from the card.',
      '- **Payment token** - The proof a provider returns when it captured money.', '',
    ].join('\n'));
    writeFileSync(join(folder, 'docs', 'use-cases.md'), ['# Use cases', '', '- **UC-1 Place order.** A shopper submits a cart.', ''].join('\n'));
    const server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      const empty = await json(server, 'docs', '/api/status');
      expect(empty.status).toBe(200);
      // The status carries the count, never the list (madarch-8bdc.2.5): nothing is read from the documents, so no finding is one.
      expect(empty.body['findingCount']).toBe(0);
      // Startup publishes the declared catalogue, not document entities inferred from working-tree files.
      const declared = readKinds(folder);
      if (!declared.present) throw new Error(`${folder}/madarch/kinds.yaml:1: fixture kinds are absent`);
      const expectedKinds = [...(declared.manifest.catalog?.kinds.keys() ?? declared.manifest.kinds.keys())].sort(byCodePoint);
      const emptyKinds = empty.body['kinds'] as { kind: string; count: number }[];
      expect(emptyKinds.map((kind) => kind.kind).sort(byCodePoint)).toEqual(expectedKinds);
      expect(emptyKinds.filter((kind) => kind.kind !== 'template').every((kind) => kind.count === 0)).toBe(true);
      expect(emptyKinds.find((kind) => kind.kind === 'template')?.count).toBeGreaterThan(0);
      const glossary = await json(server, 'docs', '/api/glossary');
      expect(glossary.body).toEqual({ terms: [], resolutions: {}, findingCount: 0 });
      // The kind is declared, but file text alone produces no document entity.
      const useCases = await json(server, 'docs', '/api/entities?kind=doc.use-case');
      expect(useCases.status).toBe(200);
      expect(useCases.body).toMatchObject({ total: 0, rows: [] });
      // After a fill the repository's own pages stand, and no document layer is filled: no stage writes one yet.
      const ended = await press(server, 'docs');
      const fill = ended['fill'] as Record<string, unknown>;
      expect(fill['state']).toBe('done');
      const after = await json(server, 'docs', '/api/status');
      expect((after.body['kinds'] as { kind: string; count: number }[]).filter((kind) => kind.kind.startsWith('doc.')).every((kind) => kind.count === 0)).toBe(true);
      expect((await pageOf(server, 'docs', 'code.file:docs-code/src/a.ts')).status).toBe(200);
      expect((await json(server, 'docs', '/api/entities?kind=doc.use-case')).body).toMatchObject({ total: 0, rows: [] });
    } finally {
      await server.stop();
    }
  }, 300_000);

  test('a declared repository with no commit does not break the wiki: the status names it, and the fill says what it did for it', async () => {
    // A checkout with no commit yet: it is a repository the product declares, and nothing is read
    // of it. The wiki answers, names it with its path, and the fill reads the other repository and
    // says what it did for this one (madarch-8bdc.2.5, item 2 of the view's rework).
    const empty = join(root, 'empty-code');
    mkdirSync(empty, { recursive: true });
    git(empty, 'init', '-q', '-b', 'main');
    writeFileSync(join(empty, 'README.md'), '# Nothing committed\n');
    const committed = join(root, 'committed-code');
    mkdirSync(join(committed, 'src'), { recursive: true });
    git(committed, 'init', '-q', '-b', 'main');
    writeFileSync(join(committed, 'src', 'a.ts'), 'export const a = 1;\n');
    git(committed, 'add', '-A');
    git(committed, 'commit', '-qm', 'the committed repository');
    const folder = makeProduct(home, 'half', committed, 'committed-code');
    useFixturePlugins(folder, ['disk', 'git']);
    nativeWorkflow(folder);
    // This case compares the unread-checkout finding before and after the fill. Other rule predicates are outside
    // its scope: the product's bundled plugin files are not the source files this fixture measures.
    const kindsFile = join(folder, 'madarch', 'kinds.yaml');
    const kinds = parseDocument(readFileSync(kindsFile, 'utf8'));
    const unreadableRule = kinds.getIn(['problems', 'rules', 'wiki.unreadable-file']);
    kinds.setIn(['problems', 'rules'], { 'wiki.unreadable-file': unreadableRule });
    writeFileSync(kindsFile, kinds.toString());
    // The manifest declares the empty checkout beside the committed one.
    const manifest = join(folder, 'workspace.yaml');
    writeFileSync(manifest, `${readFileSync(manifest, 'utf8').replace(/(\n\s+- name: committed-code[\s\S]*)$/u, '$1  - name: empty-code\n    url: file:///empty-code\n')}`);
    symlinkSync(empty, join(folder, 'repos', 'empty-code'), 'dir');
    git(folder, 'add', '-A');
    git(folder, 'commit', '-qm', 'a product with one repository that holds no commit');
    const server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      // The empty wiki answers: no 500, the repository listed, and a finding that names its path.
      const emptyStatus = await json(server, 'half', '/api/status');
      expect(emptyStatus.status).toBe(200);
      expect(JSON.stringify(emptyStatus.body['repositories'])).toContain('empty-code');
      // Validated metadata makes the unread checkout visible before any fill, without reading documents.
      const before = await json(server, 'half', '/api/problems');
      expect(before.status).toBe(200);
      expect(before.body['categories']).toMatchObject([{ rule: 'wiki.unreadable-file', count: 1, open: 1, closed: 0 }]);
      expect((before.body['categories'] as unknown[]).length).toBe(1);
      const emptyPath = join(folder, 'repos', 'empty-code');
      const problemRoute = `/api/problems?rule=${encodeURIComponent('wiki.unreadable-file')}&source=${encodeURIComponent(emptyPath)}`;
      const beforeSources = await json(server, 'half', '/api/problems?rule=wiki.unreadable-file');
      expect(beforeSources.status).toBe(200);
      expect((beforeSources.body['sources'] as { key: string }[]).map((source) => source.key)).toEqual([emptyPath]);
      const beforeItems = await json(server, 'half', problemRoute);
      expect(beforeItems.status).toBe(200);
      const initialProblems = beforeItems.body['problems'] as { id: string; reason: string; source?: string }[];
      expect(initialProblems).toMatchObject([{
        source: emptyPath,
        reason: 'the repository "empty-code" holds no commit yet: nothing is read from it until it does',
      }]);
      expect(initialProblems.length).toBe(1);
      expect(typeof initialProblems[0]!.id).toBe('string');
      // The fill reads the committed repository and says what it did for the empty one.
      const ended = await press(server, 'half');
      const fill = ended['fill'] as Record<string, unknown>;
      expect(fill['state']).toBe('done');
      // The finding now lives on the Problems page: its category, then the source the repository is,
      // then the item itself, with the engine's words and the checkout's full path (madarch-8bdc.2.5).
      const categories = await json(server, 'half', '/api/problems');
      expect(categories.status).toBe(200);
      expect((categories.body['categories'] as { rule: string }[]).filter((category) => category.rule === 'wiki.unreadable-file')).toEqual(before.body['categories'] as { rule: string }[]);
      const sources = await json(server, 'half', `/api/problems?rule=${encodeURIComponent('wiki.unreadable-file')}`);
      expect(sources.status).toBe(200);
      const emptySource = (sources.body['sources'] as { key: string }[]).find((source) => source.key === join(folder, 'repos', 'empty-code'));
      expect(emptySource).toBeDefined();
      expect((sources.body['sources'] as { key: string }[]).map((source) => source.key)).toEqual([emptyPath]);
      const items = await json(server, 'half', `/api/problems?rule=${encodeURIComponent('wiki.unreadable-file')}&source=${encodeURIComponent(emptySource!.key)}`);
      expect(items.status).toBe(200);
      expect((items.body['problems'] as { id: string }[]).map((problem) => problem.id)).toEqual([initialProblems[0]!.id]);
      const item = (items.body['problems'] as { reason: string; source?: string }[]).find((problem) => problem.reason.includes('holds no commit yet'));
      expect(item).toBeDefined();
      expect(item!.reason).toContain('holds no commit yet');
      expect(item!.source).toBe(join(folder, 'repos', 'empty-code'));
      expect(fill['unread']).toEqual([{ repository: 'empty-code', path: join(folder, 'repos', 'empty-code'), reason: 'the checkout holds no commit yet' }]);
      const counts = (ended['repository'] as Record<string, unknown>)['counts'] as Record<string, unknown>;
      expect(counts['files']).toBe(1);
      // The pages of the committed repository answer; the product's wiki stands.
      const file = await pageOf(server, 'half', 'code.file:committed-code/src/a.ts');
      expect(file.status).toBe(200);
      const after = await json(server, 'half', '/api/status');
      expect(after.status).toBe(200);
    } finally {
      await server.stop();
    }
  }, 300_000);

  test('a store where only the tree ran shows no page of the history, and names the step', async () => {
    const { folder } = product('treeonly', (repository) => {
      mkdirSync(join(repository, 'src'), { recursive: true });
      writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
      git(repository, 'add', '-A');
      git(repository, 'commit', '-qm', 'one commit');
    }, ['disk']);
    // Only disk is declared: git history does not run merely because both producers share a stage. This is
    // the one store every surface resolves (`productStoreFolder`), under the home's knowledge root.
    const store = productStoreFolder(folder, knowledgeRootOf(home));
    mkdirSync(join(store, 'graph'), { recursive: true });
    const owner = await createTestDatabaseOwner({ store: join(store, 'graph'), btreeGist: true });
    try {
      await prepareStore(owner, { contract: await readPinnedGraphContract(folder) });
      const run = await runFill({ product: folder, database: owner, steps: ['plugin-turns'], runId: 'tree-only', store, home: store, prepareContract: async (contract) => { await prepareStore(owner, { contract }); } });
      expect(run.ok).toBe(true);
    } finally {
      await owner.close();
    }
    const server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      const status = await json(server, 'treeonly', '/api/status');
      const repository = status.body['repository'] as Record<string, unknown>;
      expect(repository['steps']).toEqual({ 'tree': true, 'history': false });
      // The file page stands, with no history: the history step has not run.
      const file = await pageOf(server, 'treeonly', 'code.file:treeonly-code/src/a.ts');
      expect(file.status).toBe(200);
      expect((blockOf(file, 'filePage').data as Record<string, unknown>)['commitCount']).toBe(0);
      // No commit has a page: the entity the graph does not hold is a named 404.
      const commit = await pageOf(server, 'treeonly', 'code.commit:0000000000000000000000000000000000000000');
      expect(commit.status).toBe(404);
    } finally {
      await server.stop();
    }
  }, 300_000);

  test('a fill that ends does not validate the graph through a closed owner', async () => {
    product('validated', (folder) => {
      mkdirSync(join(folder, 'docs'), { recursive: true });
      writeFileSync(join(folder, 'docs', 'index.md'), '# Index\n');
      git(folder, 'add', '-A');
      git(folder, 'commit', '-qm', 'one file');
    });
    const errors: string[] = [];
    const server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: (line) => errors.push(line) });
    try {
      await press(server, 'validated');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(errors.filter((line) => line.includes('could not validate the graph after the fill'))).toEqual([]);
    } finally {
      await server.stop();
    }
  }, 300_000);
});
