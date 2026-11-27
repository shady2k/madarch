/**
 * The Problems page of a product whose manifest declares no `document` kind (madarch-64o5.181): the wiki's frame asks
 * `GET /api/problems` on every page it opens, and the catalogue's semantic roles are the product's — a product that
 * declares no documents has none to project, and its Problems list and count answer HTTP 200 instead of a refusal that
 * would leave every page's frame without a count.
 *
 * The fixture is a product whose manifest declares its tasks, its repositories and no `document` role at all: the
 * read that used to refuse is the document projection (`src/knowledge/anchors.ts`), not the tasks' or the files'.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import type { StartedServer } from '../src/server/http.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { startPreparedServer } from './prepared-server.js';
import { createTestDatabaseOwner } from './test-database.js';

/**
 * A product the wiki serves: a task kind with the `problem-task` role the Problems page links tasks through, and a
 * repository kind with the `repository` role the file index reads. No `document` kind and no `semantic-bindings.document`.
 */
const MANIFEST = `kinds:
  product:
    source: graph
    title: title
    key: [slug]
    fields:
      - { name: slug, type: text, producers: [start] }
      - { name: title, type: text, producers: [start] }
  code.repository:
    source: graph
    title: repo-name
    key: [name]
    fields:
      - { name: name, type: text, producers: [agent] }
      - { name: url, type: text, nullable: true, producers: [agent] }
      - { name: default_branch, type: text, nullable: true, producers: [agent] }
      - { name: tree_snapshot, type: text, nullable: true, producers: [agent] }
      - { name: history_shallow, type: boolean, nullable: true, producers: [agent] }
  task:
    source: graph
    title: title
    key: [key]
    fields:
      - { name: key, type: text, producers: [agent] }
      - { name: title, type: text, producers: [agent] }
      - { name: description, type: text, nullable: true, producers: [agent] }
      - { name: status, type: text, nullable: true, producers: [agent] }
      - { name: tracker, type: text, producers: [agent] }
edges:
  - name: task-problem
    from: [task]
    to: [system.problem]
    cardinality: { from: { min: 0, max: 1 }, to: { min: 0, max: null } }
    labels:
      en: { out: tracks problem, in: tracked by task }
      ru: { out: решает проблему, in: решается задачей }
semantic-bindings:
  repository:
    kind: code.repository
    fields:
      name: name
      url: url
      default_branch: default_branch
      tree_snapshot: tree_snapshot
      history_shallow: history_shallow
  problem-task:
    kind: task
    fields: { title: title, description: description, status: status, tracker: tracker, key: key }
    edges:
      problems: { kind: task-problem, direction: from }
`;

const PRODUCT = 'no-documents';
let root = '';
let home = '';
let server: StartedServer | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-problems-no-documents-'));
  home = join(root, 'products');
  const folder = join(home, PRODUCT);
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), `schemaVersion: 1\nid: ${PRODUCT}\nname: ${PRODUCT}\n`);
  writeFolderManifest(folder, MANIFEST);
  const env = gitEnv(SAMPLE_IDENTITY);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: folder, env });
  execFileSync('git', ['add', '-A'], { cwd: folder, env });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'a product with no document kind'], { cwd: folder, env });
  const validation = validateProductManifests(folder);
  if (!validation.ok || validation.value === undefined) throw new Error(`${folder}:1: the fixture manifest is refused: ${JSON.stringify(validation.ok ? [] : validation.findings)}`);
  // The wiki reads the catalogue the graph holds, not the checkout (madarch-hsqs stage C): the fixture publishes it the
  // way a start does, into the store the wiki opens for this product.
  const store = productStoreFolder(folder, knowledgeRootOf(home));
  const owner = await createTestDatabaseOwner({ store: storeDatabasePath(store), graphContract: withManifestContract(graphContractOf(validation.value.manifest)) });
  try { await publishValidatedManifests(owner, validation.value); }
  finally { await owner.close(); }
  const app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>app</title>\n');
  server = await startPreparedServer({ productHome: home, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

/** The Problems answers of the fixture product, read the way the wiki's frame reads them. */
const problems = async (query = ''): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${server!.url}/products/${PRODUCT}/api/problems${query}`, { headers: { accept: 'application/json' } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe('a product whose manifest declares no document kind', () => {
  test('its Problems list answers 200 with a listing and no failed document read', async () => {
    const { status, body } = await problems();
    expect(status).toBe(200);
    expect(body).toMatchObject({ problems: [], categories: [], sections: { code: 0, documents: 0, wiki: 0 }, open: 0, closed: 0, dismissed: 0 });
    const notes = (body.notes as { message: string }[]).map((note) => note.message);
    // A declared role's own faults stay refusals; a role the product does not declare is no fault of the page.
    expect(notes.filter((note) => note.includes('semantic role "document"'))).toEqual([]);
    expect(notes.filter((note) => note.includes('could not be listed'))).toEqual([]);
  }, 120_000);

  test('its Problems count answers 200 with the same read', async () => {
    const { status, body } = await problems('?count=1');
    expect(status).toBe(200);
    expect(body).toEqual({ open: 0, closed: 0, dismissed: 0, sections: { code: 0, documents: 0, wiki: 0 } });
  }, 120_000);
});
