import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseKinds, readKinds } from '../src/product/manifest/kinds.js';
import { catalogFiles } from '../src/knowledge/catalog-files.js';
import { parse } from 'yaml';
const folder = mkdtempSync(join(tmpdir(), 'purpose-contract-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
writeFileSync(join(folder, 'page.liquid'), '{{ title }}');
const vocabulary = `purposes:
  understand: { labels: { en: Understand, ru: Понять }, order: 20 }
  structure: { labels: { en: Structure, ru: Устройство }, order: 10 }
`;
const body = `kinds:
  sample:
    source: graph
    template: page.liquid
    purpose: structure
`;
test('purpose vocabulary validates complete labels, order and every referenced purpose at its location', () => {
  const parse = (text: string) => parseKinds(text, 'manifest.yaml', folder);
  expect(parse(vocabulary + body).findings).toEqual([]);
  expect(parse(vocabulary + body).kinds.get('sample')?.purpose).toBe('structure');
  expect([...parse(vocabulary + body).purposes!.values()].map((p) => [p.id, p.order])).toEqual([['understand', 20], ['structure', 10]]);
  for (const text of [
    vocabulary.replace('en: Understand, ru: Понять', 'en: Understand') + body,
    vocabulary.replace('order: 20', 'order: first') + body,
    vocabulary.replace('order: 20', 'order: 1.5') + body,
    vocabulary.replace('order: 20', 'order: 20, invented: true') + body,
    vocabulary + body.replace('purpose: structure', 'purpose: absent'),
    vocabulary + body.replace('    purpose: structure\n', ''),
  ]) {
    const findings = parse(text).findings;
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.file === 'manifest.yaml' && f.line > 0)).toBe(true);
  }
  expect(parse(body.replace('    purpose: structure\n', '')).findings).toEqual([]);
});
test('starter kind purposes reference the vocabulary without replacing standards groups', () => {
  const files = catalogFiles();
  const metadata = parse(files['catalog.yaml']!) as { purposes: Record<string, unknown> };
  expect(Object.keys(metadata.purposes).length).toBe(5);
  for (const [path, text] of Object.entries(files)) {
    if (path === 'catalog.yaml' || path.startsWith('templates/')) continue;
    const kind = parse(text) as { purpose: string; audience: string[] };
    expect(Object.hasOwn(metadata.purposes, kind.purpose)).toBe(true);
    expect(kind.audience.length).toBeGreaterThan(0);
  }
});

test('catalogue-only kinds still validate purpose and audience', () => {
  const product = join(folder, 'catalogue-only');
  const files = catalogFiles();
  const metadata = files['catalog.yaml']!;
  const [path, yaml] = Object.entries(files).find(([path, yaml]) => path !== 'catalog.yaml' && yaml.includes('template-policy: none'))!;
  const kindPath = join(product, 'madarch', 'kinds', path);
  mkdirSync(join(product, 'madarch'), { recursive: true });
  mkdirSync(join(kindPath, '..'), { recursive: true });
  writeFileSync(join(product, 'madarch', 'catalog.yaml'), metadata);
  writeFileSync(kindPath, yaml.replace(/audience:.*\n/u, 'audience: [nonexistent-role]\n').replace(/purpose:.*\n/u, 'purpose: nonexistent-purpose\n'));
  const read = readKinds(product);
  if (!read.present) throw new Error('manifest absent');
  expect(read.manifest.findings.some((f) => f.file.endsWith(path) && f.message.includes('audience'))).toBe(true);
  expect(read.manifest.findings.some((f) => f.file.endsWith(path) && f.message.includes('purpose'))).toBe(true);
});

test('split kind purpose and renamed vocabulary reread without code changes', () => {
  const root = join(folder, 'madarch');
  mkdirSync(join(root, 'kinds', 'example', 'structure'), { recursive: true });
  const header = join(root, 'catalog.yaml');
  writeFileSync(header, vocabulary + 'groups:\n  example.structure: { en: Structure, ru: Устройство }\n');
  writeFileSync(join(root, 'kinds', 'example', 'structure', 'sample.yaml'), 'source: graph\ntemplate: page.liquid\npurpose: structure\n');
  const first = readKinds(folder);
  if (!first.present) throw new Error('manifest absent');
  expect(first.manifest.findings).toEqual([]);
  expect(first.manifest.kinds.get('sample')?.purpose).toBe('structure');
  writeFileSync(header, vocabulary.replace('en: Structure', 'en: How it works').replace('order: 10', 'order: 30') + 'groups:\n  example.structure: { en: Structure, ru: Устройство }\n');
  const next = readKinds(folder);
  if (!next.present) throw new Error('manifest absent');
  expect(next.manifest.purposes?.get('structure')?.labels.en).toBe('How it works');
  expect(next.manifest.purposes?.get('structure')?.order).toBe(30);
});
