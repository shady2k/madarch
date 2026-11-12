/** A real fill publishes quarantine pages and replaces them after a committed repair. */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { createDraft } from '../src/product/draft.js';
import { manifestWithRepo } from '../src/product/manifest.js';
import { gitEnv } from './git-env.js';
import { withStorePreparationOwner } from '../src/product/store-preparation.js';
import { productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { createTestDatabaseOwner } from './test-database.js';
import { publishFixtureTemplate } from './structured-template-fixture.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const CLI = join(import.meta.dir, '..', 'scripts', 'madarch.ts');

function git(folder: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: folder, env: gitEnv(IDENTITY), encoding: 'utf8' }).trim();
}

function commit(folder: string, message: string): void {
  git(folder, 'add', '-A');
  git(folder, 'commit', '--quiet', '-m', message);
}

describe('test quarantine through a real fill', () => {
  test('the catalogue and rendered page gain a quarantine, then lose it after a committed repair', async () => await withStorePreparationOwner(async () => {
    const work = mkdtempSync(join(tmpdir(), 'madarch-quarantine-fill-'));
    const previousSandbox = process.env['MADARCH_PLUGIN_SANDBOX'];
    process.env['MADARCH_PLUGIN_SANDBOX'] = 'off';
    try {
      const home = join(work, 'home');
      const draft = createDraft({ home, name: 'quarantine-shop', gitEnv: gitEnv(IDENTITY), template: 'quarantine-fixture', templates: [{
        id: 'quarantine-fixture', title: { en: 'Quarantine', ru: 'Карантин' }, description: { en: 'Fixture', ru: 'Fixture' },
        kinds: ['code.repository', 'code.directory', 'code.file', 'code.test-case', 'code.commit', 'task', 'code.test-quarantine', 'template'],
      }] });
      if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
      const folder = draft.folder;
      const repository = join(folder, 'repos', 'app');
      mkdirSync(join(repository, 'test'), { recursive: true });
      git(repository, 'init', '--quiet', '--initial-branch=main');
      writeFileSync(join(repository, 'README.md'), '# App\n');
      commit(repository, 'Initial application');
      const since = git(repository, 'rev-parse', 'HEAD');
      const name = 'retries a payment';
      const task = 'madarch-fixture.1';
      const reason = 'flaky';
      const file = join(repository, 'test', 'payment.test.ts');
      writeFileSync(file, `quarantined('${task}', test, '${reason}', '${since}')('${name}', () => {});\n`);
      commit(repository, 'Quarantine the payment test');
      const manifest = join(folder, 'workspace.yaml');
      writeFileSync(manifest, manifestWithRepo(readFileSync(manifest, 'utf8'), { name: 'app', linked: true }));
      commit(folder, 'Link the application');

      async function fill(): Promise<void> {
        const answer = Bun.spawn([process.execPath, CLI, 'fill', '--product', folder, '--home', home, '--entity', 'code.test-quarantine'], {
          env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(answer.stdout).text(), new Response(answer.stderr).text(), answer.exited]);
        if (exitCode !== 0) throw new Error(`fill failed (${exitCode}): ${stdout}\n${stderr}`);
      }
      function reader(): KnowledgeProduct {
        return new KnowledgeProduct({ productFolder: folder, storeRoot: join(home, '.madarch', 'knowledge') });
      }

      await fill();
      const owner = await createTestDatabaseOwner({
        store: storeDatabasePath(productStoreFolder(folder, join(home, '.madarch', 'knowledge'))),
        graphContract: withManifestContract(await readPinnedGraphContract(folder)),
      });
      try { await publishFixtureTemplate(owner, folder, 'templates/test-quarantine.liquid'); }
      finally { await owner.close(); }
      let pageId: string;
      const first = reader();
      try {
        expect((await first.catalog()).kinds.find(kind => kind.kind === 'code.test-quarantine')?.count).toBe(1);
        const listed = await first.list('code.test-quarantine', { limit: 10 });
        expect(listed?.rows).toHaveLength(1);
        pageId = listed!.rows[0]!.id;
        const rendered = await first.page(pageId, 'en');
        if (!rendered.ok) throw new Error(JSON.stringify(rendered));
        expect(rendered.ok).toBe(true);
        const properties = rendered.page.blocks.find(block => block.type === 'properties');
        expect(properties).toBeDefined();
        const visible = JSON.stringify(properties);
        for (const value of [name, task, reason, since]) expect(visible).toContain(value);
      } finally { await first.close(); }

      writeFileSync(file, `test('${name}', () => {});\n`);
      commit(repository, 'Repair the payment test and remove quarantine');
      await fill();
      const second = reader();
      try {
        expect((await second.catalog()).kinds.find(kind => kind.kind === 'code.test-quarantine')?.count).toBe(0);
        expect((await second.list('code.test-quarantine', { limit: 10 }))?.rows).toEqual([]);
        expect(await second.page(pageId!, 'en')).toMatchObject({ ok: false, status: 404 });
      } finally { await second.close(); }
    } finally {
      if (previousSandbox === undefined) delete process.env['MADARCH_PLUGIN_SANDBOX'];
      else process.env['MADARCH_PLUGIN_SANDBOX'] = previousSandbox;
      rmSync(work, { recursive: true, force: true });
    }
  }), 900_000);
});
