import { testHostBinding } from './host-binding-fixture.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { expect, test } from 'bun:test';
import { publishGraphDrafts, type GraphDrafts } from '../src/graph/write.js';
import { repositoryContract, repositoryKindReads, repositoryEdgeReads } from './repository-contract-fixture.js';
import { activateGraphProducer } from '../src/graph/producer-binding.js';
import { GIT_KINDS } from '../src/fill/stages/git-contract.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { createTestDatabaseOwner } from './test-database.js';

// A whole-graph verdict reads every touched edge. Its cost must be one properties read, not one per changed file.
test('relation properties are batched without mixing edges, producers, contexts or superseded assertions', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: withManifestContract(repositoryContract) });
  try {
    const hash = 'a'.repeat(40);
    const paths = ['a.txt', 'b.txt', 'c.txt', ...Array.from({ length: 97 }, (_, at) => `extra-${String(at).padStart(3, '0')}.txt`)];
    const vertices: GraphDrafts['vertices'][number][] = [];
    const claims: NonNullable<GraphDrafts['edges']>[number][] = [];
    const vertex = (kind: string, key: Record<string, string>, values: Record<string, unknown> = {}) => {
      const ref = ['code.file', 'code.directory'].includes(kind) ? { kind, key: { path: key['path']! }, keyEdges: { [`${kind}-repository`]: { kind: 'code.repository', key: { name: key['repository']! } } } } : { kind, key };
      vertices.push({ ...ref, values, producer: 'git', producerVersion: '1' });
      return ref;
    };
    const edge = (kind: string, from: { kind: string; key: Record<string, string> }, to: { kind: string; key: Record<string, string> }, values: Record<string, unknown> = {}, discriminator?: string) => {
      claims.push({ kind, from, to, values, producer: 'git', producerVersion: '1', ...(discriminator === undefined ? {} : { discriminator }) });
    };
    const repository = vertex('code.repository', { name: 'fixture' }, { url: 'file:///fixture' });
    const heldCommit = vertex('code.commit', { hash }, { algorithm: 'sha1', subject: 'fixture', author_date: '2026-01-01T00:00:00Z', author_offset_min: 0, commit_date: '2026-01-01T00:00:00Z', commit_offset_min: 0 });
    const author = vertex('code.author', { name: 'Fixture', email: 'fixture@example.test' });
    edge('code.as-is', repository, heldCommit);
    edge('code.history', repository, heldCommit, { walk: 0 });
    edge('code.authored', author, heldCommit);
    paths.forEach((path, at) => {
      const file = vertex('code.file', { repository: 'fixture', path }, { mode: '100644', blob: 'b'.repeat(40), bytes: 2, lines: 1, form: 'text', language: 'Text', languages: ['Text'], content: 'x\n' });
      edge('code.contains', repository, file);
      edge('code.touched', heldCommit, file, { change: 'added', added: at + 1, removed: 0 });
    });
    const gitBinding = await testHostBinding(owner, repositoryContract, 'git');
    const reviewBinding = await testHostBinding(owner, repositoryContract, 'review');
    await owner.transaction('write', async tx => {
      await activateGraphProducer(tx, repositoryContract, gitBinding);
      await publishGraphDrafts(tx, repositoryContract, { vertices, edges: claims, removals: [] });
    });
    // Install the source before the child pins its parent; grants do not widen that pin.
    await testHostBinding(owner, repositoryContract, 'other-context');
    await owner.exec("INSERT INTO context (parent, ref) VALUES (1, 'review')");
    const otherBinding = await testHostBinding(owner, repositoryContract, 'other-context', '1', 2);
    const touched = (path: string, producer: string, values: Record<string, unknown>) => ({
      kind: GIT_KINDS.touched, from: heldCommit, to: { kind: 'code.file', key: { path }, keyEdges: { 'code.file-repository': repository } }, values, producer, producerVersion: '1',
    });
    await owner.transaction('write', async (tx) => {
      // A later assertion from the first source must not let its prior value enter the selected result.
      await activateGraphProducer(tx, repositoryContract, gitBinding);
      await publishGraphDrafts(tx, repositoryContract, { vertices: [], edges: [
        touched('a.txt', 'git', { change: 'modified', added: 9, removed: 2 }),
      ], removals: [] });
      await activateGraphProducer(tx, repositoryContract, reviewBinding);
      await publishGraphDrafts(tx, repositoryContract, { vertices: [], edges: [
        touched('b.txt', 'review', { change: 'modified', added: 7, removed: 0 }),
      ], removals: [] });
      await activateGraphProducer(tx, repositoryContract, otherBinding, 2);
      await publishGraphDrafts(tx, repositoryContract, { vertices: [], edges: [
        touched('c.txt', 'other-context', { change: 'deleted', added: 99, removed: 99 }),
      ], removals: [] }, 2);
    });
    const reads: string[] = [];
    await owner.transaction('snapshot', async (tx) => {
      const measured = new Proxy(tx, { get(target, key) {
        if (key === 'query') return async (sql: string, values?: readonly unknown[]) => { reads.push(sql); return await target.query(sql, values); };
        return Reflect.get(target, key);
      } });
      const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, measured, undefined, repositoryKindReads, repositoryEdgeReads, repositoryContract);
      const result = await reader.relationEdges('code.touched', 100);
      expect(result.total).toBe(100);
      expect(result.rows.map((row) => [row.to.properties?.['path'], row.properties])).toEqual([
        ['a.txt', { change: 'modified', added: 9, removed: 2 }],
        ['b.txt', { change: 'modified', added: 7, removed: 0 }],
        ['c.txt', { change: 'added', added: 3, removed: 0 }],
        ...paths.slice(3).map((path, at) => [path, { change: 'added', added: at + 4, removed: 0 }]),
      ]);
      expect(result.rows.map((row) => row.discriminator)).toEqual(paths.map(() => ''));
      // Typed reads: one edge selection (4), endpoint-kind lookup (1), two endpoint
      // selections (8), repository key-edge selection (4), and parent-key lookup (1).
      // Each selection includes one batched dispute-slot read.
      // This bound does not grow with the number of shown endpoints.
      expect(reads).toHaveLength(18);
      reads.length = 0;
      const single = await reader.relationEdges('code.touched', 1);
      expect(single.total).toBe(100);
      expect(single.rows).toEqual(result.rows.slice(0, 1));
      expect(reads).toHaveLength(18);
      reads.length = 0;
      const declared = new GraphReader(owner, () => new Date().toISOString(), undefined, measured, undefined, repositoryKindReads, new Map([[GIT_KINDS.touched, repositoryEdgeReads.get(GIT_KINDS.touched)!]]), repositoryContract);
      const generated = await declared.relationEdges('code.touched', 2);
      expect(generated.total).toBe(100);
      expect(generated.rows.map((row) => row.properties)).toEqual([
        { change: 'modified', added: 9, removed: 2 },
        { change: 'modified', added: 7, removed: 0 },
      ]);
      expect(reads).toHaveLength(13);
      reads.length = 0;
      expect((await reader.relationEdges('code.touched', 0)).rows).toEqual([]);
      expect(reads).toHaveLength(18);
    });
  } finally { await owner.close(); }
}, 20_000);
