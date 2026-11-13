import { expect, spyOn, test } from 'bun:test';
import * as yaml from 'yaml';
import { readKindsFrom } from '../src/product/manifest/kinds.js';
import type { ProductFileSource } from '../src/plugin/product-files.js';

function source(entries: Record<string, string>): ProductFileSource {
  return {
    has: (path) => Object.hasOwn(entries, path),
    text: (path) => entries[path],
    size: (path) => entries[path]?.length ?? null,
    ensure: async () => {},
    paths: () => Object.keys(entries).sort(),
    filesIn: (folder) => Object.keys(entries).filter((path) => path.startsWith(folder + '/') && !path.slice(folder.length + 1).includes('/')).sort(),
    filesBelow: (folder) => Object.keys(entries).filter((path) => path.startsWith(folder + '/')).sort(),
  };
}

test('manifest cache rechecks source changes and isolates returned mutations', () => {
  const entries: Record<string, string> = { 'madarch/catalog.yaml': '{}\n' };
  const files = source(entries);
  const first = readKindsFrom(files, '/cache-isolation');
  if (!first.present) throw new Error('manifest is present');
  (first.manifest.findings as unknown as { file: string; line: number; message: string }[]).push({ file: 'changed', line: 1, message: 'changed' });
  const second = readKindsFrom(files, '/cache-isolation');
  if (!second.present) throw new Error('manifest is present');
  expect(second.manifest.findings).toEqual([]);
  entries['madarch/kinds/bad.txt'] = '{}';
  const added = readKindsFrom(files, '/cache-isolation');
  if (!added.present) throw new Error('manifest is present');
  expect(added.manifest.findings.some((finding) => finding.file.endsWith('/bad.txt'))).toBe(true);
  delete entries['madarch/kinds/bad.txt'];
  entries['madarch/catalog.yaml'] = 'language: invalid\n';
  const changed = readKindsFrom(files, '/cache-isolation');
  if (!changed.present) throw new Error('manifest is present');
  expect(changed.manifest.findings.some((finding) => finding.message.includes('language'))).toBe(true);
});

test('manifest cache retries a source error inside the parser', () => {
  const entries: Record<string, string> = {
    'madarch/catalog.yaml': 'plugins:\n  - { id: git, version: 1, path: plugins/git, inputs: [], outputs: [], closure: [plugins/git/contract.json] }\n',
    'plugins/git/contract.json': JSON.stringify({ id: 'git', version: '1.0.0', outputs: { vertices: [], edges: [] } }),
    'plugins/git/plugin.json': '{}',
  };
  const files = source(entries);
  const text = files.text;
  let fail = false;
  files.text = (path) => { if (fail && path === 'plugins/git/plugin.json') throw new Error('read failed'); return text(path); };
  readKindsFrom(files, '/cache-source-error');
  fail = true;
  const failed = readKindsFrom(files, '/cache-source-error');
  if (!failed.present) throw new Error('manifest is present');
  expect(failed.manifest.findings.some((finding) => finding.message.includes('read failed'))).toBe(true);
  fail = false;
  const recovered = readKindsFrom(files, '/cache-source-error');
  if (!recovered.present) throw new Error('manifest is present');
  expect(recovered.manifest.findings.some((finding) => finding.message.includes('read failed'))).toBe(false);
});

test('empty metadata mapping composes with an empty kinds folder', () => {
  const read = readKindsFrom(source({'madarch/catalog.yaml': '{}\n'}), '/product');
  if (!read.present) throw new Error('the empty metadata still declares a manifest');
  expect(read.manifest.findings).toEqual([]);
  expect(read.manifest.kinds.size).toBe(0);
});

const metadata = `groups:
  code: {en: Code, ru: Код}
  code.structure: {en: Structure, ru: Структура, parent: code}
`;

test('folder declarations derive names and groups and retain exact diagnostic lines', () => {
  const read = readKindsFrom(source({
    'madarch/catalog.yaml': metadata,
    'madarch/kinds/code/structure/code.file.yaml': 'source: wrong\n',
  }), '/product');
  expect(read.present).toBe(true);
  if (!read.present) return;
  const finding = read.manifest.findings.find((one) => one.message.includes('source'));
  expect(finding?.file).toBe('/product/madarch/kinds/code/structure/code.file.yaml');
  expect(finding?.source).toBe(finding?.file);
  expect(finding?.line).toBe(1);
});

test('legacy layout is refused even beside a folder declaration', () => {
  const read = readKindsFrom(source({
    'madarch/kinds.yaml': 'kinds: {}',
    'madarch/catalog.yaml': metadata,
    'madarch/kinds/code/structure/code.file.yaml': 'source: graph\n',
  }), '/product');
  if (!read.present) throw new Error('legacy declaration must be reported');
  expect(read.manifest.unreadable).toBe(true);
  expect(read.manifest.kinds.size).toBe(0);
  expect(read.manifest.findings[0]?.message).toContain('migrate');
});

test('malformed declarations and invalid paths never disappear silently', () => {
  const read = readKindsFrom(source({
    'madarch/catalog.yaml': metadata,
    'madarch/kinds/code/structure/code.file.yaml': 'source: [\n',
    'madarch/kinds/bad.txt': 'anything',
  }), '/product');
  if (!read.present) throw new Error('declarations must be reported');
  expect(read.manifest.findings.some((one) => one.file.endsWith('code.file.yaml') && one.line === 2)).toBe(true);
  expect(read.manifest.findings.some((one) => one.file.endsWith('bad.txt'))).toBe(true);
});

test('folder layout preserves declared subgroup keys, reports duplicate names and rejects explicit identity', () => {
  const read = readKindsFrom(source({
    'madarch/catalog.yaml': 'groups:\n  strategy: {en: Strategy, ru: Стратегия}\n  product: {en: Product, ru: Продукт, parent: strategy}\n',
    'madarch/kinds/strategy/product/domain.yaml': 'source: graph\n\n',
    'madarch/kinds/strategy/zother/domain.yaml': 'source: graph\n',
    'madarch/kinds/strategy/product/invalid.yaml': 'source: graph\ngroup: other\n',
    'templates/domain.md': '# Domain',
  }), '/product');
  if (!read.present) throw new Error('declarations must be read');
  expect(read.manifest.kinds.get('domain')?.group).toBe('product');
  expect(read.manifest.kindFiles?.get('domain')).toBe('madarch/kinds/strategy/product/domain.yaml');
  expect(read.manifest.findings.find((one) => one.message.includes('already declared'))?.file).toBe('/product/madarch/kinds/strategy/zother/domain.yaml');
  expect(read.manifest.findings.find((one) => one.message.includes('"group" is not declared'))?.line).toBe(2);
});

test('flow mappings keep their original diagnostic line', () => {
  const read = readKindsFrom(source({
    'madarch/catalog.yaml': metadata,
    'madarch/kinds/code/structure/code.file.yaml': '# {a comment}\n{source: wrong}\n',
    'madarch/kinds/code/structure/.yaml': '{}',
  }), '/product');
  if (!read.present) throw new Error('declarations must be read');
  expect(read.manifest.findings.find((one) => one.message.includes('source'))?.line).toBe(2);
  expect(read.manifest.findings.some((one) => one.file.endsWith('/.yaml'))).toBe(true);
});

test('flow-style metadata composes with folder declarations', () => {
  const read = readKindsFrom(source({
    'madarch/catalog.yaml': '{groups: {code: {en: Code, ru: Код}, code.structure: {parent: code, en: Structure, ru: Структура}}}\n',
    'madarch/kinds/code/structure/code.file.yaml': 'source: graph\n\n',
    'templates/a.liquid': '# File',
  }), '/product');
  if (!read.present) throw new Error('declarations must be read');
  expect(read.manifest.findings).toEqual([]);
  expect(read.manifest.kinds.get('code.file')?.group).toBe('code.structure');
});

test('multiline flow metadata retains nested field diagnostic lines', () => {
  const read = readKindsFrom(source({
    'madarch/catalog.yaml': '{groups: {\n code: {\n ru: Код,\n en: 7\n }}}\n',
  }), '/product');
  if (!read.present) throw new Error('metadata must be read');
  const finding = read.manifest.findings.find((one) => one.message.includes('name in "en"'));
  expect(finding?.line).toBe(4);
  expect(finding?.file).toBe('/product/madarch/catalog.yaml');
});

test('folder reads parse each changed file once and keep edits and removals visible', () => {
  const declaration = 'source: graph\n\n';
  const entries: Record<string, string> = { 'madarch/catalog.yaml': metadata, 'templates/fixture.liquid': '# Fixture' };
  for (let index = 0; index < 12; index++) entries[`madarch/kinds/code/structure/fixture.${index}.yaml`] = declaration;
  const files = source(entries);
  const parser = spyOn(yaml, 'parseDocument');
  const read = () => {
    const held = readKindsFrom(files, '/cache-product');
    if (!held.present) throw new Error('the authored folder must declare a manifest');
    return held.manifest;
  };
  try {
    const initial = read();
    expect(initial.kinds.size).toBe(12);
    const parsed = parser.mock.calls.length;
    expect(parsed).toBeGreaterThan(12);
    const repeated = read();
    expect(repeated).toEqual(initial);
    expect(parser.mock.calls.length).toBe(parsed);
    const edited = 'madarch/kinds/code/structure/fixture.0.yaml';
    entries[edited] = 'source: wrong\n';
    const invalid = read();
    expect(invalid.findings.find((finding) => finding.message.includes('source'))).toMatchObject({ file: `/cache-product/${edited}`, source: `/cache-product/${edited}`, line: 1 });
    expect(parser.mock.calls.length).toBe(parsed + 1);
    entries[edited] = declaration;
    expect(read().findings).toEqual(initial.findings);
    delete entries[edited];
    expect(read().kinds.size).toBe(11);
    entries['madarch/catalog.yaml'] = metadata.replace('en: Code', 'en: Updated');
    expect(read().groups.get('code')?.labels['en']).toBe('Updated');
  } finally { parser.mockRestore(); }
});

test('aliases resolve only inside their own file and report the alias line', () => {
  const read = readKindsFrom(source({
    'madarch/catalog.yaml': 'language: &shared en\n',
    'madarch/kinds/code/structure/a.yaml': '# independent\nsource: *shared\n',
    'madarch/kinds/code/structure/b.yaml': 'source: wrong\n',
  }), '/aliases');
  if (!read.present) throw new Error('manifest must be read');
  expect(read.manifest.findings.find((one) => one.message.includes('Unresolved alias'))).toMatchObject({ file: '/aliases/madarch/kinds/code/structure/a.yaml', line: 2 });
  expect(read.manifest.findings.some((one) => one.file.endsWith('/b.yaml') && one.message.includes('source'))).toBe(true);
});

test('prototype-named kinds are retained', () => {
  const read = readKindsFrom(source({
    'madarch/catalog.yaml': metadata,
    'madarch/kinds/code/structure/__proto__.yaml': 'source: graph\n\n',
    'templates/a.liquid': '# Template',
  }), '/prototype');
  if (!read.present) throw new Error('manifest must be read');
  expect(read.manifest.kinds.has('__proto__')).toBe(true);
});

test('duplicate kind files still report their own malformed YAML', () => {
  const read = readKindsFrom(source({
    'madarch/catalog.yaml': metadata,
    'madarch/kinds/code/structure/item.yaml': 'source: graph\n\n',
    'madarch/kinds/other/structure/item.yaml': 'source: [\n',
    'templates/a.liquid': '# Template',
  }), '/duplicates');
  if (!read.present) throw new Error('manifest must be read');
  const findings = read.manifest.findings.filter((one) => one.file.endsWith('/other/structure/item.yaml'));
  expect(findings.some((one) => one.message.includes('already declared'))).toBe(true);
  expect(findings.some((one) => one.line === 2 && !one.message.includes('already declared'))).toBe(true);
});

test('alias expansion failure identifies the alias that exceeds the limit', () => {
  const aliases = Array.from({ length: 101 }, () => '  - *value').join('\n');
  const read = readKindsFrom(source({
    'madarch/catalog.yaml': metadata,
    'madarch/kinds/code/structure/item.yaml': `anchor: &value test\nitems:\n${aliases}\n`,
  }), '/alias-limit');
  if (!read.present) throw new Error('manifest must be read');
  expect(read.manifest.findings.find((one) => one.message.includes('Excessive alias count'))).toMatchObject({ file: '/alias-limit/madarch/kinds/code/structure/item.yaml', line: 102 });
});
