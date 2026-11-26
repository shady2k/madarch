
/**
 * The product's sources (decision 0031's Sources page, kept for the frame): every Markdown document the graph holds, a
 * file path and a repository, and the repositories it is grouped by. A document is an entity projected by the declared
 * document semantic role; no kind is named here, and the page names none either.
 */
import { documentOpinions } from './anchors.js';
import { byCodePoint } from '../model/order.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import type { GraphReader } from './graph-read.js';

/** One document: where it lives, its title, and the entity page that shows it when the graph gives it an id. */
export interface SourceDocument {
  readonly repo: string | null;
  readonly path: string;
  readonly title: string;
  readonly kind: string;
  /** The entity's stable uid; null when the kind has no natural key. */
  readonly id: string | null;
}

/** One repository the product declares, with the product's own repository as the null name. */
export interface SourceRepository {
  readonly name: string | null;
  readonly present: boolean;
  readonly filled: boolean;
}

export interface SourcesListing {
  readonly documents: readonly SourceDocument[];
  readonly repositories: readonly SourceRepository[];
  /** The repositories whose documents exceeded the page's cap, with how many were shown of the total. */
  readonly truncated: readonly { readonly repo: string | null; readonly shown: number; readonly total: number }[];
  /** Why some documents could not be listed, when a check could not be made. */
  readonly note?: string;
}

/** Documents projected by the catalogue semantic binding. */
export async function listDocuments(manifest: KindsManifest, graph: GraphReader): Promise<SourceDocument[]> {
  const documents: SourceDocument[] = [];
  for (const entity of await documentOpinions(graph, manifest)) {
    const { path, repository } = entity.properties as { path: string; repository: string | null };
    documents.push({ repo: repository, path, title: entity.label, kind: entity.kind, id: entity.uid ?? null });
  }
  return documents.sort((left, right) => byCodePoint(`${left.repo ?? ''}:${left.path}`, `${right.repo ?? ''}:${right.path}`));
}

/** The listing the Sources page reads: the capped documents of each repository, and the repositories themselves. */
export async function sourcesListing(manifest: KindsManifest, graph: GraphReader, repositories: readonly SourceRepository[]): Promise<SourcesListing> {
  const documents = await listDocuments(manifest, graph);
  const limit = 2_000;
  const totals = new Map<string | null, number>();
  const shown = documents.filter((document) => {
    const count = (totals.get(document.repo) ?? 0) + 1;
    totals.set(document.repo, count);
    return count <= limit;
  });
  return {
    documents: shown,
    repositories,
    truncated: [...totals].filter(([, total]) => total > limit).map(([repo, total]) => ({ repo, total, shown: limit })),
  };
}
