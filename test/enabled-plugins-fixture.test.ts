import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { planManifestFill } from '../src/plugin/fill-declarations.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';

test('fixture plugin selection preserves all fields and only converts excluded plugin bindings to provenance', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-fixture-plugins-'));
  try {
    seedStarterSet(folder);
    const file = join(folder, 'madarch', 'kinds.yaml');
    const before = parse(readFileSync(file, 'utf8'));
    useFixturePlugins(folder, ['db-schema']);
    const after = parse(readFileSync(file, 'utf8'));
    expect(after.plugins.map((plugin: { id: string }) => plugin.id)).toEqual(['db-schema']);
    const expected = structuredClone(before.kinds);
    let converted = 0;
    let enabledBindings = 0;
    let agentBindings = 0;
    for (const kind of Object.values(expected) as { fields?: { binding?: unknown; producers?: string[] }[] }[]) {
      for (const field of kind.fields ?? []) {
        if (typeof field.binding === 'string') {
          const producer = field.binding.split('@')[0]!;
          if (producer === 'db-schema') { enabledBindings += 1; continue; }
          delete field.binding;
          field.producers = [producer];
          converted += 1;
        } else if (field.binding !== undefined) agentBindings += 1;
      }
    }
    expect(converted).toBeGreaterThan(0);
    expect(enabledBindings).toBeGreaterThan(0);
    expect(agentBindings).toBeGreaterThan(0);
    expect(after.kinds).toEqual(expected);
    const read = readKinds(folder);
    if (!read.present) throw new Error('fixture manifest is absent');
    expect(read.manifest.findings).toEqual([]);
    const plan = planManifestFill(read.manifest, folder, undefined, false);
    expect(plan.order).toEqual(['db-schema']);
    expect(plan.requiresAgent).toBe(false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
