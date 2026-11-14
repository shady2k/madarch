/** The shape a Relay connection answers, and the address of an entity a row names. */
import { entityAddress } from '../address.js';

/** The rows of one connection: `connection.edges[].node`. */
export function edgesOf(connection: unknown): Record<string, unknown>[] {
  if (typeof connection !== 'object' || connection === null) return [];
  const edges = (connection as Record<string, unknown>)['edges'];
  if (!Array.isArray(edges)) return [];
  return edges.map((edge) => (typeof edge === 'object' && edge !== null ? (edge as Record<string, unknown>) : {}));
}

/** The whole count a connection states beside its page. */
export function totalOf(connection: unknown): number {
  if (typeof connection !== 'object' || connection === null) return 0;
  const total = (connection as Record<string, unknown>)['totalCount'];
  return typeof total === 'number' ? total : 0;
}

/** Whether a connection has a page after this one, and the cursor that asks for it. */
export function nextOf(connection: unknown): { hasNext: boolean; cursor?: string } {
  if (typeof connection !== 'object' || connection === null) return { hasNext: false };
  const page = (connection as Record<string, unknown>)['pageInfo'];
  if (typeof page !== 'object' || page === null) return { hasNext: false };
  const info = page as Record<string, unknown>;
  const cursor = typeof info['endCursor'] === 'string' ? info['endCursor'] : undefined;
  return { hasNext: info['hasNextPage'] === true, ...(cursor === undefined ? {} : { cursor }) };
}

/** The address of one entity: its kind and its id, as the graph answered them. */
export function entityHref(entity: Record<string, unknown>): string | undefined {
  const kind = entity['kind'];
  const id = entity['id'];
  if (typeof kind !== 'string' || typeof id !== 'string') return undefined;
  return entityAddress(kind, id);
}
