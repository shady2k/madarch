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
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { executeGraphql, type MessageBody } from '../src/graph/graphql-execute.js';
import { ReadContext } from '../src/graph/graphql-read.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { readTemplatesOf } from './page-templates-fixture.js';
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
  // One role leads the demo area and reads its files: the frame's purposes and audiences, and the role's leading groups.
  const catalog = readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml'), 'utf8')
    .replace('language: en\n', 'language: en\nroles:\n  developer: { lead: [demo] }\n');
  writeFileSync(join(folder, 'madarch/catalog.yaml'), catalog);
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.repository.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.repository.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.file.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.file.yaml'), 'utf8')
    .replace('purpose: structure\n', 'purpose: structure\naudience: [developer]\n'));
  execFileSync('git', ['init', '-q'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.source.yaml'), `id: demo.source
purpose: structure
definition: A source text fixture.
description: {en: A source text fixture., ru: Исходный текст для проверки.}
sources: [https://example.test/standard]
acquisition: [document]
relation-constraints: {out: [], in: []}
template-policy: page
source: graph
fields:
  - {name: repository, type: text, producers: [agent]}
  - {name: path, type: text, producers: [agent]}
  - {name: blob, type: text, producers: [agent]}
key: [repository, path]
file-text: {repository: repository, path: path, blob: blob}
labels:
  en: {one: Source, many: Sources}
  ru: {one: Источник, many: Источники}
`);
  const read = readKinds(folder);
  if (!read.present) throw new Error('the fixture product holds no manifest');
  if (read.manifest.findings.length > 0) throw new Error(read.manifest.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  manifest = read.manifest as never;
  // Every declared edge kind has its table (owner's rule): the manifest's own declaration is the contract.
  contract = withManifestContract(graphContractOf(read.manifest));

  owner = await createTestDatabaseOwner({ graphContract: contract });
  const repository = (name: string) => ({ kind: 'demo.repository', key: { name } });
  const file = (path: string) => ({ kind: 'demo.file', key: { repository: repository('r1'), path } });
  const big = 'x'.repeat(2_200_000);
  await owner.transaction('write', async (tx) => {
    await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'demo.source', key: {repository: 'source-repo', path: 'sample.ts'}, values: {blob: 'source-blob'}, producer: 'one', producerVersion: '1' },
        { kind: 'demo.repository', key: { name: 'r1' }, values: { url: 'https://one.test', size: 2, archived: true }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.file', key: file('a.ts').key, values: { lines: 10, language: 'TypeScript', primary: repository('r1'), preferred: repository('r1') }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.file', key: file('b.ts').key, values: { lines: 20, primary: repository('r1') }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.file', key: file('c.ts').key, values: {}, producer: 'one', producerVersion: '1' },
      ],
      edges: [
        { kind: 'demo.contains', from: repository('r1'), to: file('a.ts'), values: { position: 1 }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.contains', from: repository('r1'), to: file('b.ts'), values: { position: 2 }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.contains', from: repository('r1'), to: file('c.ts'), values: { position: 3 }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.related', from: file('a.ts'), to: file('b.ts'), producer: 'one', producerVersion: '1' },
        { kind: 'demo.touched', from: file('a.ts'), to: file('b.ts'), discriminator: 'w2', values: { weight: 2, changed_at: '2026-01-01T00:00:00Z' }, producer: 'one', producerVersion: '1' },
        { kind: 'demo.touched', from: file('a.ts'), to: file('c.ts'), discriminator: 'w10', values: { weight: 10, changed_at: '2026-02-01T00:00:00Z' }, producer: 'one', producerVersion: '1' },
      ],
      removals: [],
    }, 1, { author: 'one@1' });
    await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'demo.repository', key: { name: 'r1' }, values: { url: 'https://two.test' }, producer: 'two', producerVersion: '1' },
        { kind: 'demo.file', key: file('a.ts').key, values: { primary: repository('r1') }, producer: 'two', producerVersion: '1' },
        { kind: 'demo.file', key: file('b.ts').key, values: { primary: repository('r2') }, producer: 'two', producerVersion: '1' },
      ],
      removals: [],
    }, 1, { author: 'two@1' });
    await publishGraphDrafts(tx, contract, {
      vertices: [{ kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'B' }, producer: 'neutral', producerVersion: '1' }],
      removals: [],
    }, 1, { author: 'neutral@1' });
    await publishGraphDrafts(tx, contract, {
      vertices: [
        { kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'Hello' }, lang: 'en', producer: 'english', producerVersion: '1' },
        { kind: 'demo.repository', key: { name: 'r1' }, values: { description: 'Привет' }, lang: 'ru', producer: 'russian', producerVersion: '1' },
      ],
      removals: [],
    }, 1, { author: 'translated@1' });
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
  const held = await owner.transaction('snapshot', (tx) => readTemplatesOf(tx, manifest));
  await expect(owner.transaction('snapshot', (tx) => new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, 'en', 'test', held.templates, held.files, held.bodies, held.findings).diagramNeighbourhood(repositoryId, 2, 'en'))).rejects.toThrow('deeper diagram neighbourhoods are not supported');
});

afterAll(async () => {
  await owner?.close();
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the GraphQL executor', () => {
  test('stable keys resolve entities without guessing a kind or leaking missing keys', async () => {
    const data = await graphql(`query { entityByKey(kind: "demo.repository", key: {name: "r1"}) { id label } missing: entityByKey(kind: "demo.repository", key: {name: "absent"}) { id } undeclared: entityByKey(kind: "missing.kind", key: {name: "r1"}) { id } }`);
    expect(data['entityByKey']).toEqual({ id: repositoryId, label: 'r1' });
    expect(data['missing']).toBeNull();
    expect(data['undeclared']).toBeNull();
  });

  test('generic relations filter, sort, page and inherit the nested entity', async () => {
    const query = `query ($id: ID!, $after: String) { entity(id: $id) { related(edge: "demo.contains", kinds: ["demo.file"], where: {lines: {_gte: 10}}, orderBy: [{field: "lines", direction: DESC}], first: 1, after: $after) { totalCount pageInfo { endCursor hasNextPage } edges { node { id label related(edge: "demo.contains", inverse: true) { totalCount edges { node { id } } } } } } } }`;
    const first = await graphql(query, { id: repositoryId });
    const connection = (first['entity'] as any).related;
    expect(connection.totalCount).toBe(2);
    expect(connection.pageInfo.hasNextPage).toBe(true);
    expect(connection.edges[0].node.label).toBe('b.ts');
    expect(connection.edges[0].node.related).toMatchObject({ totalCount: 1, edges: [{ node: { id: repositoryId } }] });
    const second = await graphql(query, { id: repositoryId, after: connection.pageInfo.endCursor });
    expect((second['entity'] as any).related).toMatchObject({ totalCount: 2, pageInfo: {hasNextPage: false}, edges: [{ node: { label: 'a.ts' } }] });
    const invalid = await refusal(`{ related(id:"${repositoryId}",edge:"demo.contains",depth:4) {totalCount} }`);
    expect(invalid.message).toContain('related depth must be between 1 and 3');
  });


  test('an entity by id answers its fields and its reference', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { id kind label ... on KindDemoFile { path lines repository { ... on KindDemoRepository { name } } } } }`, { id: fileA });
    const entity = data['entity'] as Record<string, unknown>;
    expect(entity['id']).toBe(fileA);
    expect(entity['kind']).toBe('demo.file');
    expect(entity['label']).toBe('a.ts');
    expect(entity['path']).toBe('a.ts');
    expect(entity['lines']).toBe(10);
    expect(entity['repository']).toMatchObject({ name: 'r1' });
  });

  test('an edge answers both ways with its record and attribute', async () => {
    const from = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoRepository { demoContains(first: 10) { totalCount edges { node { discriminator position node { ... on KindDemoFile { path } } } } } } } }`, { id: repositoryId });
    const repository = from['entity'] as Record<string, any>;
    expect(repository.demoContains.totalCount).toBe(3);
    expect(repository.demoContains.edges.map((edge: any) => edge.node.node.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(repository.demoContains.edges[0].node.position).toBe(1);
    expect(repository.demoContains.edges[0].node.discriminator).toBe('');
    const to = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoFile { demoContainsOf(first: 10) { edges { node { node { ... on KindDemoRepository { name } } } } } } } }`, { id: fileA });
    const file = to['entity'] as Record<string, any>;
    expect(file.demoContainsOf.edges[0].node.node.name).toBe('r1');
  });

  test('a backlink names the inverse field and the vertex it comes from', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { backlinks(first: 10) { totalCount edges { node { relation from { ... on KindDemoRepository { name } } } } } } }`, { id: fileA });
    const entity = data['entity'] as Record<string, any>;
    expect(entity.backlinks.totalCount).toBe(1);
    expect(entity.backlinks.edges[0].node.relation).toBe('demoContainsOf');
    expect(entity.backlinks.edges[0].node.from.name).toBe('r1');
  });

  test('two producers that disagree give null, contested and both opinions', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoRepository { url urlOpinions { value producer } contested } } }`, { id: repositoryId });
    const repository = data['entity'] as Record<string, any>;
    expect(repository.url).toBeNull();
    expect(repository.contested).toContain('url');
    expect(repository.urlOpinions.map((one: any) => one.value).sort()).toEqual(['https://one.test', 'https://two.test']);
    expect(repository.urlOpinions.map((one: any) => one.producer).sort()).toEqual(['one', 'two']);
  });

  test('details answer every declared field with its value, its mark and the opinions that hold it', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { details { name type key value contested opinions { producer value } } } }`, { id: repositoryId });
    const details = (data['entity'] as Record<string, any>).details as Record<string, any>[];
    expect(details.map((one: Record<string, any>) => one.name)).toEqual(['archived', 'description', 'name', 'size', 'url']);
    const url = details.find((one: Record<string, any>) => one.name === 'url')!;
    expect(url.contested).toBe(true);
    expect(url.value).toBeNull();
    expect(url.opinions.map((one: Record<string, any>) => one.producer).sort()).toEqual(['one', 'two']);
    const size = details.find((one: Record<string, any>) => one.name === 'size')!;
    expect(size).toMatchObject({ type: 'integer', key: false, value: 2, contested: false });
    const key = details.find((one: Record<string, any>) => one.name === 'name')!;
    expect(key.key).toBe(true);
    expect(key.value).toBe('r1');
    expect(key.opinions).toEqual([]);
  });

  test('trail names the containers outermost first', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { label trail { id kind label } } }`, { id: fileA });
    const trail = (data['entity'] as Record<string, any>).trail as Record<string, any>[];
    expect(trail.map((one) => one.label)).toEqual(['r1']);
    expect(trail[0]!.kind).toBe('demo.repository');
    const repository = await graphql(`query ($id: ID!) { entity(id: $id) { trail { id } } }`, { id: repositoryId });
    expect((repository['entity'] as Record<string, any>).trail).toEqual([]);
  });

  test('origin names the place the newest opinion rests on', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { origin } }`, { id: repositoryId });
    expect((data['entity'] as Record<string, any>).origin).toBeNull();
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
    expect((all['allCatalogueEntity'] as Record<string, any>).totalCount).toBe(3);
  });

  test('a query deeper than seven levels is refused with LIMIT_DEPTH', async () => {
    const answer = await refusal(`{ allDemoRepository { edges { node { demoContains { edges { node { demoContainsOf { edges { node { node { ... on KindDemoFile { path } } } } } } } } } } } }`);
    expect(answer.code).toBe('LIMIT_DEPTH');
    expect(answer.message).toContain('the limit is 7');
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

  test('a field answers its typed value, not a JSON text (#1)', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoRepository { size archived description } } }`, { id: repositoryId });
    const repository = data['entity'] as Record<string, unknown>;
    expect(repository['size']).toBe(2);
    expect(repository['archived']).toBe(true);
    expect(repository['description']).toBe('Hello');
  });

  test('a key reference answers its inverse, and an agreed non-key reference answers it once (#2, #5)', async () => {
    const keyed = await graphql(`{ allDemoRepository(where: { name: { _eq: "r1" } }) { edges { node { repositoryOfDemoFile(where: { path: { _in: ["a.ts", "b.ts", "c.ts"] } }, first: 10) { totalCount edges { node { path } } } } } } }`);
    const repository = (keyed['allDemoRepository'] as Record<string, any>).edges[0].node;
    expect(repository.repositoryOfDemoFile.totalCount).toBe(3);
    expect(repository.repositoryOfDemoFile.edges.map((edge: any) => edge.node.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const agreed = await graphql(`query ($r1: ID!, $r2: ID!) { r1: entity(id: $r1) { ... on KindDemoRepository { primaryOfDemoFile(first: 10) { totalCount edges { node { path } } } backlinks(first: 20) { edges { node { relation } } } } } r2: entity(id: $r2) { ... on KindDemoRepository { primaryOfDemoFile(first: 10) { totalCount } } } }`, { r1: repositoryId, r2: repository2Id });
    const r1 = agreed['r1'] as Record<string, any>;
    expect(r1.primaryOfDemoFile.totalCount).toBe(1);
    expect(r1.primaryOfDemoFile.edges.map((edge: any) => edge.node.path)).toEqual(['a.ts']);
    expect(r1.backlinks.edges.filter((edge: any) => edge.node.relation === 'primaryOfDemoFile')).toHaveLength(1);
    expect(r1.backlinks.edges.map((edge: any) => edge.node.relation)).toContain('repositoryOfDemoFile');
    expect((agreed['r2'] as Record<string, any>).primaryOfDemoFile.totalCount).toBe(0);
  });

  test('a reference declared text answers its inverse and its backlink, not a database error (madarch-64o5.83)', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoRepository { preferredOfDemoFile(first: 10) { totalCount edges { node { path } } } backlinks(first: 20) { edges { node { relation } } } } } }`, { id: repositoryId });
    const repository = data['entity'] as Record<string, any>;
    expect(repository.preferredOfDemoFile.totalCount).toBe(1);
    expect(repository.preferredOfDemoFile.edges.map((edge: any) => edge.node.path)).toEqual(['a.ts']);
    expect(repository.backlinks.edges.map((edge: any) => edge.node.relation)).toContain('preferredOfDemoFile');
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
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoFile { demoTouched(orderBy: [{ field: weight }], first: 10) { edges { node { weight } } } } } }`, { id: fileA });
    const file = data['entity'] as Record<string, any>;
    expect(file.demoTouched.edges.map((edge: any) => edge.node.weight)).toEqual(['2', '10']);
  });

  test('the starter catalogue template composes its header, and its kinds are the command read', async () => {
    const bootstrap: Bootstrap = {
      structureRevision: 'r',
      home: null,
      catalogueTemplate: 'entity',
      templates: ['catalogue', 'entity'].map((name) => ({ name, body: readFileSync(join(folder, 'templates', `${name}.yaml`), 'utf8') })),
      recordTemplates: [], ownTemplates: [], roles: [], roleLeads: [],
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
    const data = await graphql(`{ bootstrap { structureRevision home { id kind template } catalogueTemplate templates { name } recordTemplates { kind template } ownTemplates { id template } roles roleLeads { role lead } } }`);
    const held = data['bootstrap'] as Record<string, any>;
    expect(held.structureRevision).toHaveLength(64);
    // This fixture holds no home kind: the home is null, and the mechanisms's other names stand.
    expect(held.home).toBeNull();
    expect(held.catalogueTemplate).toBe('entity');
    expect(held.templates.map((one: any) => one.name).sort()).toEqual(['catalogue', 'entity', 'home', 'own', 'record']);
    expect(held.recordTemplates).toEqual([{ kind: 'demo.file', template: 'record' }]);
    expect(held.ownTemplates).toEqual([{ id: 'own-entity', template: 'own' }]);
    expect(Array.isArray(held.roles)).toBe(true);
    expect(held.roles).toEqual(['developer']);
    // The groups a role lists first, as the manifest declares them: the sidebar reads them with the bootstrap.
    expect(held.roleLeads).toEqual([{ role: 'developer', lead: ['demo'] }]);
  });

  test('the navigation names each kind\'s purpose and the roles it is meant for', async () => {
    const data = await graphql(`{ navigation { purposes { id } kinds { kind purpose audience } } }`);
    const navigation = data['navigation'] as Record<string, any>;
    expect(navigation.purposes.map((one: any) => one.id)).toEqual(['structure']);
    const kinds = new Map(navigation.kinds.map((one: any) => [one.kind, one]));
    expect(kinds.get('demo.file')).toMatchObject({ purpose: 'structure', audience: ['developer'] });
    expect(kinds.get('demo.repository')).toMatchObject({ purpose: 'structure', audience: null });
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
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { outgoing(first: 10) { totalCount edges { node { relation to { kind ... on KindDemoFile { path } } } } } } }`, { id: repositoryId });
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
    const data = await graphql(`query ($id: ID!) { en: entity(id: $id) { ... on KindDemoRepository { description } } ru: entity(id: $id, lang: "ru") { ... on KindDemoRepository { description } } }`, { id: repositoryId });
    expect((data['en'] as Record<string, any>).description).toBe('Hello');
    expect((data['ru'] as Record<string, any>).description).toBe('Привет');
  });

  test('SQL filters and the field resolver choose the same language opinion (#11)', async () => {
    const filtered = await graphql(`{ allDemoRepository(where: { description: { _eq: "Hello" } }) { edges { node { name } } } }`);
    expect((filtered['allDemoRepository'] as Record<string, any>).edges.map((edge: any) => edge.node.name)).toEqual(['r1']);
    const read = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoRepository { description contested } } }`, { id: repositoryId });
    const repository = read['entity'] as Record<string, any>;
    expect(repository.description).toBe('Hello');
    expect(repository.contested).not.toContain('description');
  });

  test('a column read for one node is not read as loaded for another (#12)', async () => {
    const data = await graphql(`query ($a: ID!, $b: ID!, $r: ID!) { a: entity(id: $a) { ... on KindDemoFile { lines } } b: entity(id: $b) { ... on KindDemoFile { language } } deep: entity(id: $r) { ... on KindDemoRepository { demoContains(first: 3) { edges { node { node { ... on KindDemoFile { language } } } } } } } }`, { a: fileA, b: fileB, r: repositoryId });
    const deep = data['deep'] as Record<string, any>;
    const languages = deep.demoContains.edges.map((edge: any) => edge.node.node.language);
    expect(languages).toContain('TypeScript');
  });

  test('a camel-cased edge attribute answers its value and opinions (#13)', async () => {
    const data = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoFile { demoTouched(orderBy: [{ field: weight }], first: 10) { edges { node { weight changedAt changedAtOpinions { value } changedAtOpinionsCount } } } } } }`, { id: fileA });
    const file = data['entity'] as Record<string, any>;
    const edge = file.demoTouched.edges[0].node;
    expect(edge.weight).toBe('2');
    expect(JSON.stringify(edge.changedAt)).toContain('2026-01-01');
    expect(edge.changedAtOpinions).toHaveLength(1);
    expect(edge.changedAtOpinionsCount).toBe(1);
  });

  test('references of a list are batched, not one query per row (#14)', async () => {
    const counted = countingOwner();
    const answer = await executeGraphql(counted.owner, { manifest, folder }, { query: `{ allDemoFile(first: 50) { edges { node { path repository { ... on KindDemoRepository { name } } } } } }` });
    expect((answer.body as MessageBody).errors).toBeUndefined();
    expect(counted.statements()).toBeLessThan(12);
  });

  test('opinions come newest first, and an edge without attributes still has opinions (#15)', async () => {
    const data = await graphql(`query ($id: ID!, $file: ID!) { entity(id: $id) { ... on KindDemoRepository { urlOpinions { producer } } } file: entity(id: $file) { ... on KindDemoFile { demoRelated(first: 5) { edges { node { opinions { producer } } } } } } }`, { id: repositoryId, file: fileA });
    const repository = data['entity'] as Record<string, any>;
    expect(repository.urlOpinions[0].producer).toBe('two');
    const file = data['file'] as Record<string, any>;
    expect(file.demoRelated.edges[0].node.opinions.map((one: any) => one.producer)).toEqual(['one']);
    // Fifty-one producers on one edge: the list is the 50 newest, never every opinion the graph holds.
    await owner.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, contract, {
        vertices: [],
        edges: Array.from({ length: 51 }, (_, at) => ({ kind: 'demo.related', from: { kind: 'demo.file', key: { repository: { kind: 'demo.repository', key: { name: 'r1' } }, path: 'a.ts' } }, to: { kind: 'demo.file', key: { repository: { kind: 'demo.repository', key: { name: 'r1' } }, path: 'b.ts' } }, producer: `many-${String(at)}`, producerVersion: '1' })),
        removals: [],
      }, 1, { author: 'many@1' });
    });
    const bounded = await graphql(`query ($file: ID!) { entity(id: $file) { ... on KindDemoFile { demoRelated(first: 5) { edges { node { opinions { producer } } } } } } }`, { file: fileA });
    const related = (bounded['entity'] as Record<string, any>).demoRelated.edges[0].node.opinions;
    expect(related).toHaveLength(50);
    expect(related[0].producer).toBe('many-50');
  });

  test('a null where argument is an omitted filter (#16)', async () => {
    const data = await graphql(`{ allDemoFile(where: null, first: 2) { edges { node { path } } } catalogue: allCatalogueEntity(where: null, first: 1) { totalCount } filtered: allDemoFile(where: { lines: { _is_null: true }, path: { _in: ["a.ts", "b.ts", "c.ts"] } }, first: 2) { edges { node { path } } } }`);
    expect((data['catalogue'] as Record<string, any>).totalCount).toBe(3);
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
    const document = `query Shallow { allDemoFile(first: 1) { edges { cursor } } } query Deep { allDemoRepository { edges { node { demoContains { edges { node { node { ... on KindDemoFile { demoContainsOf { edges { node { node { ... on KindDemoFile { path } } } } } } } } } } } } } }`;
    const shallow = await executeGraphql(owner, { manifest, folder }, { query: document, operationName: 'Shallow' });
    expect((shallow.body as MessageBody).errors).toBeUndefined();
    const deep = await executeGraphql(owner, { manifest, folder }, { query: document, operationName: 'Deep' });
    expect((deep.body as MessageBody).errors?.[0]?.extensions?.code).toBe('LIMIT_DEPTH');
  });
  test('a response over two megabytes is refused with TOO_LARGE (#3)', async () => {
    const answer = await executeGraphql(owner, { manifest, folder }, { query: `query ($id: ID!) { entity(id: $id) { ... on KindDemoRepository { description } } }`, variables: { id: repository3Id } });
    const body = answer.body as MessageBody;
    expect(body.errors?.[0]?.extensions?.code).toBe('TOO_LARGE');
    expect(body.data).toBeUndefined();
  });
  test('an edge connection keeps its whole count after a page (#9)', async () => {
    const first = await graphql(`query ($id: ID!) { entity(id: $id) { ... on KindDemoRepository { demoContains(where: { position: { _in: [1, 2, 3] } }, first: 1) { totalCount pageInfo { endCursor } edges { node { position } } } } } }`, { id: repositoryId });
    let connection = (first['entity'] as Record<string, any>).demoContains;
    expect(connection.totalCount).toBe(3);
    for (let at = 0; at < 2; at += 1) {
      const next = await graphql(`query ($id: ID!, $after: String) { entity(id: $id) { ... on KindDemoRepository { demoContains(where: { position: { _in: [1, 2, 3] } }, first: 1, after: $after) { totalCount pageInfo { endCursor } edges { node { position } } } } } }`, { id: repositoryId, after: connection.pageInfo.endCursor });
      connection = (next['entity'] as Record<string, any>).demoContains;
      expect(connection.totalCount).toBe(3);
    }
  });

  test('an undeclared storage kind stops its field batch instead of requeuing forever', async () => {
    // Templates are the graph's entities (the owner's decision of 2026-11-15), read here outside the counted owner.
    const held = await owner.transaction('snapshot', (tx) => readTemplatesOf(tx, manifest));
    const counted = countingOwner();
    const label = await counted.owner.transaction('snapshot', async (tx) => {
      const read = new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, 'en', 'fixture', held.templates, held.files, held.bodies, held.findings);
      return await read.resolve(
        { nodeId: '1', uid: 'missing', kind: 'undeclared', key: { name: 'Fallback' }, typeName: 'Undeclared' },
        {}, read, { parentType: { name: 'Undeclared' }, fieldName: 'label' } as never,
      );
    });
    expect(label).toBe('Fallback');
    expect(counted.statements()).toBe(0);
  });

  test('catalogue diagram labels use the translated catalogue title', async () => {
    const data = await graphql(`{ catalogueEntity(name: "demo.file") { id } }`);
    const id = (data['catalogueEntity'] as { id: string }).id;
    const held = await owner.transaction('snapshot', (tx) => readTemplatesOf(tx, manifest));
    const counted = countingOwner();
    const hood = await counted.owner.transaction('snapshot', async (tx) => {
      const read = new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, 'ru', 'fixture', held.templates, held.files, held.bodies, held.findings);
      return await read.diagramNeighbourhood(id, 1, 'ru');
    });
    expect(hood).toBeDefined();
    expect(hood!.labels.get(id)).toBe('Файл');
    expect(counted.statements()).toBeLessThan(10);
  });

  test('a diagram counts 1 324 children but reads only the bounded sample', async () => {
    const repository = { kind: 'demo.repository', key: { name: 'diagram-budget' } };
    await owner.transaction('write', async (tx) => {
      const files = Array.from({ length: 1324 }, (_, at) => ({ kind: 'demo.file', key: { repository, path: `budget-${String(at)}.ts` } }));
      await publishGraphDrafts(tx, contract, {
        vertices: [{ ...repository, values: {}, producer: 'budget', producerVersion: '1' }, ...files.map((file) => ({ ...file, values: {}, producer: 'budget', producerVersion: '1' }))],
        edges: files.map((file) => ({ kind: 'demo.contains', from: repository, to: file, values: {}, producer: 'budget', producerVersion: '1' })),
        removals: [],
      }, 1, { author: 'budget@1' });
    });
    const data = await graphql(`{ allDemoRepository(where: { name: { _eq: "diagram-budget" } }) { edges { node { id } } } }`);
    const id = (data['allDemoRepository'] as { edges: { node: { id: string } }[] }).edges[0]!.node.id;
    const held = await owner.transaction('snapshot', (tx) => readTemplatesOf(tx, manifest));
    const counted = countingOwner();
    const started = performance.now();
    const hood = await counted.owner.transaction('snapshot', async (tx) => {
      const read = new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, 'en', 'fixture', held.templates, held.files, held.bodies, held.findings);
      return await read.diagramNeighbourhood(id, 1, 'en');
    });
    const elapsed = performance.now() - started;
    expect(hood).toBeDefined();
    expect(hood!.groups).toMatchObject([{ relation: 'demo.contains', side: 'out', kind: 'demo.file', total: 1324 }]);
    expect(hood!.groups[0]!.nodes).toHaveLength(12);
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
  await owner.transaction('write', (tx) => publishGraphDrafts(tx, contract, {
    vertices: [{ ...repository, values: {}, producer: 'search', producerVersion: '1' }, ...Array.from({ length: 60 }, (_, at) => ({ kind: 'demo.file', key: { repository, path: `search-bound-${String(at)}.ts` }, values: {}, producer: 'search', producerVersion: '1' }))], edges: [], removals: [],
  }, 1, { author: 'search@1' }));
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
  const grouped = await run('{ searchGroups(text: "search-bound", kinds: ["demo.file"], perKind: 2) { kind count results { node { id } matched } } }');
  expect(grouped['searchGroups']).toMatchObject([{ kind: 'demo.file', count: 60 }]);
  expect((grouped['searchGroups'] as { results: unknown[] }[])[0]!.results).toHaveLength(2);
  // Each answer names the text of the field the words were found in: the row's excerpt under its title.
  for (const hit of (grouped['searchGroups'] as { results: { matched: string }[] }[])[0]!.results) expect(hit.matched).toContain('search-bound');
  expect(transferred.pop()).toBeLessThanOrEqual(40);
});


test('recursive generic relations deduplicate paths, stop cycles and page their full count', async () => {
  const ref = (name: string) => ({kind: 'demo.repository', key: {name}});
  await owner.transaction('write', async (tx) => publishGraphDrafts(tx, contract, {
    vertices: ['depth-root', 'depth-a', 'depth-b', 'depth-c'].map((name) => ({...ref(name), values: {}, producer: 'depth', producerVersion: '1'})),
    edges: [['depth-root', 'depth-a'], ['depth-root', 'depth-b'], ['depth-a', 'depth-c'], ['depth-b', 'depth-c'], ['depth-c', 'depth-root']].map(([from, to]) => ({kind: 'mentions', from: ref(from!), to: ref(to!), discriminator: 'depth', producer: 'depth', producerVersion: '1'})),
    removals: [],
  }, 1, {author: 'depth@1'}));
  const found = await graphql(`{entityByKey(kind:"demo.repository",key:{name:"depth-root"}) {id}}`);
  const id = (found['entityByKey'] as any).id;
  const query = `query($id:ID!,$depth:Int!,$after:String){related(id:$id,edge:"mentions",depth:$depth,kinds:["demo.repository"],orderBy:[{field:"name"}],first:2,after:$after){totalCount edges{node{label}} pageInfo{endCursor hasNextPage}}}`;
  const one = (await graphql(query, {id,depth:1}))['related'] as any;
  expect(one.totalCount).toBe(2);
  expect(one.edges.map((e:any)=>e.node.label)).toEqual(['depth-a','depth-b']);
  const two = (await graphql(query, {id,depth:2}))['related'] as any;
  expect(two.totalCount).toBe(3);
  expect(two.pageInfo.hasNextPage).toBe(true);
  const rest = (await graphql(query, {id,depth:3,after:two.pageInfo.endCursor}))['related'] as any;
  expect(rest.totalCount).toBe(3);
  expect(rest.edges.map((e:any)=>e.node.label)).toEqual(['depth-c']);
  expect(rest.pageInfo.hasNextPage).toBe(false);
});

test('cochange counts distinct shared events and the target event denominator', async () => {
  const ref = (name: string) => ({kind: 'demo.repository', key: {name}});
  const names = ['co-target','co-sibling','co-once','co-event1','co-event2','co-event3'];
  await owner.transaction('write', async (tx) => publishGraphDrafts(tx, contract, {
    vertices: names.map((name)=>({...ref(name),values:{},producer:'cochange',producerVersion:'1'})),
    edges: [
      ['co-event1','co-target','a'], ['co-event1','co-target','b'], ['co-event2','co-target','a'], ['co-event3','co-target','a'],
      ['co-event1','co-sibling','a'], ['co-event1','co-sibling','b'], ['co-event2','co-sibling','a'], ['co-event1','co-once','a'],
    ].map(([from,to,discriminator])=>({kind:'mentions',from:ref(from!),to:ref(to!),discriminator:discriminator!,producer:'cochange',producerVersion:'1'})),
    removals: [],
  },1,{author:'cochange@1'}));
  const found = await graphql(`{entityByKey(kind:"demo.repository",key:{name:"co-target"}){id}}`);
  const data = await graphql(`query($id:ID!){cochange(id:$id,edge:"mentions"){node{label}count total share}}`,{id:(found['entityByKey'] as any).id});
  const rows = data['cochange'] as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({node:{label:'co-sibling'},count:2,total:3});
  expect(rows[0].share).toBeCloseTo(200/3,8);
});

test('source answers the canonical byte count through the actual GraphQL response', async () => {
  const asks: Record<string, unknown>[] = [];
  const answer = await executeGraphql(owner, {
    manifest, folder,
    readText: async (ask) => {
      asks.push(ask);
      return {text: 'const n = 1;\n', blob: ask.blob, lines: 1, bytes: 13, binary: false, from: ask.from, complete: true, language: 'TypeScript', moved: ask.moved, next: null};
    },
  }, {query: '{source(repository:"source-repo",path:"sample.ts"){text blob lines bytes binary from complete language moved next{line column}}}'});
  const body = answer.body as MessageBody;
  expect(answer.status).toBe(200);
  expect(body.errors).toBeUndefined();
  expect(body.data).toEqual({source: {text: 'const n = 1;\n', blob: 'source-blob', lines: 1, bytes: 13, binary: false, from: 1, complete: true, language: 'TypeScript', moved: false, next: null}});
  expect(asks).toEqual([{repository: 'source-repo', path: 'sample.ts', blob: 'source-blob', from: 1, moved: false}]);
});
