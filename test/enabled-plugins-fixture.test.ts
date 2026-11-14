import { readFolderManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { planManifestFill } from '../src/plugin/fill-declarations.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';

const folder = mkdtempSync(join(tmpdir(), 'madarch-fixture-plugins-'));
let original: string;
beforeAll(() => {
  seedStarterSet(folder);
  original = readFolderManifestText(folder);
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const selections: { selected: string[] }[] = [{ selected: [] }, { selected: ['db-schema'] }, { selected: ['disk', 'db-schema'] }];

test.each(selections)('fixture plugin selection keeps the kinds its plugins fill with %j', ({ selected }) => {
    writeFolderManifest(folder, original);
    useFixturePlugins(folder, selected);
    const after = parse(readFolderManifestText(folder));
    // A plugin whose declared inputs left with their kinds leaves too, so the kept ones are a selection of the asked ones.
    expect(after.plugins.map((plugin: { id: string }) => plugin.id).every((id: string) => selected.includes(id))).toBe(true);
    if (selected.includes('disk')) expect(after.plugins.map((plugin: { id: string }) => plugin.id)).toContain('disk');
    // A kind a kept plugin fills stays; a fielded kind nothing fills leaves the manifest with its producers (a kind left
    // without a producer is an abnormal state the plan reports), unless the fixture writes it itself as a person's own.
    const filled = new Set<string>();
    for (const plugin of after.plugins as { id: string; outputs?: string[] }[]) {
      for (const kind of plugin.outputs ?? []) filled.add(kind);
      const contract = join(folder, 'plugins', plugin.id, 'contract.json');
      if (!existsSync(contract)) continue;
      const held = JSON.parse(readFileSync(contract, 'utf8')) as { outputs?: { vertices?: { kind: string }[] } };
      for (const vertex of held.outputs?.vertices ?? []) filled.add(vertex.kind);
    }
    let converted = 0;
    let enabledBindings = 0;
    for (const [name, kind] of Object.entries(after.kinds) as [string, { fields?: { binding?: unknown; producers?: string[] }[] }][]) {
      const fields = kind.fields ?? [];
      if (fields.length === 0) continue;
      if (filled.has(name)) {
        for (const field of fields) {
          if (typeof field.binding === 'string' && selected.includes(field.binding.split('@')[0]!)) enabledBindings += 1;
          if (typeof field.binding === 'string' && !selected.includes(field.binding.split('@')[0]!)) converted += 1;
        }
        continue;
      }
      expect(fields.every((field) => field.producers?.includes('person') === true), `${name} stands only as a person's own writing`).toBe(true);
    }
    for (const name of filled) expect(Object.hasOwn(after.kinds, name), `${name} is kept with its producer`).toBe(true);
    expect(converted).toBe(0);
    if (selected.includes('disk')) expect(enabledBindings).toBeGreaterThan(0);
    const read = readKinds(folder);
    if (!read.present) throw new Error('fixture manifest is absent');
    expect(read.manifest.findings).toEqual([]);
    const plan = planManifestFill(read.manifest, folder, undefined, false);
    expect(plan.requiresAgent).toBe(false);
    expect(plan.errors).toEqual([]);
    expect(plan.order).toEqual(selected.includes('disk') ? ['disk', 'db-schema'] : []);
});
