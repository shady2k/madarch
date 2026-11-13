import { writeFolderManifest } from './catalog-folder-fixture.js';
/**
 * The pages of a product are written in the product's content language (madarch-m38l.4, remark 5): the language is a
 * setting of the manifest, and writing it keeps the comments around it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds, readKinds, setKindsLanguage } from '../src/product/manifest/kinds.js';

describe('the language is a setting of the manifest', () => {
  test('the manifest names it, a wrong one is a finding with its line, and writing it keeps the comments', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-language-'));
    try {
      mkdirSync(join(folder, 'madarch'), { recursive: true });
      mkdirSync(join(folder, 'templates'), { recursive: true });
      writeFileSync(join(folder, 'templates', 'a.md'), ':::body\n');
      const text = '# a comment that stays\nkinds:\n  product:\n    template: templates/a.md\n    source: markdown\n    file: docs/product.md\n';
      writeFolderManifest(folder, text);
      const metadata = join(folder, 'madarch/catalog.yaml');
      writeFileSync(metadata, '# a comment that stays\n' + readFileSync(metadata, 'utf8'));
      expect(setKindsLanguage(folder, 'ru')).toBeUndefined();
      const written = readFileSync(join(folder, 'madarch', 'catalog.yaml'), 'utf8');
      expect(written).toContain('# a comment that stays');
      expect(written).toContain('language: ru');
      const read = readKinds(folder);
      expect(read.present && read.manifest.language).toBe('ru');
      expect(setKindsLanguage(folder, 'de')).toContain('"de" is not a language of the wiki');
      const bad = parseKinds('language: de\nkinds: {}\n', 'madarch/catalog.yaml', folder);
      expect(bad.findings).toEqual([{ file: 'madarch/catalog.yaml', line: 1, message: '"language" is "de": the pages are written in en or ru' }]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
