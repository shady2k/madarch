import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { repositoryContract, repositoryManifest } from './repository-contract-fixture.js';
import { collectProblems } from '../src/problems/index.js';
import { defaultSettings } from '../src/problems/types.js';
import { workingTreeFiles } from '../src/plugin/product-files.js';
import type { GraphReader } from '../src/knowledge/graph-read.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { vanishedCurrentEvidence } from '../src/graph/index.js';

test('current evidence loses applicability without rewriting ended history or disproving unavailable commits', async () => {
  const contract: GraphContract = { ...repositoryContract, vertex: [...repositoryContract.vertex, {
    name: 'probe.fact', table: generatedTableName('probe.fact', 'vertex'), key: ['id'], capability: 'probe',
    fields: [{ name: 'id', type: 'text' }, { name: 'title', type: 'text' }],
  }] };
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', async tx => {
      await publishGraphDrafts(tx, contract, { removals: [], vertices: [
        { kind: 'code.repository', key: { name: 'fixture' }, values: { url: 'file:///fixture' }, producer: 'disk', producerVersion: '1' },
        { kind: 'code.commit', key: { hash: 'current' }, values: {}, producer: 'git', producerVersion: '1' },
        { kind: 'code.file', key: { repository: 'fixture', path: 'src/changed.ts' }, values: { blob: 'new-blob' }, producer: 'disk', producerVersion: '1' },
        ...['open', 'ended', 'unknown'].map(id => ({ kind: 'probe.fact', key: { id }, values: { title: id }, producer: 'probe', producerVersion: '1',
          evidence: [{ repository: 'fixture', commit: 'old-unavailable', ...(id === 'unknown' ? {} : { path: 'src/gone.ts', lineStart: 7 }) }] })),
      ], edges: [{ kind: 'code.as-is', from: { kind: 'code.repository', key: { name: 'fixture' } }, to: { kind: 'code.commit', key: { hash: 'current' } }, producer: 'git', producerVersion: '1', evidence: [{ repository: 'fixture', commit: 'current', path: 'src/gone.ts' }] }] }, 1);
      await tx.query(`UPDATE ${generatedTableName('probe.fact', 'vertex')} SET state = 'closed' WHERE title = 'ended'`);
      await publishGraphDrafts(tx, contract, { vertices: [
        { kind: 'probe.fact', key: { id: 'blob' }, values: { title: 'blob' }, producer: 'probe', producerVersion: '1', evidence: [{ repository: 'fixture', commit: 'new-blob', path: 'src/changed.ts' }] },
      ], removals: [], edges: [{ kind: 'code.contains', from: { kind: 'code.repository', key: { name: 'fixture' } }, to: { kind: 'code.file', key: { repository: 'fixture', path: 'src/changed.ts' } }, producer: 'disk', producerVersion: '1' }] }, 1);
      await tx.query(`UPDATE ${generatedTableName('code.file', 'vertex')} SET state = 'closed' WHERE blob = 'new-blob'`);
      await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'code.file', key: { repository: 'fixture', path: 'src/changed.ts' }, values: { blob: 'newer-blob' }, producer: 'disk', producerVersion: '1' }], removals: [] }, 1);
    });
    const page = await vanishedCurrentEvidence(owner, contract);
    expect(page.rows.find(row => row.kind === 'code.as-is')).toMatchObject({ applicability: 'stale', key: { from: { name: 'fixture' }, to: { hash: 'current' } } });
    expect(page.rows.filter(row => row.kind === 'probe.fact').map(row => [row.key['id'], row.applicability, row.evidence.path])).toEqual([
      ['open', 'stale', 'src/gone.ts'], ['unknown', 'unavailable', undefined], ['blob', 'stale', 'src/changed.ts'],
    ]);
    let after: string | undefined;
    const seen: string[] = [];
    do {
      const next = await vanishedCurrentEvidence(owner, contract, { limit: 1, ...(after === undefined ? {} : { after }) });
      seen.push(...next.rows.filter(row => row.kind === 'probe.fact').map(row => String(row.key['id'])));
      after = next.next;
    } while (after !== undefined);
    expect(seen).toEqual(['open', 'unknown', 'blob']);
    const folder = mkdtempSync(join(tmpdir(), 'evidence-problem-'));
    try {
      const graph = {
        list: async () => ({ rows: [], total: 0, next: null }),
        byPrefix: async () => ({ rows: [], total: 0 }),
        relationEdges: async () => ({ rows: [], total: 0 }),
      } as unknown as GraphReader;
      const listing = await collectProblems({
        owner, productFolder: folder, files: workingTreeFiles(folder), graph,
        manifest: { ...repositoryManifest, kinds: new Map([...repositoryManifest.kinds, ['probe.fact', {
          ...repositoryManifest.kinds.get('code.file')!, name: 'probe.fact', key: ['id'], fields: [{ name: 'id', type: 'text' }, { name: 'title', type: 'text' }],
        }]]) },
        settings: { ...defaultSettings(), rules: { 'evidence-applicability': { predicate: 'findings', kind: 'evidence-applicability', sonar: 'bug', severity: 'major', section: 'code', action: 'task', label: { en: 'Evidence applicability', ru: 'Применимость основания' } } } }, resolve: async () => { throw new Error('no fixture address'); }, findings: [],
      });
      expect(listing.problems.filter(problem => problem.rule === 'evidence-applicability').map(problem => problem.reason)).toContain('fixture/src/gone.ts:7: the evidence file is absent from the current repository tree');
    } finally { rmSync(folder, { recursive: true, force: true }); }

    await owner.transaction('write', async tx => {
      // Retired containment leaves its edge identity and another producer's file opinion standing.
      await tx.query(`UPDATE ${generatedTableName('code.contains', 'edge')} SET state = 'closed'`);
      await publishGraphDrafts(tx, contract, { removals: [], vertices: [
        { kind: 'probe.fact', key: { id: 'retired-containment' }, values: { title: 'retired-containment' }, producer: 'probe', producerVersion: '1', evidence: [{ repository: 'fixture', commit: 'current', path: 'src/changed.ts' }] },
        { kind: 'probe.fact', key: { id: 'removed-current' }, values: { title: 'removed-current' }, producer: 'probe', producerVersion: '1', evidence: [{ repository: 'fixture', commit: 'current' }] },
      ] }, 1);
      await tx.query(`UPDATE node SET removed = true WHERE key = '{"hash":"current"}'::jsonb`);
    });
    const retired = await vanishedCurrentEvidence(owner, contract);
    expect(retired.rows.find(row => row.key['id'] === 'retired-containment')?.reason).toBe('the evidence file is absent from the current repository tree');
    expect(retired.rows.find(row => row.key['id'] === 'removed-current')?.reason).toBe('the evidence commit has been withdrawn from the graph');
    await owner.transaction('write', async tx => {
      await tx.query(`UPDATE ${generatedTableName('code.as-is', 'edge')} SET state = 'closed'`);
    });
    expect((await vanishedCurrentEvidence(owner, contract)).rows).toEqual([]);
  } finally { await owner.close(); }
}, 30_000);
