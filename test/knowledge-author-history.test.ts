import { expect, test } from 'bun:test';
import { publishGraphDrafts, type GraphDrafts } from '../src/graph/write.js';
import { repositoryContract, repositoryKindReads, repositoryEdgeReads } from './repository-contract-fixture.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { projectHistory } from '../src/knowledge/history-evidence.js';
import { createTestDatabaseOwner } from './test-database.js';

test('author evidence keeps every commit and distinct non-merge file count before display limits', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: repositoryContract });
  try {
    const commit = (hash: string, parents: string[], paths: string[], name = 'Ada') => ({
      hash: hash.repeat(40), parents: parents.map((one) => one.repeat(40)), authorName: name, authorEmail: `${name.toLowerCase()}@example.test`,
      authorDate: '2026-01-01T00:00:00+00:00', commitDate: '2026-01-01T00:00:00+00:00', subject: hash,
      touched: paths.map((path) => ({ path, change: 'modified' as const, added: 3, removed: 2 })),
    });
    const commits = [
      commit('a', [], ['a.ts', 'b.ts']),
      commit('b', ['a'], ['a.ts']),
      commit('c', ['a'], ['other.ts'], 'Ben'),
      commit('d', ['b', 'c'], ['merge-only.ts']),
    ];
    const vertices: GraphDrafts['vertices'][number][] = [];
    const claims: NonNullable<GraphDrafts['edges']>[number][] = [];
    const vertex = (kind: string, key: Record<string, string>, values: Record<string, unknown> = {}) => {
      const ref = { kind, key };
      vertices.push({ ...ref, values, producer: 'git', producerVersion: '1' });
      return ref;
    };
    const edge = (kind: string, from: { kind: string; key: Record<string, string> }, to: { kind: string; key: Record<string, string> }, values: Record<string, unknown> = {}, discriminator?: string) => {
      claims.push({ kind, from, to, values, producer: 'git', producerVersion: '1', ...(discriminator === undefined ? {} : { discriminator }) });
    };
    const repository = vertex('code.repository', { name: 'fixture' });
    const files = new Map<string, ReturnType<typeof vertex>>();
    for (const [walk, commit] of commits.entries()) {
      const held = vertex('code.commit', { hash: commit.hash }, { algorithm: 'sha1', subject: commit.subject, author_date: '2026-01-01T00:00:00', author_offset_min: 0, commit_date: '2026-01-01T00:00:00', commit_offset_min: 0 });
      const author = vertex('code.author', { name: commit.authorName, email: commit.authorEmail });
      edge('code.history', repository, held, { walk });
      edge('code.authored', author, held);
      for (const [position, hash] of commit.parents.entries()) edge('code.parent', held, { kind: 'code.commit', key: { hash } }, { position });
      for (const touched of commit.touched) {
        const file = files.get(touched.path) ?? vertex('code.file', { repository: 'fixture', path: touched.path });
        files.set(touched.path, file);
        edge('code.touched', held, file, { change: touched.change, added: touched.added, removed: touched.removed });
      }
    }
    await owner.transaction('write', tx => publishGraphDrafts(tx, repositoryContract, { vertices, edges: claims, removals: [] }));
    const graph = new GraphReader(owner, () => '2026-01-01T00:00:00Z', undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads);
    const [author] = await graph.find('code.author:Ada/ada@example.test');
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
