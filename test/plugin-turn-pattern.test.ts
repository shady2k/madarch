import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closureOf } from '../src/plugin/closure.js';
import { runPluginTurn, type PluginTurnWiring } from '../src/fill/plugin-turns.js';

test('a plugin turn leaves an absent optional pattern to the plugin default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-plugin-pattern-'));
  const previous = process.env.MADARCH_PLUGIN_SANDBOX;
  process.env.MADARCH_PLUGIN_SANDBOX = 'off';
  try {
    const declaration = { name: 'pattern-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Probe', fields: '*', partition: 'key' }] };
    const contract = { vertices: [{ kind: 'Probe', key: ['name'], fields: [] }], edges: [] };
    writeFileSync(join(root, 'plugin.json'), JSON.stringify(declaration));
    writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: declaration.name, version: declaration.version, outputs: contract }));
    writeFileSync(join(root, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({ name: 'pattern-probe', version: '1.0.0', contract: ${JSON.stringify(contract)},
  planOutput(unit) {
    if ('pattern' in unit.inputs || unit.inputs.patterns.length !== 0) throw new Error('absent pattern was replaced');
    return { partitions: [] };
  },
  extract() { throw new Error('planning does not execute'); },
});`);
    const closure = closureOf(root);
    const plugin = { id: declaration.name, path: '.', declaration, contract };
    const kind = { name: 'Probe', key: ['name'], fields: [] };
    const wiring = {
      productFolder: root,
      manifest: { file: join(root, 'kinds.yaml'), kinds: new Map([['Probe', kind]]), plugins: new Map([[plugin.id, plugin]]) },
      locks: new Map([[plugin.id, { id: plugin.id, version: '1.0.0', closure: closure.hash }]]),
      contract: { vertex: [], edge: [] },
      releaseHashes: [closure.hash],
    } as unknown as PluginTurnWiring;
    let planned = false;
    await runPluginTurn(wiring, 'pattern-probe:Probe', { write() { throw new Error('planning writes no draft'); }, writes() { return { writes: [] }; } }, undefined, undefined, undefined, undefined, { plan(partitions) { expect(partitions).toEqual([]); planned = true; } });
    expect(planned).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.MADARCH_PLUGIN_SANDBOX;
    else process.env.MADARCH_PLUGIN_SANDBOX = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
