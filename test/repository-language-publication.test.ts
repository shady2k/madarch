import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { GIT_CONTRACT, GIT_KINDS, GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { publishTree } from '../src/graph/records.js';
import { ensureVertex, publishOpinion } from '../src/graph/write.js';

test('combined attribution retires the old dataset opinion and replays without changes', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: GIT_CONTRACT });
  const key = { repository: { kind: GIT_KINDS.repository, key: { name: 'fixture' } }, path: 'asset.map' };
  try {
    await owner.transaction('write', async tx => {
      const node = await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, key });
      await publishOpinion(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, nodeId: node.nodeId, producer: 'git-tree', producerVersion: '1', values: { mode: '100644' } });
      await publishOpinion(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, nodeId: node.nodeId, producer: 'linguist', producerVersion: '9.5.0', values: { language: 'unknown', languages: ['unknown'] } });
    });
    const input = { repository: { name: 'fixture', url: '' }, commit: 'a'.repeat(40), files: [{ path: 'asset.map', mode: '100644' as const, blob: 'b'.repeat(40), bytes: 2, form: 'text' as const, lines: 1, content: '{}', language: 'JSON', candidates: ['JSON'] }], gitlinks: [] };
    await publishTree(owner, input);
    const rows = await owner.transaction('snapshot', async tx => (await tx.query<{said_by:string;state:string;language:string|null}>(`SELECT said_by, state, language FROM ${GIT_TABLES.file} WHERE language IS NOT NULL ORDER BY id`)).rows);
    expect(rows).toEqual([{said_by:'linguist@9.5.0',state:'closed',language:'unknown'}, {said_by:'language-attribution@linguist-9.5.0+json-1',state:'open',language:'JSON'}]);
    const replay = await publishTree(owner, input);
    expect(replay.inserted + replay.updated + replay.deleted).toBe(0);
  } finally { await owner.close(); }
}, 60_000);
