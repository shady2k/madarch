/**
 * A producer's findings are problems (madarch-stm0.7.1): the product's manifest declares a findings kind
 * (`findings: true`), the consistency plugin states one entity a finding there, and the Problems page reads that kind
 * as problems. The engine names no kind: a manifest that declares none shows none.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { GraphEntity, GraphReader } from '../src/knowledge/graph-read.js';
import { collectProblems } from '../src/problems/index.js';
import { defaultSettings } from '../src/problems/types.js';

const unusedOwner: DatabaseOwner = {
  location: 'unused findings fixture', ready: Promise.resolve(), allowConcurrentSnapshots: false, hasVector: false,
  transaction: async () => { throw new Error('the findings fixture must not query SQL'); },
  run: async () => { throw new Error('the findings fixture must not query SQL'); },
  exec: async () => { throw new Error('the findings fixture must not query SQL'); },
  close: async () => {},
};

/** One finding as the consistency plugin states it: its rule, the entity it is about and why. */
const finding = (rule: string, subject: string, cause: string): GraphEntity => ({
  key: `probe.finding:${rule}#${subject}`,
  kind: 'probe.finding', label: cause,
  properties: { rule, subject, cause },
  nodeIds: [], scope: '',
});

/** The graph read boundary only: the findings kind answers the fixture's findings, every other read nothing. */
class FindingsReader {
  constructor(private readonly rows: readonly GraphEntity[]) {}
  async byPrefix(kind: string, prefix: string): Promise<{ total: number; rows: GraphEntity[] }> {
    const rows = this.rows.filter((one) => one.kind === kind && one.key.startsWith(prefix));
    return { total: rows.length, rows };
  }
  async relationEdges(): Promise<{ total: number; rows: [] }> { return { total: 0, rows: [] }; }
}

describe('a findings kind of the manifest is read as problems, and no other kind is', () => {
  test('a finding stated by a producer is a problem naming its subject, and a manifest with no findings kind shows none', async () => {
    const product = mkdtempSync(join(tmpdir(), 'madarch-findings-'));
    try {
      const graph = new FindingsReader([
        finding('dangling-reference', 'code.file:shop/src/a.ts', 'the edge names a key no vertex holds'),
        finding('removed-end', 'code.commit:aaaa', 'the edge ends at a removed vertex'),
      ]) as unknown as GraphReader;
      const read = async (findingKinds?: readonly string[]) => await collectProblems({
        productFolder: product, owner: unusedOwner, graph,
        ...(findingKinds === undefined ? {} : { findingKinds }),
        // A rule the manifest does not declare is a note, never a row (views.ts): the fixture declares the two.
        settings: { ...defaultSettings(), rules: {
          'dangling-reference': { predicate: 'findings', kind: 'bug', sonar: 'bug', severity: 'major', section: 'code', action: 'fix', label: 'unresolved reference' },
          'removed-end': { predicate: 'findings', kind: 'bug', sonar: 'bug', severity: 'major', section: 'code', action: 'fix', label: 'removed end' },
        } as never },
        resolve: async () => { throw new Error('the fixture resolves no address'); }, findings: [],
      });
      const listing = await read(['probe.finding']);
      const shown = listing.problems.filter((problem) => problem.rule === 'dangling-reference' || problem.rule === 'removed-end');
      expect(shown.map((problem) => [problem.rule, problem.entity?.key, problem.severity]).sort()).toEqual([
        ['dangling-reference', 'code.file:shop/src/a.ts', 'major'],
        ['removed-end', 'code.commit:aaaa', 'major'],
      ]);
      expect(shown.map((problem) => problem.reason).sort()).toEqual(['the edge ends at a removed vertex', 'the edge names a key no vertex holds']);
      // The engine names no findings kind: a product that declares none shows none of these.
      expect((await read()).problems.filter((problem) => problem.rule === 'dangling-reference')).toEqual([]);
    } finally {
      rmSync(product, { recursive: true, force: true });
    }
  }, 120_000);
});
