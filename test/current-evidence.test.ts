import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { generatedTableName, type GraphContract, type VertexContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { vanishedCurrentEvidence } from '../src/graph/index.js';
import { sha256Hex } from '../src/graph/digest.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import type { KindsManifest } from '../src/product/manifest/kinds.js';

const factKind: VertexContract = {
  name: 'probe.fact', table: generatedTableName('probe.fact', 'vertex'), key: ['id'], capability: 'fixture',
  fields: [{ name: 'id', type: 'text' }, { name: 'title', type: 'text' }],
};
const contract: GraphContract = {
  vertex: [
    { name: 'retained', table: generatedTableName('retained', 'vertex'), key: ['digest'], capability: 'fixture',
      fields: [{ name: 'digest', type: 'text' }, { name: 'body', type: 'text' }],
      evidence: { immutable: true, digestField: 'digest', contentField: 'body', digestAlgorithm: 'sha256' } },
    factKind,
  ], edge: [], dictionary: [],
};
const evidenceContract: GraphContract = {
  vertex: [
    ...contract.vertex,
    { name: 'code.file', table: generatedTableName('code.file', 'vertex'), key: ['path'], capability: 'fixture',
      fields: [{ name: 'path', type: 'text' }] },
    { name: 'code.blob', table: generatedTableName('code.blob', 'vertex'), key: ['digest'], capability: 'fixture',
      fields: [{ name: 'digest', type: 'text' }, { name: 'content', type: 'text' }],
      evidence: { immutable: true, digestField: 'digest', contentField: 'content', digestAlgorithm: 'sha256' } },
  ],
  edge: [{ name: 'code.blob-about', from: ['code.blob'], to: ['code.file'], cardinality: { from: 'many', to: 'many' },
    labels: { en: { out: 'about', in: 'has blob' }, ru: { out: 'о файле', in: 'снимок' } },
    fields: [], repeats: false, capability: 'fixture' }],
  dictionary: [],
};
const storeContract = withManifestContract(evidenceContract);

test('current evidence reports unavailable retained bytes without rewriting history or reporting ended assertions', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: storeContract });
  const digest = sha256Hex(Buffer.from('retained bytes'));
  const missing = sha256Hex(Buffer.from('unavailable bytes'));
  const evidence = (value: string) => [{ target: { kind: 'retained', key: { digest: value } } }];
  const fact = (id: string, value: string) => ({ kind: 'probe.fact', key: { id }, values: { title: id }, evidence: evidence(value), producer: 'fixture', producerVersion: '1' });
  try {
    await owner.transaction('write', async tx => {
      await publishGraphDrafts(tx, owner.graphContract, { removals: [], vertices: [
        { kind: 'retained', key: { digest }, values: { body: 'retained bytes' }, producer: 'fixture', producerVersion: '1' },
        { kind: 'retained', key: { digest: missing }, producer: 'fixture', producerVersion: '1' },
        fact('available', digest), fact('unavailable', missing), fact('ended', missing),
      ] });
      await publishGraphDrafts(tx, owner.graphContract, { vertices: [], removals: [{ kind: 'probe.fact', key: { id: 'ended' }, producer: 'fixture' }] });
    });
    const before = await owner.transaction('snapshot', async tx => (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM assertion')).rows[0]!.count);
    const page = await vanishedCurrentEvidence(owner, contract);
    expect(page.rows.filter(row => row.key['id'] === 'available').every(row => row.state.historicalValidity === 'valid' && row.state.availability === 'available')).toBe(true);
    expect(page.rows.some(row => row.key['id'] === 'ended')).toBe(false);
    expect(page.rows.filter(row => row.key['id'] === 'unavailable').length).toBeGreaterThan(0);
    expect(page.rows.filter(row => row.key['id'] === 'unavailable').every(row => row.applicability === 'unavailable')).toBe(true);
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const next = await vanishedCurrentEvidence(owner, contract, { limit: 1, ...(after === undefined ? {} : { after }) });
      seen.push(...next.rows.map(row => row.opinion));
      after = next.next;
    } while (after !== undefined);
    expect(seen).toEqual(page.rows.map(row => row.opinion));
    expect(new Set(seen).size).toBe(seen.length);
    expect(await owner.transaction('snapshot', async tx => (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM assertion')).rows[0]!.count)).toBe(before);
  } finally { await owner.close(); }
}, 30_000);

test('current evidence reports stale and unsupported blobs while accepting retained catalogue snapshots', async () => {
  const manifest: KindsManifest = {
    file: '/fixture/madarch/catalog.yaml', roles: new Map(), properties: new Map(), kinds: new Map(), groups: new Map(),
    excludeDocuments: [], ignoreBlocks: [], findings: [],
    semanticBindings: new Map([['evidence-support', {
      kind: 'code.blob', fields: {}, edges: { about: { kind: 'code.blob-about', direction: 'from', line: 1 } }, line: 1,
    }]]),
  };
  const declaration = JSON.stringify(manifest, (_key, value) => value instanceof Map ? { $map: [...value] } : value);
  const producer = { producer: 'fixture', producerVersion: '1' };
  const retained = (kind: 'code.blob' | 'system.content-snapshot', content: string) => ({
    kind, key: { digest: sha256Hex(Buffer.from(content)) }, values: { content }, ...producer,
  });
  const file = { kind: 'code.file', key: { path: 'sample.txt' }, ...producer };
  const snapshot = retained('system.content-snapshot', 'catalogue bytes');
  const original = retained('code.blob', 'original bytes');
  const unsupported = retained('code.blob', 'unsupported bytes');
  const replacement = retained('code.blob', 'replacement bytes');
  const support = { kind: 'code.blob-about', from: original, to: file, ...producer };
  const fact = (id: string, target: ReturnType<typeof retained>) => ({
    kind: factKind.name, key: { id }, values: { title: id }, evidence: [{ target }], ...producer,
  });
  const owner = await createTestDatabaseOwner({ graphContract: storeContract });
  try {
    await owner.transaction('write', async tx => {
      await publishGraphDrafts(tx, owner.graphContract, {
        vertices: [
          { kind: 'manifest.catalogue', key: { name: 'product' }, values: { declaration }, ...producer },
          file, snapshot, original, unsupported,
          fact('snapshot', snapshot), fact('stale', original), fact('unsupported', unsupported),
        ], edges: [support], removals: [],
      });
      await publishGraphDrafts(tx, owner.graphContract, {
        vertices: [replacement], edges: [{ ...support, from: replacement }], edgeRemovals: [support], removals: [],
      });
    });

    const { rows } = await vanishedCurrentEvidence(owner, evidenceContract);
    expect(new Set(rows.map(row => row.key['id']))).toEqual(new Set(['stale', 'unsupported']));
    for (const row of rows) {
      const stale = row.key['id'] === 'stale';
      expect(row).toMatchObject({
        evidence: { target: { kind: 'code.blob' } }, applicability: stale ? 'stale' : 'unavailable',
        state: { historicalValidity: 'valid', currentApplicability: stale ? 'stale' : 'unknown', availability: 'available' },
      });
    }
  } finally { await owner.close(); }
});
