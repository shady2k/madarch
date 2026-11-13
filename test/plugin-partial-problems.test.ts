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
  const previous = process.env.MADARCH_PLUGIN_SANDBOX;
  process.env.MADARCH_PLUGIN_SANDBOX = 'off';
  try {
    const declaration = { name: 'partial-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'Probe', fields: '*' }] };
    const contract = { vertices: [{ kind: 'Probe', key: ['name'], fields: [] }], edges: [] };
    writeFileSync(join(root, 'plugin.json'), JSON.stringify(declaration));
    writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: declaration.name, version: declaration.version, outputs: contract }));
    writeFileSync(join(root, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({ name: 'partial-probe', version: '1.0.0', contract: ${JSON.stringify(contract)}, extract() {
  return { problems: [{ repository: 'app', path: 'src/a.ts', line: 2, column: 3, message: 'it broke' }], end: { state: 'partial', cause: 'the rest could not be read' } };
} });`);
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
    const writes: { kind: string; value: unknown }[] = [];
    const draft = { write(write: { kind: string; value: unknown }) { writes.push(write); }, writes() { return { writes: [] }; } };
    await runPluginTurn(wiring, 'partial-probe:Probe', draft as never, undefined, undefined, undefined, undefined);
    const outcome = writes.find((write) => write.kind === 'producer-outcome')?.value as { outcome?: string; reason?: string } | undefined;
    expect(outcome?.outcome).toBe('abstained');
    expect(outcome?.reason).toContain('the rest could not be read');
    expect(outcome?.reason).toContain('app/src/a.ts:2:3 it broke');
  } finally {
    if (previous === undefined) delete process.env.MADARCH_PLUGIN_SANDBOX;
    else process.env.MADARCH_PLUGIN_SANDBOX = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
