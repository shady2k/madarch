/**
 * Decision 0039 items 5, 29 and 31, the boundary of `madarch-47vw.9`: a mention token is authored graph text.
 *
 * Immutable evidence keeps its exact bytes and digest, engine diagnostics keep their exact words, and neither is read
 * as authored prose: a refusal that quotes the reserved token still records, and an authored mention still
 * materializes its edge. The confined fill that proves a later stage still runs with such a repository is
 * `test/graph-mentions-fill.test.ts`, kept apart because its engine bookkeeping alone takes a minute.
 */
import { describe, expect, test } from 'bun:test';
import { assertionValueTableName, generatedTableName, graphContractVersion, type GraphContract } from '../src/graph/contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { bindWriteCapability, bootstrapWriteIdentity, publishGraphDrafts } from '../src/graph/write.js';
import { newUid } from '../src/graph/uid.js';
import { MentionSyntaxError } from '../src/graph/mentions.js';
import { readKindAssertions } from '../src/graph/records.js';
import { createTestDatabaseOwner } from './test-database.js';
import type { SqlExecutor } from '../src/sql-driver.js';

/** One kind's records, read in a transaction of the case's own: the writer's rows answer the reader that follows. */
const records = async (
  owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>, contract: GraphContract,
  sort: 'vertex' | 'edge', kind: string, fields: readonly string[],
) => await owner.run(async tx => await readKindAssertions(tx, sort, kind, fields, { contract }));

/** The refusal grammar states its expectation in a reserved token no rule accepts, as decision 0039 quotes it. */
const RESERVED = '[[uid:<lowercase hyphenated UUID>]]';
const FROM = '2020-01-01T00:00:00.000Z';

describe('decision 0039 items 5, 29 and 31: authored text and engine diagnostics on one writer', () => {
  const contract: GraphContract = withAssertionContract({
    vertex: [{ name: 'sample', table: generatedTableName('sample', 'vertex'), key: ['name'], capability: 'fixture', fields: [{ name: 'name', type: 'text' }, { name: 'body', type: 'text' }] }],
    edge: [],
    dictionary: [],
  });

  async function fixture(work: (held: {
    readonly owner: Awaited<ReturnType<typeof createTestDatabaseOwner>>;
    readonly write: (drafts: Parameters<typeof publishGraphDrafts>[2]) => Promise<void>;
  }) => Promise<void>): Promise<void> {
    const owner = await createTestDatabaseOwner({ graphContract: contract });
    const productUid = newUid(), sourceUid = newUid(), principalUid = newUid();
    let operationUid = newUid();
    const write = async (drafts: Parameters<typeof publishGraphDrafts>[2]): Promise<void> => await owner.transaction('write', async (tx: SqlExecutor) => {
      operationUid = newUid();
      for (const [kind, uid] of [['system.operation', operationUid]] as const) await bootstrapWriteIdentity(tx, kind, uid, productUid);
      await bindWriteCapability(tx, {
        productUid, principalUid, operationUid, sourceUid, context: 1, scope: productUid,
        contractVersion: graphContractVersion(contract),
        permissions: [...contract.vertex, ...contract.edge].map(kind => ({ kind: kind.name, properties: ['*'], assert: true, retractOwn: true })),
      });
      await publishGraphDrafts(tx, contract, drafts);
    });
    try {
      await owner.transaction('write', async tx => {
        for (const [kind, uid] of [['source', sourceUid], ['person', principalUid], ['system.operation', operationUid]] as const) await bootstrapWriteIdentity(tx, kind, uid, productUid);
      });
      await write({ vertices: [{ kind: 'sample', key: { name: 'anchor' }, values: { body: 'plain' }, validFrom: FROM, producer: 'fixture', producerVersion: '1' }], removals: [] });
      await work({ owner, write });
    } finally {
      await owner.close();
    }
  }

  test('a refusal quoting the reserved token is stored verbatim in progress and run diagnostics', async () => {
    await fixture(async ({ owner, write }) => {
      let refusal: MentionSyntaxError | undefined;
      try {
        await write({ vertices: [{ kind: 'sample', key: { name: 'refused' }, values: { body: `see ${RESERVED}` }, validFrom: FROM, producer: 'fixture', producerVersion: '1' }], removals: [] });
      } catch (error) {
        expect(error).toBeInstanceOf(MentionSyntaxError);
        refusal = error as MentionSyntaxError;
      }
      expect(refusal).toBeDefined();
      expect(refusal!.code).toBe('SCHEMA_INVALID');
      const stated = refusal!.message;
      expect(stated).toContain(RESERVED);
      // The engine records the words it refused in its own fields: storing them is not another authored write.
      await write({ vertices: [
        { kind: 'system.progress', uid: newUid(), key: {}, values: { seq: 1, at: Date.parse(FROM), stage: 'fixture', unit_name: 'sample:refused', generation: 0, kind: 'unit-failed', summary: stated }, validFrom: FROM, producer: 'fixture', producerVersion: '1' },
        { kind: 'system.run', uid: newUid(), key: {}, values: { run_name: 'diagnostic', end_state: 'failed', end_message: stated }, validFrom: FROM, producer: 'fixture', producerVersion: '1' },
      ], removals: [] });
      const progress = await records(owner, contract, 'vertex', 'system.progress', ['summary']);
      expect(progress.map(record => record.values['summary'])).toContain(stated);
      const runs = await records(owner, contract, 'vertex', 'system.run', ['end_message']);
      expect(runs.map(record => record.values['end_message'])).toContain(stated);
      const files = await records(owner, contract, 'vertex', 'sample', ['body']);
      expect(files.map(record => record.key['name'])).toEqual(['anchor']);
    });
  }, 120_000);

  test('a valid authored mention in a resolution rationale still materializes its edge', async () => {
    await fixture(async ({ owner, write }) => {
      const anchors = await records(owner, contract, 'vertex', 'sample', ['body']);
      const anchor = anchors.find(record => record.key['name'] === 'anchor')!;
      await write({ vertices: [{
        kind: 'system.dispute-resolution', uid: newUid(), key: {},
        values: { rationale: `chosen because [[uid:${anchor.uid}]] states it`, segment_from: FROM },
        validFrom: FROM, producer: 'fixture', producerVersion: '1',
      }], removals: [] });
      const resolutions = await records(owner, contract, 'vertex', 'system.dispute-resolution', ['rationale']);
      expect(resolutions.map(record => record.values['rationale'])).toEqual([`chosen because [[uid:${anchor.uid}]] states it`]);
      const mentions = await owner.transaction('snapshot', async tx => (await tx.query<{ id: string }>(
        `SELECT e.id::text AS id FROM edge e JOIN entity k ON k.id=e.entity_id WHERE k.name='system.assertion-mentions'`,
      )).rows);
      expect(mentions).toHaveLength(1);
      // The edge leaves the opinion that states the token, and that opinion's own value is the rationale verbatim.
      const value = await owner.transaction('snapshot', async tx => (await tx.query<{ property: string; value: string }>(
        `SELECT a.property AS property,v.value::text AS value FROM edge e
          JOIN entity k ON k.id=e.entity_id AND k.name='system.assertion-mentions'
          JOIN assertion a ON a.assertion_id=e.from_node
          JOIN "${assertionValueTableName('system.dispute-resolution', 'vertex', 'rationale')}" v ON v.assertion_id=a.assertion_id`,
      )).rows);
      expect(value).toEqual([{ property: 'rationale', value: `chosen because [[uid:${anchor.uid}]] states it` }]);
    });
  }, 120_000);
});
