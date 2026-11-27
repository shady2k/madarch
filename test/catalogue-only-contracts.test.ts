/** Catalogue-only declarations remain visible without producing storage or schema types. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { readKinds, deferredEdgesOf } from '../src/product/manifest/kinds.js';
import { fillKindsOf, planManifestFill } from '../src/plugin/fill-declarations.js';
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

test('a cycle can be planned without a saved agent and plugins-only identifies its agent-only prerequisite', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'madarch-cycle-plan-'));
  try {
    seedStarterSet(scratch);
    const read = readKinds(scratch);
    if (!read.present) throw new Error(`The fixture has no kinds manifest at ${read.file}`);
    for (const pluginsOnly of [false, true]) {
      const requested = ['code.commit', 'code.cycle', 'code.file'];
      const targets = fillTargets(read.manifest, requested, pluginsOnly);
      if (!targets.ok) throw new Error(targets.message);
      const { entries, order } = targets.targets;
      const plan = fillPlanView(read.manifest, scratch, order, requested, entries, pluginsOnly);
      expect(plan.errors).toEqual([]);
      expect(plan.added).toContainEqual({ kind: 'code.module', neededBy: 'code.cycle' });
      expect(plan.kinds.find((kind) => kind.kind === 'code.module')?.agentOnly).toBe(true);
      expect(plan.kinds.find((kind) => kind.kind === 'code.cycle')?.agentOnly).toBe(true);
      expect(plan.units).toContainEqual({ plugin: 'git', kind: 'code.commit' });
      expect(plan.units.some((unit) => unit.kind === 'code.cycle')).toBe(!pluginsOnly);
      if (pluginsOnly) expect(plan.skipped.find((entry) => entry.kind === 'code.module')?.fields).toContain('name');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('edges to catalogue-only kinds wait by name, without storage or schema, until a page is declared', () => {
  const folder = mkdtempSync(join(tmpdir(), 'catalogue-edge-'));
  try {
    seedStarterSet(folder);
    const read = readKinds(folder);
    if (!read.present) throw new Error(`${folder}:1: missing manifest`);
    const manifest = read.manifest;
    expect(manifest.edges?.get('profile-product')).toMatchObject({ from: ['product-profile'], to: ['system.product'] });
    expect(publishedManifestOf(manifest).edges.some((edge) => edge.name === 'profile-product')).toBe(true);
    expect(graphContractOf(manifest).edge.some((edge) => edge.name === 'profile-product')).toBe(true);
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


test('a graph-backed kind without a page keeps one fill declaration and its storage edges', () => {
  const folder = mkdtempSync(join(tmpdir(), 'catalogue-hidden-graph-'));
  try {
    seedStarterSet(folder);
    const read = readKinds(folder);
    if (!read.present) throw new Error(`${folder}:1: missing manifest`);
    expect(read.manifest.findings).toEqual([]);
    const manifest = read.manifest;
    const entry = manifest.catalog!.kinds.get('domain')!;
    const hidden = { ...manifest, catalog: { ...manifest.catalog!, kinds: new Map([
      ...manifest.catalog!.kinds,
      ['domain', { ...entry, templatePolicy: 'none' as const }],
    ]) } };
    const declarations = fillKindsOf(hidden).filter((kind) => kind.name === 'domain');
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.catalogueOnly).toBeUndefined();
    expect(declarations[0]?.fields).toContain('name');
    expect(deferredEdgesOf(hidden).some((edge) => edge.name === 'domain.covers')).toBe(false);
    expect(graphContractOf(hidden).vertex.filter((kind) => kind.name === 'domain')).toHaveLength(1);
    expect(graphContractOf(hidden).edge.some((edge) => edge.name === 'domain.covers')).toBe(true);
    expect(publishedManifestOf(hidden).edges.some((edge) => edge.name === 'domain.covers')).toBe(true);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
