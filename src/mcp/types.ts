/**
 * The shapes the MCP server and the fill's tool route share: one tool's
 * declaration, one tool's answer, one call, and the path a unit's calls are
 * forwarded to. They live apart from the unit tool catalogue so the product's
 * own MCP server does not depend on the fill's agent machinery.
 */
export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface UnitToolAnswer {
  readonly answer: unknown;
  readonly isError: boolean;
}

export interface UnitToolCall {
  /** The token this host minted when it opened the session. */
  readonly token: string;
  /** The tool's name, as `tools/list` gave it. */
  readonly tool: string;
  /** The call's arguments, as the agent wrote them. */
  readonly arguments?: unknown;
}

/** The address a unit's server forwards a tool call to. */
export const UNIT_TOOL_PATH = '/api/fill/unit/tool';
