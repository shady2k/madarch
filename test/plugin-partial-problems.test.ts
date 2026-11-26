/**
 * A partial unit's file problems (review of madarch-o0eq.6): a plugin that answers partial with file-specific problems
 * keeps both — the general cause and every place with its line and message — in the producer outcome the host records.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closureOf } from '../src/plugin/closure.js';
import { runPluginTurn, type PluginTurnWiring } from '../src/fill/plugin-turns.js';

test('a partial unit keeps its file problems beside the general cause', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-plugin-partial-'));
  try {
    const declaration = { name: 'partial-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Probe', fields: '*' }] };
    const contract = { vertices: [{ kind: 'Probe', key: ['name'], fields: [] }], edges: [] };
    writeFileSync(join(root, 'plugin.json'), JSON.stringify(declaration));
    writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: declaration.name, version: declaration.version, outputs: contract }));
    writeFileSync(join(root, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({ name: 'partial-probe', version: '1.0.0', readOnly: true, contract: ${JSON.stringify(contract)}, extract() {
  return { problems: [{ repository: 'app', path: 'src/a.ts', line: 2, column: 3, message: 'it broke' }], end: { state: 'partial', cause: 'the rest could not be read' } };
} });`);
    const closure = closureOf(root);
    const plugin = { id: declaration.name, path: '.', declaration, contract };
    const kind = { name: 'Probe', key: ['name'], fields: [] };
    const wiring = {
      productFolder: root,
      snapshots: { pins: async () => [] },
      manifest: { file: join(root, 'kinds.yaml'), kinds: new Map([['Probe', kind]]), plugins: new Map([[plugin.id, plugin]]) },
      locks: new Map([[plugin.id, { id: plugin.id, version: '1.0.0', closure: closure.hash }]]),
      contract: { vertex: [], edge: [] },
      releaseHashes: [closure.hash],
      // The plugin's own turn runs unconfined, as a fill on a machine whose person chose so (decision 0038): the choice
      // is the turn's, and the process's environment stays what the run gave it.
      unconfined: true,
    } as unknown as PluginTurnWiring;
    // Since ff84f4659 the third argument is the outcome callback itself, not a draft that records it.
    const outcomes: { outcome?: string; reason?: string }[] = [];
    await runPluginTurn(wiring, 'partial-probe:Probe', (outcome) => { outcomes.push(outcome); }, undefined, undefined, undefined, undefined);
    const outcome = outcomes[0];
    expect(outcome?.outcome).toBe('abstained');
    expect(outcome?.reason).toContain('the rest could not be read');
    expect(outcome?.reason).toContain('app/src/a.ts:2:3 it broke');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
