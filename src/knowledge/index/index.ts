/**
 * The index of a product's Markdown (madarch-m38l.8): read the knowledge pages
 * the manifest places in the product repository and publish them to the graph.
 */
import { sha256Hex } from '../../graph/digest.js';
import { readKinds, type Finding, type KindsManifest } from '../kinds.js';
import { readMarkdownEntitiesFrom } from '../markdown.js';
import { workingTreeFiles, type ProductFileSource } from '../product-files.js';
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

/**
 * The knowledge pages of one source of the product repository's files, in id order; a page that cannot be read is a
 * finding naming its file and line. A reader of the wiki passes the graph's stored files; the fill and a fixture pass
 * the working tree. Every page is read from the source alone — no second read of a file (madarch-hsqs stage C).
 */
export function readKnowledgePagesFrom(files: ProductFileSource, manifest: KindsManifest): { pages: IndexedPage[]; findings: Finding[] } {
  const read = readMarkdownEntitiesFrom(files, manifest);
  const findings: Finding[] = [...manifest.findings, ...read.findings];
  const pages: IndexedPage[] = [];
  const sha = (text: string): string => sha256Hex(new TextEncoder().encode(text));
  for (const entity of read.entities) {
    try {
      const source = entity.source;
      const page = readIndexedPage(entity.file, source, sha, manifest.language ?? 'en');
      pages.push(page);
      // An answered question is two entities in the index: the question, and the answer a person gave to it (madarch-m38l.7).
      if (entity.kind === 'question' && entity.front['status'] === 'answered') {
        pages.push({ id: `answer:${page.id.slice(page.id.indexOf(':') + 1)}`, kind: 'answer', title: `Answer: ${page.title}`, file: entity.file, relates: page.relates, sources: [], writtenAt: [], producer: 'person', statements: [], mentions: [page.id], digest: sha(`answer
${source}`) });
      }
    } catch (error) {
      if (error instanceof PageReadError) findings.push({ file: error.file, line: error.line, message: error.message.slice(error.file.length + String(error.line).length + 2) });
      else findings.push({ file: entity.file, line: 1, message: (error as Error).message });
    }
  }
  return { pages, findings };
}

/** The knowledge pages of a product folder's working tree, for the fill's planning and a fixture's read. */
export function readKnowledgePages(productFolder: string): { pages: IndexedPage[]; findings: Finding[] } {
  const kinds = readKinds(productFolder);
  if (!kinds.present) return { pages: [], findings: [] };
  return readKnowledgePagesFrom(workingTreeFiles(productFolder), kinds.manifest);
}
