import * as graphWriter from '../src/graph/write.js';
import * as engineStageRegistry from '../src/fill/stages/index.js';
import { StageRegistry } from '../src/fill/registry.js';
import { createHash } from 'node:crypto';
import { afterAll, expect, test, spyOn } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDatabaseOwner, prepareTestStore } from './test-database.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { manifestDeclaration, withManifestContract } from '../src/graph/manifest-contract.js';
import { EMPTY_CONTRACT, generatedTableName, assertionValueTableName } from '../src/graph/contract.js';
import { validateProductManifests, publishValidatedManifests, readPublishedManifest, publicationFingerprint } from '../src/graph/manifest-publication.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { createManifestWatch } from '../src/product/manifest-watch.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';
import { readKindAssertions } from '../src/graph/records.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { acquireGraphWriteLock, bindWriteCapability, publishGraphDrafts } from '../src/graph/write.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { personBinding } from '../src/graph/system-installation.js';
import { activateGraphProducer, bindGraphProducer, registerGraphPrincipal } from '../src/graph/producer-binding.js';
import { newUid } from '../src/graph/uid.js';
import { writeContractOf } from '../src/graph/graph-writes.js';
import { publicationCounts } from './publication-counts.js';
import { readPublicationFingerprint } from '../src/graph/startup-read.js';
import { cataloguePageTemplate } from '../src/knowledge/page-template-kind.js';
import { publicationContractOf, publicationReadSelector } from '../src/graph/publication-contract.js';


test('ALX-132 counter: unchanged catalogue is a bounded read with no writer', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    const read = validateProductManifests(folder);
    if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
    await publishValidatedManifests(owner, read.value);
    const counts = await publicationCounts(owner, measured => publishValidatedManifests(measured, read.value!));
    console.log('ALX-132 small repeat', JSON.stringify(counts));
    expect(counts.result).toBe(0);
    expect(counts.after).toEqual(counts.before);
    expect(counts.writes).toBe(0);
    expect(counts.constraints).toBe(0);
    expect(counts.statements).toBeLessThanOrEqual(5);
    expect(counts.reads).toBeLessThanOrEqual(500);
  } finally { await owner.close(); }
}, 30_000);

test('ALX-132 repeat reads are exactly equal with 200 foreign product vertices', async () => {
  const folder = fixture();
  const foreign = { name: 'fixture.foreign', table: generatedTableName('fixture.foreign', 'vertex'), capability: 'fixture',
    key: ['name'], fields: [{ name: 'name', type: 'text' as const }, { name: 'value', type: 'text' as const }] };
  const contract = withManifestContract({ ...EMPTY_CONTRACT, vertex: [foreign] });
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const read = validateProductManifests(folder);
    if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
    await publishValidatedManifests(owner, read.value, contract);
    const before = await publicationCounts(owner, measured => publishValidatedManifests(measured, read.value!, contract));
    await owner.transaction('write', async tx => {
      const { contract: installed } = await startupBinding(tx, contract, 'foreign');
      await publishGraphDrafts(tx, installed, { vertices: Array.from({ length: 200 }, (_, index) => ({
        kind: foreign.name, key: { name: String(index) }, values: { value: 'foreign' }, producer: 'foreign', producerVersion: '1',
      })), removals: [] });
    });
    const after = await publicationCounts(owner, measured => publishValidatedManifests(measured, read.value!, contract));
    console.log('ALX-132 foreign equality', JSON.stringify({ before, after }));
    expect(before.result).toBe(0);
    expect(after.result).toBe(0);
    expect(after.writes).toBe(0);
    expect(after.reads).toBe(before.reads);
  } finally { await owner.close(); }
}, 60_000);


test('publication refuses a relation to an undeclared kind with its declaration location', () => {
  const folder = fixture();
  writeFolderManifest(folder, `kinds:
  term:
    source: document
    terms: ["docs/*.md"]
    relations:
      - type: mentions
        to: missing:{name}
`);
  const read = validateProductManifests(folder);
  expect(read.ok).toBe(false);
  if (read.ok) throw new Error('undeclared relation endpoint was accepted');
  expect(read.findings).toContainEqual({
    file: join(folder, 'madarch/kinds/fixture/fixture/term.yaml'), line: 5,
    message: 'relation mentions from term names undeclared kind missing',
  });
});

test('changed catalogue checks assertion evidence in one batch, not once per property', async () => {
  const validated = publicationFixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await publishValidatedManifests(owner, validated);
    const changed = { ...validated, vertices: validated.vertices.map(draft => draft.kind === 'manifest.kind'
      ? { ...draft, values: { declaration: '{"changed":true}' } } : draft) };
    const evidenceQueries: string[] = [];
    await owner.transaction('write', async tx => {
      const query = tx.query;
      tx.query = async (sql, values) => {
        if (sql.startsWith('SELECT t.uid::text,e.discriminator') || sql.startsWith('SELECT a.uid::text AS assertion,t.uid::text,e.discriminator')) evidenceQueries.push(sql);
        return await query.call(tx, sql, values) as never;
      };
      try {
        const measured = { ...owner, transaction: async (_kind: unknown, work: (executor: typeof tx) => Promise<number>) => await work(tx) } as typeof owner;
        await publishValidatedManifests(measured, changed);
      } finally { tx.query = query; }
    });
    expect(evidenceQueries.length).toBeLessThanOrEqual(1);
    const manifest = await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration']));
    expect(manifest[0]!.values['declaration']).toBe('{"changed":true}');
  } finally { await owner.close(); }
}, 30_000);

test('changed fixed catalogue batches identity checks and held edge keys', async () => {
  const folder = fixture();
  writeFolderManifest(folder, 'kinds:\n' + Array.from({ length: 12 }, (_, i) => `  item${i}:
    source: document
    terms: ["docs/*.md"]
    relations:
      - type: mentions
        to: item${i}:{name}
`).join(''));
  const read = validateProductManifests(folder);
  if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
  const validated = read.value;
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await publishValidatedManifests(owner, validated);
    const changed = { ...validated, vertices: validated.vertices.map(draft => draft.kind === 'manifest.catalogue'
      ? { ...draft, values: { declaration: '{"changed":true}' } } : draft) };
    const calls: string[] = [];
    const resolver = spyOn(graphWriter, 'resolveEntityRef');
    try {
      await owner.transaction('write', async tx => {
        const query = tx.query;
        tx.query = async (sql, values) => { calls.push(sql); return await query.call(tx, sql, values) as never; };
        try {
          const measured = { ...owner, transaction: async (_kind: unknown, work: (executor: typeof tx) => Promise<number>) => await work(tx) } as typeof owner;
          await publishValidatedManifests(measured, changed);
        } finally { tx.query = query; }
      });
      // A direct resolveEntityRef per use defeats both prefetch and transaction-local reuse.
      expect(resolver.mock.calls.length).toBe(0);
      const endpointChecks = calls.filter(sql => sql.includes('graph_vertex_active') && sql.includes('FOR UPDATE') || sql.startsWith('SELECT graph_vertex_active'));
      const keyReads = calls.filter(sql => sql.includes('f.key AS from_key,t.key AS to_key'));
      console.log('X2 fixed catalogue', JSON.stringify({ endpointChecks: endpointChecks.length, keyReads: keyReads.length }));
      expect(endpointChecks.length).toBe(3);
      expect(keyReads.length).toBe(1);
      expect((await owner.run(tx => readKindAssertions(tx, 'edge', 'manifest.relation-edge', ['relation'])))).toHaveLength(12);
    } finally { resolver.mockRestore(); }
  } finally { await owner.close(); }
}, 30_000);

test('kind relation to a protected engine kind publishes its catalogue endpoint', async () => {
  const folder = fixture();
  writeFolderManifest(folder, `kinds:
  term:
    source: document
    terms: ["docs/*.md"]
    relations:
      - type: mentions
        to: system.product:{name}
`);
  const read = validateProductManifests(folder);
  if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await publishValidatedManifests(owner, read.value);
    const kinds = await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration']));
    const target = kinds.find(row => row.key['name'] === 'system.product');
    expect(JSON.parse(String(target?.values['declaration']))).toMatchObject({ protected: true, taken: false });
    const edges = await owner.run(tx => readKindAssertions(tx, 'edge', 'manifest.relation-edge', ['relation']));
    expect(edges).toHaveLength(1);
    expect(String(edges[0]!.to)).toBe(String(target!.id));
  } finally { await owner.close(); }
}, 30_000);

const root = mkdtempSync(join(tmpdir(), 'madarch-manifest-publication-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function publicationFixture() {
  const folder = fixture();
  const read = validateProductManifests(folder);
  if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
  return read.value;
}

for (const input of ['vertices', 'snapshots', 'starterValues', 'edges', 'contract'] as const) {
  test(`ALX-132 invalidation: ${input}`, async () => {
    const validated = publicationFixture();
    const valueKind = { name: 'fixture.value', table: generatedTableName('fixture.value', 'vertex'), capability: 'fixture', key: ['name'],
      fields: [{ name: 'name', type: 'text' as const }, { name: 'label', type: 'text' as const }] };
    const contract = withManifestContract({ ...EMPTY_CONTRACT, vertex: [valueKind] });
    const starter = { kind: valueKind.name, key: { name: 'one' }, values: { label: 'old' }, producer: 'manifest', producerVersion: '1' };
    const initial = { ...validated, starterValues: [starter] };
    const owner = await createTestDatabaseOwner({ graphContract: contract });
    try {
      await publishValidatedManifests(owner, initial, contract);
      let changed = initial;
      let authored = contract;
      if (input === 'vertices') changed = { ...initial, vertices: initial.vertices.map(draft => draft.kind === 'manifest.kind' ? { ...draft, values: { declaration: '{"changed":true}' } } : draft) };
      if (input === 'snapshots') changed = { ...initial, snapshots: initial.snapshots.map((draft, index) => index === 0 ? { ...draft, key: { ...draft.key, digest: createHash('sha256').update('changed snapshot').digest('hex') }, values: { ...draft.values, content: 'changed snapshot' } } : draft) };
      if (input === 'starterValues') changed = { ...initial, starterValues: [{ ...starter, values: { label: 'new' } }] };
      if (input === 'edges') changed = { ...initial, edges: [{ kind: 'manifest.depends-on', from: { kind: 'manifest.kind', key: { name: 'term' } }, to: { kind: 'manifest.kind', key: { name: 'term' } }, values: { declaration: 'changed edge' }, producer: 'manifest', producerVersion: '1' }] };
      if (input === 'contract') authored = { ...contract, vertex: contract.vertex.map(kind => kind.name === valueKind.name ? { ...kind, fields: kind.fields.map(field => field.name === 'label' ? { ...field, nullable: true } : field) } : kind) };
      const before = await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.catalogue', ['publication_fingerprint']));
      expect(await publishValidatedManifests(owner, changed, authored)).toBeGreaterThan(0);
      if (input === 'vertices') expect((await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration'])))[0]!.values['declaration']).toBe('{"changed":true}');
      if (input === 'snapshots') expect((await owner.run(tx => readKindAssertions(tx, 'vertex', 'system.content-snapshot', ['content']))).some(row => row.values['content'] === 'changed snapshot')).toBe(true);
      if (input === 'starterValues') expect((await owner.run(async tx => readKindAssertions(tx, 'vertex', valueKind.name, ['label'], await publicationReadSelector(tx, publicationContractOf(changed.manifest, authored)))))[0]!.values['label']).toBe('new');
      if (input === 'edges') expect((await owner.run(tx => readKindAssertions(tx, 'edge', 'manifest.depends-on', ['declaration'])))[0]!.values['declaration']).toBe('changed edge');
      if (input === 'contract') {
        const after = await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.catalogue', ['publication_fingerprint']));
        expect(after[0]!.values['publication_fingerprint']).not.toBe(before[0]!.values['publication_fingerprint']);
        expect(after[0]!.values['publication_fingerprint']).toBe(publicationFingerprint(changed, publicationContractOf(changed.manifest, authored), null));
      }
      expect(await publishValidatedManifests(owner, changed, authored)).toBe(0);
    } finally { await owner.close(); }
  }, 60_000);
}

test('ALX-132 publication revision and engine version change the fingerprint', () => {
  const validated = publicationFixture();
  const contract = withAssertionContract(withManifestContract(EMPTY_CONTRACT));
  const original = publicationFingerprint(validated, contract, null, 1, '1.0.0');
  expect(publicationFingerprint(validated, contract, null, 2, '1.0.0')).not.toBe(original);
  expect(publicationFingerprint(validated, contract, null, 1, '2.0.0')).not.toBe(original);
});


test('ALX-132 reset republishes the catalogue and marks the new graph', async () => {
  const validated = publicationFixture();
  const contract = withManifestContract(EMPTY_CONTRACT);
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await publishValidatedManifests(owner, validated);
    await prepareTestStore(owner, { contract, reset: true });
    expect(await publishValidatedManifests(owner, validated)).toBeGreaterThan(0);
    expect((await owner.run(tx => readPublishedManifest(tx)))!.kinds.has('term')).toBe(true);
    expect((await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.catalogue', ['publication_fingerprint'])))[0]!.values['publication_fingerprint']).toBeDefined();
  } finally { await owner.close(); }
}, 60_000);

test('ALX-132 a source that is not the manifest publication states no fingerprint, and the fast path reads the installation', async () => {
  const validated = publicationFixture();
  const contract = withManifestContract(EMPTY_CONTRACT);
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await publishValidatedManifests(owner, validated);
    const fingerprint = String((await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.catalogue', ['publication_fingerprint'])))[0]!.values['publication_fingerprint']);
    // Trusted startup can install another source with broad host authority, and the fingerprint's kind is not its to state.
    await expect(owner.transaction('write', async tx => {
      const { contract: installed } = await startupBinding(tx, contract, 'foreign');
      await publishGraphDrafts(tx, installed, { vertices: [{ kind: 'manifest.catalogue', key: { name: 'product' },
        values: { publication_fingerprint: fingerprint }, selectedFields: ['publication_fingerprint'], producer: 'foreign', producerVersion: '1' }], removals: [] });
    })).rejects.toThrow(/CAPABILITY_MISMATCH kind manifest\.catalogue declares the reserved capability manifest; source [0-9a-f-]{8}-/u);
    // The mark is the installation's own, so its value still authorizes the fast path.
    expect(await owner.run(tx => readPublicationFingerprint(tx))).toBe(fingerprint);
    expect(await publishValidatedManifests(owner, validated)).toBe(0);
    // A mark whose selected source is no longer the engine's manifest installation authorizes nothing, whatever its value.
    await owner.transaction('write', async tx => {
      const { contract: installed, binding } = await startupBinding(tx, contract, 'manifest');
      await publishGraphDrafts(tx, installed, { vertices: [{ kind: 'plugin', uid: binding.sourceUid, key: {},
        values: { installation: JSON.stringify(['system-engine', 'foreign']) }, selectedFields: ['installation'], producer: 'manifest', producerVersion: '1' }], removals: [] });
    });
    expect(await owner.run(tx => readPublicationFingerprint(tx))).toBeUndefined();
    expect(await publishValidatedManifests(owner, validated)).toBeGreaterThan(0);
    expect(await owner.run(tx => readPublicationFingerprint(tx))).toBe(fingerprint);
    expect((await owner.run(tx => readPublishedManifest(tx)))!.kinds.has('term')).toBe(true);
  } finally { await owner.close(); }
}, 60_000);

for (const interrupt of ['inside declarations', 'after declarations'] as const) {
  test(`ALX-132 rollback: ${interrupt}`, async () => {
    const initial = publicationFixture();
    const changed = { ...initial, vertices: initial.vertices.map(draft => draft.kind === 'manifest.kind' ? { ...draft, values: { declaration: '{"interrupted":true}' } } : draft) };
    const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
    try {
      await publishValidatedManifests(owner, initial);
      const marker = async () => (await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.catalogue', ['publication_fingerprint'])))[0]!.values['publication_fingerprint'];
      const before = await marker();
      const controller = new AbortController();
      const interrupted: typeof owner = { ...owner, transaction: async (kind, body, options) => {
        const result = await owner.transaction(kind, async tx => {
          const result = await body(tx);
          if (interrupt === 'inside declarations') throw new Error('injected rollback');
          return result;
        }, options);
        controller.abort(new Error('injected interruption after commit'));
        return result;
      } };
      await expect(publishValidatedManifests(interrupted, changed, undefined, controller.signal)).rejects.toThrow('injected');
      if (interrupt === 'inside declarations') {
        expect(await marker()).toBe(before);
        expect(await publishValidatedManifests(owner, changed)).toBeGreaterThan(0);
      } else {
        // The one commit includes B's declarations and its mark, even if cancellation arrives after commit.
        expect(await marker()).not.toBe(before);
        expect(await publishValidatedManifests(owner, changed)).toBe(0);
      }
      expect(await marker()).not.toBe(before);
      expect((await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration'])))[0]!.values['declaration']).toBe('{"interrupted":true}');
      expect(await publishValidatedManifests(owner, changed)).toBe(0);
    } finally { await owner.close(); }
  }, 60_000);
}


test('ALX-132 product name invalidates the page and its evidence is catalogue snapshots', async () => {
  const folder = fixture();
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: stable-id\nname: before\n');
  writeFolderManifest(folder, `kinds:
  product:
    source: graph
    title: title
    key: [slug]
    fields:
      - { name: slug, type: text, producers: [start] }
      - { name: title, type: text, producers: [start] }
`);
  const read = validateProductManifests(folder);
  if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
  const contract = writeContractOf(read.value.manifest);
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await publishValidatedManifests(owner, read.value);
    writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: stable-id\nname: after\n');
    expect(await publishValidatedManifests(owner, read.value)).toBeGreaterThan(0);
    const page = (await owner.run(async tx => readKindAssertions(tx, 'vertex', 'product', ['title'], await publicationReadSelector(tx, publicationContractOf(read.value!.manifest, contract)))))[0]!;
    expect(page.values['title']).toBe('after');
    const title = page.selectedAssertions.find(assertion => assertion.property === 'title')!;
    const snapshots = await owner.run(tx => readKindAssertions(tx, 'vertex', 'system.content-snapshot', ['content']));
    expect(title.evidence.length).toBeGreaterThan(0);
    expect(title.evidence.every(uid => snapshots.some(snapshot => snapshot.uid === uid))).toBe(true);
    expect(await publishValidatedManifests(owner, read.value)).toBe(0);
  } finally { await owner.close(); }
}, 60_000);


test('ALX-132 interrupted B followed by A cannot reuse the stale A marker', async () => {
  const initial = publicationFixture();
  const changed = { ...initial, vertices: initial.vertices.map(draft => draft.kind === 'manifest.kind' ? { ...draft, values: { declaration: '{"interrupted":true}' } } : draft) };
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await publishValidatedManifests(owner, initial);
    const controller = new AbortController();
    const interrupted: typeof owner = { ...owner, transaction: async (kind, body, options) => {
      const result = await owner.transaction(kind, body, options);
      controller.abort(new Error('injected interruption after commit'));
      return result;
    } };
    await expect(publishValidatedManifests(interrupted, changed, undefined, controller.signal)).rejects.toThrow('injected');
    expect(await publishValidatedManifests(owner, initial)).toBeGreaterThan(0);
    expect((await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration'])))[0]!.values['declaration']).not.toBe('{"interrupted":true}');
  } finally { await owner.close(); }
}, 60_000);


test('ALX-174 mark scope must name the store product, not its source identity scope', async () => {
  const validated = publicationFixture();
  const contract = withManifestContract(EMPTY_CONTRACT);
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await publishValidatedManifests(owner, validated);
    const source = (await owner.run(tx => readKindAssertions(tx, 'vertex', 'plugin', ['installation'])))
      .find(row => row.values['installation'] === JSON.stringify(['system-engine', 'manifest']))!;
    const foreignScope = newUid();
    await owner.transaction('write', async tx => {
      // Corrupt both historical scope and identity scope to model the reviewed malformed store.
      await tx.query('SET LOCAL session_replication_role = replica');
      await tx.query('UPDATE node SET identity_scope=$1::uuid WHERE uid=$2::uuid', [foreignScope, source.uid]);
      const scope = assertionValueTableName('plugin', 'vertex', 'scope');
      await tx.query(`UPDATE "${scope}" SET value=$1 WHERE assertion_id IN (SELECT a.assertion_id FROM assertion a JOIN edge e ON e.from_node=a.assertion_id JOIN node n ON n.id=e.to_node JOIN entity k ON k.id=e.entity_id WHERE n.uid=$2::uuid AND k.name='system.assertion-subject' AND a.property='scope')`, [foreignScope, source.uid]);
    });
    expect(await owner.run(tx => readPublicationFingerprint(tx))).toBeUndefined();
  } finally { await owner.close(); }
}, 30_000);

test('ALX-174 startup reads preserve sub-millisecond cutoffs', async () => {
  const validated = publicationFixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT), authenticated: false });
  try {
    await owner.transaction('write', async tx => {
      const query = tx.query;
      const cutoffs: string[] = [];
      let lastReadCutoff: string | undefined;
      tx.query = async (sql, values) => {
        const result = await query.call(tx, sql, values);
        if (sql === 'SELECT clock_timestamp()::text AS now') {
          const cutoff = (result.rows[0] as { now: string }).now;
          // PostgreSQL's text timestamp keeps the microseconds the JS Date conversion drops.
          cutoffs.push(cutoff);
        }
        if (sql.includes('WITH RECURSIVE context_path') && !sql.startsWith('SELECT marker.value') && cutoffs.length > 0) {
          const cutoff = cutoffs.at(-1)!;
          // A parameterized selector keeps the cutoff out of the SQL text; either place must carry it unchanged.
          expect(sql.includes(cutoff) || (values ?? []).some(value => value === cutoff)).toBe(true);
          // node-postgres renders anything but a string by its own rules: a Date here would drop the microseconds.
          expect((values ?? []).some(value => value instanceof Date)).toBe(false);
          // Every temporal bound is this cutoff, not a truncated form of it.
          for (const match of sql.matchAll(/\$(\d+)::timestamptz/g)) expect((values ?? [])[Number(match[1]) - 1]).toBe(cutoff);
          expect(sql).not.toContain('transaction_timestamp()');
        }
        if (sql.includes('AS request_index') && values?.length) {
          if (values.includes(cataloguePageTemplate().name)) {
            // Even an empty template kind needs a fresh cutoff after the preceding publication phase.
            expect(cutoffs.at(-1)).not.toBe(lastReadCutoff);
          }
          lastReadCutoff = cutoffs.at(-1);
        }
        return result as never;
      };
      const first = await startupBinding(tx, withManifestContract(EMPTY_CONTRACT), 'manifest');
      const second = await startupBinding(tx, withManifestContract(EMPTY_CONTRACT), 'manifest');
      expect(second.binding.sourceUid).toBe(first.binding.sourceUid);
      const borrowed: typeof owner = { ...owner, transaction: async (_kind, body) => await body(tx) };
      expect(await publishValidatedManifests(borrowed, validated)).toBeGreaterThan(0);
      expect(cutoffs.length).toBeGreaterThan(2);
    });
  } finally { await owner.close(); }
}, 30_000);

test('ALX-174 a cutoff keeps its microseconds through the parameterized read', async () => {
  const validated = publicationFixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  const boundary = '2026-01-01T00:00:00.000400Z';
  try {
    await publishValidatedManifests(owner, validated);
    const subject = (await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration'])))[0]!;
    await owner.transaction('write', async tx => {
      // Assertion history is immutable; a replica session is how the store's own tests age a row.
      await tx.query('SET LOCAL session_replication_role = replica');
      await tx.query(`UPDATE assertion SET recorded_at=$1::timestamptz, valid_from=$1::timestamptz
        WHERE assertion_id IN (
          SELECT a.assertion_id FROM assertion a
          JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id
          JOIN edge e ON e.id=s.subject_edge_id
          WHERE e.to_node=(SELECT id FROM node WHERE uid=$2::uuid)
        )`, [boundary, subject.uid]);
    });
    const visible = async (at: string) => (await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration'], { validAt: at, recordedAt: at }))).some(row => row.uid === subject.uid);
    // Truncating the bound to a millisecond reads .000400 as .000 and hides the row.
    expect(await visible('2026-01-01T00:00:00.000400Z')).toBe(true);
    // Rounding the bound up to .001 would show the row; one microsecond earlier must not.
    expect(await visible('2026-01-01T00:00:00.000399Z')).toBe(false);
  } finally { await owner.close(); }
}, 60_000);

// Task: madarch-64o5.74
test('ALX-884 identity selection sees a merge exactly at .000400 and not at .000399', async () => {
  const validated = publicationFixture();
  const valueKind = { name: 'fixture.value', table: generatedTableName('fixture.value', 'vertex'), capability: 'fixture', key: ['name'],
    fields: [{ name: 'name', type: 'text' as const }, { name: 'label', type: 'text' as const }] };
  const contract = withManifestContract({ ...EMPTY_CONTRACT, vertex: [valueKind] });
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  const write = async (drafts: Parameters<typeof publishGraphDrafts>[2]) => await owner.transaction('write', async tx => {
    const { contract: installed } = await startupBinding(tx, contract, 'alx-884');
    await publishGraphDrafts(tx, installed, drafts);
  });
  try {
    await publishValidatedManifests(owner, validated, contract);
    await write({
      vertices: ['one', 'two'].map(name => ({ kind: valueKind.name, key: { name }, values: { label: name }, producer: 'alx-884', producerVersion: '1' })),
      removals: [],
    });
    const [survivor, alias] = (await owner.run(tx => readKindAssertions(tx, 'vertex', valueKind.name, ['label'], { contract: owner.graphContract })))
      .sort((left, right) => left.id - right.id);
    if (survivor === undefined || alias === undefined) throw new Error('ALX-884 fixture needs two value entities');
    const mergeUid = newUid();
    await write({
      vertices: [{ kind: 'system.merge', uid: mergeUid, key: {}, values: { state: 'ACTIVE', reason: 'ALX-884 microsecond merge' }, producer: 'alx-884', producerVersion: '1' }],
      edges: [
        ...[survivor, alias].map(row => ({ kind: 'system.merge-member', from: { kind: 'system.merge', uid: mergeUid, key: {} },
          to: { kind: valueKind.name, uid: row.uid, key: {} }, discriminator: row.uid, producer: 'alx-884', producerVersion: '1' })),
        { kind: 'system.merge-survivor', from: { kind: 'system.merge', uid: mergeUid, key: {} },
          to: { kind: valueKind.name, uid: survivor.uid, key: {} }, producer: 'alx-884', producerVersion: '1' },
      ],
      removals: [],
    });
    // Bounds derive from the fixture's own writes, so the test holds on any calendar date.
    const { boundary, earlier } = (await owner.run(tx => tx.query<{ boundary: string; earlier: string }>(`
      WITH base AS (SELECT date_trunc('second', greatest(max(recorded_at), max(valid_from))) + interval '1 second' AS s FROM assertion)
      SELECT to_char((s + interval '400 microseconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS boundary,
             to_char((s + interval '399 microseconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS earlier FROM base`))).rows[0]!;
    // Assertion history is immutable; a replica session places the merge's valid time exactly on the boundary.
    await owner.transaction('write', async tx => {
      await tx.query('SET LOCAL session_replication_role = replica');
      await tx.query(`UPDATE assertion SET valid_from=$1::timestamptz WHERE property='state' AND assertion_id IN (
        SELECT a.assertion_id FROM assertion a
        JOIN assertion_vertex_subject attachment ON attachment.assertion_id=a.assertion_id
        JOIN edge subject_edge ON subject_edge.id=attachment.subject_edge_id
        WHERE subject_edge.to_node=(SELECT id FROM node WHERE uid=$2::uuid))`, [boundary, mergeUid]);
    });
    const precondition = await owner.run(tx => tx.query<{ valid: boolean }>(`SELECT bool_and(recorded_at < $1::timestamptz AND (valid_from < $1::timestamptz OR valid_from = $2::timestamptz)) AS valid FROM assertion`, [earlier, boundary]));
    expect(precondition.rows[0]?.valid).toBe(true);
    const visible = async (instant: string) => (await owner.run(tx => readKindAssertions(tx, 'vertex', valueKind.name, ['label'],
      { contract: owner.graphContract, subjectUids: [alias.uid], validAt: instant, recordedAt: instant }))).map(row => row.uid);
    // The alias resolves to the survivor only when the merge's valid time is inside the bound.
    expect(await visible(boundary)).toEqual([survivor.uid]);
    expect(await visible(earlier)).toEqual([alias.uid]);
  } finally { await owner.close(); }
}, 60_000);

function atomicFixture() {
  const folder = fixture();
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: stable-id\nname: A\n');
  writeFolderManifest(folder, `kinds:
  product:
    source: graph
    title: title
    key: [slug]
    fields:
      - { name: slug, type: text, producers: [start] }
      - { name: title, type: text, producers: [start] }
`);
  const read = validateProductManifests(folder);
  if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
  const a = read.value;
  const b = { ...a, vertices: a.vertices.map(draft => draft.kind === 'manifest.kind' ? { ...draft, values: { declaration: '{"generation":"B"}' } } : draft) };
  return { folder, a, b, contract: writeContractOf(a.manifest) };
}

async function publicationState(owner: Parameters<typeof publishValidatedManifests>[0], validated: Parameters<typeof publishValidatedManifests>[1], contract: Parameters<typeof publicationContractOf>[1]) {
  return await owner.run(async tx => {
    const selector = await publicationReadSelector(tx, publicationContractOf(validated.manifest, contract));
    return {
      declarations: await readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration'], selector),
      page: await readKindAssertions(tx, 'vertex', 'product', ['title'], selector),
      mark: await readKindAssertions(tx, 'vertex', 'manifest.catalogue', ['publication_fingerprint'], selector),
      sizes: (await tx.query('SELECT (SELECT count(*) FROM node) AS nodes,(SELECT count(*) FROM edge) AS edges,(SELECT count(*) FROM assertion) AS assertions')).rows,
    };
  });
}

// The two phases a publication writes through: its declarations' vertices, and the page and mark that follow
// them. The abort lands inside the transaction that wrote them, so what it leaves behind is the question.
for (const boundary of ['declarations', 'page'] as const) {
  test(`ALX-174 abort inside publication after ${boundary}`, async () => {
    const { folder, a, b, contract } = atomicFixture();
    const owner = await createTestDatabaseOwner({ graphContract: contract });
    try {
      await publishValidatedManifests(owner, a);
      const before = await publicationState(owner, a, contract);
      writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: stable-id\nname: B\n');
      const controller = new AbortController();
      // The declarations' vertices are written by their own batches; the mark is the one write that carries the
      // publication's fingerprint, and it follows the page.
      let declarationBatches = 0;
      const interrupted: typeof owner = { ...owner, transaction: (kind, body, options) => owner.transaction(kind, async tx => {
        const query = tx.query;
        tx.query = async (sql, values) => {
          const reached = boundary === 'declarations'
            ? sql.startsWith('INSERT INTO node(entity_id,uid,key,identity_scope,context_id)') && ++declarationBatches === 2
            : JSON.stringify(values ?? []).includes('publication_fingerprint');
          if (reached) {
            controller.abort(new Error('injected boundary abort'));
            controller.signal.throwIfAborted();
          }
          return await query.call(tx, sql, values) as never;
        };
        return await body(tx);
      }, options) };
      await expect(publishValidatedManifests(interrupted, b, undefined, controller.signal)).rejects.toThrow('injected');
      expect(await publicationState(owner, a, contract)).toEqual(before);
      expect(await publishValidatedManifests(owner, b)).toBeGreaterThan(0);
      const after = await publicationState(owner, a, contract);
      expect(after.declarations[0]!.values['declaration']).toBe('{"generation":"B"}');
      expect(after.page[0]!.values['title']).toBe('B');
      expect(after.mark[0]!.values['publication_fingerprint']).not.toBe(before.mark[0]!.values['publication_fingerprint']);
      expect(await publishValidatedManifests(owner, b)).toBe(0);
    } finally { await owner.close(); }
  }, 60_000);
}

test('ALX-174 queued publications re-read the mark after the graph lock', async () => {
  const fixture = atomicFixture();
  const { a, contract } = fixture;
  const bFolder = mkdtempSync(join(root, 'publication-b-'));
  cpSync(fixture.folder, bFolder, { recursive: true });
  writeFileSync(join(bFolder, 'workspace.yaml'), 'schemaVersion: 1\nid: stable-id\nname: B\n');
  const b = { ...fixture.b, folder: bFolder };
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let holder: Promise<void> | undefined;
  let publications: Promise<number>[] = [];
  try {
    // Seed A; the holder changes declarations, page and mark to B before the waiters proceed.
    await publishValidatedManifests(owner, a);
    holder = owner.transaction('write', async tx => {
      await acquireGraphWriteLock(tx);
      locked.resolve();
      await release.promise;
      const borrowed: typeof owner = { ...owner, transaction: async (_kind, body) => await body(tx) };
      await publishValidatedManifests(borrowed, b);
    });
    await locked.promise;
    const queued = (index: number): typeof owner => ({ ...owner, transaction: (kind, body, options) => owner.transaction(kind, async tx => {
      const query = tx.query;
      let first = true;
      tx.query = async (sql, values) => {
        if (first) {
          first = false;
          const waiting = query.call(tx, sql, values);
          entered[index]!.resolve();
          return await waiting as never;
        }
        return await query.call(tx, sql, values) as never;
      };
      return await body(tx);
    }, options) });
    publications = [publishValidatedManifests(queued(0), a), publishValidatedManifests(queued(1), b)];
    await Promise.all(entered.map(one => one.promise));
    release.resolve();
    await holder;
    const results = await Promise.all(publications);
    const state = await publicationState(owner, a, contract);
    const last = state.declarations[0]!.values['declaration'] === '{"generation":"B"}' ? b : a;
    const title = last === b ? 'B' : 'A';
    expect(state.page[0]!.values['title']).toBe(title);
    expect(state.mark[0]!.values['publication_fingerprint']).toBe(publicationFingerprint(last, publicationContractOf(last.manifest, contract), { kind: 'product', key: { slug: 'stable-id' }, values: { title } }));
    expect(results[0]).toBeGreaterThan(0);
    expect(await publishValidatedManifests(owner, last)).toBe(0);
    expect(await publishValidatedManifests(owner, last === a ? b : a)).toBeGreaterThan(0);
  } finally {
    release.resolve();
    await Promise.allSettled([...(holder === undefined ? [] : [holder]), ...publications]);
    await owner.close();
  }
}, 60_000);

test('ALX-215 one queued publication selects declarations after the holder commits', async () => {
  const fixture = atomicFixture();
  const { a, contract } = fixture;
  const bFolder = mkdtempSync(join(root, 'publication-b-'));
  cpSync(fixture.folder, bFolder, { recursive: true });
  writeFileSync(join(bFolder, 'workspace.yaml'), 'schemaVersion: 1\nid: stable-id\nname: B\n');
  const b = { ...fixture.b, folder: bFolder };
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let holder: Promise<void> | undefined;
  let publications: Promise<number>[] = [];
  try {
    // Seed A; the holder changes declarations, page and mark to B before the waiter proceeds.
    await publishValidatedManifests(owner, a);
    holder = owner.transaction('write', async tx => {
      await acquireGraphWriteLock(tx);
      locked.resolve();
      await release.promise;
      const borrowed: typeof owner = { ...owner, transaction: async (_kind, body) => await body(tx) };
      await publishValidatedManifests(borrowed, b);
    });
    await locked.promise;
    const queued: typeof owner = { ...owner, transaction: (kind, body, options) => owner.transaction(kind, async tx => {
      const query = tx.query;
      let first = true;
      tx.query = async (sql, values) => {
        if (first) {
          first = false;
          const waiting = query.call(tx, sql, values);
          entered.resolve();
          return await waiting as never;
        }
        return await query.call(tx, sql, values) as never;
      };
      return await body(tx);
    }, options) };
    publications = [publishValidatedManifests(queued, a)];
    await entered.promise;
    release.resolve();
    await holder;
    const results = await Promise.all(publications);
    const state = await publicationState(owner, a, contract);
    expect(state.page[0]!.values['title']).toBe(state.declarations[0]!.values['declaration'] === '{"generation":"B"}' ? 'B' : 'A');
    expect(results).toHaveLength(1);
    expect(results[0]).toBeGreaterThan(0);
    expect(state.declarations[0]!.values['declaration']).toBe(a.vertices.find(draft => draft.kind === 'manifest.kind')!.values!['declaration']);
    expect(state.page[0]!.values['title']).toBe('A');
    expect(state.mark[0]!.values['publication_fingerprint']).toBe(publicationFingerprint(a, publicationContractOf(a.manifest, contract), { kind: 'product', key: { slug: 'stable-id' }, values: { title: 'A' } }));
    expect(await publishValidatedManifests(owner, a)).toBe(0);
    expect(await publishValidatedManifests(owner, b)).toBeGreaterThan(0);
    expect((await publicationState(owner, a, contract)).page[0]!.values['title']).toBe('B');
  } finally {
    release.resolve();
    await Promise.allSettled([...(holder === undefined ? [] : [holder]), ...publications]);
    await owner.close();
  }
}, 60_000);

function fixture(): string {
  const folder = mkdtempSync(join(root, 'product-'));
  mkdirSync(join(folder, 'madarch'));
  mkdirSync(join(folder, 'templates'));
  writeFileSync(join(folder, 'templates', 'term.md'), '# Term');
  writeFolderManifest(folder, `kinds:
  term:
    source: document
    
    terms: ["docs/*.md"]
`);
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  future: { status: planned, stages: [] }\n');
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '--allow-empty', '-qm', 'fixture']);
  return folder;
}

test('publishes complete metadata and declaration evidence without repository content or fill', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    const read = validateProductManifests(folder);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(JSON.stringify(read.findings));
    if (read.value === undefined) throw new Error('fixture manifest was absent');
    expect(await publishValidatedManifests(owner, read.value)).toBeGreaterThan(0);
    const manifest = await owner.run((tx) => readPublishedManifest(tx));
    expect([...manifest!.kinds.keys()]).toEqual(['term']);
    expect([...manifest!.workflows!.workflows.keys()]).toEqual(['future']);
    const rows = await owner.run(tx => loadAssertions(tx, 'vertex', 'manifest.kind', ['declaration']));
    const kind = rows.at(-1)!;
    expect(kind.evidence).toHaveLength(1);
    const snapshots = await owner.run(tx => readKindAssertions(tx, 'vertex', 'system.content-snapshot', ['content']));
    const snapshot = snapshots.find(row => row.uid === kind.evidence[0])!;
    expect(snapshot.values['content']).toContain('term');
    const locators = await owner.run(tx => tx.query<{ discriminator: string }>(`SELECT e.discriminator FROM edge e JOIN node a ON a.id=e.from_node JOIN entity k ON k.id=e.entity_id WHERE a.uid=$1::uuid AND k.name='system.assertion-evidence'`, [kind.id]));
    expect(JSON.parse(locators.rows[0]!.discriminator).locator).toMatchObject({ lineStart: 1, lineEnd: 1 });
    expect(await publishValidatedManifests(owner, read.value)).toBe(0);
    const regrounded = { ...read.value, vertices: read.value.vertices.map(one => ({ ...one, evidence: one.evidence?.map(e => ({ ...e, locator: { ...e.locator, lineStart: 2, lineEnd: 2 } })) })) };
    expect(await publishValidatedManifests(owner, regrounded)).toBeGreaterThan(0);
    const grounds = await owner.run(tx => loadAssertions(tx, 'vertex', 'manifest.kind', ['declaration']));
    expect(grounds.at(-1)!.evidence).toEqual(kind.evidence);
    const changedLocators = await owner.run(tx => tx.query<{ discriminator: string }>(`SELECT e.discriminator FROM edge e JOIN node a ON a.id=e.from_node JOIN entity k ON k.id=e.entity_id WHERE a.uid=$1::uuid AND k.name='system.assertion-evidence'`, [grounds.at(-1)!.id]));
    // 0039 item 25 / ALX-102 §3: unchanged values retain the assertion and append the new pass's evidence.
    expect(grounds.at(-1)!.id).toBe(kind.id);
    expect(changedLocators.rows.map(row => JSON.parse(row.discriminator).locator).sort((a, b) => a.lineStart - b.lineStart))
      .toEqual([1, 2].map(line => ({ digest: JSON.parse(locators.rows[0]!.discriminator).locator.digest, lineStart: line, lineEnd: line })));
    expect(await publishValidatedManifests(owner, regrounded)).toBe(0);
    const edited = { ...regrounded, vertices: regrounded.vertices.map((one) => one.kind === 'manifest.kind' ? { ...one, values: { declaration: JSON.stringify({ ...JSON.parse(String(one.values!['declaration'])), title: 'Changed title' }) } } : one) };
    expect(await publishValidatedManifests(owner, edited)).toBeGreaterThan(0);
    const declaration = await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', ['declaration']));
    expect(JSON.parse(String(declaration[0]!.values['declaration']))).toMatchObject({ title: 'Changed title' });
    expect(await publishValidatedManifests(owner, edited)).toBe(0);
    // An older matching opinion is closed history, not proof that the latest declaration is unchanged.
    expect(await publishValidatedManifests(owner, regrounded)).toBeGreaterThan(0);
    expect(await publishValidatedManifests(owner, regrounded)).toBe(0);
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.kinds.size).toBe(1);
    const contents = await owner.run((tx) => tx.query<{ count: string }>("SELECT count(*)::text AS count FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name LIKE 'code.%'"));
    expect(contents.rows[0]!.count).toBe('0');
  } finally { await owner.close(); }
}, 30_000);


test('repeat publication adds a workflow stage beside an already published stage', async () => {
  const folder = fixture();
  const registry = engineStageRegistry.createEngineStageRegistry();
  registry.register({ ...registry.all()[0]!, id: 'fixture-second' });
  // The engine currently holds only plugin-turns; register a second declaration for this fixture.
  const stages = registry.all();
  const reader = spyOn(StageRegistry.prototype, 'all').mockReturnValue(stages);
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  alpha: { status: planned, stages: [plugin-turns] }\n');
    const first = validateProductManifests(folder);
    if (!first.ok || first.value === undefined) throw new Error(JSON.stringify(first));
    expect(await publishValidatedManifests(owner, first.value)).toBeGreaterThan(0);
    const before = await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.workflow-stage', ['position']));
    expect(before.map(row => row.key)).toEqual([{ name: 'plugin-turns' }]);
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  alpha: { status: planned, stages: [plugin-turns, fixture-second] }\n');
    const second = validateProductManifests(folder);
    if (!second.ok || second.value === undefined) throw new Error(JSON.stringify(second));
    expect(await publishValidatedManifests(owner, second.value)).toBeGreaterThan(0);
    const after = await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.workflow-stage', ['position']));
    expect(after.map(row => [row.key['name'], row.values['position']]).sort())
      .toEqual([['fixture-second', 1], ['plugin-turns', 0]]);
    expect(after.find(row => row.key['name'] === 'plugin-turns')!.uid).toBe(before[0]!.uid);
    // The third call checks the unchanged fingerprint shortcut, not stage matching.
    expect(await publishValidatedManifests(owner, second.value)).toBe(0);
  } finally { reader.mockRestore(); await owner.close(); }
}, 30_000);

test('workflow stages are protected metadata with parent edges, identities and declaration evidence', async () => {
  const folder = fixture();
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  alpha: { status: planned, stages: [plugin-turns] }\n  beta: { status: planned, stages: [plugin-turns] }\n');
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    const read = validateProductManifests(folder);
    if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
    expect(read.value.manifest.kinds.has('manifest.workflow-stage')).toBe(false);
    const stage = manifestDeclaration('workflow-stage');
    const parent = manifestDeclaration('workflow');
    const edge = stage.keyEdges![0]!;
    expect(read.value.vertices.filter(draft => draft.kind === stage.name)).toHaveLength(2);
    expect(await publishValidatedManifests(owner, read.value)).toBeGreaterThan(0);
    const rows = await owner.run(tx => readKindAssertions(tx, 'vertex', stage.name, ['position', 'declaration']));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.uid)).size).toBe(2);
    expect(rows.map(row => row.values['position'])).toEqual([0, 0]);
    const relations = await owner.run(tx => tx.query<{ stage: string; workflow: string; kind: string }>(`SELECT s.uid::text AS stage,p.key->>'name' AS workflow,pk.name AS kind FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node s ON s.id=e.from_node JOIN node p ON p.id=e.to_node JOIN entity pk ON pk.id=p.entity_id WHERE ek.name=$1 ORDER BY workflow`, [edge.edge]));
    expect(relations.rows.map(row => [row.workflow, row.kind])).toEqual([['alpha', parent.name], ['beta', parent.name]]);
    const lineage = await owner.run(tx => loadAssertions(tx, 'vertex', stage.name, ['position']));
    expect(lineage).toHaveLength(2);
    expect(lineage.every(assertion => assertion.evidence.length === 1)).toBe(true);
    expect(await publishValidatedManifests(owner, read.value)).toBe(0);
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  alpha: { status: planned, stages: [plugin-turns] }\n  beta: { status: planned, stages: [] }\n');
    const changed = validateProductManifests(folder);
    if (!changed.ok || changed.value === undefined) throw new Error(JSON.stringify(changed));
    expect(await publishValidatedManifests(owner, changed.value)).toBeGreaterThan(0);
    const remaining = await owner.run(tx => readKindAssertions(tx, 'vertex', stage.name, ['position']));
    expect(remaining.map(row => row.uid)).toEqual([relations.rows[0]!.stage]);
    expect(await publishValidatedManifests(owner, changed.value)).toBe(0);
  } finally { await owner.close(); }
}, 30_000);

test('reports all invalid declarations with full paths and retains the last valid publication on refresh', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  const reports: string[] = [];
  const watch = createManifestWatch([], async (value) => { await publishValidatedManifests(owner, value); }, (line) => reports.push(line));
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    await watch.refresh(folder);
    writeFolderManifest(folder, 'kinds:\n  bad: { source: unknown, template: missing.md }\n');
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  broken: { status: wrong, stages: [unknown] }\n');
    const read = validateProductManifests(folder);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('invalid manifests accepted');
    expect(read.findings.some((one) => one.file === join(folder, 'madarch/kinds/fixture/fixture/bad.yaml'))).toBe(true);
    expect(read.findings.some((one) => one.file === join(folder, 'madarch', 'workflows.yaml'))).toBe(true);
    expect(read.findings.every((one) => one.line > 0)).toBe(true);
    await watch.refresh(folder);
    expect(reports.length).toBeGreaterThan(1);
    expect([...((await owner.run((tx) => readPublishedManifest(tx)))!.kinds.keys())]).toEqual(['term']);
    writeFolderManifest(folder, 'kinds: {}\n');
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows: {}\n');
    await watch.refresh(folder);
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.kinds.size).toBe(0);
    const rows = await owner.run(tx => readKindAssertions(tx, 'vertex', 'manifest.kind', []));
    expect(rows).toEqual([]);
  } finally { watch.stop(); await owner.close(); }
}, 30_000);

test('filesystem watcher publishes a valid edit and refuses invalid edits without losing metadata', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  const reports: string[] = [];
  let publications = 0;
  let resolvePublished: (() => void) | undefined;
  let resolveRefused: (() => void) | undefined;
  const watcher = createManifestWatch([folder], async (value) => {
    await publishValidatedManifests(owner, value);
    publications++;
    resolvePublished?.();
  }, (line) => { reports.push(line); resolveRefused?.(); });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    await watcher.refresh(folder);
    const published = new Promise<void>((done) => { resolvePublished = done; });
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  later: { status: planned, stages: [] }\n');
    await published;
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.workflows!.workflows.has('later')).toBe(true);
    resolvePublished = undefined;
    const refused = new Promise<void>((done) => { resolveRefused = done; });
    writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows:\n  invalid: { status: incorrect }\n');
    await refused;
    expect(reports.some((line) => line.includes('workflows.yaml:2:'))).toBe(true);
    expect((await owner.run((tx) => readPublishedManifest(tx)))!.workflows!.workflows.has('later')).toBe(true);
    expect(publications).toBeGreaterThan(1);
  } finally { watcher.stop(); await owner.close(); }
}, 30_000);

test('a home watcher discovers the current folder when the startup folder has already moved', async () => {
  const folder = fixture();
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: startup-fixture\nname: fixture\n');
  const moved = join(root, 'startup-renamed');
  renameSync(folder, moved);
  const publications: string[] = [];
  const watcher = createManifestWatch([folder], async (value) => { publications.push(value.folder); }, () => {}, root);
  try {
    for (let tries = 0; tries < 200 && !publications.includes(moved); tries++) await Bun.sleep(25);
    expect(publications, `${moved}:1: the startup rename was not published`).toContain(moved);
    writeFileSync(join(moved, 'madarch', 'workflows.yaml'), 'workflows: {}\n');
    const before = publications.length;
    for (let tries = 0; tries < 200 && publications.length === before; tries++) await Bun.sleep(25);
    expect(publications.length, `${moved}:1: the startup rename was not watched`).toBeGreaterThan(before);
  } finally { watcher.stop(); }
}, 15_000);

test('a home watcher follows a renamed product and keeps its watch while its identity needs repair', async () => {
  const folder = fixture();
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: fixture\nname: fixture\n');
  const moved = join(root, 'renamed');
  const publications: string[] = [];
  const reports: string[] = [];
  const watcher = createManifestWatch([folder], async (value) => { publications.push(value.folder); }, (line) => reports.push(line), root);
  const until = async (ready: () => boolean): Promise<void> => {
    for (let tries = 0; tries < 200; tries++) {
      if (ready()) return;
      await Bun.sleep(25);
    }
    throw new Error(`${moved}:1: watcher did not settle: ${reports.join('; ')}`);
  };
  try {
    renameSync(folder, moved);
    await until(() => publications.includes(moved));
    writeFileSync(join(moved, 'workspace.yaml'), 'schemaVersion: 1\nid: [invalid\n');
    // A change to the home asks discovery to read the broken identity.
    const signal = join(root, 'signal'); mkdirSync(signal);
    await until(() => reports.some((line) => line.includes(`${moved}/workspace.yaml:2:`)));
    const before = publications.length;
    writeFileSync(join(moved, 'workspace.yaml'), 'schemaVersion: 1\nid: fixture\nname: repaired\n');
    writeFileSync(join(moved, 'madarch', 'workflows.yaml'), 'workflows: {}\n');
    await until(() => publications.length > before);
    expect(publications.slice(before)).toContain(moved);
    expect(reports.some((line) => line.includes(`${moved}/workspace.yaml:2:`))).toBe(true);
  } finally { watcher.stop(); }
}, 15_000);

test('malformed kinds still reports workflow and lock diagnostics, and no commit is refused', () => {
  const folder = fixture();
  writeFileSync(join(folder, 'madarch/catalog.yaml'), 'groups: [');
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows: [');
  writeFileSync(join(folder, 'madarch', 'plugins.lock'), 'plugins: [');
  const invalid = validateProductManifests(folder);
  expect(invalid.ok).toBe(false);
  if (invalid.ok) throw new Error('invalid manifests accepted');
  for (const name of ['catalog.yaml', 'workflows.yaml', 'plugins.lock']) expect(invalid.findings.some((one) => one.file === join(folder, 'madarch', name))).toBe(true);
  const fresh = fixture();
  rmSync(join(fresh, '.git'), { recursive: true });
  const noCommit = validateProductManifests(fresh);
  expect(noCommit.ok).toBe(false);
  if (noCommit.ok) throw new Error('no commit accepted');
  expect(noCommit.findings[0]!.file).toBe(join(fresh, '.git', 'HEAD'));
});

test('an absent kinds manifest is valid without publishing a catalogue, but invalid declarations still refuse', () => {
  const folder = fixture();
  rmSync(join(folder, 'madarch', 'catalog.yaml'));
  rmSync(join(folder, 'madarch/kinds'), { recursive: true, force: true });
  expect(validateProductManifests(folder)).toEqual({ ok: true, value: undefined });
  writeFileSync(join(folder, 'madarch', 'workflows.yaml'), 'workflows: [');
  const invalid = validateProductManifests(folder);
  expect(invalid.ok).toBe(false);
  if (invalid.ok) throw new Error('invalid workflow accepted without kinds');
  expect(invalid.findings.some((one) => one.file === join(folder, 'madarch', 'workflows.yaml'))).toBe(true);
});

test('named plugin manifests use the existing plugin validator for missing and malformed files', () => {
  const folder = fixture();
  mkdirSync(join(folder, 'plugins', 'words'), { recursive: true });
  writeFolderManifest(folder, `plugins:
  - id: words
    version: "1"
    path: plugins/words
    inputs: [term]
    outputs: [term]
    closure: [main.ts]
kinds:
  term:
    source: document
    
    terms: ["docs/*.md"]
`);
  const file = join(folder, 'plugins', 'words', 'plugin.json');
  const missing = validateProductManifests(folder);
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error('missing plugin accepted');
  expect(missing.findings.some((one) => one.file === file)).toBe(true);
  writeFileSync(file, '{ "name": 7 }');
  const malformed = validateProductManifests(folder);
  expect(malformed.ok).toBe(false);
  if (malformed.ok) throw new Error('malformed plugin accepted');
  expect(malformed.findings.some((one) => one.file === file && one.line === 1 && one.message.length > 0)).toBe(true);
});

test('the published declarations answer before any fill, even after the checkout changes', async () => {
  const folder = fixture();
  writeFolderManifest(folder, `properties:
  summary: { en: Summary, ru: Описание }
kinds:
  term:
    source: document
    
    terms: ["docs/*.md"]
    details: [summary]
    fields:
      - { name: summary, type: text, producers: [reader] }
`);
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    const validated = validateProductManifests(folder);
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    await publishValidatedManifests(owner, validated.value);
    writeFolderManifest(folder, 'kinds: {}');
    const manifest = (await owner.run((tx) => readPublishedManifest(tx)))!;
    // The graph's published manifest is the one that answers: the checkout's later edit changes nothing.
    expect([...manifest.kinds.keys()]).toEqual(['term']);
    expect(manifest.kinds.get('term')?.fields?.map((field) => field.name)).toEqual(['summary']);
    expect(graphqlSchemaOf(publishedManifestOf(manifest))).toContain('type KindTerm implements Entity');
    const contents = await owner.run((tx) => tx.query<{ count: string }>("SELECT count(*)::text AS count FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'code.file'"));
    expect(contents.rows[0]!.count).toBe('0');
  } finally { await owner.close(); }
}, 30_000);

test('purpose labels and order publish through the manifest watcher without a fill', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  const reports: string[] = [];
  const watch = createManifestWatch([], async (value) => { await publishValidatedManifests(owner, value); }, (line) => reports.push(line));
  const declaration = (label: string, order: number) => `purposes:
  understand: { labels: { en: ${label}, ru: Понять }, order: ${order} }
kinds:
  term:
    purpose: understand
    source: document
    
    terms: ["docs/*.md"]
`;
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    writeFolderManifest(folder, declaration('Understand', 10));
    await watch.refresh(folder);
    let published = await owner.run((tx) => readPublishedManifest(tx));
    expect(published?.kinds.get('term')?.purpose).toBe('understand');
    expect(published?.purposes?.get('understand')?.labels.en).toBe('Understand');
    writeFolderManifest(folder, declaration('Read first', 50));
    await watch.refresh(folder);
    published = await owner.run((tx) => readPublishedManifest(tx));
    expect(published?.purposes?.get('understand')?.labels.en).toBe('Read first');
    expect(published?.purposes?.get('understand')?.order).toBe(50);
    expect(reports).toEqual([]);
  } finally { watch.stop(); await owner.close(); }

}, 30_000);

test('startup binding gives its new operation exactly one author, its principal', async () => {
  const contract = withManifestContract(EMPTY_CONTRACT);
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', async tx => {
      const { binding } = await startupBinding(tx, contract, 'x');
      const authors = await tx.query<{ uid: string }>(`
        SELECT author.uid::text AS uid FROM edge e
        JOIN entity k ON k.id=e.entity_id AND k.name='system.operation-author'
        JOIN node operation ON operation.id=e.from_node
        JOIN node author ON author.id=e.to_node
        WHERE operation.uid=$1::uuid`, [binding.operationUid]);
      expect(authors.rows).toEqual([{ uid: binding.principalUid }]);
    });
  } finally { await owner.close(); }
});

test('startup binding keeps product, source and principal identities and renews only the operation', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    const first = await owner.transaction('write', tx => startupBinding(tx, withManifestContract(EMPTY_CONTRACT), 'manifest'));
    const second = await owner.transaction('write', tx => startupBinding(tx, withManifestContract(EMPTY_CONTRACT), 'manifest'));
    for (const key of ['productUid', 'sourceUid', 'principalUid'] as const) {
      expect(second.binding[key]).toBe(first.binding[key]);
      expect(first.binding[key][14]).toBe('7');
    }
    expect(second.binding.operationUid).not.toBe(first.binding.operationUid);
    expect(first.binding.operationUid[14]).toBe('7');
    const other = await owner.transaction('write', tx => startupBinding(tx, withManifestContract(EMPTY_CONTRACT), 'start'));
    expect(other.binding.productUid).toBe(first.binding.productUid);
    expect(other.binding.principalUid).toBe(other.binding.sourceUid);
    expect(other.binding.principalUid).not.toBe(first.binding.principalUid);
    expect(other.binding.sourceUid).not.toBe(first.binding.sourceUid);
    const personContract = withAssertionContract(withManifestContract(EMPTY_CONTRACT));
    const personGrant = await personBinding(owner, personContract);
    const person = { binding: await owner.transaction('write', tx => activateGraphProducer(tx, personContract, personGrant)) };
    const samePersonGrant = await personBinding(owner, personContract);
    const samePerson = { binding: await owner.transaction('write', tx => activateGraphProducer(tx, personContract, samePersonGrant)) };
    expect(person.binding.principalUid).toBe(samePerson.binding.principalUid);
    expect(person.binding.principalUid).not.toBe(first.binding.principalUid);
    expect(person.binding.principalUid[14]).toBe('7');
    expect(person.binding.sourceUid).toBe(person.binding.principalUid);
    expect(samePerson.binding.sourceUid).toBe(person.binding.sourceUid);
    expect(person.binding.sourceUid).not.toBe(first.binding.sourceUid);
    const identity = await owner.run(tx => tx.query<{ kind: string }>('SELECT k.name AS kind FROM node n JOIN entity k ON k.id=n.entity_id WHERE n.uid=$1::uuid', [person.binding.principalUid]));
    expect(identity.rows).toEqual([{ kind: 'person' }]);
  } finally { await owner.close(); }
});

test('plugin release changes preserve one source while distinct actors persist across store sessions', async () => {
  const contract = { vertex: [{ name: 'fixture.release', table: generatedTableName('fixture.release', 'vertex'), capability: 'fixture', key: ['name'], fields: [{ name: 'name', type: 'text' as const }, { name: 'observed', type: 'text' as const }] }], edge: [], dictionary: [] };
  const options = { store: mkdtempSync(join(root, 'identities-')), graphContract: contract };
  let owner = await createTestDatabaseOwner(options);
  const actorContract = withAssertionContract(contract);
  const actorBinding = async (installation: string) => {
    const uid = await owner.transaction('write', async tx => {
      await startupBinding(tx, actorContract, 'fixture-person-installer');
      const found = (await readKindAssertions(tx, 'vertex', 'person', ['installation'])).filter(row => row.values['installation'] === installation);
      if (found.length > 1) throw new Error(`${import.meta.path}:390: duplicate fixture person ${installation}`);
      const uid = found[0]?.uid ?? newUid();
      await publishGraphDrafts(tx, actorContract, { vertices: [{ kind: 'person', uid, key: {}, values: { installation, label: installation, scope: 'fixture', version: '1' }, producer: 'fixture-person-installer', producerVersion: '1' }], removals: [] });
      return uid;
    });
    const principal = await registerGraphPrincipal(owner, { producer: `person:${uid}`, version: '1', uid, kind: 'person', sourceUid: uid, principalUid: uid, scope: 'fixture' });
    const grant = bindGraphProducer(owner, actorContract, { principal, vertices: { 'fixture.release': ['name', 'observed'] }, edges: {} });
    return { binding: await owner.transaction('write', tx => activateGraphProducer(tx, actorContract, grant)) };
  };
  try {
    const release = async (version: string) => await owner.transaction('write', async tx => {
      const authenticated = await startupBinding(tx, contract, 'fixture-plugin');
      bindWriteCapability(tx, authenticated.binding);
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'fixture.release', key: { name: 'release' }, values: { observed: version }, producer: 'fixture-plugin', producerVersion: version }], removals: [] });
      return authenticated.binding;
    });
    const first = await release('1.0.0');
    const upgraded = await release('2.0.0');
    expect(upgraded.sourceUid).toBe(first.sourceUid);
    expect(upgraded.principalUid).toBe(first.principalUid);
    const firstPerson = await actorBinding('first-person');
    const secondPerson = await actorBinding('second-person');
    expect(secondPerson.binding.principalUid).not.toBe(firstPerson.binding.principalUid);
    expect(secondPerson.binding.sourceUid).toBe(secondPerson.binding.principalUid);
    expect(secondPerson.binding.sourceUid).not.toBe(firstPerson.binding.sourceUid);
    expect(firstPerson.binding.sourceUid).not.toBe(first.sourceUid);
    const assertions = await owner.run(tx => loadAssertions(tx, 'vertex', 'fixture.release', ['observed']));
    expect(assertions.map(assertion => assertion.value)).toEqual(['1.0.0', '2.0.0']);
    expect(new Set(assertions.map(assertion => assertion.source))).toEqual(new Set([first.sourceUid]));
    await owner.close();
    owner = await createTestDatabaseOwner(options);
    const reopened = await owner.transaction('write', tx => startupBinding(tx, contract, 'fixture-plugin'));
    const reopenedFirst = await actorBinding('first-person');
    const reopenedSecond = await actorBinding('second-person');
    expect(reopened.binding.productUid).toBe(first.productUid);
    expect(reopened.binding.sourceUid).toBe(first.sourceUid);
    expect(reopened.binding.principalUid).toBe(first.principalUid);
    expect(reopenedFirst.binding.principalUid).toBe(firstPerson.binding.principalUid);
    expect(reopenedSecond.binding.principalUid).toBe(secondPerson.binding.principalUid);
    expect(reopenedSecond.binding.principalUid).not.toBe(reopenedFirst.binding.principalUid);
  } finally { await owner.close(); }
}, 30_000);

test('repeat publication adds no snapshot or declaration assertions', async () => {
  const folder = fixture();
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(EMPTY_CONTRACT) });
  try {
    await createOneGraphSchema(owner, withManifestContract(EMPTY_CONTRACT));
    const read = validateProductManifests(folder);
    if (!read.ok || read.value === undefined) throw new Error(JSON.stringify(read));
    await publishValidatedManifests(owner, read.value);
    const count = async () => await owner.run(async tx => (await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM assertion_vertex_subject s JOIN edge e ON e.id=s.subject_edge_id JOIN node n ON n.id=e.to_node JOIN entity k ON k.id=n.entity_id WHERE k.name LIKE 'manifest.%' OR k.name='system.content-snapshot'`)).rows[0]!.count);
    const first = await count();
    expect(await publishValidatedManifests(owner, read.value)).toBe(0);
    expect(await count()).toBe(first);
  } finally { await owner.close(); }
}, 30_000);
