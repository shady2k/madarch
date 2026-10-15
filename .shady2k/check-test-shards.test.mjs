import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkShardCoverage } from './check-test-shards.mjs';

function manifests(...shards) {
  return shards.map((files) => files);
}

describe('root test shard coverage', () => {
  it('accepts the full test-file list when every file ran once', () => {
    assert.deepEqual(checkShardCoverage(
      ['a.test.ts', 'b.test.ts', 'c.test.ts'],
      manifests(['a.test.ts'], ['b.test.ts', 'c.test.ts']),
      2,
      '/repo',
      'shards',
    ), []);
  });

  it('names every test file omitted from all shards', () => {
    assert.deepEqual(checkShardCoverage(
      ['a.test.ts', 'b.test.ts'],
      manifests(['a.test.ts']),
      1,
      '/repo',
      'shards',
    ), ['test file ran in no shard: /repo/b.test.ts']);
  });

  it('refuses overlap, unknown files, and a missing shard manifest', () => {
    assert.deepEqual(checkShardCoverage(
      ['a.test.ts'],
      manifests(['a.test.ts', 'not-a-test.ts'], ['a.test.ts']),
      3,
      '/repo',
      'shards',
    ), [
      '/repo/shards: expected 3 shard manifests, found 2',
      'shard 1 reported unknown test file /repo/not-a-test.ts',
      'test file ran in more than one shard: /repo/a.test.ts',
    ]);
  });
});
