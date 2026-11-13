/** Knowledge page opinions, read from the one graph rather than product files. */
import type { GraphReader } from '../graph-read.js';
import type { Finding, KindsManifest } from '../../product/manifest/kinds.js';
import { graphMarkdownEntities } from '../markdown.js';
import type { IndexedPage, WrittenAt } from './page.js';
export type { IndexedPage } from './page.js';
export { changedGrounds } from './queries.js';
export type { GroundChange } from './queries.js';

export async function graphKnowledgePages(graph: Pick<GraphReader, 'list'>, manifest: KindsManifest): Promise<{ pages: IndexedPage[]; findings: Finding[] }> {
  const read = await graphMarkdownEntities(graph, manifest);
  return {
    pages: read.entities.map((entity) => ({
      id: entity.id, kind: entity.kind, title: entity.title, file: entity.file,
      relates: entity.relates, sources: entity.sources, producer: entity.producer,
      writtenAt: writtenAt(entity.front['written-at'], entity.id),
      statements: entity.indexedStatements, mentions: entity.mentions, digest: entity.digest,
    })),
    findings: read.findings,
  };
}

function writtenAt(value: unknown, id: string): WrittenAt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`src/knowledge/index/index.ts: ${id}.written-at: expected a list of structured opinions`);
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`src/knowledge/index/index.ts: ${id}.written-at: expected a repository and commit`);
    const record = entry as Record<string, unknown>;
    if (typeof record['repository'] !== 'string' || typeof record['commit'] !== 'string' || (record['branch'] !== undefined && typeof record['branch'] !== 'string') || (record['origin'] !== undefined && typeof record['origin'] !== 'string')) throw new Error(`src/knowledge/index/index.ts: ${id}.written-at: expected repository, commit and optional branch/origin texts`);
    return record as unknown as WrittenAt;
  });
}
