import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { newUid } from '../src/graph/uid.js';

test('vertex, edge and repeated publications omit empty insertion and lock phases', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    await owner.transaction('write', async tx => {
      const { contract, binding } = await startupBinding(tx, owner.graphContract, 'empty-phases');
      const uid = newUid();
      const vertex = { kind: 'system.operation', uid, key: {}, values: {}, producer: binding.sourceUid, producerVersion: binding.contractVersion! };
      const emptyQueries: string[] = [];
      const identityLocks: string[] = [];
      const query = tx.query.bind(tx);
      tx.query = async (sql, parameters) => {
        const input = parameters?.[0];
        if (Array.isArray(input) && input.length > 0 && /SELECT .*FROM node.*FOR UPDATE/s.test(sql)) identityLocks.push(sql);
        if ((Array.isArray(input) && input.length === 0 || input === '[]') &&
          (/INSERT INTO (node|edge)\(/.test(sql) || /SELECT .*FROM (node|edge).*FOR UPDATE/s.test(sql))) emptyQueries.push(sql);
        return await query(sql, parameters);
      };
      try {
        await publishGraphDrafts(tx, contract, { vertices: [vertex], removals: [] });
        await publishGraphDrafts(tx, contract, { vertices: [], edges: [{kind: 'system.operation-author', from: {kind: 'system.operation', uid, key: {}}, to: {kind: 'plugin', uid: binding.sourceUid, key: {}}, producer: binding.sourceUid, producerVersion: binding.contractVersion!}], removals: [] });
        await publishGraphDrafts(tx, contract, { vertices: [vertex], removals: [] });
      } finally { tx.query = query; }
      const locks = await tx.query<{ active: boolean }>("SELECT graph_vertex_active(id,'system.operation',1) AS active FROM node WHERE uid=$1::uuid", [uid]);
      expect(locks.rows[0]?.active).toBe(true);
      console.log('empty publication queries', emptyQueries.length);
      expect(identityLocks).toHaveLength(2);
      expect(emptyQueries).toEqual([]);
    });
  } finally { await owner.close(); }
}, 30_000);
