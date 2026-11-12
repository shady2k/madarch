import { expect, test } from 'bun:test';
import { repositoryContract, repositoryKindReads, repositoryEdgeReads } from './repository-contract-fixture.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts, type GraphDrafts } from '../src/graph/write.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { projectHistory } from '../src/knowledge/history-evidence.js';
import { createTestDatabaseOwner } from './test-database.js';

// Path evidence must not walk unrelated structure, but import notes still need complete endpoint membership.
test('path history keeps rename and import membership evidence without loading unrelated structure', async () => {
  const contract: GraphContract = { ...repositoryContract, edge: [...repositoryContract.edge, {
    name: 'code.imports', capability: 'fixture', table: generatedTableName('code.imports', 'edge'), from: ['code.directory'], to: ['code.directory'], repeats: false, fields: [],
  }] };
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const first = 'a'.repeat(40); const last = 'b'.repeat(40);
    const paths = ['src/new.txt', 'lib/peer.txt', ...Array.from({ length: 80 }, (_, at) => `unrelated-${at}/file.txt`)];
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
    const repository = vertex('code.repository', { name: 'fixture' }, { url: 'file:///fixture' });
    const files = new Map<string, ReturnType<typeof vertex>>();
    const directories = new Map<string, ReturnType<typeof vertex>>();
    for (const path of paths) {
      const directory = path.slice(0, path.lastIndexOf('/'));
      if (!directories.has(directory)) {
        const held = vertex('code.directory', { repository: 'fixture', path: directory });
        directories.set(directory, held);
        edge('code.contains', repository, held);
      }
      const file = vertex('code.file', { repository: 'fixture', path }, { mode: '100644', blob: 'c'.repeat(40), bytes: 2, lines: 1, form: 'text', language: 'Text', languages: ['Text'], content: 'x\n' });
      files.set(path, file);
      edge('code.contains', directories.get(directory)!, file);
    }
    const signature = { authorName: 'Fixture', authorEmail: 'fixture@example.test', authorDate: '2026-01-01T00:00:00+00:00', commitDate: '2026-01-01T00:00:00+00:00' };
    const commits = [
      { ...signature, commitDate: '2026-01-02T00:00:00+00:00', hash: last, parents: [first], subject: 'move', touched: [
        { path: 'src/new.txt', previousPath: 'src/old.txt', change: 'renamed', added: 0, removed: 0 },
        { path: 'lib/peer.txt', change: 'modified', added: 2, removed: 1 },
      ] },
      { ...signature, hash: first, parents: [], subject: 'start', touched: [
        { path: 'src/old.txt', change: 'added', added: 1, removed: 0 },
        { path: 'lib/peer.txt', change: 'added', added: 1, removed: 0 },
      ] },
    ];
    for (const [walk, commit] of commits.entries()) {
      const held = vertex('code.commit', { hash: commit.hash }, { algorithm: 'sha1', subject: commit.subject, author_date: '2026-01-01T00:00:00', author_offset_min: 0, commit_date: commit.commitDate.slice(0, 19), commit_offset_min: 0 });
      const author = vertex('code.author', { name: commit.authorName, email: commit.authorEmail });
      edge('code.history', repository, held, { walk });
      edge('code.authored', author, held);
      if (walk === 0) edge('code.as-is', repository, held);
      for (const [position, hash] of commit.parents.entries()) edge('code.parent', held, { kind: 'code.commit', key: { hash } }, { position });
      for (const touched of commit.touched) {
        const file = files.get(touched.path) ?? vertex('code.file', { repository: 'fixture', path: touched.path });
        files.set(touched.path, file);
        edge('code.touched', held, file, { change: touched.change, added: touched.added, removed: touched.removed });
        if ('previousPath' in touched && touched.previousPath !== undefined) {
          const previous = files.get(touched.previousPath) ?? vertex('code.file', { repository: 'fixture', path: touched.previousPath });
          files.set(touched.previousPath, previous);
          edge('code.renamed-from', file, previous, {}, commit.hash);
        }
      }
    }
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, { vertices, edges: claims, removals: [] }));
    const reader = new GraphReader(owner, () => '2026-01-02T00:00:00Z', undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads);
    const subject = (await reader.find('code.file:fixture/src/new.txt'))[0]!;
    const src = (await reader.find('code.directory:fixture/src'))[0]!;
    const lib = (await reader.find('code.directory:fixture/lib'))[0]!;
    const imports = [['src', 'lib'], ['unrelated-0', 'unrelated-1']].map(([from, to]) => ({
      kind: 'code.imports', from: directories.get(from!)!, to: directories.get(to!)!, producer: 'git', producerVersion: '1',
    }));
    await owner.transaction('write', tx => publishGraphDrafts(tx, contract, { vertices: [], edges: imports, removals: [] }));
    const evidence = await reader.historyEvidenceFor(subject, 'path', 5);
    expect(evidence.entities.some((one) => String(one.properties['path'] ?? '').startsWith('unrelated-'))).toBe(false);
    expect(evidence.edges.filter((one) => one.relation === 'code.imports')).toEqual([
      { from: src.key, to: lib.key, relation: 'code.imports', properties: {} },
    ]);
    expect(evidence.edges.filter((one) => one.relation === 'code.renamed-from')).toEqual([
      { from: 'code.file:fixture/src/new.txt', to: 'code.file:fixture/src/old.txt', relation: 'code.renamed-from', properties: { discriminator: last } },
    ]);
    expect(evidence.edges.filter((one) => one.relation === 'code.contains').map((one) => one.to).sort()).toEqual([
      'code.file:fixture/lib/peer.txt', 'code.file:fixture/src/new.txt',
    ]);
    expect(evidence.entities.filter((one) => one.kind === 'code.commit').map((one) => one.properties['subject']).sort()).toEqual(['move', 'start']);
    const projected = projectHistory(evidence, subject, 'path', 100, (one) => ({ id: one.key, kind: one.kind, label: one.label, href: `/e/${one.key}` }));
    expect(projected.sections.find((one) => one.role === 'commits')?.total).toBe(2);
    expect(projected.sections.find((one) => one.role === 'commits')?.rows.map((one) => one.when)).toEqual(['2026-01-02', '2026-01-01']);
    expect(projected.sections.find((one) => one.role === 'coupling')?.rows[0]?.figures[0]).toEqual({ kind: 'both', value: '2' });
    expect(projected.notes.map((one) => one.key)).not.toContain('noImport');
    expect(projected.notes.map((one) => one.key)).not.toContain('importCoverage');
  } finally { await owner.close(); }
}, 20_000);
