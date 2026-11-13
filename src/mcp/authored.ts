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
import { KnowledgeProduct } from '../knowledge/product.js';
import { withSpan } from '../obs/trace.js';
import { serveUnitMcp } from '../fill/unit-mcp.js';
import { runningVersion } from '../product/version.js';
import { knowledgeRootOf } from '../product/store.js';
import { productsHome, type DraftEnv } from '../product/home.js';
import { WriteRefusal, type WriteSource } from '../graph/graph-writes.js';
import type { McpToolDefinition, UnitToolAnswer } from './types.js';

/** The producer a client's writes carry: `agent:<client>`, its session as the producer's version. */
export function agentSource(client: string, session: string): WriteSource {
  const name = client.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || 'mcp-client';
  return { producer: `agent:${name}`, version: session };
}

const object = (properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> => ({ type: 'object', additionalProperties: false, required, properties });

const EVIDENCE = {
  type: 'array', minItems: 1,
  description: 'What the write rests on, at least one: {type:"file", path, commit or blob, lineStart, lineEnd?, repository?}, {type:"conversation", id, at?, words} or {type:"url", url, at}.',
  items: { type: 'object' },
};

const END = {
  type: 'object', additionalProperties: false, required: ['kind'],
  properties: { kind: { type: 'string', description: 'The kind of this end.' }, key: { type: 'object', description: 'The key fields of the entity.' }, id: { type: 'string', description: 'The stable uid, instead of a key.' } },
};

/** The read tools: the schema and one operation, through the same executor the wiki's POST /graphql runs. */
const READ_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'graph_schema',
    description: 'The product GraphQL schema (decision 0036): the SDL its published manifest derives, the same schema POST /graphql reads through. Reads the published manifest in a snapshot.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'graph_query',
    description: 'Runs one GraphQL operation against the product graph through the same executor the wiki uses: an entity by id, a kind list filtered, ordered and paged, an edge both ways, backlinks, opinions, catalogue entities. Answers the GraphQL result, or its errors with their codes (LIMIT_DEPTH, LIMIT_NODES, LIMIT_ALIASES, TIMEOUT, TOO_LARGE).',
    inputSchema: object({
      query: { type: 'string', description: 'The GraphQL operation text; graph_schema gives the SDL it must satisfy.' },
      variables: { type: 'object', description: 'The operation variables, keyed by name.' },
      operationName: { type: 'string', description: 'Which operation to run when the text holds several.' },
      lang: { type: 'string', description: 'The reader language for text fields.' },
    }, ['query']),
  },
];

/** The write tools: the agent's opinions and retractions. */
const WRITE_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'put_entity',
    description: 'State the agent\'s opinion of the given fields of an entity of any kind of the published manifest, created when its key names none. Evidence is required. An unknown field is refused by name.',
    inputSchema: object({
      kind: { type: 'string', description: 'The kind of the published manifest, such as doc.term.' },
      key: { type: 'object', description: 'The kind\'s key fields; omitted when id names the entity.' },
      id: { type: 'string', description: 'The stable uid of an entity to write again.' },
      values: { type: 'object', description: 'The field values the agent states.' },
      evidence: EVIDENCE,
      words: { type: 'string', description: 'The agent\'s exact words, kept in the journal.' },
    }, ['kind', 'values', 'evidence']),
  },
  {
    name: 'put_edge',
    description: 'State the agent\'s opinion of an edge of a declared edge kind, with its attributes. Evidence is required; a repeating edge names its discriminator.',
    inputSchema: object({
      kind: { type: 'string', description: 'The edge kind of the published manifest.' },
      from: END,
      to: END,
      discriminator: { type: 'string', description: 'What tells repeated edges between the same ends apart.' },
      values: { type: 'object', description: 'The edge\'s attributes.' },
      evidence: EVIDENCE,
      words: { type: 'string' },
    }, ['kind', 'from', 'to', 'evidence']),
  },
  {
    name: 'retract',
    description: 'Close only this agent\'s own open opinions: of one entity (all its fields, or the named fields), or of one edge.',
    inputSchema: object({
      entity: {
        type: 'object', additionalProperties: false, required: ['kind'],
        properties: { kind: { type: 'string' }, key: { type: 'object' }, id: { type: 'string' }, fields: { type: 'array', items: { type: 'string' }, description: 'The fields to retract; every field when left out.' } },
      },
      edge: {
        type: 'object', additionalProperties: false, required: ['kind', 'from', 'to'],
        properties: { kind: { type: 'string' }, from: END, to: END, discriminator: { type: 'string' } },
      },
      words: { type: 'string' },
    }, []),
  },
];

/** Every tool of the one product session: the schema, one query, and the agent's writes. */
export const PRODUCT_TOOLS: readonly McpToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS];

/** One tool call of the product session, its refusal answered as the tool's own content. */
export async function callProductTool(product: KnowledgeProduct, source: WriteSource, name: string, input: unknown): Promise<UnitToolAnswer> {
  return await withSpan('mcp.product', { 'mcp.tool': name, 'mcp.producer': source.producer }, async () => {
    try {
      if (!PRODUCT_TOOLS.some((tool) => tool.name === name)) throw new WriteRefusal(`${JSON.stringify(name)} is no tool of this server: the tools are ${PRODUCT_TOOLS.map((tool) => tool.name).join(', ')}`);
      if (input !== null && (typeof input !== 'object' || Array.isArray(input))) throw new WriteRefusal('the arguments are one object');
      const args = (input ?? {}) as Record<string, unknown>;
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
        ...(typeof args['words'] === 'string' ? { words: args['words'] } : {}),
      });
      return { answer, isError: false };
    } catch (error) {
      if (error instanceof WriteRefusal) return { answer: { error: { code: 'refused', message: error.message, ...(error.field === undefined ? {} : { field: error.field }) } }, isError: true };
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
      tools: PRODUCT_TOOLS,
      info: { name: 'madarch', version: runningVersion() },
      onClientInfo: (info) => { client = info.name; },
      call: (name, args) => callProductTool(product, agentSource(client, session), name, args),
      streams: { input: options.input ?? process.stdin, write: (text) => { (options.output ?? process.stdout).write(text); } },
    });
    return 0;
  } finally { await product.close(); }
}
