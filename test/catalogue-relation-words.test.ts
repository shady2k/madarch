import { testHostBinding } from './host-binding-fixture.js';
/**
 * Relation words are declared data (owner's decision, 2026-11-15): a starter product's domain page and its diagrams name
 * each relation in the words the catalogue declares, in Russian and in English, and never in the relation's key.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
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
    const repository = { kind: 'code.repository', key: { name: 'app' } };
    const folderEntity = { kind: 'code.directory', key: { path: 'src/payments' }, keyEdges: { 'code.directory-repository': repository } };
    const term = { kind: 'doc.term', key: { identifier: 'payment' }, keyEdges: { 'doc.term-subject': domain } };
    const producer = { producer: 'fixture', producerVersion: '1' };
    const binding = await testHostBinding(owner, contract, 'fixture');
    await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
      vertices: [
        { ...repository, ...producer },
        { ...domain, ...producer },
        { ...module, ...producer },
        { ...folderEntity, ...producer },
        { ...term, ...producer },
      ],
      edges: [
        { kind: 'code.module-folder', from: module, to: folderEntity, ...producer },
        { kind: 'domain.covers', from: domain, to: module, ...producer },
        { kind: 'domain.covers-folder', from: domain, to: folderEntity, ...producer },
        { kind: 'domain.uses-term', from: domain, to: term, ...producer },
      ],
      removals: [],
    }, 1, { binding, author: 'fixture@1' }));
    const uid = (await owner.transaction('snapshot', async (tx) => await tx.query<{ uid: string }>(
      `SELECT n.uid::text AS uid FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'domain' AND n.key->>'name' = 'Payments' AND graph_vertex_active(n.id, 'domain', 1)`,
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

test('manifest.kind has no duplicate kind type or list root', async () => {
  const { graphqlSchemaOf } = await import('../src/graphql/schema.js');
  const { buildSchema } = await import('graphql');
  const schema = buildSchema(graphqlSchemaOf({ kinds: [{name:'manifest.kind',key:['name'],fields:[{name:'name',type:'text'}]}],edges:[],relations:[] }));
  expect(schema.getType('KindManifestKind')).toBeUndefined();
  expect(schema.getQueryType()!.getFields()['allManifestKind']).toBeUndefined();
});

test('explicit manifest.kind edge ends use the single catalogue entity type', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-catalogue-end-'));
  let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>> | undefined;
  try {
    const { mkdirSync } = await import('node:fs');
    const folder = root;
    mkdirSync(join(folder, 'madarch/kinds/demo/core'), { recursive: true });
    const cataloguePath = join(folder, 'madarch/catalog.yaml');
    const declared = parse(readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml'), 'utf8'));
    declared.edges.push({ ...declared.edges.find((edge: {name:string}) => edge.name === 'mentions'), name: 'catalogue-link', from: ['demo.repository'], to: ['manifest.kind'] });
    writeFileSync(cataloguePath, stringify(declared));
    for (const name of ['demo.repository', 'demo.file', 'doc.term', 'demo.note']) {
      writeFileSync(join(folder, 'madarch/kinds/demo/core', `${name}.yaml`), readFileSync(join(import.meta.dir, 'graphql', `fixture-product-${name}.yaml`), 'utf8'));
    }
    const { execFileSync } = await import('node:child_process');
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'fixture']]) execFileSync('git', args, { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
    const validation = validateProductManifests(folder);
    if (!validation.ok) throw new Error(JSON.stringify(validation.findings));
    if (validation.value === undefined) throw new Error(`${folder}:1: no manifest`);
    const manifest = validation.value.manifest;
    const { graphqlSchemaOf } = await import('../src/graphql/schema.js');
    const { buildSchema, isObjectType } = await import('graphql');
    const schema = buildSchema(graphqlSchemaOf(publishedManifestOf(manifest)));
    const catalogue = schema.getType('CatalogueEntity');
    expect(isObjectType(catalogue) && catalogue.getFields()['catalogueLinkOf']).toBeTruthy();
    expect(schema.getType('KindManifestKind')).toBeUndefined();
    expect(schema.getQueryType()!.getFields()['allManifestKind']).toBeUndefined();
    const contract = withManifestContract(graphContractOf(manifest));
    owner = await createTestDatabaseOwner({ graphContract: contract });
    await publishValidatedManifests(owner, validation.value);
    const target = (await owner.run(tx => tx.query<{uid:string}>(`SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='manifest.kind' AND n.key->>'name'='demo.repository'`))).rows[0]!;
    const producer = { producer: 'fixture', producerVersion: '1' };
    const source = { kind: 'demo.repository', key: { name: 'app' } };
    const binding = await testHostBinding(owner, contract, 'fixture');
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, {
      vertices: [{ ...source, ...producer }], removals: [],
      edges: [{ kind: 'catalogue-link', from: source, to: { kind: 'manifest.kind', uid: target.uid, key: {} }, discriminator: 'fixture:1', ...producer }],
    }, 1, { binding, author: 'fixture@1' }));
    const answer = await executeGraphql(owner, { manifest, folder }, {
      query: `query($id: ID!) { entity(id: $id) { __typename ... on CatalogueEntity { catalogueLinkOf(first: 5) { totalCount edges { node { node { id } } } } } } }`,
      variables: { id: target.uid },
    });
    const body = answer.body as MessageBody;
    expect(body.errors).toBeUndefined();
    const entity = (body.data as {entity:{__typename:string;catalogueLinkOf:{totalCount:number;edges:{node:{node:{id:string}}}[]}}}).entity;
    expect(entity.__typename).toBe('CatalogueEntity');
    expect(entity.catalogueLinkOf.totalCount).toBe(1);
    expect(entity.catalogueLinkOf.edges[0]!.node.node.id).toBeDefined();
  } finally {
    if (owner !== undefined) await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
