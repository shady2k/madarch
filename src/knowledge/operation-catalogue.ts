import { resolve } from 'node:path';
import type { RenderContext } from './blocks.js';
import { refOfGraph } from './blocks.js';
import type { GraphEntity } from './graph-read.js';
import type { EntityRef } from './model.js';
import { byCodePoint } from '../model/order.js';

export type OperationMetadata = { contracts: {entity: EntityRef; protocol: string; directions?: ('publish' | 'subscribe')[]; directionStatus?: 'known' | 'unavailable'; producedBy?: EntityRef[]; consumedBy?: EntityRef[]}[]; implementedBy: EntityRef[]; calledBy: EntityRef[]; cuts: {relation: string; shown: number; total: number}[] };

/** Stable declared-by edges own grouping; matching names must never assign another contract. */
export async function operationMetadata(ctx: RenderContext, operation: GraphEntity): Promise<OperationMetadata> {
  const groups = await ctx.graph.neighbors(operation, {relations: ['code.declares', 'code.serves', 'code.calls-remote', 'code.calls', 'code.implements', ...(operation.kind === 'code.channel' ? ['code.publishes', 'code.consumes'] : [])], direction: 'in', limit: 500});
  const owners = groups.filter((group) => group.relation === 'code.declares').flatMap((group) => group.rows).filter((row) => row.entity.kind === 'code.contract');
  const contracts: OperationMetadata['contracts'] = owners.map(({entity}) => ({entity: refOfGraph(ctx, entity), protocol: entity.properties['format'] === 'proto' ? 'gRPC' : entity.properties['format'] === 'asyncapi' ? 'AsyncAPI' : entity.properties['format'] === 'openapi' ? 'OpenAPI' : String(entity.properties['format'] ?? '')})).sort((a, b) => byCodePoint(a.entity.id, b.entity.id));
  const refs = (relations: string[]): EntityRef[] => [...new Map(groups.filter((group) => relations.includes(group.relation)).flatMap((group) => group.rows).map(({entity}) => [entity.key, refOfGraph(ctx, entity)])).values()].sort((a, b) => byCodePoint(a.id, b.id));
  if (operation.kind === 'code.channel') for (const owner of contracts) {
    const directions = operation.properties['directions'];
    owner.directionStatus = operation.properties['direction_status'] === 'known' ? 'known' : 'unavailable';
    if (owner.directionStatus !== 'known') continue;
    if (!Array.isArray(directions) || !directions.every((direction) => direction === 'publish' || direction === 'subscribe')) {
      const path = operation.span?.path ?? operation.key;
      const line = operation.span?.lineStart ?? 1;
      const repo = ctx.repoOfScope(operation.scope) ?? null;
      const fullPath = repo === null ? resolve(ctx.productFolder, path) : resolve(ctx.productFolder, 'repos', repo, path);
      throw new Error(`${path}:${line} (${fullPath}): a known channel direction opinion must supply publish/subscribe directions`);
    }
    owner.directions = directions;
    if (directions.includes('subscribe')) owner.producedBy = refs(['code.publishes']);
    if (directions.includes('publish')) owner.consumedBy = refs(['code.consumes']);
  }
  return {contracts, implementedBy: refs(['code.serves', 'code.implements']), calledBy: refs(['code.calls-remote', 'code.calls']), cuts: groups.filter((group) => group.total > group.rows.length).map((group) => ({relation: group.relation, shown: group.rows.length, total: group.total}))};
}
