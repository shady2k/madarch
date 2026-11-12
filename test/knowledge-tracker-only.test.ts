import { writeFolderManifest } from './catalog-folder-fixture.js';
import { publishFixtureTemplate } from './structured-template-fixture.js';
import { authoredEntity } from '../src/graph/authored.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { prepareStore } from '../src/adapters/prepare-store.js';
/**
 * A product that is only a tracker (decision 0034, item 14): its manifest declares two person-authored kinds
 * and binds no capability. It opens, fills and serves its wiki, and its store holds the mechanism
 * tables and the fill's, and no repository, file, commit, signature, blob or path table.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { runFill } from '../src/fill/run.js';
import { createDraft } from '../src/product/draft.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { startPreparedServer } from './prepared-server.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { byCodePoint } from '../src/model/order.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

let root = '';
let home = '';
let app = '';
let product = '';

const MANIFEST = `groups:
  tracker: { en: Tracker, ru: Трекер, short: { en: Tracker, ru: Трекер } }
  tracker.items: { en: Items, ru: Записи, parent: tracker }
kinds:
  template:
    template: templates/item.liquid
    source: graph
    key: [path]
    fields:
      - { name: path, type: text, binding: { agent: "Fixture template path." } }
      - { name: template_parts, type: json, binding: { agent: "Fixture structured template parts." } }
  idea:
    template: templates/item.liquid
    source: graph
    origin: person
    fields:
      - { name: title, type: text, producers: [person] }
    group: tracker.items
    title: title
    labels:
      en: { one: Idea, many: Ideas }
      ru: { one: Идея, many: Идеи }
  task:
    template: templates/item.liquid
    source: graph
    origin: person
    fields:
      - { name: title, type: text, producers: [person] }
    group: tracker.items
    title: title
    labels:
      en: { one: Task, many: Tasks }
      ru: { one: Задача, many: Задачи }
`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-tracker-only-'));
  home = join(root, 'products');
  app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>\n');
  const draft = createDraft({ home, name: 'tracker', gitEnv: env });
  if (draft.outcome !== 'created') throw new Error(`the tracker product was not made: ${JSON.stringify(draft)}`);
  product = draft.folder;
  mkdirSync(join(product, 'templates'), { recursive: true });
  mkdirSync(join(product, 'docs', 'ideas'), { recursive: true });
  mkdirSync(join(product, 'docs', 'tasks'), { recursive: true });
  writeFolderManifest(product, MANIFEST);
  writeFileSync(join(product, 'templates', 'entity.liquid'), '{% block lead %}{% endblock %}\n{% block details %}{% endblock %}\n{% block parts %}{% endblock %}\n');
  writeFileSync(join(product, 'templates', 'item.liquid'), '{% layout "./entity.liquid" %}\n{% block lead %}{{ page.title }}{% endblock %}\n{% block details %}{% properties title="Details" %}{% endblock %}\n');
  writeFileSync(join(product, 'docs', 'ideas', 'one.md'), '---\nid: idea:one\nkind: idea\ntitle: One idea\n---\n\nAn idea.\n');
  writeFileSync(join(product, 'docs', 'tasks', 'one.md'), '---\nid: task:one\nkind: task\ntitle: One task\n---\n\nA task.\n');
  git(product, 'add', '-A');
  git(product, 'commit', '-qm', 'the tracker manifest and its two entities');
}, 120_000);

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('a product that is only a tracker', () => {
  test('opens, fills and serves with no code table in its store', async () => {
    const errors: string[] = [];
    const server = await startPreparedServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: (line) => errors.push(line) });
    let owner: DatabaseOwner | undefined;
    try {
      // Startup publishes the validated declarations; no entity exists before the fill or explicit authorship.
      const before = await fetch(`${server.url}/products/tracker/api/status`, { headers: { accept: 'application/json' } });
      expect(before.status, JSON.stringify({ body: await before.clone().text(), errors })).toBe(200);
      const opening = (await before.json()) as { manifest?: string; manifestFile?: string; filled?: boolean; kinds?: unknown[]; fill?: { state: string } };
      expect(opening).toMatchObject({ manifest: 'not-filled', filled: false, fill: { state: 'idle' } });
      expect((opening.kinds as { kind: string; count: number }[]).map(({ kind, count }) => ({ kind, count })).sort((a, b) => byCodePoint(a.kind, b.kind))).toEqual([{ kind: 'idea', count: 0 }, { kind: 'task', count: 0 }, { kind: 'template', count: 0 }]);
      expect(String(opening.manifestFile)).toContain(join('madarch', 'catalog.yaml'));
      const unopened = await fetch(`${server.url}/products/tracker/api/page?id=${encodeURIComponent('idea:00000000-0000-4000-8000-000000000001')}&full=1`, { headers: { accept: 'application/json' } });
      expect(unopened.status, JSON.stringify({ body: await unopened.text(), errors })).toBe(404);

      const store = productStoreFolder(product, knowledgeRootOf(home));
      owner = await createDatabaseOwner({ store: storeDatabasePath(store) });
      await prepareStore(owner, { contract: await readPinnedGraphContract(product) });
      const preparedOwner = owner;
      const filled = await runFill({ product, database: owner, store, home, runId: 'tracker-only', prepareContract: async (contract) => { await prepareStore(preparedOwner, { contract }); } });
      expect(filled.ok).toBe(true);
      if (!filled.ok) return;
      // The native workflow records repository history and tree as mechanism state, with no capability stage
      // because the manifest binds no code kind.
      expect(filled.units.map((unit) => unit.stageId)).toEqual(['repository-history', 'repository-tree']);
      const unimported = await (await fetch(`${server.url}/products/tracker/api/status`, { headers: { accept: 'application/json' } })).json() as { kinds: { kind: string; count: number }[] };
      expect(unimported.kinds.map(({ kind, count }) => ({ kind, count })).sort((a, b) => byCodePoint(a.kind, b.kind))).toEqual([{ kind: 'idea', count: 0 }, { kind: 'task', count: 0 }, { kind: 'template', count: 0 }]);
      const manifest = readKinds(product);
      if (!manifest.present) throw new Error('the tracker manifest is absent');
      await publishFixtureTemplate(owner, product, 'templates/item.liquid');
      const made = await owner.transaction('write', async (tx) => {
        const idea = await authoredEntity(tx, manifest.manifest, 'tracker', 'Fixture reader', 'create', 'idea', { values: { title: 'One idea' }, words: 'An idea.' });
        const task = await authoredEntity(tx, manifest.manifest, 'tracker', 'Fixture reader', 'create', 'task', { values: { title: 'One task' }, words: 'A task.' });
        return { idea: idea.entity!, task: task.entity! };
      });
      expect(made.idea.values).toEqual({ title: 'One idea' });
      expect(made.task.values).toEqual({ title: 'One task' });
      // Explicit authored records, not Markdown file bytes, supply the tracker entities.

      const status = await fetch(`${server.url}/products/tracker/api/status`, { headers: { accept: 'application/json' } });
      expect(status.status).toBe(200);
      const body = (await status.json()) as { kinds?: { kind: string; count: number }[]; filled?: boolean };
      expect(body.filled).toBe(true);
      expect(body.kinds?.some((kind) => kind.kind === 'idea' && kind.count === 1), JSON.stringify({ body, made, errors })).toBe(true);
      expect(body.kinds?.some((kind) => kind.kind === 'task' && kind.count === 1), JSON.stringify({ body, made, errors })).toBe(true);
      expect(body.kinds?.filter((kind) => kind.kind.startsWith('code.'))).toEqual([]);

      const tables = await owner.run((tx) => tx.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
      ));
      const names = tables.rows.map((row) => row.table_name);
      // The mechanism holds the product's files: the path index, the blob text and the entry of each path.
      expect(names).toContain('file_entry');
      expect(names.filter((name) => name.startsWith('d_path_'))).toHaveLength(1);
      expect(names.filter((name) => name.startsWith('d_blob_'))).toHaveLength(1);
      // No code kind is declared: only the tracker and structured-template opinion tables stand.
      for (const generated of ['k_file_', 'k_repository_', 'k_directory_', 'k_commit_', 'k_signature_', 'e_contains_', 'e_as-is_', 'd_language_']) {
        expect({ table: generated, present: names.some((name) => name.startsWith(generated)) }).toEqual({ table: generated, present: false });
      }
      for (const absent of ['repository', 'directory', 'file', 'gitlink', 'commit', 'signature', 'blob', 'path', 'language', 'touched', 'history', 'parent_position', 'authored', 'lifecycle', 'responsibility', 'work_span']) {
        expect({ table: absent, present: names.includes(absent) }).toEqual({ table: absent, present: false });
      }
      for (const present of ['entity', 'node', 'edge', 'context', 'operation']) {
        expect({ table: present, present: names.includes(present) }).toEqual({ table: present, present: true });
      }

      const page = await fetch(`${server.url}/products/tracker/api/page?id=${encodeURIComponent(`idea:${made.idea.uid}`)}&full=1`, { headers: { accept: 'application/json' } });
      expect(page.status).toBe(200);
    } finally {
      await owner?.close();
      await server.stop();
    }
  }, 300_000);
});
;
