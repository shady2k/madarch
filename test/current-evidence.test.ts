import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createTestDatabaseOwner } from './test-database.js';
import { generatedTableName, type GraphContract, type VertexContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { vanishedCurrentEvidence } from '../src/graph/index.js';
import { sha256Hex } from '../src/graph/digest.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import type { KindsManifest } from '../src/product/manifest/kinds.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { collectProblems } from '../src/problems/index.js';
import { defaultSettings } from '../src/problems/types.js';
import { workingTreeFiles } from '../src/plugin/product-files.js';
import { STARTER_PROBLEM_RULES } from './catalog-data-fixture.js';

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
const identityContract: GraphContract = {
  vertex: [...contract.vertex,
    { name: 'code.commit', table: generatedTableName('code.commit', 'vertex'), key: ['hash'], capability: 'fixture',
      fields: [{ name: 'hash', type: 'text' }],
      evidence: { immutable: true, digestField: 'hash' } },
  ], edge: [], dictionary: [],
};

test('current evidence accepts a live identity target and the writer protects it from retirement', async () => {
  const hash = 'a'.repeat(40);
  const producer = { producer: 'fixture', producerVersion: '1' };
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(identityContract) });
  try {
    await owner.transaction('write', async tx => {
      await publishGraphDrafts(tx, owner.graphContract, { removals: [], vertices: [
        { kind: 'code.commit', key: { hash }, ...producer },
        { kind: 'probe.fact', key: { id: 'live' }, values: { title: 'live' }, evidence: [{ target: { kind: 'code.commit', key: { hash } } }], ...producer },
      ] });
    });
    expect((await vanishedCurrentEvidence(owner, identityContract)).rows).toEqual([]);
    const retired = await owner.transaction('write', async tx => {
      await publishGraphDrafts(tx, owner.graphContract, { vertices: [], removals: [{ kind: 'code.commit', key: { hash }, ...producer }] });
    }).then(() => undefined, (error: unknown) => String(error));
    expect(retired).toContain('IMMUTABLE_EVIDENCE immutable support cannot be retired');
  } finally { await owner.close(); }
}, 30_000);

test('the Problems collector counts a current evidence dismissal after the rule is disabled or removed', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: storeContract });
  const producer = { producer: 'fixture', producerVersion: '1' };
  const retained = { kind: 'retained', key: { digest: sha256Hex(Buffer.from('unavailable bytes')) }, ...producer };
  const fact = { kind: factKind.name, key: { id: 'sample' }, values: { title: 'Sample' }, evidence: [{ target: retained }], ...producer };
  const manifest: KindsManifest = {
    file: '/fixture/madarch/catalog.yaml', roles: new Map(), properties: new Map(), groups: new Map(),
    kinds: new Map(contract.vertex.map(kind => [kind.name, { ...kind, source: 'graph' as const, title: kind.key[0]!, relations: [], line: 1 }])),
    excludeDocuments: [], ignoreBlocks: [], findings: [],
    semanticBindings: new Map([['problem-task', {
      kind: 'fixture.task', line: 1, fields: { title: 'title', description: 'description', status: 'status', tracker: 'tracker', key: 'key' },
      edges: { problems: { kind: 'fixture.task-problem', direction: 'from', line: 1 } },
    }]]),
  };
  const settings = defaultSettings();
  const { id, ...rule } = STARTER_PROBLEM_RULES.find(rule => rule.id === 'evidence-applicability')!;
  const read = async (rules: typeof settings.rules, dismissed?: ReadonlySet<string>) => await collectProblems({
    productFolder: '/fixture', owner, manifest, graph: new GraphReader(owner, () => new Date().toISOString()),
    files: workingTreeFiles('/fixture'), settings: { ...settings, rules }, findings: [],
    resolve: async () => { throw new Error('the fixture has no grounds'); },
    ...(dismissed === undefined ? {} : { dismissed }),
  });
  try {
    await owner.transaction('write', tx => publishGraphDrafts(tx, owner.graphContract, { vertices: [retained, fact], removals: [] }));
    const shown = await read({ [id]: rule });
    expect(shown.open).toBe(2);
    const dismissed = new Set([shown.problems[0]!.id]);
    for (const rules of [{ [id]: { ...rule, enabled: false } }, {}]) {
      expect(await read(rules, dismissed)).toMatchObject({ open: 0, dismissed: 1, problems: [] });
    }
    await owner.transaction('write', tx => publishGraphDrafts(tx, owner.graphContract, { vertices: [], removals: [fact] }));
    expect(await read({}, dismissed)).toMatchObject({ open: 0, dismissed: 0, problems: [] });
  } finally { await owner.close(); }
});

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
        { ...fact('available', digest), evidence: [...evidence(digest), { ...evidence(digest)[0]!, locator: { start: 0, end: 4 } }] },
      ] });
      await publishGraphDrafts(tx, owner.graphContract, { removals: [], vertices: [fact('ended', missing)] });
      await publishGraphDrafts(tx, owner.graphContract, { removals: [], vertices: [
        fact('unavailable', missing),
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
    const storedLinks = await owner.run(async tx => (await tx.query<{ cursor: string; opinion: string; fact: string }>(`
      SELECT origin.uid::text || ':' || evidence.uid::text AS cursor,
        origin.uid::text AS opinion, fact.key->>'id' AS fact
      FROM edge evidence JOIN entity kind ON kind.id=evidence.entity_id
      JOIN node origin ON origin.id=evidence.from_node JOIN assertion a ON a.assertion_id=origin.id
      JOIN assertion_vertex_subject attachment ON attachment.assertion_id=a.assertion_id
      JOIN edge subject ON subject.id=attachment.subject_edge_id JOIN node fact ON fact.id=subject.to_node
      WHERE kind.name='system.assertion-evidence' AND a.property IN ('$exists','title')
        AND fact.key->>'id' IN ('available','ended','unavailable')
      ORDER BY evidence.from_node,evidence.to_node,evidence.discriminator,evidence.context_id`)).rows);
    expect(storedLinks.map(link => link.fact)).toEqual(['available', 'available', 'available', 'available', 'ended', 'ended', 'unavailable', 'unavailable']);
    const activeLinks = storedLinks.filter(link => link.fact !== 'ended');
    expect(activeLinks).toHaveLength(6);
    const first = await vanishedCurrentEvidence(owner, contract, { limit: 1 });
    expect(await vanishedCurrentEvidence(owner, contract, { limit: 1, after: '' })).toEqual(first);
    expect(first.next).toBe(activeLinks[0]!.cursor);
    expect(activeLinks[1]!.opinion).toBe(activeLinks[0]!.opinion);
    const second = await vanishedCurrentEvidence(owner, contract, { limit: 1, after: first.next! });
    expect(second.next).toBe(activeLinks[1]!.cursor);
    const lastSound = activeLinks[3]!;
    const firstMissing = activeLinks[4]!;
    const afterSound = await vanishedCurrentEvidence(owner, contract, { limit: 1, after: lastSound.cursor });
    expect(afterSound.rows.map(row => row.opinion)).toEqual([firstMissing.opinion]);
    expect(afterSound.next).toBe(firstMissing.cursor);
    for (const ended of storedLinks.filter(link => link.fact === 'ended')) {
      expect(await vanishedCurrentEvidence(owner, contract, { limit: 1, after: ended.cursor })).toEqual(afterSound);
    }
    expect(await vanishedCurrentEvidence(owner, contract, { after: activeLinks.at(-1)!.cursor })).toEqual({ rows: [] });
    for (const after of [
      `${lastSound.opinion}:00000000-0000-0000-0000-000000000000`,
      `${lastSound.opinion}:${firstMissing.cursor.split(':')[1]}`,
      `${lastSound.opinion}:invalid-link-uid`,
      'invalid-cursor',
    ]) {
      await expect(vanishedCurrentEvidence(owner, contract, { after })).rejects.toThrow(/records\.ts:\d+:\d+: evidence cursor .* names no stored attachment/);
    }
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
