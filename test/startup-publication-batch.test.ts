import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { writeAssertions } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';
import { publicationReadSelector } from '../src/graph/publication-contract.js';
import { runningVersion } from '../src/product/version.js';
import { createTestDatabaseOwner } from './test-database.js';
import { openTrace, runInTrace, closeTrace } from '../src/obs/trace.js';
import { readTraceSpans } from '../src/obs/trace-report.js';

test('startup batches owned operation publication and changed installation metadata', async () => {
  const owner = await createTestDatabaseOwner();
  const store = mkdtempSync(join(tmpdir(), 'madarch-startup-batch-'));
  try {
    const first = await owner.transaction('write', tx => startupBinding(tx, EMPTY_CONTRACT, 'batch-install'));
    const counts: number[][] = [];
    for (const changed of [false, true]) {
      if (changed) await owner.transaction('write', async tx => {
        const held = await startupBinding(tx, EMPTY_CONTRACT, 'batch-install', undefined, first.binding.operationUid);
        const node = (await tx.query<{id:string}>('SELECT id::text FROM node WHERE uid=$1::uuid', [first.binding.sourceUid])).rows[0]!;
        await writeAssertions(tx, held.contract, ['version', 'label'].map(property => ({sort:'vertex' as const,kind:'plugin',subjectId:node.id,property,operation:'assert' as const,value:'outdated'})));
      });
      const current = await owner.transaction('write', async tx => {
        const trace = openTrace({ store, runId: `changed-${changed}`, console: false });
        try {
          return await runInTrace(trace, async () => await startupBinding(tx, EMPTY_CONTRACT, 'batch-install'));
        } finally {
          closeTrace(trace);
          const spans = readTraceSpans(trace.file);
          counts.push(['graph.write.admitAssertionInputs', 'graph.publish'].map(name => spans.filter(span => span.name === name).length));
        }
      });
      expect(current.binding.sourceUid).toBe(first.binding.sourceUid);
      expect(current.binding.operationUid).not.toBe(first.binding.operationUid);
      await owner.transaction('snapshot', async tx => {
        const records = await readKindAssertions(tx, 'vertex', 'plugin', ['version', 'label'], await publicationReadSelector(tx, current.contract));
        expect(records.find(row => row.uid === first.binding.sourceUid)?.values).toMatchObject({version:runningVersion(),label:'batch-install'});
        const lineage = await tx.query<{count:string}>(`SELECT count(*)::text AS count FROM edge e JOIN entity k ON k.id=e.entity_id JOIN node n ON n.id=e.from_node WHERE k.name='system.operation-author' AND n.uid=$1::uuid`, [current.binding.operationUid]);
        expect(Number(lineage.rows[0]!.count)).toBe(1);
      });
    }
    console.log('startup admission/publication calls', counts);
    expect(counts).toEqual([[0,1],[1,1]]);
  } finally { await owner.close(); rmSync(store, {recursive:true,force:true}); }
}, 30_000);
