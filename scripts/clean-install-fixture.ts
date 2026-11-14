/** A plugin-free store walk keeps only the generic templates its neutral kind can answer. */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function prepareStoreAcceptanceFixture(folder: string): void {
  rmSync(join(folder, 'madarch/kinds'), { recursive: true });
  mkdirSync(join(folder, 'madarch/kinds/acceptance/records'), { recursive: true });
  writeFileSync(join(folder, 'madarch/catalog.yaml'), 'groups:\n  acceptance: { en: Acceptance }\n  records: { en: Records, parent: acceptance }\n');
  writeFileSync(join(folder, 'madarch/kinds/acceptance/records/acceptance.record.yaml'), 'source: graph\n');
  for (const name of readdirSync(join(folder, 'templates'))) {
    if (name !== 'entity.yaml' && name !== 'catalogue-entity.yaml') rmSync(join(folder, 'templates', name), { recursive: true });
  }
}
