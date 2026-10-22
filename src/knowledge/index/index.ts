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
  for (const entity of read.entities) {
    try {
      pages.push(readIndexedPage(entity.file, readFileSync(join(productFolder, entity.file), 'utf8'), (text) => sha256Hex(new TextEncoder().encode(text))));
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

/**
 * Publishes the product's Markdown to the graph. Refuses (throws, naming each
 * finding with its file and line) when a page cannot be read: an index that
 * dropped a page would be a smaller picture of the product.
 */
export async function indexProductMarkdown(options: IndexProductOptions): Promise<IndexReport> {
  const { pages, findings } = readKnowledgePages(options.productFolder);
  const pageFindings = findings.filter((finding) => !finding.file.endsWith('kinds.yaml'));
  if (pageFindings.length > 0) {
    throw new Error(`src/knowledge/index/index.ts: the Markdown of ${options.productFolder} cannot be indexed whole:\n${pageFindings.map((finding) => `  ${finding.file}:${finding.line}: ${finding.message}`).join('\n')}`);
  }
  return await indexKnowledge(options.owner, options.store, { productId: options.productId, at: options.at, pages, ...(options.head === undefined ? {} : { head: options.head }), repositories: options.repositories });
}
