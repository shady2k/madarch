/** Joins facts emitted by different readers, using only their declared identities. */
import type {ExtractedEdge, Extraction} from '../records.js';

export function endpointRelations(extractions: readonly Extraction[]): Extraction[] {
  const nodes = extractions.flatMap((extraction) => extraction.nodes);
  const routes = nodes.filter((node) => node.kind === 'code.route');
  return extractions.map((extraction) => {
    const edges: ExtractedEdge[] = [...extraction.edges];
    for (const node of extraction.nodes) {
      if (!['code.probe', 'code.healthcheck', 'code.health-endpoint', 'code.metrics-endpoint'].includes(node.kind)) continue;
      let path = node.properties['path'];
      if (node.kind === 'code.healthcheck') {
        const test = node.properties['test'];
        const command = Array.isArray(test) ? test.join(' ') : test;
        path = typeof command === 'string' ? /https?:\/\/[^\s/]+(\/[^\s'"?]*)/.exec(command)?.[1] : undefined;
      }
      if (typeof path !== 'string') continue;
      const candidates = routes.filter((route) => route.properties['path'] === path && route.properties['method'] === 'GET' && route.properties['service'] === node.properties['service']);
      if (candidates.length !== 1) continue;
      const route = candidates[0]!;
      edges.push({type: node.kind === 'code.probe' || node.kind === 'code.healthcheck' ? 'code.probes' : 'code.served-by', from: node.key, to: route.key, discriminator: 'route', properties: {role: 'route'}, ...(node.span === undefined ? {} : {span: node.span})});
    }
    return {...extraction, edges};
  });
}
