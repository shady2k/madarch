import { expect, test } from 'bun:test';
import { GIT_CONTRACT } from '../src/fill/stages/git-contract.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishHistory, publishTree } from '../src/graph/records.js';
import { ensureEdge } from '../src/graph/write.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { projectHistory } from '../src/knowledge/history-evidence.js';
import { createTestDatabaseOwner } from './test-database.js';

// Path evidence must not walk unrelated structure, but import notes still need complete endpoint membership.
test('path history keeps rename and import membership evidence without loading unrelated structure', async () => {
  const contract: GraphContract = { ...GIT_CONTRACT, edge: [...GIT_CONTRACT.edge, {
    name: 'imports', capability: 'fixture', table: generatedTableName('imports', 'edge'), from: ['directory'], to: ['directory'], repeats: false, fields: [],
  }] };
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    const first = 'a'.repeat(40); const last = 'b'.repeat(40);
    const paths = ['src/new.txt', 'lib/peer.txt', ...Array.from({ length: 80 }, (_, at) => `unrelated-${at}/file.txt`)];
    await publishTree(owner, {
      repository: { name: 'fixture', url: 'file:///fixture' }, commit: last, gitlinks: [],
      files: paths.map((path) => ({ path, mode: '100644', blob: 'c'.repeat(40), bytes: 2, lines: 1, form: 'text' as const, language: 'Text', candidates: ['Text'], content: 'x\n' })),
    });
    const signature = { authorName: 'Fixture', authorEmail: 'fixture@example.test', authorDate: '2026-01-01T00:00:00+00:00', commitDate: '2026-01-01T00:00:00+00:00' };
    await publishHistory(owner, { repository: { name: 'fixture' }, commits: [
      { ...signature, commitDate: '2026-01-02T00:00:00+00:00', hash: last, parents: [first], subject: 'move', touched: [
        { path: 'src/new.txt', previousPath: 'src/old.txt', change: 'renamed', added: 0, removed: 0 },
        { path: 'lib/peer.txt', change: 'modified', added: 2, removed: 1 },
      ] },
      { ...signature, hash: first, parents: [], subject: 'start', touched: [
        { path: 'src/old.txt', change: 'added', added: 1, removed: 0 },
        { path: 'lib/peer.txt', change: 'added', added: 1, removed: 0 },
      ] },
    ] });
    const reader = new GraphReader(owner, () => '2026-01-02T00:00:00Z');
    const subject = (await reader.find('code.file:fixture/src/new.txt'))[0]!;
    const src = (await reader.find('code.directory:fixture/src'))[0]!;
    const lib = (await reader.find('code.directory:fixture/lib'))[0]!;
    const other = (await reader.find('code.directory:fixture/unrelated-0'))[0]!;
    const next = (await reader.find('code.directory:fixture/unrelated-1'))[0]!;
    await owner.transaction('write', async (tx) => {
      await ensureEdge(tx, contract, 'imports', src.nodeIds[0]!, lib.nodeIds[0]!);
      await ensureEdge(tx, contract, 'imports', other.nodeIds[0]!, next.nodeIds[0]!);
    });
    const evidence = await reader.historyEvidenceFor(subject, 'path', 5);
    expect(evidence.entities.some((one) => String(one.properties['path'] ?? '').startsWith('unrelated-'))).toBe(false);
    expect(evidence.edges.filter((one) => one.relation === 'code.imports')).toEqual([
      { from: src.key, to: lib.key, relation: 'code.imports', properties: {} },
    ]);
    expect(evidence.edges.some((one) => one.relation === 'code.renamed-to')).toBe(true);
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
