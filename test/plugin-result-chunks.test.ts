import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost } from '../src/plugin/host.js';

/** Protocol-only fixture: sandbox-off is not an isolation test. */
async function runLargeResult(maxUnitOutputBytes?: number, count = 3, textBytes = 400000, fault?: 'sequence' | 'missing-count' | 'after-writes') {
  const root = mkdtempSync(join(tmpdir(), 'madarch-result-chunks-'));
  const outputs = { vertices: [{ kind: 'item', key: ['id'], fields: [{ name: 'text', type: 'text', meaning: 'fixture text', example: '', required: false }] }], edges: [] };
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'chunks', version: '1.0.0', entry: 'entry.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'item', fields: '*' }] }));
  writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: 'chunks', version: '1.0.0', outputs, rights: { network: 'none', graph: true, graphReads: ['files', 'value', 'ownFacts'] } }));
  writeFileSync(join(root, 'entry.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({ name: 'chunks', version: '1.0.0', contract: ${JSON.stringify(outputs)}, extract: async (unit, context) => {
const result = { vertices: Array.from({length: ${count}}, (_, id) => ({kind: 'item', key: {id: String(id)}, values: {text: 'x'.repeat(${textBytes})}, evidence: {path: 'fixture.txt', lineStart: 1}})), end: {state: 'complete'} };
${fault === 'after-writes' ? 'await context.reconcile(result, {});' : ''}
${fault === undefined ? '' : `process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'writer.applyChunk',params:{unitId:unit.unitId,writeId:'broken',sequence:${fault === 'sequence' ? 1 : 0},data:'e30='}})+'\\n');`}
return ${fault === 'after-writes' ? '{end: result.end}' : 'result'};
} });`);
  let session;
  try {
    session = await new PluginHost({ pluginFolder: root, repository: root, workRoot: join(root, 'work'), trust: 'validation', graph: { async files() { return []; }, async value() { return undefined; }, async ownFacts() { return { vertices: [], edges: [] }; } }, env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' }, ...(maxUnitOutputBytes === undefined ? {} : { limits: { maxUnitOutputBytes } }) }).open();
    return await session.runUnit({ unitId: 'large', kind: 'item', key: { id: 'all' } });
  } finally {
    await session?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('bounded explicit writes retain every item above one message', async () => {
  const outcome = await runLargeResult();
  expect(outcome.state).toBe('extracted');
  if (outcome.state !== 'extracted') throw new Error(outcome.cause.message);
  expect(outcome.bytes).toBeGreaterThan(1_048_576);
  expect(outcome.result.writes!.map(({ vertex }) => [vertex!.key.id, vertex!.values?.text])).toEqual(['0', '1', '2'].map((id) => [id, 'x'.repeat(400000)]));
  expect(outcome.result.end).toEqual({ state: 'complete' });
});

test('byte fragments preserve a single vertex larger than one message', async () => {
  const outcome = await runLargeResult(undefined, 1, 1_200_000);
  expect(outcome.state).toBe('extracted');
  if (outcome.state !== 'extracted') throw new Error(outcome.cause.message);
  expect(outcome.result.writes).toHaveLength(1);
  expect(outcome.result.writes?.[0]?.vertex?.values?.text).toBe('x'.repeat(1_200_000));
  expect(outcome.result.end).toEqual({ state: 'complete' });
});

for (const fault of ['sequence', 'missing-count', 'after-writes'] as const) {
  test(`incomplete or out-of-order writer fragments refuse the unit: ${fault}`, async () => {
    const outcome = await runLargeResult(undefined, 1, 10, fault);
    expect(outcome.state).toBe('not-extracted');
    if (outcome.state === 'not-extracted') expect(outcome.cause.code).toBe('malformed-result');
    expect('result' in outcome).toBe(false);
  });
}

test('explicit writer operations cannot bypass a configured per-unit cap', async () => {
  const outcome = await runLargeResult(1_048_576);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state === 'not-extracted') expect(outcome.cause.code).toBe('unit-output-too-large');
  expect('result' in outcome).toBe(false);
});

test('a fragmented writer operation cannot bypass the per-unit cap', async () => {
  const outcome = await runLargeResult(1_048_576, 1, 1_200_000);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state === 'not-extracted') expect(outcome.cause.code).toBe('unit-output-too-large');
});

test('the default eight MiB cap includes accumulated explicit writes', async () => {
  const outcome = await runLargeResult(undefined, 22, 400000);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state === 'not-extracted') expect(outcome.cause.code).toBe('unit-output-too-large');
  expect('result' in outcome).toBe(false);
});

test('the default eight MiB cap includes a single fragmented write', async () => {
  const outcome = await runLargeResult(undefined, 1, 8 * 1_048_576);
  expect(outcome.state).toBe('not-extracted');
  if (outcome.state === 'not-extracted') expect(outcome.cause.code).toBe('unit-output-too-large');
  expect('result' in outcome).toBe(false);
});
