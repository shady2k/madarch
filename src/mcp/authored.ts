/**
 * Graph tools share the durable operation host. Writes require a principal provisioned by the host.
 * Client initialization is display metadata, never authentication. The execution session is provenance;
 * the producer and the transport operation identity remain stable across sessions.
 */
import { randomUUID } from 'node:crypto';
import { KnowledgeProduct } from '../knowledge/product.js';
import { withSpan } from '../obs/trace.js';
import { serveUnitMcp } from '../fill/unit-mcp.js';
import { runningVersion } from '../product/version.js';
import { knowledgeRootOf } from '../product/store.js';
import { productsHome, type DraftEnv } from '../product/home.js';
import { WriteRefusal, evidenceOf, type WriteSource } from '../graph/graph-writes.js';
import type { ProducerBinding } from '../graph/producer-binding.js';
import type { GraphContract } from '../graph/contract.js';
import { catalogueRequests, readRequests, inputSchema, parseRequest, resolveDisputeRequest } from '../graph/door-contract.js';
import { GraphRefusal } from '../graph/validation.js';
import { renderDiagram } from '../render/diagram-render.js';
import type { McpToolDefinition, UnitToolAnswer } from './types.js';

/** Build host attribution; a client name alone grants no principal or write permission. */
export function agentSource(client: string, session: string, principal?: WriteSource['principal']): WriteSource {
  const allowed = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-';
  let normalized = '';
  for (const point of client) {
    if (allowed.includes(point)) normalized += point;
    else if (!normalized.endsWith('-')) normalized += '-';
  }
  let start = 0;
  let end = normalized.length;
  while (normalized[start] === '-') start += 1;
  while (end > start && normalized[end - 1] === '-') end -= 1;
  const name = normalized.slice(start, end).slice(0, 64) || 'mcp-client';
  return { producer: `agent:${principal?.identity ?? name}`, version: session, ...(principal === undefined ? {} : { principal }) };
}

const TOOL_DESCRIPTIONS = {
  graph_schema: 'Read the catalogue-generated GraphQL schema.',
  graph_query: 'Run one GraphQL read against the published catalogue schema.',
  render_diagram: 'Render one entity neighbourhood.',
  put_entity: 'State an evidenced assertion using the generated kind contract.',
  put_edge: 'State an evidenced edge using the generated edge contract.',
  retract: 'Withdraw this source’s evidenced entity or edge assertions.',
  graph_resolve_dispute: 'Record an authenticated person’s decision pinned to exact candidate assertions. Changed candidates are refused; operationKey replay returns the original receipt.',
};

/** Advertised and executed contracts are generated from the same published catalogue. */
export function productTools(contract: GraphContract): readonly McpToolDefinition[] {
  const requests = { ...readRequests, ...catalogueRequests(contract), graph_resolve_dispute: resolveDisputeRequest };
  return Object.entries(TOOL_DESCRIPTIONS).map(([name, description]) => ({ name, description, inputSchema: inputSchema(requests[name as keyof typeof TOOL_DESCRIPTIONS]) }));
}

/** One tool call of the product session, its refusal answered as the tool's own content. */
export async function callProductTool(product: KnowledgeProduct, source: WriteSource, name: string, input: unknown, hostBinding?: ProducerBinding): Promise<UnitToolAnswer> {
  return await withSpan('mcp.product', { 'mcp.tool': name, 'mcp.producer': source.producer }, async () => {
    try {
      if (!Object.hasOwn(TOOL_DESCRIPTIONS, name)) throw new GraphRefusal('/tool', Object.keys(TOOL_DESCRIPTIONS).join(', '), name);
      const requests = { ...(Object.hasOwn(readRequests, name) || name === 'graph_resolve_dispute' ? readRequests : catalogueRequests(await product.requestContract())), graph_resolve_dispute: resolveDisputeRequest };
      const args = parseRequest(requests[name as keyof typeof requests], input) as Record<string, unknown>;
      const contractVersion = args['contractVersion'] as string | undefined;
      const checks = args.preconditions as { readonly uid: string; readonly recordedSequence: string }[] | undefined;
      if (name === 'graph_schema') return { answer: { schema: await product.graphqlSchema() }, isError: false };
      if (name === 'graph_query') {
        const query = args['query'];
        if (typeof query !== 'string' || query.trim() === '') throw new WriteRefusal('"query" is the GraphQL operation text', 'query');
        const variables = args['variables'];
        if (variables !== undefined && variables !== null && (typeof variables !== 'object' || Array.isArray(variables))) throw new WriteRefusal('"variables" is an object of the operation\'s variables', 'variables');
        const operationName = args['operationName'];
        if (operationName !== undefined && operationName !== null && typeof operationName !== 'string') throw new WriteRefusal('"operationName" is the name of the operation to run', 'operationName');
        const lang = args['lang'];
        if (lang !== undefined && typeof lang !== 'string') throw new WriteRefusal('"lang" is the reader language', 'lang');
        const answer = await product.graphql({
          query,
          ...(variables === undefined || variables === null ? {} : { variables: variables as Record<string, unknown> }),
          ...(operationName === undefined ? {} : { operationName: operationName as string | null }),
          ...(lang === undefined ? {} : { lang }),
        });
        const body = answer.body as Record<string, unknown>;
        return { answer: body, isError: Array.isArray(body['errors']) && body['errors'].length > 0 };
      }
      if (name === 'render_diagram') {
        const entity = args['entity'];
        if (typeof entity !== 'string' || entity.trim() === '') throw new WriteRefusal('"entity" is the uid of the entity whose diagram is drawn', 'entity');
        const format = args['format'] === undefined ? 'likec4' : args['format'];
        if (format !== 'likec4' && format !== 'mermaid' && format !== 'archify') throw new WriteRefusal('"format" is one of likec4, mermaid and archify', 'format');
        const depth = args['depth'];
        if (depth !== undefined && (typeof depth !== 'number' || !Number.isInteger(depth) || depth !== 1)) throw new WriteRefusal('"depth" must be 1; deeper diagram neighbourhoods are not supported', 'depth');
        const aggregateAbove = args['aggregateAbove'];
        if (aggregateAbove !== undefined && (typeof aggregateAbove !== 'number' || !Number.isInteger(aggregateAbove) || aggregateAbove < 1)) throw new WriteRefusal('"aggregateAbove" is a whole number of neighbours, 1 or more', 'aggregateAbove');
        const lang = args['lang'];
        if (lang !== undefined && typeof lang !== 'string') throw new WriteRefusal('"lang" is the reader language', 'lang');
        const answer = await renderDiagram(product, { entity: entity.trim(), format, ...(depth === undefined ? {} : { depth: depth as number }), ...(aggregateAbove === undefined ? {} : { aggregateAbove: aggregateAbove as number }), ...(lang === undefined ? {} : { lang }) });
        if ('error' in answer) return { answer: { error: answer.error }, isError: true };
        if ('html' in answer) return { answer: { format: 'archify', html: answer.html }, isError: false };
        return { answer: answer.body, isError: false };
      }
      if (!hostBinding) throw new WriteRefusal('SOURCE_FORBIDDEN a retained host source grant is required');
      if (name === 'graph_resolve_dispute') {
        const request = args as unknown as { operationKey: string; questionUid: string; chosenAssertionUid: string; expectedCandidates: string[]; rationale: string; evidence: unknown };
        const answer = await product.resolveDispute(source, { questionUid: request.questionUid, chosenAssertionUid: request.chosenAssertionUid, expectedCandidates: request.expectedCandidates, rationale: request.rationale, evidence: evidenceOf(request.evidence) }, request.operationKey, hostBinding!);
        return { answer, isError: false };
      }
      if (name === 'put_entity') {
        const answer = await product.putEntity(source, {
          kind: String(args['kind'] ?? ''),
          ...(args['key'] === undefined ? {} : { key: args['key'] }),
          ...(args['keyEdges'] === undefined ? {} : { keyEdges: args['keyEdges'] }),
          ...(args['id'] === undefined ? {} : { id: String(args['id']) }),
          values: args['values'],
          evidence: args['evidence'],
          ...(typeof args['words'] === 'string' ? { words: args['words'] } : {}),
        }, { preconditions: checks, contractVersion, hostBinding: hostBinding! });
        return { answer, isError: false };
      }
      if (name === 'put_edge') {
        const answer = await product.putEdge(source, {
          kind: String(args['kind'] ?? ''),
          from: args['from'], to: args['to'],
          ...(args['discriminator'] === undefined ? {} : { discriminator: String(args['discriminator']) }),
          ...(args['values'] === undefined ? {} : { values: args['values'] }),
          evidence: args['evidence'],
          ...(typeof args['words'] === 'string' ? { words: args['words'] } : {}),
        }, { preconditions: checks, contractVersion, hostBinding: hostBinding! });
        return { answer, isError: false };
      }
      const answer = await product.retract(source, {
        ...(args['entity'] === undefined ? {} : { entity: args['entity'] }),
        ...(args['edge'] === undefined ? {} : { edge: args['edge'] }),
        evidence: args['evidence'],
        ...(typeof args['words'] === 'string' ? { words: args['words'] } : {}),
      }, { preconditions: checks, contractVersion, hostBinding: hostBinding! });
      return { answer, isError: false };
    } catch (error) {
      if (error instanceof GraphRefusal) return { answer: { error: error.toJSON() }, isError: true };
      const message = error instanceof Error ? error.message : String(error);
      const named = /^\/.+:\d+:/u.test(message) ? message : `${import.meta.path}:1: ${message}`;
      return { answer: { error: { code: 'write-failed', message: named } }, isError: true };
    }
  });
}

/** Serves the product's graph writes over MCP: the agent's producer is its `clientInfo` name and this session. */
export async function serveProductMcp(options: {
  productFolder: string; home?: string; env?: DraftEnv;
  trustedPrincipal?: WriteSource['principal'];
  resolverBinding?: ProducerBinding;
  input?: AsyncIterable<string | Uint8Array>; output?: { write(text: string): void };
}): Promise<number> {
  const env = options.env ?? process.env;
  const product = new KnowledgeProduct({ productFolder: options.productFolder, storeRoot: knowledgeRootOf(productsHome(env, options.home)), env });
  const session = randomUUID();
  let client = 'mcp-client';
  try {
    let agent: ProducerBinding | undefined;
    const resolver = options.resolverBinding;
    await serveUnitMcp({
      tools: productTools(await product.requestContract()),
      info: { name: 'madarch', version: runningVersion() },
      onClientInfo: (info) => { client = info.name; },
      call: async (name, args, requestId) => {
        if (['put_entity', 'put_edge', 'retract'].includes(name)) agent ??= await product.provisionAgentBinding(session);
        return await callProductTool(product, { ...agentSource(client, session, options.trustedPrincipal), operationId: requestId }, name, args, name === 'graph_resolve_dispute' ? resolver : agent);
      },
      streams: { input: options.input ?? process.stdin, write: (text) => { (options.output ?? process.stdout).write(text); } },
    });
    return 0;
  } finally { await product.close(); }
}
