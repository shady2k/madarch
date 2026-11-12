import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProduct, commitProduct } from './knowledge-fixture.js';
import { runGit } from '../src/product/git.js';
import { ensureDaemon, stopDaemon } from '../src/product/daemon.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { withStorePreparationOwner } from '../src/product/store-preparation.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { MANIFEST_CONTRACT } from '../src/graph/manifest-contract.js';

const project = join(import.meta.dir, '..');
async function command(home: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, MADARCH_HOME: home, MADARCH_OWN_WIKI: 'off' };
  delete env.MADARCH_STORE_OWNER_URL;
  delete env.MADARCH_STORE_OWNER_TOKEN;
  const child = Bun.spawn([process.execPath, 'scripts/madarch.ts', ...args, '--home', home], { cwd: project, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, error, code };
}

for (const running of [false, true]) test(`reset starts a filled fixture over ${running ? 'through its running server' : 'without a running server'}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-product-reset-'));
  const home = join(root, 'products');
  let started = false;
  try {
    const repository = join(root, 'repository'); mkdirSync(repository); mkdirSync(home);
    writeFileSync(join(repository, 'item.txt'), 'fixture item\n');
    for (const args of [['init', '--quiet', '--initial-branch=main'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'Fixture']]) {
      const answer = runGit(repository, args); if (!answer.ok) throw new Error(answer.output);
    }
    const folder = makeProduct(home, 'sample', repository, 'source');
    commitProduct(folder, 'Link fixture source');
    const filled = await command(home, 'fill-stages', '--product', folder, '--steps', 'repository-tree,repository-history', '--json');
    expect(filled.code, JSON.stringify(filled)).toBe(0);
    expect(JSON.parse(filled.out.trim().split('\n').at(-1)!).state).toBe('succeeded');
    const filledOwner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, knowledgeRootOf(home))) });
    try {
      await filledOwner.ready;
      const rows = await filledOwner.run((tx) => tx.query<{ count: string }>("SELECT count(*) FROM node n JOIN entity e ON e.id=n.entity_id WHERE NOT n.removed AND e.name NOT LIKE 'manifest.%'"));
      expect(Number(rows.rows[0]!.count)).toBeGreaterThan(0);
    } finally { await filledOwner.close(); }
    const app = join(root, 'app'); mkdirSync(join(app, 'dist'), { recursive: true }); writeFileSync(join(app, 'dist', 'index.html'), '<html>Fixture</html>');
    if (running) {
      const daemon = await ensureDaemon({ home, port: 0, appFolder: app, env: { ...process.env, MADARCH_OWN_WIKI: 'off' }, print: () => {} });
      expect(daemon.ok, JSON.stringify(daemon)).toBe(true);
      if (!daemon.ok) return;
      started = true;
      const readyBy = Date.now() + 15_000;
      let preview: Response;
      do {
        preview = await fetch(`${daemon.url}/products/sample/api/reset`);
        if (preview.status !== 503) break;
        await Bun.sleep(25);
      } while (Date.now() < readyBy);
      expect(preview.status).toBe(200);
      const reset = await command(home, 'reset', 'sample', '--yes');
      expect(reset.code, JSON.stringify(reset)).toBe(0);
      expect(reset.out).toContain('Starting sample over removes:');
      expect(reset.out).toContain('Done.');
      const after = await (await fetch(`${daemon.url}/products/sample/api/status`)).json();
      expect(after.manifest).toBe('not-filled');
      expect(after.fill.state).toBe('idle');
    } else {
      const reset = await command(home, 'reset', 'sample', '--yes');
      expect(reset.code, JSON.stringify(reset)).toBe(0);
      expect(reset.out).toContain('Starting sample over removes:');
      expect(reset.out).toContain('Done.');
      await withStorePreparationOwner(async () => {
        const product = new KnowledgeProduct({ productFolder: folder, storeRoot: knowledgeRootOf(home) });
        try {
          const after = await product.status();
          expect(after.manifest).toBe('not-filled');
          expect(after.fill.state).toBe('idle');
        } finally { await product.close(); }
      });
    }
    const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, knowledgeRootOf(home))) });
    try {
      await owner.ready;
      const kinds = await owner.run((tx) => tx.query<{ entity: string }>('SELECT DISTINCT e.name AS entity FROM node n JOIN entity e ON e.id=n.entity_id WHERE NOT n.removed ORDER BY entity'));
      expect(kinds.rows.map((row) => row.entity)).toContain('manifest.catalogue');
      expect(kinds.rows.every((row) => MANIFEST_CONTRACT.vertex.some((kind) => kind.name === row.entity))).toBe(true);
    } finally { await owner.close(); }
  } finally {
    if (started) expect(stopDaemon({ home })).toBe(0);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
