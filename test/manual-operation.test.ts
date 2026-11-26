/** Durable manual requests share one dispatcher and preserve authenticated request identity. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDatabaseOwner } from './test-database.js';
import { validateProductManifests, publishValidatedManifests, startupBinding } from '../src/graph/manifest-publication.js';
import { writeContractOf, type WriteSource } from '../src/graph/graph-writes.js';
import { executeManualOperation, type ManualRequest } from '../src/graph/manual-operation.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { createPgBossQueue } from '../src/adapters/pg-boss-queue.js';
import { MANUAL_GRAPH_QUEUE } from '../src/adapters/queue-definition.js';
import { agentBinding, personBinding, registerSystemSource } from '../src/graph/system-installation.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { bindGraphProducer, producerIdentityOf, type ProducerBinding } from '../src/graph/producer-binding.js';
import { canonicalJsonDigest } from '../src/model/canonical.js';

const evidenceContent = 'Manual operation evidence snapshot';
const evidenceDigest = createHash('sha256').update(evidenceContent).digest('hex');
const source = (operationId: string): WriteSource => ({ producer: 'manual-fixture', version: '1', principal: { kind: 'system.plugin', identity: 'manual-test-agent' }, operationId });
const request = (name: string, size: unknown = 7): ManualRequest => ({ kind: 'put-entity', input: {
  kind: 'demo.repository', key: { name }, values: { size },
  evidence: [{ target: { kind: 'demo.snapshot', key: { digest: evidenceDigest } }, relation: 'supports' }],
} });

async function fixture(work: (owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>, grants: { agent: ProducerBinding; person: ProducerBinding; plugin: ProducerBinding }) => Promise<void>) {
  const folder = mkdtempSync(join(tmpdir(), 'manual-operation-'));
  let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>> | undefined;
  try {
    const kinds = join(folder, 'madarch/kinds/demo/core');
    mkdirSync(kinds, { recursive: true });
    writeFileSync(join(folder, 'madarch/catalog.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml')));
    for (const name of ['demo.repository', 'demo.file']) writeFileSync(join(kinds, `${name}.yaml`), readFileSync(join(import.meta.dir, `graphql/fixture-product-${name}.yaml`)));
    writeFileSync(join(kinds, 'demo.snapshot.yaml'), `id: demo.snapshot
purpose: structure
definition: Immutable content used to ground manual operation fixture writes.
sources:
- https://example.test/snapshot
acquisition:
- document
relation-constraints:
  out: []
  in: []
template-policy: none
source: graph
evidence:
  immutable: true
  digestField: digest
  contentField: content
  digestAlgorithm: sha256
labels:
  en:
    one: Snapshot
    many: Snapshots
  ru:
    one: Snapshot
    many: Snapshots
description:
  en: Immutable fixture evidence.
  ru: Immutable fixture evidence.
fields:
- name: digest
  type: text
  producers:
  - agent
- name: content
  type: text
  producers:
  - agent
key:
- digest
`);
    const validated = validateProductManifests(folder, undefined, 'fixture-commit');
    if (!validated.ok) throw new Error(JSON.stringify(validated.findings));
    if (!validated.value) throw new Error('No fixture manifest');
    const contract = writeContractOf(validated.value.manifest);
    owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
    await publishValidatedManifests(owner, validated.value);
    await owner.transaction('write', async tx => {
      await startupBinding(tx, contract, 'evidence-fixture');
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'demo.snapshot', key: { digest: evidenceDigest }, values: { content: evidenceContent }, producer: 'fixture', producerVersion: '1' }], removals: [] });
    });
    const boundContract = withAssertionContract(contract);
    const agent = await agentBinding(owner, boundContract, 'fixture-session');
    const person = await personBinding(owner, boundContract);
    const installed = await registerSystemSource(owner, boundContract, {
      type: 'plugin', installationKey: 'manual-fixture-plugin',
      scope: producerIdentityOf(agent).scope, version: '1',
    });
    const plugin = bindGraphProducer(owner, boundContract, {
      principal: installed.principal,
      vertices: { 'demo.repository': boundContract.vertex.find(kind => kind.name === 'demo.repository')!.fields.map(field => field.name) },
      edges: {},
    });
    await work(owner, { agent, person, plugin });
  } finally { await owner?.close(); rmSync(folder, { recursive: true, force: true }); }
}

async function sizes(owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>) {
  return await owner.run(tx => loadAssertions(tx, 'vertex', 'demo.repository', ['size']));
}

test('manual operation replay returns its receipt without a duplicate assertion or a per-request queue', async () => {
  await fixture(async (owner, grants) => {
    const first = await executeManualOperation(owner, source('stable'), request('accepted'), grants.agent);
    const before = await sizes(owner);
    expect(before).toHaveLength(1);
    const second = await executeManualOperation(owner, { ...source('stable'), version: 'reconnected-session' }, request('accepted'), grants.agent);
    expect(second).toEqual(first);
    expect(await sizes(owner)).toEqual(before);
    const installed = await owner.run(tx => tx.query<{ uid: string }>("SELECT n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='agent' AND n.uid=$1::uuid", [before[0]!.source]));
    expect(installed.rows).toHaveLength(1);
    await expect(executeManualOperation(owner, source('stable'), request('changed'), grants.agent)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('IDEMPOTENCY_CONFLICT') });
    expect(await sizes(owner)).toEqual(before);
    const queues = await owner.run(tx => tx.query<{ name: string }>('SELECT name FROM pgboss.queue ORDER BY name'));
    expect(queues.rows.filter(row => row.name.startsWith('manual'))).toEqual([{ name: 'manual-graph-operations' }]);
    const evidence = await owner.run(tx => tx.query("SELECT e.id FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='system.assertion-evidence'"));
    expect(evidence.rows.length).toBeGreaterThan(0);
  });
}, 30_000);

test('a dispatcher refuses unretained queued authority and concurrent callers retain their own answers', async () => {
  await fixture(async (owner, grants) => {
    const queue = await createPgBossQueue({ owner, supervise: false });
    try {
      await queue.declare(MANUAL_GRAPH_QUEUE);
      const foreign = source('foreign');
      // Leave the durable job behind as a caller lost before dispatch would.
      await queue.enqueue({ queue: 'manual-graph-operations', singletonKey: canonicalJsonDigest({ sourceUid: producerIdentityOf(grants.agent).sourceUid, operationId: foreign.operationId }), data: { source: foreign, operation: request('foreign'), identity: canonicalJsonDigest({ sourceUid: producerIdentityOf(grants.agent).sourceUid, operationId: foreign.operationId }) } });
      await queue.stop();
      const answers = await Promise.allSettled(['first', 'second'].map(id => executeManualOperation(owner, source(id), request(id), grants.agent)));
      for (const [index, answer] of answers.entries()) {
        const id = ['first', 'second'][index]!;
        if (answer.status === 'rejected') expect(answer.reason).toMatchObject({ status: 409 });
        const result = answer.status === 'fulfilled' ? answer.value : await executeManualOperation(owner, source(id), request(id), grants.agent);
        expect(result.key).toEqual({ name: id });
      }
      expect(await sizes(owner)).toHaveLength(2);
      const replay = await executeManualOperation(owner, foreign, request('foreign'), grants.agent);
      expect(replay.key).toEqual({ name: 'foreign' });
      expect(await sizes(owner)).toHaveLength(3);
    } finally { await queue.stop(); }
  });
}, 30_000);

test('manual operations attribute distinct authenticated actors through author edges', async () => {
  await fixture(async (owner, grants) => {
    await executeManualOperation(owner, source('agent-authored'), request('agent-authored'), grants.agent);
    await executeManualOperation(owner, { ...source('person-authored'), producer: 'person-fixture', principal: { kind: 'system.person', identity: 'reader@example.test' } }, request('person-authored'), grants.person);
    const authors = await owner.run(tx => tx.query<{ kind: string; uid: string }>(`SELECT DISTINCT k.name AS kind,n.uid::text AS uid FROM edge e JOIN entity ek ON ek.id=e.entity_id JOIN node n ON n.id=e.to_node JOIN entity k ON k.id=n.entity_id WHERE ek.name='system.operation-author' ORDER BY kind,uid`));
    expect(authors.rows.some(row => row.kind === 'person' && row.uid === producerIdentityOf(grants.person).principalUid)).toBe(true);
    expect(authors.rows.every(row => row.kind !== 'system.person')).toBe(true);
    const assertions = await sizes(owner);
    expect(new Set(assertions.map(row => row.source)).size).toBe(2);
  });
}, 30_000);

test('a stale manual precondition refuses the whole write without a new assertion', async () => {
  await fixture(async (owner, grants) => {
    const created = await executeManualOperation(owner, source('create-guarded'), request('guarded'), grants.agent);
    if (!created.uid) throw new Error('The accepted write returned no identity');
    const before = await sizes(owner);
    const stale: ManualRequest = { ...request('guarded', 8), preconditions: [{ uid: created.uid, recordedSequence: '0' }] };
    await expect(executeManualOperation(owner, source('stale-guarded'), stale, grants.agent)).rejects.toThrow('REVISION_CONFLICT');
    expect(await sizes(owner)).toEqual(before);
  });
}, 30_000);

test('invalid manual input and absent authenticated request identity leave no half fact', async () => {
  await fixture(async (owner, grants) => {
    await expect(executeManualOperation(owner, { producer: 'manual-fixture', version: '1' }, request('anonymous'), grants.agent)).rejects.toThrow('request identity');
    await expect(executeManualOperation(owner, { producer: 'manual-fixture', version: '1', operationId: 'no-principal' }, request('no-principal'), { ...grants.agent } as ProducerBinding)).rejects.toThrow('host-issued source binding');
    await expect(executeManualOperation(owner, source('invalid'), request('invalid', 'seven'), grants.agent)).rejects.toThrow('integer');
    expect(await sizes(owner)).toEqual([]);
    const nodes = await owner.run(tx => tx.query("SELECT n.uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='demo.repository' AND n.key->>'name' IN ('anonymous','invalid','no-principal')"));
    expect(nodes.rows).toEqual([]);
  });
}, 30_000);

test('manual authority comes from the installed plugin grant, not caller producer or principal metadata', async () => {
  await fixture(async (owner, grants) => {
    const spoofed = { ...source('plugin-request'), producer: 'person:invented', principal: { kind: 'system.person' as const, identity: 'invented@example.test' } };
    const first = await executeManualOperation(owner, spoofed, request('plugin-authored'), grants.plugin);
    const before = await sizes(owner);
    expect(before).toHaveLength(1);
    expect(before[0]!.source).toBe(producerIdentityOf(grants.plugin).sourceUid);
    expect(before[0]!.author).toBe(producerIdentityOf(grants.plugin).principalUid);
    expect(await executeManualOperation(owner, { ...source('plugin-request'), producer: 'another-display-label' }, request('plugin-authored'), grants.plugin)).toEqual(first);
    expect(await sizes(owner)).toEqual(before);
    const installed = await owner.run(tx => tx.query<{ uid: string }>("SELECT n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='plugin' AND n.uid=$1::uuid", [before[0]!.source]));
    expect(installed.rows).toHaveLength(1);
  });
}, 30_000);

test('missing, copied and foreign-owner manual grants refuse before any graph write', async () => {
  await fixture(async (owner, grants) => {
    await fixture(async (_foreignOwner, foreignGrants) => {
      const counts = async () => await owner.run(tx => tx.query<{ nodes: string; edges: string; assertions: string }>(
        'SELECT (SELECT count(*)::text FROM node) AS nodes, (SELECT count(*)::text FROM edge) AS edges, (SELECT count(*)::text FROM assertion) AS assertions',
      ));
      const before = await counts();
      await expect(executeManualOperation(owner, source('missing-grant'), request('missing-grant'), undefined as unknown as ProducerBinding)).rejects.toThrow('host-issued source binding');
      expect(await counts()).toEqual(before);
      await expect(executeManualOperation(owner, source('copied-grant'), request('copied-grant'), { ...grants.agent } as ProducerBinding)).rejects.toThrow('host-issued source binding');
      expect(await counts()).toEqual(before);
      await expect(executeManualOperation(owner, source('foreign-grant'), request('foreign-grant'), foreignGrants.agent)).rejects.toThrow('another product');
      expect(await counts()).toEqual(before);
      expect(await sizes(owner)).toEqual([]);
    });
  });
}, 60_000);
