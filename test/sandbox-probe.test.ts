import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('the delegated scope command is a child scope with its own controllers and pid file', () => {
  const scope = delegatedScopeCommand('madarch', ['daemon-serve', '--home', '/tmp/home'], '/tmp/madarch.pid', 'madarch-daemon-1');
  expect(scope.command).toBe('systemd-run');
  expect(scope.args).toContain('--scope');
  expect(scope.args).toContain('Delegate=yes');
  expect(scope.args).toContain('/tmp/madarch.pid');
  expect(scope.args.slice(-4)).toEqual(['madarch', 'daemon-serve', '--home', '/tmp/home']);
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
