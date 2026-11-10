/**
 * A product that is only a tracker (decision 0034, item 14): its manifest declares two Markdown kinds
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
import { startServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

const env = gitEnv(SAMPLE_IDENTITY);
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

let root = '';
let home = '';
let app = '';
let product = '';

const MANIFEST = `groups:
  tracker: { en: Tracker, ru: Трекер, short: { en: Tracker, ru: Трекер } }
kinds:
  idea:
    template: templates/item.liquid
    source: markdown
    folder: docs/ideas
    group: tracker
    title: label
    labels:
      en: { one: Idea, many: Ideas }
      ru: { one: Идея, many: Идеи }
  task:
    template: templates/item.liquid
    source: markdown
    folder: docs/tasks
    group: tracker
    title: label
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
  writeFileSync(join(product, 'madarch', 'kinds.yaml'), MANIFEST);
  writeFileSync(join(product, 'templates', 'entity.liquid'), '{% block lead %}{% endblock %}\n{% block details %}{% endblock %}\n{% block parts %}{% endblock %}\n');
  writeFileSync(join(product, 'templates', 'item.liquid'), '{% layout "./entity.liquid" %}\n{% block lead %}{{ page.label }}{% endblock %}\n{% block details %}{% properties title="Details" %}{% endblock %}\n');
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
    const server = await startServer({ productHome: home, appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    let owner: DatabaseOwner | undefined;
    try {
      const status = await fetch(`${server.url}/products/tracker/api/status`, { headers: { accept: 'application/json' } });
      expect(status.status).toBe(200);
      const body = (await status.json()) as { kinds?: { kind: string; count: number }[]; filled?: boolean };
      expect(body.kinds?.some((kind) => kind.kind === 'idea' && kind.count === 1)).toBe(true);
      expect(body.kinds?.some((kind) => kind.kind === 'task' && kind.count === 1)).toBe(true);
      expect(body.kinds?.filter((kind) => kind.kind.startsWith('code.'))).toEqual([]);

      const store = productStoreFolder(product, knowledgeRootOf(home));
      owner = await createDatabaseOwner({ store: storeDatabasePath(store) });
      const filled = await runFill({ product, database: owner, store, home, runId: 'tracker-only' });
      expect(filled.ok).toBe(true);
      if (!filled.ok) return;
      expect(filled.units).toEqual([]);

      const tables = await owner.run((tx) => tx.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
      ));
      const names = tables.rows.map((row) => row.table_name);
      for (const absent of ['repository', 'directory', 'file', 'gitlink', 'commit', 'signature', 'blob', 'path', 'language', 'touched', 'history', 'parent_position', 'authored', 'lifecycle', 'responsibility', 'work_span']) {
        expect({ table: absent, present: names.includes(absent) }).toEqual({ table: absent, present: false });
      }
      for (const present of ['entity', 'node', 'edge', 'context', 'layer_entry', 'operation', 'gap']) {
        expect({ table: present, present: names.includes(present) }).toEqual({ table: present, present: true });
      }

      const page = await fetch(`${server.url}/products/tracker/api/page?id=${encodeURIComponent('idea:one')}&full=1`, { headers: { accept: 'application/json' } });
      expect(page.status).toBe(200);
    } finally {
      await owner?.close();
      await server.stop();
    }
  }, 300_000);
});
