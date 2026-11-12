/** Document anchors and ranges are structured producer opinions. */
import type { GraphEntity, GraphReader } from './graph-read.js';

export interface DocumentSection {
  readonly anchor: string;
  readonly title: string;
  readonly start: number;
  readonly end: number;
  readonly markdown: string;
}

/** The manifest supplies the kinds whose opinions hold document fields. */
export async function graphDocument(graph: Pick<GraphReader, 'list'>, repo: string | null, path: string, kinds: readonly string[]): Promise<GraphEntity | undefined> {
  for (const kind of kinds) {
    let after: string | undefined;
    do {
      const page = await graph.list(kind, { limit: 500, ...(after === undefined ? {} : { after }) });
      const found = page.rows.find((entity) => entity.properties['path'] === path && entity.properties['repository'] === repo);
      if (found !== undefined) return found;
      after = page.next ?? undefined;
    } while (after !== undefined);
  }
  return undefined;
}

/** Every anchor carries its producer's exact range and excerpt; the wiki infers neither. */
export function documentSections(document: GraphEntity): readonly DocumentSection[] {
  const anchors = document.properties['anchors'];
  const { repository, path } = document.properties;
  const file = repository === null ? String(path) : `repos/${String(repository)}/${String(path)}`;
  const fail = (anchor: string): never => { throw new Error(`${file}:1: document ${document.key} anchor ${JSON.stringify(anchor)} requires title, start, end and markdown`); };
  if (anchors === null || typeof anchors !== 'object' || Array.isArray(anchors)) return fail('');
  return Object.entries(anchors).map(([anchor, value]) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(anchor);
    const { title, start, end, markdown } = value as Record<string, unknown>;
    if (anchor === '' || typeof title !== 'string' || typeof markdown !== 'string' || typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return fail(anchor);
    return { anchor, title, start, end, markdown };
  });
}
