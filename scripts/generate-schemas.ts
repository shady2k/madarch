/**
 * Generates the published JSON Schema files from the same TypeBox sources
 * that give the code its types and runtime validation (decision 0008): the
 * model file format (`schema.ts`) and the compiled model, `model.json`
 * (`compiled-schema.ts`). Run with `bun run schemas`; the test
 * `schema freshness` fails if the committed files fall out of date with
 * these sources.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ModelFile } from '../src/model/schema.js';
import { CompiledModel } from '../src/model/compiled-schema.js';

export function renderSchema(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  writeFileSync(`${root}schema/madarch-model.schema.json`, renderSchema(ModelFile));
  writeFileSync(`${root}schema/model.schema.json`, renderSchema(CompiledModel));
}

if (import.meta.main) {
  main();
}
