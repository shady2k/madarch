import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabaseOwner } from './test-database.js';
import { createRun, readUnitGraphUidIn, readNodeIdIn, readRecordsIn } from '../src/graph/fill-state.js';
import { createUnit } from './fill-unit-fixture.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { writeAssertions } from '../src/graph/write.js';
import { openTrace, runInTrace, closeTrace } from '../src/obs/trace.js';
import { readTraceSpans } from '../src/obs/trace-report.js';

test('multiple assertions use one admission and retain ordered assertion identities and values', async () => {
  const owner = await createTestDatabaseOwner();
  const store = mkdtempSync(join(tmpdir(), 'madarch-assertion-batch-'));
  try {
    await createRun(owner, { runId: 'batch', product: 'batch', at: 1 });
    await createUnit(owner, { unitId: 'unit', product: 'batch', runId: 'batch', stageId: 'stage', scopeKey: 'scope', inputsDigest: 'digest', retries: 0, at: 2 });
    const fields = [['produced_kind', 'example.kind'], ['producer', 'example'], ['outcome', 'produced'], ['produced', 3], ['reason', 'done'], ['producer_version', '1']] as const;
    const costs: number[] = [];
    for (const count of [1, 6]) {
      await owner.transaction('write', async tx => {
        const {contract} = await startupBinding(tx, owner.graphContract, 'assertion-batch');
        const uid = await readUnitGraphUidIn(tx, 'unit');
        const id = await readNodeIdIn(tx, uid!);
        const trace = openTrace({ store, runId: `fields-${count}`, console: false });
        let ids: string[];
        try {
          ids = await runInTrace(trace, async () => await writeAssertions(tx, contract, fields.slice(0, count).map(([property, value]) => ({sort: 'vertex', kind: 'system.unit', subjectId: String(id), property, operation: 'assert', value}))));
        } finally { closeTrace(trace); }
        costs.push(readTraceSpans(trace.file).filter(span => span.name === 'graph.write.admitAssertionInputs').length);
        expect(ids).toHaveLength(count);
        expect(new Set(ids).size).toBe(count);
        const held = await readRecordsIn(tx, 'vertex', 'system.unit', fields.slice(0, count).map(([property]) => property), [id!]);
        for (const [position, [property, value]] of fields.slice(0, count).entries()) {
          const assertion = held[0]!.assertions.find(row => row.id === ids[position]);
          expect(assertion?.property).toBe(property);
          expect(assertion?.value).toBe(value);
        }
      });
    }
    console.log('assertion admission calls', costs);
    expect(costs).toEqual([1, 1]);
  } finally { await owner.close(); rmSync(store, { recursive: true, force: true }); }
}, 30_000);

import { assertionValueTableName, generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { loadAssertions } from '../src/graph/assertion-read.js';

test('a plugin nullable JSON assertion stores JSON null rather than SQL NULL', async () => {
  const contract: GraphContract = { vertex: [{ name: 'nullable-json', table: generatedTableName('nullable-json','vertex'), key: ['name'], capability: 'fixture', fields: [
    { name: 'name', type: 'text' }, { name: 'payload', type: 'json', nullable: true, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: ['object','null'] } },
  ] }], edge: [], dictionary: [] };
  const owner = await createTestDatabaseOwner({ graphContract: contract, authenticated: false });
  try {
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'nullable-json', key: { name: 'one' }, values: { payload: null }, producer: 'fixture', producerVersion: '1' }], removals: [] });
    });
    await owner.run(async tx => {
      const assertions = await loadAssertions(tx, 'vertex', 'nullable-json', ['payload']);
      expect(assertions.map(row => row.value)).toEqual([null]);
      const stored = await tx.query<{ sql_null: boolean; distinct: boolean }>(`SELECT value IS NULL AS sql_null, value IS DISTINCT FROM 'null'::jsonb AS distinct FROM "${assertionValueTableName('nullable-json','vertex','payload')}"`);
      expect(stored.rows).toEqual([{ sql_null: false, distinct: false }]);
    });
  } finally { await owner.close(); }
},30_000);
