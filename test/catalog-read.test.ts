/**
 * The catalog's reader (decision 0033, items 8 to 10): `src/knowledge/catalog.ts` reads the schema a product's
 * manifest declares about its entity catalog and each kind's row, and refuses a schema it cannot read, a row that
 * leaves a field out, a subgroup above its bound, two kinds of one concept id, a value the catalog marks as an
 * attribute declared as a kind, and an area, a subgroup or an origin mark the manifest does not declare — every
 * refusal with the file, the line and the kind.
 *
 * Fixtures only: a small catalog written by the test, whose bound, marks, statuses, policies, attributes and
 * relations it can change one line at a time, and the starter set's own manifest read once. The starter set's
 * templates are written into a temporary product so a page kind's template is found.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { GROUP_SHORT_LABEL_LIMIT, parseKinds } from '../src/knowledge/kinds.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { CATALOG_KINDS, type CatalogKindData } from '../src/knowledge/starter-catalog.js';

const made: string[] = [];
afterAll(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A product folder whose templates are the starter set's, so a page kind's template resolves. */
function product(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-catalog-read-'));
  made.push(folder);
  for (const file of STARTER_FILES.filter((entry) => entry.path.startsWith('templates/'))) {
    const path = join(folder, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  return folder;
}

/** The templates, written once: every manifest below is read against them. */
const TEMPLATES = product();

/** A small catalog: two areas, three subgroups, three kinds, and a schema a test can change one line at a time. */
const SMALL = [
  'catalog:',
  '  subgroup-kind-bound: 2',
  '  attributes: [version]',
  '  origin-marks: [document, conversation, not-implemented]',
  '  extractor-mark: extractor',
  '  statuses: [implemented, not-implemented]',
  '  template-policies: [page, member, none]',
  '  relations:',
  '    c4.uses: "https://c4model.com/abstractions"',
  '    refines:',
  'groups:',
  '  area: { en: Area, ru: Область, short: { en: Area, ru: Область }, open: true }',
  '  area.one: { en: One, ru: Один, short: { en: One, ru: Один }, parent: area }',
  '  area.two: { en: Two, ru: Два, short: { en: Two, ru: Два }, parent: area }',
  'kinds:',
  '  widget:',
  '    id: "x.widget"',
  '    group: area.one',
  '    definition: "A widget."',
  '    sources: ["https://example.test/widget"]',
  '    acquisition: ["document"]',
  '    status: implemented',
  '    relation-constraints: { out: [c4.uses], in: [refines] }',
  '    template-policy: page',
  '    template: templates/service.liquid',
  '    source: markdown',
  '    file: docs/widget.md',
  '    labels:',
  '      en: { one: Widget, many: Widgets }',
  '      ru: { one: Виджет, many: Виджеты }',
  '    description:',
  '      en: A widget.',
  '      ru: Виджет.',
  '  gadget:',
  '    id: "x.gadget"',
  '    group: area.one',
  '    definition: "A gadget."',
  '    sources: ["https://example.test/gadget"]',
  '    acquisition: ["extractor code"]',
  '    status: implemented',
  '    relation-constraints: { out: [], in: [] }',
  '    template-policy: none',
  '    labels:',
  '      en: { one: Gadget, many: Gadgets }',
  '      ru: { one: Приспособление, many: Приспособления }',
  '    description:',
  '      en: A gadget.',
  '      ru: Приспособление.',
  '  sprocket:',
  '    id: "x.sprocket"',
  '    group: area.two',
  '    definition: "A sprocket."',
  '    sources: ["https://example.test/sprocket"]',
  '    acquisition: ["conversation", "not-implemented"]',
  '    status: not-implemented',
  '    relation-constraints: { out: [], in: [] }',
  '    template-policy: none',
  '    labels:',
  '      en: { one: Sprocket, many: Sprockets }',
  '      ru: { one: Звёздочка, many: Звёздочки }',
  '    description:',
  '      en: A sprocket.',
  '      ru: Звёздочка.',
  '',
].join('\n');

/**
 * One catalog-only kind as the small catalog writes it, with the fields a test changes. Its words are written unless the
 * test leaves `labels` or `description` out (`null`), which is how a missing translation is planted.
 */
function kind(name: string, fields: Readonly<Record<string, string | null>> = {}): string[] {
  const row: Record<string, string | null> = {
    id: `"x.${name}"`,
    group: 'area.two',
    definition: `"A ${name}."`,
    sources: '["https://example.test/kind"]',
    acquisition: '["conversation"]',
    status: 'not-implemented',
    'relation-constraints': '{ out: [], in: [] }',
    'template-policy': 'none',
    labels: `labels:\n      en: { one: ${name}, many: ${name}s }\n      ru: { one: ${name}, many: ${name}s }`,
    description: `description:\n      en: A ${name}.\n      ru: ${name}.`,
    ...fields,
  };
  const lines = [`  ${name}:`];
  for (const [field, value] of Object.entries(row)) {
    if (value === null) continue;
    if (value.startsWith('labels:\n') || value.startsWith('description:\n')) {
      const [head, ...rest] = value.split('\n');
      lines.push(`    ${head}`, ...rest);
    } else lines.push(`    ${field}: ${value}`);
  }
  return lines;
}

/** The small catalog with `name` declared last, its fields as `fields` says (`null` leaves a field out). */
function withKind(manifest: string, name: string, fields: Readonly<Record<string, string | null>> = {}): string {
  return `${manifest.trimEnd()}\n${kind(name, fields).join('\n')}\n`;
}

/** The manifest's text with the first line that starts with `prefix` replaced by `written`, or dropped when it is null. */
function line(manifest: string, prefix: string, written: string | null): string {
  const lines = manifest.split('\n');
  const at = lines.findIndex((text) => text.startsWith(prefix));
  if (at < 0) throw new Error(`the fixture manifest holds no line starting ${prefix}`);
  return written === null ? [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n') : [...lines.slice(0, at), written, ...lines.slice(at + 1)].join('\n');
}

/** The small catalog without one kind's whole declaration (its name line and its indented fields). */
function withoutKind(manifest: string, name: string): string {
  const lines = manifest.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`the fixture manifest declares no kind ${name}`);
  let end = start + 1;
  while (end < lines.length && lines[end]!.startsWith('    ')) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/** A mapping's block replaced whole: `at` (`  relations:`), its indented lines, and one line in their place. */
function block(manifest: string, at: string, written: string): string {
  const lines = manifest.split('\n');
  const start = lines.findIndex((text) => text.startsWith(at));
  const indent = lines[start]!.length - lines[start]!.trimStart().length;
  let end = start + 1;
  while (end < lines.length && lines[end]!.length - lines[end]!.trimStart().length > indent) end += 1;
  return [...lines.slice(0, start), written, ...lines.slice(end)].join('\n');
}

/** The catalog findings of a manifest: the line and the words of each. */
function refusals(manifest: string): string[] {
  const read = parseKinds(manifest, 'madarch/kinds.yaml', TEMPLATES);
  // A schema the catalog cannot read leaves the manifest without a catalog; its findings are the manifest's own then.
  return (read.catalog?.findings ?? read.findings).filter((finding) => !finding.message.startsWith('"documents.expect"')).map((finding) => `${finding.line}: ${finding.message}`);
}

/** The whole-manifest findings of a small manifest: the line and the words of each. */
function read1(manifest: string): string[] {
  const read = parseKinds(manifest, 'madarch/kinds.yaml', TEMPLATES);
  return read.findings.map((finding) => `${finding.line}: ${finding.message}`);
}

/** The catalog findings held to the one finding the manifest is expected to make. */
function expectRefused(manifest: string, message: string): void {
  const findings = refusals(manifest);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toContain(message);
}

describe('a catalog is read as its manifest declares it', () => {
  test('the schema, the two levels and every kind\'s row are read, and a catalogue-only kind shows no page', () => {
    const read = parseKinds(SMALL, 'madarch/kinds.yaml', TEMPLATES);
    expect(read.findings).toEqual([]);
    expect(read.catalog!.schema.subgroupKindBound).toBe(2);
    expect(read.catalog!.schema.attributes).toEqual(['version']);
    expect(read.catalog!.schema.originMarks).toEqual(['document', 'conversation', 'not-implemented']);
    expect(read.catalog!.schema.extractorMark).toBe('extractor');
    expect(read.catalog!.schema.statuses).toEqual(['implemented', 'not-implemented']);
    expect(read.catalog!.schema.templatePolicies).toEqual(['page', 'member', 'none']);
    expect([...read.catalog!.schema.relations.keys()]).toEqual(['c4.uses', 'refines']);
    expect(read.catalog!.schema.relations.get('c4.uses')).toBe('https://c4model.com/abstractions');
    expect(read.catalog!.schema.relations.get('refines')).toBeUndefined();
    expect([...read.catalog!.kinds.keys()]).toEqual(['widget', 'gadget', 'sprocket']);
    expect(read.catalog!.kinds.get('widget')).toMatchObject({ id: 'x.widget', area: 'area', subgroup: 'area.one', status: 'implemented', acquisition: ['document'], relationsOut: ['c4.uses'], relationsIn: ['refines'], templatePolicy: 'page' });
    // The wiki shows the page kinds and no page for a kind the engine cannot make yet.
    expect([...read.kinds.keys()]).toEqual(['widget']);
    expect([...read.groups.keys()]).toEqual(['area', 'area.one', 'area.two']);
  });

  test('a kind without a translation is a finding at its declaration and stays in the catalog, never an English label in its place', () => {
    const manifest = withKind(SMALL, 'untranslated', { labels: '{ en: { one: Thing, many: Things } }', description: '{ en: A thing. }' });
    const read = parseKinds(manifest, 'madarch/kinds.yaml', TEMPLATES);
    const found = read.findings.filter((finding) => finding.message.includes('untranslated'));
    expect(found.map((finding) => finding.message)).toEqual([
      'kind "untranslated": the kind has no name in "ru": the catalogue names every kind in en and ru, and an untranslated name is never shown as an English one',
      'kind "untranslated": the kind has no description in "ru": the catalogue describes every kind in en and ru, and an untranslated description is never shown as an English one',
    ]);
    for (const finding of found) {
      expect(finding.file).toBe('madarch/kinds.yaml');
      expect(finding.line).toBeGreaterThan(0);
    }
    // The catalogue keeps the kind with the words it has: the page marks it untranslated rather than dropping it.
    expect(read.catalog!.kinds.get('untranslated')).toMatchObject({ labels: { en: { one: 'Thing', many: 'Things' } }, descriptions: { en: 'A thing.' } });
  });

  test('a page kind the product has not translated still shows: the finding names it and its page stays in "kinds"', () => {
    const manifest = withKind(SMALL, 'untranslated-page', {
      'template-policy': 'page',
      template: 'templates/item.liquid',
      source: 'markdown',
      file: 'docs/untranslated.md',
      labels: '{ en: { one: Page, many: Pages } }',
      description: null,
    });
    const read = parseKinds(manifest, 'madarch/kinds.yaml', TEMPLATES);
    const found = read.findings.filter((finding) => finding.message.includes('untranslated-page'));
    expect(found.map((finding) => finding.message)).toEqual([
      'kind "untranslated-page": the kind has no name in "ru": the catalogue names every kind in en and ru, and an untranslated name is never shown as an English one',
      'kind "untranslated-page": "description" says what the kind is in each interface language (en, ru): a sentence saying what the kind is',
    ]);
    for (const finding of found) expect(finding.line).toBeGreaterThan(0);
    // The page kind is not a broken row: the missing translation is reported and the kind is still declared.
    expect(read.kinds.has('untranslated-page')).toBe(true);
    expect(read.catalog!.kinds.get('untranslated-page')).toMatchObject({ labels: { en: { one: 'Page', many: 'Pages' } }, descriptions: {} });
    // The catalogue's own answer carries the finding too, so its page can mark the kind untranslated.
    expect(read.catalog!.findings.filter((finding) => finding.message.includes('untranslated-page'))).toHaveLength(2);
  });

  test('the starter set reads clean: every area of the life cycle, two levels, and a row for every kind', () => {
    const read = parseKinds(STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content, 'madarch/kinds.yaml', TEMPLATES);
    const starter = product();
    const seeded = parseKinds(STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content, 'madarch/kinds.yaml', starter);
    expect(seeded.findings).toEqual([]);
    expect(read.catalog!.kinds.size).toBe(515);
    expect(read.findings.filter((finding) => !finding.message.startsWith('"documents.expect"'))).toEqual([]);
    const areas = [...read.groups.values()].filter((group) => group.parent === undefined);
    const subgroups = [...read.groups.values()].filter((group) => group.parent !== undefined);
    expect([areas.length, subgroups.length]).toEqual([28, 106]);
    for (const entry of read.catalog!.kinds.values()) expect(read.groups.get(entry.subgroup)!.parent).toBe(entry.area);
  });
});

describe('a schema the catalog cannot read is refused', () => {
  const cases: { what: string; manifest: string; message: string }[] = [
    { what: 'an unknown field of the schema', manifest: line(SMALL, '  subgroup-kind-bound:', '  subgroup-kind-bound: 2\n  sub-groups: 4'), message: '"sub-groups" is not a field of the catalog: the fields are subgroup-kind-bound, attributes, origin-marks, extractor-mark, statuses, template-policies, relations' },
    { what: 'a bound that is not a whole number above zero', manifest: line(SMALL, '  subgroup-kind-bound:', '  subgroup-kind-bound: 0'), message: '"subgroup-kind-bound" is the most kinds one subgroup holds, a whole number above zero, got 0' },
    { what: 'attributes that are not a list', manifest: line(SMALL, '  attributes:', '  attributes: version'), message: '"attributes" is a list of the values the catalog marks as attributes of a kind rather than kinds, such as "version" or "coverage"' },
    { what: 'origin marks that are not a list', manifest: line(SMALL, '  origin-marks:', '  origin-marks: []'), message: '"origin-marks" is a list of the ways a kind comes to be besides an extractor, such as "document" or "conversation"' },
    { what: 'an extractor mark that is empty', manifest: line(SMALL, '  extractor-mark:', '  extractor-mark: ""'), message: '"extractor-mark" is the mark an extractor\'s id follows ("extractor code"), got ""' },
    { what: 'an extractor mark the origin marks already declare', manifest: line(SMALL, '  extractor-mark:', '  extractor-mark: document'), message: '"extractor-mark" is "document", and "origin-marks" declares it as a mark of its own: an extractor\'s mark is followed by its id' },
    { what: 'statuses that are not a list', manifest: line(SMALL, '  statuses:', '  statuses: yes'), message: '"statuses" is a list of the implementation statuses a kind declares, such as "implemented" and "not-implemented"' },
    { what: 'template policies that are not a list', manifest: line(SMALL, '  template-policies:', '  template-policies: {}'), message: '"template-policies" is a list of the template policies a kind declares, such as "page", "member" and "none"' },
    { what: 'relations that are not a mapping', manifest: block(SMALL, '  relations:', '  relations: 7'), message: '"relations" maps each relation name the catalog uses to the address of the standard that defines it, or to nothing for a plain verb' },
    { what: 'a relation whose source is not an address', manifest: line(SMALL, '    refines:', '    refines: somewhere'), message: 'relation "refines": the source is the address of the standard that defines it, such as "https://c4model.com/abstractions", or nothing for a plain verb, got "somewhere"' },
  ];
  for (const one of cases) {
    test(`${one.what} is refused`, () => {
      expectRefused(one.manifest, one.message);
    });
  }
});

describe('every field of a catalog row is required, and a wrong one is refused naming the kind', () => {
  const cases: { field: string; value: string | null; message: string }[] = [
    { field: 'id', value: null, message: '"id" is the canonical concept id of the kind (one concept has one kind), such as "c4.container", got undefined' },
    { field: 'definition', value: '""', message: '"definition" is one sentence saying what the kind is, got ""' },
    { field: 'sources', value: '[]', message: '"sources" is a list of the addresses of the standards or documents the kind was taken from, so a person can read them' },
    { field: 'sources', value: '["not a url"]', message: '"sources" holds "not a url", which is not an http or https address: the standard or document is linked so a person can read it' },
    { field: 'acquisition', value: null, message: '"acquisition" is a list of the ways the kind comes to be: "extractor <id>" or one of document, conversation, not-implemented' },
    { field: 'status', value: 'shipped', message: '"status" is one of implemented, not-implemented, got "shipped"' },
    { field: 'relation-constraints', value: '[c4.uses]', message: '"relation-constraints" is { out: [<relation>, ...], in: [<relation>, ...] }: the relations the kind may carry, out and in' },
    { field: 'relation-constraints', value: '{ out: [c4.uses] }', message: '"relation-constraints" names "in", the relations the kind may carry in that direction, as a list (empty when it carries none)' },
    { field: 'relation-constraints', value: '{ out: [c4.flies], in: [] }', message: 'the relation "c4.flies" is not one of the catalog\'s relations' },
    { field: 'relation-constraints', value: '{ out: [], in: [], sideways: [] }', message: '"sideways" is not a field of "relation-constraints": the fields are out and in' },
    { field: 'template-policy', value: 'sometimes', message: '"template-policy" is one of page, member, none, got "sometimes"' },
    { field: 'group', value: 'nowhere.at-all', message: '"group" names the subgroup of the catalog the kind belongs to, and "groups" declares no "nowhere.at-all"' },
  ];
  for (const one of cases) {
    test(`a ${one.field} that is ${one.value === null ? 'absent' : 'wrong'} is refused naming the kind`, () => {
      expectRefused(withKind(SMALL, 'test.kind', { [one.field]: one.value }), `kind "test.kind": ${one.message}`);
    });
  }

  test('a kind whose template policy is page declares no member, and one whose policy is member declares one', () => {
    expectRefused(withKind(SMALL, 'test.kind', { 'template-policy': 'page', template: 'templates/service.liquid', source: 'markdown', file: 'docs/test.md', member: '{ relation: c4.uses, direction: out }' }), 'kind "test.kind": \'template-policy\' is "page", and the kind declares "member": a member\'s row is the policy "member"');
    expectRefused(withKind(SMALL, 'test.kind', { 'template-policy': 'member', template: 'templates/item.liquid', source: 'markdown', file: 'docs/test.md' }), 'kind "test.kind": "template-policy" is "member", and the kind declares no "member": a member\'s row names the relation to the parent whose page it stands on');
  });

  test('a kind the engine cannot make yet declares no page: a template, a source or a member is refused', () => {
    for (const field of ['template', 'source', 'member'] as const) {
      expectRefused(withKind(SMALL, 'test.kind', { [field]: field === 'member' ? '{ relation: c4.uses, direction: out }' : '"templates/item.liquid"' }), `kind "test.kind": "${field}" belongs to a kind that shows a page, and "template-policy" is "none"`);
    }
  });
});

describe('the navigation names every group by a short label', () => {
  test('the starter set gives every area and subgroup a short label that fits the sidebar, in both languages', () => {
    const read = parseKinds(STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content, 'madarch/kinds.yaml', TEMPLATES);
    expect(read.findings).toEqual([]);
    for (const group of read.groups.values()) {
      expect([group.name, group.short?.en !== undefined && group.short?.ru !== undefined]).toEqual([group.name, true]);
      for (const language of ['en', 'ru']) expect([group.name, language, Array.from(group.short![language]!).length <= GROUP_SHORT_LABEL_LIMIT]).toEqual([group.name, language, true]);
    }
  });

  test('a short label the sidebar cannot hold is refused, naming the group, the language and the bound', () => {
    const long = line(SMALL, '  area:', '  area: { en: Area, ru: Область, short: { en: "A name far too long to fit", ru: Область }, open: true }');
    expect(read1(long)).toContainEqual(expect.stringContaining('group "area": the short label in "en" is 26 code points, and the navigation holds 18 without cutting it'));
  });

  test('a catalogued manifest gives every group a short label', () => {
    const bare = line(SMALL, '  area:', '  area: { en: Area, ru: Область, open: true }');
    expect(read1(bare)).toContainEqual(expect.stringContaining('group "area": no "short" label, and the navigation names every group by one or two words'));
  });
});

  test('a short label is a mapping of both languages, one or two words each, and its guards say why', () => {
    expect(read1(line(SMALL, '  area:', '  area: { en: Area, ru: Область, short: 7, open: true }'))).toContainEqual(expect.stringContaining('group "area": "short" is { en: <its short label>, ru: <its short label> }'));
    expect(read1(line(SMALL, '  area:', '  area: { en: Area, ru: Область, short: { en: Area }, open: true }'))).toContainEqual(expect.stringContaining('group "area": "short" names a label in each language (en, ru), and it names en'));
    expect(read1(line(SMALL, '  area:', '  area: { en: Area, ru: Область, short: { en: Area, ru: Область, de: Bereich }, open: true }'))).toContainEqual(expect.stringContaining('group "area": "short" holds a label per language (en, ru), got "de"'));
    expect(read1(line(SMALL, '  area:', '  area: { en: Area, ru: Область, short: { en: "", ru: Область }, open: true }'))).toContainEqual(expect.stringContaining('group "area": the short label in "en" is one or two words'));
    expect(read1(line(SMALL, '  area:', '  area: { en: Area, ru: Область, short: { en: Area, ru: Область }, open: yes }'))).toContainEqual(expect.stringContaining('group "area": "open" is true or absent'));
    expect(read1(line(SMALL, '  area:', '  area: { en: Area, ru: Область, short: { en: Area, ru: Область }, parent: 7 }'))).toContainEqual(expect.stringContaining('group "area": "parent" is the name of a group of "groups"'));
    expect(read1(line(SMALL, '  area:', '  area: { en: 7, ru: Область, short: { en: Area, ru: Область } }'))).toContainEqual(expect.stringContaining('group "area": the name in "en" is a text'));
  });

describe('one defect in the manifest is one problem', () => {
  /** The findings of the starter manifest with one defect planted, the file and the words of each. */
  function planted(text: string): string[] {
    const read = parseKinds(text, 'madarch/kinds.yaml', TEMPLATES);
    return read.findings.map((finding) => finding.message);
  }
  /** The starter manifest with one string replaced (the plant), so the plant is what the manifest differs by. */
  function withPlant(old: string, written: string): string {
    const base = STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content;
    if (!base.includes(old)) throw new Error(`the starter manifest holds no ${JSON.stringify(old)}`);
    return base.replace(old, written);
  }
  /** A catalogue-only kind appended to the `kinds:` section, for the plants that add one. */
  function appendedKind(name: string, id: string, group: string, extra: string[] = []): string {
    const base = STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content;
    return base.replace('\nmapping:\n', `\n  ${name}:\n    id: "${id}"\n    group: ${group}\n    definition: "A kind the test plants."\n    sources: ["https://example.test/plant"]\n    acquisition: ["conversation"]\n    status: not-implemented\n    relation-constraints: { out: [], in: [] }\n    template-policy: none\n    labels:\n      en: { one: Plant, many: Plants }\n      ru: { one: Растение, many: Растения }\n    description:\n      en: A kind the test plants.\n      ru: Вид, который сажает тест.\n${extra.join('')}\nmapping:\n`);
  }
  const cases: [string, string, string][] = [
    ['a group whose parent nobody declares', withPlant('groups:\n', 'groups:\n  broken: { en: Broken, ru: Сломано, short: { en: Broken, ru: Сломано }, parent: nowhere }\n'), 'group "broken": "parent" names a group of "groups"'],
    ['a subgroup whose parent nobody declares, its kinds included', withPlant('  contracts: { en: "Interfaces", ru: "Интерфейсы", short: { en: "Interfaces", ru: "Интерфейсы" }, parent: code }', '  contracts: { en: "Interfaces", ru: "Интерфейсы", short: { en: "Interfaces", ru: "Интерфейсы" }, parent: nowhere }'), 'group "contracts": "parent" names a group of "groups"'],
    ['a kind in a group nobody declares', withPlant('    group: code.structure\n', '    group: nowhere.at-all\n'), 'kind "code.service": "group" names the subgroup of the catalog the kind belongs to'],
    ['a kind in an area rather than a subgroup', withPlant('    group: code.structure\n', '    group: code\n'), 'kind "code.service": "group" names "code", which no area holds'],
    ['a subgroup over its bound', appendedKind('probe.overflow', 'practice.probe-overflow', 'infrastructure.orchestration'), 'subgroup "infrastructure.orchestration": 13 kinds'],
    ['two kinds of one concept id', appendedKind('probe.duplicate', 'c4.container', 'code.schema'), 'kind "probe.duplicate": the concept id "c4.container" is the id of kind "code.service"'],
    ['a value the catalog marks as an attribute declared as a kind', appendedKind('probe.attribute', 'version', 'code.schema'), 'kind "probe.attribute": "version" is a value the catalog marks as an attribute'],
    ['an origin mark the catalog does not declare', withPlant('    acquisition: ["extractor operations"]\n', '    acquisition: ["telepathy"]\n'), 'kind "code.service": "acquisition" holds "telepathy"'],
    ['a source that is not an address', withPlant('    sources: ["https://c4model.com/abstractions"]\n', '    sources: ["nowhere"]\n'), 'kind "code.service": "sources" holds "nowhere"'],
    ['a short label the sidebar cannot hold', withPlant('short: { en: "Strategy", ru: "Стратегия" }', 'short: { en: "Strategy and business motivation", ru: "Стратегия" }'), 'group "strategy": the short label in "en" is 32 code points'],
    ['a role leading a group nobody declares', withPlant('lead: [strategy, discovery, requirements, rd]', 'lead: [nowhere, discovery, requirements, rd]'), 'role "product": "nowhere" is not a group of "groups"'],
    ['a role opening a block outside the library', withPlant('open: [stated, implementedby, linkedfrom, related, properties] }\n  analyst', 'open: [nothing] }\n  analyst'), 'role "product": "nothing" is not a block of the library'],
    ['a tied relation with no direction', withPlant('    code.contains: { relation: "contains", direction: "same" }', '    code.contains: { relation: "contains" }'), 'relation "code.contains": "direction" is same or inverse'],
    ['a tied relation with a direction the mapping does not know', withPlant('    code.contains: { relation: "contains", direction: "same" }', '    code.contains: { relation: "contains", direction: "sideways" }'), 'relation "code.contains": "direction" is same or inverse'],
  ];
  for (const [what, manifest, names] of cases) {
    test(`${what} is one problem, naming it`, () => {
      const found = planted(manifest);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain(names);
    });
  }

  test('the starter set itself holds no problem at all', () => {
    expect(planted(STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content)).toEqual([]);
  });
});

describe('the areas a person sees open at once', () => {
  test('the product\'s own knowledge opens before code, and every kind the old product group held is in an open area', () => {
    const read = parseKinds(STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content, 'madarch/kinds.yaml', TEMPLATES);
    expect(read.findings).toEqual([]);
    const areas = [...read.groups.values()].filter((group) => group.parent === undefined);
    // The areas the wiki opens by itself: strategy, requirements, research and documentation — the product's knowledge.
    expect(areas.filter((area) => area.open === true).map((area) => area.name)).toEqual(['strategy', 'requirements', 'rd', 'documentation']);
    const order = areas.map((area) => area.name);
    // A person reads the product's own knowledge before the code: every open area stands before code.
    for (const open of ['strategy', 'requirements', 'rd', 'documentation']) expect([open, order.indexOf(open) < order.indexOf('code')]).toEqual([open, true]);
    // The kinds the old "Product knowledge" group held are all in an area that opens: domains and the product page,
    // use cases, rules, requirements and terms, decisions, and the agent's enrichments and corrections. The question
    // is now the tracker's clarification, so it stands in Work instead (the owner's decision of 2026-11-08).
    const opened = new Set(areas.filter((area) => area.open === true).map((area) => area.name));
    for (const kind of ['product', 'domain', 'doc.use-case', 'doc.rule', 'doc.requirement', 'doc.term', 'doc.decision', 'enrichment', 'correction']) {
      const entry = read.catalog!.kinds.get(kind);
      expect([kind, entry !== undefined && opened.has(entry.area)]).toEqual([kind, true]);
    }
    expect(read.catalog!.kinds.get('question')).toMatchObject({ subgroup: 'work.coordination', area: 'work' });
  });
});

describe('a catalog relation reads in the direction its standard gives it', () => {
  /** The starter set's own rows, by the name the manifest declares them under. */
  const rows = new Map(CATALOG_KINDS.map((kind) => [kind.name, kind]));
  /** One kind's catalog row, which the starter set declares. */
  function row(name: string): CatalogKindData {
    const held = rows.get(name);
    if (held === undefined) throw new Error(`the starter set declares no kind ${name}`);
    return held;
  }
  /**
   * The kinds the `generates` relation joins in the starter set, each with the side SPDX 3 reads the edge on: the
   * source generates the target, so the source permits the relation out and the target permits it in. SPDX 2.3's
   * `generatedFrom` named the same edge from the target's end, so a row that named it must stand on the other side
   * now; a kind may also permit the other side when an edge runs both ways through it (an image is made by a
   * Dockerfile and makes a container).
   */
  const generates: readonly (readonly [string, 'out' | 'in'])[] = [
    ['build', 'out'],            // the build generates its artifact, its byproduct and the SBOM
    ['code.dockerfile', 'out'],  // the Dockerfile generates the image
    ['build-artifact', 'in'],
    ['byproduct', 'in'],
    ['sbom', 'in'],
    ['code.image', 'in'],
    ['code.lockfile', 'in'],     // a package manager generates the lock file, and no kind of the catalog is one
  ];
  test('each kind permits the relation on the side the standard reads it, on both ends of the edge', () => {
    for (const [name, side] of generates) {
      const held = row(name);
      expect([name, (side === 'out' ? held.out : held.into).includes('generates')]).toEqual([name, true]);
    }
  });
});

describe('the catalog as a whole is refused where its rows do not agree', () => {
  test('a subgroup above the bound its manifest declares is refused, naming the kinds it holds', () => {
    expectRefused(withKind(SMALL, 'third', { group: 'area.one' }), 'subgroup "area.one": 3 kinds (gadget, third, widget), above the bound of 2 a subgroup holds ("catalog: subgroup-kind-bound")');
  });

  test('two kinds for one concept id are refused, naming both kinds', () => {
    expectRefused(withKind(SMALL, 'another', { id: '"x.gadget"' }), 'kind "another": the concept id "x.gadget" is the id of kind "gadget", and one concept has one kind');
  });

  test('a value the catalog marks as an attribute, declared as a kind, is refused', () => {
    expectRefused(withKind(SMALL, 'version'), 'kind "version": "version" is a value the catalog marks as an attribute ("catalog.attributes"), not a kind');
  });

  test('a subgroup no area holds is refused, naming the kind and the area it belongs to', () => {
    const moved = line(SMALL, '  area.two:', '  area.two: { en: Two, ru: Два, short: { en: Two, ru: Два } }');
    const read = parseKinds(moved, 'madarch/kinds.yaml', TEMPLATES);
    expect(read.findings.map((finding) => finding.message)).toContain('kind "sprocket": "group" names "area.two", which no area holds: a catalog kind belongs to a subgroup, and a subgroup\'s "parent" names its area');
    // A group the catalog does not fill is the product's own business: no second finding is invented for it.
    expect(read.findings.filter((finding) => finding.message.startsWith('area ') || finding.message.startsWith('subgroup '))).toEqual([]);
  });

  test('a catalog field on a manifest that declares no catalog is refused, and the manifest keeps its kinds', () => {
    const without = SMALL.slice(SMALL.indexOf('groups:'));
    const read = parseKinds(without, 'madarch/kinds.yaml', TEMPLATES);
    expect(read.catalog).toBeUndefined();
    expect(read.findings.map((finding) => finding.message)).toContain('kind "widget": "id" is a field of the entity catalog, and the manifest declares no "catalog"');
  });

  test('a catalogue-only kind is read, and refused when the manifest declares no "catalog"', () => {
    const without = SMALL.slice(SMALL.indexOf('groups:'));
    const read = parseKinds(SMALL, 'madarch/kinds.yaml', TEMPLATES);
    expect(read.kinds.has('gadget')).toBe(false);
    expect(read.catalog!.kinds.has('gadget')).toBe(true);
    expect(parseKinds(without, 'madarch/kinds.yaml', TEMPLATES).kinds.has('gadget')).toBe(false);
  });
});

describe('the reader\'s own rules: an address, a list, an identifier and an extractor\'s mark', () => {
  /** The line of a kind's field, or of the kind's own declaration when no field is named. */
  function lineOf(manifest: string, name: string, field?: string): number {
    const lines = manifest.split('\n');
    const start = lines.indexOf(`  ${name}:`);
    if (field === undefined) return start + 1;
    let end = start + 1;
    while (end < lines.length && lines[end]!.startsWith('    ')) end += 1;
    return start + 1 + lines.slice(start + 1, end).findIndex((text) => text.startsWith(`    ${field}:`));
  }

  test('a source is an http or https address with a host, and a padded or other-scheme address is refused', () => {
    for (const source of ['" http://example.test/x"', '"ftp://example.test/x"', '"http://"', '"//example.test/x"']) {
      expectRefused(withKind(SMALL, 'test.kind', { sources: `[${source}]` }), `kind "test.kind": "sources" holds ${JSON.stringify(JSON.parse(source))}, which is not an http or https address`);
    }
    expect(refusals(withKind(SMALL, 'test.kind', { sources: '["http://example.test/a", "https://example.test/b"]' }))).toEqual([]);
  });

  test('a list of the schema holds no repeat and no padded word', () => {
    expectRefused(line(SMALL, '  attributes:', '  attributes: [version, version]'), '"attributes" is a list of the values the catalog marks as attributes');
    expectRefused(line(SMALL, '  origin-marks:', '  origin-marks: ["document ", conversation, not-implemented]'), '"origin-marks" is a list of the ways a kind comes to be');
    expectRefused(withKind(SMALL, 'test.kind', { acquisition: '["document", "document"]' }), 'kind "test.kind": "acquisition" is a list of the ways the kind comes to be');
  });

  test('an id is one word, without whitespace, and a relation name is too', () => {
    expectRefused(withKind(SMALL, 'test.kind', { id: '"x.two words"' }), 'kind "test.kind": "id" is the canonical concept id of the kind');
    expectRefused(line(SMALL, '    c4.uses:', '    "c4 uses": "https://c4model.com/abstractions"'), 'relation "c4 uses": a relation name is a word, such as "c4.uses"');
  });

  test('an extractor\'s mark is its name, a space, and an id with no whitespace in it', () => {
    // A padded mark is not a list of marks at all; a mark whose id holds a space is a mark the catalog does not know.
    expectRefused(withKind(SMALL, 'test.kind', { acquisition: '["extractor "]' }), 'kind "test.kind": "acquisition" is a list of the ways the kind comes to be');
    expectRefused(withKind(SMALL, 'test.kind', { acquisition: '["extractor  code"]' }), 'kind "test.kind": "acquisition" holds "extractor  code"');
    expect(refusals(withKind(SMALL, 'test.kind', { acquisition: '["extractor data-model"]' }))).toEqual([]);
  });

  test('a value the catalog marks as an attribute is refused by the id\'s own last segment and by the kind\'s name', () => {
    expectRefused(withKind(SMALL, 'test.kind', { id: '"x.version"' }), 'kind "test.kind": "version" is a value the catalog marks as an attribute');
    expectRefused(withKind(SMALL, 'version', { id: '"x.other"' }), 'kind "version": "version" is a value the catalog marks as an attribute');
  });

  test('a finding stands at the field it is about, and at the kind when the field is absent', () => {
    const written = withKind(SMALL, 'test.kind', { status: 'shipped' });
    expect(parseKinds(written, 'madarch/kinds.yaml', TEMPLATES).catalog!.findings.map((finding) => finding.line)).toEqual([written.split('\n').findIndex((text) => text === '    status: shipped') + 1]);
    const absent = withKind(SMALL, 'test.kind', { status: null });
    expect(parseKinds(absent, 'madarch/kinds.yaml', TEMPLATES).catalog!.findings.map((finding) => finding.line)).toEqual([absent.split('\n').findIndex((text) => text === '  test.kind:') + 1]);
  });

  test('every field of a row stands the finding it makes at its own line', () => {
    const cases: [string, string][] = [
      ['id', '"x two"'],
      ['definition', '""'],
      ['sources', '[]'],
      ['acquisition', '[]'],
      ['status', 'shipped'],
      ['template-policy', 'sometimes'],
      ['relation-constraints', '[]'],
      ['group', 'nowhere.at-all'],
    ];
    for (const [field, value] of cases) {
      const manifest = withKind(SMALL, 'test.kind', { [field]: value });
      const read = parseKinds(manifest, 'madarch/kinds.yaml', TEMPLATES);
      expect([field, read.catalog!.findings.map((finding) => finding.line)]).toEqual([field, [manifest.split('\n').findIndex((text) => text === `    ${field}: ${value}`) + 1]]);
    }
  });

  test('every field of the schema stands the finding it makes at its own line', () => {
    const cases: [string, string][] = [
      ['subgroup-kind-bound', '0'],
      ['attributes', 'version'],
      ['origin-marks', '[]'],
      ['extractor-mark', '""'],
      ['statuses', 'yes'],
      ['template-policies', '{}'],
    ];
    for (const [field, value] of cases) {
      const manifest = line(SMALL, `  ${field}:`, `  ${field}: ${value}`);
      const read = parseKinds(manifest, 'madarch/kinds.yaml', TEMPLATES);
      expect([field, read.findings.map((finding) => finding.line)]).toEqual([field, [manifest.split('\n').findIndex((text) => text === `  ${field}: ${value}`) + 1]]);
    }
  });

  test('a finding inside the schema or a row stands at the line of the field it names', () => {
    /** The 1-based line of the first line that holds `text`. */
    const at = (manifest: string, text: string): number => manifest.split('\n').findIndex((one) => one === text) + 1;
    const cases: [string, string, string][] = [
      ['a relation whose source is not an address', line(SMALL, '    refines:', '    refines: somewhere'), '    refines: somewhere'],
      ['a relation name that is not a word', line(SMALL, '    refines:', '    "a b":'), '    "a b":'],
      ['an extractor mark the origin marks already declare', line(SMALL, '  extractor-mark:', '  extractor-mark: document'), '  extractor-mark: document'],
      ['a constraint on a relation the catalog does not hold', withKind(SMALL, 'test.kind', { 'relation-constraints': '{ out: [c4.flies], in: [] }' }), '    relation-constraints: { out: [c4.flies], in: [] }'],
    ];
    for (const [what, manifest, text] of cases) {
      const read = parseKinds(manifest, 'madarch/kinds.yaml', TEMPLATES);
      expect([what, (read.catalog?.findings ?? read.findings).map((finding) => finding.line)]).toEqual([what, [at(manifest, text)]]);
    }
    // A kind whose subgroup no area holds is refused at the kind's own `group` line.
    const moved = line(SMALL, '  area.two:', '  area.two: { en: Two, ru: Два, short: { en: Two, ru: Два } }');
    const read = parseKinds(moved, 'madarch/kinds.yaml', TEMPLATES);
    const finding = read.findings.find((one) => one.message.startsWith('kind "sprocket"'))!;
    expect(finding.line).toBe(at(moved, '    group: area.two'));
  });

  test('a row with a problem leaves its kind out of the catalog, and the rest of the catalog stands', () => {
    const read = parseKinds(withKind(SMALL, 'test.kind', { status: 'shipped' }), 'madarch/kinds.yaml', TEMPLATES);
    expect(read.catalog!.kinds.has('test.kind')).toBe(false);
    expect(read.catalog!.kinds.has('widget')).toBe(true);
    expect(read.kinds.has('widget')).toBe(true);
  });

  test('a schema that is not a mapping, and constraints that are a list, are refused at the catalog\'s line and the kind\'s', () => {
    const read = parseKinds(block(SMALL, 'catalog:', 'catalog: []'), 'madarch/kinds.yaml', TEMPLATES);
    expect(read.findings.map((finding) => [finding.line, finding.message])).toEqual([
      [read.findings[0]!.line, '"catalog" declares the schema of the entity catalog: subgroup-kind-bound, attributes, origin-marks, extractor-mark, statuses, template-policies and relations'],
    ]);
    expectRefused(withKind(SMALL, 'test.kind', { 'relation-constraints': '[]' }), 'kind "test.kind": "relation-constraints" is { out: [<relation>, ...], in: [<relation>, ...] }');
    expectRefused(withKind(SMALL, 'test.kind', { 'relation-constraints': '{ out: c4.uses, in: [] }' }), 'kind "test.kind": "out" is a list of the catalog\'s relations, empty when the kind carries none');
  });
});
