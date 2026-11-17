import { starterManifestText, writeFolderManifest } from './catalog-folder-fixture.js';
/**
 * The catalog check of the starter set (decision 0033, items 8 to 10): `bun run check:catalog` checks the
 * entity catalog `madarch init` writes, and refuses a kind that leaves a field out, a subgroup above its
 * bound, two kinds of one concept id, a value the catalog marks as an attribute declared as a kind, and an
 * area, a subgroup or an origin mark the manifest does not declare. Every refusal names the file, the line
 * and the kind. A kind the catalog marks with the template policy `none` is catalogue data only: the wiki
 * shows no page for it. Fixtures only: the starter set written into a temporary product.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { CATALOG_KINDS } from '../src/knowledge/catalog-starter.js';
import { parse, stringify } from 'yaml';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-catalog.ts');
const MANIFEST = starterManifestText();

const made: string[] = [];
afterAll(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A product folder holding the starter set, its manifest written as `manifest` says. */
function product(manifest?: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-catalog-check-'));
  made.push(folder);
  for (const file of STARTER_FILES) {
    const path = join(folder, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes ?? file.content);
  }
  if (manifest !== undefined) {
    writeFolderManifest(folder, manifest);
  }
  return folder;
}

interface Run {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** `bun scripts/check-catalog.ts --folder <folder>`, as a person runs it. */
function run(folder?: string): Run {
  const command = folder === undefined ? ['bun', SCRIPT] : ['bun', SCRIPT, '--folder', folder];
  const done = Bun.spawnSync(command, { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
}

/** The line `field:` of a kind's declaration replaced, added or dropped. */
function editField(manifest: string, kind: string, field: string, value: string | null): string {
  const lines = manifest.split('\n');
  const start = lines.indexOf(`  ${kind}:`);
  if (start < 0) throw new Error(`the starter set declares no kind ${kind}`);
  let end = start + 1;
  while (end < lines.length && lines[end]!.startsWith('    ')) end += 1;
  const held = lines.slice(start + 1, end);
  const at = held.findIndex((line) => line.trimStart().startsWith(`${field}:`));
  const written = value === null ? held.filter((_line, index) => index !== at) : at < 0 ? [...held, `    ${field}: ${value}`] : held.map((line, index) => (index === at ? `    ${field}: ${value}` : line));
  return [...lines.slice(0, start + 1), ...written, ...lines.slice(end)].join('\n');
}

/** One catalogue-only kind appended to the `kinds:` section of the manifest, after the kinds it holds. */
function appended(manifest: string, kind: string, row: { id: string; group: string; acquisition: string }): string {
  const lines = manifest.split('\n');
  const start = lines.indexOf('kinds:');
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || lines[end]!.startsWith('  '))) end += 1;
  return [
    ...lines.slice(0, end),
    `  ${kind}:`,
    `    id: ${row.id}`,
    `    group: ${row.group}`,
    '    purpose: understand',
    '    definition: "A kind the check is asked about."',
    '    sources: ["https://example.test/kind"]',
    `    acquisition: ${row.acquisition}`,
    '    relation-constraints: { out: [], in: [] }',
    '    template-policy: none',
    '    labels:',
    '      en: { one: Probe, many: Probes }',
    '      ru: { one: Проба, many: Пробы }',
    '    description:',
    '      en: A kind the check is asked about.',
    '      ru: Вид, о котором спрашивают проверку.',
    ...lines.slice(end),
  ].join('\n');
}

/** One edge kind's `labels` block removed, leaving the edge without words. */
function edgeWithoutLabels(manifest: string, edge: string): string {
  const fixture = parse(manifest);
  const declaration = fixture.edges.find((row: { name: string }) => row.name === edge);
  if (!declaration) throw new Error(`the starter set declares no edge ${edge}`);
  delete declaration.labels;
  return stringify(fixture, { lineWidth: 0 });
}

describe('the catalog check over the starter set', () => {
  test('the starter set `madarch init` writes passes, and the run names the counts it read', () => {
    const done = run();
    expect(done.err).toBe('');
    expect(done.code).toBe(0);
    expect(done.out).toContain(`catalog: 28 areas, 106 subgroups, ${CATALOG_KINDS.length} kinds (${CATALOG_KINDS.filter((kind) => kind.policy !== 'none').length} with a page of their own or a member's row)`);
    expect(done.out).toContain('catalog: 5 edges waiting for a page kind');
    for (const name of ['architecture.serves-domain', 'data-catalog.contains', 'organization.contains', 'software-system.contains', 'token-group.contains']) {
      expect(done.out).toContain(`edge "${name}": waiting for a page kind`);
    }
    expect(done.out).toContain(join('madarch', 'catalog.yaml'));
  }, 30_000);

  test('a kind that leaves a field out is refused, naming the file, the line and the kind', () => {
    const folder = product(editField(MANIFEST, 'code.service', 'definition', null));
    const done = run(folder);
    expect(done.code).toBe(1);
    const file = join(folder, 'madarch/kinds/code/structure/code.service.yaml');
    const line = 1;
    expect(done.err).toContain(`${file}:${line}: kind "code.service": "definition" is one sentence saying what the kind is`);
  }, 30_000);

  test('the same row is refused by the wiki\'s own read of the manifest, which is the product-wiki check', () => {
    const manifest = editField(appended(MANIFEST, 'probe.catalogue', { id: 'practice.probe-catalogue', group: 'code.schema', acquisition: '[conversation]' }), 'probe.catalogue', 'definition', null);
    const read = parseKinds(manifest, 'madarch/catalog.yaml', product());
    expect(read.catalog!.findings.map((finding) => finding.message)).toEqual(['kind "probe.catalogue": "definition" is one sentence saying what the kind is, got undefined']);
    // One defect is one problem: the kind's refused row is the finding, and the mapping's row for it is not echoed.
    expect(read.findings.map((finding) => finding.message)).toEqual(['kind "probe.catalogue": "definition" is one sentence saying what the kind is, got undefined']);
    // The kind is left out of the catalog and of the wiki\'s kinds, and the rest of the catalog stands.
    expect(read.catalog!.kinds.has('probe.catalogue')).toBe(false);
    expect(read.kinds.has('probe.catalogue')).toBe(false);
    expect(read.catalog!.kinds.has('code.file')).toBe(true);
  }, 30_000);

  test('an edge kind without both languages of words is refused, naming the file, the line and the edge', () => {
    const folder = product(edgeWithoutLabels(MANIFEST, 'domain.covers'));
    const done = run(folder);
    expect(done.code).toBe(1);
    expect(done.err).toContain('edge "domain.covers": "labels" names the words the edge reads as at each end');
    expect(done.err).toMatch(/madarch\/catalog\.yaml:\d+: edge "domain\.covers"/u);
  }, 30_000);

  test('a subgroup above its bound is refused, naming the subgroup and the kinds it holds', () => {
    const overflow = appended(MANIFEST, 'tests.overflow', { id: 'practice.overflow', group: 'infrastructure.orchestration', acquisition: '["conversation", "not-implemented"]' });
    const done = run(product(overflow));
    expect(done.code).toBe(1);
    expect(done.err).toContain('subgroup "infrastructure.orchestration": 13 kinds (');
    expect(done.err).toContain(', above the bound of 12 a subgroup holds ("catalog: subgroup-kind-bound")');
  }, 30_000);

  test('two kinds for one concept id are refused, naming both kinds', () => {
    const twice = appended(MANIFEST, 'tests.duplicate', { id: 'c4.container', group: 'code.schema', acquisition: '["conversation", "not-implemented"]' });
    const done = run(product(twice));
    expect(done.code).toBe(1);
    expect(done.err).toContain('the concept id "c4.container"');
    expect(done.err).toContain('"code.service"');
    expect(done.err).toContain('"tests.duplicate"');
  }, 30_000);

  test('a value the catalog marks as an attribute, declared as a kind, is refused', () => {
    const attribute = appended(MANIFEST, 'tests.attribute', { id: 'version', group: 'code.schema', acquisition: '["conversation", "not-implemented"]' });
    const done = run(product(attribute));
    expect(done.code).toBe(1);
    expect(done.err).toContain('kind "tests.attribute": "version" is a value the catalog marks as an attribute ("catalog.attributes"), not a kind');
  }, 30_000);

  test('an unknown origin mark is refused, naming the marks the catalog declares', () => {
    const telepathy = appended(MANIFEST, 'tests.acquisition', { id: 'practice.acquired-by-telepathy', group: 'code.schema', acquisition: '["telepathy"]' });
    const done = run(product(telepathy));
    expect(done.code).toBe(1);
    expect(done.err).toContain('kind "tests.acquisition": "acquisition" holds "telepathy", which is not an acquisition of this catalog: "extractor <id>" or one of document, conversation, agent-from-graph, live-system, not-implemented');
  }, 30_000);

  test('an unknown subgroup is refused, naming the kind and the groups the manifest declares', () => {
    const done = run(product(editField(MANIFEST, 'code.service', 'group', 'nowhere.at-all')));
    expect(done.code).toBe(1);
    expect(done.err).toContain('kind "code.service": "group" names the subgroup of the catalog the kind belongs to, and "groups" declares no "nowhere.at-all"');
  }, 30_000);

  test('an unknown area is refused, naming the subgroup\'s missing parent and the kinds it holds', () => {
    const manifest = MANIFEST.split('\n').map((line) => (line.startsWith('  infrastructure.network: ') ? line.replace('parent: infrastructure', 'parent: nowhere') : line)).join('\n');
    expect(manifest).not.toBe(MANIFEST);
    const done = run(product(manifest));
    expect(done.code).toBe(1);
    expect(done.err).toContain('group "infrastructure.network": "parent" names a group of "groups"');
    // One defect is one problem: the group's refused parent is the finding, and the kinds in it do not repeat it.
    expect(done.err.trim().split('\n').filter((line) => line.includes('kind "'))).toEqual([]);
  }, 30_000);

  test('a kind the catalog marks with the template policy none is catalogue data only: the wiki shows no page for it', () => {
    const read = parseKinds(MANIFEST, 'madarch/catalog.yaml', product());
    expect(read.findings).toEqual([]);
    expect(read.catalog!.kinds.get('firewall-rule')).toMatchObject({ templatePolicy: 'none', subgroup: 'infrastructure.network', area: 'infrastructure' });
    expect(read.kinds.has('firewall-rule')).toBe(false);
    expect(read.kinds.has('code.service')).toBe(true);
  }, 30_000);
});
