import { expect, test } from 'bun:test';
import { EMPTY_CONTRACT } from '../src/graph/contract.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { requireWriteCapability, writeAssertion } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';
import { publicationReadSelector } from '../src/graph/publication-contract.js';
import { runningVersion } from '../src/product/version.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { createTestDatabaseOwner } from './test-database.js';

test('unchanged engine installation adds no assertion-operation edges on repeated startup', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    const startup = async () => await owner.transaction('write', async tx => {
      let queries = 0;
      const measured: SqlExecutor = { query: async (sql, values) => { queries++; return await tx.query(sql, values); } };
      const result = await startupBinding(measured, EMPTY_CONTRACT, 'installation-check');
      return { ...result, queries };
    });
    const count = async (source: string) => await owner.transaction('snapshot', async tx => Number((await tx.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM edge operation
      JOIN entity ok ON ok.id=operation.entity_id AND ok.name='system.assertion-operation'
      JOIN edge subject ON subject.from_node=operation.from_node
      JOIN entity sk ON sk.id=subject.entity_id AND sk.name='system.assertion-subject'
      JOIN node source ON source.id=subject.to_node WHERE source.uid=$1::uuid`, [source])).rows[0]!.count));
    const first = await startup();
    const before = await count(first.binding.sourceUid);
    const second = await startup();
    const afterSecond = await count(first.binding.sourceUid);
    const third = await startup();
    console.log(JSON.stringify({ startupQueries: [first.queries, second.queries, third.queries], installationEdges: [before, afterSecond, await count(first.binding.sourceUid)] }));
    expect(second.binding.sourceUid).toBe(first.binding.sourceUid);
    expect(third.binding.sourceUid).toBe(first.binding.sourceUid);
    expect(afterSecond).toBe(before);
    expect(await count(first.binding.sourceUid)).toBe(before);
    await owner.transaction('write', async tx => {
      let borrowedQueries = 0;
      const measured: SqlExecutor = { query: async (sql, values) => { borrowedQueries++; return await tx.query(sql, values); } };
      const borrowed = await startupBinding(measured, EMPTY_CONTRACT, 'installation-check', undefined, first.binding.operationUid);
      console.log(JSON.stringify({ borrowedStartupQueries: borrowedQueries }));
      expect(borrowed.binding.operationUid).toBe(first.binding.operationUid);
      expect(requireWriteCapability(measured).operationUid).toBe(first.binding.operationUid);
      const subject = (await tx.query<{ id: string }>('SELECT id::text FROM node WHERE uid=$1::uuid', [first.binding.sourceUid])).rows[0]!;
      for (const property of ['version', 'label']) await writeAssertion(measured, borrowed.contract, {
        sort: 'vertex', kind: 'plugin', subjectId: subject.id, property, operation: 'assert', value: 'outdated',
      });
    });
    const changed = await count(first.binding.sourceUid);
    await startup();
    expect(await count(first.binding.sourceUid)).toBe(changed + 2);
    await owner.transaction('snapshot', async tx => {
      const records = await readKindAssertions(tx, 'vertex', 'plugin', ['version', 'label'], await publicationReadSelector(tx, first.contract));
      const plugin = records.find(record => record.uid === first.binding.sourceUid)!;
      expect(plugin.values['version']).toBe(runningVersion());
      expect(plugin.values['label']).toBe('installation-check');
    });
  } finally { await owner.close(); }
});


test('rolled-back borrowed installation leaves no identities or metadata cached', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    const host = await owner.transaction('write', async tx => await startupBinding(tx, EMPTY_CONTRACT, 'rollback-host'));
    const counts = async () => await owner.transaction('snapshot', async tx =>
      (await tx.query('SELECT (SELECT count(*) FROM node)::text AS nodes,(SELECT count(*) FROM edge)::text AS edges,(SELECT count(*) FROM assertion)::text AS assertions')).rows[0]);
    const before = await counts();
    let rolledBackSource: string | undefined;
    await expect(owner.transaction('write', async tx => {
      const installed = await startupBinding(tx, EMPTY_CONTRACT, 'rollback-installation', undefined, host.binding.operationUid);
      rolledBackSource = installed.binding.sourceUid;
      throw new Error('injected installation rollback');
    })).rejects.toThrow('injected installation rollback');
    expect(await counts()).toEqual(before);
    const retried = await owner.transaction('write', async tx => await startupBinding(tx, EMPTY_CONTRACT, 'rollback-installation', undefined, host.binding.operationUid));
    expect(retried.binding.sourceUid).not.toBe(rolledBackSource);
    await owner.transaction('snapshot', async tx => {
      const records = await readKindAssertions(tx, 'vertex', 'plugin', ['installation', 'scope', 'version', 'label'], await publicationReadSelector(tx, retried.contract));
      const installed = records.filter(record => record.values['installation'] === JSON.stringify(['system-engine', 'rollback-installation']));
      expect(installed).toHaveLength(1);
      expect(installed[0]!.uid).toBe(retried.binding.sourceUid);
      expect(installed[0]!.values).toMatchObject({ scope: host.binding.productUid, version: runningVersion(), label: 'rollback-installation' });
    });
  } finally { await owner.close(); }
});
