/**
 * The index of a product's Markdown (madarch-m38l.8): read the knowledge pages
 * the manifest places in the product repository and publish them to the graph.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../graph/digest.js';
import { readKinds, type Finding } from '../kinds.js';
import { readMarkdownEntities } from '../markdown.js';
import { readIndexedPage, PageReadError, type IndexedPage } from './page.js';


;
;
;
export type { IndexedPage,  } from './page.js';
export { changedGrounds,  statementsRelyingOn } from './queries.js';
export type { GroundChange,    RelyingStatement } from './queries.js';
export {  gitReader } from './grounds.js';
;
;
;

/** The knowledge pages of a product folder, in id order; a page that cannot be read is a finding naming its file and line. */
export function readKnowledgePages(productFolder: string): { pages: IndexedPage[]; findings: Finding[] } {
  const kinds = readKinds(productFolder);
  if (!kinds.present) return { pages: [], findings: [] };
  const read = readMarkdownEntities(productFolder, kinds.manifest);
  const findings: Finding[] = [...kinds.manifest.findings, ...read.findings];
  const pages: IndexedPage[] = [];
  const sha = (text: string): string => sha256Hex(new TextEncoder().encode(text));
  for (const entity of read.entities) {
    try {
      const source = readFileSync(join(productFolder, entity.file), 'utf8');
      const page = readIndexedPage(entity.file, source, sha, kinds.manifest.language ?? 'en');
      pages.push(page);
      // An answered question is two entities in the index: the question, and the answer a person gave to it (madarch-m38l.7).
      if (entity.kind === 'question' && entity.front['status'] === 'answered') {
        pages.push({ id: `answer:${page.id.slice(page.id.indexOf(':') + 1)}`, kind: 'answer', title: `Answer: ${page.title}`, file: entity.file, relates: page.relates, sources: [], writtenAt: [], producer: 'person', statements: [], mentions: [page.id], digest: sha(`answer\n${source}`) });
      }
    } catch (error) {
      if (error instanceof PageReadError) findings.push({ file: error.file, line: error.line, message: error.message.slice(error.file.length + String(error.line).length + 2) });
      else findings.push({ file: join(productFolder, entity.file), line: 1, message: (error as Error).message });
    }
  }
  return { pages, findings };
}

