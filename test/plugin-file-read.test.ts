/**
 * A plugin's file read is the host's one read (owner's decision, 2026-11-15; decisions 0037 and 0038): an ordinary plugin
 * asks `file.read` by (repository, blob id), the host routes it to the git core plugin, and the confinement is the one
 * `verifyBlobRead` makes — a repository that links out of the product is refused there, not in a second check. The answer
 * is the whole range the plugin asked for, even though each read the host makes of the plugin is bounded in bytes.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closureOf } from '../src/plugin/closure.js';
import { PluginHost } from '../src/plugin/host.js';
import { closeFileTextSessions, readBlobThroughPlugin } from '../src/plugin/file-reads.js';
import type { FactsOperation } from '../src/plugin-sdk.js';

const roots: string[] = [];
afterAll(async () => { await closeFileTextSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const REPO = join(import.meta.dir, '..');
const IDENTITY = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (root: string, ...args: string[]): string => execFileSync('git', args, { cwd: root, env: { ...process.env, ...IDENTITY }, encoding: 'utf8' });

/** A product with a connected repository and a reader plugin that asks the host for one blob. */
function product(options: { readonly link?: string } = {}): { folder: string; reader: string; blob: string; bytes: number } {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-plugin-file-read-'));
  roots.push(folder);
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: sample\nname: sample\n');
  const gitPlugin = join(folder, 'plugins', 'git');
  cpSync(join(REPO, 'plugins', 'git'), gitPlugin, { recursive: true });
  const repo = join(folder, 'repos', 'sample');
  if (options.link === undefined) {
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repo, 'long.txt'), `${'x'.repeat(400_000)}\n`);
    git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', 'one long line');
  } else {
    // The connected repository is a link to a checkout outside the product: the one guard refuses it.
    mkdirSync(join(folder, 'repos'), { recursive: true });
    symlinkSync(options.link, repo);
  }
  const reader = join(folder, 'plugins', 'reader');
  mkdirSync(reader, { recursive: true });
  const outputs = { vertices: [{ kind: 'probe.read', key: ['id'], fields: [{ name: 'length', type: 'integer', meaning: 'the text length', example: 1, required: true }] }], edges: [] };
  writeFileSync(join(reader, 'plugin.json'), JSON.stringify({ name: 'reader', version: '1.0.0', tier: 'ordinary', capabilities: ['git'], entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'probe.read', fields: '*', reads: [] }] }));
  // The plugin reads its own facts to reconcile them (decision 0039), so its contract declares exactly the graph rights
  // the SDK's introduction repeats beside the file read it asks the host for.
  writeFileSync(join(reader, 'contract.json'), JSON.stringify({ id: 'reader', version: '1.0.0', outputs, rights: { network: 'none', graph: true, graphReads: ['files', 'value', 'ownFacts'] } }));
  writeFileSync(join(reader, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({ name: 'reader', version: '1.0.0', contract: ${JSON.stringify(outputs)}, async extract(unit, context) {
  try {
    const read = await context.read({ repository: 'sample', blob: String(unit.inputs.blob) });
    await context.facts.apply('read', { vertices: [{ kind: 'probe.read', key: { id: 'read' }, values: { length: read.text.length } }], edges: [], removals: [] });
    return { end: { state: 'complete' } };
  } catch (error) {
    return { end: { state: 'partial', cause: String(error && error.message ? error.message : error) } };
  }
} });`);
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFileSync(join(folder, 'madarch', 'plugins.lock'), `plugins:
  - id: git
    version: 1.0.0
    closure: ${closureOf(gitPlugin).hash}
    path: plugins/git
  - id: reader
    version: 1.0.0
    closure: ${closureOf(reader).hash}
    path: plugins/reader
`.replace(/^/, ''));
  const blob = options.link === undefined ? git(repo, 'rev-parse', 'HEAD:long.txt').trim() : 'a'.repeat(40);
  const bytes = options.link === undefined ? 400_001 : 0;
  return { folder, reader, blob, bytes };
}

/** Runs one unit of the reader plugin: the host answers its file read through the one path. */
async function run(fixture: ReturnType<typeof product>): Promise<{ state: string; length?: number; cause?: string }> {
  const operations: FactsOperation[] = [];
  // The host's own environment carries the choice, never the test process's: a leaked variable would run every later
  // plugin of the run unconfined.
  const host = new PluginHost({
    pluginFolder: fixture.reader, repository: fixture.folder, workRoot: mkdtempSync(join(tmpdir(), 'madarch-plugin-file-read-work-')),
    trust: 'production', releaseHashes: [closureOf(fixture.reader).hash],
    operations: { async apply(_unitId, _key, operation) { operations.push(operation as FactsOperation); return { accepted: true }; } },
    env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' },
    // The reader reconciles what it produced before (decision 0039): the host answers the unit's own facts, none here.
    graph: { ownFacts: async () => ({ vertices: [], edges: [] }), files: async () => [], value: async () => null },
  });
  const session = await host.open();
  try {
    const outcome = await session.runUnit({ unitId: 'reader', kind: 'probe.read', key: {}, inputs: { blob: fixture.blob } });
    if (outcome.state !== 'extracted') return { state: 'not-extracted', cause: outcome.cause.message };
    const vertex = operations.flatMap(operation => operation.vertices ?? [])[0];
    return { state: outcome.result.end.state, length: vertex?.values?.['length'] as number | undefined, ...(outcome.result.end.state === 'partial' ? { cause: outcome.result.end.cause } : {}) };
  } finally { await session.close(); }
}

test('a plugin reads a file through the host, and a range past the byte bound is continued rather than cut', async () => {
  const fixture = product();
  const answer = await run(fixture);
  expect(answer.state).toBe('complete');
  // The whole 400 001-character text, though each read the host made was bounded in bytes.
  expect(answer.length).toBe(fixture.bytes);
}, 60_000);

test('an unconfined host reads a blob through its core reader where nothing confines a plugin', async () => {
  const fixture = product();
  const work = mkdtempSync(join(tmpdir(), 'madarch-plugin-file-read-unconfined-'));
  roots.push(work);
  // The child names a cgroup that delegates nothing, so the confined path refuses on every machine: the case proves the
  // read itself runs unconfined, not that the machine can confine a plugin (madarch-64o5.178). The mode is the host's own
  // `unconfined`, and the variable stays as the child found it in its environment, which the read must not change.
  const source = `
    import { closureOf } from ${JSON.stringify(fileURLToPath(new URL('../src/plugin/closure.ts', import.meta.url)))};
    import { PluginHost } from ${JSON.stringify(fileURLToPath(new URL('../src/plugin/host.ts', import.meta.url)))};
    import { closeFileTextSessions } from ${JSON.stringify(fileURLToPath(new URL('../src/plugin/file-reads.js', import.meta.url)))};
    const host = new PluginHost({
      pluginFolder: ${JSON.stringify(fixture.reader)}, repository: ${JSON.stringify(fixture.folder)},
      workRoot: ${JSON.stringify(join(work, 'host'))}, trust: 'production', unconfined: true,
      releaseHashes: [closureOf(${JSON.stringify(fixture.reader)}).hash],
      env: { ...process.env },
      operations: { async apply() { return { accepted: true }; } },
      graph: { ownFacts: async () => ({ vertices: [], edges: [] }), files: async () => [], value: async () => null },
    });
    const session = await host.open();
    let answer = '';
    try {
      const outcome = await session.runUnit({ unitId: 'reader', kind: 'probe.read', key: {}, inputs: { blob: ${JSON.stringify(fixture.blob)} } });
      if (outcome.state !== 'extracted') answer = 'not-extracted ' + outcome.cause.message;
      else answer = outcome.result.end.state === 'complete' ? 'complete' : 'partial ' + String(outcome.result.end.cause);
    } finally { await session.close(); }
    await closeFileTextSessions();
    console.log(answer);
    console.log('process ' + String(process.env.MADARCH_PLUGIN_SANDBOX));
  `;
  // The child starts without a choice of its own, whatever the run that started it holds: a run already set to
  // MADARCH_PLUGIN_SANDBOX=off would make the same answer mean nothing about the host's own `unconfined`.
  const inherited: Record<string, string | undefined> = { ...process.env };
  delete inherited['MADARCH_PLUGIN_SANDBOX'];
  const child = Bun.spawn([process.execPath, '--eval', source], {
    cwd: REPO,
    env: { ...inherited, MADARCH_PLUGIN_CGROUP: join(work, 'no-cgroup') },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stdout.trim().split('\n')).toEqual(['complete', 'process undefined']);
}, 60_000);

test('a reader is opened for the environment of its call, never reused by a call that runs differently', async () => {
  const fixture = product();
  // One repository, one process, two environments: the core plugin finds git through the PATH its host was given, so an
  // empty PATH is refused by name and a full one answers. The second read of the file must not hand the first
  // environment's reader to the third call (madarch-64o5.178).
  const read = { product: fixture.folder, plugin: join('plugins', 'git'), repository: 'sample', root: join(fixture.folder, 'repos', 'sample'), blob: fixture.blob };
  const noGit = { ...process.env, PATH: '' };
  const before = process.env['MADARCH_PLUGIN_SANDBOX'];
  await expect(readBlobThroughPlugin(read, { env: noGit, unconfined: true })).rejects.toThrow('no git executable on PATH');
  const answered = await readBlobThroughPlugin(read, { env: { ...process.env }, unconfined: true });
  expect(answered.text.startsWith('x')).toBe(true);
  await expect(readBlobThroughPlugin(read, { env: noGit, unconfined: true })).rejects.toThrow('no git executable on PATH');
  // The reads answer the settings their call names and never write the process's own.
  expect(process.env['MADARCH_PLUGIN_SANDBOX']).toBe(before);
}, 60_000);

test('the same confinement refuses a repository that links out of the product, naming it', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'madarch-plugin-file-read-outside-'));
  roots.push(outside);
  git(outside, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(outside, 'a.txt'), 'outside\n');
  git(outside, 'add', '-A'); git(outside, 'commit', '--quiet', '-m', 'outside');
  const fixture = product({ link: outside });
  const answer = await run(fixture);
  expect(answer.state).toBe('partial');
  // The one guard of `readBlobThroughPlugin` (realpath, madarch-u3vw.16's review) answers, not a second check in the host.
  expect(answer.cause).toContain('resolves to');
  expect(answer.cause).toContain(outside);
  expect(answer.cause).toContain('a read follows no link out of the product');
  rmSync(outside, { recursive: true, force: true });
}, 60_000);
