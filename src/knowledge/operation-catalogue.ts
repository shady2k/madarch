import type { RenderContext } from './blocks.js';
import { refOfGraph } from './blocks.js';
import type { GraphEntity } from './graph-read.js';
import type { EntityRef } from './model.js';
import { byCodePoint } from '../model/order.js';

export type OperationMetadata = { contracts: {entity: EntityRef; protocol: string}[]; implementedBy: EntityRef[]; calledBy: EntityRef[]; cuts: {relation: string; shown: number; total: number}[] };

/** Stable declared-by edges own grouping; matching names must never assign another contract. */
export async function operationMetadata(ctx: RenderContext, operation: GraphEntity): Promise<OperationMetadata> {
  const groups = await ctx.graph.neighbors(operation, {relations: ['code.declares', 'code.serves', 'code.calls-remote', 'code.calls', 'code.implements'], direction: 'in', limit: 500});
  const contracts = groups.filter((group) => group.relation === 'code.declares').flatMap((group) => group.rows).filter((row) => row.entity.kind === 'code.contract').map(({entity}) => ({entity: refOfGraph(ctx, entity), protocol: entity.properties['format'] === 'proto' ? 'gRPC' : entity.properties['format'] === 'asyncapi' ? 'AsyncAPI' : entity.properties['format'] === 'openapi' ? 'OpenAPI' : String(entity.properties['format'] ?? '')})).sort((a, b) => byCodePoint(a.entity.id, b.entity.id));
  const refs = (relations: string[]): EntityRef[] => [...new Map(groups.filter((group) => relations.includes(group.relation)).flatMap((group) => group.rows).map(({entity}) => [entity.key, refOfGraph(ctx, entity)])).values()].sort((a, b) => byCodePoint(a.id, b.id));
  return {contracts, implementedBy: refs(['code.serves', 'code.implements']), calledBy: refs(['code.calls-remote', 'code.calls']), cuts: groups.filter((group) => group.total > group.rows.length).map((group) => ({relation: group.relation, shown: group.rows.length, total: group.total}))};
}
