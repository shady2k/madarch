/**
 * The seven tools of decision 0032 as a repository's MCP server serves them
 * (madarch-ztyq.10): the tool surface the writer's units already have, without
 * the tools that write.
 *
 * The names, the descriptions and the argument schemas are the writer's own
 * (`WRITER_TOOLS`), so an agent that learned `get_symbol` from a fill's unit
 * finds the same tool with the same words here; the answering functions are the
 * writer's own (`src/writer/answers.ts`), called with a graph view and a page
 * sink. What is added is the envelope: every answer names the revision it was
 * read at, the files the working tree changed, and what the layer re-extracted.
 */
import { AnswerRefusal, CONTEXT_PURPOSES, EVIDENCE_SHOWN, FLOW_DEPTH, FLOW_STEPS, FLOW_TARGETS, PAGES_SHOWN, QUESTIONS_SHOWN, UNRESOLVED_SHOWN, getContext, getDocumentSections, getPage, getSymbol, searchPages, searchQuestions, traceFlow, type AnswerResult, type ContextPurpose, type FlowTarget, type GraphReads, type SourceRead } from '../writer/answers.js';
import { argumentsOf, count, fail, isFailure, ok, text, WRITER_TOOLS, type PageSink } from '../writer/tools.js';
import type { McpToolDefinition } from '../fill/unit-mcp.js';
import type { UnitToolAnswer } from '../fill/unit-tools.js';
import type { Question } from '../loop/entities.js';
import { byCodePoint } from '../model/order.js';
import { pathOfKey } from './layer.js';

/** The tools decision 0032 gives the agent stage, in the decision's own order. */
export const REPO_TOOL_NAMES = ['get_symbol', 'get_context', 'trace_flow', 'get_document_sections', 'search_pages', 'get_page', 'search_questions'] as const;

export type RepoToolName = (typeof REPO_TOOL_NAMES)[number];

/** The served tools: the writer's definitions, filtered to the seven, in their own order. */
export const REPO_TOOLS: readonly McpToolDefinition[] = WRITER_TOOLS.filter((tool) => (REPO_TOOL_NAMES as readonly string[]).includes(tool.name));

/** What the tools read: the graph, the pages, the questions, and the revision every answer names. */
export interface RepoToolDeps {
  readonly reads: GraphReads;
  readonly pages: PageSink;
  readonly questions: () => Promise<readonly Question[]>;
  /** The revision the answer is read at, as `source` shows it. */
  readonly source: Record<string, unknown>;
}

/** One answer and what it cost: the source it showed, and the files a reader no longer has to open. */
export interface RepoToolAnswer extends UnitToolAnswer {
  readonly reads: readonly SourceRead[];
  readonly covered: readonly string[];
}

/** The paths an answer's evidence covers, from the shapes evidence takes: a document section and a graph key. */
export function coveredPaths(evidence: readonly string[]): string[] {
  const covered = new Set<string>();
  for (const target of evidence) {
    if (target.startsWith('doc:')) {
      const rest = target.slice('doc:'.length);
      const hash = rest.indexOf('#');
      covered.add(hash < 0 ? rest : rest.slice(0, hash));
      continue;
    }
    const path = pathOfKey(target);
    if (path !== null) {
      covered.add(path);
      continue;
    }
    // A page's evidence is the page's own path.
    if (target.endsWith('.md') || target.endsWith('.markdown')) covered.add(target);
  }
  return [...covered].sort(byCodePoint);
}

/** One answer of the graph-reading tools, in the envelope the writer's units already read. */
async function answered(work: () => Promise<AnswerResult>, source: Record<string, unknown>): Promise<RepoToolAnswer> {
  let result: AnswerResult;
  try {
    result = await work();
  } catch (error) {
    if (error instanceof AnswerRefusal) return { ...fail(error.code, error.message), reads: [], covered: [] };
    throw error;
  }
  const evidence = [...new Set(result.evidence)].sort(byCodePoint);
  const shown = evidence.slice(0, EVIDENCE_SHOWN);
  return {
    answer: {
      source,
      ...result.body,
      evidence: shown,
      ...(result.unresolved.length === 0 ? {} : { unresolved: result.unresolved.slice(0, UNRESOLVED_SHOWN) }),
      truncated: result.truncated || shown.length < evidence.length,
    },
    isError: false,
    reads: result.reads,
    covered: [...new Set([...result.reads.map((read) => read.path), ...coveredPaths(evidence)])].sort(byCodePoint),
  };
}

/**
 * Calls one tool. A refused argument is the answer's own `error` with `isError`,
 * as every tool of the writer answers it; a name this server does not serve is a
 * refusal too, because the protocol layer has already refused it by schema.
 */
export async function callRepoTool(tool: string, argumentsValue: unknown, deps: RepoToolDeps): Promise<RepoToolAnswer> {
  const args = argumentsOf(argumentsValue);
  try {
    switch (tool) {
      case 'get_symbol': {
        const name = text(args['name'], 'name');
        if (isFailure(name)) return { ...name, reads: [], covered: [] };
        if (args['service'] !== undefined && typeof args['service'] !== 'string') return { ...fail('bad-argument', '"service" is a text'), reads: [], covered: [] };
        return await answered(() => getSymbol(deps.reads, { name, ...(args['service'] === undefined ? {} : { service: args['service'] as string }) }), deps.source);
      }
      case 'get_context': {
        const entity = text(args['entity'], 'entity');
        if (isFailure(entity)) return { ...entity, reads: [], covered: [] };
        const purpose = args['purpose'];
        if (typeof purpose !== 'string' || !(CONTEXT_PURPOSES as readonly string[]).includes(purpose)) return { ...fail('bad-argument', `"purpose" is one of ${CONTEXT_PURPOSES.join(', ')}`), reads: [], covered: [] };
        return await answered(() => getContext(deps.reads, { entity, purpose: purpose as ContextPurpose }), deps.source);
      }
      case 'trace_flow': {
        const entry = text(args['entry'], 'entry');
        if (isFailure(entry)) return { ...entry, reads: [], covered: [] };
        const rawTargets = args['targets'];
        if (rawTargets !== undefined && (!Array.isArray(rawTargets) || rawTargets.some((one) => !(FLOW_TARGETS as readonly unknown[]).includes(one)))) return { ...fail('bad-argument', `"targets" is a list of ${FLOW_TARGETS.join(', ')}`), reads: [], covered: [] };
        const depth = count(args['depth'], 'depth', 1, 8, FLOW_DEPTH);
        if (isFailure(depth)) return { ...depth, reads: [], covered: [] };
        const maxSteps = count(args['maxSteps'], 'maxSteps', 1, 200, FLOW_STEPS);
        if (isFailure(maxSteps)) return { ...maxSteps, reads: [], covered: [] };
        const targets = (rawTargets === undefined ? [...FLOW_TARGETS] : [...new Set(rawTargets as FlowTarget[])].sort(byCodePoint));
        return await answered(() => traceFlow(deps.reads, { entry, targets, depth, maxSteps }), deps.source);
      }
      case 'get_document_sections': {
        const intent = text(args['intent'], 'intent');
        if (isFailure(intent)) return { ...intent, reads: [], covered: [] };
        if (args['scope'] !== undefined && typeof args['scope'] !== 'string') return { ...fail('bad-argument', '"scope" is a text'), reads: [], covered: [] };
        return await answered(() => getDocumentSections(deps.reads, { intent, ...(args['scope'] === undefined ? {} : { scope: args['scope'] as string }) }), deps.source);
      }
      case 'search_pages': {
        const wanted = text(args['text'], 'text');
        if (isFailure(wanted)) return { ...wanted, reads: [], covered: [] };
        if (args['kind'] !== undefined && typeof args['kind'] !== 'string') return { ...fail('bad-argument', '"kind" is a text, such as "product" or "domain"'), reads: [], covered: [] };
        const limit = count(args['limit'], 'limit', 1, 20, PAGES_SHOWN);
        if (isFailure(limit)) return { ...limit, reads: [], covered: [] };
        return await answered(() => searchPages(deps.pages, { text: wanted, ...(args['kind'] === undefined ? {} : { kind: args['kind'] as string }), limit }), deps.source);
      }
      case 'get_page': {
        const page = text(args['page'], 'page');
        if (isFailure(page)) return { ...page, reads: [], covered: [] };
        const format = args['format'] ?? 'md';
        if (format !== 'md' && format !== 'json') return { ...fail('bad-argument', '"format" is "md" or "json"'), reads: [], covered: [] };
        return await answered(() => getPage(deps.pages, { page, format }), deps.source);
      }
      case 'search_questions': {
        if (args['text'] !== undefined && typeof args['text'] !== 'string') return { ...fail('bad-argument', '"text" is a text'), reads: [], covered: [] };
        if (args['includeAnswered'] !== undefined && typeof args['includeAnswered'] !== 'boolean') return { ...fail('bad-argument', '"includeAnswered" is true or false'), reads: [], covered: [] };
        const limit = count(args['limit'], 'limit', 1, 60, QUESTIONS_SHOWN);
        if (isFailure(limit)) return { ...limit, reads: [], covered: [] };
        return await answered(() => searchQuestions(async () => [...await deps.questions()], { ...(args['text'] === undefined ? {} : { text: args['text'] as string }), includeAnswered: args['includeAnswered'] === true, limit }), deps.source);
      }
      default:
        return { ...fail('unknown-tool', `${JSON.stringify(tool)} is no tool of this server: the tools are ${REPO_TOOL_NAMES.join(', ')} (src/mcp/tools.ts)`), reads: [], covered: [] };
    }
  } catch (error) {
    return { ...fail('tool-failed', `${tool} failed: ${error instanceof Error ? error.message : String(error)} (src/mcp/tools.ts)`), reads: [], covered: [] };
  }
}
