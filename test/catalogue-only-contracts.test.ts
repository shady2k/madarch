/** Catalogue-only declarations remain visible without producing storage or schema types. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { readKinds, deferredEdgesOf } from '../src/product/manifest/kinds.js';
import { planManifestFill } from '../src/plugin/fill-declarations.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';
import { fillTargets } from '../src/knowledge/fill-targets.js';
import { fillPlanView } from '../src/knowledge/fill-plan.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';

test('a catalogue-only prerequisite is planned explicitly as empty, even with wildcard agent coverage', () => {
  const folder = mkdtempSync(join(tmpdir(), 'catalogue-empty-'));
  try {
    seedStarterSet(folder);
    const read = readKinds(folder);
    if (!read.present) throw new Error(`${folder}:1: missing manifest`);
    expect(read.manifest.findings).toEqual([]);
    const manifest = { ...read.manifest, kinds: new Map([...read.manifest.kinds, ['domain', { ...read.manifest.kinds.get('domain')!, derivesFrom: ['goal'] }]]) };
    const plan = planManifestFill(manifest, folder, ['domain'], true, [...manifest.kinds.keys()]);
    expect(plan.errors).toEqual([]);
    const targets = fillTargets(manifest, ['domain']);
    expect(targets.ok).toBe(true);
    if (!targets.ok) throw new Error(targets.message);
    expect(targets.targets.order.indexOf('idea')).toBeLessThan(targets.targets.order.indexOf('vision'));
    expect(targets.targets.order.indexOf('vision')).toBeLessThan(targets.targets.order.indexOf('goal'));
    expect(fillPlanView(manifest, folder, ['domain'], [...manifest.kinds.keys()]).emptyKinds)
      .toContainEqual({ kind: 'goal', state: 'no-producer-declared' });
    expect(plan.selectedKinds).toContain('goal');
    expect(plan.emptyKinds).toContainEqual({ kind: 'goal', state: 'no-producer-declared' });
    expect(plan.selectedKinds).toContain('idea');
    expect(plan.producers('goal', 'name')).toEqual([]);
    expect(plan.selectedKinds).toContain('domain');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('edges to catalogue-only kinds wait by name, without storage or schema, until a page is declared', () => {
  const folder = mkdtempSync(join(tmpdir(), 'catalogue-edge-'));
  try {
    seedStarterSet(folder);
    const read = readKinds(folder);
    if (!read.present) throw new Error(`${folder}:1: missing manifest`);
    const manifest = read.manifest;
    const names = deferredEdgesOf(manifest).map((edge) => edge.name);
    expect(names).toEqual(['architecture.serves-domain', 'data-catalog.contains', 'organization.contains', 'software-system.contains', 'token-group.contains']);
    expect(manifest.edges?.has('software-system.contains')).toBe(true);
    expect(publishedManifestOf(manifest).edges.some((edge) => names.includes(edge.name))).toBe(false);
    expect(graphContractOf(manifest).edge.some((edge) => names.includes(edge.name))).toBe(false);
    expect(graphContractOf(manifest).vertex.some((kind) => kind.name === 'software-system')).toBe(false);
    expect(() => graphqlSchemaOf(publishedManifestOf(manifest))).not.toThrow();
    const entry = manifest.catalog!.kinds.get('software-system')!;
    const promoted = { ...manifest, kinds: new Map([...manifest.kinds, ['software-system', { name: 'software-system', source: 'graph' as const, title: 'name', relations: [], line: entry.line }]]),
      catalog: { ...manifest.catalog!, kinds: new Map([...manifest.catalog!.kinds, ['software-system', { ...entry, templatePolicy: 'page' }]]) } };
    expect(deferredEdgesOf(promoted).map((edge) => edge.name)).not.toContain('software-system.contains');
    expect(publishedManifestOf(promoted).edges.some((edge) => edge.name === 'software-system.contains')).toBe(true);
    expect(graphContractOf(promoted).edge.some((edge) => edge.name === 'software-system.contains')).toBe(true);
    expect(() => graphqlSchemaOf(publishedManifestOf(promoted))).not.toThrow();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
