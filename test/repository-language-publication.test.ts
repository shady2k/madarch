import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStore } from '../src/adapters/prepare-store.js';
import { runFill } from '../src/fill/run.js';
import { GIT_KINDS } from '../src/fill/stages/git-contract.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { readKindAssertions } from '../src/graph/records.js';
import { useFixturePlugins, useRepositoryPlugins } from './enabled-plugins-fixture.js';
import { repositoryContract, restrictRepositoryDeclarations } from './repository-contract-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';

test('disk JSON attribution retains unknown assertion history and replays without changes', async () => {
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
    useFixturePlugins(product, ['disk']);
    restrictRepositoryDeclarations(product);
    git(product, 'init', '-q');
    commit(product, 'Declare repository plugins');
    let sequence = 0;
    const fill = async () => {
      const answer = await runFill({ product, database: owner, home: join(root, 'home'), runId: `language-${++sequence}`, prepareContract: async contract => { await prepareStore(owner, { contract }); } });
      if (!answer.ok) throw new Error(`fill refused: ${answer.reason}`);
      if (answer.state !== 'succeeded') throw new Error(`fill failed: ${JSON.stringify(answer)}`);
      return answer;
    };
    const opinions = () => owner.run(async tx => {
      const files = await tx.query<{ id: number }>(`SELECT n.id FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name=$1 AND n.key->>'path'='asset.map'`, [GIT_KINDS.file]);
      return await loadAssertions(tx, 'vertex', GIT_KINDS.file, ['language', 'languages'], files.rows.map(row => Number(row.id)));
    });
    await fill();
    const before = await opinions();
    expect(before.map(row => [row.property, row.value])).toEqual([['language', 'unknown'], ['languages', ['unknown']]]);
    writeFileSync(join(repository, 'asset.map'), '{}');
    commit(repository, 'valid JSON');
    const changed = await fill();
    expect(changed.units.some(unit => unit.unitId.split('#')[0] === 'plugin-turns/disk:code.file')).toBe(true);
    const after = await opinions();
    expect(after.filter(row => before.some(old => old.id === row.id))).toEqual(before);
    expect(after.filter(row => !before.some(old => old.id === row.id)).map(row => [row.property, row.value])).toEqual([['language', 'JSON'], ['languages', ['JSON']]]);
    expect(new Set(after.map(row => row.source))).toEqual(new Set(before.map(row => row.source)));
    const inventory = await owner.run(tx => readKindAssertions(tx, 'vertex', GIT_KINDS.file, ['language', 'languages']));
    expect(inventory.map(row => row.key['path']).sort()).toEqual(['asset.map', 'unchanged.txt']);
    expect(inventory.find(row => row.key['path'] === 'asset.map')?.values).toMatchObject({ language: 'JSON', languages: ['JSON'] });
    const countOpinions = () => owner.run(async tx => (await tx.query<{ n: number }>('SELECT count(*)::integer AS n FROM assertion')).rows);
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
