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
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

test('a starter product publishes its catalogue and the page lists the new kinds', async () => {
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
    owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(manifest)) });
    await publishValidatedManifests(owner, validation.value);
    const total = await executeGraphql(owner, { manifest, folder }, { query: '{ allCatalogueEntity(first: 1) { totalCount } }' });
    expect((total.body as MessageBody).data).toMatchObject({ allCatalogueEntity: { totalCount: 498 } });
    // Every kind the owner agreed is a catalogue entity a reader reaches, with its name in both languages.
    for (const kind of ['person', 'role', 'permission', 'iam-role', 'activity', 'activity-node', 'class-diagram', 'logical-data-model', 'use-case-step', 'scenario-step', 'process-event', 'state-machine', 'event', 'proposed-kind', 'doc.decision', 'business-process', 'runtime-scenario', 'work-span', 'container-health-check']) {
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
  } finally {
    if (owner !== undefined) await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
