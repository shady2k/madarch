import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds, readKinds } from '../src/product/manifest/kinds.js';
import { buildFacts } from '../src/knowledge/facts.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import type { GraphEntity } from '../src/knowledge/graph-read.js';

const folder = mkdtempSync(join(tmpdir(), 'facts-contract-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
writeFileSync(join(folder, 'page.liquid'), '{{ title }}');
const prefix = `roles:
  developer: { lead: [] }
  architect: { lead: [] }
  manager: { lead: [] }
`;
const declaration = `template: page.liquid
source: graph
fields:
- { name: language, type: text, producers: [fixture] }
- { name: bytes, type: integer, producers: [fixture] }
- { name: changed, type: timestamp, producers: [fixture] }
audience: [developer, architect]
facts:
- { id: count, labels: { en: Files, ru: Файлы }, measure: count, display: number }
- { id: languages, labels: { en: Languages, ru: Языки }, measure: group-by, field: language, display: bar }
- { id: age, labels: { en: Age, ru: Возраст }, measure: histogram, field: changed, buckets: [30, 90], display: timeline }
- { id: largest, labels: { en: Largest, ru: Большие }, measure: top-n, field: bytes, limit: 2, display: bar, audience: [manager] }
`;
function parse(body = declaration) {
  return parseKinds(prefix + 'kinds:\n  sample:\n' + body.split('\n').filter(Boolean).map((line) => '    ' + line).join('\n'), 'manifest.yaml', folder);
}
function entity(n: number, properties: Record<string, unknown>): GraphEntity {
  return { key: `sample:${String(n).padStart(4, '0')}`, kind: 'sample', label: `File ${n}`, properties, nodeIds: [], scope: 'fixture' };
}
const now = new Date('2026-11-12T00:00:00Z');
function ctx(rows: GraphEntity[], manifest = parse()): RenderContext {
  return { manifest, graph: { list: async (kind: string, options: { after?: string; limit: number }) => {
    const tail = rows.filter((row) => row.kind === kind && (options.after === undefined || row.key > options.after));
    return { rows: tail.slice(0, options.limit), next: tail.length > options.limit ? tail[options.limit - 1]!.key : null, total: rows.length };
  } } } as unknown as RenderContext;
}

test('contract validates roles, measures, translations, field types and bounds without hiding bad facts', () => {
  expect(parse().findings).toEqual([]);
  for (const [from, to] of [
    ['audience: [developer, architect]', 'audience: [unknown]'],
    ['measure: count', 'measure: interpret'],
    ['en: Files, ru: Файлы', 'en: Files'],
    ['field: language', 'field: absent'],
    ['field: changed', 'field: bytes'],
    ['buckets: [30, 90]', 'buckets: [90, 30]'],
    ['limit: 2', 'limit: 0'],
    ['display: number', 'display: sparkles'],
    ['display: number', 'display: bar'],
    ['display: bar', 'display: number'],
  ]) {
    const manifest = parse(declaration.replace(from!, to!));
    expect(manifest.kinds.size).toBe(0);
    expect(manifest.findings.length).toBeGreaterThan(0);
    expect(manifest.findings.every((finding) => finding.file === 'manifest.yaml' && finding.line > 0)).toBe(true);
  }
});

test('role facts are grounded statements; missing and conflicting values are explicit, not interpreted', async () => {
  const context = ctx([
    entity(1, { language: 'TS', bytes: 10, changed: '2026-11-01T00:00:00Z' }),
    entity(2, { language: 'TS', bytes: 20, changed: '2026-10-01T00:00:00Z' }),
    entity(3, { language: 'Go', bytes: 20, changed: '2026-01-01T00:00:00Z' }),
    entity(4, { language: ['Go', 'TS'], bytes: null, changed: null }),
  ]);
  const developer = await buildFacts(context, 'developer', 'en', now);
  const facts = developer.kinds[0]!.statements;
  expect(facts.map((fact) => fact.id)).toEqual(['fact:sample/count', 'fact:sample/languages', 'fact:sample/age']);
  expect(facts[0]!.value).toBe(4);
  expect(facts[1]!.rows).toEqual([{ label: 'TS', value: 2 }, { label: 'Go', value: 1 }]);
  expect(facts[1]!.ground.missing).toBe(1);
  expect(facts[2]!.rows.map((row) => row.value)).toEqual([1, 1, 1]);
  for (const fact of facts) {
    expect(fact.statement.grounded).toBe(true);
    expect(fact.statement.aggregate).toEqual(fact.ground);
    expect(fact.ground.entities).toHaveLength(4);
    expect(fact.ground.computedAt).toBe(now.toISOString());
  }
  const manager = await buildFacts(context, 'manager', 'en', now);
  expect(manager.kinds[0]!.statements.map((fact) => fact.id)).toEqual(['fact:sample/largest']);
  expect(manager.kinds[0]!.statements[0]!.rows.map((row) => row.entity)).toEqual(['sample:0002', 'sample:0003']);
  expect((await buildFacts(context, 'everything', 'ru', now)).kinds[0]!.statements[0]!.label).toBe('Файлы');
});

test('reads the complete graph across pages and keeps kind/fact manifest order', async () => {
  const manifest = parse();
  (manifest.kinds as Map<string, import('../src/product/manifest/kinds.js').KindDecl>).set('other', { ...manifest.kinds.get('sample')!, name: 'other' });
  const context = ctx(Array.from({ length: 1001 }, (_, n) => entity(n, {})), manifest);
  const facts = await buildFacts(context, 'developer', 'en', now);
  expect(facts.kinds.map((kind) => kind.kind)).toEqual(['sample', 'other']);
  expect(facts.kinds[0]!.statements[0]!.value).toBe(1001);
  expect(facts.kinds[0]!.statements[0]!.ground.entities).toHaveLength(1001);
  expect(facts.kinds[1]!.statements[0]!.value).toBe(0);
});

test('editing the product kind file changes facts after rereading without a code change', async () => {
  mkdirSync(join(folder, 'madarch', 'kinds', 'example', 'structure'), { recursive: true });
  writeFileSync(join(folder, 'madarch', 'catalog.yaml'), prefix + 'groups:\n  example.structure: { en: Structure, ru: Структура }\n');
  const path = join(folder, 'madarch', 'kinds', 'example', 'structure', 'sample.yaml');
  writeFileSync(path, declaration);
  const first = readKinds(folder);
  expect(first.present).toBe(true);
  if (!first.present) throw new Error('manifest absent');
  expect(first.manifest.findings).toEqual([]);
  expect((await buildFacts(ctx([], first.manifest), 'developer')).kinds[0]!.statements[0]!.label).toBe('Files');
  writeFileSync(path, declaration.replace('en: Files', 'en: Source files'));
  const second = readKinds(folder);
  if (!second.present) throw new Error('manifest absent');
  expect((await buildFacts(ctx([], second.manifest), 'developer')).kinds[0]!.statements[0]!.label).toBe('Source files');
});


test('a fact counts only the entities its declared condition names, and null matches a field no opinion states', async () => {
  const conditioned = declaration
    .replace('- { name: changed, type: timestamp, producers: [fixture] }', '- { name: changed, type: timestamp, producers: [fixture] }\n- { name: removed, type: timestamp, producers: [fixture] }')
    .replace('- { id: count, labels: { en: Files, ru: Файлы }, measure: count, display: number }', '- { id: count, labels: { en: Files, ru: Файлы }, measure: count, display: number, where: { removed: null } }');
  const manifest = parse(conditioned);
  expect(manifest.findings).toEqual([]);
  const context = ctx([
    entity(1, { language: 'TS' }),
    entity(2, { language: 'Go', removed: '2026-01-01T00:00:00Z' }),
  ], manifest);
  const facts = await buildFacts(context, 'developer', 'en', now);
  const count = facts.kinds[0]!.statements.find((fact) => fact.id === 'fact:sample/count')!;
  expect(count.value).toBe(1);
  expect(count.ground.total).toBe(1);
  expect(count.ground.entities).toEqual(['sample:0001']);
  expect(count.ground.where).toEqual({ removed: null });
});
