/**
 * A source read follows a fill another process published (decision 0036, section 8: `/api/source` answers the text of the
 * filled commit). The api instance may have answered before the fill landed; the text it reads is the store's, so the
 * commit it reports and the kinds it reads must be the store's too — the follow step the old page context ran.
 */
import { parse, stringify } from 'yaml';
import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
import { afterAll, beforeAll, expect, test, spyOn } from 'bun:test';
import { Client } from 'pg';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { fillInProcess } from './fill-inline.js';
import { activateTestProduct, retainTestStorePreparationOwner } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY, makeProduct } from './knowledge-fixture.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';
import { startFileTextServer } from './file-text-server.js';

/** The host hands the plugin the git tool it resolved; a test that serves reads does the same. */
process.env['MADARCH_TOOL_GIT'] = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

/** The source-text kind the fixture declares: a file's text at the commit a fill recorded. */
const SOURCE_KIND = `id: fixture.source
purpose: history
audience: [developer, architect]
definition: A source text is the text of one repository file at the commit the fill recorded.
sources:
- https://git-scm.com/docs/git-show
acquisition:
- conversation
relation-constraints:
  out: []
  in: []
template-policy: page
source: graph
fields:
- name: path
  type: text
  producers:
  - person
- name: blob
  type: text
  producers:
  - person
key:
- path
key-edges:
- role: source-repository
  edge: source-repository
  side: from
labels:
  en:
    one: Source text
    many: Source texts
  ru:
    one: Исходный текст
    many: Исходные тексты
description:
  en: A source text is the text of one file of a repository at the commit a fill recorded, kept so a reader opens it without the repository.
  ru: Исходный текст — текст одного файла репозитория на коммите, который записал проход, чтобы читатель открыл его без репозитория.
`;

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

let work = '';
let home = '';
let folder = '';
let repository = '';
let closeOwner: (() => Promise<void>) | undefined;
let files: Awaited<ReturnType<typeof startFileTextServer>> | undefined;
let readOwner: DatabaseOwner | undefined;

/** The commit a repository stands at now. */
const headOf = (): string => git(repository, 'rev-parse', 'HEAD');
/** The blob of one file at the repository's head. */
const blobOf = (path: string): string => git(repository, 'rev-parse', `HEAD:${path}`);

/** One file's blob, as a fill states it: the text of a file is read by the blob the graph names (decision 0037). */
async function publishBlob(path: string, blob: string, previousCommit?: string): Promise<void> {
  const read = readKinds(folder);
  if (!read.present) throw new Error('the fixture manifest is absent');
  const contract = graphContractOf(read.manifest);
  const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, knowledgeRootOf(home))), connectOnly: true });
  try {
    await owner.transaction('write', async (tx) => {
      await bindTestWriteCapability(tx, contract);
      const repository = { kind: 'code.repository', key: { name: 'code' } };
      const source = { kind: 'fixture-text', key: { path }, keyEdges: { 'source-repository': repository } };
      const revision = { kind: 'code.commit', key: { hash: headOf() } };
      const provenance = { producer: 'fixture', producerVersion: '1' };
      await publishGraphDrafts(tx, contract, { vertices: [{ ...source, ...provenance, values: { blob } }, { ...revision, ...provenance }], removals: [], edges: [
        { kind: 'source-repository', from: source, to: repository, ...provenance },
        { kind: 'source-commit', from: source, to: revision, ...provenance },
      ], edgeRemovals: previousCommit === undefined ? [] : [
        { kind: 'source-commit', from: source, to: { kind: 'code.commit', key: { hash: previousCommit } }, producer: provenance.producer },
      ] });
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
  // The fixture declares its own source role and graph relationships; no field name selects it.
  mkdirSync(join(folder, 'madarch/kinds/common/attachment'), { recursive: true });
  writeFileSync(join(folder, 'madarch/kinds/common/attachment/fixture-text.yaml'), SOURCE_KIND);
  const declaration = parse(readFolderManifestText(folder));
  declaration['semantic-bindings'].source = { kind: 'fixture-text', fields: { path: 'path', blob: 'blob' }, edges: {
    repository: { kind: 'source-repository', direction: 'from' }, commit: { kind: 'source-commit', direction: 'from' },
  } };
  for (const [name, target, required] of [['source-repository', 'code.repository', true], ['source-commit', 'code.commit', false]] as const) {
    declaration.edges.push({ name, from: ['fixture-text'], to: [target], cardinality: { from: { min: required ? 1 : 0, max: 1 }, to: { min: 0, max: null } },
      ...(required ? { 'on-parent-delete': 'restrict' } : {}), labels: { en: { out: name, in: 'source text' }, ru: { out: 'источник', in: 'исходный текст' } } });
  }
  writeFolderManifest(folder, stringify(declaration));
  useFixturePlugins(folder, ['disk', 'git'], ['fixture-text']);
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  first-fill:\n    status: implemented\n    stages: [plugin-turns]\n');
  git(folder, 'add', '-A');
  git(folder, 'commit', '-qm', 'the product and its one repository');
  closeOwner = await retainTestStorePreparationOwner();
  let statements=0,transactions=0,databaseMs=0;
  const query=Client.prototype.query;
  const spy=spyOn(Client.prototype,'query').mockImplementation(function(this:Client,...args:unknown[]){
    statements++;
    if(typeof args[0]==='string'&&args[0].startsWith('BEGIN'))transactions++;
    const started=performance.now();
    const answer=Reflect.apply(query,this,args);
    if(answer&&typeof answer.then==='function')void answer.then(()=>{databaseMs+=performance.now()-started;},()=>{databaseMs+=performance.now()-started;});
    return answer;
  } as typeof query);
  const started=performance.now();
  try { await fillInProcess(folder, home); } finally { spy.mockRestore(); }
  console.log('source fixture fill',JSON.stringify({statements,transactions,databaseMs,elapsedMs:performance.now()-started}));
  expect(statements).toBeLessThanOrEqual(1000);
  await activateTestProduct(folder, home);
  // The api role waits on the store's read queue: the fill role answers it, and this test serves that side itself.
  const reader = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, knowledgeRootOf(home))), connectOnly: true });
  files = await startFileTextServer(reader);
  readOwner = reader;
}, 180_000);

afterAll(async () => {
  await files?.stop();
  await readOwner?.close();
  await closeOwner?.();
  if (work !== '') rmSync(work, { recursive: true, force: true });
});

test('a source read reports the commit of a fill another process published, with the text that fill left', async () => {
  const first = headOf();
  await publishBlob('src/a.ts', blobOf('src/a.ts'));
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
    await publishBlob('src/a.ts', blobOf('src/a.ts'), first);
    // The text is read from the store; the commit and the kinds must be the store's too, without a status poll between.
    expect(await api.source('code', 'src/a.ts')).toEqual({ text: 'export const a = 2;\n', commit: second });
  } finally { await api.close(); }
}, 180_000);
