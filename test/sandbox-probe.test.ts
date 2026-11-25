import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillIsolation, probePluginSandbox } from '../src/plugin/sandbox-probe.js';
import { delegatedScopeCommand } from '../src/plugin/sandbox-delegation.js';
import { isolationFromAnswer } from '../src/product/cli.js';
import { readPluginsUnconfined, readSettings, writePluginsUnconfined, writeRole } from '../src/knowledge/settings.js';

test('a machine with no delegated cgroup reaches the isolation choice in plain words', async () => {
  const probe = await probePluginSandbox({ fresh: true, cgroupParent: join(tmpdir(), 'madarch-no-cgroup') });
  expect(probe.state).toBe('unavailable');
  expect(probe.reason.length).toBeGreaterThan(0);
  expect(probe.reason).not.toContain('MADARCH_PLUGIN_SANDBOX');
  expect(probe.reason).not.toMatch(/systemd-run|--scope|bwrap/u);
});

// ALX-1703 minor 1: the wrapper is written beside the pid file before anything is spawned, so a write that fails is a
// start that did not happen, and a home keeps no `.madarch-daemon-scope.sh.<pid>` of it.
test('a scope wrapper that cannot be replaced takes its own partial file with it', () => {
  const home = mkdtempSync(join(tmpdir(), 'madarch-scope-'));
  try {
    const pidFile = join(home, '.madarch-daemon-pid-1');
    // A rename onto a folder fails after the partial file stands, which is the moment the cleanup exists for.
    mkdirSync(join(home, '.madarch-daemon-scope.sh'));
    expect(() => delegatedScopeCommand('madarch', ['daemon-serve'], pidFile, 'madarch-daemon-1')).toThrow();
    expect(readdirSync(home)).toEqual(['.madarch-daemon-scope.sh']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the delegated scope command is a child scope with its own controllers and pid file', () => {
  const home = mkdtempSync(join(tmpdir(), 'madarch-scope-'));
  try {
    const pidFile = join(home, 'daemon.pid');
    const scope = delegatedScopeCommand('madarch', ['daemon-serve', '--home', home], pidFile, 'madarch-daemon-1');
    expect(scope.command).toBe('systemd-run');
    expect(scope.args).toContain('--scope');
    expect(scope.args).toContain('Delegate=yes');
    expect(scope.args).toContain(pidFile);
    expect(scope.args.slice(-4)).toEqual(['madarch', 'daemon-serve', '--home', home]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// madarch-4ag1: systemd-run expands the words it is given — on systemd 262 `--expand-environment` is on by default even
// for `--scope`, so a `$$` in an argument arrives at the shell as `$` and the pid receipt held `$` instead of the pid.
test('the delegated scope hands systemd-run no word that its expansion rewrites', () => {
  const home = mkdtempSync(join(tmpdir(), 'madarch-scope-'));
  try {
    const pidFile = join(home, 'daemon.pid');
    const scope = delegatedScopeCommand(process.execPath, ['-e', 'console.log(1)'], pidFile, 'madarch-daemon-1');
    const commandAt = scope.args.indexOf(process.execPath);
    expect(commandAt).toBeGreaterThan(0);
    for (const word of [scope.command, ...scope.args.slice(0, commandAt)]) {
      expect(word).not.toContain('$');
      expect(word).not.toContain('%');
    }
    expect(scope.args).toContain(pidFile);
    expect(scope.args.slice(-3)).toEqual([process.execPath, '-e', 'console.log(1)']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test.skipIf(!existsSync('/bin/sh'))('the delegated scope writes the scoped process\'s own pid and becomes the target whole', () => {
  const home = mkdtempSync(join(tmpdir(), 'madarch-receipt-'));
  try {
    const pidFile = join(home, 'daemon.pid');
    const said = ['a b', '"quoted"', 'кириллица', 'tab\there'];
    const program = 'console.log(JSON.stringify({ pid: process.pid, argv: process.argv.slice(1) }))';
    const scope = delegatedScopeCommand(process.execPath, ['-e', program, ...said], pidFile, 'madarch-daemon-1');
    const inner = scope.args.slice(scope.args.indexOf('--') + 1);
    const ran = spawnSync(inner[0]!, inner.slice(1), { encoding: 'utf8' });
    expect(ran.status).toBe(0);
    const held = readFileSync(pidFile, 'utf8');
    expect(held).toMatch(/^[0-9]+\n?$/);
    const receipt = Number(held.trim());
    expect(receipt).toBeGreaterThan(0);
    expect(receipt).not.toBe(process.pid);
    const answer = JSON.parse(ran.stdout) as { pid: number; argv: string[] };
    expect(answer.pid).toBe(receipt);
    expect(answer.argv).toEqual(said);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the machine setting is remembered in settings.json beside the reader role, without another file', () => {
  const home = mkdtempSync(join(tmpdir(), 'madarch-isolation-'));
  try {
    const env = { MADARCH_HOME: home, HOME: home };
    expect(readPluginsUnconfined(env)).toBeUndefined();
    writePluginsUnconfined(env, true);
    expect(readPluginsUnconfined(env)).toBe(true);
    expect(readSettings(env, ['everything']).pluginsUnconfined).toBe(true);
    writeRole(env, 'everything', ['everything']);
    expect(readPluginsUnconfined(env)).toBe(true);
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toMatchObject({ role: 'everything', pluginsUnconfined: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a fill without an isolation answer refuses in plain words, and the operator override runs unconfined', async () => {
  const home = mkdtempSync(join(tmpdir(), 'madarch-fill-isolation-'));
  try {
    const env = { MADARCH_HOME: home, HOME: home, MADARCH_PLUGIN_CGROUP: join(home, 'missing-cgroup') };
    let refusal = '';
    try { await fillIsolation(env); } catch (error) { refusal = (error as Error).message; }
    expect(refusal).toContain('preparation page');
    expect(refusal).not.toContain('MADARCH_PLUGIN_SANDBOX');
    await expect(fillIsolation({ ...env, MADARCH_PLUGIN_SANDBOX: 'off' })).resolves.toEqual({ unconfined: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('no interface string names the operator override', () => {
  for (const language of ['en', 'ru']) {
    const text = readFileSync(join(import.meta.dir, '..', 'wiki/app/src/locales', `${language}.json`), 'utf8');
    expect(text).not.toContain('MADARCH_PLUGIN_SANDBOX');
  }
});

test('the terminal answer names yes in either language and no by default', () => {
  expect(isolationFromAnswer('1')).toBe(true);
  expect(isolationFromAnswer('да')).toBe(true);
  expect(isolationFromAnswer('yes')).toBe(true);
  expect(isolationFromAnswer('2')).toBe(false);
  expect(isolationFromAnswer('')).toBe(false);
});
