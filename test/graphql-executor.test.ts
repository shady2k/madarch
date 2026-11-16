import { activateGraphProducer, bindGraphProducer } from '../src/graph/producer-binding.js';
import { registerSystemSource } from '../src/graph/system-installation.js';
import { readKindAssertions } from '../src/graph/records.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import {reconcileDisputes,resolveDispute} from '../src/graph/disputes.js';
import {readDispute} from '../src/graph/dispute-read.js';
import { writeAssertion } from '../src/graph/write.js';
import { keyUid } from '../src/graph/uid.js';
import { createHash } from 'node:crypto';
import { bindTestWriteCapability } from './write-capability-fixture.js';
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
import { withAssertionContract } from '../src/graph/system-contract.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { readKinds, type KindsManifest } from '../src/product/manifest/kinds.js';
import { executeGraphql, type MessageBody } from '../src/graph/graphql-execute.js';
import { ReadContext } from '../src/graph/graphql-read.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { readProductTemplates } from '../src/graph/product-templates.js';
import { composePage, type Bootstrap } from '../src/page-contract/index.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

let root = '';
let folder = '';
let owner: DatabaseOwner;
let manifest: ReturnType<typeof readKinds> extends { present: true; manifest: infer M } ? M : never;
let contract: ReturnType<typeof graphContractOf>;
let repositoryId = '';
let repository2Id = '';
let repository3Id = '';
let fileA = '';
let fileB = '';

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
  // The starter's catalogue template composes into one operation over the catalogue (decision 0036, section 6).
  writeFileSync(join(folder, 'templates/catalogue.yaml'), readFileSync(join(import.meta.dir, '..', 'catalog/templates/pages/catalogue.yaml'), 'utf8'));
  writeFileSync(join(folder, 'templates/home.yaml'), 'template: home\nsections: []\n');
  // A record template and an entity's own template: the bootstrap names both, and an entity answers the one it opens.
  writeFileSync(join(folder, 'templates/record.yaml'), 'template: record\nextends: entity\nrecords: [demo.file]\nsections:\n  - id: files\n    component: table\n    after: header\n    query: |\n      id\n      label\n    params:\n      path: .\n      columns: [{ label: { en: Label }, path: label }]\n');
  writeFileSync(join(folder, 'templates/own.yaml'), 'template: own\nextends: entity\nentities: [own-entity]\nsections: []\n');
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
  // Every declared edge kind has its table (owner's rule): the manifest's own declaration is the contract.
  contract = withManifestContract(graphContractOf(read.manifest));

  owner = await createTestDatabaseOwner({ graphContract: contract });
  const repository = (name: string) => ({ kind: 'demo.repository', key: { name } });
  const file = (path: string) => ({ kind: 'demo.file', key: { path }, keyEdges: { repository: repository('r1') } });
  const big = 'x'.repeat(2_200_000);
  await owner.transaction('write', async (tx) => {
    await bindTestWriteCapability(tx, contract);
    await bindTestWriteCapability(tx, contract, '7692c3ad-0000-7000-8000-000000000001');
    await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'demo.repository', key: { name: 'r1' }, values: { url: 'https://one.test', size: 2, archived: true }, producer: 'one', producerVersion: '1' },
        { ...file('a.ts'), values: { lines: 10, language: 'TypeScript' }, producer: 'one', producerVersion: '1' },
        { ...file('b.ts'), values: { lines: 20 }, producer: 'one', producerVersion: '1' },
        { ...file('c.ts'), values: {}, producer: 'one', producerVersion: '1' },
      ],
      edges: [
        { kind: 'demo.file-primary', from: file('a.ts'), to: repository('r1'), producer: 'one', producerVersion: '1' },
        { kind: 'demo.file-preferred', from: file('a.ts'), to: repository('r1'), producer: 'one', producerVersion: '1' },
        { kind: 'demo.contains', from: repository('r1'), to: file('a.ts'), values: { position: 1 }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.contains', from: repository('r1'), to: file('b.ts'), values: { position: 2 }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.contains', from: repository('r1'), to: file('c.ts'), values: { position: 3 }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.related', from: file('a.ts'), to: file('b.ts'), producer: 'one', producerVersion: '1' },
        { kind: 'demo.touched', from: file('a.ts'), to: file('b.ts'), discriminator: 'w2', values: { weight: 2, changed_at: '2026-01-01T00:00:00Z' }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.touched', from: file('a.ts'), to: file('c.ts'), discriminator: 'w10', values: { weight: 10, changed_at: '2026-02-01T00:00:00Z' }, producer: 'one', producerVersion: '1' },
      ],
      removals: [],
    }, 1, { author: 'one@1' });
    await bindTestWriteCapability(tx, contract, '3fc4ccfe-0000-7000-8000-000000000001');
    await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'demo.repository', key: { name: 'r1' }, values: { url: 'https://two.test' }, producer: 'two', producerVersion: '1' },
        { ...file('a.ts'), values: {}, producer: 'two', producerVersion: '1' },
        { ...file('b.ts'), values: {}, producer: 'two', producerVersion: '1' },
      ],
      removals: [],
    }, 1, { author: 'two@1' });
    await reconcileDisputes(tx, contract);
    await bindTestWriteCapability(tx, contract, '7e2372f4-0000-7000-8000-000000000001');
    await publishGraphDrafts(tx, contract, {
      vertices: [{ kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'B' }, producer: 'neutral', producerVersion: '1' }],
      removals: [],
    }, 1, { author: 'neutral@1' });
    await bindTestWriteCapability(tx, contract, 'b6234d2e-0000-7000-8000-000000000001');
    await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'Hello' }, lang: 'en', producer: 'english', producerVersion: '1' },
        { kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'Привет' }, lang: 'ru', producer: 'russian', producerVersion: '1' },
      ],
      removals: [],
    }, 1, { author: 'translated@1' });
    await bindTestWriteCapability(tx, contract, '8b5b9db0-0000-7000-8000-000000000001');
    await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'demo.repository', key: { name: 'r2' }, values: { description: 'Second' }, producer: 'three', producerVersion: '1' },
        { kind: 'demo.repository', key: { name: 'r3' }, values: { description: big }, producer: 'three', producerVersion: '1' },
      ],
      removals: [],
    }, 1, { author: 'three@1' });
  });
  const validation = validateProductManifests(folder);
  if (!validation.ok) throw new Error(validation.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  if (validation.value !== undefined) await publishValidatedManifests(owner, validation.value);
  const ids = await owner.run(async (tx) => await tx.query<{ uid: string; entity: string; name: string | null; path: string | null }>(
    `SELECT n.uid::text AS uid, en.name AS entity, n.key->>'name' AS name, n.key->>'path' AS path FROM node n JOIN entity en ON en.id = n.entity_id WHERE en.name = ANY($1::text[])`,
    [['demo.repository', 'demo.file']],
  ));
  for (const row of ids.rows) {
    if (row.entity === 'demo.repository' && row.name === 'r1') repositoryId = row.uid;
    if (row.entity === 'demo.repository' && row.name === 'r2') repository2Id = row.uid;
    if (row.entity === 'demo.repository' && row.name === 'r3') repository3Id = row.uid;
    if (row.entity === 'demo.file' && row.path === 'a.ts') fileA = row.uid;
    if (row.entity === 'demo.file' && row.path === 'b.ts') fileB = row.uid;
  }
}, 120_000);

test('diagram neighbourhood refuses a deeper traversal of the real graph', async () => {
  const templates = readProductTemplates(folder);
  await expect(owner.transaction('snapshot', (tx) => new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, 'en', 'test', templates).diagramNeighbourhood(repositoryId, 2, 'en'))).rejects.toThrow('deeper diagram neighbourhoods are not supported');
});

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the GraphQL executor', () => {
  test('temporal root selectors isolate valid and recorded snapshots', async () => {
    await owner.transaction('write', async (tx) => {
      await bindTestWriteCapability(tx, contract, '7692c3ad-0000-7000-8000-000000000001');
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'demo.file', key: { path: 'a.ts' }, keyEdges: { repository: { kind: 'demo.repository', key: { name: 'r1' } } }, values: { lines: 111 }, validFrom: '2099-01-01T00:00:00.000Z', producer: 'one', producerVersion: '1' }], edges: [], removals: [], edgeRemovals: [] });
    });
    const data = await graphql(`query ($id: ID!) {
      present: entity(id: $id, validAt: "2027-01-01T00:00:00.000Z") { ... on DemoFile { lines } }
      future: entity(id: $id, validAt: "2100-01-01T00:00:00.000Z") { ... on DemoFile { lines } }
      beforeRecording: entity(id: $id, recordedAt: "2000-01-01T00:00:00.000Z") { id }
    }`, { id: fileA });
    expect(data['present']).toEqual({ lines: 10 });
    expect(data['future']).toEqual({ lines: 111 });
    expect(data['beforeRecording']).toBeNull();
  });

  test('a pinned context hides assertion identities recorded after its ancestor snapshot', async () => {
    const held = await owner.transaction('write', async (tx) => {
      const branch = await tx.query<{ id: string }>(`INSERT INTO context(parent,ref,parent_recorded_seq) VALUES(1,'graphql-pinned-header',-1) RETURNING id::text`);
      await bindTestWriteCapability(tx, contract, '7692c3ad-0000-7000-8000-000000000001');
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'demo.file', key: { path: 'a.ts' }, keyEdges: { repository: { kind: 'demo.repository', key: { name: 'r1' } } }, values: { lines: 10 }, producer: 'one', producerVersion: '1' }], edges: [], removals: [] });
      const assertion = await tx.query<{ uid: string }>(`SELECT n.uid::text FROM assertion a JOIN node n ON n.id=a.assertion_id JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id JOIN edge subject_edge ON subject_edge.id=s.subject_edge_id JOIN node subject ON subject.id=subject_edge.to_node JOIN entity k ON k.id=subject.entity_id WHERE k.name='demo.file' AND subject.key->>'path'='a.ts' AND a.property='lines' ORDER BY a.recorded_sequence DESC LIMIT 1`);
      return { context: Number(branch.rows[0]!.id), uid: assertion.rows[0]!.uid };
    });
    const data = await graphql(`query ($id: ID!, $context: Int!) {
      current: entity(id: $id) { id kind }
      pinned: entity(id: $id, context: $context) { id kind }
    }`, { id: held.uid, context: held.context });
    expect(data['current']).toEqual({ id: held.uid, kind: 'system.assertion' });
    expect(data['pinned']).toBeNull();
  });

  test('sequence-pinned branches select inherited fields and SQL filters while local writes remain live', async () => {
    const { pinContext } = await import('../src/graph/context.js');
    const source = '019a0000-0000-7000-8000-000000000077';
    const write = async (context: number, name: string, url: string) => await owner.transaction('write', async (tx) => {
      await bindTestWriteCapability(tx, contract, source, context);
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'demo.repository', key: { name }, values: { url }, producer: 'fixture', producerVersion: '1' }], removals: [] }, context);
    });
    await write(1, 'sequence-inherited', 'old');
    const branch = Number(await owner.transaction('write', (tx) => pinContext(tx, '1', 'graphql-sequence-branch')));
    await write(1, 'sequence-inherited', 'later-parent');
    await write(1, 'sequence-after-pin', 'later-parent');
    await write(branch, 'sequence-local', 'local-first');
    await write(branch, 'sequence-local', 'local-latest');
    const data = await graphql(`query ($context: Int!) {
      inherited: allDemoRepository(context: $context, where: { name: { _eq: "sequence-inherited" }, url: { _eq: "old" } }) { totalCount edges { node { name url urlAssertions { value } } } }
      local: allDemoRepository(context: $context, where: { name: { _eq: "sequence-local" }, url: { _eq: "local-latest" } }) { totalCount edges { node { url } } }
      hidden: allDemoRepository(context: $context, where: { name: { _eq: "sequence-after-pin" } }) { totalCount }
      current: allDemoRepository(where: { name: { _eq: "sequence-inherited" }, url: { _eq: "later-parent" } }) { totalCount }
    }`, { context: branch });
    expect(data['inherited']).toEqual({ totalCount: 1, edges: [{ node: { name: 'sequence-inherited', url: 'old', urlAssertions: [{ value: 'old' }] } }] });
    expect(data['local']).toEqual({ totalCount: 1, edges: [{ node: { url: 'local-latest' } }] });
    expect(data['hidden']).toEqual({ totalCount: 0 });
    expect(data['current']).toEqual({ totalCount: 1 });
  });

  test('an entity by id answers its fields and its reference', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { id kind label ... on DemoFile { path lines demoFileRepository(first: 1) { edges { node { node { ... on DemoRepository { name } } } } } } } }`, { id: fileA });
    const entity = data['entity'] as Record<string, unknown>;
    expect(entity['id']).toBe(fileA);
    expect(entity['kind']).toBe('demo.file');
    expect(entity['label']).toBe('a.ts');
    expect(entity['path']).toBe('a.ts');
    expect(entity['lines']).toBe(10);
    expect(entity['demoFileRepository']).toMatchObject({ edges: [{ node: { node: { name: 'r1' } } }] });
  });

  test('an edge answers both ways with its record and attribute', async () => {
    const from = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoRepository { demoContains(first: 10) { totalCount edges { node { discriminator position node { ... on DemoFile { path } } } } } } } }`, { id: repositoryId });
    const repository = from['entity'] as Record<string, any>;
    expect(repository.demoContains.totalCount).toBe(3);
    expect(repository.demoContains.edges.map((edge: any) => edge.node.node.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
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
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoRepository { url urlAssertions { value source { id } } contested } } }`, { id: repositoryId });
    const repository = data['entity'] as Record<string, any>;
    expect(repository.url).toBe('https://two.test');
    expect(repository.contested).toContain('url');
    expect(repository.urlAssertions.map((one: any) => one.value).sort()).toEqual(['https://one.test', 'https://two.test']);
    expect(repository.urlAssertions.map((one: any) => one.source.id).sort()).toEqual(['3fc4ccfe-0000-7000-8000-000000000001', '7692c3ad-0000-7000-8000-000000000001']);
  });

  test('a list filters, orders and pages with a cursor', async () => {
    const first = await graphql(`{ allDemoFile(where: { path: { _contains: "." } }, orderBy: [{ field: path, direction: DESC }], first: 1) { totalCount pageInfo { hasNextPage endCursor } edges { node { path } } } }`);
    const page = first['allDemoFile'] as Record<string, any>;
    expect(page.totalCount).toBe(3);
    expect(page.edges.map((edge: any) => edge.node.path)).toEqual(['c.ts']);
    expect(page.pageInfo.hasNextPage).toBe(true);
    const rest = await graphql(`query ($after: String) { allDemoFile(orderBy: [{ field: path, direction: DESC }], first: 1, after: $after) { edges { node { path } } } }`, { after: page.pageInfo.endCursor });
    expect((rest['allDemoFile'] as Record<string, any>).edges.map((edge: any) => edge.node.path)).toEqual(['b.ts']);
  });

  test('a catalogue entity comes from what start publishes into the graph', async () => {
    const one = await graphql(`{ catalogueEntity(name: "demo.file") { name title definition group taken plugins fields { name type } derivesFrom { edges { node { name } } } } }`);
    const entry = one['catalogueEntity'] as Record<string, any>;
    expect(entry.name).toBe('demo.file');
    expect(entry.title).toBe('File');
    expect(entry.definition).toBe('A file of the demo.');
    expect(entry.group).toBe('demo');
    expect(entry.taken).toBe(true);
    expect(entry.fields.map((field: any) => field.name)).toContain('path');
    expect(entry.fields.find((field: any) => field.name === 'path').type).toBe('text');
    expect(entry.derivesFrom.edges.map((edge: any) => edge.node.name)).toEqual(['demo.repository']);
    const all = await graphql(`{ allCatalogueEntity(first: 10) { totalCount edges { node { name } } } }`);
    expect((all['allCatalogueEntity'] as Record<string, any>).totalCount).toBe(2);
  });

  test('a query deeper than seven levels is refused with LIMIT_DEPTH', async () => {
    const answer = await refusal(`{ allDemoRepository { edges { node { demoContains { edges { node { demoContainsOf { edges { node { node { ... on DemoFile { path } } } } } } } } } } } }`);
    expect(answer.code).toBe('LIMIT_DEPTH');
    expect(answer.message).toContain('the limit is 7');
  });

  test('a list of fifty entities with one edge each costs a small constant number of statements', async () => {
    const { pinContext } = await import('../src/graph/context.js');
    const context = Number(await owner.transaction('write', tx => pinContext(tx, '1', 'bounded-list-fixture')));
    const many: VertexDraft[] = [];
    const edges: EdgeDraft[] = [];
    // Fifty files, each with one incoming contains edge: the same shape a page's list has.
    for (let at = 0; at < 50; at += 1) {
      const key = { path: `bulk-${String(at)}.ts` };
      const keyEdges = { repository: { kind: 'demo.repository', key: { name: 'r1' } } };
      many.push({ kind: 'demo.file', key, keyEdges, producer: 'bulk', producerVersion: '1' });
      edges.push({ kind: 'demo.contains', from: { kind: 'demo.repository', key: { name: 'r1' } }, to: { kind: 'demo.file', key, keyEdges }, producer: 'bulk', producerVersion: '1' });
    }
    await owner.transaction('write', async (tx) => {
      await bindTestWriteCapability(tx, contract, 'bf8348b4-0000-7000-8000-000000000001', context);
    await publishGraphDrafts(tx, contract, {
        vertices: many.map((one) => ({ ...one, producer: 'bulk', producerVersion: '1' })),
        edges: edges.map((one) => ({ ...one, producer: 'bulk', producerVersion: '1' })),
        removals: [],
      }, context, { author: 'bulk@1' });
    });
    const counted = countingOwner();
    const answer = await executeGraphql(counted.owner, { manifest, folder }, {
      query: `{ allDemoFile(context: ${context}, where: { path: { _contains: "bulk-" } }, first: 50) { edges { node { path demoContainsOf(first: 1) { edges { cursor } } } } } }`,
    });
    expect((answer.body as MessageBody).errors).toBeUndefined();
    const data = (answer.body as MessageBody).data as Record<string, unknown>;
    expect((data['allDemoFile'] as { edges: unknown[] }).edges).toHaveLength(50);
    expect(counted.statements()).toBeLessThan(12);
  }, 60_000);

  test('a field answers its typed value, not a JSON text (#1)', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoRepository { size archived description } } }`, { id: repositoryId });
    const repository = data['entity'] as Record<string, unknown>;
    expect(repository['size']).toBe(2);
    expect(repository['archived']).toBe(true);
    expect(repository['description']).toBe('Hello');
  });

  test('a key reference answers its inverse, and an agreed non-key reference answers it once (#2, #5)', async () => {
    const keyed = await graphql(`{ allDemoRepository(where: { name: { _eq: "r1" } }) { edges { node { demoFileRepositoryOf(first: 10) { totalCount edges { node { node { ... on DemoFile { path } } } } } } } } }`);
    const repository = (keyed['allDemoRepository'] as Record<string, any>).edges[0].node;
    expect(repository.demoFileRepositoryOf.totalCount).toBe(3);
    expect(repository.demoFileRepositoryOf.edges.map((edge: any) => edge.node.node.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const agreed = await graphql(`query ($r1: ID!, $r2: ID!) { r1: entity(id: $r1) { ... on DemoRepository { demoFilePrimaryOf(first: 10) { totalCount edges { node { node { ... on DemoFile { path } } } } } backlinks(first: 20) { edges { node { relation } } } } } r2: entity(id: $r2) { ... on DemoRepository { demoFilePrimaryOf(first: 10) { totalCount } } } }`, { r1: repositoryId, r2: repository2Id });
    const r1 = agreed['r1'] as Record<string, any>;
    expect(r1.demoFilePrimaryOf.totalCount).toBe(1);
    expect(r1.demoFilePrimaryOf.edges.map((edge: any) => edge.node.node.path)).toEqual(['a.ts']);
    expect(r1.backlinks.edges.filter((edge: any) => edge.node.relation === 'demoFilePrimaryOf')).toHaveLength(1);
    expect(r1.backlinks.edges.map((edge: any) => edge.node.relation)).toContain('demoFileRepositoryOf');
    expect((agreed['r2'] as Record<string, any>).demoFilePrimaryOf.totalCount).toBe(0);
  });

  test('a reference declared text answers its inverse and its backlink, not a database error (madarch-64o5.83)', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoRepository { demoFilePreferredOf(first: 10) { totalCount edges { node { node { ... on DemoFile { path } } } } } backlinks(first: 20) { edges { node { relation } } } } } }`, { id: repositoryId });
    const repository = data['entity'] as Record<string, any>;
    expect(repository.demoFilePreferredOf.totalCount).toBe(1);
    expect(repository.demoFilePreferredOf.edges.map((edge: any) => edge.node.node.path)).toEqual(['a.ts']);
    expect(repository.backlinks.edges.map((edge: any) => edge.node.relation)).toContain('demoFilePreferredOf');
  });

  test('pagination over a null order value neither skips nor repeats a row (#6)', async () => {
    const where = '{ path: { _in: ["a.ts", "b.ts", "c.ts"] } }';
    const first = await graphql(`{ allDemoFile(where: ${where}, orderBy: [{ field: lines }], first: 1) { pageInfo { endCursor hasNextPage } edges { node { path } } } }`);
    let page = first['allDemoFile'] as Record<string, any>;
    expect(page.edges.map((edge: any) => edge.node.path)).toEqual(['a.ts']);
    let after: string = page.pageInfo.endCursor;
    const seen: string[] = [];
    for (let at = 0; at < 4; at += 1) {
      const next = await graphql(`query ($after: String) { allDemoFile(where: ${where}, orderBy: [{ field: lines }], first: 1, after: $after) { pageInfo { endCursor hasNextPage } edges { node { path } } } }`, { after });
      page = next['allDemoFile'] as Record<string, any>;
      if (page.edges.length === 0) break;
      seen.push(page.edges[0].node.path);
      after = page.pageInfo.endCursor;
      if (!page.pageInfo.hasNextPage) break;
    }
    expect(seen).toEqual(['b.ts', 'c.ts']);
    const nullsFirst = await graphql(`{ allDemoFile(where: ${where}, orderBy: [{ field: lines, nulls: FIRST }], first: 1) { edges { node { path } } pageInfo { endCursor } } }`);
    const firstNull = nullsFirst['allDemoFile'] as Record<string, any>;
    expect(firstNull.edges.map((edge: any) => edge.node.path)).toEqual(['c.ts']);
    const afterNull = await graphql(`query ($after: String) { allDemoFile(where: ${where}, orderBy: [{ field: lines, nulls: FIRST }], first: 1, after: $after) { edges { node { path } } } }`, { after: firstNull.pageInfo.endCursor });
    expect((afterNull['allDemoFile'] as Record<string, any>).edges.map((edge: any) => edge.node.path)).toEqual(['a.ts']);
  });

  test('a bigint edge attribute orders by its number, not its text (#7)', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoFile { demoTouched(orderBy: [{ field: weight }], first: 10) { edges { node { weight } } } } } }`, { id: fileA });
    const file = data['entity'] as Record<string, any>;
    expect(file.demoTouched.edges.map((edge: any) => edge.node.weight)).toEqual(['2', '10']);
  });

  test('the starter catalogue template composes its header, and its kinds are the command read', async () => {
    const bootstrap: Bootstrap = {
      structureRevision: 'r',
      home: null,
      catalogueTemplate: 'entity',
      templates: ['catalogue', 'entity'].map((name) => ({ name, body: readFileSync(join(folder, 'templates', `${name}.yaml`), 'utf8') })),
      recordTemplates: [], ownTemplates: [], roles: [],
    };
    const page = composePage(bootstrap, { template: 'catalogue' });
    expect(page.findings).toEqual([]);
    // The header reads the product's name; the catalogue's kinds come from the command's navigation and plan reads.
    expect(page.operation).toContain('s_header: home');
    expect(page.operation).not.toContain('s_kinds');
    const data = await graphql(page.operation, page.variables);
    expect(data).toHaveProperty('s_header');
  });

  test('the bootstrap names the templates, the pages they open and the roles', async () => {
    const data = await graphql(`{ bootstrap { structureRevision home { id kind template } catalogueTemplate templates { name } recordTemplates { kind template } ownTemplates { id template } roles } }`);
    const held = data['bootstrap'] as Record<string, any>;
    expect(held.structureRevision).toHaveLength(64);
    // This fixture holds no home kind: the home is null, and the mechanisms's other names stand.
    expect(held.home).toBeNull();
    expect(held.catalogueTemplate).toBe('entity');
    expect(held.templates.map((one: any) => one.name).sort()).toEqual(['catalogue', 'entity', 'home', 'own', 'record']);
    expect(held.recordTemplates).toEqual([{ kind: 'demo.file', template: 'record' }]);
    expect(held.ownTemplates).toEqual([{ id: 'own-entity', template: 'own' }]);
    expect(Array.isArray(held.roles)).toBe(true);
  });

  test('an entity answers the template its kind\'s record template names', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { kind template } }`, { id: fileA });
    expect((data['entity'] as Record<string, any>).template).toBe('record');
  });

  test('a catalogue entity\'s template is the product\'s catalogue template', async () => {
    const data = await graphql(`{ catalogueEntity(name: "demo.file") { kind template } }`);
    expect((data['catalogueEntity'] as Record<string, any>).template).toBe('entity');
  });

  test('a catalogue entry lists its records through its instances relation, one page at a time', async () => {
    const first = await graphql(`{ catalogueEntity(name: "demo.file") { instances(first: 2) { totalCount pageInfo { hasNextPage endCursor } edges { node { id kind label } } } } }`);
    const page = (first['catalogueEntity'] as Record<string, any>).instances;
    expect(page.totalCount).toBeGreaterThanOrEqual(3);
    expect(page.edges).toHaveLength(2);
    expect(page.edges.map((edge: any) => edge.node.kind)).toEqual(['demo.file', 'demo.file']);
    expect(page.pageInfo.hasNextPage).toBe(true);
    const rest = await graphql(`query ($after: String) { catalogueEntity(name: "demo.file") { instances(first: 2, after: $after) { edges { node { id } } } } }`, { after: page.pageInfo.endCursor });
    const ids = (rest['catalogueEntity'] as Record<string, any>).instances.edges.map((edge: any) => edge.node.id);
    expect(ids).not.toContain(page.edges[0].node.id);
  });

  test('an entity answers the relations it leads out with, as backlinks answer the ones it is reached by', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { outgoing(first: 10) { totalCount edges { node { relation to { kind ... on DemoFile { path } } } } } } }`, { id: repositoryId });
    const outgoing = (data['entity'] as Record<string, any>).outgoing;
    expect(outgoing.totalCount).toBeGreaterThanOrEqual(3);
    expect(new Set(outgoing.edges.map((edge: any) => edge.node.relation))).toEqual(new Set(['demoContains']));
    expect(outgoing.edges.map((edge: any) => edge.node.to.path)).toContain('a.ts');
  });

  test('a catalogue page with no order still pages by its id (#8)', async () => {
    const first = await graphql(`{ allCatalogueEntity(first: 1) { pageInfo { endCursor hasNextPage } edges { node { name } } } }`);
    const page = first['allCatalogueEntity'] as Record<string, any>;
    expect(page.pageInfo.hasNextPage).toBe(true);
    const rest = await graphql(`query ($after: String) { allCatalogueEntity(first: 1, after: $after) { edges { node { name } } } }`, { after: page.pageInfo.endCursor });
    expect((rest['allCatalogueEntity'] as Record<string, any>).edges).toHaveLength(1);
  });

  test('totalCount is the whole filtered set, not what is left after the cursor (#9)', async () => {
    const where = '{ path: { _in: ["a.ts", "b.ts", "c.ts"] } }';
    const first = await graphql(`{ allDemoFile(where: ${where}, orderBy: [{ field: lines }], first: 1) { totalCount pageInfo { endCursor } edges { node { path } } } }`);
    let page = first['allDemoFile'] as Record<string, any>;
    expect(page.totalCount).toBe(3);
    for (let at = 0; at < 2; at += 1) {
      const next = await graphql(`query ($after: String) { allDemoFile(where: ${where}, orderBy: [{ field: lines }], first: 1, after: $after) { totalCount pageInfo { endCursor } edges { node { path } } } }`, { after: page.pageInfo.endCursor });
      page = next['allDemoFile'] as Record<string, any>;
      expect(page.totalCount).toBe(3);
    }
  });

  test('a root lang chooses that reader language for its branch (#10)', async () => {
    const data = await graphql(`query ($id: ID!) { en: entity(id: $id) { ... on DemoRepository { description } } ru: entity(id: $id, lang: "ru") { ... on DemoRepository { description } } }`, { id: repositoryId });
    expect((data['en'] as Record<string, any>).description).toBe('Hello');
    expect((data['ru'] as Record<string, any>).description).toBe('Привет');
  });

  test('SQL filters and the field resolver choose the same language opinion (#11)', async () => {
    const filtered = await graphql(`{ allDemoRepository(where: { description: { _eq: "Hello" } }) { edges { node { name } } } }`);
    expect((filtered['allDemoRepository'] as Record<string, any>).edges.map((edge: any) => edge.node.name)).toEqual(['r1']);
    const read = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoRepository { description contested } } }`, { id: repositoryId });
    const repository = read['entity'] as Record<string, any>;
    expect(repository.description).toBe('Hello');
    expect(repository.contested).not.toContain('description');
  });

  test('a column read for one node is not read as loaded for another (#12)', async () => {
    const data = await graphql(`query ($a: ID!, $b: ID!, $r: ID!) { a: entity(id: $a) { ... on DemoFile { lines } } b: entity(id: $b) { ... on DemoFile { language } } deep: entity(id: $r) { ... on DemoRepository { demoContains(first: 3) { edges { node { node { ... on DemoFile { language } } } } } } } }`, { a: fileA, b: fileB, r: repositoryId });
    const deep = data['deep'] as Record<string, any>;
    const languages = deep.demoContains.edges.map((edge: any) => edge.node.node.language);
    expect(languages).toContain('TypeScript');
  });

  test('a camel-cased edge attribute answers its value and opinions (#13)', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoFile { demoTouched(orderBy: [{ field: weight }], first: 10) { edges { node { weight changedAt changedAtAssertions { value } changedAtAssertions { id } } } } } } }`, { id: fileA });
    const file = data['entity'] as Record<string, any>;
    const edge = file.demoTouched.edges[0].node;
    expect(edge.weight).toBe('2');
    expect(JSON.stringify(edge.changedAt)).toContain('2026-01-01');
    expect(edge.changedAtAssertions).toHaveLength(1);
    expect(edge.changedAtAssertions).toHaveLength(1);
  });

  test('references of a list are batched, not one query per row (#14)', async () => {
    const counted = countingOwner();
    const answer = await executeGraphql(counted.owner, { manifest, folder }, { query: `{ allDemoFile(first: 50) { edges { node { path demoFileRepository(first: 1) { edges { node { node { ... on DemoRepository { name } } } } } } } } }` });
    expect((answer.body as MessageBody).errors).toBeUndefined();
    expect(counted.statements()).toBeLessThan(12);
  });

  test('opinions come newest first, and an edge without attributes still has opinions (#15)', async () => {
    const data = await graphql(`query ($id: ID!, $file: ID!) { entity(id: $id) { ... on DemoRepository { urlAssertions { source { id } } } } file: entity(id: $file) { ... on DemoFile { demoRelated(first: 5) { edges { node { assertions { source { id } } } } } } } }`, { id: repositoryId, file: fileA });
    const repository = data['entity'] as Record<string, any>;
    expect(repository.urlAssertions[0].source.id).toBe('3fc4ccfe-0000-7000-8000-000000000001');
    const file = data['file'] as Record<string, any>;
    expect(file.demoRelated.edges[0].node.assertions[0].source.id).toBe('7692c3ad-0000-7000-8000-000000000001');
    // Fifty-one authenticated producers add their opinions to the original source's opinion.
    await owner.transaction('write', async (tx) => {
      for (let at = 0; at < 51; at += 1) {
        const sourceUid = `0af96a8e-0000-7000-8000-${String(at + 1).padStart(12, '0')}`;
        await bindTestWriteCapability(tx, contract, sourceUid);
        await publishGraphDrafts(tx, contract, {
          vertices: [],
          edges: [{ kind: 'demo.related', from: { kind: 'demo.file', key: { path: 'a.ts' }, keyEdges: { repository: { kind: 'demo.repository', key: { name: 'r1' } } } }, to: { kind: 'demo.file', key: { path: 'b.ts' }, keyEdges: { repository: { kind: 'demo.repository', key: { name: 'r1' } } } }, producer: `many-${String(at)}`, producerVersion: '1' }],
          removals: [],
        }, 1, { author: 'many@1' });
      }
    });
    const bounded = await graphql(`query ($file: ID!) { entity(id: $file) { ... on DemoFile { demoRelated(first: 5) { edges { node { assertions { source { id } } } } } } } }`, { file: fileA });
    const related = (bounded['entity'] as Record<string, any>).demoRelated.edges[0].node.assertions;
    expect(related).toHaveLength(52);
    expect(related[0].source.id).toBeDefined();
  });

  test('a null where argument is an omitted filter (#16)', async () => {
    const data = await graphql(`{ allDemoFile(where: null, first: 2) { edges { node { path } } } catalogue: allCatalogueEntity(where: null, first: 1) { totalCount } filtered: allDemoFile(where: { lines: { _is_null: true }, path: { _in: ["a.ts", "b.ts", "c.ts"] } }, first: 2) { edges { node { path } } } }`);
    expect((data['catalogue'] as Record<string, any>).totalCount).toBe(2);
    expect((data['allDemoFile'] as Record<string, any>).edges).toHaveLength(2);
    expect((data['filtered'] as Record<string, any>).edges.map((edge: any) => edge.node.path)).toEqual(['c.ts']);
  });

  test('the scalar filter operators answer (#17)', async () => {
    const gte2 = await graphql(`{ allDemoFile(where: { lines: { _gte: 10 }, path: { _in: ["a.ts", "b.ts", "c.ts"] } }, orderBy: [{ field: lines }], first: 10) { edges { node { path } } } }`);
    expect((gte2['allDemoFile'] as Record<string, any>).edges.map((edge: any) => edge.node.path)).toEqual(['a.ts', 'b.ts']);
    const like = await graphql(`{ allDemoFile(where: { path: { _like: "%.ts" } }, first: 10) { totalCount } }`);
    expect((like['allDemoFile'] as Record<string, any>).totalCount).toBeGreaterThanOrEqual(3);
    const neq = await graphql(`{ allDemoFile(where: { path: { _in: ["a.ts", "b.ts", "c.ts"], _neq: "a.ts", _nin: ["c.ts"] } }, first: 10) { edges { node { path } } } }`);
    expect((neq['allDemoFile'] as Record<string, any>).edges.map((edge: any) => edge.node.path)).toEqual(['b.ts']);
    const lte = await graphql(`{ allDemoFile(where: { lines: { _lte: 10 }, path: { _in: ["a.ts", "b.ts", "c.ts"] } }, first: 10) { edges { node { path } } } }`);
    expect((lte['allDemoFile'] as Record<string, any>).edges.map((edge: any) => edge.node.path)).toEqual(['a.ts']);
    const isNull = await graphql(`{ allDemoFile(where: { lines: { _is_null: true }, path: { _in: ["a.ts", "b.ts", "c.ts"] } }, first: 10) { edges { node { path } } } }`);
    expect((isNull['allDemoFile'] as Record<string, any>).edges.map((edge: any) => edge.node.path)).toEqual(['c.ts']);
  });

  test('depth admission looks only at the operation the request names (#20)', async () => {
    const document = `query Shallow { allDemoFile(first: 1) { edges { cursor } } } query Deep { allDemoRepository { edges { node { demoContains { edges { node { node { ... on DemoFile { demoContainsOf { edges { node { node { ... on DemoFile { path } } } } } } } } } } } } } }`;
    const shallow = await executeGraphql(owner, { manifest, folder }, { query: document, operationName: 'Shallow' });
    expect((shallow.body as MessageBody).errors).toBeUndefined();
    const deep = await executeGraphql(owner, { manifest, folder }, { query: document, operationName: 'Deep' });
    expect((deep.body as MessageBody).errors?.[0]?.extensions?.code).toBe('LIMIT_DEPTH');
  });
  test('a response over two megabytes is refused with TOO_LARGE (#3)', async () => {
    const answer = await executeGraphql(owner, { manifest, folder }, { query: `query ($id: ID!) { entity(id: $id) { ... on DemoRepository { description } } }`, variables: { id: repository3Id } });
    const body = answer.body as MessageBody;
    expect(body.errors?.[0]?.extensions?.code).toBe('TOO_LARGE');
    expect(body.data).toBeUndefined();
  });
  test('an edge connection keeps its whole count after a page (#9)', async () => {
    const first = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoRepository { demoContains(where: { position: { _in: [1, 2, 3] } }, first: 1) { totalCount pageInfo { endCursor } edges { node { position } } } } } }`, { id: repositoryId });
    let connection = (first['entity'] as Record<string, any>).demoContains;
    expect(connection.totalCount).toBe(3);
    for (let at = 0; at < 2; at += 1) {
      const next = await graphql(`query ($id: ID!, $after: String) { entity(id: $id) { ... on DemoRepository { demoContains(where: { position: { _in: [1, 2, 3] } }, first: 1, after: $after) { totalCount pageInfo { endCursor } edges { node { position } } } } } }`, { id: repositoryId, after: connection.pageInfo.endCursor });
      connection = (next['entity'] as Record<string, any>).demoContains;
      expect(connection.totalCount).toBe(3);
    }
  });

  test('an undeclared storage kind stops its field batch instead of requeuing forever', async () => {
    const counted = countingOwner();
    const label = await counted.owner.transaction('snapshot', async (tx) => {
      const read = new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, 'en', 'fixture', readProductTemplates(folder));
      return await read.resolve(
        { nodeId: '1', uid: 'missing', kind: 'undeclared', key: { name: 'Fallback' }, typeName: 'Undeclared' },
        {}, read, { parentType: { name: 'Undeclared' }, fieldName: 'label' } as never,
      );
    });
    // With no declared title or typed key field, stored key JSON is not a naming contract.
    expect(label).toBe('missing');
    expect(counted.statements()).toBe(0);
  });

  test('a declared text key labels an entity from its canonical assertion, not stored key JSON', async () => {
    const nodeId = await owner.transaction('snapshot', async (tx) => {
      const found = await tx.query<{ id: string }>('SELECT id::text AS id FROM node WHERE uid = $1::uuid', [repositoryId]);
      return found.rows[0]!.id;
    });
    const declared: KindsManifest = manifest;
    const kinds = new Map(declared.kinds);
    kinds.set('demo.repository', { ...kinds.get('demo.repository')!, title: 'unpublished-title' });
    const withoutTitle: KindsManifest = { ...declared, kinds };
    const counted = countingOwner();
    const label = await counted.owner.transaction('snapshot', async (tx) => {
      const read = new ReadContext(tx, withoutTitle, publishedManifestOf(withoutTitle), folder, 'en', 'fixture', readProductTemplates(folder));
      return await read.resolve(
        { nodeId, uid: repositoryId, kind: 'demo.repository', key: { name: 'Not the canonical name' }, typeName: 'DemoRepository' },
        {}, read, { parentType: { name: 'DemoRepository' }, fieldName: 'label' } as never,
      );
    });
    expect(label).toBe('r1');
    expect(counted.statements()).toBe(1);
  });

  test('catalogue diagram labels use the translated catalogue title', async () => {
    const data = await graphql(`{ catalogueEntity(name: "demo.file") { id } }`);
    const id = (data['catalogueEntity'] as { id: string }).id;
    const counted = countingOwner();
    const hood = await counted.owner.transaction('snapshot', async (tx) => {
      const read = new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, 'ru', 'fixture', readProductTemplates(folder));
      return await read.diagramNeighbourhood(id, 1, 'ru');
    });
    expect(hood).toBeDefined();
    expect(hood!.labels.get(id)).toBe('Файл');
    expect(counted.statements()).toBeLessThan(10);
  });

  test('a diagram counts 1 324 children but reads only the bounded sample', async () => {
    const repository = { kind: 'demo.repository', key: { name: 'diagram-budget' } };
    await owner.transaction('write', async (tx) => {
    await bindTestWriteCapability(tx, contract);
      const files = Array.from({ length: 1324 }, (_, at) => ({ kind: 'demo.file', keyEdges: { repository }, key: { path: `budget-${String(at)}.ts` } }));
      await bindTestWriteCapability(tx, contract, '0af96a8e-0000-7000-8000-000000000001');
    await publishGraphDrafts(tx, contract, {
        vertices: [{ ...repository, values: {}, producer: 'budget', producerVersion: '1' }, ...files.map((file) => ({ ...file, values: {}, producer: 'budget', producerVersion: '1' }))],
        edges: files.map((file) => ({ kind: 'demo.contains', from: repository, to: file, values: {}, producer: 'budget', producerVersion: '1' })),
        removals: [],
      }, 1, { author: 'budget@1' });
    });
    const data = await graphql(`{ allDemoRepository(where: { name: { _eq: "diagram-budget" } }) { edges { node { id } } } }`);
    const id = (data['allDemoRepository'] as { edges: { node: { id: string } }[] }).edges[0]!.node.id;
    const counted = countingOwner();
    const started = performance.now();
    const hood = await counted.owner.transaction('snapshot', async (tx) => {
      const read = new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, 'en', 'fixture', readProductTemplates(folder));
      return await read.diagramNeighbourhood(id, 1, 'en');
    });
    const elapsed = performance.now() - started;
    expect(hood).toBeDefined();
    expect(hood!.groups).toMatchObject([
      { relation: 'demo.file-repository', side: 'in', kind: 'demo.file', total: 1324 },
      { relation: 'demo.contains', side: 'out', kind: 'demo.file', total: 1324 },
    ]);
    for (const group of hood!.groups) expect(group.nodes).toHaveLength(12);
    expect(hood!.links).toHaveLength(24);
    expect(hood!.nodes.size).toBe(13);
    expect(hood!.labels.size).toBe(13);
    expect(hood!.truncated).toBe(true);
    expect(counted.statements()).toBeLessThan(10);
    console.log(`diagram read budget: ${elapsed.toFixed(1)} ms, ${String(counted.statements())} statements, ${String(hood!.nodes.size)} nodes`);
    expect(elapsed).toBeLessThan(2000);
  }, 60_000);
});

test('search transfers only requested SQL rows while keeping exact distinct totals', async () => {
  const repository = { kind: 'demo.repository', key: { name: 'search-bound' } };
  await owner.transaction('write', async (tx) => { await bindTestWriteCapability(tx, contract); return await publishGraphDrafts(tx, contract, {
    vertices: [{ ...repository, values: {}, producer: 'search', producerVersion: '1' }, ...Array.from({ length: 60 }, (_, at) => ({ kind: 'demo.file', keyEdges: { repository }, key: { path: `search-bound-${String(at)}.ts` }, values: {}, producer: 'search', producerVersion: '1' }))], edges: [], removals: [],
  }, 1, { author: 'search@1' }); });
  const transferred: number[] = [];
  const wrapped: DatabaseOwner = { ...owner, transaction: (kind, work) => owner.transaction(kind, (tx) => work({ ...tx, query: async (sql: string, values?: readonly unknown[]) => {
    const answer = await tx.query(sql, values);
    if (sql.startsWith('WITH hits AS')) transferred.push(answer.rows.length);
    return answer;
  } } as OuterTransaction)) };
  const run = async (query: string) => {
    const result = await executeGraphql(wrapped, { manifest, folder }, { query });
    const body = result.body as MessageBody;
    expect(body.errors).toBeUndefined();
    return body.data as Record<string, unknown>;
  };
  const flat = await run('{ search(text: "search-bound", kinds: ["demo.file"], first: 2) { totalCount pageInfo { hasNextPage } edges { node { id } } } }');
  expect(flat['search']).toMatchObject({ totalCount: 60, pageInfo: { hasNextPage: true } });
  expect((flat['search'] as { edges: unknown[] }).edges).toHaveLength(2);
  expect(transferred.pop()).toBeLessThanOrEqual(2);
  const empty = await run('{ search(text: "search-bound", kinds: ["demo.file"], first: 0) { totalCount pageInfo { hasNextPage } edges { node { id } } } }');
  expect(empty['search']).toMatchObject({ totalCount: 60, pageInfo: { hasNextPage: true }, edges: [] });
  expect(transferred.pop()).toBeLessThanOrEqual(1);
  const grouped = await run('{ searchGroups(text: "search-bound", kinds: ["demo.file"], perKind: 2) { kind count results { node { id } } } }');
  expect(grouped['searchGroups']).toMatchObject([{ kind: 'demo.file', count: 60 }]);
  expect((grouped['searchGroups'] as { results: unknown[] }[])[0]!.results).toHaveLength(2);
  expect(transferred.pop()).toBeLessThanOrEqual(40);
});


test('search uses the declared evidence content field rather than conventional property names', async () => {
  const held = manifest as KindsManifest;
  const declared = held.kinds.get('demo.file')!;
  const original = held.kinds;
  const searchManifest = { ...held, kinds: new Map(original) };
  searchManifest.kinds.set('demo.file', { ...declared, evidence: { immutable: true, contentField: 'payload', digestField: 'digest', digestAlgorithm: 'sha256' }, fields: [
    { name: 'path', type: 'text' }, { name: 'body', type: 'text' }, { name: 'payload', type: 'text' },
  ] });
  const statements: string[] = [];
  const values: unknown[] = [];
  await owner.transaction('snapshot', async tx => {
    const context = new ReadContext({ ...tx, query: async (sql: string, parameters?: readonly unknown[]) => {
      statements.push(sql);
      values.push(...parameters ?? []);
      if (sql.startsWith('WITH hits AS')) return { rows: [] };
      return await tx.query(sql, parameters);
    } } as OuterTransaction, searchManifest, { kinds: [{ name: 'demo.file', key: ['path'], fields: [
      { name: 'path', type: 'text' }, { name: 'body', type: 'text' }, { name: 'payload', type: 'text' },
    ] }], edges: [], relations: [] }, folder, 'en', 'fixture', readProductTemplates(folder));
    await context.resolve(undefined, { text: 'needle', kinds: ['demo.file'], first: 2 }, context, { fieldName: 'search', parentType: { name: 'Query' } } as never);
  });
  expect(statements.some(sql => sql.startsWith('WITH hits AS'))).toBe(true);
  expect(values).toContain('body');
  expect(values).not.toContain('payload');
});

test('a durable resolution selects the same value for fields, filters, order and aggregates', async () => {
  const disputeContract = withAssertionContract(contract);
  const a = await registerSystemSource(owner, disputeContract, { type: 'plugin', installationKey: 'resolution-a', scope: 'fixture', version: '1' });
  const b = await registerSystemSource(owner, disputeContract, { type: 'plugin', installationKey: 'resolution-b', scope: 'fixture', version: '1' });
  const judge = await registerSystemSource(owner, disputeContract, { type: 'plugin', installationKey: 'resolution-judge', scope: 'fixture', version: '1' });
  const grant = (principal: typeof a.principal, resolve = false) => bindGraphProducer(owner, disputeContract, { principal, vertices: { 'demo.repository': ['description'], 'system.content-snapshot': ['digest', 'content'] }, edges: {}, actions: resolve ? ['assert', 'retract-own', 'resolve'] : ['assert', 'retract-own'] });
  const ga = grant(a.principal), gb = grant(b.principal), gj = grant(judge.principal, true);
  const target = await owner.run(async tx => (await tx.query<{ id: string }>('SELECT id::text FROM node WHERE uid=$1::uuid', [repository3Id])).rows[0]!.id);
  const write = async (binding: typeof ga, value: string) => owner.transaction('write', async tx => {

    await activateGraphProducer(tx, disputeContract, binding);
    await writeAssertion(tx, disputeContract, { sort: 'vertex', kind: 'demo.repository', subjectId: target, property: 'description', operation: 'assert', value, language: 'en', validFrom: '2020-01-01T00:00:00Z' });
    await reconcileDisputes(tx, contract);

  });
  await write(ga, 'Chosen resolution');
  await write(gb, 'Newest losing value');
  const question = await owner.transaction('snapshot', async tx => readDispute(tx, disputeContract, (await loadAssertions(tx, 'vertex', 'demo.repository', ['description'], [Number(target)])).filter(row => row.language === 'en'), { validAt: new Date().toISOString(), recordedAt: new Date().toISOString(), contexts: [1] }));
  expect(question?.state).toBe('OPEN');
  const rows = await owner.run(tx => loadAssertions(tx, 'vertex', 'demo.repository', ['description'], [Number(target)]));
  const chosen = rows.find(row => row.value === 'Chosen resolution')!;
  const content = 'A durable resolution evidence snapshot';
  const digest = createHash('sha256').update(content).digest('hex');
  await owner.transaction('write', async tx => {

    await activateGraphProducer(tx, disputeContract, gj);
    await publishGraphDrafts(tx, disputeContract, { vertices: [{ kind: 'system.content-snapshot', key: { digest }, values: { content }, producer: 'fixture', producerVersion: '1' }], removals: [] });
    await resolveDispute(tx, disputeContract, gj, { questionUid: question!.id, chosenAssertionUid: chosen.id, expectedCandidates: question!.candidates, rationale: 'Confirmed by snapshot', evidence: [{ target: { kind: 'system.content-snapshot', key: { digest } } }] });

  });
  const result = await graphql(`query ($id: ID!) {
    entity(id: $id) { ... on DemoRepository { description contested descriptionAssertions { id selected question { id state candidates { id } resolution { id value source { id } } supersededResolutions { id } } } } }
    allDemoRepository(where: { description: { _eq: "Chosen resolution" } }, orderBy: [{field: description}]) { totalCount edges { node { description } } }
    ordered: allDemoRepository(orderBy: [{field: description}], first: 1) { edges { node { name } } }
    allDemoRepositoryAggregate(where: { description: { _eq: "Chosen resolution" } }) { count }
  }`, { id: repository3Id });
  const entity = result['entity'] as Record<string, any>;
  expect(entity.description).toBe('Chosen resolution');
  const exposed = entity.descriptionAssertions.find((row: any) => row.id === chosen.id).question;
  expect(exposed.id).toBe(question!.id);
  expect(exposed.state).toBe('RESOLVED');
  expect(exposed.candidates.map((row: any) => row.id).sort()).toEqual([...question!.candidates].sort());
  expect(exposed.resolution.value).toBe('Chosen resolution');
  expect(exposed.resolution.source.id).toBe(keyUid('system.resolution-source', [gj.principalUid]));
  expect(exposed.supersededResolutions).toEqual([]);
  expect(entity.contested).not.toContain('description');
  expect(entity.descriptionAssertions.filter((row: any) => row.selected).map((row: any) => row.id)).toEqual([exposed.resolution.id]);
  expect((result['allDemoRepository'] as Record<string, any>).totalCount).toBe(1);
  expect((result['allDemoRepository'] as Record<string, any>).edges[0].node.description).toBe('Chosen resolution');
  expect((result['allDemoRepositoryAggregate'] as Record<string, any>).count).toBe(1);
  expect((result['ordered'] as Record<string, any>).edges[0].node.name).toBe('r3');
  const record = await owner.transaction('snapshot', tx => readKindAssertions(tx, 'vertex', 'demo.repository', ['description'], { contract: disputeContract, subjectIds: [Number(target)] }));
  expect(record[0]!.values['description']).toBe('Chosen resolution');
  const resolvedAt = new Date().toISOString();
  await write(gb, 'Changed losing value');
  const reopened = await graphql(`query ($id: ID!) { entity(id: $id) { ... on DemoRepository { description contested descriptionAssertions { question { state resolution { id } supersededResolutions { id } } } } } }`, { id: repository3Id });
  const openEntity = reopened['entity'] as Record<string, any>;
  expect(openEntity.description).toBe('Changed losing value');
  expect(openEntity.contested).toContain('description');
  expect(openEntity.descriptionAssertions[0].question.state).toBe('OPEN');
  expect(openEntity.descriptionAssertions[0].question.resolution).toBeNull();
  expect(openEntity.descriptionAssertions[0].question.supersededResolutions).toHaveLength(1);
  const historical = await graphql(`query ($id: ID!, $at: DateTime!) { entity(id: $id, recordedAt: $at) { ... on DemoRepository { description contested } } }`, { id: repository3Id, at: resolvedAt });
  expect((historical['entity'] as Record<string, any>).description).toBe('Chosen resolution');
  expect((historical['entity'] as Record<string, any>).contested).not.toContain('description');
  // A source can deny existence or withdraw only its own stream, not another source's live assertion.
  await owner.transaction('write', async tx => {

    await activateGraphProducer(tx, disputeContract, gb);
    await writeAssertion(tx, disputeContract, { sort: 'vertex', kind: 'demo.repository', subjectId: target, property: '$exists', operation: 'assert', value: false });

  });
  const stillLive = await owner.transaction('snapshot', tx => readKindAssertions(tx, 'vertex', 'demo.repository', [], { contract: disputeContract, subjectIds: [Number(target)] }));
  expect(stillLive).toHaveLength(1);
  const existsRead = await graphql(`query ($id: ID!) { entity(id: $id) { id } }`, { id: repository3Id });
  expect((existsRead['entity'] as Record<string, unknown>).id).toBe(repository3Id);
  await owner.transaction('write', async tx => {

    await activateGraphProducer(tx, disputeContract, gb);
    await writeAssertion(tx, disputeContract, { sort: 'vertex', kind: 'demo.repository', subjectId: target, property: '$exists', operation: 'retract' });

  });
  expect(await owner.transaction('snapshot', tx => readKindAssertions(tx, 'vertex', 'demo.repository', [], { contract: disputeContract, subjectIds: [Number(target)] }))).toHaveLength(1);
}, 30000);


test('assertion evidence metadata batches one hundred distinct rows', async () => {
  const content = 'Shared immutable evidence for the metadata batch';
  const digest = createHash('sha256').update(content).digest('hex');
  const snapshot = { kind: 'system.content-snapshot', key: { digest } };
  await owner.transaction('write', async tx => {

    await bindTestWriteCapability(tx, contract);
    await publishGraphDrafts(tx, contract, {
      vertices: [{ ...snapshot, values: { digest, content }, producer: 'metadata-batch', producerVersion: '1' },
        ...Array.from({ length: 100 }, (_, index) => ({ kind: 'demo.repository', key: { name: `metadata-batch-${String(index).padStart(3, '0')}` },
          values: { url: `https://batch.test/${String(index)}` }, producer: 'metadata-batch', producerVersion: '1',
          evidence: [{ target: snapshot, relation: 'supports' as const, locator: {} }] }))], removals: [],
    });

  });
  const statements: string[] = [];
  const counted: DatabaseOwner = { ...owner, transaction: (kind, work) => owner.transaction(kind, tx => work({ ...tx,
    query: (sql: string, parameters?: readonly unknown[]) => { statements.push(sql); return tx.query(sql, parameters); },
  } as OuterTransaction)) };
  const run = async (first: number) => await executeGraphql(counted, { manifest, folder }, { query: `{
    allDemoRepository(first: ${String(first)}, where: { name: { _like: "metadata-batch-%" } }) {
      edges { node { name urlAssertions { value evidence { targetUid historicalValidity currentApplicability availability issues } } } }
    }
  }` });
  const one = await run(1);
  expect(one.body.errors).toBeUndefined();
  expect((one.body.data as Record<string, any>)['allDemoRepository'].edges).toHaveLength(1);
  const singleCount = statements.length;
  statements.length = 0;
  const answer = await run(100);
  const body = answer.body as { errors?: unknown[]; data: { allDemoRepository: { edges: { node: { urlAssertions: { evidence: { historicalValidity: string; availability: string }[] }[] } }[] } } };
  expect(body.errors).toBeUndefined();
  const edges = body.data.allDemoRepository.edges;
  expect(edges).toHaveLength(100);
  for (const edge of edges) {
    expect(edge.node.urlAssertions).toHaveLength(1);
    expect(edge.node.urlAssertions[0]!.evidence).toHaveLength(1);
    expect(edge.node.urlAssertions[0]!.evidence[0]!.historicalValidity).toBe('VALID');
    expect(edge.node.urlAssertions[0]!.evidence[0]!.availability).toBe('AVAILABLE');
  }
  const evidenceStatements = statements.filter(sql => sql.includes('AS assertion_uid,target.uid'));
  expect(evidenceStatements).toHaveLength(1);
  expect(statements.length).toBe(singleCount);
  console.log(`metadata batch: 100 assertions, ${String(evidenceStatements.length)} evidence-link statement, ${String(singleCount)} one-row / ${String(statements.length)} hundred-row total statements`);
}, 60000);


test('language fallback agrees with SQL after temporal and context selection', async () => {
  const key = { name: 'language-fallback-snapshot' };
  await owner.transaction('write', async tx => {

    await bindTestWriteCapability(tx, contract);
    await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'demo.repository', key, values: { description: 'Active English fallback' }, lang: 'en', producer: 'language-fixture', producerVersion: '1' }], removals: [] });

  });
  const recordedAt = await owner.run(async tx => new Date((await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now).toISOString());
  const context = await owner.transaction('write', async tx => {

    const id = Number((await tx.query<{ id: string }>("INSERT INTO context(parent,ref,parent_recorded_seq) VALUES(1,'language-fallback-pinned',-1) RETURNING id::text")).rows[0]!.id);

    return id;
  });
  const id = await owner.run(async tx => (await tx.query<{ uid: string }>("SELECT n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='demo.repository' AND n.key->>'name'=$1", [key.name])).rows[0]!.uid);
  await owner.transaction('write', async tx => {

    await bindTestWriteCapability(tx, contract);
    await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'demo.repository', key, values: { description: 'Future Russian' }, lang: 'ru', validFrom: '2099-01-01T00:00:00.000Z', producer: 'language-fixture', producerVersion: '1' }], removals: [] });

  });
  const check = async (selectors: string) => {
    const data = await graphql(`query ($id: ID!) {
      entity(id: $id, lang: "ru", ${selectors}) { ... on DemoRepository { description } }
      filtered: allDemoRepository(lang: "ru", ${selectors}, where: { name: { _eq: "language-fallback-snapshot" }, description: { _eq: "Active English fallback" } }) { totalCount edges { node { description } } }
      ordered: allDemoRepository(lang: "ru", ${selectors}, where: { name: { _eq: "language-fallback-snapshot" } }, orderBy: [{ field: description }]) { edges { node { description } } }
      aggregate: allDemoRepositoryAggregate(lang: "ru", ${selectors}, where: { name: { _eq: "language-fallback-snapshot" }, description: { _eq: "Active English fallback" } }) { count }
    }`, { id });
    expect(data['entity']).toEqual({ description: 'Active English fallback' });
    expect(data['filtered']).toEqual({ totalCount: 1, edges: [{ node: { description: 'Active English fallback' } }] });
    expect(data['ordered']).toEqual({ edges: [{ node: { description: 'Active English fallback' } }] });
    expect(data['aggregate']).toEqual({ count: 1 });
  };
  await check('validAt: "2027-01-01T00:00:00.000Z"');
  await check(`recordedAt: "${recordedAt}"`);
  await check(`context: ${String(context)}`);
  await owner.transaction('write', async tx => {

    await bindTestWriteCapability(tx, contract);
    const subject = (await tx.query<{ id: string }>('SELECT id::text FROM node WHERE uid=$1::uuid', [id])).rows[0]!.id;
    await writeAssertion(tx, contract, { sort: 'vertex', kind: 'demo.repository', subjectId: subject, property: 'description', operation: 'retract', language: 'ru', validFrom: '2020-01-01T00:00:00.000Z' });

  });
  await check('validAt: "2100-01-01T00:00:00.000Z"');
}, 30000);
