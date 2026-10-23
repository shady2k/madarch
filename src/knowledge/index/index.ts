/**
 * The index of a product's Markdown (madarch-m38l.8): read the knowledge pages
 * the manifest places in the product repository and publish them to the graph.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseOwner } from '../../adapters/database-owner.js';
import { sha256Hex } from '../../graph/digest.js';
import type { GraphStore } from '../../graph/index.js';
import { readKinds, type Finding } from '../kinds.js';
import { readMarkdownEntities } from '../markdown.js';
import { readIndexedPage, PageReadError, type IndexedPage } from './page.js';
import { indexKnowledge, type IndexHead, type IndexReport } from './publish.js';
import type { GitReader } from './grounds.js';

export { indexKnowledge, pageKey, sectionKey, statementKey } from './publish.js';
export type { IndexHead, IndexInput, IndexReport, Unresolved } from './publish.js';
export { readIndexedPage, readWrittenAt, PageReadError } from './page.js';
export type { IndexedPage, WrittenAt } from './page.js';
export { changedGrounds, indexCounts, statementsRelyingOn } from './queries.js';
export type { GroundChange, GroundStatus, KindCount, NowState, RelyingStatement } from './queries.js';
export { digestGround, gitReader } from './grounds.js';
export type { DigestMethod, GitReader, GroundDigest } from './grounds.js';
export { documentSections, sectionDigest } from './sections.js';
export { parseRemote, webLink } from './web-link.js';
export type { PlaceInput, Remote, WebLink } from './web-link.js';
export { GROUNDED_BY, INDEX_PRODUCER, MENTIONS, PAGE_KIND, RELATES, SECTION_KIND, STATEMENT_KIND, STATEMENT_OF } from './vocabulary.js';

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
      const page = readIndexedPage(entity.file, source, sha);
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

export interface IndexProductOptions {
  readonly owner: DatabaseOwner;
  readonly store: GraphStore;
  readonly productFolder: string;
  readonly productId: string;
  /** The valid time of the publication: the instant of the fill's last commit. */
  readonly at: string;
  readonly head?: IndexHead;
  readonly repositories: (name: string) => GitReader | undefined;
}

/** What the index published and what it left out, each with its file and line. */
export type ProductIndexReport = IndexReport & {
  /** Findings that kept a kind or a page out of the index, each scoped to it; the Problems page lists them. */
  readonly findings: readonly Finding[];
};

/**
 * Publishes the product's Markdown to the graph. A finding scoped to one kind (its declaration in the manifest) or one
 * page (its file) leaves only that kind or page out, and is answered in `findings` for the Problems page: the other
 * pages are published (madarch-m38l.11). Only a manifest that cannot be read at all publishes nothing, because an index
 * made from no kinds would unpublish every page the graph holds; that refuses, naming each finding with its file and line.
 */
export async function indexProductMarkdown(options: IndexProductOptions): Promise<ProductIndexReport> {
  const kinds = readKinds(options.productFolder);
  if (kinds.present && kinds.manifest.unreadable === true) {
    throw new Error(`src/knowledge/index/index.ts: the manifest of ${options.productFolder} cannot be read, so no kind is known and nothing was published (publishing no pages would unpublish every page):\n${kinds.manifest.findings.map((finding) => `  ${finding.file}:${finding.line}: ${finding.message}`).join('\n')}`);
  }
  const { pages, findings } = readKnowledgePages(options.productFolder);
  const report = await indexKnowledge(options.owner, options.store, { productId: options.productId, at: options.at, pages, ...(options.head === undefined ? {} : { head: options.head }), repositories: options.repositories });
  return { ...report, findings };
}
export { indexWorkerProduct, type WorkerIndexOptions } from './run.js';
