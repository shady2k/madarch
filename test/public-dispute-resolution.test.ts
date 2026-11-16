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
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { callProductTool } from '../src/mcp/authored.js';
import {readDispute} from '../src/graph/dispute-read.js';
import { withAssertionContract } from '../src/graph/system-contract.js';

const evidenceContent = 'Manual operation evidence snapshot';
const evidenceDigest = createHash('sha256').update(evidenceContent).digest('hex');
const source = (operationId: string): WriteSource => ({ producer: 'manual-fixture', version: '1', operationId });
const request = (name: string, size: unknown = 7): ManualRequest => ({ kind: 'put-entity', input: {
  kind: 'demo.repository', key: { name }, values: { size },
  evidence: [{ target: { kind: 'demo.snapshot', key: { digest: evidenceDigest } }, relation: 'supports' }],
} });

async function fixture(work: (owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>, manifests: import('../src/graph/manifest-publication.js').ValidatedManifests) => Promise<void>) {
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
    await work(owner, validated.value);
  } finally { await owner?.close(); rmSync(folder, { recursive: true, force: true }); }
}


test('public MCP resolution authenticates person, refuses stale values, replays a receipt and retains operation lineage', async () => {
  await fixture(async (owner, manifests) => {
    const product = new KnowledgeProduct({ productFolder: '/unused-fixture', storeRoot: '/unused-fixture' });
    // Keep the production public API and durable dispatcher; this fixture already installed the store.
    Object.defineProperty(product, 'open', { value: async () => owner });
    const input = request('disputed');
    const { registerSystemSource } = await import('../src/graph/system-installation.js');
    const { bindGraphProducer } = await import('../src/graph/producer-binding.js');
    const fixtureContract = await owner.transaction('snapshot', async tx => withAssertionContract(writeContractOf((await (await import('../src/graph/manifest-publication.js')).readPublishedManifest(tx))!)));
    const grant = async (name: string) => {
      const installed = await registerSystemSource(owner, fixtureContract, { type: 'plugin', installationKey: name, scope: 'fixture', version: '1' });
      return bindGraphProducer(owner, fixtureContract, { principal: installed.principal, vertices: { 'demo.repository': ['size'] }, edges: {} });
    };
    await executeManualOperation(owner, source('first'), input, await grant('first'));
    const rival = { ...source('second'), producer: 'other-fixture' };
    await executeManualOperation(owner, rival, request('disputed', 8), await grant('second'));
    const view = async () => await owner.transaction('snapshot', async tx => {
      const manifest = (await import('../src/graph/manifest-publication.js')).readPublishedManifest;
      const declared = withAssertionContract(writeContractOf((await manifest(tx))!));
      const rows = await loadAssertions(tx, 'vertex', 'demo.repository', ['size']);
      return await readDispute(tx, declared, rows, { validAt: new Date().toISOString(), recordedAt: new Date().toISOString(), contexts: [1] });
    });
    const question = (await view())!;
    expect(question.candidates).toHaveLength(2);
    const args = { operationKey: 'resolution', questionUid: question.id, chosenAssertionUid: question.candidates[0]!, expectedCandidates: question.candidates, rationale: 'The first source was verified against the immutable snapshot.', evidence: [{ target: { kind: 'demo.snapshot', key: { digest: evidenceDigest } }, relation: 'supports' }] };
    expect((await callProductTool(product, { producer: 'untrusted', version: 'client' }, 'graph_resolve_dispute', args)).isError).toBe(true);
    expect((await callProductTool(product, source('agent'), 'graph_resolve_dispute', args)).isError).toBe(true);
    await expect(product.resolveDispute(source('direct-agent'), { ...args, evidence: args.evidence }, 'direct-agent', undefined!)).rejects.toThrow('host-issued source binding');
    const { installSystemSources } = await import('../src/graph/system-installation.js');
    const declared = await owner.transaction('snapshot', async tx => withAssertionContract(writeContractOf((await (await import('../src/graph/manifest-publication.js')).readPublishedManifest(tx))!)));
    const { person: installedPerson } = await installSystemSources(owner, declared);
    const resolver = bindGraphProducer(owner, declared, { principal: installedPerson.principal, vertices: { 'demo.repository': ['size'] }, edges: {}, actions: ['resolve'] });
    const identity = (await import('../src/graph/producer-binding.js')).producerIdentityOf(resolver);
    const person: WriteSource = { producer: identity.producer, version: 'session-one' };
    const forgedMetadata = { ...person, principal: { kind: 'system.person', identity: 'forged-host-person' } } as WriteSource;
    expect((await callProductTool(product, forgedMetadata, 'graph_resolve_dispute', args)).isError).toBe(true);
    expect((await callProductTool(product, person, 'graph_resolve_dispute', args, {} as typeof resolver)).isError).toBe(true);
    const badSchema = await callProductTool(product, person, 'graph_resolve_dispute', { ...args, principal: { identity: 'forged' } }, resolver);
    expect(badSchema.isError).toBe(true);
    const stale = await callProductTool(product, person, 'graph_resolve_dispute', { ...args, operationKey: 'stale', expectedCandidates: [question.candidates[0], question.candidates[0]] }, resolver);
    expect(stale.isError).toBe(true);
    const changed = await callProductTool(product, person, 'graph_resolve_dispute', { ...args, operationKey: 'changed', expectedCandidates: [question.candidates[0], '00000000-0000-7000-8000-000000000001'] }, resolver);
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed.answer)).toContain('REVISION_CONFLICT');
    expect((await view())?.state).toBe('OPEN');
    await expect(product.resolveDispute(person, { ...args, evidence: args.evidence }, '', resolver)).rejects.toMatchObject({ field: 'operationKey' });
    await expect(product.resolveDispute(person, { ...args, evidence: args.evidence }, 42 as unknown as string, resolver)).rejects.toMatchObject({ field: 'operationKey' });
    const accepted = await callProductTool(product, person, 'graph_resolve_dispute', args, resolver);
    expect(accepted.isError).toBe(false);
    expect(accepted.answer).toMatchObject({ kind: 'system.dispute-resolution', written: 1 });
    const uid = (accepted.answer as { uid: string }).uid;
    expect((await view())?.resolution).toBe(uid);
    await publishValidatedManifests(owner, manifests);
    const { writeProductEntity } = await import('../src/graph/start-entity.js');
    const startEntity = { kind: 'demo.repository', key: { name: 'fixture-product' }, values: {}, evidence: [] };
    await writeProductEntity(owner, startEntity);
    await writeProductEntity(owner, startEntity);
    await installSystemSources(owner, declared);
    await registerSystemSource(owner, declared, { type: 'plugin', installationKey: 'post-resolution-plugin', scope: 'fixture', version: '1', principalUid: installedPerson.uid });
    const { installAgentSession } = await import('../src/graph/system-installation.js');
    await installAgentSession(owner, declared, 'post-resolution-session');
    expect((await view())?.resolution).toBe(uid);
    const replay = await callProductTool(product, { ...person, version: 'session-two' }, 'graph_resolve_dispute', args, resolver);
    expect(replay).toEqual(accepted);
    const conflict = await callProductTool(product, person, 'graph_resolve_dispute', { ...args, rationale: 'A different decision' }, resolver);
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict.answer)).toContain('IDEMPOTENCY_CONFLICT');
    await owner.run(async tx => {
      const rows = await loadAssertions(tx, 'vertex', 'system.dispute-resolution', ['rationale']);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.author).toBe(installedPerson.uid);
      expect(rows[0]!.source).toBe(installedPerson.uid);
      expect(rows[0]!.operationUid).toBeTruthy();
      expect(rows[0]!.unit).toBeTruthy();
      expect(rows[0]!.evidence).toHaveLength(1);
      const lineage = await tx.query(`SELECT k.name FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node n ON n.id=e.from_node WHERE n.uid=$1::uuid AND k.name IN ('system.operation-unit','system.operation-author') ORDER BY k.name`, [rows[0]!.operationUid]);
      expect(lineage.rows).toHaveLength(2);
    });
  });
}, 30_000);
