import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { runFill } from '../src/fill/run.js';
import { GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { useFixturePlugins, useRepositoryPlugins } from './enabled-plugins-fixture.js';
import { repositoryContract, restrictRepositoryDeclarations } from './repository-contract-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';

test('disk JSON attribution closes the prior unknown opinion and replays without changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'language-publication-'));
  const repository = join(root, 'repo');
  const product = join(root, 'product');
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd }).toString().trim();
  const commit = (cwd: string, message: string): void => {
    git(cwd, 'add', '-A');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message);
  };
  const owner = await createTestDatabaseOwner({ graphContract: repositoryContract });
  try {
    mkdirSync(repository);
    git(repository, 'init', '-q');
    writeFileSync(join(repository, 'asset.map'), '{"broken":');
    writeFileSync(join(repository, 'unchanged.txt'), 'inventory stays\n');
    commit(repository, 'invalid JSON');
    mkdirSync(join(product, 'repos'), { recursive: true });
    symlinkSync(repository, join(product, 'repos', 'fixture'));
    writeFileSync(join(product, 'workspace.yaml'), `schemaVersion: 1
id: 8a1c6f2e-4f2b-4b8a-9f7e-1a2b3c4d5e6f
name: language-publication
repos:
  - name: fixture
    url: file://${repository}
`);
    useRepositoryPlugins(product);
    restrictRepositoryDeclarations(product);
    useFixturePlugins(product, ['disk']);
    git(product, 'init', '-q');
    commit(product, 'Declare repository plugins');
    let sequence = 0;
    const fill = async () => {
      const answer = await runFill({ product, database: owner, home: join(root, 'home'), runId: `language-${++sequence}`, prepareContract: async contract => { await prepareStore(owner, { contract }); } });
      if (!answer.ok) throw new Error(`fill refused: ${answer.reason}`);
      expect(answer.state).toBe('succeeded');
      return answer;
    };
    const opinions = () => owner.transaction('snapshot', async tx => (await tx.query<{ node_id: string; said_by: string; state: string; language: string; languages: string[] }>(
      `SELECT o.node_id::text, o.said_by, o.state, o.language, o.languages FROM ${GIT_TABLES.file} o JOIN node n ON n.id = o.node_id
       WHERE n.key->>'repository' = 'fixture' AND n.key->>'path' = 'asset.map' AND split_part(o.said_by, '@', 1) = 'disk' ORDER BY o.id`,
    )).rows);
    await fill();
    const before = await opinions();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ state: 'open', language: 'unknown', languages: ['unknown'] });
    writeFileSync(join(repository, 'asset.map'), '{}');
    commit(repository, 'valid JSON');
    const changed = await fill();
    expect(changed.units.some(unit => unit.unitId.split('#')[0] === 'plugin-turns/disk:code.file')).toBe(true);
    const after = await opinions();
    expect(after).toEqual([
      { ...before[0]!, state: 'closed' },
      { node_id: before[0]!.node_id, said_by: before[0]!.said_by, state: 'open', language: 'JSON', languages: ['JSON'] },
    ]);
    const inventory = await owner.transaction('snapshot', async tx => (await tx.query<{ path: string }>(
      `SELECT n.key->>'path' AS path FROM ${GIT_TABLES.file} o JOIN node n ON n.id = o.node_id
       WHERE n.key->>'repository' = 'fixture' AND o.state = 'open' AND split_part(o.said_by, '@', 1) = 'disk' ORDER BY path`,
    )).rows);
    expect(inventory).toEqual([{ path: 'asset.map' }, { path: 'unchanged.txt' }]);
    const countOpinions = () => owner.transaction('snapshot', async tx => (await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${GIT_TABLES.file}`)).rows);
    const count = await countOpinions();
    const replay = await fill();
    expect(replay.work).toBe(0);
    expect(await countOpinions()).toEqual(count);
    expect(await opinions()).toEqual(after);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
