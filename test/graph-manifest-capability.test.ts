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
import { MANIFEST_DEPENDS_ON, MANIFEST_RELATION_EDGE, withManifestContract } from '../src/graph/manifest-contract.js';
import { publishValidatedManifests, startupBinding, validateProductManifests, type ValidatedManifests } from '../src/graph/manifest-publication.js';
import { activateGraphProducer } from '../src/graph/producer-binding.js';
import { readKindAssertions } from '../src/graph/records.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { pluginTurnAuthority, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import { parsePluginManifest } from '../src/plugin/closure.js';
import type { PluginLockEntry } from '../src/plugin/lock.js';
import type { KindsManifest, PluginContract } from '../src/product/manifest/kinds.js';
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
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.kind declares the reserved capability manifest; source [0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{12} carries no capability/u);
    await expect(asForeign({ vertices: [], edges: [ROGUE_EDGE], removals: [] }))
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.relation-edge declares the reserved capability manifest; source [0-9a-f-]{8}-/u);
    await expect(asForeign({ vertices: [], removals: [{ kind: 'manifest.catalogue', key: { name: 'product' }, producer: 'foreign-host' }] }))
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.catalogue declares the reserved capability manifest; source [0-9a-f-]{8}-/u);
    expect(await declaredKinds(owner)).toContain('topic');
  } finally { await owner.close(); }
}, 60_000);

/**
 * The fill's own binding path for a plugin the catalogue names `manifest`: its turn's authority comes from the selected
 * declaration and the plugin's own contract, and that contract names the catalogue's edges.
 */
function manifestNamedPlugin(owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>): PluginTurnWiring {
  const text = JSON.stringify({ version: '1.0.0', entry: 'index.ts', runtime: { name: 'bun', version: Bun.version },
    name: 'manifest', produces: [{ kind: 'topic', fields: '*' }] }, null, 2);
  const declaration = parsePluginManifest(text, '/fixture/madarch/manifest/plugin.json');
  const contract = {
    id: 'manifest', version: '1.0.0', reads: 'unit', file: '/fixture/madarch/manifest/contract.json', vertices: [],
    edges: [MANIFEST_RELATION_EDGE, MANIFEST_DEPENDS_ON].map(kind => ({
      kind, from: 'manifest.kind', to: 'manifest.kind', cardinality: { from: 'many', to: 'many' },
      labels: { en: { out: 'relates to', in: 'related from' }, ru: { out: 'связан с', in: 'связан от' } },
      fields: [{ name: 'relation', type: 'text' }, { name: 'declaration', type: 'text' }],
    })),
  } as unknown as PluginContract;
  const manifest = {
    file: '/fixture/madarch/catalog.yaml',
    kinds: new Map([['topic', { name: 'topic', fields: [{ name: 'title', type: 'text' }], derivesFrom: [], file: '/fixture/madarch/catalog.yaml', line: 4 }]]),
    plugins: new Map([['manifest', { id: 'manifest', declaration, declarationFile: '/fixture/madarch/manifest/plugin.json', declarationText: text, contract }]]),
  } as unknown as KindsManifest;
  const locks = new Map<string, PluginLockEntry>([['manifest', { id: 'manifest', version: '1.0.0', closure: 'a'.repeat(64), path: 'madarch/manifest', line: 1 }]]);
  return { owner, contract: withManifestContract(EMPTY_CONTRACT), manifest, locks, productFolder: '/fixture' } as unknown as PluginTurnWiring;
}

test('a plugin the catalogue names manifest states and retires no manifest kind through the fill binding', async () => {
  const { owner } = await publishedProduct();
  try {
    const authority = pluginTurnAuthority(manifestNamedPlugin(owner), 'manifest:topic');
    if (authority === undefined) throw new Error('a declared plugin turn requires authority');
    const asNamedPlugin = async (drafts: Parameters<typeof publishGraphDrafts>[2]) => await owner.transaction('write', async tx => {
      const installed = await startupBinding(tx, contract, authority.sourceName, authority.permissions);
      await publishGraphDrafts(tx, installed.contract, drafts);
    });
    // The plugin's own contract grants its edges, and the identifier it is installed under is the reserved capability's name.
    const rogueEdge = { kind: MANIFEST_RELATION_EDGE,
      from: { kind: 'manifest.kind', key: { name: 'topic' } }, to: { kind: 'manifest.kind', key: { name: 'system.product' } },
      discriminator: 'rogue', values: { relation: 'rogue', declaration: '{}' }, producer: 'manifest', producerVersion: '1' };
    await expect(asNamedPlugin({ vertices: [], edges: [rogueEdge], removals: [] }))
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.relation-edge declares the reserved capability manifest; source [0-9a-f-]{8}-/u);
    await expect(asNamedPlugin({ vertices: [], edges: [rogueEdge], removals: [], edgeRemovals: [{ kind: MANIFEST_RELATION_EDGE,
      from: { kind: 'manifest.kind', key: { name: 'topic' } }, to: { kind: 'manifest.kind', key: { name: 'system.product' } },
      discriminator: 'mentions', producer: 'manifest' }] }))
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.relation-edge declares the reserved capability manifest; source [0-9a-f-]{8}-/u);
    await expect(asNamedPlugin({ vertices: [ROGUE_KIND], removals: [] }))
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.kind declares the reserved capability manifest; source [0-9a-f-]{8}-/u);
    await expect(asNamedPlugin({ vertices: [], removals: [{ kind: 'manifest.kind', key: { name: 'topic' }, producer: 'manifest' }] }))
      .rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.kind declares the reserved capability manifest; source [0-9a-f-]{8}-/u);
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

test('a plugin installed under the name manifest holds no manifest kind as a grant', async () => {
  const { owner } = await publishedProduct();
  try {
    // The installation's identifier is the reserved capability's name, and the grant is still the plugin's own kinds.
    const granted = await testHostBinding(owner, contract, 'manifest');
    const asNamedPlugin = async (drafts: Parameters<typeof publishGraphDrafts>[2]) => await owner.transaction('write', async tx => {
      await activateGraphProducer(tx, contract, granted);
      await publishGraphDrafts(tx, contract, drafts);
    });
    await expect(asNamedPlugin({ vertices: [ROGUE_KIND], removals: [] }))
      .rejects.toThrow(/FORBIDDEN_SOURCE: manifest\.kind\.\$exists/u);
    await expect(asNamedPlugin({ vertices: [], edges: [ROGUE_EDGE], removals: [] }))
      .rejects.toThrow(/FORBIDDEN_SOURCE: manifest\.relation-edge\.\$exists/u);
    expect(await declaredKinds(owner)).toContain('topic');
  } finally { await owner.close(); }
}, 60_000);
