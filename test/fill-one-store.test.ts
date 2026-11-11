/**
 * One product, one store (madarch-8bdc.2.5, item 7): `madarch fill-stages`, `madarch mcp` and the
 * wiki's reader resolve the store through the same function, and the command's run is what the
 * other two read.
 *
 * The fixture is a product the test makes under its own products home: the command fills it, the
 * MCP server's resolver names the store it wrote, and the wiki's reader opens the snapshot the
 * command finished for it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseOwner } from '../src/adapters/database-owner.js';
import { repositoryFacts } from '../src/graph/index.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { repositoryStoreFolder } from '../src/mcp/graph.js';
import { runGit } from '../src/product/git.js';
import { readProduct } from '../src/product/manifest.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { generateTrainingRepository, makeProduct } from './knowledge-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';

const PROJECT = join(import.meta.dir, '..');
const ROOT = mkdtempSync(join(tmpdir(), 'madarch-one-store-'));
/** The products home the command and every reader name. */
const PRODUCTS_HOME = join(ROOT, 'products');
let product = '';
let name = '';

/** One git call in the fixture product, through the project's own runner. */
function git(folder: string, ...args: string[]): string {
  const answer = runGit(folder, args);
  if (!answer.ok) throw new Error(`git ${args.join(' ')} failed in ${folder}: ${answer.output}`);
  return answer.output;
}

beforeAll(() => {
  mkdirSync(PRODUCTS_HOME, { recursive: true });
  const repository = generateTrainingRepository(join(ROOT, 'repository'));
  product = makeProduct(PRODUCTS_HOME, 'training-shop', repository);
  const read = readProduct(product);
  if (!read.ok) throw new Error(`${read.file}:${read.line}: ${read.message}`);
  name = read.product.name;
}, 300_000);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** One store's owner, closed by the caller. */
async function openStore(path: string): Promise<DatabaseOwner> {
  const owner = await createTestDatabaseOwner({ store: path, btreeGist: true });
  await owner.ready;
  return owner;
}

describe('the one store of one product', () => {
  let store = '';
  let head = '';

  test('madarch fill-stages writes the store every caller resolves, and finishes it for a reader', async () => {
    head = git(product, 'rev-parse', 'HEAD').trim();
    // The command as a person runs it, over this products home.
    const output = execFileSync(process.execPath, ['scripts/madarch.ts', 'fill-stages', '--product', product, '--home', PRODUCTS_HOME, '--json'], {
      cwd: PROJECT,
      env: { ...process.env, MADARCH_HOME: ROOT },
      encoding: 'utf8',
    });
    const answer = JSON.parse(output.trim().split('\n').at(-1)!) as { store: string; runId: string; state: string };
    expect(answer.state).toBe('succeeded');
    store = productStoreFolder(product, knowledgeRootOf(PRODUCTS_HOME));
    expect(answer.store).toBe(store);
    expect(existsSync(storeDatabasePath(store))).toBe(true);
    expect(existsSync(storeDatabasePath(store))).toBe(true);
    // The store's own records name the commit the run published (what `madarch mcp` reads first).
    const owner = await openStore(storeDatabasePath(store));
    try {
      expect((await repositoryFacts(owner, name))?.asIsCommit).toBe(head);
    } finally {
      await owner.close();
    }
  }, 300_000);

  test('the store the MCP server resolves is the one the command wrote', () => {
    expect(repositoryStoreFolder(product, { ...process.env, MADARCH_HOME: ROOT })).toBe(store);
  }, 60_000);

  test('the wiki reads the store the command filled, and its pins are the run\'s', async () => {
    const wiki = new KnowledgeProduct({ productFolder: product, storeRoot: knowledgeRootOf(PRODUCTS_HOME) });
    try {
      expect((await wiki.settingsView()).store).toBe(store);
      // The wiki reads the store the command wrote directly (madarch-8bdc.9): no copy stands between them.
      await wiki.status();
      const owner = await openStore(storeDatabasePath(store));
      try {
        // The pins are the graph's own rows (stage 3: `knowledge_fill` is gone): the repository entity and its as-is edge.
        expect((await repositoryFacts(owner, name))?.asIsCommit).toBe(head);
      } finally {
        await owner.close();
      }
    } finally {
      await wiki.close();
    }
  }, 300_000);
});
