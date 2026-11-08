/**
 * The extractors' vocabulary mapped to the catalog (decision 0033, item 7): `src/knowledge/mapping.ts` reads the
 * `mapping:` section of a product's manifest and refuses an emitted kind or relation no row ties, a row that ties
 * one to a catalog kind or relation the catalog does not hold, a row for a key no extractor emits, and a row that
 * is neither a tie nor an internal declaration with the reason — naming both sides, the file and the line.
 *
 * Fixtures only: a small catalog and mapping written by the test, and the starter set's own manifest read once.
 */
import { describe, expect, test } from 'bun:test';
import { EXTRACTOR_KINDS, EXTRACTOR_RELATIONS } from '../src/extract/vocabulary.js';
import { readMapping } from '../src/knowledge/mapping.js';
import { LineCounter, parseDocument } from 'yaml';
import { lineForPath } from '../src/model/yaml-position.js';
import { readCatalogKind, readCatalogSchema } from '../src/knowledge/catalog.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { parseKinds } from '../src/knowledge/kinds.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SMALL = [
  'catalog:',
  '  subgroup-kind-bound: 12',
  '  attributes: [version]',
  '  origin-marks: [document, conversation, not-implemented]',
  '  extractor-mark: extractor',
  '  statuses: [implemented, not-implemented]',
  '  template-policies: [page, member, none]',
  '  relations:',
  '    contains:',
  '    uses:',
  '    internal-thing: "https://example.test/relation"',
  'groups:',
  '  area: { en: Area, ru: Область, short: { en: Area, ru: Область }, open: true }',
  '  area.one: { en: One, ru: Один, short: { en: One, ru: Один }, parent: area }',
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
  'mapping:',
  '  version: 1',
  '  kinds:',
  '    code.symbol: { kind: code.symbol }',
  '  relations:',
  '    code.contains: { relation: contains, direction: same }',
  '',
].join('\n');

/** The emitted vocabulary of a test: two keys a side can extend, so a "new" kind is proved without touching code. */
const EMITTED = {
  kinds: new Map([['code.symbol', ['code.extract.code']], ['code.new-thing', ['code.extract.code']]]),
  relations: new Map([['code.contains', ['code.extract.code']], ['code.fresh-link', ['code.extract.code']]]),
};

/** The mapping of one manifest, read against the small catalog and the emitted vocabulary the test names. */
function read(text: string, emitted: { kinds: ReadonlyMap<string, readonly string[]>; relations: ReadonlyMap<string, readonly string[]> } = EMITTED): { findings: string[]; mapped: number; internal: number; rows: [string, string, string | undefined][] } {
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  const at = (path: (string | number)[]): number => lineForPath(document, lines, path);
  const findings: { file: string; line: number; message: string }[] = [];
  const schema = readCatalogSchema((document.toJS() as Record<string, unknown>)['catalog'], at, 'madarch/kinds.yaml');
  const groups = new Map<string, { name: string; parent?: string; line: number }>();
  const raw = (document.toJS() as { groups?: Record<string, { parent?: string }> });
  for (const [name, entry] of Object.entries(raw.groups ?? {})) groups.set(name, { name, ...(entry.parent === undefined ? {} : { parent: entry.parent }), line: at(['groups', name]) });
  const kinds = new Map();
  const declared = (document.toJS() as { kinds?: Record<string, Record<string, unknown>> }).kinds ?? {};
  for (const [name, decl] of Object.entries(declared)) {
    if (schema.schema === undefined) break;
    const entry = readCatalogKind(name, decl, schema.schema, groups, at(['kinds', name]), () => undefined, ['en', 'ru']);
    if (entry !== undefined) kinds.set(name, entry);
  }
  const mapping = readMapping((document.toJS() as Record<string, unknown>)['mapping'], at, 'madarch/kinds.yaml', schema.schema === undefined ? undefined : { schema: schema.schema, kinds }, emitted);
  findings.push(...mapping.findings);
  const rows = [...mapping.kinds.values(), ...mapping.relations.values()];
  return {
    findings: findings.map((finding) => `${finding.line}: ${finding.message}`),
    mapped: rows.filter((row) => row.tie !== 'internal').length,
    internal: rows.filter((row) => row.tie === 'internal').length,
    rows: rows.map((row) => [row.key, row.tie, row.direction] as [string, string, string | undefined]),
  };
}

/** The small manifest with one line replaced or dropped. */
function line(text: string, prefix: string, written: string | null): string {
  const held = text.split('\n');
  const at = held.findIndex((one) => one.startsWith(prefix));
  if (at < 0) throw new Error(`the fixture holds no line starting ${prefix}`);
  return written === null ? [...held.slice(0, at), ...held.slice(at + 1)].join('\n') : [...held.slice(0, at), written, ...held.slice(at + 1)].join('\n');
}

/** The small manifest with one row added to a section of the mapping, after the rows it already holds. */
function rowIn(text: string, section: 'kinds' | 'relations', row: string): string {
  const held = text.split('\n');
  // The mapping's own section, not the catalog's `relations:` above it.
  const from = held.indexOf('mapping:');
  const start = held.indexOf(`  ${section}:`, from < 0 ? 0 : from);
  if (start < 0) throw new Error(`the fixture mapping holds no ${section}`);
  let end = start + 1;
  while (end < held.length && held[end]!.startsWith('    ')) end += 1;
  return [...held.slice(0, end), row, ...held.slice(end)].join('\n');
}

/** The small manifest without one section of the mapping, its rows and all. */
function removeSection(text: string, section: 'kinds' | 'relations'): string {
  const held = text.split('\n');
  const from = held.indexOf('mapping:');
  const start = held.indexOf(`  ${section}:`, from);
  let end = start + 1;
  while (end < held.length && held[end]!.startsWith('    ')) end += 1;
  return [...held.slice(0, start), ...held.slice(end)].join('\n');
}

/** The small manifest with every key of the emitted vocabulary tied or declared internal. */
function complete(text: string): string {
  const kinds = rowIn(text, 'kinds', '    code.new-thing: { internal: "a reading of the file the extractor emits, not a catalog kind" }');
  return rowIn(kinds, 'relations', '    code.fresh-link: { internal: "one positioned site a name is read at" }');
}

describe('the mapping ties the extractors\' vocabulary to the catalog', () => {
  test('a complete mapping is read, and its rows are counted as tied or internal', () => {
    const read1 = read(complete(SMALL));
    expect(read1.findings).toEqual([]);
    expect([read1.mapped, read1.internal]).toEqual([2, 2]);
  });

  test('an extractor kind or relation with no row is refused, naming the extractor that emits it', () => {
    const { findings } = read(SMALL);
    expect(findings).toEqual([
      expect.stringContaining('kind "code.new-thing": the extractor "code.extract.code" emits it, and the mapping ties no row to it'),
      expect.stringContaining('relation "code.fresh-link": the extractor "code.extract.code" emits it, and the mapping ties no row to it'),
    ] as unknown as string[]);
  });

  test('a row that ties an extractor kind to a kind the catalog does not hold is refused, naming both', () => {
    const text = rowIn(rowIn(SMALL, 'kinds', '    code.new-thing: { kind: code.nowhere }'), 'relations', '    code.fresh-link: { relation: contains, direction: same }');
    // The refused row leaves the key untied, so the missing row is named too.
    expect(read(text).findings).toContainEqual(expect.stringContaining('kind "code.new-thing": the mapping ties it to the kind "code.nowhere", and the catalog holds no such kind (its kinds are code.symbol)'));
  });

  test('a row that ties an extractor relation to a relation the catalog does not hold is refused, naming both', () => {
    const text = rowIn(rowIn(SMALL, 'kinds', '    code.new-thing: { relation: contains }'), 'relations', '    code.fresh-link: { relation: flies, direction: same }');
    expect(read(text).findings).toContainEqual(expect.stringContaining('kind "code.new-thing": "relation" is not a field of a kind\'s row: a kind is tied to the catalog\'s kind, or declared internal'));
    expect(read(text).findings).toContainEqual(expect.stringContaining('relation "code.fresh-link": the mapping ties it to the relation "flies", and the catalog holds no such relation ("catalog.relations": contains, internal-thing, uses)'));
  });

  test('a row for a key no extractor emits is refused as stale', () => {
    const text = rowIn(complete(SMALL), 'kinds', '    code.gone: { internal: "a reading of something nobody emits" }');
    expect(read(text).findings).toEqual([
      expect.stringContaining('kind "code.gone": no extractor emits it, and the mapping names it: remove the row (the emitted kinds are code.new-thing, code.symbol)'),
    ] as unknown as string[]);
  });

  test('a row that is neither a tie nor an internal declaration with a reason is refused', () => {
    const both = rowIn(complete(SMALL), 'kinds', '    code.new-thing: { kind: code.symbol, internal: "no" }');
    expect(read(both).findings).toContainEqual(expect.stringContaining('kind "code.new-thing": the row names exactly one of kind, relation, internal, and it names kind and internal'));
    const empty = rowIn(complete(SMALL), 'kinds', '    code.new-thing: { internal: "" }');
    expect(read(empty).findings).toContainEqual(expect.stringContaining('kind "code.new-thing": "internal" is the reason the key is extraction\'s own'));
    const blank = rowIn(complete(SMALL), 'kinds', '    code.new-thing: { internal: "   " }');
    expect(read(blank).findings).toContainEqual(expect.stringContaining('"internal" is the reason the key is extraction'));
    const unknown = rowIn(complete(SMALL), 'kinds', '    code.new-thing: { kind: code.symbol, reason: "no" }');
    expect(read(unknown).findings).toContainEqual(expect.stringContaining('kind "code.new-thing": "reason" is not a field of a mapping row'));
  });

  test('a version this engine does not read is refused, naming the versions it reads', () => {
    const text = line(SMALL, '  version: 1', '  version: 7');
    const findings = read(complete(text)).findings;
    expect(findings).toContainEqual(expect.stringContaining('"version" is a version of the mapping this engine reads (1), got 7'));
  });

  test('a mapping on a manifest that declares no catalog is refused', () => {
    const without = SMALL.slice(SMALL.indexOf('groups:'));
    expect(read(without).findings).toContainEqual(expect.stringContaining('"mapping" ties the extractors\' vocabulary to the catalog, and the manifest declares no "catalog"'));
  });

  test('the mechanism reads the extractors\' declaration, so a kind an extractor starts emitting is refused until mapped', () => {
    // A test adds a kind to the emitted vocabulary the way an extractor declares one: no list in the check changes.
    const extended = { kinds: new Map([...EMITTED.kinds, ['code.cache', ['code.extract.operations']]]), relations: EMITTED.relations };
    expect(read(complete(SMALL), extended).findings).toContainEqual(expect.stringContaining('kind "code.cache": the extractor "code.extract.operations" emits it, and the mapping ties no row to it'));
  });

  test('a mapping that is not a mapping, a section it leaves out and a version it leaves out are refused', () => {
    expect(read('mapping: 7\n' + SMALL.slice(0, SMALL.indexOf('catalog:'))).findings).toContainEqual(expect.stringContaining('"mapping" ties every kind and relation the extractors emit to a catalog kind or relation, or declares it internal: { version, kinds, relations }'));
    const noKinds = removeSection(SMALL, 'kinds');
    expect(read(noKinds).findings).toContainEqual(expect.stringContaining('"kinds" maps every node kind the extractors emit to the catalog, or declares it internal'));
    const noRelations = removeSection(SMALL, 'relations');
    expect(read(noRelations).findings).toContainEqual(expect.stringContaining('"relations" maps every relation type the extractors emit to the catalog, or declares it internal'));
    const noVersion = line(SMALL, '  version: 1', null);
    expect(read(complete(noVersion)).findings).toContainEqual(expect.stringContaining('"version" is a version of the mapping this engine reads (1), got undefined'));
  });

  test('a row that is not a row, and an unknown field of the mapping, are refused', () => {
    expect(read(rowIn(complete(SMALL), 'kinds', '    code.new-thing: 7')).findings).toContainEqual(expect.stringContaining('kind "code.new-thing": the row is { kind } or { internal }'));
    expect(read(line(SMALL, '  version: 1', '  version: 1\n  stamp: 2026-11-04')).findings).toContainEqual(expect.stringContaining('"stamp" is not a field of the mapping: the fields are version, kinds and relations'));
  });

  test('a missing row stands at the section it belongs to, and a refused row at its own line', () => {
    const findings = read(SMALL).findings;
    const lines = SMALL.split('\n');
    const from = lines.indexOf('mapping:');
    expect(findings.map((finding) => Number(finding.slice(0, finding.indexOf(':'))))).toEqual([lines.indexOf('  kinds:', from) + 1, lines.indexOf('  relations:', from) + 1]);
    const bad = rowIn(SMALL, 'kinds', '    code.new-thing: { kind: code.nowhere }');
    const refused = read(bad).findings[0]!;
    expect(Number(refused.slice(0, refused.indexOf(':')))).toBe(bad.split('\n').indexOf('    code.new-thing: { kind: code.nowhere }') + 1);
  });

  test('a tied relation says which way it runs, and a row that does not is refused', () => {
    const noDirection = rowIn(complete(SMALL), 'relations', '    code.fresh-link: { relation: contains }');
    expect(read(noDirection).findings).toContainEqual(expect.stringContaining('relation "code.fresh-link": "direction" is same or inverse: whether the extractor\'s edge runs with the catalog\'s "contains" or against it, got undefined'));
    const wrong = rowIn(complete(SMALL), 'relations', '    code.fresh-link: { relation: contains, direction: sideways }');
    expect(read(wrong).findings).toContainEqual(expect.stringContaining('relation "code.fresh-link": "direction" is same or inverse'));
    const backwards = rowIn(rowIn(SMALL, 'relations', '    code.fresh-link: { relation: contains, direction: inverse }'), 'kinds', '    code.new-thing: { internal: "a reading" }');
    expect(read(backwards).findings).toEqual([]);
    expect(read(backwards).rows.filter((row) => row[0].startsWith('code.fresh') || row[0] === 'code.contains')).toEqual([['code.contains', 'relation', 'same'], ['code.fresh-link', 'relation', 'inverse']]);
  });

  test('a direction on a kind\'s row or on an internal row is refused', () => {
    expect(read(rowIn(complete(SMALL), 'kinds', '    code.new-thing: { kind: code.symbol, direction: same }')).findings).toContainEqual(expect.stringContaining('kind "code.new-thing": "direction" belongs to a relation tie: a kind is tied to a kind, which has no direction'));
    const internal = rowIn(rowIn(SMALL, 'relations', '    code.fresh-link: { internal: "a reading", direction: inverse }'), 'kinds', '    code.new-thing: { internal: "a reading" }');
    expect(read(internal).findings).toContainEqual(expect.stringContaining('relation "code.fresh-link": "direction" belongs to a relation tie: an internal key names no catalog relation to run with or against'));
  });

  test('the starter set ties every kind and relation the extractors declare', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-mapping-'));
    try {
      for (const file of STARTER_FILES) {
        const path = join(folder, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      }
      const read1 = parseKinds(STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content, 'madarch/kinds.yaml', folder);
      expect(read1.mapping).toBeDefined();
      expect(read1.mapping!.findings).toEqual([]);
      expect(read1.mapping!.version).toBe(1);
      expect(read1.mapping!.kinds.size).toBe(EXTRACTOR_KINDS.size);
      expect(read1.mapping!.relations.size).toBe(EXTRACTOR_RELATIONS.size);
      expect([...read1.mapping!.kinds.keys()]).toEqual([...EXTRACTOR_KINDS.keys()]);
      expect([...read1.mapping!.relations.keys()]).toEqual([...EXTRACTOR_RELATIONS.keys()]);
      const rows = [...read1.mapping!.kinds.values(), ...read1.mapping!.relations.values()];
      // The rows the catalog calls internal, in code point order — the kinds and the relations alike. (The list is
      // the catalog's, which grows as the extractors' vocabulary grows; the mapping's own row order is no assertion
      // here, so both sides are sorted before they are compared.)
      expect(rows.filter((row) => row.tie === 'internal').map((row) => row.key).sort()).toEqual([
        'code.alters', 'code.authored', 'code.backed-by', 'code.callable', 'code.changed-with', 'code.comment',
        'code.coverage', 'code.covers', 'code.cycle-member', 'code.defined-in', 'code.deploy-unit',
        'code.describes-file', 'code.document-link', 'code.env-read', 'code.exposes', 'code.exposes-metric',
        'code.facet', 'code.facet-of', 'code.flows-into', 'code.http-route', 'code.link-target',
        'code.listener-port', 'code.listens-on', 'code.logger-use', 'code.logical-reference', 'code.mention',
        'code.mentions', 'code.metric-exposition', 'code.occurrence', 'code.parent', 'code.rank', 'code.reads',
        'code.reads-env', 'code.references', 'code.renamed-to', 'code.resolves', 'code.runs',
        'code.schema-reading', 'code.service-unit', 'code.starts', 'code.storage-evidence', 'code.targets',
        'code.tasks', 'code.touched', 'code.transitions', 'code.updates-metric', 'code.writes',
      ]);
      // Every tied relation says which way it runs, and the ones the extractors read backwards are marked.
      expect([...read1.mapping!.relations.values()].filter((row) => row.tie === 'relation').every((row) => row.direction === 'same' || row.direction === 'inverse')).toBe(true);
      expect([...read1.mapping!.relations.values()].filter((row) => row.direction === 'inverse').map((row) => row.key)).toEqual(['code.built-by', 'code.configured-by', 'code.handled-by', 'code.manifest-of', 'code.served-by', 'code.tests']);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
