import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProduct, commitProduct } from './knowledge-fixture.js';
import { readPinnedPluginInstallations } from '../src/product/preparation-contract.js';

test('startup installations include every approved lock entry and ignore uncommitted versions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-pinned-installs-'));
  try {
    const home = join(root, 'home'); mkdirSync(home);
    const repository = join(root, 'repo'); mkdirSync(repository);
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture repository']);
    const folder = makeProduct(home, 'installations', repository);
    mkdirSync(join(folder, 'madarch'), { recursive: true });
    const lock = (version: string) => `plugins:\n  - id: idle\n    version: ${version}\n    path: plugins/idle\n    closure: ${'a'.repeat(64)}\n`;
    writeFileSync(join(folder, 'madarch/plugins.lock'), lock('1.0.0'));
    commitProduct(folder, 'Approve an idle installed plugin');
    writeFileSync(join(folder, 'madarch/plugins.lock'), lock('9.0.0'));
    expect(await readPinnedPluginInstallations(folder)).toEqual([{ id: 'idle', version: '1.0.0' }]);
    const draft = join(root, 'draft'); mkdirSync(draft);
    expect(await readPinnedPluginInstallations(draft)).toEqual([]);
    mkdirSync(join(draft, 'madarch'));
    writeFileSync(join(draft, 'madarch/plugins.lock'), lock('1.0.0'));
    await expect(readPinnedPluginInstallations(draft)).rejects.toThrow(`${draft}/madarch/plugins.lock:1`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
