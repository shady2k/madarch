/**
 * The POV over the catalog (decision 0033, item 12): the roles are the product's own — the engine keeps no list of
 * them — a role lists the areas or subgroups it leads, and every area is led by at least one role. A role's name
 * is one word, "everything" is every role at once and is not declared, and a group a role leads must be declared.
 * Fixtures only: a small catalog with the roles a test declares, and the starter set's own manifest read once.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { starterManifestText } from './catalog-folder-fixture.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';

const SMALL = [
  'catalog:',
  '  subgroup-kind-bound: 2',
  '  attributes: [version]',
  '  origin-marks: [document, conversation, not-implemented]',
  '  extractor-mark: extractor',
  '  statuses: [implemented, not-implemented]',
  '  template-policies: [page, member, none]',
  '  relations:',
  '    contains:',
  'groups:',
  '  area: { en: Area, ru: Область, short: { en: Area, ru: Область }, open: true }',
  '  area.one: { en: One, ru: Один, short: { en: One, ru: Один }, parent: area }',
  '  area.two: { en: Two, ru: Два, short: { en: Two, ru: Два }, parent: area }',
  'kinds:',
  '  code.symbol:',
  '    id: "practice.code-symbol"',
  '    group: area.one',
  '    definition: "A symbol the extractor read."',
  '    sources: ["https://example.test/symbol"]',
  '    acquisition: ["extractor code"]',
  '    status: implemented',
  '    relation-constraints: { out: [], in: [] }',
  '    template-policy: none',
  '    labels:',
  '      en: { one: Symbol, many: Symbols }',
  '      ru: { one: Символ, many: Символы }',
  '    description:',
  '      en: A symbol the extractor read.',
  '      ru: Символ, прочитанный извлекателем.',
  '',
].join('\n');

const made: string[] = [];
afterAll(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** The starter set's templates, written once: the starter manifest is read against them. */
const TEMPLATES = ((): string => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-roles-check-'));
  made.push(folder);
  // The whole starter set stands here: the manifest names its plugin and the lock, and a manifest is read against the
  // product that holds them (decision 0035, items 18 and 20).
  for (const file of STARTER_FILES) {
    const path = join(folder, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  return folder;
})();

/** The small catalog with the roles a test declares, added after its kinds. */
function withRoles(roles: readonly string[]): string {
  return `${SMALL.trimEnd()}\nroles:\n${roles.join('\n')}\n`;
}

/** The findings of a manifest: the line and the words of each. */
function findings(manifest: string): string[] {
  const read = parseKinds(manifest, 'madarch/catalog.yaml', TEMPLATES);
  return read.findings.map((finding) => `${finding.line}: ${finding.message}`);
}

describe('the roles are the product\'s own, and the POV covers the catalog', () => {
  test('an area no role leads is refused, naming the area and the roles', () => {
    expect(findings(withRoles(['  product: { lead: [] }']))).toEqual([
      expect.stringContaining('area "area": no role leads it, and every area is led by a role or by one of its subgroups (the roles are product)'),
    ] as unknown as string[]);
  });

  test('a role that leads a subgroup leads its area, and a role may lead several areas', () => {
    expect(findings(withRoles(['  product: { lead: [area.one] }', '  designer: { lead: [area.two] }']))).toEqual([]);
    expect(findings(withRoles(['  product: { lead: [area] }']))).toEqual([]);
  });

  test('a role naming an area or a subgroup the manifest does not declare is refused, naming the role', () => {
    expect(findings(withRoles(['  product: { lead: [area.one, nowhere] }', '  designer: { lead: [area.two] }']))).toEqual([
      expect.stringContaining('role "product": "nowhere" is not a group of "groups"'),
    ] as unknown as string[]);
  });

  test('a role\'s name is one word, and "everything" is every role at once and is not declared', () => {
    expect(findings(withRoles(['  "security engineer": { lead: [area] }']))).toEqual([
      expect.stringContaining('role "security engineer": a role\'s name is one word without whitespace'),
    ] as unknown as string[]);
    expect(findings(withRoles(['  everything: { lead: [area] }']))).toEqual([
      expect.stringContaining('role "everything": "everything" is every role at once and is not declared'),
    ] as unknown as string[]);
    expect(findings(withRoles(['  security-engineer: { lead: [area] }']))).toEqual([]);
  });

  test('a manifest with no roles declared has no POV to check, and a catalog is still read', () => {
    expect(findings(SMALL)).toEqual([]);
  });

  test('a role\'s declaration and its lead list are checked, each at its own line', () => {
    expect(findings(withRoles(['  product: 7']))).toEqual([expect.stringContaining('role "product": the declaration is { open: [<block>, ...], lead: [<group>, ...] }')] as unknown as string[]);
    expect(findings(withRoles(['  product: { lead: area }']))).toEqual([expect.stringContaining('role "product": "lead" is a list of groups of "groups"')] as unknown as string[]);
    expect(findings(withRoles(['  product: { lead: [area], mood: yes }']))).toEqual([expect.stringContaining('role "product": "mood" is not a field of a role: the fields are "open" and "lead"')] as unknown as string[]);
    // The finding stands at the line of the role, or of the field it is about, never at the block's top.
    const planted = withRoles(['  product: { lead: [nowhere] }', '  designer: { lead: [area] }']);
    const read = parseKinds(planted, 'madarch/catalog.yaml', TEMPLATES);
    expect(read.findings.map((finding) => finding.line)).toEqual([planted.split('\n').findIndex((one) => one.startsWith('  product:')) + 1]);
  });

  test('a role is left out when its declaration has a problem, and the rest of the roles stand', () => {
    const read = parseKinds(withRoles(['  product: { lead: [nowhere] }', '  designer: { lead: [area] }']), 'madarch/catalog.yaml', TEMPLATES);
    expect([...read.roles.keys()]).toEqual(['designer']);
  });

  test('the starter set declares ten roles and every area is led', () => {
    const read = parseKinds(starterManifestText(), 'madarch/catalog.yaml', TEMPLATES);
    expect(read.findings).toEqual([]);
    expect([...read.roles.keys()]).toEqual(['product', 'analyst', 'architect', 'developer', 'operations', 'tester', 'designer', 'security-engineer', 'platform-devops', 'product-lead']);
    const led = new Set([...read.roles.values()].flatMap((role) => role.lead));
    const areas = [...read.groups.values()].filter((group) => group.parent === undefined);
    expect(areas.filter((area) => !led.has(area.name) && ![...read.groups.values()].some((subgroup) => subgroup.parent === area.name && led.has(subgroup.name))).map((area) => area.name)).toEqual([]);
  });
});
