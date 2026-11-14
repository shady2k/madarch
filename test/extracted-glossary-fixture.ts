/** An extracted glossary declaration, distinct from the starter's person-authored terms. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

export function useExtractedGlossary(folder: string): void {
  const path = join(folder, 'madarch', 'kinds', 'requirements', 'statement', 'doc.term.yaml');
  const manifest = parseDocument(readFileSync(path, 'utf8'));
  manifest.setIn(['source'], 'document');
  manifest.setIn(['origin'], 'person');
  manifest.setIn(['terms'], ['**/glossary*.md']);
  manifest.setIn(['semantics'], 'term');
  manifest.setIn(['key'], ['name']);
  manifest.setIn(['title'], 'name');
  manifest.setIn(['fields'], [
    { name: 'name', type: 'text', binding: 'glossary@1.name' },
    { name: 'definition', type: 'text', binding: 'glossary@1.definition' },
    { name: 'synonyms', type: 'json', nullable: true, binding: 'glossary@1.synonyms' },
    { name: 'code', type: 'json', nullable: true, binding: 'glossary@1.code' },
    { name: 'usages', type: 'json', binding: 'glossary@1.usages' },
  ]);
  writeFileSync(path, manifest.toString());
}
