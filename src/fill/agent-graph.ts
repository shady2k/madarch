/**
 * The server a fill's agent session is given (owner's decision, 2026-11-15): madarch's own graph reads over the Model
 * Context Protocol, one per tool call, so the agent chooses what it reads instead of being handed a list of files.
 * The reads themselves are the graph store's own (`src/graph/agent-reads.ts`); this module only speaks the protocol.
 */
import { randomUUID } from 'node:crypto';
import { answerUnitMcpMessage } from './unit-mcp.js';
import { runningVersion } from '../product/version.js';
import { AGENT_GRAPH_TOOLS, callAgentGraphTool, type AgentGraphSource } from '../graph/agent-reads.js';
import type { AcpMcpServer } from './acp.js';

/** How long one body of the agent's MCP server may be: a GraphQL operation and a key, never a file. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Starts the server the agent's session is given and answers `close` with it stopped. It speaks the protocol's
 * streamable HTTP transport with one JSON answer per POST, as the hand-written unit server speaks it: the client's
 * `initialize`, its `tools/list` and its `tools/call`, answered by the same code that answers them over stdio.
 */
export function startAgentGraphMcp(source: AgentGraphSource): { readonly server: AcpMcpServer; close(): Promise<void> } {
  const token = randomUUID();
  const running = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(request) {
      if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response('unauthorized', { status: 403 });
      if (request.method !== 'POST') return new Response('this server answers POST with one JSON-RPC message; it streams nothing', { status: 405, headers: { allow: 'POST' } });
      let message: unknown;
      try {
        message = await request.json();
      } catch {
        return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'the body is one JSON-RPC message' } });
      }
      if (Array.isArray(message)) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'this server reads one JSON-RPC message per request, never a batch' } });
      const answered = await answerUnitMcpMessage(message, {
        tools: AGENT_GRAPH_TOOLS,
        info: { name: 'madarch', version: runningVersion() },
        call: async (tool, args) => await callAgentGraphTool(source, tool, args),
      });
      if (answered === null) return new Response(null, { status: 202 });
      return Response.json(answered);
    },
  });
  return {
    server: { name: 'madarch', url: `http://127.0.0.1:${String(running.port)}/mcp`, type: 'http', headers: { authorization: `Bearer ${token}` } },
    async close() { await running.stop(true); },
  };
}
