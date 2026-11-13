/**
 * The GraphQL executor on a real store (decision 0036, sections 2 to 5): one fixture product, one prepared graph, and
 * the operations a page and an agent ask: a field, an edge both ways, a backlink, a contested value, a filtered and
 * paged list, a catalogue entity, the depth refusal, and the statement count of a list with one edge per row.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import type { EdgeDraft, VertexDraft } from '../src/graph/contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { generatedTableName } from '../src/graph/contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { executeGraphql, type MessageBody } from '../src/graph/graphql-execute.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

let root = '';
let folder = '';
let owner: DatabaseOwner;
let manifest: ReturnType<typeof readKinds> extends { present: true; manifest: infer M } ? M : never;
let contract: ReturnType<typeof graphContractOf>;
let repositoryId = '';
let fileA = '';

/** The operation's answer, with any error thrown rather than read as a smaller result. */
async function graphql(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const answer = await executeGraphql(owner, { manifest, folder }, { query, ...(variables === undefined ? {} : { variables }) });
  const body = answer.body as MessageBody;
  if (body.errors !== undefined) throw new Error(`HTTP ${String(answer.status)}: ${body.errors.map((error) => error.message).join('; ')}`);
  return body.data as Record<string, unknown>;
}

/** The refusal one operation answers, when it is refused. */
async function refusal(query: string): Promise<{ status: number; code: string | undefined; message: string }> {
  const answer = await executeGraphql(owner, { manifest, folder }, { query });
  const body = answer.body as MessageBody;
  return { status: answer.status, code: body.errors?.[0]?.extensions?.code, message: body.errors?.[0]?.message ?? '' };
}

/** An owner whose statements are counted, so a batch is told apart from a query per row. */
function countingOwner(): { owner: DatabaseOwner; statements: () => number } {
  let count = 0;
  const wrap = (transaction: OuterTransaction): OuterTransaction => ({
    ...transaction,
    query: (sql: string, values?: readonly unknown[]) => { count += 1; return transaction.query(sql, values); },
  });
  return {
    owner: {
      ...owner,
      transaction: (kind, work) => owner.transaction(kind, (transaction) => work(wrap(transaction))),
      run: (work) => owner.run((transaction) => work(wrap(transaction))),
    },
    statements: () => count,
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-graphql-executor-'));
  folder = join(root, 'product');
  mkdirSync(join(folder, 'madarch/kinds/demo/core'), { recursive: true });
  mkdirSync(join(folder, 'templates'), { recursive: true });
  writeFileSync(join(folder, 'templates/entity.yaml'), 'template: entity\nsections: []\n');
  writeFileSync(join(folder, 'madarch/catalog.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.repository.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.repository.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.file.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.file.yaml'), 'utf8'));
  execFileSync('git', ['init', '-q'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  const read = readKinds(folder);
  if (!read.present) throw new Error('the fixture product holds no manifest');
  if (read.manifest.findings.length > 0) throw new Error(read.manifest.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  manifest = read.manifest as never;
  // The graph contract takes the edge's table like a capability's: the manifest declares the edge and its attribute.
  const declared = graphContractOf(read.manifest);
  contract = withManifestContract({ ...declared, edge: [...declared.edge, {
    name: 'demo.contains', table: generatedTableName('demo.contains', 'edge'), from: ['demo.repository'], to: ['demo.file'],
    repeats: false, fields: [{ name: 'position', type: 'integer', nullable: true }], capability: 'fixture',
  }] });
  owner = await createTestDatabaseOwner({ graphContract: contract });
  await owner.transaction('write', async (tx) => {
    await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'demo.repository', key: { name: 'r1' }, values: { url: 'https://one.test', size: 2 }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.repository', key: { name: 'r1' }, values: { url: 'https://two.test' }, producer: 'two', producerVersion: '1' },
        { kind: 'demo.file', key: { repository: { kind: 'demo.repository', key: { name: 'r1' } }, path: 'a.ts' }, values: { lines: 10 }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.file', key: { repository: { kind: 'demo.repository', key: { name: 'r1' } }, path: 'b.ts' }, values: { lines: 20 }, producer: 'one', producerVersion: '1' },
      ],
      edges: [
        { kind: 'demo.contains', from: { kind: 'demo.repository', key: { name: 'r1' } }, to: { kind: 'demo.file', key: { repository: { kind: 'demo.repository', key: { name: 'r1' } }, path: 'a.ts' } }, values: { position: 1 }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.contains', from: { kind: 'demo.repository', key: { name: 'r1' } }, to: { kind: 'demo.file', key: { repository: { kind: 'demo.repository', key: { name: 'r1' } }, path: 'b.ts' } }, values: { position: 2 }, producer: 'one', producerVersion: '1' },
      ],
      removals: [],
    }, 1, { author: 'one@1' });
  });
  const validation = validateProductManifests(folder);
  if (!validation.ok) throw new Error(validation.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  if (validation.value !== undefined) await publishValidatedManifests(owner, validation.value);
  const ids = await owner.run(async (tx) => await tx.query<{ uid: string; entity: string; path: string | null }>(
    `SELECT n.uid::text AS uid, en.name AS entity, n.key->>'path' AS path FROM node n JOIN entity en ON en.id = n.entity_id WHERE en.name = ANY($1::text[])`,
    [['demo.repository', 'demo.file']],
  ));
  for (const row of ids.rows) {
    if (row.entity === 'demo.repository') repositoryId = row.uid;
    else if (row.path === 'a.ts') fileA = row.uid;
  }
}, 120_000);

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the GraphQL executor', () => {
  test('an entity by id answers its fields and its reference', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { id kind label ... on DemoFile { path lines repository { ... on DemoRepository { name } } } } }`, { id: fileA });
    const entity = data['entity'] as Record<string, unknown>;
    expect(entity['id']).toBe(fileA);
    expect(entity['kind']).toBe('demo.file');
    expect(entity['label']).toBe('a.ts');
    expect(entity['path']).toBe('a.ts');
    expect(entity['lines']).toBe(10);
    expect(entity['repository']).toMatchObject({ name: 'r1' });
  });

  test('an edge answers both ways with its record and attribute', async () => {
    const from = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoRepository { demoContains(first: 10) { totalCount edges { node { discriminator position node { ... on DemoFile { path } } } } } } } }`, { id: repositoryId });
    const repository = from['entity'] as Record<string, any>;
    expect(repository.demoContains.totalCount).toBe(2);
    expect(repository.demoContains.edges.map((edge: any) => edge.node.node.path)).toEqual(['a.ts', 'b.ts']);
    expect(repository.demoContains.edges[0].node.position).toBe(1);
    expect(repository.demoContains.edges[0].node.discriminator).toBe('');
    const to = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoFile { demoContainsOf(first: 10) { edges { node { node { ... on DemoRepository { name } } } } } } } }`, { id: fileA });
    const file = to['entity'] as Record<string, any>;
    expect(file.demoContainsOf.edges[0].node.node.name).toBe('r1');
  });

  test('a backlink names the inverse field and the vertex it comes from', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { backlinks(first: 10) { totalCount edges { node { relation from { ... on DemoRepository { name } } } } } } }`, { id: fileA });
    const entity = data['entity'] as Record<string, any>;
    expect(entity.backlinks.totalCount).toBe(1);
    expect(entity.backlinks.edges[0].node.relation).toBe('demoContainsOf');
    expect(entity.backlinks.edges[0].node.from.name).toBe('r1');
  });

  test('two producers that disagree give null, contested and both opinions', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoRepository { url urlOpinions { value producer } contested } } }`, { id: repositoryId });
    const repository = data['entity'] as Record<string, any>;
    expect(repository.url).toBeNull();
    expect(repository.contested).toContain('url');
    expect(repository.urlOpinions.map((one: any) => one.value).sort()).toEqual(['https://one.test', 'https://two.test']);
    expect(repository.urlOpinions.map((one: any) => one.producer).sort()).toEqual(['one', 'two']);
  });

  test('a list filters, orders and pages with a cursor', async () => {
    const first = await graphql(`{ allDemoFile(where: { path: { _contains: "." } }, orderBy: [{ field: path, direction: DESC }], first: 1) { totalCount pageInfo { hasNextPage endCursor } edges { node { path } } } }`);
    const page = first['allDemoFile'] as Record<string, any>;
    expect(page.totalCount).toBe(2);
    expect(page.edges.map((edge: any) => edge.node.path)).toEqual(['b.ts']);
    expect(page.pageInfo.hasNextPage).toBe(true);
    const rest = await graphql(`query ($after: String) { allDemoFile(orderBy: [{ field: path, direction: DESC }], first: 1, after: $after) { edges { node { path } } } }`, { after: page.pageInfo.endCursor });
    expect((rest['allDemoFile'] as Record<string, any>).edges.map((edge: any) => edge.node.path)).toEqual(['a.ts']);
  });

  test('a catalogue entity comes from what start publishes into the graph', async () => {
    const one = await graphql(`{ catalogueEntity(name: "demo.file") { name title definition group taken plugins fields { name type reference } derivesFrom { edges { node { name } } } } }`);
    const entry = one['catalogueEntity'] as Record<string, any>;
    expect(entry.name).toBe('demo.file');
    expect(entry.title).toBe('File');
    expect(entry.definition).toBe('A file of the demo.');
    expect(entry.group).toBe('demo');
    expect(entry.taken).toBe(true);
    expect(entry.fields.map((field: any) => field.name)).toContain('repository');
    expect(entry.fields.find((field: any) => field.name === 'repository').reference).toBe('demo.repository');
    expect(entry.derivesFrom.edges.map((edge: any) => edge.node.name)).toEqual(['demo.repository']);
    const all = await graphql(`{ allCatalogueEntity(first: 10) { totalCount edges { node { name } } } }`);
    expect((all['allCatalogueEntity'] as Record<string, any>).totalCount).toBe(2);
  });

  test('a query deeper than six levels is refused with LIMIT_DEPTH', async () => {
    const answer = await refusal(`{ allDemoRepository { edges { node { demoContains { edges { node { demoContainsOf { edges { node { path } } } } } } } } } }`);
    expect(answer.code).toBe('LIMIT_DEPTH');
    expect(answer.message).toContain('the limit is 6');
  });

  test('a list of fifty entities with one edge each costs a small constant number of statements', async () => {
    const many: VertexDraft[] = [];
    const edges: EdgeDraft[] = [];
    // Fifty files, each with one incoming contains edge: the same shape a page's list has.
    for (let at = 0; at < 50; at += 1) {
      const key = { repository: { kind: 'demo.repository', key: { name: 'r1' } }, path: `bulk-${String(at)}.ts` };
      many.push({ kind: 'demo.file', key, producer: 'bulk', producerVersion: '1' });
      edges.push({ kind: 'demo.contains', from: { kind: 'demo.repository', key: { name: 'r1' } }, to: { kind: 'demo.file', key }, producer: 'bulk', producerVersion: '1' });
    }
    await owner.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, contract, {
        vertices: many.map((one) => ({ ...one, producer: 'bulk', producerVersion: '1' })),
        edges: edges.map((one) => ({ ...one, producer: 'bulk', producerVersion: '1' })),
        removals: [],
      }, 1, { author: 'bulk@1' });
    });
    const counted = countingOwner();
    const answer = await executeGraphql(counted.owner, { manifest, folder }, {
      query: `{ allDemoFile(first: 50) { edges { node { path demoContainsOf(first: 1) { edges { cursor } } } } } }`,
    });
    expect((answer.body as MessageBody).errors).toBeUndefined();
    expect(counted.statements()).toBeLessThan(12);
  }, 60_000);

});
