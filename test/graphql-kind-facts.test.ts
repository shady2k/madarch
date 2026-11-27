import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import type { VertexDraft } from '../src/graph/contract.js';
import { executeGraphql } from '../src/graph/graphql-execute.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { publishValidatedManifests, validateProductManifests } from '../src/graph/manifest-publication.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { CATALOGUE_KIND, composePage, splitResponse } from '../src/page-contract/index.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';

let folder = '';
let owner: DatabaseOwner;
let contract: ReturnType<typeof graphContractOf>;

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'madarch-graphql-kind-facts-'));
  const kinds = join(folder, 'madarch/kinds/demo/core');
  const fixtures = join(import.meta.dir, 'graphql');
  mkdirSync(kinds, { recursive: true });
  mkdirSync(join(folder, 'templates'), { recursive: true });
  writeFileSync(join(folder, 'templates/entity.yaml'), 'template: entity\nsections: []\n');
  writeFileSync(join(folder, 'madarch/catalog.yaml'), readFileSync(join(fixtures, 'fixture-product-catalog.yaml')));
  writeFileSync(join(kinds, 'demo.file.yaml'), readFileSync(join(fixtures, 'fixture-product-demo.file.yaml')));
  writeFileSync(join(kinds, 'demo.repository.yaml'), readFileSync(join(fixtures, 'fixture-product-demo.repository.yaml'), 'utf8')
    .replace('key:\n', '- {name: last_change, type: timestamp, nullable: true, producers: [agent]}\nkey:\n'));
  const env = gitEnv(SAMPLE_IDENTITY);
  execFileSync('git', ['init', '-q'], { cwd: folder, env });
  execFileSync('git', ['add', '-A'], { cwd: folder, env });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: folder, env });
  const checked = validateProductManifests(folder);
  if (!checked.ok) throw new Error(checked.findings.map(({ file, line, message }) => `${file}:${line}: ${message}`).join('\n'));
  if (checked.value === undefined) throw new Error(`${folder}: the fixture has no kinds manifest`);
  contract = withManifestContract(graphContractOf(checked.value.manifest));
  owner = await createTestDatabaseOwner({ graphContract: contract });
  await publishValidatedManifests(owner, checked.value);
});

afterAll(async () => {
  try { await owner?.close(); } finally { rmSync(folder, { recursive: true, force: true }); }
});

async function graphql(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { body, status } = await executeGraphql(owner, { folder }, { query, ...(variables === undefined ? {} : { variables }) });
  if (body.errors !== undefined) throw new Error(`HTTP ${status}: ${body.errors.map(({ message }) => message).join('\n')}`);
  return body.data as Record<string, unknown>;
}

test('kind aggregates and instances count entities once across producers and translations', async () => {
  const names = ['aggregate-one', 'aggregate-two', 'aggregate-three'] as const;
  const old = '2000-01-02T12:00:00Z';
  const future = '2099-01-02T12:00:00Z';
  const draft = (name: string, values: VertexDraft['values'], producer: string, lang?: string): VertexDraft => ({
    kind: 'demo.repository', key: { name }, values, producer, producerVersion: '1', ...(lang === undefined ? {} : { lang }),
  });
  await owner.transaction('write', async tx => {
    await bindTestWriteCapability(tx, contract, '019a0000-0000-7000-8000-000000000052');
    await publishGraphDrafts(tx, contract, { vertices: [
      draft(names[0], { description: 'Shared', size: 20, last_change: old }, 'first', 'en'),
      draft(names[1], { description: 'Shared', size: 10, last_change: future }, 'first', 'en'),
      draft(names[2], { description: 'Other' }, 'first', 'en'),
    ], removals: [] });
    await bindTestWriteCapability(tx, contract, '019a0000-0000-7000-8000-000000000053');
    await publishGraphDrafts(tx, contract, { vertices: [
      draft(names[0], { description: 'First translation' }, 'second', 'ru'),
      draft(names[1], { description: 'Second translation' }, 'second', 'ru'),
      draft(names[0], { description: 'Shared', size: 20, last_change: old }, 'second', 'en'),
      draft(names[1], { description: 'Shared', size: 10, last_change: future }, 'second', 'en'),
    ], removals: [] });
  });
  const data = await graphql(`query ($names: [String!]!) {
    catalogueEntity(name: "demo.repository", lang: "en") {
      instances(where: { name: { _in: $names } }, first: 10) {
        totalCount
        edges { node { label ... on KindDemoRepository { lastChange descriptionAssertions { value source { id } } } } }
      }
      instancesAggregate(where: { name: { _in: $names } }) {
        count
        descriptions: groupBy(field: "description") { key count }
        sizes: histogram(field: "size", bounds: [15]) { from to count }
        bySize: topN(field: "size") { value node { label } }
        dates: groupBy(field: "lastChange") { key count }
        ages: histogram(field: "lastChange", bounds: [0]) { from to count }
        byDate: topN(field: "lastChange") { value node { label } }
      }
    }
  }`, { names });
  const page = data['catalogueEntity'] as {
    instances: { totalCount: number; edges: { node: { label: string; lastChange: string | null; descriptionAssertions: { value: unknown; source: { id: string } }[] } }[] };
    instancesAggregate: { dates: { key: string | null; count: number }[]; byDate: { value: unknown; node: { label: string } }[] };
  };
  const { instances, instancesAggregate } = page;
  expect(instances.totalCount).toBe(3);
  expect(instances.edges.map(({ node }) => [node.label, node.lastChange === null ? null : Date.parse(node.lastChange)])).toEqual([
    [names[0], Date.parse(old)], [names[1], Date.parse(future)], [names[2], null],
  ]);
  const opinions = instances.edges[0]!.node.descriptionAssertions.filter(({ value }) => value === 'Shared');
  expect(new Set(opinions.map(({ source }) => source.id)).size).toBe(2);
  expect(instancesAggregate).toMatchObject({
    count: 3,
    descriptions: [{ key: 'Shared', count: 2 }, { key: 'Other', count: 1 }],
    sizes: [{ from: null, to: 15, count: 1 }, { from: 15, to: null, count: 1 }],
    bySize: [{ value: 20, node: { label: names[0] } }, { value: 10, node: { label: names[1] } }],
    ages: [{ from: null, to: 0, count: 1 }, { from: 0, to: null, count: 1 }],
  });
  const { dates, byDate } = instancesAggregate;
  expect(dates.map(({ key, count }) => [key === null ? null : Date.parse(key), count])).toEqual([
    [Date.parse(old), 1], [Date.parse(future), 1], [null, 1],
  ]);
  expect(byDate).toEqual([
    { value: dates[1]!.key, node: { label: names[1] } },
    { value: dates[0]!.key, node: { label: names[0] } },
  ]);
});

test('a composed kind page reads facts and paged records in one snapshot across a committed write', async () => {
  const names = ['snapshot-first', 'snapshot-second', 'snapshot-third'];
  const publish = (records: readonly string[]) => owner.transaction('write', async tx => {
    await bindTestWriteCapability(tx, contract);
    await publishGraphDrafts(tx, contract, { vertices: records.map(name => ({
      kind: 'demo.repository', key: { name }, values: {}, producer: 'snapshot-fixture', producerVersion: '1',
    })), removals: [] });
  });
  await publish(names.slice(0, 2));
  const catalogue = await graphql('{ catalogueEntity(name: "demo.repository") { id } }');
  const { id } = catalogue['catalogueEntity'] as { id: string };
  // Both temporal cutoffs include the concurrent write. Only the database snapshot can hide it from this operation.
  const selector = 'recordedAt: "2099-01-01T00:00:00Z", validAt: "2099-01-01T00:00:00Z"';
  const where = `where: { name: { _in: ${JSON.stringify(names)} } }`;
  const page = composePage({
    structureRevision: 'fixture', catalogueTemplate: 'kind-facts', home: null, recordTemplates: [], ownTemplates: [], roles: [], roleLeads: [],
    templates: [{ name: 'kind-facts', body: `template: kind-facts
sections:
  - id: count
    on: root
    component: facts
    params:
      rows: [{ label: { en: Count }, path: count, format: number }]
    query: |
      allDemoRepositoryAggregate(${where}, ${selector}) { count }
  - id: records
    on: root
    component: table
    params:
      path: .
      columns: [{ label: { en: Record }, path: node.label }]
      pageSize: 1
    query: |
      allDemoRepository(${where}, ${selector}, first: $records_first, after: $records_after) {
        totalCount
        edges { node { label } }
        pageInfo { endCursor hasNextPage }
      }
` }],
  }, { kind: CATALOGUE_KIND, id });
  expect(page.findings).toEqual([]);
  const first = splitResponse(page, await graphql(page.operation, page.variables));
  type Records = {
    edges: { node: { label: string } }[];
    totalCount: number;
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  };
  const firstPage = first['records'] as Records;
  expect(first['count']).toEqual({ count: 2 });
  expect(firstPage).toMatchObject({ totalCount: 2, edges: [{ node: { label: names[0] } }], pageInfo: { hasNextPage: true } });

  let snapshots = 0;
  const reads: string[] = [];
  const firstRead = Promise.withResolvers<void>();
  // Start from outside the reader's transaction context so the database owner can give the writer its own connection.
  const writer = firstRead.promise.then(() => publish(names.slice(2)));
  const reader: DatabaseOwner = {
    ...owner,
    transaction: (kind, work) => owner.transaction(kind, async tx => {
      snapshots += 1;
      const isolation = await tx.query<{ transaction_isolation: string }>('SHOW transaction_isolation');
      expect(isolation.rows[0]?.transaction_isolation).toBe('repeatable read');
      const observed: OuterTransaction = {
        ...tx,
        query: async <Row extends object>(sql: string, values?: readonly unknown[]) => {
          const result = await tx.query<Row>(sql, values);
          const section = sql.includes('SELECT count(*)::int AS n FROM v') ? 'count'
            : sql.includes('WITH filtered AS (') ? 'records' : undefined;
          if (section !== undefined) {
            reads.push(section);
            if (reads.length === 1) {
              firstRead.resolve();
              await writer;
              reads.push('committed write');
            }
          }
          return result;
        },
      };
      return work(observed);
    }),
  };
  const after = { ...page.variables, records_after: firstPage.pageInfo.endCursor };
  const answer = await executeGraphql(reader, { folder }, { query: page.operation, variables: after });
  expect(answer.body.errors).toBeUndefined();
  expect(snapshots).toBe(1);
  expect(reads).toHaveLength(3);
  expect(reads[1]).toBe('committed write');
  expect([reads[0], reads[2]].sort()).toEqual(['count', 'records']);
  const during = splitResponse(page, answer.body.data as Record<string, unknown>);
  expect(during['count']).toEqual({ count: 2 });
  expect(during['records']).toMatchObject({ totalCount: 2, edges: [{ node: { label: names[1] } }], pageInfo: { hasNextPage: false } });

  const fresh = splitResponse(page, await graphql(page.operation, { ...after, records_first: 3 }));
  expect(fresh['count']).toEqual({ count: 3 });
  expect(fresh['records']).toMatchObject({ totalCount: 3, edges: [{ node: { label: names[1] } }, { node: { label: names[2] } }] });
  const lastPage = fresh['records'] as Records;
  const exhausted = splitResponse(page, await graphql(page.operation, { ...after, records_after: lastPage.pageInfo.endCursor }));
  expect(exhausted['records']).toEqual({ totalCount: 3, edges: [], pageInfo: { endCursor: null, hasNextPage: false } });
});
