/** Composite values exist only to exercise the shared validator in unit tests. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';

export function starterManifestText(): string {
  const rawMetadata = CATALOG_FILES['catalog.yaml']!;
  const seededMetadata = parse(STARTER_FILES.find((file) => file.path === 'madarch/catalog.yaml')!.content);
  const metadataText = rawMetadata + '\n' + stringify({ plugins: seededMetadata.plugins }, { lineWidth: 0 });
  const metadata = parse(metadataText);
  const kinds: string[] = [];
  for (const file of [...STARTER_FILES].sort((a, b) => Number(b.path.endsWith('/code.service.yaml')) - Number(a.path.endsWith('/code.service.yaml')))) {
    if (!file.path.startsWith('madarch/kinds/') || !file.path.endsWith('.yaml')) continue;
    const segments = file.path.slice('madarch/kinds/'.length).split('/');
    const name = segments.pop()!.slice(0, -5);
    const joined = segments.join('.');
    const group = metadata.groups[segments[1]!]?.parent === segments[0] ? segments[1] : joined;
    kinds.push(`  ${name}:\n    group: ${group}\n${file.content.trimEnd().split('\n').map((line) => '    ' + line).join('\n')}`);
  }
  return metadataText + '\nkinds:\n' + kinds.join('\n') + '\n';
}

/** Write a composite unit fixture using the product's real folder layout. */
export function writeFolderManifest(folder: string, text: string): void {
  const { kinds = {}, ...metadata } = parse(text);
  rmSync(join(folder, 'madarch/kinds'), { recursive: true, force: true });
  if (Object.values(kinds).some((raw) => (raw as Record<string, unknown>).group === undefined)) {
    metadata.groups = { ...metadata.groups, fixture: { en: 'Fixture', ru: 'Пример' }, 'fixture.fixture': { en: 'Fixture', ru: 'Пример', parent: 'fixture' } };
  }
  writeFileSync(join(folder, 'madarch/catalog.yaml'), stringify(metadata, { lineWidth: 0 }));
  for (const [name, raw] of Object.entries(kinds)) {
    const { group = 'fixture.fixture', ...body } = raw as Record<string, unknown>;
    const subgroup = String(group);
    const parent = metadata.groups?.[subgroup]?.parent ?? 'fixture';
    const segments = subgroup.includes('.') ? subgroup.split('.') : [parent, subgroup];
    const path = join(folder, 'madarch/kinds', ...segments, name + '.yaml');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stringify(body, { lineWidth: 0 }));
  }
}
