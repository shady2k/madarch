import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract as diskExtract } from '../plugins/disk/main.js';
import { extract as gitExtract } from '../plugins/git/main.js';
import { readRepositoryTree } from '../plugins/disk/reader.js';
import diskContract from '../plugins/disk/contract.json';
import gitContract from '../plugins/git/contract.json';

type Context = Parameters<typeof gitExtract>[1];
type Unit = Parameters<typeof gitExtract>[0];

async function fixture(work: (repo: { root: string; git: (...args: string[]) => string; commit: (message: string, date: string) => string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-file-facts-'));
  const previousGit = process.env['MADARCH_TOOL_GIT'];
  const executable = Bun.which('git');
  if (executable === null) throw new Error('git is required');
  process.env['MADARCH_TOOL_GIT'] = executable;
  const command = (args: string[], env = process.env) => {
    const result = Bun.spawnSync([executable, '-C', root, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const git = (...args: string[]) => command(args);
  const commit = (message: string, date: string) => {
    git('add', '-A');
    command(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message], { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '-b', 'main');
    await work({ root, git, commit });
  } finally {
    if (previousGit === undefined) delete process.env['MADARCH_TOOL_GIT'];
    else process.env['MADARCH_TOOL_GIT'] = previousGit;
    rmSync(root, { recursive: true, force: true });
  }
}

const context = (paths: string[] = []): Context => ({
  signal: new AbortController().signal,
  progress() {},
  graph: {
    files: async () => paths.map(path => ({ kind: 'code.file', key: { path }, keyEdges: { 'code.file-repository': { kind: 'code.repository', key: { name: 'fixture' } } } })),
    value: async () => '',
  },
} as unknown as Context);

const unit = (root: string, commit: string, contract: unknown): Unit => ({
  kind: 'code.file',
  inputs: { repositories: [{ repository: 'fixture', root, commit, url: '' }], edgeOutputs: [{ kind: 'code.file-directory', from: 'code.file', to: 'code.directory' }, { kind: 'code.file-added-in', from: 'code.file', to: 'code.commit' }, { kind: 'code.file-removed-in', from: 'code.file', to: 'code.commit' }], contract },
} as unknown as Unit);

test('disk publishes repository parents and directory edges, never relation fields (0039 items 1–2)', async () => {
  await fixture(async ({ root, commit }) => {
    mkdirSync(join(root, 'src/nested'), { recursive: true });
    writeFileSync(join(root, 'root.txt'), 'root\n');
    writeFileSync(join(root, 'src/nested/file.txt'), 'nested\n');
    const pin = commit('files', '2026-01-01T00:00:00Z');
    const result = await diskExtract(unit(root, pin, diskContract.outputs), context());
    expect(result.end?.state).toBe('complete');
    for (const vertex of (result.vertices ?? []).filter(vertex=>vertex.kind==='code.file')) {
      expect(Object.keys(vertex.key)).toEqual(['path']);
      expect(vertex.keyEdges?.['code.file-repository']).toEqual({ kind: 'code.repository', key: { name: 'fixture' } });
      expect(vertex.values).not.toHaveProperty('directory');
      expect(vertex.values).not.toHaveProperty('repository');
    }
    const blobs=(result.vertices??[]).filter(vertex=>vertex.kind==='code.blob');
    expect(blobs).toHaveLength(3);
    const repositoryResult = await diskExtract({ ...unit(root, pin, diskContract.outputs), kind: 'code.repository' }, context());
    expect(result.edges?.filter(edge => edge.kind === 'code.blob-about' && edge.to.kind === 'code.repository')).toHaveLength(0);
    for(const blob of blobs){
      expect(blob.key['digest']).toBe(createHash('sha256').update(String(blob.values?.['content'])).digest('hex'));
      const fileContent = (result.vertices ?? []).some(vertex => vertex.kind === 'code.file' && vertex.evidence?.target.key['digest'] === blob.key['digest']);
      // The graph-level repository owner publishes the inventory pair.
      const publisher = fileContent ? result : repositoryResult;
      expect(publisher.edges?.filter(edge=>edge.kind==='code.blob-about'&&edge.from.key['digest']===blob.key['digest'])).toHaveLength(1);
    }
    expect(result.edges?.filter(edge=>edge.kind==='code.file-directory').map(edge => [edge.kind, edge.from.key['path'], edge.to.key['path']])).toEqual([
      ['code.file-directory', 'src/nested/file.txt', 'src/nested'],
    ]);
  });
}, 60_000);

test('git file facts count the commits the touched edges hold, merge commits included', async () => {
  await fixture(async ({ root, git, commit }) => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'old.txt'), 'old\n');
    writeFileSync(join(root, 'src/file.txt'), 'nested\n');
    const base = commit('base with later clock', '2026-01-10T00:00:00Z');
    writeFileSync(join(root, 'old.txt'), 'old\nedited\n');
    commit('edit with earlier clock', '2026-01-05T00:00:00Z');
    git('mv', 'old.txt', 'renamed.txt');
    const renamed = commit('rename', '2026-01-06T00:00:00Z');
    git('checkout', '-qb', 'side');
    writeFileSync(join(root, 'src/file.txt'), 'nested\nside\n');
    commit('side change', '2026-01-07T00:00:00Z');
    git('checkout', '-q', 'main');
    writeFileSync(join(root, 'main.txt'), 'main\n');
    commit('main change', '2026-01-08T00:00:00Z');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'merge', '--no-ff', '--no-commit', 'side');
    const pin = commit('merge is not another file change', '2026-01-20T00:00:00Z');
    writeFileSync(join(root, 'src/file.txt'), 'future\n');
    commit('outside pin', '2026-02-01T00:00:00Z');
    const result = await gitExtract(unit(root, pin, gitContract.outputs), context(['renamed.txt', 'src/file.txt', 'main.txt', 'untouched.txt']));
    expect(result.end?.state).toBe('complete');
    const vertices = new Map(result.vertices?.filter(vertex=>vertex.kind==='code.file').map(vertex => [String(vertex.key['path']), vertex]));
    // A path the tree no longer holds is a file too: its history and the period it existed are stated.
    expect(vertices.get('old.txt')?.values).toEqual({
      commit_count: 2, last_change: '2026-01-10T00:00:00.000Z',
      added_at: '2026-01-10T00:00:00.000Z',
      removed_at: '2026-01-06T00:00:00.000Z',
    });
    expect(vertices.get('renamed.txt')?.values).toEqual({
      commit_count: 1, last_change: '2026-01-06T00:00:00.000Z',
      added_at: '2026-01-06T00:00:00.000Z', removed_at: null,
    });
    expect(vertices.get('src/file.txt')?.values).toEqual({
      commit_count: 3, last_change: '2026-01-20T00:00:00.000Z',
      added_at: '2026-01-10T00:00:00.000Z', removed_at: null,
    });
    expect(vertices.get('main.txt')?.values).toEqual({
      commit_count: 1, last_change: '2026-01-08T00:00:00.000Z',
      added_at: '2026-01-08T00:00:00.000Z', removed_at: null,
    });
    expect(vertices.get('untouched.txt')?.values).toEqual({
      commit_count: 0, last_change: null, added_at: null, removed_at: null,
    });
    expect(result.edges?.find(edge => edge.kind === 'code.file-added-in' && edge.from.key['path'] === 'old.txt')?.to.key['hash']).toBe(base);
    expect(result.edges?.find(edge => edge.kind === 'code.file-removed-in' && edge.from.key['path'] === 'old.txt')?.to.key['hash']).toBe(renamed);
    for (const [path, vertex] of vertices) expect(vertex.evidence).toEqual({target:{kind:'code.commit',key:{hash:pin}},commit:pin,path});
  });
}, 60_000);


test('disk repository snapshots cover the complete pinned inventory including an empty tree', async () => {
  await fixture(async ({ root, git, commit }) => {
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'empty');
    const empty = await diskExtract({ ...unit(root, git('rev-parse', 'HEAD'), diskContract.outputs), kind: 'code.repository' }, context());
    const snapshot = (result: typeof empty) => result.vertices?.find(vertex => vertex.kind === 'code.repository')?.values?.['tree_snapshot'];
    const digest = (rows: unknown[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    expect(snapshot(empty)).toBe(digest([]));
    writeFileSync(join(root, 'z.txt'), 'z');
    writeFileSync(join(root, 'A.txt'), 'A');
    const pin = commit('inventory', '2026-01-01T00:00:00Z');
    const fullUnit = { ...unit(root, pin, diskContract.outputs), kind: 'code.repository' };
    const full = await diskExtract(fullUnit, context());
    expect(snapshot(full)).toBe(digest([['A.txt', git('rev-parse', `${pin}:A.txt`)], ['z.txt', git('rev-parse', `${pin}:z.txt`)]]));
    expect(snapshot(await diskExtract(fullUnit, context()))).toBe(snapshot(full));
    const limited = await diskExtract({ ...fullUnit, inputs: { ...(fullUnit.inputs as Record<string,unknown>), paths: ['A.txt'] } }, context());
    expect(snapshot(limited)).toBeUndefined();
  });
}, 60_000);

test('disk publishes the whole pinned inventory under a fill scope, and the keys alone narrow it (madarch-64o5.160)', async () => {
  await fixture(async ({ root, commit, git }) => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), 'readme\n');
    // A NUL byte is git's own answer that this blob is binary, so its file row stands on the inventory and not on bytes.
    writeFileSync(join(root, 'src/a.bin'), Buffer.from([0, 1, 2, 3]));
    const pin = commit('files', '2026-01-01T00:00:00Z');
    const rows = [['README.md', git('rev-parse', `${pin}:README.md`)], ['src/a.bin', git('rev-parse', `${pin}:src/a.bin`)]] as const;
    const inventoryDigest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const inventoryOf = (result: Awaited<ReturnType<typeof diskExtract>>) => (result.vertices ?? []).find(vertex => vertex.kind === 'code.blob' && vertex.key['digest'] === inventoryDigest);
    const published = (result: Awaited<ReturnType<typeof diskExtract>>) => (result.vertices ?? []).filter(vertex => vertex.kind === 'code.file').map(vertex => vertex.key['path']);
    const targetOf = (result: Awaited<ReturnType<typeof diskExtract>>, path: string) => (result.vertices ?? []).find(vertex => vertex.kind === 'code.file' && vertex.key['path'] === path)?.evidence?.target.key['digest'];
    const base = unit(root, pin, diskContract.outputs);
    const withInputs = (inputs: Record<string, unknown>) => ({ ...base, inputs: { ...(base.inputs as Record<string, unknown>), ...inputs } });
    const full = await diskExtract(base, context());
    expect(published(full)).toEqual(['README.md', 'src/a.bin']);
    expect(inventoryOf(full)?.values?.['content']).toBe(JSON.stringify(rows));
    // A fill's paths decide what is published, never what the inventory states: the binary row is still part of it.
    const scoped = await diskExtract(withInputs({ paths: ['src'] }), context());
    expect(published(scoped)).toEqual(['src/a.bin']);
    expect(inventoryOf(scoped)?.values?.['content']).toBe(JSON.stringify(rows));
    expect(targetOf(scoped, 'src/a.bin')).toBe(inventoryDigest);
    expect(targetOf(full, 'src/a.bin')).toBe(inventoryDigest);
    // Keys are the rows that narrow the inventory; a narrower scope does not take a key's row away.
    const keyed = await diskExtract(withInputs({ paths: ['src'], keys: [{ path: 'README.md' }, { path: 'src/a.bin' }] }), context());
    expect(published(keyed)).toEqual(['README.md', 'src/a.bin']);
    expect(inventoryOf(keyed)?.values?.['content']).toBe(JSON.stringify(rows));
    // A strict subset outside the scope must keep only its own inventory row and still publish the key.
    const subset = await diskExtract(withInputs({ paths: ['src'], keys: [{ path: 'README.md' }] }), context());
    const subsetRows = [rows[0]];
    expect(published(subset)).toEqual(['README.md']);
    const recorder = recordingGit(root, process.env['MADARCH_TOOL_GIT']!);
    try {
      const subsetTree = await readRepositoryTree({ repository: 'fixture', root, commit: pin }, { paths: ['README.md'], scope: ['src'] });
      expect(subsetTree.inventory).toEqual(subsetRows);
      expect(recorder.commands().split('\n').filter(line => line.startsWith('ls-tree '))).toEqual([
        `ls-tree -r -l -z ${pin} -- :(literal)README.md`,
      ]);
      // Git treats a directory pathspec as a prefix; inventory must still keep only exact keys.
      const directoryKey = await readRepositoryTree({ repository: 'fixture', root, commit: pin }, { paths: ['src'], scope: ['src'] });
      expect(directoryKey.inventory).toEqual([]);
    } finally { recorder.restore(); }

  });
}, 60_000);

/**
 * A git that writes every command it is given, and every batch `cat-file` is handed, so a test states which bytes the
 * plugin asked git for — never a stopwatch (madarch-64o5.74).
 */
function recordingGit(work: string, real: string): { commands: () => string; batches: () => string; diff: () => string; diffArgs: () => string[]; restore: () => void } {
  const executable = join(work, 'git-recording.sh');
  const commands = join(work, 'git-commands.log');
  const batches = join(work, 'git-batches.log');
  const diff = join(work, 'git-diff.log');
  const diffArgs = join(work, 'git-diff-args.log');
  writeFileSync(commands, '');
  writeFileSync(batches, '');
  writeFileSync(diff, '');
  writeFileSync(executable, [
    '#!/bin/sh',
    'printf "%s\n" "$*" >> "$MADARCH_TEST_GIT_COMMANDS"',
    'if [ "$1" = "cat-file" ]; then',
    '  batch=$(cat)',
    '  printf "%s\n" "$batch" >> "$MADARCH_TEST_GIT_BATCHES"',
    '  printf "%s\n" "$batch" | "$MADARCH_TEST_GIT_REAL" "$@"',
    '  exit $?',
    'fi',
    'if [ "$1" = "diff" ]; then',
    '  printf "%s\\0" "$@" > "$MADARCH_TEST_GIT_DIFF_ARGS"',
    '  "$MADARCH_TEST_GIT_REAL" "$@" > "$MADARCH_TEST_GIT_DIFF"',
    '  status=$?',
    '  cat "$MADARCH_TEST_GIT_DIFF"',
    '  exit $status',
    'fi',
    'exec "$MADARCH_TEST_GIT_REAL" "$@"',
    '',
  ].join('\n'));
  chmodSync(executable, 0o755);
  const previous = process.env['MADARCH_TOOL_GIT'];
  process.env['MADARCH_TOOL_GIT'] = executable;
  process.env['MADARCH_TEST_GIT_COMMANDS'] = commands;
  process.env['MADARCH_TEST_GIT_BATCHES'] = batches;
  process.env['MADARCH_TEST_GIT_DIFF'] = diff;
  process.env['MADARCH_TEST_GIT_DIFF_ARGS'] = diffArgs;
  process.env['MADARCH_TEST_GIT_REAL'] = real;
  return {
    commands: () => readFileSync(commands, 'utf8'),
    batches: () => readFileSync(batches, 'utf8'),
    diff: () => readFileSync(diff, 'utf8'),
    diffArgs: () => readFileSync(diffArgs, 'utf8').split('\u0000').slice(0, -1),
    restore: () => {
      if (previous === undefined) delete process.env['MADARCH_TOOL_GIT'];
      else process.env['MADARCH_TOOL_GIT'] = previous;
      delete process.env['MADARCH_TEST_GIT_COMMANDS'];
      delete process.env['MADARCH_TEST_GIT_BATCHES'];
      delete process.env['MADARCH_TEST_GIT_DIFF'];
      delete process.env['MADARCH_TEST_GIT_DIFF_ARGS'];
      delete process.env['MADARCH_TEST_GIT_REAL'];
    },
  };
}

test('disk never reads the bytes of a path the product excludes, and the tree snapshot still covers the whole inventory (madarch-64o5.74)', async () => {
  await fixture(async ({ root, commit, git }) => {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(root, 'src/kept.ts'), 'export const kept = 1;\n');
    writeFileSync(join(root, 'node_modules/pkg/index.js'), 'module.exports = 2;\n');
    const pin = commit('files', '2026-01-01T00:00:00Z');
    const recorder = recordingGit(root, process.env['MADARCH_TOOL_GIT']!);
    try {
      const excluded = ['**/node_modules/**'];
      const base = unit(root, pin, diskContract.outputs);
      const files = await diskExtract({ ...base, inputs: { ...(base.inputs as Record<string, unknown>), exclude: excluded } }, context());
      // The product's own exclusion decides what is published: a dependency tree's bytes are never read to be dropped.
      expect((files.vertices ?? []).filter(vertex => vertex.kind === 'code.file').map(vertex => vertex.key['path'])).toEqual(['src/kept.ts']);
      expect(recorder.batches()).not.toContain(git('rev-parse', `${pin}:node_modules/pkg/index.js`));
      // The paired control keeps the absence honest: the kept text blob really was read through that same call.
      expect(recorder.batches()).toContain(git('rev-parse', `${pin}:src/kept.ts`));
      // Git is told to leave the excluded path out of its line counts, so its blob is never unpacked to count it.
      expect(recorder.commands().split('\n').filter(line => line.startsWith('diff '))).toEqual([
        expect.stringContaining(':(exclude,literal)node_modules/pkg/index.js'),
      ]);
      expect(recorder.diff()).toContain('src/kept.ts');
      expect(recorder.diff()).not.toContain('node_modules');
      // The snapshot states the whole pinned inventory, which the exclusion does not narrow (output unchanged).
      const repositoryUnit = { ...unit(root, pin, diskContract.outputs), kind: 'code.repository' };
      const snapshotOf = (result: Awaited<ReturnType<typeof diskExtract>>) => result.vertices?.find(vertex => vertex.kind === 'code.repository')?.values?.['tree_snapshot'];
      const narrowed = await diskExtract({ ...repositoryUnit, inputs: { ...(repositoryUnit.inputs as Record<string, unknown>), exclude: excluded } }, context());
      expect(snapshotOf(narrowed)).toBe(snapshotOf(await diskExtract(repositoryUnit, context())));
      expect(snapshotOf(narrowed)).toBeDefined();
    } finally {
      recorder.restore();
    }
  });
}, 60_000);

// Separate count and UTF-8 byte pressure, then a sparse tree whose old exclusions exceed Linux ARG_MAX.
for (const [label, count, stem] of [
  ['argument count', 600, 'x'],
  ['UTF-8 bytes', 180, 'é'.repeat(110)],
  ['ARG_MAX sparse tree', 9_000, 'x'.repeat(220)],
] as const) {
  test(`disk bounds numstat arguments under ${label} without narrowing inventory or published facts (madarch-64o5.160)`, async () => {
    await fixture(async ({ root, git, commit }) => {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/kept.ts'), 'export const kept = 1;\n// second line\n');
      writeFileSync(join(root, 'src/binary.bin'), Buffer.from([0, 1, 2]));
      // Every excluded file is at the root; no directory can stand in for this sparse exclusion set.
      for (let at = 0; at < count; at++) writeFileSync(join(root, `${at}-${stem}.omit`), 'excluded\n');
      const pin = commit('sparse excluded files', '2026-01-01T00:00:00Z');
      const rows = git('ls-tree', '-r', '-z', pin).split('\u0000').filter(Boolean)
        .map(line => [line.slice(line.indexOf('\t') + 1), line.slice(0, line.indexOf('\t')).split(' ')[2]!]);
      const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      const recorder = recordingGit(root, process.env['MADARCH_TOOL_GIT']!);
      try {
        const base = unit(root, pin, diskContract.outputs);
        // Successful extraction is also the no-E2BIG check: this is a real git, not a mocked spawn.
        const result = await diskExtract({ ...base, inputs: { ...(base.inputs as Record<string, unknown>), exclude: ['*.omit'] } }, context());
        const args = recorder.diffArgs();
        expect(args.length).toBeLessThanOrEqual(256);
        expect(args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0)).toBeLessThanOrEqual(32 * 1024);
        expect(args.some(arg => arg.startsWith(':(exclude,literal)'))).toBe(false);
        expect(result.end?.state).toBe('complete');
        const files = result.vertices?.filter(vertex => vertex.kind === 'code.file');
        expect(files?.map(vertex => vertex.key['path'])).toEqual(['src/binary.bin', 'src/kept.ts']);
        expect(files?.map(vertex => [vertex.values?.['form'], vertex.values?.['lines'], vertex.values?.['bytes']])).toEqual([
          ['binary', null, 3], ['text', 2, 38],
        ]);
        expect(files?.[0]?.evidence?.target.key['digest']).toBe(digest);
        expect(result.vertices?.find(vertex => vertex.kind === 'code.blob' && vertex.key['digest'] === digest)?.values?.['content']).toBe(JSON.stringify(rows));
        expect(recorder.batches()).not.toContain(git('rev-parse', `${pin}:0-${stem}.omit`));
        expect(recorder.batches()).toContain(git('rev-parse', `${pin}:src/kept.ts`));
      } finally { recorder.restore(); }
    });
  }, 60_000);
}

test('disk states the product reference to each pinned repository, and none without a product (0039, item 1)', async () => {
  await fixture(async ({ root, commit }) => {
    writeFileSync(join(root, 'README.md'), '# Fixture\n');
    const pin = commit('files', '2026-01-01T00:00:00Z');
    const held = unit(root, pin, diskContract.outputs);
    const base = held.inputs as { edgeOutputs: { kind: string; from: string; to: string }[] };
    const product = { kind: 'product', key: { name: 'fixture-product' } };
    const repositoryUnit = { ...held, kind: 'code.repository', inputs: {
      ...(held.inputs as Record<string, unknown>),
      edgeOutputs: [...base.edgeOutputs, { kind: 'product.uses-repository', from: 'product', to: 'code.repository' }],
      product,
    } } as unknown as Unit;
    const result = await diskExtract(repositoryUnit, context());
    expect(result.end?.state).toBe('complete');
    const uses = (result.edges ?? []).filter(edge => edge.kind === 'product.uses-repository');
    expect(uses).toHaveLength(1);
    expect(uses[0]!.from).toEqual(product);
    expect(uses[0]!.to).toEqual({ kind: 'code.repository', key: { name: 'fixture' } });
    // The edge cites the inventory snapshot the repository vertex stands on, so a rule that admits the vertex admits the edge.
    const repositoryVertex = (result.vertices ?? []).find(vertex => vertex.kind === 'code.repository');
    expect(repositoryVertex).toBeDefined();
    expect(uses[0]!.evidence).toEqual(repositoryVertex!.evidence);
    const withoutProduct = await diskExtract({ ...repositoryUnit, inputs: { ...(repositoryUnit.inputs as Record<string, unknown>), product: undefined } } as unknown as Unit, context());
    expect((withoutProduct.edges ?? []).filter(edge => edge.kind === 'product.uses-repository')).toHaveLength(0);
    // The product's own checkout is pinned under its own id, and a product does not refer to itself.
    const ownCheckout = await diskExtract({ ...repositoryUnit, inputs: { ...(repositoryUnit.inputs as Record<string, unknown>), productRepository: 'fixture' } } as unknown as Unit, context());
    expect((ownCheckout.edges ?? []).filter(edge => edge.kind === 'product.uses-repository')).toHaveLength(0);
  });
}, 60_000);
