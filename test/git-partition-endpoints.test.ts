import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract } from '../plugins/git/main.js';
import { partitioned } from '../plugins/git/partition.js';
import gitContract from '../plugins/git/contract.json';

type Unit = Parameters<typeof extract>[0];
type Context = Parameters<typeof extract>[1];
const root = mkdtempSync(join(tmpdir(), 'madarch-git-partition-endpoints-'));
const repo = join(root, 'repo');
const hashes: string[] = [];
const priorGit = process.env['MADARCH_TOOL_GIT'];
function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { env: { ...process.env,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  } }).toString('utf8').trim();
}
beforeAll(() => {
  const executable = Bun.which('git');
  if (executable === null) throw new Error('git is required');
  process.env['MADARCH_TOOL_GIT'] = executable;
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  for (let index = 0; index < 3; index++) {
    writeFileSync(join(repo, 'source.txt'), `source-${index}\n`);
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', `commit-${index}`);
    hashes.push(git('rev-parse', 'HEAD'));
  }
});
afterAll(() => {
  if (priorGit === undefined) delete process.env['MADARCH_TOOL_GIT'];
  else process.env['MADARCH_TOOL_GIT'] = priorGit;
  rmSync(root, { recursive: true, force: true });
});
const context = (): Context => ({ signal: new AbortController().signal, progress() {},
  graph: { files: async () => [], value: async () => `file://${repo}` },
} as unknown as Context);
function unit(keys: readonly string[]): Unit {
  return { kind: 'code.commit', inputs: {
    repositories: [{ repository: 'fixture', root: repo, commit: hashes[2]!, url: `file://${repo}` }],
    keys: keys.map(hash => ({ hash })),
    edgeOutputs: [{ kind: 'code.parent', from: 'code.commit', to: 'code.commit' }],
    contract: gitContract.outputs,
  } } as unknown as Unit;
}
function fullCommit(answer: Awaited<ReturnType<typeof extract>>, hash: string) {
  const vertex = answer.vertices?.find(vertex => vertex.kind === 'code.commit' && vertex.key['hash'] === hash);
  expect(vertex?.values).toMatchObject({ algorithm: 'sha1', subject: `commit-${hashes.indexOf(hash)}` });
  return vertex;
}

test('a real selected child keeps its full parent endpoint outside keys (madarch-64o5.74)', async () => {
  const answer = await partitioned(extract).extract(unit([hashes[2]!]), context());
  expect(answer.edges).toHaveLength(1);
  expect(answer.edges?.[0]).toMatchObject({ kind: 'code.parent', from: { key: { hash: hashes[2] } }, to: { key: { hash: hashes[1] } }, values: { position: 0 } });
  fullCommit(answer, hashes[2]!);
  fullCommit(answer, hashes[1]!);
  expect(answer.vertices?.some(vertex => vertex.key['hash'] === hashes[0])).toBe(false);
});

test('a real selected middle commit keeps its parent but only cites the established evidence pin (madarch-64o5.74)', async () => {
  const answer = await partitioned(extract).extract(unit([hashes[1]!]), context());
  expect(answer.edges).toHaveLength(1);
  const primary = fullCommit(answer, hashes[1]!);
  fullCommit(answer, hashes[0]!);
  expect(answer.vertices?.some(vertex => vertex.key['hash'] === hashes[2])).toBe(false);
  expect(primary?.evidence).toMatchObject({ target: { kind: 'code.commit', key: { hash: hashes[2] } } });
});

for (const reverse of [false, true]) test(`real acyclic history preserves endpoints in cyclic partition dependencies, reverse=${reverse} (madarch-64o5.74)`, async () => {
  // The history is tip -> middle -> root. Grouping root with tip yields A -> B and B -> A.
  const groups = [[hashes[0]!, hashes[2]!], [hashes[1]!]];
  if (reverse) groups.reverse();
  const output = partitioned(extract);
  const results = [];
  for (const keys of groups) {
    const answer = await output.extract(unit(keys), context());
    for (const edge of answer.edges ?? []) {
      fullCommit(answer, String(edge.from.key['hash']));
      fullCommit(answer, String(edge.to.key['hash']));
    }
    results.push(answer);
  }
  expect(results.flatMap(result => result.edges ?? [])).toHaveLength(2);
});
