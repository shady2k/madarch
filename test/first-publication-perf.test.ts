import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedStarterSet } from '../src/knowledge/seed';
import { workingTreeFiles } from '../src/plugin/product-files';
import { createDatabaseOwner } from '../src/adapters/database-owner';
import { prepareStore } from '../src/adapters/prepare-store';
import { publicationContractOf } from '../src/graph/publication-contract';
import { publishValidatedManifests, validateProductManifests } from '../src/graph/manifest-publication';

const perf = process.env['MADARCH_SKIP_PERF'] === '1' ? test.skip : test;
perf('first everything publication including schema preparation takes at most 15 seconds on four CPUs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-first-publication-'));
  const folder = join(root, 'product');
  mkdirSync(folder);
  let owner: Awaited<ReturnType<typeof createDatabaseOwner>> | undefined;
  try {
    seedStarterSet(folder, 'everything');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', 'commit', '-qm', 'fixture']]) {
      const child = Bun.spawn(['git', '-C', folder, ...args], { stdout: 'inherit', stderr: 'inherit' });
      expect(await child.exited).toBe(0);
    }
    const validated = validateProductManifests(folder, workingTreeFiles(folder));
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    owner = await createDatabaseOwner({ store: join(root, 'store') });
    const start = performance.now();
    await prepareStore(owner, { contract: publicationContractOf(validated.value.manifest) });
    const written = await publishValidatedManifests(owner, validated.value);
    const elapsed = performance.now() - start;
    expect(written).toBeGreaterThan(0);
    expect(elapsed).toBeLessThanOrEqual(15_000);
  } finally {
    await owner?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
