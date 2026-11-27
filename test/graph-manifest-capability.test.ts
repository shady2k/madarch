/**
 * The manifest's own kinds are declarations, not repository content: the one writer states an assertion or a
 * retraction of a kind whose declared capability is reserved only for the source that serves it, and the manifest
 * publication is that source.
 *
 * The source is authenticated by its binding, never by a draft's label, so these cases take the grants a plugin and a
 * host source are given and show the writer refusing each of them: a binding that holds no manifest kind still cannot
 * state one, and a label naming the publication changes nothing.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { publishValidatedManifests, startupBinding, validateProductManifests, type ValidatedManifests } from '../src/graph/manifest-publication.js';
import { activateGraphProducer } from '../src/graph/producer-binding.js';
import { readKindAssertions } from '../src/graph/records.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { testHostBinding } from './host-binding-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-manifest-capability-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const contract = withManifestContract(EMPTY_CONTRACT);

/** A product whose catalogue declares two kinds and one relation between a kind and a protected endpoint. */
function manifold(): string {
  const folder = mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'madarch'));
  writeFolderManifest(folder, `kinds:
  term:
    source: document
    terms: ["docs/*.md"]
  topic:
    source: document
    terms: ["docs/*.md"]
    relations:
      - type: mentions
        to: system.product:{name}
`);
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '--allow-empty', '-qm', 'fixture']);
  return folder;
}

function validated(folder: string): ValidatedManifests {
  const read = validateProductManifests(folder);
  if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
  return read.value;
}

/** A store holding the product's catalogue, published by the manifest source alone. */
async function publishedProduct() {
  const folder = manifold();
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  await publishValidatedManifests(owner, validated(folder));
  return { folder, owner };
}

/** The kinds the store's catalogue states, by name. */
async function declaredKinds(owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>): Promise<string[]> {
  return (await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration']))).map(row => String(row.key['name']));
}

const ROGUE_KIND = {
  kind: 'manifest.kind', key: { name: 'rogue.kind' }, values: { declaration: '{}' },
  producer: 'foreign-host', producerVersion: '1',
};
const ROGUE_EDGE = {
  kind: 'manifest.relation-edge',
  from: { kind: 'manifest.kind', key: { name: 'topic' } }, to: { kind: 'manifest.kind', key: { name: 'system.product' } },
  discriminator: 'mentions', values: { relation: 'mentions', declaration: '{}' },
  producer: 'foreign-host', producerVersion: '1',
};

test('the manifest publication states and retires its own kinds', async () => {
  const { folder, owner } = await publishedProduct();
  try {
    expect(await declaredKinds(owner)).toContain('topic');
    // A declaration the product stops making is retired by the same source that stated it.
    writeFolderManifest(folder, `kinds:
  term:
    source: document
    terms: ["docs/*.md"]
`);
    expect(await publishValidatedManifests(owner, validated(folder))).toBeGreaterThan(0);
    expect(await declaredKinds(owner)).not.toContain('topic');
  } finally { await owner.close(); }
}, 60_000);

test('a host source that is not the manifest publication states and retires no manifest kind', async () => {
  const { owner } = await publishedProduct();
  try {
    const asForeign = async (drafts: Parameters<typeof publishGraphDrafts>[2]) => await owner.transaction('write', async tx => {
      const { contract: installed } = await startupBinding(tx, contract, 'foreign-host');
      await publishGraphDrafts(tx, installed, drafts);
    });
    await expect(asForeign({ vertices: [ROGUE_KIND], removals: [] }))
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.kind declares the reserved capability manifest; source [0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12} carries foreign-host/u);
    await expect(asForeign({ vertices: [], edges: [ROGUE_EDGE], removals: [] }))
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.relation-edge declares the reserved capability manifest; source [0-9a-f-]{8}-/u);
    await expect(asForeign({ vertices: [], removals: [{ kind: 'manifest.catalogue', key: { name: 'product' }, producer: 'foreign-host' }] }))
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.catalogue declares the reserved capability manifest; source [0-9a-f-]{8}-/u);
    expect(await declaredKinds(owner)).toContain('topic');
  } finally { await owner.close(); }
}, 60_000);

test('a plugin binding states and retires no manifest kind', async () => {
  const { owner } = await publishedProduct();
  try {
    const granted = await testHostBinding(owner, contract, 'catalogue-plugin');
    const asPlugin = async (drafts: Parameters<typeof publishGraphDrafts>[2]) => await owner.transaction('write', async tx => {
      await activateGraphProducer(tx, contract, granted);
      await publishGraphDrafts(tx, contract, drafts);
    });
    await expect(asPlugin({ vertices: [ROGUE_KIND], removals: [] }))
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.kind declares the reserved capability manifest; source [0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12} carries catalogue-plugin/u);
    await expect(asPlugin({ vertices: [], removals: [{ kind: 'manifest.kind', key: { name: 'topic' }, producer: 'catalogue-plugin' }] }))
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.kind declares the reserved capability manifest; source [0-9a-f-]{8}-/u);
    expect(await declaredKinds(owner)).toContain('topic');
  } finally { await owner.close(); }
}, 60_000);
