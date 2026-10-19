/**
 * The per-unit MCP server's host half (decision 0026, "Agents and tools" and
 * "Writing"; madarch-tzte.22.2): the ten tools one agent unit reads and writes
 * the product graph through, bound to that unit's run, snapshot, scope and
 * limits, and the registry that binds each started server to its session.
 *
 * Decision 0026: "for each unit it starts an MCP server bound to the snapshot,
 * the unit's scope and its limits and passes it into the ACP session. The
 * agent's own file tools are off: it reads code only through the server's
 * evidence spans, and every call is logged as the unit's dependency." And: "The
 * background server owns the database and is its only writer; the units' MCP
 * servers are thin proxies to it."
 *
 * How that is built here, and why:
 *
 * - **The tools are the landed ones, not a second copy.** The six bounded reads
 *   are `src/fill/graph-reads.ts` (madarch-tzte.20.3) and the four checked
 *   writes are `src/fill/checked-writes.ts` (madarch-tzte.20.4): this module
 *   names them, reads one call's arguments and hands them the session they were
 *   built for. Every read is recorded as the unit's dependency by the reader the
 *   session reads through (`GraphReadContext`), and every accepted write lands in
 *   the unit's own draft set (`CheckedWriteDraft`), so "every call is logged"
 *   holds by construction rather than by this module remembering it.
 * - **The server is a process of its own and this is its host.** The agent starts
 *   `madarch mcp-unit` (`unitServerCommand`) through the ACP session's
 *   `mcpServers` (`src/fill/acp.ts`), and that process speaks the Model Context
 *   Protocol over its standard input and output (`src/fill/unit-mcp.ts`) and
 *   forwards each tool call here over HTTP, with a token this module minted. So
 *   the unit's process holds no database, no snapshot and no scope of its own: it
 *   cannot answer anything this host does not answer for it, and a unit that
 *   loses its session loses its tools.
 * - **Bound to the unit.** A token names one session, and the host holds what that
 *   session is: the unit's identity (0027's unit generation), the run its drafts are
 *   read from, the reader its calls are recorded in, the write session that holds
 *   its scope, its pinned snapshot and its draft set, and the caps its answers are
 *   cut by. The child carries the token and nothing else, so a compromised or
 *   confused child can neither widen its scope nor answer another unit's question.
 * - **A refusal is a value.** The reads raise where a request is not a read of
 *   theirs and the writes answer their own refusals; both are handed back as the
 *   tool's answer with `isError`, never as a failure of the transport, so the
 *   agent reads why and writes again. An answer over the unit's cap carries the
 *   marker that says what was cut (`src/fill/graph-reads.ts`), and never a
 *   smaller answer that says nothing.
 */
import type { AcpMcpServer } from './acp.js';
import {
  assertFact,
  link,
  proposeEntity,
  raiseQuestion,
  type CheckedWriteSession,
  type CitedPlaceRequest,
  type WriteAnswer,
} from './checked-writes.js';
import {
  claimsAbout,
  coverage,
  describeScope,
  evidenceSpan,
  neighbors,
  references,
  type ClaimDirection,
  type EdgeDirection,
  type GraphReadContext,
} from './graph-reads.js';
import type { EntityProposalForm, FactEdgeKind } from './facts.js';
import { here } from './fsm-core.js';
import { selfCommand, type SelfCommandReadings } from '../product/self-command.js';

// ---------------------------------------------------------------------------------------------
// The tools, as an agent is told about them
// ---------------------------------------------------------------------------------------------

/** The six reads and the four writes one unit's server offers (0026: "Agents and tools", "Writing"). */
export const UNIT_TOOL_NAMES = [
  'describe_scope',
  'neighbors',
  'references',
  'claims_about',
  'coverage',
  'evidence_span',
  'assert_fact',
  'propose_entity',
  'link',
  'raise_question',
] as const;

export type UnitToolName = (typeof UNIT_TOOL_NAMES)[number];

/** One tool as `tools/list` answers it: its name, what it is for, and its arguments' JSON schema. */
export interface UnitToolDefinition {
  readonly name: UnitToolName;
  readonly description: string;
  /** A JSON schema of the call's arguments object, which is what the Model Context Protocol asks for. */
  readonly inputSchema: Record<string, unknown>;
}

/** A cited place: the bytes a write stands on, which madarch reads itself at the pinned commit. */
const PLACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['repository', 'file', 'startLine'],
  properties: {
    repository: { type: 'string', description: 'The product\'s own name for the repository, like "orders-api", never a path or a URL.' },
    file: { type: 'string', description: 'The file, as a repository path from the repository\'s root, like "src/order.ts".' },
    startLine: { type: 'integer', minimum: 1, description: 'The first line the write cites, counted from 1.' },
    endLine: { type: 'integer', minimum: 1, description: 'The last line the write cites; the first line when it is left out.' },
    startColumn: { type: 'integer', minimum: 0, description: 'The first character\'s offset in the first line, counted from 0.' },
    endColumn: { type: 'integer', minimum: 0, description: 'The offset just past the last character, counted from 0.' },
  },
} as const;

/** The one tool catalogue: what an agent is told each tool does, and what arguments it takes. */
export const UNIT_TOOLS: readonly UnitToolDefinition[] = [
  {
    name: 'describe_scope',
    description: 'What one scope (a repository, directory, file, package or module of the graph) is: the node, the kinds of node it holds by count, the edges touching it by kind and direction, its coverage, and the drafts other units of this run hold about it, marked as drafts. A repository, a folder and a file read their drafts by place (the writes that cite a place inside them); a module and a package read the writes that name the node, and the answer\'s draftScope says which.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scope'],
      properties: { scope: { type: 'string', description: 'The fact id of the scope node, like "file:<64 hex digits>".' } },
    },
  },
  {
    name: 'neighbors',
    description: 'The nodes one node stands next to over edges of the kinds asked for, with the edge that joins each, and the drafts other units of this run hold about that node, marked as drafts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The fact id of the node whose neighbourhood is asked for.' },
        direction: { type: 'string', enum: ['in', 'out', 'both'], description: 'Which way the neighbours stand; both when it is left out.' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'The edge kinds to answer; every relation kind (every kind but contains and defines) when it is left out.' },
      },
    },
  },
  {
    name: 'references',
    description: 'Who names or uses one node, and where: every edge of a citing kind that points at it, with the citing node and the edge\'s own place, and the drafts other units of this run hold that name it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The fact id of the node that is referenced.' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'The edge kinds to answer; the kinds that name or use a node when it is left out.' },
      },
    },
  },
  {
    name: 'claims_about',
    description: 'What the graph says about one node: the claims whose subject is the node, and, asked for, the claims whose object names it, each with the layer and status it stands at, and the drafts other units of this run hold about it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The fact id of the node the claims are about.' },
        direction: { type: 'string', enum: ['about', 'names', 'both'], description: 'about for the claims whose subject is the node, names for those whose object is; both when it is left out.' },
      },
    },
  },
  {
    name: 'coverage',
    description: 'What is known about one scope and what could not be read: the coverage facts that name the scope, each with the count of what it read, a bounded sample and every gap it names. It shows no drafts: a coverage is a stage\'s published declaration of what it read whole, and a draft one is published with its unit.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scope'],
      properties: { scope: { type: 'string', description: 'The scope as the coverage facts name it: a scope token, a node fact id or a path.' } },
    },
  },
  {
    name: 'evidence_span',
    description: 'The bytes of one file at the pinned commit, as the lines a reader counts, at most about 200 lines: this is the only way this unit reads code. It shows no drafts: the bytes are the commit\'s own, and no draft can change them.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['repository', 'commit', 'file'],
      properties: {
        repository: { type: 'string', description: 'The repository the bytes are read from, as the product names it.' },
        commit: { type: 'string', description: 'The commit the bytes are read at: the run\'s own pin, 40 lower-case hexadecimal digits.' },
        file: { type: 'string', description: 'The file, as a repository path.' },
        startLine: { type: 'integer', minimum: 1, description: 'The first line to show; the file\'s first line when it is left out.' },
        endLine: { type: 'integer', minimum: 1, description: 'The last line to show; the file\'s last line when it is left out.' },
      },
    },
  },
  {
    name: 'assert_fact',
    description: 'Assert one fact of the schema, cited to bytes this unit cites. It is checked at once (schema, the cited bytes at the pinned commit, the referenced nodes, the unit\'s scope) and lands in the unit\'s draft set, visible to other units as draft.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'value', 'place'],
      properties: {
        kind: { type: 'string', description: 'The kind of fact: one of the schema\'s kinds, like "claim", "symbol" or "question".' },
        value: { type: 'object', description: 'The kind\'s own value; the schema judges it field by field. Never an id, a commit, a layer or a status.' },
        place: PLACE_SCHEMA,
      },
    },
  },
  {
    name: 'propose_entity',
    description: 'Propose a concept of the domain or an entity a document could be about, cited to bytes this unit cites; the answer names the entities the graph already holds that are like it, so a concept that exists is not proposed twice.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['proposed', 'name', 'place'],
      properties: {
        proposed: { type: 'string', enum: ['concept', 'entity'], description: 'Whether the proposal is a concept of the domain or an entity.' },
        name: { type: 'string', description: 'The name proposed.' },
        summary: { type: 'string', description: 'One sentence on what it is.' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Other names found for it.' },
        place: PLACE_SCHEMA,
      },
    },
  },
  {
    name: 'link',
    description: 'Draw one edge of the schema between two nodes the graph holds, cited to bytes this unit cites. Both ends must be nodes: a published fact, or a write this unit\'s own draft set already took.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'value', 'place'],
      properties: {
        kind: { type: 'string', description: 'The kind of edge: one of the schema\'s edge kinds, like "call", "import" or "dependency".' },
        value: { type: 'object', description: 'The edge\'s own value: its ends are fact ids the graph holds, at the fields the kind names for them.' },
        place: PLACE_SCHEMA,
      },
    },
  },
  {
    name: 'raise_question',
    description: 'Raise a question for a person, cited to the bytes that raised it: an assumption to check, a contradiction, or something the unit could not verify.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'prompt', 'place'],
      properties: {
        type: { type: 'string', description: 'The kind of question, one lower-case kebab token: assumption-check, contradiction or unverifiable.' },
        prompt: { type: 'string', description: 'The question, as a person reads it, in one sentence.' },
        about: { type: 'string', description: 'What the question is about: a node the graph holds, when it names one.' },
        place: PLACE_SCHEMA,
      },
    },
  },
];

/** One tool of the catalogue by name, or `undefined` where the name is no tool. */
export function unitTool(name: string): UnitToolDefinition | undefined {
  return UNIT_TOOLS.find((tool) => tool.name === name);
}

// ---------------------------------------------------------------------------------------------
// One call, answered
// ---------------------------------------------------------------------------------------------

/**
 * What one unit reads and writes through: the landed sessions of madarch-tzte.20.3
 * and 20.4, bound to one unit generation. Nothing here is a database of its own:
 * the reads go through the reader the orchestrator tracks, and the writes land in
 * the draft set the unit's attempt hands over.
 */
export interface UnitToolSession {
  /** The unit this session answers for: the identity its reads and its draft set belong to (0027). */
  readonly unit: { readonly unitId: string; readonly generation: number };
  /** What the unit reads the graph through, with the run whose drafts it sees beside the published facts. */
  readonly reads: GraphReadContext;
  /** What the unit writes the graph through: its scope, the pinned bytes, its draft set and the facts a write stands on. */
  readonly writes: CheckedWriteSession;
}

/**
 * What one tool call answered: the tool's own answer, as the JSON an agent reads,
 * and whether that answer is the tool failing to do what it was asked. A read's
 * answer is never a failure; a write the checks refused is, and so is a call this
 * host could not answer at all — its answer then carries an `error` naming the
 * code and what went wrong, with the file and line in the message.
 */
export interface UnitToolAnswer {
  readonly answer: unknown;
  readonly isError: boolean;
}

/** The arguments of one call, as the transport handed them over; a value that is no object is read as none. */
function argumentsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A list of alternative names as the schema reads one, or the value as it stands for the schema to refuse. */
function asTexts(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : value as readonly string[];
}

/**
 * Answers one call of one tool of one unit's session. A refusal, wherever it
 * comes from — a read's own raise, a write's checks, an argument of no shape a
 * tool takes — is answered as the tool failing, never raised: an agent that wrote
 * a field wrong learns which field and why and writes again, and a session that
 * died of it would take the unit's turn with it.
 */
export async function callUnitTool(session: UnitToolSession, tool: string, argumentsValue: unknown): Promise<UnitToolAnswer> {
  const known = unitTool(tool);
  if (known === undefined) {
    return {
      answer: { error: { code: 'unknown-tool', message: `"${tool}" is no tool of a unit's server: the tools are ${UNIT_TOOL_NAMES.join(', ')} (src/fill/unit-tools.ts)` } },
      isError: true,
    };
  }
  const asked = argumentsOf(argumentsValue);
  try {
    switch (known.name) {
      case 'describe_scope':
        return { answer: await describeScope(session.reads, { tool: 'describe_scope', scope: asked['scope'] as string }), isError: false };
      case 'neighbors':
        return {
          answer: await neighbors(session.reads, {
            tool: 'neighbors',
            id: asked['id'] as string,
            ...(asked['direction'] === undefined ? {} : { direction: asked['direction'] as EdgeDirection }),
            ...(asked['kinds'] === undefined ? {} : { kinds: asked['kinds'] as readonly FactEdgeKind[] }),
          }),
          isError: false,
        };
      case 'references':
        return {
          answer: await references(session.reads, {
            tool: 'references',
            id: asked['id'] as string,
            ...(asked['kinds'] === undefined ? {} : { kinds: asked['kinds'] as readonly FactEdgeKind[] }),
          }),
          isError: false,
        };
      case 'claims_about':
        return {
          answer: await claimsAbout(session.reads, {
            tool: 'claims_about',
            id: asked['id'] as string,
            ...(asked['direction'] === undefined ? {} : { direction: asked['direction'] as ClaimDirection }),
          }),
          isError: false,
        };
      case 'coverage':
        return { answer: await coverage(session.reads, { tool: 'coverage', scope: asked['scope'] as string }), isError: false };
      case 'evidence_span':
        return {
          answer: await evidenceSpan(session.reads, {
            tool: 'evidence_span',
            repository: asked['repository'] as string,
            commit: asked['commit'] as string,
            file: asked['file'] as string,
            ...(asked['startLine'] === undefined ? {} : { startLine: asked['startLine'] as number }),
            ...(asked['endLine'] === undefined ? {} : { endLine: asked['endLine'] as number }),
          }),
          isError: false,
        };
      case 'assert_fact':
        return written(await assertFact(session.writes, {
          kind: asked['kind'] as string,
          value: asked['value'],
          place: asked['place'] as unknown as CitedPlaceRequest,
        }));
      case 'propose_entity':
        return written(await proposeEntity(session.writes, {
          proposed: asked['proposed'] as EntityProposalForm,
          name: asked['name'] as string,
          ...(asked['summary'] === undefined ? {} : { summary: asked['summary'] as string }),
          ...(asked['aliases'] === undefined ? {} : { aliases: asTexts(asked['aliases']) }),
          place: asked['place'] as unknown as CitedPlaceRequest,
        }));
      case 'link':
        return written(await link(session.writes, {
          kind: asked['kind'] as string,
          value: asked['value'],
          place: asked['place'] as unknown as CitedPlaceRequest,
        }));
      case 'raise_question':
        return written(await raiseQuestion(session.writes, {
          type: asked['type'] as string,
          prompt: asked['prompt'] as string,
          ...(asked['about'] === undefined ? {} : { about: asked['about'] as string }),
          place: asked['place'] as unknown as CitedPlaceRequest,
        }));
      default:
        // Every name of the catalogue is answered above; this line is the type's own last case.
        return { answer: { error: { code: 'unknown-tool', message: `"${tool}" is no tool of a unit's server: the tools are ${UNIT_TOOL_NAMES.join(', ')} (src/fill/unit-tools.ts)` } }, isError: true };
    }
  } catch (error) {
    // The message a read raises already names the file, the line and the column it was raised at
    // (`src/fill/fsm-core.ts`), and a write's failure names the table it touched: it is handed on as it
    // stands, because the agent has to read exactly where and what went wrong.
    return {
      answer: { error: { code: 'refused', message: error instanceof Error ? error.message : String(error) } },
      isError: true,
    };
  }
}

/** One write's answer as the call's answer: a write that landed is the tool's answer, and one the checks refused is a failure the agent reads. */
function written(answer: WriteAnswer | (WriteAnswer & { readonly similar: unknown })): UnitToolAnswer {
  return { answer, isError: answer.ok === false };
}

// ---------------------------------------------------------------------------------------------
// The registry: one started server, one session
// ---------------------------------------------------------------------------------------------

/**
 * The path this process answers a unit's tool calls at (`POST`, `src/server/http.ts`):
 * the fill's own, so it stands at the server's root rather than under a served
 * product's prefix — a unit's tools answer for the process's database, not for
 * one product.
 */
export const UNIT_TOOL_PATH = '/api/fill/unit/tool';

/** What a started server is told about its host: where a call goes, and the token that names its session. */
export const UNIT_TOOL_URL_VARIABLE = 'MADARCH_UNIT_TOOL_URL';
export const UNIT_TOOL_TOKEN_VARIABLE = 'MADARCH_UNIT_TOOL_TOKEN';

/** One call a unit's server forwards to this host. */
export interface UnitToolCall {
  /** The token this host minted when it opened the session. */
  readonly token: string;
  /** The tool's name, as `tools/list` gave it. */
  readonly tool: string;
  /** The call's arguments, as the agent wrote them. */
  readonly arguments?: unknown;
}

/** What opening one unit's tools is given. */
export interface OpenUnitTools {
  /** The unit's sessions, bound to it: the unit a call is made for. */
  readonly session: UnitToolSession;
  /** The address this host answers a call at, as the started server is told it. */
  readonly url: string;
  /** How this build's own program is started (`selfCommand`); the readings a test passes stand here too. */
  readonly self?: SelfCommandReadings;
}

/** One unit's tools, as the session that runs the unit hands them to the agent. */
export interface UnitToolsHandle {
  /**
   * The MCP server to attach to the unit's ACP session:
   * `connection.newSession({ cwd, mcpServers: [handle.mcpServer] })` (`src/fill/acp.ts`).
   */
  readonly mcpServer: AcpMcpServer;
  /** Forgets this session's token: no further call of its server is answered, and its tools answer nothing. */
  close(): void;
}

/** The host of the units' servers: it mints a session's token, and answers the calls that carry one. */
export interface UnitToolsHost {
  /** Opens one unit's tools: the server an agent starts, bound to this session and to nothing else. */
  open(request: OpenUnitTools): UnitToolsHandle;
  /**
   * Answers one call a server forwarded: the tool's answer, or `null` for a token
   * this host minted for no open session (a server whose unit ended, say), which
   * a transport reports as a refusal rather than as a tool's answer.
   */
  call(request: UnitToolCall): Promise<UnitToolAnswer | null>;
  /** Forgets every session; a call after it is refused by its token. */
  closeAll(): void;
}

/** The tokens' own randomness: `crypto.randomUUID` where the runtime has it, bytes from the platform otherwise. */
function mintToken(): string {
  return crypto.randomUUID();
}

/**
 * The registry of unit sessions. A session is bound to the unit whose tools it
 * serves, and it is forgotten when the unit's attempt ends (`close`) or when the
 * host goes (`closeAll`): a token is a capability, so it lives exactly as long as
 * the unit it was minted for.
 */
export function createUnitToolsHost(): UnitToolsHost {
  const sessions = new Map<string, UnitToolSession>();
  return {
    open(request: OpenUnitTools): UnitToolsHandle {
      const at = here();
      if (typeof request.url !== 'string' || request.url.trim() === '') {
        throw new Error(`${at}: the unit's tools cannot be opened without the address this host answers at: the server is started with MADARCH_UNIT_TOOL_URL`);
      }
      const token = mintToken();
      sessions.set(token, request.session);
      const server = selfCommand(['mcp-unit'], request.self ?? {});
      return {
        mcpServer: {
          name: 'madarch-unit',
          command: server.command,
          args: server.args,
          env: { [UNIT_TOOL_URL_VARIABLE]: request.url, [UNIT_TOOL_TOKEN_VARIABLE]: token },
        },
        close: () => { sessions.delete(token); },
      };
    },
    async call(request: UnitToolCall): Promise<UnitToolAnswer | null> {
      const session = typeof request.token === 'string' ? sessions.get(request.token) : undefined;
      if (session === undefined) return null;
      return await callUnitTool(session, String(request.tool), request.arguments);
    },
    closeAll: () => { sessions.clear(); },
  };
}
