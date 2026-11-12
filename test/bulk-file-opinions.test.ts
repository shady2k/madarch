import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { GIT_CONTRACT, GIT_KINDS, GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { ensureVertex, journalFor, journalOn, publishOpinion, publishOpinions, writeJournal } from '../src/graph/write.js';

// The batch and individual calls see the same declarations, inputs and transaction boundaries.
test('bulk file opinions retain singleton state, journal order, replacements and rollback', async () => {
  const owners = await Promise.all([createTestDatabaseOwner(), createTestDatabaseOwner()]);
  try {
    const snapshots: unknown[] = [];
    for (const [mode, owner] of owners.entries()) {
      await createOneGraphSchema(owner, GIT_CONTRACT);
      const nodes: string[] = [];
      await owner.transaction('write', async (tx) => {
        for (const path of ['a.ts', 'b.ts']) nodes.push((await ensureVertex(tx, GIT_CONTRACT, { kind: GIT_KINDS.file, key: { repository: { kind: GIT_KINDS.repository, key: { name: 'fixture' } }, path } })).nodeId);
      });
      const base = nodes.map((nodeId, at) => ({ kind: GIT_KINDS.file, nodeId, producer: 'scanner', producerVersion: '1', values: { mode: '100644', blob_id: null, language: at === 0 ? 'TypeScript' : 'XML', languages: at === 0 ? ['TypeScript', 'XML'] : [] }, evidence: [{ type: 'file' as const, path: `${at}.ts` }] }));
      const turns = [
        base,
        base,
        base.map((draft) => ({ ...draft, evidence: [{ type: 'file' as const, path: 'changed.ts' }], producerVersion: '2' })),
        base.map((draft) => ({ ...draft, values: { language: 'JavaScript' }, producerVersion: '3' })),
        base.map((draft) => ({ ...draft, lang: 'ru', translatedFrom: '1', sourceDigest: 'digest' })),
        [{ ...base[0]!, producer: 'duplicate' }, { ...base[0]!, producer: 'duplicate', values: { language: 'JSON' } }],
      ];
      const results: unknown[] = [];
      for (const drafts of turns) await owner.transaction('write', async (tx) => {
        const journal = journalFor('scanner@1'); journalOn(tx, journal);
        if (mode === 0) results.push(await publishOpinions(tx, GIT_CONTRACT, drafts));
        else { const changed: boolean[] = []; for (const draft of drafts) changed.push(await publishOpinion(tx, GIT_CONTRACT, draft)); results.push(changed); }
        await writeJournal(tx, journal);
      });
      await owner.transaction('write', async (tx) => {
        const made = await tx.query<{ id: string }>("INSERT INTO context (parent, ref) VALUES (1, 'branch') RETURNING id::text");
        const context = Number(made.rows[0]!.id);
        const journal = journalFor('scanner@1'); journalOn(tx, journal);
        if (mode === 0) results.push(await publishOpinions(tx, GIT_CONTRACT, base, context));
        else { const changed: boolean[] = []; for (const draft of base) changed.push(await publishOpinion(tx, GIT_CONTRACT, draft, context)); results.push(changed); }
        await writeJournal(tx, journal);
      });
      await expect(owner.transaction('write', async (tx) => {
        await publishOpinions(tx, GIT_CONTRACT, base.map((draft) => ({ ...draft, producer: 'rolled-back' })));
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      const state = await owner.transaction('snapshot', async (tx) => {
        const opinions = await tx.query(`SELECT id::text, node_id::text, said_by, state, evidence, lang, context_id, translated_from::text, source_digest, mode, blob_id::text, languages, language FROM ${GIT_TABLES.file} ORDER BY id`);
        expect(opinions.rows.filter((row: any) => row.state === 'closed')).toHaveLength(3);
        const journal = await tx.query<{ change: unknown }>('SELECT change FROM operation ORDER BY seq');
        return { opinions: opinions.rows, journal: journal.rows };
      });
      // Node UIDs are deterministic, while event timestamps reflect each database's own turn.
      const normalized = JSON.parse(JSON.stringify(state), (key, value) => key === 'said_at' ? '<time>' : value);
      snapshots.push({ results, state: normalized });
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
  } finally { for (const owner of owners) await owner.close(); }
}, 30_000);
