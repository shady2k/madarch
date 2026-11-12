import { expect, test } from 'bun:test';
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
    'madarch/kinds/strategy/product/domain.yaml': 'source: graph\ntemplate: templates/domain.md\n',
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
    'madarch/kinds/code/structure/code.file.yaml': 'source: graph\ntemplate: templates/a.liquid\n',
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
