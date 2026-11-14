/** The plugin-free store walk keeps the starter templates beside a reduced code manifest. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function prepareStoreAcceptanceFixture(folder: string): void {
  rmSync(join(folder, 'madarch/kinds'), { recursive: true });
  mkdirSync(join(folder, 'madarch/kinds/code/files'), { recursive: true });
  writeFileSync(join(folder, 'madarch/catalog.yaml'), 'groups:\n  code: { en: Code, ru: Код }\n  files: { en: Files, ru: Файлы, parent: code }\n');
  writeFileSync(join(folder, 'madarch/kinds/code/files/code.file.yaml'), 'source: graph\n');
}
