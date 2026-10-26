/** Joins facts emitted by different readers, using only their declared identities. */
import type {ExtractedEdge, Extraction} from '../records.js';
import {resolveEndpointTarget, matchesEndpoint} from '../endpoint-target.js';

export function endpointRelations(extractions: readonly Extraction[]): Extraction[] {
  const nodes = extractions.flatMap((extraction) => extraction.nodes);
  const routes = nodes.filter((node) => node.kind === 'code.route');
  return extractions.map((extraction) => {
    const edges: ExtractedEdge[] = [...extraction.edges];
    const gaps = [...extraction.gaps];
    for (const node of extraction.nodes) {
      if (!['code.probe', 'code.healthcheck', 'code.health-endpoint', 'code.metrics-endpoint'].includes(node.kind)) continue;
      const resolved = resolveEndpointTarget(node);
      if (resolved.kind === 'non-http') continue;
      if (resolved.kind === 'unresolved') {
        if (node.kind === 'code.healthcheck') gaps.push({path:node.span?.path ?? '.',reason:`line ${node.span?.lineStart ?? 1}: healthcheck command target is unresolved (${node.key})`});
        continue;
      }
      const candidates = routes.filter((route) => matchesEndpoint(resolved.target, route));
      if (candidates.length !== 1) continue;
      const route = candidates[0]!;
      edges.push({type: node.kind === 'code.probe' || node.kind === 'code.healthcheck' ? 'code.probes' : 'code.served-by', from: node.key, to: route.key, discriminator: 'route', properties: {role: 'route'}, ...(node.span === undefined ? {} : {span: node.span})});
    }
    return {...extraction, edges, gaps};
  });
}
