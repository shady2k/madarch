import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { createRecordSchema } from '../src/graph/index.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { withStorePreparationOwner } from '../src/product/store-preparation.js';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { callRecordTool, isRecordTool } from '../src/mcp/records.js';
import { fixtureManifest } from './knowledge-manifest-fixture.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeProduct } from './knowledge-fixture.js';
import { RepositorySession } from '../src/mcp/session.js';

test('MCP kinds reads published declarations without a repository fill or checkout', async () => {
  const owner = await createTestDatabaseOwner({ btreeGist: true, graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await createRecordSchema(owner, EMPTY_CONTRACT);
    const manifest = fixtureManifest({ zebra: { dependsOn: ['alpha'] }, alpha: {} });
    // The publication payload uses the same explicit Map encoding as the validated publisher.
    const encode = (value: unknown): unknown => value instanceof Map
      ? { $map: [...value].map(([key, held]) => [key, encode(held)]) }
      : Array.isArray(value) ? value.map(encode)
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, held]) => [key, encode(held)])) : value;
    await publishValidatedManifests(owner, { folder: '/absent-product', manifest, templatePaths: [], vertices: [{ kind: 'manifest.catalogue', key: { name: 'product' }, values: { declaration: encode(manifest) }, producer: 'manifest', producerVersion: '1', evidence: [] }, { kind: 'manifest.dependency', key: { name: 'alpha-zebra' }, values: { declaration: { from: 'alpha', to: 'zebra', via: 'depends-on' } }, producer: 'manifest', producerVersion: '1', evidence: [] }] });
    expect(isRecordTool('kinds')).toBe(true);
    const result = await callRecordTool('kinds', {}, { owner, repository: 'sample', source: { repository: '/absent-product', commit: null, branch: null, head: null, changed: [] } });
    expect(result.isError).toBe(false);
    expect(result.answer.kinds).toEqual([
      { kind: 'alpha', fields: [], dependsOn: [] },
      { kind: 'zebra', fields: [], dependsOn: ['alpha'] },
    ]);
    expect(result.answer.relations).toEqual([]);
  } finally {
    await owner.close();
  }
});


test('a product MCP session publishes kinds without filling repository content', async () => await withStorePreparationOwner(async () => {
  const home = mkdtempSync(join(tmpdir(), 'madarch-mcp-kinds-'));
  let session: RepositorySession | undefined;
  try {
    const product = makeProduct(home, 'sample', home, 'sample-code');
    session = await RepositorySession.open({ repository: product, env: { ...process.env, MADARCH_HOME: join(home, 'state') } });
    const kinds = await session.call('kinds', {});
    expect(kinds.isError).toBe(false);
    expect((kinds.answer as { kinds: unknown[] }).kinds.length).toBeGreaterThan(0);
    expect(session.filledCommit).toBeNull();
    const files = await session.call('list_files', {});
    expect(files.isError).toBe(true);
    expect((files.answer as { error: { code: string } }).error.code).toBe('step-not-run');
    expect(session.filledCommit).toBeNull();
    const manifestFile = join(product, 'madarch', 'kinds.yaml');
    const valid = readFileSync(manifestFile, 'utf8');
    writeFileSync(manifestFile, `${valid}\n  invalid: [\n`);
    const invalid = await session.call('kinds', {});
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.answer)).toContain(manifestFile);
    writeFileSync(manifestFile, valid);
    const restored = await session.call('kinds', {});
    expect(restored.isError).toBe(false);
    expect((restored.answer as { kinds: unknown[] }).kinds).toEqual((kinds.answer as { kinds: unknown[] }).kinds);
  } finally {
    await session?.close();
    rmSync(home, { recursive: true, force: true });
  }
}), 60_000);
