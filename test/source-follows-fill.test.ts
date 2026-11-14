/**
 * A source read follows a fill another process published (decision 0036, section 8: `/api/source` answers the text of the
 * filled commit). The api instance may have answered before the fill landed; the text it reads is the store's, so the
 * commit it reports and the kinds it reads must be the store's too — the follow step the old page context ran.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { ensureVertex, journalFor, publishOpinion, writeJournal } from '../src/graph/write.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { fillInProcess } from './fill-inline.js';
import { activateTestProduct, retainTestStorePreparationOwner } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

let work = '';
let home = '';
let folder = '';
let repository = '';
let closeOwner: (() => Promise<void>) | undefined;

/** The commit a repository stands at now. */
const headOf = (): string => git(repository, 'rev-parse', 'HEAD');

/** One `source` opinion, as the fill's source-text producer states it. */
async function publishSource(path: string, text: string, commit: string): Promise<void> {
  const read = readKinds(folder);
  if (!read.present) throw new Error('the fixture manifest is absent');
  const contract = graphContractOf(read.manifest);
  const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, knowledgeRootOf(home))), connectOnly: true });
  try {
    await owner.transaction('write', async (tx) => {
      const journal = journalFor('fixture@1');
      const node = await ensureVertex(tx, contract, { kind: 'source', key: { repository: 'code', path } }, 1, journal);
      await publishOpinion(tx, contract, { kind: 'source', nodeId: node.nodeId, producer: 'fixture', producerVersion: '1',
        values: { source_text: text, commit } }, 1, journal);
      await writeJournal(tx, journal);
    });
  } finally { await owner.close(); }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'madarch-source-follow-'));
  home = join(work, 'products');
  repository = join(work, 'code');
  mkdirSync(join(repository, 'src'), { recursive: true });
  git(repository, 'init', '-q', '-b', 'main');
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 1;\n');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'first');
  folder = makeProduct(home, 'source-follow', repository, 'code');
  useFixturePlugins(folder, ['disk', 'git']);
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  first-fill:\n    status: implemented\n    stages: [plugin-turns]\n');
  git(folder, 'add', '-A');
  git(folder, 'commit', '-qm', 'the product and its one repository');
  closeOwner = await retainTestStorePreparationOwner();
  await fillInProcess(folder, home);
  await activateTestProduct(folder, home);
}, 180_000);

afterAll(async () => {
  await closeOwner?.();
  if (work !== '') rmSync(work, { recursive: true, force: true });
});

test('a source read reports the commit of a fill another process published, with the text that fill left', async () => {
  const first = headOf();
  await publishSource('src/a.ts', 'export const a = 1;\n', first);
  const api = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home) });
  try {
    const before = await api.source('code', 'src/a.ts');
    expect(before).toEqual({ text: 'export const a = 1;\n', commit: first });
    // Another process fills: a new commit, a new pin, and the source text the fill's producer states for it.
    writeFileSync(join(repository, 'src', 'a.ts'), 'export const a = 2;\n');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-qm', 'second');
    const second = headOf();
    await fillInProcess(folder, home);
    await publishSource('src/a.ts', 'export const a = 2;\n', second);
    // The text is read from the store; the commit and the kinds must be the store's too, without a status poll between.
    expect(await api.source('code', 'src/a.ts')).toEqual({ text: 'export const a = 2;\n', commit: second });
  } finally { await api.close(); }
}, 180_000);
