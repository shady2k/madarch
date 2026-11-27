import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
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
        { kind: 'code.file', key: { path: 'unrelated.txt' }, producer: 'fixture', producerVersion: '1' },
      ] });
      await publishGraphDrafts(tx, owner.graphContract, { vertices: [], removals: [{ kind: 'probe.fact', key: { id: 'ended' }, producer: 'fixture' }] });
    });
    const before = await owner.transaction('snapshot', async tx => (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM assertion')).rows[0]!.count);
    const page = await vanishedCurrentEvidence(owner, contract);
    expect(page.rows.filter(row => row.key['id'] === 'available').every(row => row.state.historicalValidity === 'valid' && row.state.availability === 'available')).toBe(true);
    expect(page.rows.some(row => row.key['id'] === 'ended')).toBe(false);
    expect(page.rows.filter(row => row.key['id'] === 'unavailable').length).toBeGreaterThan(0);
    expect(page.rows.filter(row => row.key['id'] === 'unavailable').every(row => row.applicability === 'unavailable')).toBe(true);
    const activeLinks = await owner.run(async tx => (await tx.query<{ cursor: string; opinion: string; fact: string }>(`
      SELECT (origin.uid::text || ':' || evidence.uid::text) COLLATE "C" AS cursor,
        origin.uid::text AS opinion, fact.key->>'id' AS fact
      FROM edge evidence JOIN entity kind ON kind.id=evidence.entity_id
      JOIN node origin ON origin.id=evidence.from_node JOIN assertion a ON a.assertion_id=origin.id
      JOIN assertion_vertex_subject attachment ON attachment.assertion_id=a.assertion_id
      JOIN edge subject ON subject.id=attachment.subject_edge_id JOIN node fact ON fact.id=subject.to_node
      WHERE kind.name='system.assertion-evidence' AND a.property IN ('$exists','title')
        AND fact.key->>'id' IN ('available','unavailable')
      ORDER BY cursor`)).rows);
    expect(activeLinks).toHaveLength(4);
    const seen: string[] = [];
    const cursors: string[] = [];
    const scans: string[] = [];
    const measuredOwner: DatabaseOwner = {
      ...owner,
      transaction: (kind, read) => owner.transaction(kind, tx => read({
        query: <Row extends object>(sql: string, parameters?: readonly unknown[]) => {
          if (sql.includes('property_rank') && parameters?.includes('code.file')) scans.push('code.file');
          return tx.query<Row>(sql, parameters);
        },
      })),
    };
    let after: string | undefined;
    do {
      const next = await vanishedCurrentEvidence(measuredOwner, evidenceContract, { limit: 1, ...(after === undefined ? {} : { after }) });
      seen.push(...next.rows.map(row => row.opinion));
      after = next.next;
      if (after !== undefined) cursors.push(after);
    } while (after !== undefined);
    expect(cursors).toEqual(activeLinks.slice(0, -1).map(link => link.cursor));
    expect(seen).toEqual(activeLinks.filter(link => link.fact === 'unavailable').map(link => link.opinion));
    expect(seen).toEqual(page.rows.map(row => row.opinion));
    expect(new Set(seen).size).toBe(seen.length);
    expect(scans).toEqual([]);
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
        vertices: [replacement], edges: [{ ...support, from: replacement, evidence: [{ target: unsupported }] }], edgeRemovals: [support], removals: [],
      });
    });

    const { rows } = await vanishedCurrentEvidence(owner, evidenceContract);
    const facts = rows.filter(row => row.kind === factKind.name);
    expect(new Set(facts.map(row => row.key['id']))).toEqual(new Set(['stale', 'unsupported']));
    for (const row of facts) {
      const stale = row.key['id'] === 'stale';
      expect(row).toMatchObject({
        evidence: { target: { kind: 'code.blob' } }, applicability: stale ? 'stale' : 'unavailable',
        state: { historicalValidity: 'valid', currentApplicability: stale ? 'stale' : 'unknown', availability: 'available' },
      });
    }
    expect(rows.filter(row => row.kind === support.kind)).toMatchObject([{
      key: { from: expect.any(Number), to: expect.any(Number), discriminator: '' },
      evidence: { target: { kind: 'code.blob', key: unsupported.key } },
      applicability: 'unavailable',
    }]);
  } finally { await owner.close(); }
});
