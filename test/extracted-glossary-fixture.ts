/** An extracted glossary declaration, distinct from the starter's person-authored terms. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

export function useExtractedGlossary(folder: string): void {
  const path = join(folder, 'madarch', 'kinds.yaml');
  const manifest = parseDocument(readFileSync(path, 'utf8'));
  const term = ['kinds', 'doc.term'];
  manifest.setIn([...term, 'source'], 'document');
  manifest.setIn([...term, 'origin'], 'person');
  manifest.setIn([...term, 'terms'], ['**/glossary*.md']);
  manifest.setIn([...term, 'semantics'], 'term');
  manifest.setIn([...term, 'key'], ['name']);
  manifest.setIn([...term, 'fields'], [
    { name: 'name', type: 'text', binding: 'glossary@1.name' },
    { name: 'definition', type: 'text', binding: 'glossary@1.definition' },
    { name: 'synonyms', type: 'json', nullable: true, binding: 'glossary@1.synonyms' },
    { name: 'code', type: 'json', nullable: true, binding: 'glossary@1.code' },
    { name: 'usages', type: 'json', binding: 'glossary@1.usages' },
  ]);
  writeFileSync(path, manifest.toString());
}
