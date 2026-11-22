import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closureOf } from '../src/plugin/closure.js';
import { runPluginTurn, type PluginTurnWiring } from '../src/fill/plugin-turns.js';
import { createTestDatabaseOwner } from './test-database.js';
import { withSystemContract } from '../src/graph/system-contract.js';
import { generatedTableName } from '../src/graph/contract.js';

test('a plugin turn leaves an absent optional pattern to the plugin default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-plugin-pattern-'));
  const graphContract = withSystemContract({ dictionary: [], vertex: [{ name: 'Probe', table: generatedTableName('Probe', 'vertex'), key: ['name'], fields: [{ name: 'name', type: 'text' }], capability: 'pattern-probe' }], edge: [] });
  const owner = await createTestDatabaseOwner({ graphContract });
  try {
    const declaration = { name: 'pattern-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Probe', fields: '*', partition: 'key' }] };
    const contract = { vertices: [{ kind: 'Probe', key: ['name'], fields: [] }], edges: [] };
    // The SDK introduces a writing plugin with the graph right and these reads (src/plugin-sdk.ts:747); the contract grants them.
    const rights = { network: 'none', graph: true, graphReads: ['files', 'value', 'ownFacts'] };
    writeFileSync(join(root, 'plugin.json'), JSON.stringify(declaration));
    writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: declaration.name, version: declaration.version, outputs: contract, rights }));
    writeFileSync(join(root, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({ name: 'pattern-probe', version: '1.0.0', contract: ${JSON.stringify(contract)}, graph: true, graphReads: ['files', 'value', 'ownFacts'],
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
      // plugin-turns.ts:469 reads the run's pins before the unit's turn; this double pins no repository.
      snapshots: { pins: async () => [], open: async () => { throw new Error('no repository'); } },
      manifest: { file: join(root, 'kinds.yaml'), kinds: new Map([['Probe', kind]]), plugins: new Map([[plugin.id, plugin]]) },
      locks: new Map([[plugin.id, { id: plugin.id, version: '1.0.0', closure: closure.hash }]]),
      owner,
      contract: graphContract,
      releaseHashes: [closure.hash],
      // The plugin's own turn runs unconfined, as a fill on a machine whose person chose so (decision 0038): the choice
      // is the turn's, and the process's environment stays what the run gave it.
      unconfined: true,
    } as unknown as PluginTurnWiring;
    let planned = false;
    await runPluginTurn(wiring, 'pattern-probe:Probe', () => { throw new Error('planning reports no outcome'); }, undefined, undefined, undefined, undefined, { plan(partitions) { expect(partitions).toEqual([]); planned = true; } });
    expect(planned).toBe(true);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});
