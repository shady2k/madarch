import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { repoAddLife } from '../src/product/lifecycle.js';
import { runGit } from '../src/product/git.js';
import { daemonFills } from '../src/product/daemon-fills.js';
import { daemonUpdateWatch } from '../src/product/daemon.js';
import { readSeenHeads, seenKey } from '../src/product/fill-updates.js';
import { validateProductManifests } from '../src/graph/manifest-publication.js';
import { startServer } from '../src/server/http.js';
import { retainTestStorePreparationOwner } from './prepared-server.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

test('repo add with the server running advances only the baseline before the first Fill', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-before-fill-'));
  const home = join(root, 'products');
  const release = await retainTestStorePreparationOwner();
  const fills = daemonFills(home);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let watch: ReturnType<typeof daemonUpdateWatch> | undefined;
  try {
    const draft = createDraft({ home, name: 'shop', gitEnv: gitEnv(identity) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    const validated = validateProductManifests(draft.folder);
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    await fills.publishManifests(validated.value);
    const app = join(root, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'index.html'), '<!doctype html><title>Wiki</title>');
    server = await startServer({ productFolder: draft.folder, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
    watch = daemonUpdateWatch(home, fills, { debounceMs: 0, intervalMs: 0, enabled: () => true, log: () => undefined });
    await watch.outset();
    const code = join(root, 'library');
    mkdirSync(code);
    writeFileSync(join(code, 'index.ts'), 'export const price = 10;\n');
    for (const args of [['init', '-q', '--initial-branch=main'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Initial library']]) {
      const result = runGit(code, args);
      if (!result.ok) throw new Error(result.output);
    }
    Object.assign(process.env, identity);
    const added = repoAddLife({ name: 'library', source: code, mode: 'link', folder: draft.folder, cwd: draft.folder });
    expect(added.errors).toEqual([]);
    expect(added.exit).toBe(0);
    const pass = await watch.pass();
    expect(pass.asked).toEqual([]);
    expect(watch.pending()).toEqual([]);
    const head = runGit(draft.folder, ['rev-parse', 'HEAD']);
    expect(head.ok).toBe(true);
    if (!head.ok) throw new Error(head.output);
    expect(readSeenHeads(home)[seenKey('shop', 'shop')]?.commit).toBe(head.output);
    expect(await fills.progress(draft.folder)).toBeNull();
    const status = await fetch(`${server.url}/api/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ filled: false, manifest: 'not-filled', fill: { state: 'idle' } });
    const page = await fetch(`${server.url}/api/page?id=repository:shop`);
    expect(page.status).toBe(404);
    expect(await page.text()).not.toContain('structured template opinion');
    const owner = await createTestDatabaseOwner({ store: storeDatabasePath(productStoreFolder(draft.folder, knowledgeRootOf(home))), btreeGist: true });
    try {
      const rows = await owner.run((tx) => tx.query<{ name: string }>("SELECT DISTINCT k.name FROM node n JOIN entity k ON k.id = n.entity_id ORDER BY k.name"));
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((row) => row.name.startsWith('manifest.') || row.name === 'template')).toBe(true);
      expect(rows.rows.some((row) => row.name === 'template')).toBe(true);
    } finally { await owner.close(); }
    watch.stop();
    watch = daemonUpdateWatch(home, fills, { debounceMs: 0, intervalMs: 0, enabled: () => true, log: () => undefined });
    expect((await watch.outset()).asked).toEqual([]);
  } finally {
    watch?.stop();
    await server?.stop();
    await fills.stop();
    await release();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
