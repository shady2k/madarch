/**
 * The graph a fill's agent reads (owner's decision, 2026-11-15): the schema of the product's catalogue, one GraphQL
 * operation over the graph the fill writes, and one text field of one entity in a line range — a file's text through
 * the graph. The reads stand beside the graph's own storage (`src/graph`), because they are the graph store's answer;
 * the server the agent's session is given is `src/fill/agent-graph.ts`.
 *
 * Nothing here writes: an agent's write is its answer to the unit, which the fill publishes with its evidence.
 */
import { parse, visit } from 'graphql';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { executeGraphql } from './graphql-execute.js';
import { publishedManifestOf } from '../graphql/manifest.js';
import { graphqlSchemaOf } from '../graphql/schema.js';
import { pluginGraphValue } from './plugin-turns.js';
import type { GraphContract } from './contract.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import type { McpToolDefinition, UnitToolAnswer } from '../mcp/types.js';

const WHERE = 'src/graph/agent-reads.ts';

/** What the reads answer from: the fill's own graph, its manifest and the contract its declarations made. */
export interface AgentGraphSource {
  readonly owner: DatabaseOwner;
  readonly manifest: KindsManifest;
  readonly contract: GraphContract;
  /** The product's folder, which the executor reads the page templates from. */
  readonly folder: string;
}

const object = (properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> =>
  ({ type: 'object', additionalProperties: false, required, properties });

/** The reads a fill agent makes: the schema, one GraphQL operation, one text field in a line range. */
export const AGENT_GRAPH_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'graph_schema',
    description: 'The GraphQL schema of the product catalogue the graph holds: every kind with its fields and keys, and every edge kind with its ends. A query is written against this schema.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'graph_query',
    description: 'Runs one GraphQL operation against the product graph: the entities of a kind, filtered by a field (text fields take {_contains} and {_like}), ordered and paged; one entity and its fields; an entity\'s edges both ways (outgoing, backlinks) and the opinions behind every value.',
    inputSchema: object({
      query: { type: 'string', description: 'The GraphQL operation text; graph_schema states the schema it must satisfy.' },
      variables: { type: 'object', description: 'The operation\'s variables, keyed by name.' },
      operationName: { type: 'string', description: 'Which operation to run when the text holds several.' },
      lang: { type: 'string', description: 'The reader language for text fields.' },
    }, ['query']),
  },
  {
    name: 'graph_text',
    description: 'One text field of one entity, one range of lines at a time: a file\'s text through the graph, named by its kind and its key. The answer names the range and the number of lines the field holds.',
    inputSchema: object({
      kind: { type: 'string', description: 'The entity\'s kind, as the schema names it.' },
      key: { type: 'object', description: 'The entity\'s key fields and their values.' },
      field: { type: 'string', description: 'The text field to read, such as content.' },
      lineStart: { type: 'integer', description: 'The first line of the range, counting from 1; the first line of the field when left out.' },
      lineEnd: { type: 'integer', description: 'The last line of the range, both ends included; the last line of the field when left out.' },
    }, ['kind', 'key', 'field']),
  },
];

/** One refusal as a tool's own content: the sentence a person reads, with the place it was made at. */
function refused(message: string): UnitToolAnswer {
  return { answer: { error: { code: 'refused', message } }, isError: true };
}

/** Whether an argument is a positive whole number, as a line number is. */
function lineNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * The reader's page-layer roots: `bootstrap` hands out the product's page templates as the reader's own bundles
 * (bodies read from files under `templates/`), and `templateFindings` names absolute files of this machine. The general
 * GraphQL executor serves them for the wiki; the agent's server does not (owner's rule, 2026-11-15: the agent reads only
 * the graph).
 */
const PAGE_ROOTS: readonly string[] = ['bootstrap', 'templateFindings'];

/** Every field name a GraphQL operation mentions, or undefined when its text is no operation. */
function fieldNames(text: string): Set<string> | undefined {
  try {
    const names = new Set<string>();
    visit(parse(text), { Field: { enter: (node) => { names.add(node.name.value); } } });
    return names;
  } catch {
    return undefined;
  }
}

/** Answers one of the agent's reads over the fill's own graph. */
export async function callAgentGraphTool(source: AgentGraphSource, name: string, input: unknown): Promise<UnitToolAnswer> {
  try {
    if (!AGENT_GRAPH_TOOLS.some((tool) => tool.name === name)) return refused(`${WHERE}: ${JSON.stringify(name)} is no tool of this server: the tools are ${AGENT_GRAPH_TOOLS.map((tool) => tool.name).join(', ')}`);
    if (input !== null && (typeof input !== 'object' || Array.isArray(input))) return refused(`${WHERE}: the arguments are one object`);
    const args = (input ?? {}) as Record<string, unknown>;
    if (name === 'graph_schema') {
      const schema = graphqlSchemaOf(publishedManifestOf(source.manifest));
      return { answer: { schema }, isError: false };
    }
    if (name === 'graph_query') {
      const query = args['query'];
      if (typeof query !== 'string' || query.trim() === '') return refused(`${WHERE}: "query" is the GraphQL operation text`);
      const names = fieldNames(query);
      if (names === undefined) return refused(`${WHERE}: "query" is not a GraphQL operation`);
      for (const root of PAGE_ROOTS) {
        if (names.has(root)) return refused(`${WHERE}: the agent reads only the graph, and ${root} is the reader's page layer: it reads the product's files and templates, which this server does not answer`);
      }
      const variables = args['variables'];
      if (variables !== undefined && variables !== null && (typeof variables !== 'object' || Array.isArray(variables))) return refused(`${WHERE}: "variables" is an object of the operation's variables`);
      const operationName = args['operationName'];
      if (operationName !== undefined && operationName !== null && typeof operationName !== 'string') return refused(`${WHERE}: "operationName" is the name of the operation to run`);
      const lang = args['lang'];
      if (lang !== undefined && typeof lang !== 'string') return refused(`${WHERE}: "lang" is the reader language`);
      const answer = await executeGraphql(source.owner, { manifest: source.manifest, folder: source.folder }, {
        query,
        ...(variables === undefined || variables === null ? {} : { variables: variables as Record<string, unknown> }),
        ...(operationName === undefined ? {} : { operationName }),
        ...(lang === undefined ? {} : { lang }),
      });
      const body = answer.body as Record<string, unknown>;
      return { answer: body, isError: Array.isArray(body['errors']) && body['errors'].length > 0 };
    }
    const kind = args['kind'];
    const key = args['key'];
    const field = args['field'];
    if (typeof kind !== 'string' || kind.trim() === '') return refused(`${WHERE}: "kind" is the entity's kind`);
    if (key === null || typeof key !== 'object' || Array.isArray(key)) return refused(`${WHERE}: "key" is the entity's key fields and their values`);
    if (typeof field !== 'string' || field.trim() === '') return refused(`${WHERE}: "field" is the text field to read`);
    const lineStart = args['lineStart'];
    const lineEnd = args['lineEnd'];
    if (lineStart !== undefined && !lineNumber(lineStart)) return refused(`${WHERE}: "lineStart" is a whole line number, 1 or more`);
    if (lineEnd !== undefined && !lineNumber(lineEnd)) return refused(`${WHERE}: "lineEnd" is a whole line number, 1 or more`);
    const held = source.contract.vertex.find((vertex) => vertex.name === kind);
    if (held === undefined) return refused(`${WHERE}: the graph holds no kind ${JSON.stringify(kind)}`);
    if (!held.fields.some((declared) => declared.name === field) || held.key.includes(field)) return refused(`${WHERE}: the kind ${JSON.stringify(kind)} declares no text field ${JSON.stringify(field)}`);
    const value = await pluginGraphValue(source.owner, source.contract, kind, key as Record<string, string | number>, field);
    if (Array.isArray(value)) return refused(`${WHERE}: the opinions of ${kind}.${field} disagree, so the graph holds no one text: ${JSON.stringify(value.map((one) => (typeof one === 'string' ? one.slice(0, 80) : one))).slice(0, 400)}`);
    if (typeof value !== 'string') return refused(`${WHERE}: ${kind}.${field} holds ${value === null ? 'no value' : 'a value that is no text'} for the given key`);
    const lines = value.split('\n');
    const start = lineStart ?? 1;
    const end = lineEnd ?? lines.length;
    if (start > lines.length || end > lines.length || end < start) return refused(`${WHERE}: the range ${String(start)}-${String(end)} is outside the ${String(lines.length)} lines ${kind}.${field} holds`);
    return { answer: { kind, key, field, lineStart: start, lineEnd: end, lines: lines.length, text: lines.slice(start - 1, end).join('\n') }, isError: false };
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
}

