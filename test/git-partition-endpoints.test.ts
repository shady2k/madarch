import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract } from '../plugins/git/main.js';
import { partitioned } from '../plugins/git/partition.js';
import { reconcileFacts, reconciliationBatches } from '../src/plugin-sdk.js';
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

for (const split of [false, true]) test(`commit change evidence reconciles across hash groups, split=${split} (madarch-64o5.74)`, async () => {
  const output = partitioned(extract);
  const groups = split ? [[hashes[0]!], [hashes[1]!, hashes[2]!]] : [hashes];
  const vertices = new Map<string, NonNullable<Awaited<ReturnType<typeof extract>>['vertices']>[number]>();
  const edges = new Map<string, NonNullable<Awaited<ReturnType<typeof extract>>['edges']>[number]>();
  const reconcile = async (keys: readonly string[]) => {
    const base = unit(keys);
    const selected = { ...base, inputs: { ...base.inputs as object, edgeOutputs: [
      { kind: 'code.parent', from: 'code.commit', to: 'code.commit' },
      { kind: 'code.touched', from: 'code.commit', to: 'code.file' },
    ] } };
    const answer = await output.extract(selected, context());
    expect(answer.end.state).toBe('complete');
    const current = { vertices: [...vertices.values()], edges: [...edges.values()].filter(edge => keys.includes(String(edge.from.key['hash']))) };
    const writes = reconcileFacts(answer, current, {}, { kind: selected.kind, keys: keys.map(hash => ({ hash })) });
    expect(writes.some(write => write.operation === 'remove')).toBe(false);
    const operations = [...reconciliationBatches(writes, gitContract.outputs as never, selected)];
    for (const operation of operations) {
      for (const vertex of operation.vertices ?? []) {
        const identity = JSON.stringify([vertex.kind, vertex.key]);
        const prior = vertices.get(identity);
        if (prior !== undefined) expect(vertex.values).toEqual(prior.values);
        vertices.set(identity, vertex);
      }
      for (const edge of operation.edges ?? []) {
        const identity = JSON.stringify([edge.kind, edge.from, edge.to]);
        const prior = edges.get(identity);
        if (prior !== undefined) expect(edge.values).toEqual(prior.values);
        edges.set(identity, edge);
      }
    }
    return writes;
  };
  for (const keys of groups) await reconcile(keys);
  for (const edge of edges.values()) if (edge.kind === 'code.touched') expect(edge.evidence).toMatchObject({ target: edge.from, commit: edge.from.key['hash'] });
  expect(vertices.size).toBe(3);
  expect([...edges.values()].filter(edge => edge.kind === 'code.parent')).toHaveLength(2);
  expect([...edges.values()].filter(edge => edge.kind === 'code.touched')).toHaveLength(3);
  expect([...edges.values()]).toContainEqual(expect.objectContaining({ kind: 'code.parent', from: { kind: 'code.commit', key: { hash: hashes[2] } }, to: { kind: 'code.commit', key: { hash: hashes[1] } } }));
  expect(await reconcile(hashes)).toEqual([]);
  for (const keys of [...groups].reverse()) expect(await reconcile(keys)).toEqual([]);
});
