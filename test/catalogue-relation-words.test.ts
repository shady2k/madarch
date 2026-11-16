import { testHostBinding } from './host-binding-fixture.js';
/**
 * Relation words are declared data (owner's decision, 2026-11-15): a starter product's domain page and its diagrams name
 * each relation in the words the catalogue declares, in Russian and in English, and never in the relation's key.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDraft } from '../src/product/draft.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { executeGraphql, type MessageBody } from '../src/graph/graphql-execute.js';
import { ReadContext } from '../src/graph/graphql-read.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { readTemplatesOf } from './page-templates-fixture.js';
import { diagramGraphOf } from '../src/render/diagram.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

test("a starter product's domain page and diagram name relations in the declared words only", async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-relation-words-'));
  let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>> | undefined;
  try {
    const draft = createDraft({ home: root, name: 'relation-words', template: 'everything', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    const folder = draft.folder;
    const validation = validateProductManifests(folder);
    if (!validation.ok) throw new Error(validation.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
    if (validation.value === undefined) throw new Error(`${folder}:1: no manifest`);
    const manifest = validation.value.manifest;
    const contract = withManifestContract(graphContractOf(manifest));
    owner = await createTestDatabaseOwner({ graphContract: contract });
    await publishValidatedManifests(owner, validation.value);
    const domain = { kind: 'domain', key: { name: 'Payments' } };
    const module = { kind: 'code.module', key: { name: 'payments' } };
    const folderEntity = { kind: 'code.directory', key: { repository: 'app', path: 'src/payments' } };
    const term = { kind: 'doc.term', key: { name: 'Payment' } };
    const producer = { producer: 'fixture', producerVersion: '1' };
    const binding = await testHostBinding(owner, contract, 'fixture');
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
      vertices: [
        { ...domain, ...producer },
        { ...module, ...producer },
        { ...folderEntity, ...producer },
        { ...term, ...producer },
      ],
      edges: [
        { kind: 'domain.covers', from: domain, to: module, ...producer },
        { kind: 'domain.covers-folder', from: domain, to: folderEntity, ...producer },
        { kind: 'domain.uses-term', from: domain, to: term, ...producer },
      ],
      removals: [],
    }, 1, { binding, author: 'fixture@1' }));
    const uid = (await owner.transaction('snapshot', async (tx) => await tx.query<{ uid: string }>(
      `SELECT n.uid::text AS uid FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'domain' AND n.key->>'name' = 'Payments' AND NOT n.removed`,
    ))).rows[0]!.uid;
    const declared = {
      ru: { 'domain.covers': 'покрывает', 'domain.covers-folder': 'покрывает папку', 'domain.uses-term': 'использует термин' },
      en: { 'domain.covers': 'covers', 'domain.covers-folder': 'covers folder', 'domain.uses-term': 'uses term' },
    } as const;
    for (const lang of ['ru', 'en'] as const) {
      const answer = await executeGraphql(owner, { manifest, folder }, { query: `{ entity(id: ${JSON.stringify(uid)}) { outgoing(first: 50) { edges { node { relation label edge inverse } } } } }`, lang });
      const body = answer.body as MessageBody;
      if (body.errors !== undefined) throw new Error(JSON.stringify(body.errors));
      const rows = (body.data as { entity: { outgoing: { edges: { node: { relation: string; label: string; edge: string; inverse: boolean } }[] } } }).entity.outgoing.edges.map((edge) => edge.node);
      for (const [relation, word] of Object.entries(declared[lang])) {
        const row = rows.find((one) => one.edge === relation);
        expect([lang, relation, row?.label]).toEqual([lang, relation, word]);
      }
      // No relation key and no English word reaches a Russian page, and no key reaches any page.
      for (const row of rows) {
        expect([lang, row.label]).not.toEqual([lang, row.relation]);
        expect(row.label).not.toContain('.');
        expect(row.label).not.toMatch(/^(domain|code|module)[A-Z]/);
      }
      const neighbourhood = await owner.transaction('snapshot', async (tx) => {
        const templates = (await readTemplatesOf(tx, manifest)).templates;
        const context = new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, lang, 'fixture', templates);
        return await context.diagramNeighbourhood(uid, 1, lang);
      });
      expect(neighbourhood).toBeDefined();
      const diagram = diagramGraphOf(neighbourhood!, 1, 100);
      const labels = diagram.edges.map((edge) => edge.label);
      for (const word of Object.values(declared[lang])) expect(labels).toContain(word);
      for (const label of labels) expect(label).not.toMatch(/^(domain|code|module)\./);
    }
  } finally {
    if (owner !== undefined) await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
