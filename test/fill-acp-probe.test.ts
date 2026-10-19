import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ACP_ADAPTERS, acpAdapterBinFolder, acpAgentFolder, acpLoginState, adapterInstallCommand, formatAcpProbe, formatBytes, madarchAgentsFolder, probeAcpAgents, type AcpAdapterCatalogueEntry } from '../src/fill/acp-probe.js';

const scratch: string[] = [];
afterEach(() => { for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function scratchFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-acp-probe-'));
  scratch.push(folder);
  return folder;
}

/**
 * Write an executable fake adapter into `folder` and answer with its path.
 * The program is a shell wrapper around this test process's own runtime, so
 * the fake needs nothing on PATH: a machine of the test's own is a PATH the
 * test holds, and a real adapter on the machine's own PATH must never be what
 * a test connects to.
 */
function program(folder: string, name: string, source: string): string {
  mkdirSync(folder, { recursive: true });
  const script = join(folder, `${name}.program.js`);
  writeFileSync(script, source);
  const file = join(folder, name);
  writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}
const fakeAdapter = program;

const ANSWERING_ADAPTER = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
const record = join(dirname(process.argv[1] ?? '.'), 'record.jsonl');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  appendFileSync(record, line + '\\n');
  const message = JSON.parse(line);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake-claude-agent', version: '9.9.9' }, authMethods: [{ id: 'claude-login' }] } }) + '\\n');
});
`;

const failingAdapter = `#!/usr/bin/env bun
process.stderr.write('fake adapter: no credentials on this machine\\n');
process.exit(3);
`;

/** A machine of the test's own: a home, a madarch home, and an empty PATH. */
function machine(): { home: string; env: NodeJS.ProcessEnv; path: string } {
  const home = scratchFolder();
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  return { home, env: { HOME: home, MADARCH_HOME: join(home, 'madarch') }, path: bin };
}

function entry(overrides: Partial<AcpAdapterCatalogueEntry> = {}): AcpAdapterCatalogueEntry {
  return {
    id: 'claude-code',
    label: 'Claude Code',
    fillAgent: 'claude',
    launches: [{ binary: 'claude-agent-acp', args: [] }],
    install: { kind: 'npm', package: '@agentclientprotocol/claude-agent-acp', version: '0.93.0', unpackedBytes: 1_956_577, installedBytes: 313_672_155, sizeEvidence: 'test catalogue' },
    login: { kind: 'files', paths: ['.claude/.credentials.json'], detail: 'Claude Code keeps its sign-in there.' },
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    evidence: 'test catalogue',
    ...overrides,
  };
}

describe('the ACP probe reports what this machine can connect', () => {
  test('an installed adapter is reported connected after the initialize handshake, with no prompt sent', async () => {
    const machineNow = machine();
    const adapter = fakeAdapter(acpAdapterBinFolder(acpAgentFolder('claude', machineNow.env, machineNow.home)), 'claude-agent-acp', ANSWERING_ADAPTER);
    const report = await probeAcpAgents({ cwd: process.cwd(), path: machineNow.path, home: machineNow.home, env: machineNow.env, adapters: [entry()] });
    expect(report.findings).toHaveLength(1);
    const found = report.findings[0]!;
    expect(found.status).toBe('connected');
    expect(found.protocolVersion).toBe(1);
    expect(found.agentInfo).toEqual({ name: 'fake-claude-agent', version: '9.9.9' });
    expect(found.authMethods).toEqual(['claude-login']);
    expect(found.executable).toBe(adapter);
    // An adapter madarch installed itself is found in madarch's folder first,
    // and the report says so: a reader must know which program ran.
    expect(found.foundIn).toBe('madarch');
    expect(found.fillAgent).toBe('claude');
    expect(found.detail).toContain('answered initialize with protocol version 1');
    expect(found.detail).toContain('no prompt was sent');
    const sent = readFileSync(join(dirname(adapter), 'record.jsonl'), 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { method?: string; params?: { protocolVersion?: number; clientCapabilities?: unknown } });
    expect(sent.map((message) => message.method)).toEqual(['initialize']);
    expect(sent[0]?.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  });

  test('an adapter on the machine PATH is found after madarch\'s own folder, which is searched first', async () => {
    const machineNow = machine();
    const own = fakeAdapter(acpAdapterBinFolder(acpAgentFolder('claude', machineNow.env, machineNow.home)), 'claude-agent-acp', ANSWERING_ADAPTER);
    const onPath = fakeAdapter(machineNow.path, 'claude-agent-acp', ANSWERING_ADAPTER);
    const report = await probeAcpAgents({ cwd: process.cwd(), path: machineNow.path, home: machineNow.home, env: machineNow.env, adapters: [entry()] });
    expect(report.agentsFolder).toBe(join(machineNow.home, 'madarch', 'agents'));
    expect(report.findings[0]?.executable).toBe(own);
    expect(report.findings[0]?.executable).not.toBe(onPath);
    // A machine whose madarch home holds no adapter of its own falls back to PATH.
    const elsewhere = scratchFolder();
    const onlyPath = await probeAcpAgents({ cwd: process.cwd(), path: machineNow.path, home: elsewhere, env: { ...machineNow.env, MADARCH_HOME: join(elsewhere, 'madarch') }, adapters: [entry()] });
    expect(onlyPath.findings[0]?.executable).toBe(onPath);
    expect(onlyPath.findings[0]?.foundIn).toBe('path');
  });

  test('madarch\'s own folder is searched for both of an agent\'s names before PATH is asked at all', async () => {
    const machineNow = machine();
    // The older name sits on PATH, the name madarch pinned sits in its own folder:
    // the answer is the pinned one, not whichever name came first.
    const onPath = fakeAdapter(machineNow.path, 'claude-agent-acp', ANSWERING_ADAPTER);
    const own = fakeAdapter(acpAdapterBinFolder(acpAgentFolder('claude', machineNow.env, machineNow.home)), 'claude-code-acp', ANSWERING_ADAPTER);
    const report = await probeAcpAgents({
      cwd: process.cwd(),
      path: machineNow.path,
      home: machineNow.home,
      env: machineNow.env,
      adapters: [entry({ launches: [{ binary: 'claude-agent-acp', args: [] }, { binary: 'claude-code-acp', args: [] }] })],
    });
    expect(report.findings[0]?.executable).toBe(own);
    expect(report.findings[0]?.foundIn).toBe('madarch');
    expect(report.findings[0]?.executable).not.toBe(onPath);
  });

  test('an agent without an adapter names what is missing, the install into madarch\'s own folder, and the size the install really costs', async () => {
    const machineNow = machine();
    const report = await probeAcpAgents({ cwd: process.cwd(), path: machineNow.path, home: machineNow.home, env: machineNow.env, adapters: [entry()] });
    const found = report.findings[0]!;
    const folder = join(machineNow.home, 'madarch', 'agents', 'claude');
    expect(found.status).toBe('not-installed');
    expect(found.detail).toContain('nothing named claude-agent-acp is executable on PATH');
    // The install is madarch's own prefix, never a global one and never root.
    expect(found.install?.command).toBe(`npm install --prefix ${folder} @agentclientprotocol/claude-agent-acp@0.93.0`);
    expect(found.install?.command).not.toContain('-g');
    expect(found.install).toMatchObject({ kind: 'npm', package: '@agentclientprotocol/claude-agent-acp', version: '0.93.0', folder, byMadarch: true });
    // The package alone is 1.9 MiB; the install with its dependencies is 299 MiB,
    // and the person deciding on the install is told the second figure.
    expect(found.install?.unpackedBytes).toBe(1_956_577);
    expect(found.install?.installedBytes).toBe(313_672_155);
    expect(found.install?.unpackedSize).toBe('1.9 MiB');
    expect(found.install?.installedSize).toBe('299 MiB');
    expect(found.detail).toContain('1.9 MiB unpacked');
    expect(found.detail).toContain('about 299 MiB installed with its dependencies');
    expect(found.executable).toBeUndefined();
  });

  test('a bundled agent names its own program instead of a package, and says madarch cannot install it', async () => {
    const machineNow = machine();
    const report = await probeAcpAgents({
      cwd: process.cwd(),
      path: machineNow.path,
      home: machineNow.home,
      env: machineNow.env,
      adapters: [entry({
        id: 'omp',
        label: 'omp',
        fillAgent: 'omp',
        launches: [{ binary: 'omp', args: ['acp'] }],
        install: { kind: 'bundled', program: 'omp', note: 'install omp from its own project' },
        login: { kind: 'none', detail: 'omp keeps no sign-in madarch knows.' },
        apiKeyEnv: undefined,
      })],
    });
    const found = report.findings[0]!;
    expect(found.detail).toContain('To get it: install omp from its own project');
    expect(found.install).toMatchObject({ kind: 'bundled', byMadarch: false });
    expect(found.install?.reason).toContain('carries ACP in its own program');
  });

  test('an adapter that cannot connect is reported failed, naming the program and the reason', async () => {
    const machineNow = machine();
    const adapter = fakeAdapter(acpAdapterBinFolder(acpAgentFolder('claude', machineNow.env, machineNow.home)), 'claude-agent-acp', failingAdapter);
    const report = await probeAcpAgents({ cwd: process.cwd(), path: machineNow.path, home: machineNow.home, env: machineNow.env, adapters: [entry()] });
    const found = report.findings[0]!;
    expect(found.status).toBe('failed');
    expect(found.executable).toBe(adapter);
    expect(found.detail).toContain(`has an ACP adapter at ${adapter} but it did not connect`);
  });

  test('the second name of an adapter is tried when the first is absent', async () => {
    const machineNow = machine();
    fakeAdapter(acpAdapterBinFolder(acpAgentFolder('claude', machineNow.env, machineNow.home)), 'claude-code-acp', ANSWERING_ADAPTER);
    const report = await probeAcpAgents({
      cwd: process.cwd(),
      path: machineNow.path,
      home: machineNow.home,
      env: machineNow.env,
      adapters: [entry({ launches: [{ binary: 'claude-agent-acp', args: [] }, { binary: 'claude-code-acp', args: [] }] })],
    });
    expect(report.findings[0]?.status).toBe('connected');
    expect(report.findings[0]?.executable).toBe(join(acpAdapterBinFolder(acpAgentFolder('claude', machineNow.env, machineNow.home)), 'claude-code-acp'));
  });

  test('the report names the PATH and madarch\'s folder it searched, and prints one block per agent with its sign-in', async () => {
    const machineNow = machine();
    const report = await probeAcpAgents({ cwd: process.cwd(), path: machineNow.path, home: machineNow.home, env: machineNow.env, adapters: [entry(), entry({ id: 'codex', label: 'Codex', fillAgent: 'codex', launches: [{ binary: 'codex-acp', args: [] }] })] });
    expect(report.path).toBe(machineNow.path);
    expect(report.findings.map((finding) => finding.id)).toEqual(['claude-code', 'codex']);
    const text = formatAcpProbe(report);
    expect(text).toContain(`Agents that connect over ACP on this machine (PATH ${JSON.stringify(machineNow.path)}, madarch's own folder ${join(machineNow.home, 'madarch', 'agents')}`);
    expect(text).toContain('– Claude Code — not installed');
    expect(text).toContain('– Codex — not installed');
    expect(text).toContain('Sign-in: not signed in');
    expect(text).toContain('Install: npm install --prefix');
    // The report names where each claim comes from, not only what it found.
    expect(text).toContain('Evidence: test catalogue');
    expect(text).toContain('The probe sent no prompt: it stopped at the initialize handshake. It installed nothing.');
  });
});

describe('whether an agent is signed in, as its own sign-in store tells it', () => {
  test('a sign-in file that is there is signed in, and one that is not is not, named by its path', () => {
    const machineNow = machine();
    const absent = acpLoginState(entry(), machineNow.home);
    expect(absent.state).toBe('not-signed-in');
    expect(absent.detail).toContain(join(machineNow.home, '.claude', '.credentials.json'));
    expect(absent.detail).toContain('madarch never asks for the person\'s agent credentials');
    mkdirSync(join(machineNow.home, '.claude'), { recursive: true });
    writeFileSync(join(machineNow.home, '.claude', '.credentials.json'), '{}');
    const present = acpLoginState(entry(), machineNow.home);
    expect(present.state).toBe('signed-in');
    expect(present.detail).toContain(join(machineNow.home, '.claude', '.credentials.json'));
  });

  test('an agent with no sign-in store madarch knows answers unknown rather than a guess', () => {
    const state = acpLoginState(entry({ login: { kind: 'none', detail: 'pi keeps no sign-in madarch knows.' } }), scratchFolder());
    expect(state.state).toBe('unknown');
    expect(state.detail).toBe('pi keeps no sign-in madarch knows.');
  });
});

describe('where madarch installs its agents', () => {
  test('the agents folder sits under the madarch home the environment names, never above it', () => {
    expect(madarchAgentsFolder({ HOME: '/srv/one', MADARCH_HOME: '/srv/one/madarch' }, '/srv/one')).toBe('/srv/one/madarch/agents');
    expect(madarchAgentsFolder({ HOME: '/srv/one' }, '/srv/one')).toBe('/srv/one/madarch/agents');
    expect(acpAgentFolder('codex', { HOME: '/srv/one', MADARCH_HOME: '/opt/madarch' }, '/srv/one')).toBe('/opt/madarch/agents/codex');
  });

  test('the command a person reads installs one pinned version into that folder', () => {
    const claude = ACP_ADAPTERS.find((adapter) => adapter.id === 'claude-code')!;
    expect(adapterInstallCommand(claude, '/opt/madarch/agents/claude-code')).toBe('npm install --prefix /opt/madarch/agents/claude-code @agentclientprotocol/claude-agent-acp@0.93.0');
    const omp = ACP_ADAPTERS.find((adapter) => adapter.id === 'omp')!;
    expect(adapterInstallCommand(omp, '/opt/madarch/agents/omp')).toBe('install omp from its own project — it carries ACP itself, with no adapter package');
  });

  test('a folder the environment gave a space is quoted, so the shell hands npm one --prefix', () => {
    const claude = ACP_ADAPTERS.find((adapter) => adapter.id === 'claude-code')!;
    const folder = acpAgentFolder('claude', { HOME: '/srv/my home', MADARCH_HOME: '/srv/my home/madarch' }, '/srv/my home');
    const command = adapterInstallCommand(claude, folder);
    expect(command).toBe(`npm install --prefix '${folder}' @agentclientprotocol/claude-agent-acp@0.93.0`);
    const words = execFileSync('bash', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], { encoding: 'utf8' }).trim().split('\n');
    expect(words).toEqual(['npm', 'install', '--prefix', folder, '@agentclientprotocol/claude-agent-acp@0.93.0']);
  });

  test('a folder holding a quote is quoted so the shell reads it whole', () => {
    const claude = ACP_ADAPTERS.find((adapter) => adapter.id === 'claude-code')!;
    const folder = "/srv/o'brien/agents/claude";
    const command = adapterInstallCommand(claude, folder);
    const words = execFileSync('bash', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], { encoding: 'utf8' }).trim().split('\n');
    expect(words).toEqual(['npm', 'install', '--prefix', folder, '@agentclientprotocol/claude-agent-acp@0.93.0']);
  });
});

describe('`madarch fill --probe-acp`', () => {
  test('refuses to probe beside the fill options, naming them', () => {
    const cli = join(import.meta.dir, '..', 'scripts', 'madarch.ts');
    const run = Bun.spawnSync([process.execPath, cli, 'fill', '--probe-acp', '--agent', 'omp'], { cwd: join(import.meta.dir, '..') });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain('--probe-acp reports the agents on this machine and fills nothing: drop --agent');
  });

  test('--json prints one object whose findings are the catalogue\'s, and holds still on a PATH without adapters', () => {
    const cli = join(import.meta.dir, '..', 'scripts', 'madarch.ts');
    const empty = scratchFolder();
    const home = join(empty, 'home');
    mkdirSync(home, { recursive: true });
    const run = Bun.spawnSync([process.execPath, cli, 'fill', '--probe-acp', '--json'], { cwd: join(import.meta.dir, '..'), env: { ...process.env, PATH: empty, HOME: home, MADARCH_HOME: join(empty, 'madarch') } });
    expect(run.exitCode).toBe(0);
    const report = JSON.parse(run.stdout.toString()) as { path: string; agentsFolder: string; findings: { id: string; status: string; evidence: string; login: { state: string } }[] };
    expect(report.path).toBe(empty);
    expect(report.agentsFolder).toBe(join(empty, 'madarch', 'agents'));
    expect(report.findings.map((finding) => finding.id)).toEqual(ACP_ADAPTERS.map((adapter) => adapter.id));
    expect(report.findings.every((finding) => finding.status === 'not-installed')).toBe(true);
    expect(report.findings.every((finding) => finding.evidence.length > 20)).toBe(true);
    // The sign-in state follows the home given, never this machine's own.
    const signIn = report.findings.map((finding) => finding.login.state);
    expect(signIn.every((state) => state === 'not-signed-in' || state === 'unknown')).toBe(true);
  });

  test('its help names the flag', () => {
    const cli = join(import.meta.dir, '..', 'scripts', 'madarch.ts');
    const run = Bun.spawnSync([process.execPath, cli, 'fill', '--help'], { cwd: join(import.meta.dir, '..') });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain('--probe-acp');
  });
});

describe('the catalogue names the documented adapters', () => {
  test('every agent the fill considers is listed once, with its launch command, its install and its sign-in', () => {
    expect(ACP_ADAPTERS.map((adapter) => adapter.id)).toEqual(['claude-code', 'codex', 'omp', 'pi']);
    const byId = new Map(ACP_ADAPTERS.map((adapter) => [adapter.id, adapter]));
    expect(byId.get('claude-code')?.install).toMatchObject({ kind: 'npm', package: '@agentclientprotocol/claude-agent-acp', version: '0.93.0', unpackedBytes: 1_956_577, installedBytes: 313_672_155 });
    expect(byId.get('claude-code')?.launches.map((launch) => launch.binary)).toEqual(['claude-agent-acp', 'claude-code-acp']);
    expect(byId.get('claude-code')?.fillAgent).toBe('claude');
    expect(byId.get('claude-code')?.login).toMatchObject({ kind: 'files', paths: ['.claude/.credentials.json'] });
    expect(byId.get('claude-code')?.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
    expect(byId.get('codex')?.install).toMatchObject({ kind: 'npm', package: '@agentclientprotocol/codex-acp', version: '2.2.2', unpackedBytes: 1_748_544, installedBytes: 461_758_222 });
    expect(byId.get('codex')?.launches.map((launch) => launch.binary)).toEqual(['codex-acp', 'codex-acp.js']);
    expect(byId.get('codex')?.login).toMatchObject({ kind: 'files', paths: ['.codex/auth.json'] });
    expect(byId.get('codex')?.apiKeyEnv).toBe('OPENAI_API_KEY');
    expect(byId.get('omp')?.launches).toEqual([{ binary: 'omp', args: ['acp'] }]);
    expect(byId.get('omp')?.install).toMatchObject({ kind: 'bundled' });
    expect(byId.get('pi')?.install).toMatchObject({ kind: 'npm', package: 'pi-acp', version: '0.0.34' });
    // pi is not a fill agent yet, so the wizard offers no choice for it.
    expect(byId.get('pi')?.fillAgent).toBeUndefined();
    for (const adapter of ACP_ADAPTERS) expect(adapter.evidence.length).toBeGreaterThan(20);
  });

  test('the two sizes the registry figure hides are measured and their evidence named', () => {
    const claude = ACP_ADAPTERS.find((adapter) => adapter.id === 'claude-code')!;
    const codex = ACP_ADAPTERS.find((adapter) => adapter.id === 'codex')!;
    if (claude.install.kind !== 'npm' || codex.install.kind !== 'npm') throw new Error('both adapters are npm packages');
    // Measured on 2026-10-19, madarch-tzte.22.4: the install is the package plus
    // its dependencies, about 160x and 264x the package's own unpacked size.
    expect(claude.install.installedBytes! / claude.install.unpackedBytes).toBeGreaterThan(150);
    expect(codex.install.installedBytes! / codex.install.unpackedBytes).toBeGreaterThan(250);
    expect(claude.install.sizeEvidence).toContain('du -sb');
    expect(codex.install.sizeEvidence).toContain('du -sb');
  });

  test('a byte count reads in the unit a person expects', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(332_266)).toBe('324 KiB');
    expect(formatBytes(1_748_544)).toBe('1.7 MiB');
    expect(formatBytes(1_956_577)).toBe('1.9 MiB');
    expect(formatBytes(313_672_155)).toBe('299 MiB');
    expect(formatBytes(461_758_222)).toBe('440 MiB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MiB');
  });
});
