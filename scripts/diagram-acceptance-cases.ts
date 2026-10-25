/** Explicit acceptance fixtures. The real view builders and app render these synthetic graph facts. */
import { buildViews, payloadOf, type ViewPayload } from '../src/knowledge/views.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import type { GraphEntity, GraphReader } from '../src/knowledge/graph-read.js';

export async function diagramAcceptanceCases(lang: string): Promise<{ name: string; views: ViewPayload[] }[]> {
  const table: GraphEntity = { key: 'code.table:orders/public.orders', kind: 'code.table', label: 'orders', properties: {}, nodeIds: [], scope: 'repo' };
  const columns = Array.from({ length: 64 }, (_, index) => ({ ...table, key: `${table.key}/column_${index}`, kind: 'code.column', label: `column_${index}`, properties: { type: 'uuid', primaryKey: index === 0 } }));
  const erGraph = {
    find: async () => [table],
    byPrefix: async (_kind: string, _prefix: string, limit: number) => ({ rows: columns.slice(0, limit), total: columns.length }),
    neighbors: async () => [{ relation: 'code.foreign-key', direction: 'out', total: 1, edges: 2, rows: [{ entity: table, edges: 2 }] }],
    relationEdges: async () => ({ rows: [0, 63].map(index => ({ from: table, to: table, discriminator: `fk_${index}`, properties: { column: `column_${index}` } })), total: 2 }),
  } as unknown as GraphReader;
  const context = (graph: GraphReader) => ({ ctx: { graph, manifest: { kinds: new Map([['code.table', {}]]) }, repoOfScope: () => undefined } as unknown as RenderContext, lang, productTitle: 'Fixture shop' });
  const er = await buildViews(context(erGraph), { type: 'er', subject: table.key });
  const cases = [{ name: 'case-er64', views: er.map(view => payloadOf(view, 'mermaid')) }];
  for (const mode of ['roots', 'one-group'] as const) {
    const rows: GraphEntity[] = Array.from({ length: 45 }, (_, index) => ({ key: mode === 'roots' ? `code.dockerfile:deploy/${String(index).padStart(2, '0')}/Dockerfile` : `code.compose-service:compose.yaml#api-${String(index).padStart(2, '0')}`, kind: mode === 'roots' ? 'code.dockerfile' : 'code.compose-service', label: `api-${index}`, properties: {}, nodeIds: [], scope: 'repo' }));
    const facts = rows.slice(1).map((to, index) => ({ from: rows[index]!, to, properties: {} }));
    const graph = { list: async (kind: string) => ({ rows: kind === rows[0]!.kind ? rows : [], total: kind === rows[0]!.kind ? rows.length : 0 }), relationEdges: async (relation: string) => ({ rows: relation === 'code.depends-on' ? facts : [], total: relation === 'code.depends-on' ? facts.length : 0 }) } as unknown as GraphReader;
    cases.push({ name: `case-${mode}45`, views: (await buildViews(context(graph), { type: 'deployment', subject: '' })).map(view => payloadOf(view, 'likec4')) });
  }
  return cases;
}
