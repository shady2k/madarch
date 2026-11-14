import { expect, test } from 'bun:test';
import type { DatabaseOwner, OuterTransaction } from '../src/adapters/database-owner.js';
import { GraphReader } from '../src/knowledge/graph-read.js';

// The storage read reports inventory availability independently of history commits and entry counts.
test.each([
  { name: 'empty inventory publication', values: {}, tree: true },
  { name: 'history only', values: { history_shallow: false }, tree: false },
  { name: 'metadata only', values: { url: 'https://example.test/repo.git' }, tree: false },
])('$name reports tree availability without a history commit or file counts', async ({ values, tree }) => {
  const tx = { query: async () => ({ rows: [{
    node_id: '1', opinions: [{ id: '1', said_by: 'fixture@1', ...values }],
    as_is: null, has_tree: tree, files: '0', commits: '0', directories: '0',
  }] }) } as unknown as OuterTransaction;
  const reader = new GraphReader({} as DatabaseOwner, () => '', undefined, tx, new Set(['code.repository']));
  const repository = await reader.repository('fixture');
  expect(repository).toMatchObject({ asIsCommit: null, counts: { files: 0, commits: 0, folders: 0 }, steps: { tree, history: false } });
});
