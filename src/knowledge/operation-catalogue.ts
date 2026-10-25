import type { RenderContext } from './blocks.js';
import { refOfGraph } from './blocks.js';
import type { GraphEntity } from './graph-read.js';
import type { EntityRef } from './model.js';
import { byCodePoint } from '../model/order.js';
import {contractDocument, contractFullPath, contractObjectAt, object} from './contract-document.js';

export type OperationMetadata = { contracts: {entity: EntityRef; protocol: string; directions?: ('publish' | 'subscribe')[]; directionStatus?: 'known' | 'unavailable'; producedBy?: EntityRef[]; consumedBy?: EntityRef[]}[]; implementedBy: EntityRef[]; calledBy: EntityRef[]; cuts: {relation: string; shown: number; total: number}[] };

/** Stable declared-by edges own grouping; matching names must never assign another contract. */
export async function operationMetadata(ctx: RenderContext, operation: GraphEntity): Promise<OperationMetadata> {
  const groups = await ctx.graph.neighbors(operation, {relations: ['code.declares', 'code.serves', 'code.calls-remote', 'code.calls', 'code.implements', ...(operation.kind === 'code.channel' ? ['code.publishes', 'code.consumes'] : [])], direction: 'in', limit: 500});
  const owners = groups.filter((group) => group.relation === 'code.declares').flatMap((group) => group.rows).filter((row) => row.entity.kind === 'code.contract');
  const contracts: OperationMetadata['contracts'] = owners.map(({entity}) => ({entity: refOfGraph(ctx, entity), protocol: entity.properties['format'] === 'proto' ? 'gRPC' : entity.properties['format'] === 'asyncapi' ? 'AsyncAPI' : entity.properties['format'] === 'openapi' ? 'OpenAPI' : String(entity.properties['format'] ?? '')})).sort((a, b) => byCodePoint(a.entity.id, b.entity.id));
  const refs = (relations: string[]): EntityRef[] => [...new Map(groups.filter((group) => relations.includes(group.relation)).flatMap((group) => group.rows).map(({entity}) => [entity.key, refOfGraph(ctx, entity)])).values()].sort((a, b) => byCodePoint(a.id, b.id));
  if (operation.kind === 'code.channel') for (const owner of contracts) {
    const entity = owners.find((held) => held.entity.key === owner.entity.id)?.entity;
    owner.directionStatus = 'unavailable';
    if (entity === undefined || entity.properties['format'] !== 'asyncapi') continue;
    const path = typeof entity.properties['path'] === 'string' ? entity.properties['path'] : entity.key.slice('code.contract:'.length);
    const repo = ctx.repoOfScope(entity.scope) ?? null;
    try {
      const {document} = await contractDocument(path, (file) => ctx.readSource(repo, file), (file) => contractFullPath(ctx.productFolder, repo, file));
      if (typeof document['asyncapi'] !== 'string' || !document['asyncapi'].startsWith('2.')) continue;
      const channels = document['channels'];
      const name = operation.label;
      const channel = contractObjectAt(document, object(channels) ? channels[name] : undefined);
      if (channel === undefined) continue;
      owner.directions = (['publish', 'subscribe'] as const).filter((direction) => object(channel[direction]));
      owner.directionStatus = 'known';
      if (owner.directions.includes('subscribe')) owner.producedBy = refs(['code.publishes']);
      if (owner.directions.includes('publish')) owner.consumedBy = refs(['code.consumes']);
    } catch {
      // The catalogue stays visible; Definition carries the exact source-located refusal.
    }
  }
  return {contracts, implementedBy: refs(['code.serves', 'code.implements']), calledBy: refs(['code.calls-remote', 'code.calls']), cuts: groups.filter((group) => group.total > group.rows.length).map((group) => ({relation: group.relation, shown: group.rows.length, total: group.total}))};
}
