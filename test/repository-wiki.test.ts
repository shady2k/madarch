/**
 * The repository pages of the wiki (madarch-8bdc.2.5, items 2, 3 and 4): an
 * empty product, the press, the progress, the end state, and then the
 * repository, a folder, a file and a commit — over HTTP, the way
 * the app reads them.
 *
 * The products are fixtures this test makes; the generated repository of the
 * walk is not needed to know that a page is the store's own answer. One case
 * writes two thousand files, because the repository page must open without
 * loading them all.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { runFill } from '../src/fill/run.js';
import { storeFolderOf } from '../src/knowledge/product.js';
import { startServer, type StartedServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

let root = '';
let home = '';
let app = '';

/** A product whose one repository is the folder named: the fixture writes the files, this makes the product. */
function product(name: string, write: (repository: string) => void): { folder: string; repository: string } {
  const repository = join(root, `${name}-code`);
  mkdirSync(repository, { recursive: true });
  git(repository, 'init', '-q', '-b', 'main');
  write(repository);
  const folder = makeProduct(home, name, repository, `${name}-code`);
  git(folder, 'add', '-A');
  git(folder, 'commit', '-qm', `the product ${name}`);
  return { folder, repository };
}

/** One page of a product, as the app reads it. */
const json = async (server: StartedServer, product: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const answer = await fetch(`${server.url}/products/${product}${path}`, { headers: { accept: 'application/json' } });
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
};

/** Presses the fill and waits for the run to end; answers the status that says how it ended. */
async function press(server: StartedServer, name: string): Promise<Record<string, unknown>> {
  const pressed = await fetch(`${server.url}/products/${name}/api/k/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: null }) });
  expect(pressed.status).toBe(202);
  for (let attempt = 0; attempt < 1200; attempt++) {
    const status = await json(server, name, '/api/k/status');
    const fill = status.body['fill'] as Record<string, unknown>;
    if (fill['state'] !== 'running') return status.body;
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
    const { repository } = product('walk', (folder) => {
      mkdirSync(join(folder, 'src', 'nested'), { recursive: true });
      mkdirSync(join(folder, 'assets'), { recursive: true });
      writeFileSync(join(folder, 'README.md'), '# Walk\n\nA fixture.\n');
      writeFileSync(join(folder, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(folder, 'src', 'nested', 'b.ts'), 'export const b = 2;\n');
      writeFileSync(join(folder, 'assets', 'picture.bin'), Uint8Array.from([0, 1, 2, 0, 255]));
      git(folder, 'add', '-A');
      git(folder, 'commit', '-qm', 'the tree is written');
      git(folder, 'mv', 'src/nested/b.ts', 'src/nested/c.ts');
      git(folder, 'commit', '-qm', 'the nested file moves');
    });
    const server = await startServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      // The empty state: the manifest reads, the store holds no repository and no trace.
      const empty = await json(server, 'walk', '/api/k/status');
      expect(empty.status).toBe(200);
      expect(empty.body['repository']).toBeUndefined();
      expect((empty.body['fill'] as Record<string, unknown>)['state']).toBe('idle');
      const noRepository = await json(server, 'walk', '/api/k/repository');
      expect(noRepository.status).toBe(404);
      expect(String((noRepository.body['message'] ?? (noRepository.body['error'] as Record<string, unknown> | undefined)?.['message']))).toContain('repository-tree');

      const ended = await press(server, 'walk');
      expect((ended['fill'] as Record<string, unknown>)['state']).toBe('done');
      expect(ended['filled']).toBe(true);
      expect(ended['incomplete']).toBe(false);
      // The counts: the store's own numbers.
      const repositoryFacts = ended['repository'] as Record<string, unknown>;
      expect(repositoryFacts['counts']).toEqual({ files: 4, commits: 2, folders: 3 });
      expect(repositoryFacts['steps']).toEqual({ 'tree': true, 'history': true });
      const fill = ended['fill'] as Record<string, unknown>;
      expect(fill['counts']).toEqual({ files: 4, commits: 2, folders: 3 });

      // The repository page, its tree, one file, one commit and the run.
      const repositoryPage = await json(server, 'walk', '/api/k/repository');
      expect(repositoryPage.status).toBe(200);
      expect((repositoryPage.body['repository'] as Record<string, unknown>)['name']).toBe('walk-code');
      const rootFolder = await json(server, 'walk', '/api/k/folder?path=');
      expect(rootFolder.status).toBe(200);
      const rootModel = rootFolder.body['folder'] as Record<string, unknown>;
      expect(rootModel['folders']).toEqual(['assets', 'src']);
      expect((rootModel['files'] as { path: string }[]).map((file) => file.path)).toEqual(['README.md']);
      const nested = await json(server, 'walk', '/api/k/folder?path=src%2Fnested');
      expect(nested.status).toBe(200);
      expect((nested.body['folder'] as Record<string, unknown>)['parent']).toBe('src');
      expect(((nested.body['folder'] as Record<string, unknown>)['files'] as { path: string }[]).map((file) => file.path)).toEqual(['src/nested/c.ts']);
      const file = await json(server, 'walk', '/api/k/file?path=src%2Fnested%2Fc.ts');
      expect(file.status).toBe(200);
      const fileModel = file.body['file'] as Record<string, unknown>;
      expect((fileModel['file'] as Record<string, unknown>)['form']).toBe('text');
      expect((fileModel['history'] as { change: string; previousPath: string | null }[]).map((row) => [row.change, row.previousPath])).toEqual([['renamed', 'src/nested/b.ts'], ['added', null]]);
      const hash = (fileModel['history'] as { commit: string }[])[0]!.commit;
      const commit = await json(server, 'walk', `/api/k/commit?hash=${hash}`);
      expect(commit.status).toBe(200);
      expect((commit.body['commit'] as Record<string, unknown>)['subject']).toBe('the nested file moves');
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
    const server = await startServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      const ended = await press(server, 'many');
      const facts = ended['repository'] as Record<string, unknown>;
      expect((facts['counts'] as Record<string, unknown>)['files']).toBe(2000);
      const root = await json(server, 'many', '/api/k/folder?path=');
      expect(root.status).toBe(200);
      const rootModel = root.body['folder'] as Record<string, unknown>;
      expect(rootModel['folders']).toEqual(['files']);
      // The root holds one folder and no file: the page is small whatever the tree holds.
      expect(rootModel['files']).toEqual([]);
      const deep = await json(server, 'many', '/api/k/folder?path=files%2Fdeep');
      const deepModel = deep.body['folder'] as Record<string, unknown>;
      const page = deepModel['files'] as unknown[];
      expect(page.length).toBe(100);
      expect(deepModel['next']).toBe('files/deep/f0099.txt');
      // The whole answer is a page, not the repository: two thousand rows would be tens of thousands of bytes.
      expect(JSON.stringify(deep.body).length).toBeLessThan(60_000);
      const second = await json(server, 'many', '/api/k/folder?path=files%2Fdeep&after=files%2Fdeep%2Ff0099.txt');
      expect(((second.body['folder'] as Record<string, unknown>)['files'] as { path: string }[])[0]!.path).toBe('files/deep/f0100.txt');
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
    });
    // The store the product reads, filled by the tree pass alone: the history step did not run.
    const manifest = join(folder, 'workspace.yaml');
    const id = /^id: (.+)$/mu.exec(execFileSync('cat', [manifest], { encoding: 'utf8' }))?.[1];
    expect(typeof id).toBe('string');
    const store = storeFolderOf(join(home, '.madarch', 'knowledge'), id!, manifest);
    mkdirSync(join(store, 'graph'), { recursive: true });
    const owner = createPGliteDatabaseOwner({ path: join(store, 'graph'), btreeGist: true });
    try {
      const run = await runFill({ product: folder, database: owner, steps: ['repository-tree'], runId: 'tree-only', store, home: store });
      expect(run.ok).toBe(true);
    } finally {
      await owner.close();
    }
    const server = await startServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    try {
      const status = await json(server, 'treeonly', '/api/k/status');
      const repository = status.body['repository'] as Record<string, unknown>;
      expect(repository['steps']).toEqual({ 'tree': true, 'history': false });
      // The file page stands, with no history: the history step has not run.
      const file = await json(server, 'treeonly', '/api/k/file?path=src%2Fa.ts');
      expect(file.status).toBe(200);
      expect(((file.body['file'] as Record<string, unknown>)['history'] as unknown[])).toEqual([]);
      expect(((file.body['file'] as Record<string, unknown>)['commitCount'] as number)).toBe(0);
      // No commit has a page: the step that would have made it is named.
      const commit = await json(server, 'treeonly', '/api/k/commit?hash=0000000000000000000000000000000000000000');
      expect(commit.status).toBe(404);
      expect(String(commit.body['message'])).toContain('repository-history');
    } finally {
      await server.stop();
    }
  }, 300_000);
});
