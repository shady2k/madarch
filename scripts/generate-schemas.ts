/**
 * Generates the published JSON Schema files from the same TypeBox sources
 * that give the code its types and runtime validation (decision 0008): the
 * model file format (`schema.ts`), the compiled model, `model.json`
 * (`compiled-schema.ts`), and the product kinds registry
 * (`src/product/schema.ts`, decision 0021). Run with `bun run schemas`; the
 * test `schema freshness` fails if the committed files fall out of date with
 * these sources.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ModelFile } from '../src/model/schema.js';
import { CompiledModel } from '../src/model/compiled-schema.js';
import { DocumentFields, KindsRegistry, ProductCompleteness } from '../src/product/schema.js';
import { DiscussionMessage } from '../src/product/discussion-schema.js';

export function renderSchema(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url));
  writeFileSync(`${root}schema/intended-model.schema.json`, renderSchema(ModelFile));
  writeFileSync(`${root}schema/compiled-model.schema.json`, renderSchema(CompiledModel));
  writeFileSync(`${root}schema/product-registry.schema.json`, renderSchema(KindsRegistry));
  writeFileSync(`${root}schema/product-document.schema.json`, renderSchema(DocumentFields));
  writeFileSync(`${root}schema/product-completeness.schema.json`, renderSchema(ProductCompleteness));
  writeFileSync(`${root}schema/product-discussion-message.schema.json`, renderSchema(DiscussionMessage));
}

if (import.meta.main) {
  main();
}
