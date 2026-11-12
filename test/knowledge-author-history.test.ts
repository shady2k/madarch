import { expect, test } from 'bun:test';
import { GIT_CONTRACT } from '../src/fill/stages/git-contract.js';
import { publishHistory, type HistoryCommit } from '../src/graph/records.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { projectHistory } from '../src/knowledge/history-evidence.js';
import { createTestDatabaseOwner } from './test-database.js';

test('author evidence keeps every commit and distinct non-merge file count before display limits', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: GIT_CONTRACT });
  try {
    const commit = (hash: string, parents: string[], paths: string[], name = 'Ada'): HistoryCommit => ({
      hash: hash.repeat(40), parents: parents.map((one) => one.repeat(40)), authorName: name, authorEmail: `${name.toLowerCase()}@example.test`,
      authorDate: '2026-01-01T00:00:00+00:00', commitDate: '2026-01-01T00:00:00+00:00', subject: hash,
      touched: paths.map((path) => ({ path, change: 'modified', added: 3, removed: 2 })),
    });
    await publishHistory(owner, { repository: { name: 'fixture' }, commits: [
      commit('a', [], ['a.ts', 'b.ts']),
      commit('b', ['a'], ['a.ts']),
      commit('c', ['a'], ['other.ts'], 'Ben'),
      commit('d', ['b', 'c'], ['merge-only.ts']),
    ] });
    const graph = new GraphReader(owner, () => '2026-01-01T00:00:00Z');
    const [author] = await graph.find('code.author:ada@example.test');
    if (author === undefined) throw new Error('fixture author missing');
    const evidence = await graph.historyEvidenceFor(author, 'author', 1);
    expect(evidence.entities.filter((one) => one.kind === 'code.commit').map((one) => one.properties['hash']).sort()).toEqual(['a', 'b', 'd'].map((one) => one.repeat(40)));
    const touches = evidence.edges.filter((one) => one.relation === 'code.touched');
    expect(touches.map((one) => one.to).sort()).toEqual(['code.file:fixture/a.ts', 'code.file:fixture/a.ts', 'code.file:fixture/b.ts']);
    expect(touches.every((one) => one.properties['added'] === 3 && one.properties['removed'] === 2)).toBe(true);
    const projection = projectHistory(evidence, author, 'author', 1, (one) => ({ id: one.key, kind: one.kind, label: one.label, href: '' }));
    expect(projection.sections.map((one) => ({ role: one.role, total: one.total, rows: one.rows.length }))).toEqual([
      { role: 'commits', total: 3, rows: 1 }, { role: 'files', total: 2, rows: 1 },
    ]);
    expect(projection.sections[1]!.rows[0]!.entity!.id).toBe('code.file:fixture/a.ts');
    expect(projection.sections[1]!.rows[0]!.figures).toEqual([{ kind: 'commits', value: '2' }]);
    expect(projection.notes).toEqual([{ key: 'observedAuthorship' }]);
  } finally { await owner.close(); }
});
