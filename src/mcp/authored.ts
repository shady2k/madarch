/**
 * Graph tools share the durable operation host. Writes require a principal provisioned by the host.
 * Client initialization is display metadata, never authentication. The execution session is provenance;
 * the producer and the transport operation identity remain stable across sessions.
 */
import { Type } from 'typebox';
import { isDevelopmentTool } from '../graph/development-read.js';
import { Value } from 'typebox/value';
import { randomUUID } from 'node:crypto';
import { KnowledgeProduct } from '../knowledge/product.js';
import { withSpan } from '../obs/trace.js';
import { serveUnitMcp } from '../fill/unit-mcp.js';
import { runningVersion } from '../product/version.js';
import { knowledgeRootOf } from '../product/store.js';
import { productsHome, type DraftEnv } from '../product/home.js';
import { WriteRefusal, evidenceOf, type WriteSource } from '../graph/graph-writes.js';
import type { ProducerBinding } from '../graph/producer-binding.js';
import { GraphEvidenceEntrySchema } from '../graph/evidence-schema.js';
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

const object = (properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> => ({ type: 'object', additionalProperties: false, required, properties });

const END = Type.Object({
  kind: Type.String(), key: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  keyEdges: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Role to full entity reference map.' })),
  id: Type.Optional(Type.String()),
}, { additionalProperties: false });

const EVIDENCE = Type.Array(Type.Object({
  target: END, relation: Type.Optional(Type.String()),
  locator: Type.Optional(Type.Partial(Type.Object({
    path: Type.String(), commit: Type.String(), digest: Type.String(),
    lineStart: Type.Integer(), lineEnd: Type.Integer(), columnStart: Type.Integer(), columnEnd: Type.Integer(), start: Type.Integer(), end: Type.Integer(),
  }, { additionalProperties: false }))),
}, { additionalProperties: false }), { minItems: 1, description: 'Declared graph evidence endpoint and optional immutable source locator.' });

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
  {
    name: 'render_diagram',
    description: 'Renders one entity\'s diagram on the server, the same answer the wiki\'s page and GET /render/diagram get: the neighbourhood at a depth, an edge and its inverse drawn once, more than aggregateAbove neighbours of one kind folded into one node with the count. "likec4" answers the workspace and its laid-out model with each node\'s page; "mermaid" answers the flowchart source; "archify" answers its self-contained interactive HTML page.',
    inputSchema: object({
      entity: { type: 'string', description: 'The stable uid of the entity whose diagram is drawn.' },
      format: { type: 'string', enum: ['likec4', 'mermaid', 'archify'], description: 'likec4 by default.' },
      depth: { type: 'integer', enum: [1], description: 'One level from the entity; deeper neighbourhoods are not supported.' },
      aggregateAbove: { type: 'integer', description: 'How many neighbours of one kind stand as one node; 12 by default.' },
      lang: { type: 'string', description: 'The reader language for the labels.' },
    }, ['entity']),
  },
];

/** The write tools: the agent's opinions and retractions. */
const validUid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && [...value].every((point, index) => [8, 13, 18, 23].includes(index) ? point === '-' : '0123456789abcdefABCDEF'.includes(point));

const PRECONDITIONS = Type.Array(Type.Object({ uid: Type.String(), recordedSequence: Type.String({ minLength: 1 }) }, { additionalProperties: false }));

const RESOLVE_DISPUTE = Type.Object({
  operationKey: Type.String({ minLength: 1 }),
  questionUid: Type.String({ minLength: 36, maxLength: 36 }),
  chosenAssertionUid: Type.String({ minLength: 36, maxLength: 36 }),
  expectedCandidates: Type.Array(Type.String({ minLength: 36, maxLength: 36 }), { minItems: 2, uniqueItems: true }),
  rationale: Type.String({ minLength: 1 }),
  evidence: Type.Array(GraphEvidenceEntrySchema, { minItems: 1 }),
}, { additionalProperties: false });

const WRITE_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'graph_resolve_dispute',
    description: 'Record an authenticated person’s decision pinned to the exact candidate assertions. Changed candidates are refused; replaying operationKey returns the original receipt. Client metadata grants no authority.',
    inputSchema: { ...RESOLVE_DISPUTE },
  },
  {
    name: 'put_entity',
    description: 'State the agent\'s opinion of the given fields of an entity of any kind of the published manifest, created when its key names none. Evidence is required. An unknown field is refused by name.',
    inputSchema: object({
      kind: { type: 'string', description: 'The kind of the published manifest, such as doc.term.' },
      key: { type: 'object', description: 'The kind\'s key fields; omitted when id names the entity.' },
      keyEdges: { type: 'object', description: 'Identity role to full entity reference map.' },
      id: { type: 'string', description: 'The stable uid of an entity to write again; for a kind with no key it is also the uid its entity takes when it does not stand yet, so a write of the same uid twice states one entity.' },
      values: { type: 'object', description: 'The field values the agent states.' },
      evidence: EVIDENCE,
      preconditions: PRECONDITIONS,
      contractVersion: { type: 'string', minLength: 1 },
      words: { type: 'string', description: 'The agent\'s exact words, attached to the assertion operation.' },
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
      preconditions: PRECONDITIONS,
      contractVersion: { type: 'string', minLength: 1 },
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
      evidence: EVIDENCE,
      preconditions: PRECONDITIONS,
      contractVersion: { type: 'string', minLength: 1 },
      words: { type: 'string' },
    }, ['evidence']),
  },
];

/** Every tool of the one product session: the schema, one query, and the agent's writes. */
export const PRODUCT_TOOLS: readonly McpToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS];

/** One tool call of the product session, its refusal answered as the tool's own content. */
export async function callProductTool(product: KnowledgeProduct, source: WriteSource, name: string, input: unknown, hostBinding?: ProducerBinding): Promise<UnitToolAnswer> {
  return await withSpan('mcp.product', { 'mcp.tool': name, 'mcp.producer': source.producer }, async () => {
    try {
      if (isDevelopmentTool(name)) return await product.developmentRead(name, input) as UnitToolAnswer;
      if (!PRODUCT_TOOLS.some((tool) => tool.name === name)) throw new WriteRefusal(`${JSON.stringify(name)} is no tool of this server: the tools are ${PRODUCT_TOOLS.map((tool) => tool.name).join(', ')}`);
      if (input !== null && (typeof input !== 'object' || Array.isArray(input))) throw new WriteRefusal('the arguments are one object');
      const args = (input ?? {}) as Record<string, unknown>;
      // The declared schema is the boundary: an argument no tool names is refused, and words is the agent's text.
      const tool = PRODUCT_TOOLS.find((tool) => tool.name === name)!;
      const allowed = Object.keys(tool.inputSchema['properties'] as Record<string, unknown>);
      const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
      if (unknown.length > 0) throw new WriteRefusal(`${JSON.stringify(unknown[0])} is not an argument of ${name}: its arguments are ${allowed.join(', ') || 'none'}`, unknown[0]);
      if ('words' in args && typeof args['words'] !== 'string') throw new WriteRefusal('words is the agent\'s exact words, as text', 'words');
      const preconditions = args['preconditions'];
      if (preconditions !== undefined && (!Value.Check(PRECONDITIONS, preconditions) || preconditions.some(value => !validUid(value.uid) || [...value.recordedSequence].some(point => point < '0' || point > '9')))) throw new WriteRefusal('preconditions must name uid and recordedSequence text', 'preconditions');
      const contractVersion = args['contractVersion'];
      if (contractVersion !== undefined && (typeof contractVersion !== 'string' || contractVersion.length === 0)) throw new WriteRefusal('contractVersion must be nonempty text', 'contractVersion');
      const checks = preconditions as { readonly uid: string; readonly recordedSequence: string }[] | undefined;
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
        if (!Value.Check(RESOLVE_DISPUTE, args)) {
          const failure = [...Value.Errors(RESOLVE_DISPUTE, args)][0];
          throw new WriteRefusal(failure?.message ?? 'invalid dispute resolution request', failure?.instancePath);
        }
        const request = args as unknown as { operationKey: string; questionUid: string; chosenAssertionUid: string; expectedCandidates: string[]; rationale: string; evidence: unknown };
        if (![request.questionUid, request.chosenAssertionUid, ...request.expectedCandidates].every(validUid)) throw new WriteRefusal('dispute identifiers must be UUIDs', 'questionUid');
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
      tools: [...PRODUCT_TOOLS, ...await product.developmentRead() as McpToolDefinition[]],
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
