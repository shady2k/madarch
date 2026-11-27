/**
 * The starter catalogue's new kinds are entities a reader reaches (madarch-64o5.109, .114 and .115): a product made
 * with the `everything` template publishes its catalogue, and the catalogue page lists the access kinds, the behaviour
 * kinds and the decision kinds the owner agreed. This is the acceptance walk the change record names.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDraft } from '../src/product/draft.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { executeGraphql, type MessageBody } from '../src/graph/graphql-execute.js';
import { vanishedCurrentEvidence } from '../src/graph/records.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { sha256Hex } from '../src/graph/digest.js';
import { byCodePoint } from '../src/model/order.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

test('a starter product publishes its catalogue and distinguishes starter evidence from stale source evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-catalogue-kinds-'));
  let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>> | undefined;
  try {
    const draft = createDraft({ home: root, name: 'catalogue-kinds', template: 'everything', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    const folder = draft.folder;
    const validation = validateProductManifests(folder);
    if (!validation.ok) throw new Error(validation.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
    if (validation.value === undefined) throw new Error(`${folder}:1: no manifest`);
    const manifest = validation.value.manifest;
    const contract = graphContractOf(manifest);
    const installed = withManifestContract(contract);
    owner = await createTestDatabaseOwner({ graphContract: installed });
    await publishValidatedManifests(owner, validation.value);
    const fresh = await vanishedCurrentEvidence(owner, contract, { limit: 1000 });
    expect(fresh.rows).toHaveLength(0);
    expect(fresh.next).toBeUndefined();
    // The page also lists the protected engine kinds the catalogue's declarations name (decision 0039, item 9):
    // `system.product`, the root every kind derives from after R1 (the owner's decision of 2026-11-19, 0b5028570), and
    // `system.problem`, the end of `task-problem`. Both are one vertex each, not duplicates of catalogue kinds.
    // The names themselves, not a count (ALX-531): a catalogue that lost `system.problem` and showed another protected
    // kind instead would keep the count, and the per-kind checks below reach none of the two.
    const declared = new Set([...manifest.kinds.keys(), ...manifest.catalog!.kinds.keys()]);
    const expectedNames = [...declared, 'system.product', 'system.problem'].sort(byCodePoint);
    const listedNames: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await executeGraphql(owner, { manifest, folder }, {
        query: 'query ($after: String) { allCatalogueEntity(first: 200, after: $after) { pageInfo { hasNextPage endCursor } edges { node { name } } } }',
        variables: { after },
      });
      const body = page.body as MessageBody;
      if (body.errors !== undefined) throw new Error(`${folder}:1: GraphQL HTTP ${String(page.status)}: ${JSON.stringify(body.errors)}`);
      const held = (body.data as { allCatalogueEntity: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { node: { name: string } }[] } }).allCatalogueEntity;
      for (const edge of held.edges) listedNames.push(edge.node.name);
      if (!held.pageInfo.hasNextPage) break;
      after = held.pageInfo.endCursor;
    }
    expect([...listedNames].sort(byCodePoint)).toEqual(expectedNames);
    // Every kind the owner agreed is a catalogue entity a reader reaches, with its name in both languages.
    for (const kind of ['person', 'role', 'permission', 'iam-role', 'activity', 'activity-node', 'class-diagram', 'logical-data-model', 'use-case-step', 'scenario-step', 'process-event', 'state-machine', 'state-event', 'proposed-kind', 'doc.decision', 'business-process', 'runtime-scenario', 'work-span', 'container-health-check']) {
      const page = await executeGraphql(owner, { manifest, folder }, { query: `{ catalogueEntity(name: "${kind}", lang: "ru") { name label } }` });
      const body = page.body as MessageBody;
      if (body.errors !== undefined) throw new Error(`${folder}: GraphQL HTTP ${String(page.status)}: ${JSON.stringify(body.errors)}`);
      expect([kind, (body.data as { catalogueEntity: { name: string } | null }).catalogueEntity?.name]).toEqual([kind, kind]);
    }
    const role = await executeGraphql(owner, { manifest, folder }, { query: '{ catalogueEntity(name: "role", lang: "ru") { label definition } }' });
    expect((role.body as MessageBody).data).toMatchObject({ catalogueEntity: { label: 'Роль' } });
    const person = await executeGraphql(owner, { manifest, folder }, { query: '{ catalogueEntity(name: "person", lang: "ru") { label } }' });
    expect((person.body as MessageBody).data).toMatchObject({ catalogueEntity: { label: 'Человек' } });
    const permission = await executeGraphql(owner, { manifest, folder }, { query: '{ catalogueEntity(name: "permission", lang: "ru") { label } }' });
    expect((permission.body as MessageBody).data).toMatchObject({ catalogueEntity: { label: 'Право' } });

    const repository = { kind: 'code.repository', key: { name: 'example' } };
    const file = { kind: 'code.file', key: { path: 'example.txt' }, keyEdges: { 'code.file-repository': repository } };
    const blob = (content: string) => ({ kind: 'code.blob', key: { digest: sha256Hex(Buffer.from(content)) }, values: { content } });
    const original = blob('original bytes');
    const replacement = blob('updated bytes');
    const unsupported = blob('bytes without a source file');
    const producer = { producer: 'fixture', producerVersion: '1' };
    const support = { kind: 'code.blob-about', from: original, to: file, ...producer };
    const idea = (identifier: string, target: ReturnType<typeof blob>) => ({
      kind: 'idea', key: { identifier }, values: { title: identifier, status: 'proposed' }, evidence: [{ target }],
    });
    const evidenceContract = {
      ...contract,
      vertex: contract.vertex.filter(({ name }) => name === 'idea' || name === 'code.blob'),
      edge: contract.edge.filter(({ name }) => name === support.kind),
    };
    await owner.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, installed, {
        vertices: [repository, file, original, unsupported, idea('original', original), idea('unsupported', unsupported)]
          .map((vertex) => ({ ...vertex, ...producer })),
        edges: [support], removals: [],
      });
    });
    const current = await vanishedCurrentEvidence(owner, evidenceContract);
    expect(current.rows.length).toBeGreaterThan(0);
    expect(current.rows.every((row) => row.key['identifier'] === 'unsupported' && row.applicability === 'unavailable'
      && row.state.currentApplicability === 'unknown' && row.state.availability === 'available')).toBe(true);

    await owner.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, installed, {
        vertices: [{ ...replacement, ...producer }],
        edges: [{ ...support, from: replacement }], edgeRemovals: [support], removals: [],
      });
    });
    const changed = await vanishedCurrentEvidence(owner, evidenceContract);
    const stale = changed.rows.filter((row) => row.key['identifier'] === 'original');
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((row) => row.evidence.target.kind === 'code.blob' && row.applicability === 'stale'
      && row.state.historicalValidity === 'valid' && row.state.availability === 'available')).toBe(true);
  } finally {
    if (owner !== undefined) await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
