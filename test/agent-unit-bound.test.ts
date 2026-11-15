/**
 * An agent unit's deadline is its own bound (madarch-64o5.112, owner's decision 2026-11-15): a plugin that declares an
 * agent part runs its units under `AgentUnitMs` — thirty minutes by default, `plugins[].bounds.minutes` in a product's
 * manifest — and the minute a unit may take stays for every other plugin. The agent's own ACP events keep its unit's
 * silence fresh, so only its bound and the run's token cap stop it.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closureOf } from '../src/plugin/closure.js';
import { PluginHost, type UnitOutcome } from '../src/plugin/host.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** The fixture plugin: one kind, and a unit that sleeps as many milliseconds as its key names. */
async function fixture(agent: boolean): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'madarch-agent-bound-'));
  roots.push(root);
  const folder = join(root, 'plugin');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({
    name: 'probe-slow', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version },
    produces: [{ kind: 'probe.slow', fields: '*', reads: [] }],
    ...(agent ? { agent: { prompt: 'prompt.md', roots: ['.'] } } : {}),
  }));
  writeFileSync(join(folder, 'prompt.md'), 'Fill the slow kind.');
  const outputs = { vertices: [{ kind: 'probe.slow', key: ['id'], fields: [{ name: 'title', type: 'text', meaning: 'the title', example: 'x', required: true }] }], edges: [] };
  writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'probe-slow', version: '1.0.0', outputs, rights: { network: 'none', graph: true } }));
  writeFileSync(join(folder, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';\nawait definePlugin({ name: 'probe-slow', version: '1.0.0', graph: true, contract: ${JSON.stringify(outputs)}, async extract(unit) { await Bun.sleep(Number(unit.key['id'])); return { vertices: [{ kind: 'probe.slow', key: unit.key, values: { title: 'slow' } }], end: { state: 'complete' } }; } });\n`);
  return folder;
}

/** One unit run under the limits, unconfined: the agent bound is the host's own question, not the sandbox's. */
async function run(folder: string, limits: { readonly unitMs: number; readonly agentUnitMs: number }, sleep: number): Promise<UnitOutcome> {
  const host = new PluginHost({
    pluginFolder: folder, repository: folder, workRoot: mkdtempSync(join(tmpdir(), 'madarch-agent-bound-work-')),
    trust: 'production', releaseHashes: [closureOf(folder).hash],
    limits: { handshakeMs: 10_000, heartbeatMs: 1_000, maxMessageBytes: 65_536, ...limits },
    env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' },
  });
  const session = await host.open();
  try {
    return await session.runUnit({ unitId: 'probe.slow', kind: 'probe.slow', key: { id: String(sleep) }, inputs: {} });
  } finally { await session.close(); }
}

test('a plugin with an agent part gives its unit the agent bound, not the minute', async () => {
  const folder = await fixture(true);
  const outcome = await run(folder, { unitMs: 150, agentUnitMs: 10_000 }, 600);
  expect(outcome.state).toBe('extracted');
});

test('the agent bound stops the unit, and says so', async () => {
  const folder = await fixture(true);
  const outcome = await run(folder, { unitMs: 10_000, agentUnitMs: 200 }, 800);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state !== 'not-extracted') return;
  expect(outcome.cause.code).toBe('agent-timeout');
  expect(outcome.cause.message).toContain('200 ms agent bound');
});

test('a plugin without an agent part keeps the minute its units may take', async () => {
  const folder = await fixture(false);
  const outcome = await run(folder, { unitMs: 200, agentUnitMs: 10_000 }, 800);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state !== 'not-extracted') return;
  expect(outcome.cause.code).toBe('unit-timeout');
});
