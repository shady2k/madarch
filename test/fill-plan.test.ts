
/**
 * The fill plan the command page reads (decision 0036, section 7): the catalogue's kinds with the catalogue's words, the
 * fields each enabled plugin fills and the dependency order of a selection. The plan is the engine's; this read states it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKinds } from '../src/product/manifest/kinds.js';
import { fillPlanOf } from '../src/knowledge/fill-plan.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { useFixturePlugins } from './enabled-plugins-fixture.js';

describe('the fill plan', () => {
  test('names the catalogue in the reader\'s words and the fields each plugin fills', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-fill-plan-'));
    try {
      seedStarterSet(folder);
      useFixturePlugins(folder, ['disk', 'git']);
      const read = readKinds(folder);
      if (!read.present) throw new Error('the starter holds no kinds manifest');
      const plan = fillPlanOf(read.manifest, folder, { lang: 'ru', selected: [] });
      expect(plan.refusal).toBeUndefined();
      expect(plan.catalogue.length).toBeGreaterThan(10);
      const file = plan.catalogue.find((kind) => kind.kind === 'code.file');
      expect(file).toBeDefined();
      expect(file!.labels.many).not.toBe('code.file');
      expect(file!.plugins.length).toBeGreaterThan(0);
      expect(file!.fields.some((field) => field.plugins.length > 0)).toBe(true);
      const selection = fillPlanOf(read.manifest, folder, { lang: 'ru', selected: ['code.file'] });
      expect(selection.refusal).toBeUndefined();
      expect(selection.order.at(-1)).toBe('code.file');
      expect(selection.kinds.find((kind) => kind.kind === 'code.file')?.reason).toBe('requested');
      expect(selection.unproduced).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 60_000);

  test('a kind the manifest does not declare refuses the plan and keeps the catalogue for the page', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-fill-plan-'));
    try {
      seedStarterSet(folder);
      useFixturePlugins(folder, ['disk', 'git']);
      const read = readKinds(folder);
      if (!read.present) throw new Error('the starter holds no kinds manifest');
      const plan = fillPlanOf(read.manifest, folder, { lang: 'en', selected: ['no.such'] });
      expect(plan.refusal).toContain('no.such');
      expect(plan.catalogue.length).toBeGreaterThan(10);
      expect(plan.kinds).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 60_000);
});
