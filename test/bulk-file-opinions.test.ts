import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { GIT_KINDS, GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { repositoryContract } from './repository-contract-fixture.js';
import { ensureVertex, publishGraphDrafts } from '../src/graph/write.js';

// The batch and individual calls see the same declarations, inputs and transaction boundaries.
test('bulk file opinions retain singleton state, journal order, replacements and rollback', async () => {
  const owners = await Promise.all([createTestDatabaseOwner({ graphContract: repositoryContract }), createTestDatabaseOwner({ graphContract: repositoryContract })]);
  try {
    const snapshots: unknown[] = [];
    for (const [mode, owner] of owners.entries()) {
      await createOneGraphSchema(owner, repositoryContract);
      const nodes: string[] = [];
      await owner.transaction('write', async (tx) => {
        for (const path of ['a.ts', 'b.ts']) nodes.push((await ensureVertex(tx, repositoryContract, { kind: GIT_KINDS.file, key: { repository: 'fixture', path } })).nodeId);
      });
      const base = nodes.map((_nodeId, at) => ({ kind: GIT_KINDS.file, key: { repository: 'fixture', path: at === 0 ? 'a.ts' : 'b.ts' }, producer: 'scanner', producerVersion: '1', values: { mode: '100644', blob: null, language: at === 0 ? 'TypeScript' : 'XML', languages: at === 0 ? ['TypeScript', 'XML'] : [] }, evidence: [{ type: 'file' as const, path: `${at}.ts` }] }));
      const turns = [
        base,
        base,
        base.map((draft) => ({ ...draft, evidence: [{ type: 'file' as const, path: 'changed.ts' }], producerVersion: '2' })),
        base.map((draft) => ({ ...draft, values: { language: 'JavaScript' }, producerVersion: '3' })),
        base.map((draft) => ({ ...draft, lang: 'ru', translatedFrom: '1', sourceDigest: 'digest' })),
        [{ ...base[0]!, producer: 'duplicate' }, { ...base[0]!, producer: 'duplicate', values: { language: 'JSON' } }],
      ];
      const results: number[] = [];
      for (const drafts of turns) await owner.transaction('write', async (tx) => {
        let changed = 0;
        if (mode === 0) changed = await publishGraphDrafts(tx, repositoryContract, { vertices: drafts, removals: [] });
        else for (const draft of drafts) changed += await publishGraphDrafts(tx, repositoryContract, { vertices: [draft], removals: [] });
        results.push(changed);
      });
      await owner.transaction('write', async (tx) => {
        const made = await tx.query<{ id: string }>("INSERT INTO context (parent, ref) VALUES (1, 'branch') RETURNING id::text");
        const context = Number(made.rows[0]!.id);
        let changed = 0;
        if (mode === 0) changed = await publishGraphDrafts(tx, repositoryContract, { vertices: base, removals: [] }, context);
        else for (const draft of base) changed += await publishGraphDrafts(tx, repositoryContract, { vertices: [draft], removals: [] }, context);
        results.push(changed);
      });
      await expect(owner.transaction('write', async (tx) => {
        await publishGraphDrafts(tx, repositoryContract, { vertices: base.map((draft) => ({ ...draft, producer: 'rolled-back' })), removals: [] });
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      const state = await owner.transaction('snapshot', async (tx) => {
        const opinions = await tx.query(`SELECT id::text, node_id::text, said_by, state, evidence, lang, context_id, translated_from::text, source_digest, mode, blob::text, languages, language FROM ${GIT_TABLES.file} ORDER BY id`);
        expect(opinions.rows.filter((row: any) => row.state === 'closed')).toHaveLength(3);
        const journal = await tx.query<{ change: { opinions: unknown[] } }>('SELECT change FROM operation ORDER BY seq');
        return { opinions: opinions.rows, journal: journal.rows.flatMap(row => row.change.opinions) };
      });
      // Node UIDs are deterministic, while event timestamps reflect each database's own turn.
      const normalized = JSON.parse(JSON.stringify(state), (key, value) => key === 'said_at' ? '<time>' : value);
      snapshots.push({ results, state: normalized });
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
  } finally { for (const owner of owners) await owner.close(); }
}, 30_000);
