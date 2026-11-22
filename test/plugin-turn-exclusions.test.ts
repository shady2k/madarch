/**
 * What the host hands a unit about the paths the product leaves out (madarch-64o5.74): a unit that writes an edge to a
 * path has to know the exclusions of the kind at that edge's end. An excluded path has no producer (madarch-64o5.83),
 * so an edge that names one has no vertex to point at and the publication fails with `MISSING_ENDPOINT`.
 *
 * The unit's inputs are the host's own answer here — the kinds, the plugin's contract and the edge ownership are the
 * manifest's data, and nothing is handed to the unit by hand. The probe plugin answers with the exclusions it was
 * given, one partition key each, so the test reads exactly what reached the plugin's process.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closureOf } from '../src/plugin/closure.js';
import { runPluginTurn, type PluginTurnWiring } from '../src/fill/plugin-turns.js';

/** The dependency tree and the repository's own folder, as the catalogue's file kind declares them. */
const FILE_PATHS = ['**/node_modules/**', '**/.git/**'];

/**
 * A product of four kinds: a file placed by its path, a folder placed by its path, an archive keyed by an identifier and
 * a note with no exclusions at all, and one commit kind that ends at all of them. The probe plugin produces them.
 */
function fixture(): { root: string; wiring: PluginTurnWiring; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'madarch-plugin-exclusions-'));
  const declaration = {
    name: 'exclusion-probe', version: '1.0.0', entry: 'main.ts', runtime: { name: 'bun', version: Bun.version },
    produces: [{ kind: 'CodeFile', fields: '*' }, { kind: 'CodeFolder', fields: '*' }, { kind: 'Archive', fields: '*' }, { kind: 'Note', fields: '*' }, { kind: 'CodeCommit', fields: '*' }],
  };
  // An edge declaration's shape is the shipped git plugin's own: what the protocol asks of it beside the two ends is
  // the product's, so the test borrows a valid declaration and names its own kinds on it.
  const shipped = JSON.parse(readFileSync(join(import.meta.dir, '..', 'plugins', 'git', 'contract.json'), 'utf8')) as { outputs: { edges: Record<string, unknown>[] } };
  const shape = shipped.outputs.edges.find((edge) => edge['kind'] === 'code.touched');
  if (shape === undefined) throw new Error('plugins/git/contract.json declares no code.touched edge');
  const contract = {
    vertices: ['CodeFile', 'CodeFolder', 'Archive', 'Note', 'CodeCommit'].map((kind) => ({ kind, key: ['id'], fields: [] })),
    edges: [
      { ...shape, kind: 'touched', from: 'CodeCommit', to: 'CodeFile' },
      { ...shape, kind: 'holds', from: 'CodeCommit', to: 'CodeFolder' },
      { ...shape, kind: 'archived', from: 'CodeCommit', to: 'Archive' },
      { ...shape, kind: 'noted', from: 'CodeCommit', to: 'Note' },
    ],
  };
  writeFileSync(join(root, 'plugin.json'), JSON.stringify(declaration));
  writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: declaration.name, version: declaration.version, outputs: contract, rights: { network: 'none' } }));
  // The probe answers what it read: one partition per exclusion pattern, or the one marker that no "exclude" arrived.
  // It declares the contract's own rights, `network: none`, and nothing else: the host refuses an introduction whose
  // rights its contract does not grant, and a read-only probe asks for none.
  writeFileSync(join(root, 'main.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({ name: 'exclusion-probe', version: '1.0.0', graph: false, readOnly: true, contract: ${JSON.stringify(contract)},
  planOutput(unit) {
    const held = unit.inputs.exclude;
    const values = held === undefined ? ['<absent>'] : held;
    return { partitions: values.map((value) => ({ keys: [{ id: String(value) }] })) };
  },
  extract() { throw new Error('planning does not execute'); },
});`);
  const kinds = new Map<string, Record<string, unknown>>([
    // A file and a folder are placed by their path, so the host knows their exclusions speak of paths.
    ['CodeFile', { name: 'CodeFile', key: ['repository', 'path'], fields: [], fileText: { repository: 'repository', path: 'path', blob: 'blob' }, exclude: FILE_PATHS }],
    ['CodeFolder', { name: 'CodeFolder', key: ['repository', 'path'], fields: [], exclude: [...FILE_PATHS, '**/.cache/**'] }],
    // An archive is keyed by an identifier: its exclusions name no path the commit can reach.
    ['Archive', { name: 'Archive', key: ['id'], fields: [], exclude: ['**/dist/**'] }],
    ['Note', { name: 'Note', key: ['id'], fields: [], derivesFrom: ['CodeCommit'] }],
    // The commit ends at every other kind, so it owns all four edges.
    ['CodeCommit', { name: 'CodeCommit', key: ['hash'], fields: [], derivesFrom: ['CodeFile', 'CodeFolder', 'Archive'] }],
  ]);
  const closure = closureOf(root);
  const plugin = { id: declaration.name, path: '.', declaration, contract };
  const wiring = {
    productFolder: root,
    manifest: { file: join(root, 'kinds.yaml'), kinds, plugins: new Map([[plugin.id, plugin]]) },
    locks: new Map([[plugin.id, { id: plugin.id, version: '1.0.0', closure: closure.hash }]]),
    snapshots: { pins: async () => [] },
    contract: { vertex: [], edge: [] },
    releaseHashes: [closure.hash],
  } as unknown as PluginTurnWiring;
  return { root, wiring, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The exclusion patterns the host handed the unit of `kind`, as the probe's own partitions name them. */
async function handedTo(kind: string): Promise<string[]> {
  const held = fixture();
  const previous = process.env.MADARCH_PLUGIN_SANDBOX;
  process.env.MADARCH_PLUGIN_SANDBOX = 'off';
  try {
    let answered: string[] | undefined;
    // Planning writes nothing, so the third argument is never used; it is cast to whatever shape the fill's turn
    // takes for it today, so this test reads the inputs the host builds and not the writer's own API.
    const writes = { write() { throw new Error('planning writes no draft'); }, writes() { return { writes: [] }; } } as unknown as Parameters<typeof runPluginTurn>[2];
    await runPluginTurn(held.wiring, `exclusion-probe:${kind}`, writes, undefined, undefined, undefined, undefined, {
      plan(partitions) { answered = partitions.map((partition) => String(partition.keys[0]?.['id'])); },
    });
    if (answered === undefined) throw new Error(`the unit exclusion-probe:${kind} planned no partition list`);
    return answered;
  } finally {
    if (previous === undefined) delete process.env.MADARCH_PLUGIN_SANDBOX;
    else process.env.MADARCH_PLUGIN_SANDBOX = previous;
    held.cleanup();
  }
}

test('a unit whose edges end at a path carries the exclusions of the kind at that end (madarch-64o5.74)', async () => {
  // A commit touches files and folders: the exclusions of the file shape have to reach it, or the edge it writes names
  // a path no producer publishes. The archive's patterns do not travel: an archive is keyed by an identifier, and its
  // exclusions are no paths of this unit's edges.
  expect(await handedTo('CodeCommit')).toEqual([...FILE_PATHS, '**/.cache/**']);
});

test("a unit carries its own kind's exclusions (madarch-64o5.83)", async () => {
  expect(await handedTo('CodeFile')).toEqual(FILE_PATHS);
});

test('a unit that names no excluded path receives no "exclude" at all', async () => {
  expect(await handedTo('Note')).toEqual(['<absent>']);
});
