import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost } from '../src/plugin/host.js';

/** Protocol-only fixture: sandbox-off is not an isolation test. */
async function runLargeResult(maxUnitOutputBytes?: number, count = 3, textBytes = 400000) {
  const root = mkdtempSync(join(tmpdir(), 'madarch-result-chunks-'));
  const outputs = { vertices: [{ kind: 'item', key: ['id'], fields: [{ name: 'text', type: 'text', meaning: 'fixture text', example: '', required: false }] }], edges: [] };
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'chunks', version: '1.0.0', entry: 'entry.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'item', fields: '*' }] }));
  writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: 'chunks', version: '1.0.0', outputs, rights: { network: 'none' } }));
  writeFileSync(join(root, 'entry.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({ name: 'chunks', version: '1.0.0', contract: ${JSON.stringify(outputs)}, extract: () => ({ vertices: Array.from({length: ${count}}, (_, id) => ({kind: 'item', key: {id: String(id)}, values: {text: 'x'.repeat(${textBytes})}})), end: {state: 'complete'} }) });`);
  let session;
  try {
    session = await new PluginHost({ pluginFolder: root, repository: root, workRoot: join(root, 'work'), trust: 'validation', env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' }, ...(maxUnitOutputBytes === undefined ? {} : { limits: { maxUnitOutputBytes } }) }).open();
    return await session.runUnit({ unitId: 'large', kind: 'item', key: { id: 'all' } });
  } finally {
    await session?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('bounded result chunks retain the complete atomic unit above one message', async () => {
  const outcome = await runLargeResult();
  expect(outcome.state).toBe('extracted');
  if (outcome.state !== 'extracted') throw new Error(outcome.cause.message);
  expect(outcome.bytes).toBeGreaterThan(1_048_576);
  expect(outcome.result.vertices.map((vertex) => [vertex.key.id, vertex.values?.text])).toEqual(['0', '1', '2'].map((id) => [id, 'x'.repeat(400000)]));
  expect(outcome.result.end).toEqual({ state: 'complete' });
});

test('byte fragments preserve a single vertex larger than one message', async () => {
  const outcome = await runLargeResult(undefined, 1, 1_200_000);
  expect(outcome.state).toBe('extracted');
  if (outcome.state !== 'extracted') throw new Error(outcome.cause.message);
  expect(outcome.result.vertices).toHaveLength(1);
  expect(outcome.result.vertices[0]?.values?.text).toBe('x'.repeat(1_200_000));
  expect(outcome.result.end).toEqual({ state: 'complete' });
});

test('bounded result chunks cannot bypass the unchanged per-unit cap', async () => {
  const outcome = await runLargeResult(1_048_576);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state === 'not-extracted') expect(outcome.cause.code).toBe('unit-output-too-large');
  expect('result' in outcome).toBe(false);
});
