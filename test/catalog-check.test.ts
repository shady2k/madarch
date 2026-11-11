/**
 * The catalog check of the starter set (decision 0033, items 8 to 10): `bun run check:catalog` checks the
 * entity catalog `madarch new` writes, and refuses a kind that leaves a field out, a subgroup above its
 * bound, two kinds of one concept id, a value the catalog marks as an attribute declared as a kind, and an
 * area, a subgroup or an origin mark the manifest does not declare. Every refusal names the file, the line
 * and the kind. A kind the catalog marks with the template policy `none` is catalogue data only: the wiki
 * shows no page for it. Fixtures only: the starter set written into a temporary product.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { parseKinds } from '../src/knowledge/kinds.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-catalog.ts');
const MANIFEST = STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content;

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
    writeFileSync(path, file.path === 'madarch/kinds.yaml' && manifest !== undefined ? manifest : file.content);
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
    '    definition: "A kind the check is asked about."',
    '    sources: ["https://example.test/kind"]',
    `    acquisition: ${row.acquisition}`,
    '    status: not-implemented',
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

describe('the catalog check over the starter set', () => {
  test('the starter set `madarch new` writes passes, and the run names the counts it read', () => {
    const done = run();
    expect(done.err).toBe('');
    expect(done.code).toBe(0);
    expect(done.out).toContain('catalog: 28 areas, 106 subgroups, 516 kinds (70 with a page of their own or a member\'s row)');
    expect(done.out).toContain(join('madarch', 'kinds.yaml'));
  }, 30_000);

  test('a kind that leaves a field out is refused, naming the file, the line and the kind', () => {
    const folder = product(editField(MANIFEST, 'code.service', 'status', null));
    const done = run(folder);
    expect(done.code).toBe(1);
    const file = join(folder, 'madarch', 'kinds.yaml');
    const line = readFileSync(file, 'utf8').split('\n').findIndex((text) => text.startsWith('  code.service:')) + 1;
    expect(done.err).toContain(`${file}:${line}: kind "code.service": "status" is one of implemented, partial, not-implemented`);
  }, 30_000);

  test('the same row is refused by the wiki\'s own read of the manifest, which is the product-wiki check', () => {
    const manifest = editField(MANIFEST, 'code.service', 'status', null);
    const read = parseKinds(manifest, 'madarch/kinds.yaml', product());
    expect(read.catalog!.findings.map((finding) => finding.message)).toEqual(['kind "code.service": "status" is one of implemented, partial, not-implemented, got undefined']);
    // One defect is one problem: the kind's refused row is the finding, and the mapping's row for it is not echoed.
    expect(read.findings.map((finding) => finding.message)).toEqual(['kind "code.service": "status" is one of implemented, partial, not-implemented, got undefined']);
    // The kind is left out of the catalog and of the wiki\'s kinds, and the rest of the catalog stands.
    expect(read.catalog!.kinds.has('code.service')).toBe(false);
    expect(read.kinds.has('code.service')).toBe(false);
    expect(read.catalog!.kinds.has('code.file')).toBe(true);
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
    expect(done.err).toContain('kind "tests.duplicate": the concept id "c4.container" is the id of kind "code.service"');
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
    const read = parseKinds(MANIFEST, 'madarch/kinds.yaml', product());
    expect(read.findings).toEqual([]);
    expect(read.catalog!.kinds.get('firewall-rule')).toMatchObject({ templatePolicy: 'none', status: 'not-implemented', subgroup: 'infrastructure.network', area: 'infrastructure' });
    expect(read.kinds.has('firewall-rule')).toBe(false);
    expect(read.kinds.has('code.service')).toBe(true);
  }, 30_000);
});
