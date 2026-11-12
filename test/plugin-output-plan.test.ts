import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost } from '../src/plugin/host.js';

test('planOutput returns finite key pages through the ordinary plugin session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-output-plan-'));
  const outputs = { vertices: [{ kind: 'item', key: ['id'] }], edges: [] };
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'planning', version: '1.0.0', entry: 'entry.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'item', fields: '*', partition: 'key' }] }));
  writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: 'planning', version: '1.0.0', outputs, rights: { network: 'none' } }));
  writeFileSync(join(root, 'entry.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({name:'planning',version:'1.0.0',contract:${JSON.stringify(outputs)},planOutput:(_unit,_context,cursor)=>cursor===undefined?{partitions:[{keys:[{id:'a'},{id:'b'}]}],next:'last'}:{partitions:[{keys:[{id:'c'}]}]},extract:()=>({end:{state:'complete'}})});`);
  let session;
  try {
    session = await new PluginHost({ pluginFolder: root, repository: root, workRoot: join(root, 'work'), trust: 'validation', env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' } }).open();
    expect(session.declared.planOutput).toBe(true);
    const unit = { unitId: 'plan', kind: 'item', key: {} };
    const first = await session.planOutput(unit);
    expect(first).toEqual({ partitions: [{ keys: [{ id: 'a' }, { id: 'b' }] }], next: 'last' });
    expect(await session.planOutput(unit, first.next)).toEqual({ partitions: [{ keys: [{ id: 'c' }] }] });
  } finally {
    await session?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
