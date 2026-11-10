/**
 * The writer's unit contract: what an agent is handed for one unit, how a run
 * ended, the pages and languages a rewrite names. The one graph has no writer
 * stage yet; these types and constants are what the loop and the ACP judges
 * still read.
 */
import type { McpToolDefinition } from '../mcp/types.js';

/** The languages a product's pages are written in, with the name the agent is told. */
export const CONTENT_LANGUAGES: Readonly<Record<string, { name: string }>> = {
  en: { name: 'English' },
  ru: { name: 'Russian' },
};

/** The unit bounds the writer enforces. */
export const DEFAULT_UNIT_BOUNDS = { maxWriteAttempts: 5, maxCalls: 80 } as const;
/** The most domains one product page declares. */
export const MAX_DOMAINS = 12;

/** The product page the overview unit writes (0032, section 11). */
export const PRODUCT_PATH = 'docs/product.md';
/** The folder the domain pages stand in. */
export const DOMAINS_FOLDER = 'docs/domains';

export interface ToolAnswer {
  readonly answer: unknown;
  readonly isError: boolean;
}

/** What an agent is handed for one unit. */
export interface UnitRequest {
  readonly id: string;
  readonly prompt: string;
  readonly tools: ToolClient;
}

export interface ToolClient {
  readonly definitions: readonly McpToolDefinition[];
  call(tool: string, argumentsValue: unknown): Promise<ToolAnswer>;
  finished(): boolean;
}

export interface UnitRunStatus {
  readonly completed: boolean;
  readonly stopped?: string;
}

export interface UnitAgent {
  run(request: UnitRequest): Promise<UnitRunStatus | void>;
  warnings?(): readonly string[];
}
