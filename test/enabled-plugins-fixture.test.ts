import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { planManifestFill } from '../src/plugin/fill-declarations.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';

const folder = mkdtempSync(join(tmpdir(), 'madarch-fixture-plugins-'));
const file = join(folder, 'madarch', 'kinds.yaml');
let original: string;
beforeAll(() => {
  seedStarterSet(folder);
  original = readFileSync(file, 'utf8');
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const selections: { selected: string[] }[] = [{ selected: [] }, { selected: ['db-schema'] }];

test.each(selections)('fixture plugin selection preserves all fields with %j', ({ selected }) => {
    writeFileSync(file, original);
    const before = parse(original);
    useFixturePlugins(folder, selected);
    const after = parse(readFileSync(file, 'utf8'));
    expect(after.plugins.map((plugin: { id: string }) => plugin.id)).toEqual(selected);
    const expected = structuredClone(before.kinds);
    let converted = 0;
    let enabledBindings = 0;
    let agentBindings = 0;
    for (const kind of Object.values(expected) as { source?: string; terms?: string[]; fields?: { binding?: unknown; producers?: string[] }[] }[]) {
      for (const field of kind.fields ?? []) {
        if (typeof field.binding === 'string') {
          const producer = field.binding.split('@')[0]!;
          if (selected.includes(producer)) { enabledBindings += 1; continue; }
          delete field.binding;
          field.producers = [producer];
          converted += 1;
        } else if (field.binding !== undefined) agentBindings += 1;
      }
      if (kind.source === 'graph' && !(kind.fields ?? []).some(field => field.binding !== undefined)) delete kind.terms;
    }
    expect(converted).toBeGreaterThan(0);
    if (selected.length > 0) expect(enabledBindings).toBeGreaterThan(0);
    expect(agentBindings).toBeGreaterThan(0);
    expect(after.kinds).toEqual(expected);
    const read = readKinds(folder);
    if (!read.present) throw new Error('fixture manifest is absent');
    expect(read.manifest.findings).toEqual([]);
    const plan = planManifestFill(read.manifest, folder, undefined, false);
    expect(plan.order).toEqual(selected);
    expect(plan.requiresAgent).toBe(false);
});
