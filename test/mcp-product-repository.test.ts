/**
 * The MCP server over a product's own repository (madarch-8bdc.2.5 review, item 4): a product named
 * `sample` that connects a repository also called `sample` fills two repositories under two ids, and
 * the server reads the product's own under the id its fill pinned it as (`sample-product`).
 *
 * The fixture is a product this test makes with one connected checkout, filled by the one fill and
 * then served from the store that fill wrote. Before the id came from one function, the start filled
 * `sample-product` and then read `sample`, found no commit there, and refused its own fill
 * ("a graph of another commit is not served").
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { repositoryFacts } from '../src/graph/index.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { runFill } from '../src/fill/run.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RepositorySession } from '../src/mcp/session.js';
import { writeFirstFillWorkflow } from './fill-workflow-fixture.js';
import { fillInProcess } from './fill-inline.js';
import { createTestDatabaseOwner } from './test-database.js';

const ROOT = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-product-'));
const PRODUCT = path.join(ROOT, 'sample');
const HOME = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-product-home-'));
const COMMIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Ada Example', GIT_AUTHOR_EMAIL: 'ada@example.test', GIT_COMMITTER_NAME: 'Ada Example', GIT_COMMITTER_EMAIL: 'ada@example.test', TZ: 'UTC', LC_ALL: 'C' };

const run = (folder: string, ...args: string[]): string => execFileSync('git', args, { cwd: folder, encoding: 'utf8', env: COMMIT_ENV }).trim();

function put(folder: string, relativePath: string, text: string): void {
  mkdirSync(path.dirname(path.join(folder, relativePath)), { recursive: true });
  writeFileSync(path.join(folder, relativePath), text, 'utf8');
}

let session: RepositorySession | undefined;
let productCommit = '';
let connectedCommit = '';

beforeAll(async () => {
  // The product's own repository: a manifest, a workflow, a source file and a commit.
  mkdirSync(path.join(PRODUCT, 'src'), { recursive: true });
  writeFileSync(path.join(PRODUCT, 'workspace.yaml'), [
    'schemaVersion: 1',
    'id: 3b2a1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    'name: sample',
    'repos:',
    '  - name: sample',
    '    url: https://example.invalid/sample.git',
    '',
  ].join('\n'));
  writeFirstFillWorkflow(PRODUCT);
  for (const file of STARTER_FILES) put(PRODUCT, file.path, file.content);
  put(PRODUCT, 'src/total.ts', 'export function total(): number {\n  return 42;\n}\n');
  run(PRODUCT, 'init', '-q', '-b', 'main');
  run(PRODUCT, 'add', '-A');
  run(PRODUCT, 'commit', '-qm', 'the sample product');
  productCommit = run(PRODUCT, 'rev-parse', 'HEAD');
  // The connected repository of the product's own name, in a checkout the manifest links to.
  const connected = path.join(ROOT, 'sample-connected');
  mkdirSync(connected, { recursive: true });
  put(connected, 'main.go', 'package main\n');
  run(connected, 'init', '-q', '-b', 'main');
  run(connected, 'add', '-A');
  run(connected, 'commit', '-qm', 'the connected sample');
  connectedCommit = run(connected, 'rev-parse', 'HEAD');
  mkdirSync(path.join(PRODUCT, 'repos'), { recursive: true });
  symlinkSync(connected, path.join(PRODUCT, 'repos', 'sample'), 'dir');
  await fillInProcess(PRODUCT, path.join(HOME, 'products'));
  session = await RepositorySession.open({ repository: PRODUCT, env: { ...process.env, MADARCH_HOME: HOME } });
}, 600_000);

afterAll(async () => {
  await session?.close();
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

describe("the server over a product's own repository", () => {
  test('serves the product repository under the id its fill pinned it as, at the commit it filled', async () => {
    if (session === undefined) throw new Error('the session was not opened');
    const answered = await session.call('get_repository', {});
    expect(answered.isError).toBe(false);
    const answer = answered.answer as Record<string, unknown>;
    // One store names one repository by one id: the product's own is `sample-product`, and the
    // connected repository of the product's name is `sample`, exactly as the fill's pins name them.
    expect(answer['repository']).toBe('sample-product');
    expect(answer['asIsCommit']).toBe(productCommit);
    expect((answer['source'] as Record<string, unknown>)['repository']).toBe(PRODUCT);
    expect((answer['source'] as Record<string, unknown>)['commit']).toBe(productCommit);
    const files = await session.call('list_files', {});
    expect(files.isError).toBe(false);
    expect(((files.answer as Record<string, unknown>)['files'] as { path: string }[]).map((file) => file.path)).toEqual([...new Set([...STARTER_FILES.map((file) => file.path), 'madarch/workflows.yaml', 'src/total.ts', 'workspace.yaml'])].sort());
  }, 600_000);

  test('the store holds both repositories under their own ids and commits, never one for the other', async () => {
    if (session === undefined) throw new Error('the session was not opened');
    // The fill's pins name two checkouts by two ids; the store must hold each under its own id, at
    // its own commit, with its own files. A pin id resolved to the wrong folder would put the
    // product's commits under the connected repository's name (review, item 4).
    const folder = session.stateFolder;
    await session.close();
    session = undefined;
    const owner = await createTestDatabaseOwner({ store: storeDatabasePath(folder), btreeGist: true });
    try {
      const product = await repositoryFacts(owner, 'sample-product');
      expect(product?.asIsCommit).toBe(productCommit);
      expect(product?.fileCount).toBe(new Set([...STARTER_FILES.map((file) => file.path), 'madarch/workflows.yaml', 'src/total.ts', 'workspace.yaml']).size);
      const connected = await repositoryFacts(owner, 'sample');
      expect(connected?.asIsCommit).toBe(connectedCommit);
      expect(connected?.fileCount).toBe(1);
    } finally {
      await owner.close();
    }
  }, 600_000);
});
