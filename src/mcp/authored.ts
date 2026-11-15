/**
 * The agent's graph writes over MCP (owner's rule, 2026-11-13): the graph is written by plugins and by MCP writes only,
 * a write's source is the agent that made it, and every write names its evidence. The tools replace the authored
 * create/update/delete surface: `put_entity` states the agent's opinion of an entity's fields, `put_edge` its opinion of
 * an edge, and `retract` closes only this agent's own open opinions.
 *
 * The producer is `agent:<client>@<session>`: the client's own name from `initialize` (`clientInfo`) and this server
 * process's session. It is written like a plugin's producer, so on one field the agent's and the plugins' opinions
 * meet by decision 0036, section 2 — an agreed value stands, a disagreement is null and contested.
 */
import { randomUUID } from 'node:crypto';
import type { GraphContract } from '../graph/contract.js';
import { catalogueRequests, readRequests, inputSchema, parseRequest } from '../graph/door-contract.js';
import { GraphRefusal } from '../graph/validation.js';
import { KnowledgeProduct } from '../knowledge/product.js';
import { withSpan } from '../obs/trace.js';
import { serveUnitMcp } from '../fill/unit-mcp.js';
import { runningVersion } from '../product/version.js';
import { knowledgeRootOf } from '../product/store.js';
import { productsHome, type DraftEnv } from '../product/home.js';
import { WriteRefusal, type WriteSource } from '../graph/graph-writes.js';
import { renderDiagram } from '../render/diagram-render.js';
import type { McpToolDefinition, UnitToolAnswer } from './types.js';

/** The producer a client's writes carry: `agent:<client>`, its session as the producer's version. */
export function agentSource(client: string, session: string): WriteSource {
  const name = client.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || 'mcp-client';
  return { producer: `agent:${name}`, version: session };
}

const TOOL_DESCRIPTIONS = {
  graph_schema: 'Read the catalogue-generated GraphQL schema.',
  graph_query: 'Run one GraphQL read against the published catalogue schema.',
  render_diagram: 'Render one entity neighbourhood.',
  put_entity: 'State an evidenced opinion using the generated kind contract.',
  put_edge: 'State an evidenced edge using the generated edge contract.',
  retract: 'Withdraw this source’s evidenced entity or edge opinion.',
};

/** Advertised and executed contracts are generated from the same published catalogue. */
export function productTools(contract: GraphContract): readonly McpToolDefinition[] {
  const requests = { ...readRequests, ...catalogueRequests(contract) };
  return Object.entries(TOOL_DESCRIPTIONS).map(([name, description]) => ({ name, description, inputSchema: inputSchema(requests[name as keyof typeof TOOL_DESCRIPTIONS]) }));
}

/** One tool call of the product session, its refusal answered as the tool's own content. */
export async function callProductTool(product: KnowledgeProduct, source: WriteSource, name: string, input: unknown): Promise<UnitToolAnswer> {
  return await withSpan('mcp.product', { 'mcp.tool': name, 'mcp.producer': source.producer }, async () => {
    try {
      if (!Object.hasOwn(TOOL_DESCRIPTIONS, name)) throw new GraphRefusal('/tool', Object.keys(TOOL_DESCRIPTIONS).join(', '), name);
      const requests = Object.hasOwn(readRequests, name) ? readRequests : catalogueRequests(await product.requestContract());
      const args = parseRequest(requests[name as keyof typeof requests], input) as Record<string, unknown>;
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
      if (name === 'put_entity') {
        const answer = await product.putEntity(source, {
          kind: String(args['kind'] ?? ''),
          ...(args['key'] === undefined ? {} : { key: args['key'] }),
          ...(args['id'] === undefined ? {} : { id: String(args['id']) }),
          values: args['values'],
          evidence: args['evidence'],
          ...(typeof args['words'] === 'string' ? { words: args['words'] } : {}),
        });
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
        });
        return { answer, isError: false };
      }
      const answer = await product.retract(source, {
        ...(args['entity'] === undefined ? {} : { entity: args['entity'] }),
        ...(args['edge'] === undefined ? {} : { edge: args['edge'] }),
        evidence: args['evidence'],
        ...(typeof args['words'] === 'string' ? { words: args['words'] } : {}),
      });
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
  input?: AsyncIterable<string | Uint8Array>; output?: { write(text: string): void };
}): Promise<number> {
  const env = options.env ?? process.env;
  const product = new KnowledgeProduct({ productFolder: options.productFolder, storeRoot: knowledgeRootOf(productsHome(env, options.home)), env });
  const session = randomUUID();
  let client = 'mcp-client';
  try {
    await serveUnitMcp({
      tools: productTools(await product.requestContract()),
      info: { name: 'madarch', version: runningVersion() },
      onClientInfo: (info) => { client = info.name; },
      call: (name, args) => callProductTool(product, agentSource(client, session), name, args),
      streams: { input: options.input ?? process.stdin, write: (text) => { (options.output ?? process.stdout).write(text); } },
    });
    return 0;
  } finally { await product.close(); }
}
