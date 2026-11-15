import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { parseKinds, readKindsFrom } from '../src/product/manifest/kinds.js';

const file = '/product/madarch/catalog.yaml';
const folder = '/product';
const names = ['run', 'unit', 'event', 'agent-usage', 'operation', 'problem', 'question', 'person', 'role', 'plugin', 'setting', 'kind'];

for (const name of names) {
  test(`protects and explicitly extends ${name}`, () => {
    const refused = parseKinds(`kinds:
  ${name}:
    source: graph
`, file, folder);
    expect(refused.findings).toContainEqual(expect.objectContaining({ file, line: 2 }));
    expect(refused.kinds.has(name)).toBe(false);
    const read = parseKinds(`kinds:
  ${name}:
    extends: system:${name}
    fields:
      - name: note
        type: text
        producers: [person]
`, file, folder);
    expect(read.findings).toEqual([]);
    const kind = read.kinds.get(name)!;
    expect(kind.systemBase).toEqual({ name });
    expect(kind.source).toBe('graph');
    expect(kind.labels?.en?.one).toBeTruthy();
    expect(kind.labels?.ru?.one).toBeTruthy();
    expect(kind.fields?.map((field) => field.name)).toEqual(['note', 'label']);
    expect(kind.fields?.find((field) => field.name === 'label')).toMatchObject({ type: 'text', nullable: true });
  });
}

test('refuses contract replacement and incorrect inheritance at their actual lines', () => {
  for (const [body, line] of [
    ['extends: system:unit', 3],
    [`extends: system:run
    source: markdown`, 4],
    [`extends: system:run
    key: [label]`, 4],
    [`extends: system:run
    fields:
      - name: label
        type: integer`, 5],
    [`extends: system:run
    fields: wrong`, 4],
  ] as const) {
    const read = parseKinds(`kinds:
  run:
    ${body}
`, file, folder);
    expect(read.findings).toContainEqual(expect.objectContaining({ file, line }));
    expect(read.kinds.has('run')).toBe(false);
  }
  const unknown = parseKinds(`kinds:
  local:
    extends: system:run
`, file, folder);
  expect(unknown.findings[0]).toMatchObject({ file, line: 3 });
});

test('extension fields still pass ordinary semantic validation', () => {
  const read = parseKinds(`kinds:
  run:
    extends: system:run
    fields:
      - name: note
        type: wrong
`, file, folder);
  expect(read.findings[0]).toMatchObject({ file, line: 5 });
  expect(read.kinds.has('run')).toBe(false);
});

test('folder collision keeps the full declaration path and YAML line', () => {
  const entries: Record<string, string> = {
    'madarch/catalog.yaml': '{}',
    'madarch/kinds/work/runtime/run.yaml': `# explanation

source: graph
`,
  };
  const read = readKindsFrom({
    has: (path) => Object.hasOwn(entries, path),
    text: (path) => entries[path],
    size: (path) => entries[path]?.length ?? null,
    filesBelow: (path) => Object.keys(entries).filter((one) => one.startsWith(path + '/')),
  }, folder);
  expect(read.present).toBe(true);
  if (!read.present) throw new Error('the product catalogue is present');
  expect(read.manifest.findings[0]).toMatchObject({ file: '/product/madarch/kinds/work/runtime/run.yaml', source: '/product/madarch/kinds/work/runtime/run.yaml', line: 3 });
});

test('ordinary parsing and absent product source do not install system contracts', () => {
  expect(parseKinds('kinds: {}', file, folder).kinds.size).toBe(0);
  expect(readKindsFrom({ has: () => false, text: () => undefined, size: () => null, filesBelow: () => [] }, '/absent-system-product').present).toBe(false);
});

test('each extension receives a fresh trusted base', () => {
  const first = parseKinds(`kinds:
  run:
    extends: system:run`, file, folder);
  (first.kinds.get('run')!.fields as unknown as { name: string }[])[0]!.name = 'changed';
  const second = parseKinds(`kinds:
  run:
    extends: system:run`, file, folder);
  expect(second.kinds.get('run')!.fields?.[0]?.name).toBe('label');
});


test('an extension keeps ordinary edge declarations', () => {
  const read = parseKinds(`kinds:
  run:
    extends: system:run
edges:
  - name: follows
    from: [run]
    to: [run]
`, file, folder);
  expect(read.findings).toEqual([]);
  expect(read.edges?.get('follows')).toMatchObject({ from: ['run'], to: ['run'] });
});

test('catalogue-only presentation preserves the inherited graph contract', () => {
  const read = parseKinds(`kinds:
  event:
    extends: system:event
    template-policy: none
`, file, folder);
  // Without a catalogue, presentation metadata is refused normally, not ignored.
  expect(read.findings.some((finding) => finding.message.includes('catalog'))).toBe(true);
});

test('inherited labels remain validated and source may only repeat the base', () => {
  const valid = parseKinds(`kinds:
  run:
    extends: system:run
    source: graph
`, file, folder);
  expect(valid.findings).toEqual([]);
  const invalid = parseKinds(`kinds:
  run:
    extends: system:run
    labels: wrong
`, file, folder);
  expect(invalid.findings[0]).toMatchObject({ file, line: 4 });
  expect(invalid.kinds.has('run')).toBe(false);
});


const cataloguedEvent = `catalog:
  subgroup-kind-bound: 2
  attributes: [version]
  origin-marks: [document]
  extractor-mark: extractor
  template-policies: [page, member, none]
  relations: {}
groups:
  area: {en: Area, ru: Область, short: {en: Area, ru: Область}}
  area.one: {en: One, ru: Один, short: {en: One, ru: Один}, parent: area}
kinds:
  event:
    extends: system:event
    id: x.event
    group: area.one
    definition: A durable event.
    sources: [https://example.test/event]
    acquisition: [document]
    relation-constraints: {out: [], in: []}
    template-policy: none
`;

test('catalogue none policy admits metadata without activating a graph contract', () => {
  const read = parseKinds(cataloguedEvent, file, folder);
  expect(read.findings).toEqual([]);
  expect(read.kinds.has('event')).toBe(false);
  expect(read.catalog?.kinds.get('event')?.templatePolicy).toBe('none');
});

test('catalogue none policy refuses additions rather than silently dropping them', () => {
  const read = parseKinds(cataloguedEvent + '    fields: [{name: note, type: text, producers: [person]}]\n', file, folder);
  expect(read.findings).toContainEqual(expect.objectContaining({ file, line: 21, message: expect.stringContaining('cannot add graph fields') }));
  expect(read.kinds.has('event')).toBe(false);
});

test('extension catalogue metadata is validated, not trusted as engine data', () => {
  const read = parseKinds(cataloguedEvent.replace('definition: A durable event.', 'definition: 2'), file, folder);
  expect(read.findings.some((finding) => finding.line === 16 && finding.message.includes('definition'))).toBe(true);
  expect(read.kinds.has('event')).toBe(false);
});


test('an aliased protected declaration cannot bypass admission', () => {
  const read = parseKinds(`kinds:
  local: &declaration
    source: graph
  run: *declaration
`, file, folder);
  expect(read.findings).toContainEqual(expect.objectContaining({ file, line: 4 }));
  expect(read.kinds.has('run')).toBe(false);
});


test('system plugin bindings are refused until UID-aware transport exists; ordinary bindings remain valid', () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-system-plugin-'));
  try {
    mkdirSync(join(root, 'plugins', 'writer'), {recursive: true});
    mkdirSync(join(root, 'madarch'), {recursive: true});
    const contract = {id: 'writer', version: '1.0.0', outputs: {vertices: [{kind: 'run', fields: [{name: 'note', type: 'text', meaning: 'A note.', example: 'note', required: true}]}], edges: []}};
    writeFileSync(join(root, 'plugins', 'writer', 'contract.json'), JSON.stringify(contract));
    writeFileSync(join(root, 'madarch', 'plugins.lock'), `plugins:
  - {id: writer, version: 1.0.0, closure: ${'a'.repeat(64)}, path: plugins/writer}
`);
    const text = `kinds:
  run:
    extends: system:run
    fields:
      - {name: note, type: text, binding: writer@1.note}
plugins:
  - {id: writer, version: 1, path: plugins/writer, inputs: [], outputs: [run], closure: [plugins/writer/contract.json]}
`;
    const read = parseKinds(text, file, root);
    expect(read.findings).toContainEqual(expect.objectContaining({file, line: 5, message: expect.stringContaining('require UID-aware plugin transport')}));
    writeFileSync(join(root, 'plugins', 'writer', 'contract.json'), JSON.stringify({...contract, outputs: {vertices: [{...contract.outputs.vertices[0], kind: 'local', key: ['note']}], edges: []}}));
    const keyedProduct = parseKinds(text.replace('    extends: system:run', '    source: graph\n    key: [note]').replaceAll('run', 'local'), file, root);
    expect(keyedProduct.findings).toEqual([]);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
