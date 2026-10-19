import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acpAdapterBinFolder, acpAgentFolder, probeAcpAgents, type AcpAdapterCatalogueEntry } from '../src/fill/acp-probe.js';
import { installAcpAdapter } from '../src/fill/acp-install.js';

const scratch: string[] = [];
afterEach(() => { for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function scratchFolder(prefix = 'madarch-acp-install-'): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(folder);
  return folder;
}

/** The adapter a fake registry serves: it answers `initialize` and writes down what it was sent. */
const ADAPTER_PROGRAM = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
const record = process.env.FAKE_ADAPTER_RECORD ?? join(dirname(process.argv[1] ?? '.'), 'record.jsonl');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  appendFileSync(record, JSON.stringify({ method: message.method ?? null }) + '\\n');
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake-claude-agent', version: '0.93.0' }, authMethods: [] } }) + '\\n');
});
`;

const FAKE_NPM = `import { appendFileSync, chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const fail = (message) => { process.stderr.write('fake npm: ' + message + '\\n'); process.exit(1); };
if (process.env.FAKE_NPM_RECORD) appendFileSync(process.env.FAKE_NPM_RECORD, JSON.stringify(args) + '\\n');
if (args.includes('-g') || args.includes('--global')) fail('a global install is refused: madarch never installs globally');
if (args[0] !== 'install') fail('the first word must be install, not ' + JSON.stringify(args[0]));
const value = (flag) => { const at = args.indexOf(flag); return at === -1 ? undefined : args[at + 1]; };
const prefix = value('--prefix');
if (!prefix) fail('no --prefix: madarch installs into its own folder, never a global one');
const registry = value('--registry');
if (registry !== process.env.FAKE_REGISTRY) fail('unknown registry ' + JSON.stringify(registry) + ': this fake serves ' + JSON.stringify(process.env.FAKE_REGISTRY));
const spec = args[args.length - 1];
const at = spec.lastIndexOf('@');
const name = spec.slice(0, at); const version = spec.slice(at + 1);
const source = join(process.env.FAKE_REGISTRY.slice('file://'.length), name);
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
if (manifest.version !== version) fail('no version ' + version + ' of ' + name + ': the fake registry serves ' + manifest.version);
if (process.env.FAKE_NPM_FAIL === '1') fail('the network is down in this test');
if (process.env.FAKE_NPM_SECRET === '1') fail('401 Unauthorized for //registry.npmjs.org/:_authToken=secret-value from https://user:hunter2@registry.example/npm');
if (process.env.FAKE_NPM_SLEEP === '1') { await new Promise((step) => setTimeout(step, 3000)); }
if (process.env.FAKE_NPM_IGNORE_TERM === '1') { process.on('SIGTERM', () => undefined); process.stderr.write('partial work written before the stop\\n'); await new Promise((step) => setTimeout(step, 4000)); }
const target = join(prefix, 'node_modules', ...name.split('/'));
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
const written = process.env.FAKE_NPM_WRITE_VERSION;
if (written) writeFileSync(join(target, 'package.json'), JSON.stringify({ ...manifest, version: written }));
const bin = join(prefix, 'node_modules', '.bin');
mkdirSync(bin, { recursive: true });
const bins = process.env.FAKE_NPM_NO_BIN === '1' ? {} : (manifest.bin ?? {});
for (const [name, file] of Object.entries(bins)) {
  chmodSync(join(target, file), 0o755);
  const shim = join(bin, name);
  writeFileSync(shim, '#!/bin/sh\\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(join(target, file)) + ' "$@"\\n');
  chmodSync(shim, 0o755);
}
process.stdout.write('added 133 packages in 1m\\n');
`;

/**
 * A machine of the test's own: a fake npm on a PATH of its own, a fake
 * registry serving one fake adapter package, and a home with no agents yet.
 */
function machine(packageName = '@agentclientprotocol/claude-agent-acp', version = '0.93.0', binary = 'claude-agent-acp'): {
  home: string; env: NodeJS.ProcessEnv; registry: string; npmRecord: string; path: string;
} {
  const home = scratchFolder();
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  // The fake npm is a shell wrapper around this test process's own runtime:
  // the machine's PATH is a folder this test holds, so a real npm can never
  // run and nothing reaches the network.
  writeFileSync(join(bin, 'npm.program.js'), FAKE_NPM);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(bin, 'npm.program.js'))} "$@"\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  const registry = join(home, 'registry');
  const packageFolder = join(registry, ...packageName.split('/'));
  mkdirSync(join(packageFolder, 'dist'), { recursive: true });
  writeFileSync(join(packageFolder, 'package.json'), JSON.stringify({ name: packageName, version, bin: { [binary]: 'dist/index.js' } }));
  writeFileSync(join(packageFolder, 'dist', 'index.js'), ADAPTER_PROGRAM);
  chmodSync(join(packageFolder, 'dist', 'index.js'), 0o755);
  const npmRecord = join(home, 'npm-args.jsonl');
  return {
    home,
    registry,
    npmRecord,
    path: bin,
    env: { HOME: home, MADARCH_HOME: join(home, 'madarch'), PATH: bin, FAKE_REGISTRY: `file://${registry}`, FAKE_NPM_RECORD: npmRecord },
  };
}

function entry(overrides: Partial<AcpAdapterCatalogueEntry> = {}): AcpAdapterCatalogueEntry {
  return {
    id: 'claude-code',
    label: 'Claude Code',
    fillAgent: 'claude',
    launches: [{ binary: 'claude-agent-acp', args: [] }],
    install: { kind: 'npm', package: '@agentclientprotocol/claude-agent-acp', version: '0.93.0', unpackedBytes: 1_956_577, installedBytes: 313_672_155, sizeEvidence: 'test catalogue' },
    login: { kind: 'files', paths: ['.claude/.credentials.json'], detail: 'test sign-in store' },
    evidence: 'test catalogue',
    ...overrides,
  };
}

describe('installing an ACP adapter into madarch\'s own folder', () => {
  test('on a yes it fetches the pinned package into madarch\'s folder, and the probe then finds it', async () => {
    const machineNow = machine();
    const installed = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 1000 });
    const folder = join(machineNow.home, 'madarch', 'agents', 'claude');
    expect(installed.outcome).toBe('installed');
    if (installed.outcome !== 'installed') throw new Error('installed expected');
    // madarch's own folder under MADARCH_HOME, the pinned version on disk, and
    // the program in the folder the probe searches.
    expect(installed.folder).toBe(folder);
    expect(installed.command).toBe(`npm install --prefix ${folder} @agentclientprotocol/claude-agent-acp@0.93.0`);
    expect(installed.executable).toBe(join(acpAdapterBinFolder(folder), 'claude-agent-acp'));
    expect(existsSync(join(folder, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'package.json'))).toBe(true);
    // The install ran with the machine's own registry, into the prefix madarch
    // chose, and never as a global one.
    const called = readFileSync(machineNow.npmRecord, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
    expect(called).toHaveLength(1);
    expect(called[0]).toContain('--prefix');
    expect(called[0]).toContain(folder);
    expect(called[0]).toContain('@agentclientprotocol/claude-agent-acp@0.93.0');
    expect(called[0]).not.toContain('-g');
    expect(called[0]).not.toContain('--global');
    // And the probe, on the same machine, now connects to it.
    const report = await probeAcpAgents({ cwd: process.cwd(), path: machineNow.path, home: machineNow.home, env: machineNow.env, adapters: [entry()] });
    expect(report.findings[0]?.status).toBe('connected');
    expect(report.findings[0]?.foundIn).toBe('madarch');
    expect(report.findings[0]?.executable).toBe(installed.executable);
    expect(report.findings[0]?.agentInfo).toEqual({ name: 'fake-claude-agent', version: '0.93.0' });
  });

  test('as root it refuses before anything runs, naming the person who should run it', async () => {
    const machineNow = machine();
    const refused = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 0 });
    expect(refused.outcome).toBe('refused');
    if (refused.outcome !== 'refused') throw new Error('refused expected');
    expect(refused.message).toContain('does not install an agent adapter as root');
    expect(refused.message).toContain(join(machineNow.home, 'madarch', 'agents', 'claude'));
    expect(refused.message).toContain('npm install --prefix');
    // Nothing ran and nothing was written.
    expect(existsSync(machineNow.npmRecord)).toBe(false);
    expect(existsSync(join(machineNow.home, 'madarch'))).toBe(false);
  });

  test('without npm it refuses, and says how to install the adapter by hand', async () => {
    const machineNow = machine();
    const refused = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, npm: 'npm-that-is-not-here', uid: 1000 });
    expect(refused.outcome).toBe('refused');
    if (refused.outcome !== 'refused') throw new Error('refused expected');
    expect(refused.message).toContain('no program named "npm-that-is-not-here" is executable on PATH');
    expect(refused.message).toContain(`npm install --prefix ${join(machineNow.home, 'madarch', 'agents', 'claude')} @agentclientprotocol/claude-agent-acp@0.93.0`);
  });

  test('an agent that carries ACP itself has no package to install, and its own way is named', async () => {
    const machineNow = machine();
    const refused = await installAcpAdapter(entry({
      id: 'omp',
      label: 'omp',
      launches: [{ binary: 'omp', args: ['acp'] }],
      install: { kind: 'bundled', program: 'omp', note: 'install omp from its own project' },
      login: { kind: 'none', detail: 'no sign-in' },
    }), { env: machineNow.env, home: machineNow.home, uid: 1000 });
    expect(refused.outcome).toBe('refused');
    if (refused.outcome !== 'refused') throw new Error('refused expected');
    expect(refused.message).toContain('madarch has no package to install for omp: install omp from its own project');
    expect(existsSync(machineNow.npmRecord)).toBe(false);
  });

  test('an installer that fails is a failure naming the folder, the package, the version and the end of what npm said', async () => {
    const machineNow = machine();
    machineNow.env.FAKE_NPM_FAIL = '1';
    const failed = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 1000 });
    expect(failed.outcome).toBe('failed');
    if (failed.outcome !== 'failed') throw new Error('failed expected');
    // The failure names the installer by its full path, the folder, the package and the version.
    expect(failed.message).toContain(join(machineNow.home, 'bin', 'npm'));
    expect(failed.message).toContain(`install of @agentclientprotocol/claude-agent-acp 0.93.0 into ${join(machineNow.home, 'madarch', 'agents', 'claude')} exited with 1`);
    expect(failed.message).toContain('the network is down in this test');
  });

  test('an installer that unpacks another version than the pinned one is a failure, not a success', async () => {
    const machineNow = machine();
    machineNow.env.FAKE_NPM_WRITE_VERSION = '0.92.0';
    const failed = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 1000 });
    expect(failed.outcome).toBe('failed');
    if (failed.outcome !== 'failed') throw new Error('failed expected');
    expect(failed.message).toContain('names version 0.92.0, not the pinned 0.93.0');
  });

  test('a failed install leaves nothing behind that the probe would report as installed', async () => {
    // The version on disk is not the pinned one: the failure must not leave a
    // tree the next probe would report as a connected adapter madarch refused.
    const machineNow = machine();
    machineNow.env.FAKE_NPM_WRITE_VERSION = '0.92.0';
    const failed = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 1000 });
    expect(failed.outcome).toBe('failed');
    const folder = join(machineNow.home, 'madarch', 'agents', 'claude');
    expect(existsSync(folder)).toBe(false);
    const afterVersion = await probeAcpAgents({ cwd: process.cwd(), path: machineNow.path, home: machineNow.home, env: machineNow.env, adapters: [entry()] });
    expect(afterVersion.findings[0]?.status).toBe('not-installed');
    // The same for an installer that exits non-zero after a partial tree.
    const other = machine();
    other.env.FAKE_NPM_FAIL = '1';
    expect((await installAcpAdapter(entry(), { env: other.env, home: other.home, registry: other.env.FAKE_REGISTRY!, uid: 1000 })).outcome).toBe('failed');
    expect(existsSync(join(other.home, 'madarch', 'agents', 'claude'))).toBe(false);
    const afterFailure = await probeAcpAgents({ cwd: process.cwd(), path: other.path, home: other.home, env: other.env, adapters: [entry()] });
    expect(afterFailure.findings[0]?.status).toBe('not-installed');
  });

  test('a refused and a failed install both name the file and the function the refusal comes from', async () => {
    const machineNow = machine();
    machineNow.env.FAKE_NPM_FAIL = '1';
    const failed = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 1000 });
    expect(failed.outcome === 'failed' && failed.message.startsWith('src/fill/acp-install.ts:installAcpAdapter: ')).toBe(true);
    const refused = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, uid: 0 });
    expect(refused.outcome === 'refused' && refused.message.startsWith('src/fill/acp-install.ts:installAcpAdapter: ')).toBe(true);
  });

  test('npm\'s own words never carry a registry credential into what madarch shows or logs', async () => {
    const machineNow = machine();
    machineNow.env.FAKE_NPM_SECRET = '1';
    const failed = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 1000 });
    expect(failed.outcome).toBe('failed');
    if (failed.outcome !== 'failed') throw new Error('failed expected');
    // The token and the password in the URL are masked; the diagnosis stays.
    expect(failed.message).not.toContain('secret-value');
    expect(failed.message).not.toContain('hunter2');
    expect(failed.message).toContain('401 Unauthorized');
    expect(failed.message).toContain('_authToken=***');
    expect(failed.message).toContain('***@registry.example');
  });

  test('a package with no program in it is a failure naming the folder the program was expected in', async () => {
    const machineNow = machine();
    machineNow.env.FAKE_NPM_NO_BIN = '1';
    const failed = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 1000 });
    expect(failed.outcome).toBe('failed');
    if (failed.outcome !== 'failed') throw new Error('failed expected');
    expect(failed.message).toContain(`no program named claude-agent-acp is executable in ${acpAdapterBinFolder(join(machineNow.home, 'madarch', 'agents', 'claude'))}`);
  });

  test('an installer that does not finish in its bound is stopped and said so', async () => {
    const machineNow = machine();
    machineNow.env.FAKE_NPM_SLEEP = '1';
    const started = Date.now();
    const failed = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 1000, timeoutMs: 400 });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(failed.outcome).toBe('failed');
    if (failed.outcome !== 'failed') throw new Error('failed expected');
    expect(failed.message).toContain(join(machineNow.home, 'bin', 'npm'));
    expect(failed.message).toContain('did not finish installing @agentclientprotocol/claude-agent-acp 0.93.0');
    expect(failed.message).toContain('within 400 ms and was stopped');
  });

  test('a failed install keeps the adapter a person already had, and says which version stands', async () => {
    const machineNow = machine();
    // A working adapter of another version in madarch's own folder: a failed
    // install must not destroy it.
    const folder = join(machineNow.home, 'madarch', 'agents', 'claude');
    mkdirSync(join(folder, 'node_modules', '@agentclientprotocol', 'claude-agent-acp'), { recursive: true });
    writeFileSync(join(folder, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'package.json'), JSON.stringify({ name: '@agentclientprotocol/claude-agent-acp', version: '0.94.0', bin: { 'claude-agent-acp': 'dist/index.js' } }));
    mkdirSync(acpAdapterBinFolder(folder), { recursive: true });
    writeFileSync(join(acpAdapterBinFolder(folder), 'claude-agent-acp'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    machineNow.env.FAKE_NPM_FAIL = '1';
    const failed = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 1000 });
    expect(failed.outcome).toBe('failed');
    if (failed.outcome !== 'failed') throw new Error('failed expected');
    expect(existsSync(join(folder, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'package.json'))).toBe(true);
    expect(failed.message).toContain(`The tree in ${folder} was left as it was: it holds @agentclientprotocol/claude-agent-acp 0.94.0, not the pinned 0.93.0.`);
  });

  test('a stopped install ends its process group before the tree is removed, and keeps the last thing it said', async () => {
    const machineNow = machine();
    machineNow.env.FAKE_NPM_IGNORE_TERM = '1';
    const started = Date.now();
    const failed = await installAcpAdapter(entry(), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 1000, timeoutMs: 400 });
    expect(failed.outcome).toBe('failed');
    if (failed.outcome !== 'failed') throw new Error('failed expected');
    // SIGTERM is ignored by this installer, SIGKILL ends it two seconds later;
    // the folder is removed only once the group is gone, and what it wrote
    // before the stop is in the failure.
    expect(Date.now() - started).toBeGreaterThan(2_000);
    expect(failed.message).toContain('within 400 ms and was stopped');
    expect(failed.message).toContain('partial work written before the stop');
    expect(existsSync(join(machineNow.home, 'madarch', 'agents', 'claude'))).toBe(false);
  });

  test('a second agent of its own gets a folder of its own', async () => {
    const machineNow = machine('@agentclientprotocol/codex-acp', '2.2.2', 'codex-acp');
    const installed = await installAcpAdapter(entry({ id: 'codex', label: 'Codex', fillAgent: 'codex', launches: [{ binary: 'codex-acp', args: [] }], install: { kind: 'npm', package: '@agentclientprotocol/codex-acp', version: '2.2.2', unpackedBytes: 1_748_544, installedBytes: 461_758_222, sizeEvidence: 'test catalogue' } }), { env: machineNow.env, home: machineNow.home, registry: machineNow.env.FAKE_REGISTRY!, uid: 1000 });
    expect(installed.outcome).toBe('installed');
    if (installed.outcome !== 'installed') throw new Error('installed expected');
    expect(installed.folder).toBe(acpAgentFolder('codex', machineNow.env, machineNow.home));
    expect(installed.folder).not.toBe(acpAgentFolder('claude', machineNow.env, machineNow.home));
  });
});
