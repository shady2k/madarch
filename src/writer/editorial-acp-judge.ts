
/**
 * The ACP-backed editing judge (madarch-ztyq.9). It reuses the writer's ACP unit agent exactly as
 * the answer-key judge does, and gives the role one tool: `revisions`, whose pages and passage ids
 * are the ones the pack showed. The caller resolves the `editing` pair; this file starts it.
 *
 * The prompt is built from the pack, never from a model name. The pack is bounded by the caller
 * (pages, statements and the per-page setting), so a model cannot enlarge its own task.
 */
import type { DraftEnv } from '../product/home.js';
import type { AgentPreferences } from '../fill/acp-choices.js';
import type { McpToolDefinition } from '../fill/unit-mcp.js';
import { makeUnitAgent } from '../knowledge/agents.js';
import type { ModelPair } from '../knowledge/model-roles.js';
import type { ToolClient, UnitAgent, UnitRunStatus } from './run.js';
import type { Journal } from './journal.js';
import type { EditorialJudge, EditorialJudgeAnswer, EditorialJudgePack } from './editorial.js';

export class EditorialJudgeError extends Error {}

const MAX_IN_PROMPT = 600;

const REVISIONS_TOOL: McpToolDefinition = {
  name: 'revisions',
  description: 'Return bounded revision requests. Each names one page and one passage id shown in this pack. Call exactly once.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['revisions'],
    properties: {
      revisions: {
        type: 'array', maxItems: 12,
        description: 'At most the number this pack allows per page, and only passages this pack showed.',
        items: {
          type: 'object', additionalProperties: false, required: ['page', 'passage', 'change', 'why'],
          properties: {
            page: { type: 'string', description: 'A page path shown in this pack.' },
            passage: { type: 'string', description: 'A passage id shown on that page.' },
            change: { type: 'string', minLength: 1, maxLength: 2000, description: 'What to change in that passage.' },
            why: { type: 'string', minLength: 1, maxLength: 2000, description: 'Why a newcomer needs the change.' },
          },
        },
      },
    },
  },
};

function promptOf(pack: EditorialJudgePack): string {
  const pages = pack.pages.map((page) => [
    `### ${page.path} — ${page.title}`,
    ...page.statements.map((statement) => `[${statement.id}] line ${statement.line}: ${statement.text.length > MAX_IN_PROMPT ? `${statement.text.slice(0, MAX_IN_PROMPT)}…` : statement.text}`),
  ].join('\n'));
  const findings = pack.findings.map((finding) => `- ${finding.kind}: ${finding.message}`);
  return [
    'You are the editor of this product’s written pages. Read them as a newcomer: does each sentence mean what it says, do pages agree with one another, are glossary terms used by the names the glossary gives, and is any internal identifier (a graph key, file path or code name) standing in a reader’s sentence?',
    '',
    `Return at most ${pack.maxPerPage} requests for each page, and only requests that change one of the passages shown below. A request names the page, the passage id in square brackets, the change to make, and why a newcomer needs it. Never ask for a whole page to be rewritten, never invent a page or a passage, and never paste page text into the answer.`,
    '',
    'Findings the deterministic pass already made (they need no repetition, but a request may rely on one):',
    ...(findings.length === 0 ? ['(none)'] : findings),
    '',
    'Pages and passages (name only these ids):',
    ...(pages.length === 0 ? ['(none)'] : pages),
    '',
    'Call the revisions tool exactly once with { revisions: [...] }. Return an empty array when the pages need no revision.',
  ].join('\n');
}

export interface EditorialAcpJudgeOptions {
  readonly env: DraftEnv;
  readonly progress?: (line: string) => void;
  readonly journal?: Journal;
  /** The production factory; tests pass a scripted agent that calls the tool. */
  readonly makeAgent?: typeof makeUnitAgent;
}

/** One editing judge for one resolved pair. It starts on the first pack and keeps the agent for the run. */
export function editorialAcpJudge(pair: ModelPair, options: EditorialAcpJudgeOptions): EditorialJudge {
  const preferences: AgentPreferences = {
    ...(pair.model === undefined ? {} : { model: pair.model }),
    ...(pair.reasoning === undefined ? {} : { reasoning: pair.reasoning }),
  };
  let agent: (UnitAgent & { close(): Promise<void> }) | undefined;
  const warnings: string[] = [];
  const started = (): UnitAgent & { close(): Promise<void> } => {
    if (agent !== undefined) return agent;
    const made = (options.makeAgent ?? makeUnitAgent)(pair.agent, options.env, options.progress, Object.keys(preferences).length === 0 ? undefined : preferences, options.journal);
    if ('error' in made) throw new EditorialJudgeError(`src/writer/editorial-acp-judge.ts: cannot start the editing judge (${pair.agent}): ${made.error}`);
    agent = made;
    return made;
  };
  return {
    async judge(pack: EditorialJudgePack): Promise<EditorialJudgeAnswer> {
      let answer: EditorialJudgeAnswer | undefined;
      let refusal: string | undefined;
      let calls = 0;
      const client: ToolClient = {
        definitions: [REVISIONS_TOOL],
        async call(tool: string, argumentsValue: unknown) {
          if (tool !== 'revisions') return { answer: { error: 'the editing judge has only the revisions tool' }, isError: true };
          calls += 1;
          const held = typeof argumentsValue === 'object' && argumentsValue !== null ? argumentsValue as Record<string, unknown> : {};
          const list = Array.isArray(held.revisions) ? held.revisions : [];
          if (list.length > 12) {
            refusal = 'more than 12 revision requests in one answer';
            return { answer: { accepted: false, error: refusal }, isError: true };
          }
          const shown = new Map(pack.pages.map((page) => [page.path, new Set(page.statements.map((statement) => statement.id))]));
          const perPage = new Map<string, number>();
          const requests: { page: string; passage: string; change: string; why: string }[] = [];
          for (const [index, entry] of list.entries()) {
            const item = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {};
            if (typeof item.page !== 'string' || typeof item.passage !== 'string' || typeof item.change !== 'string' || typeof item.why !== 'string') {
              refusal = `request ${index + 1} is missing one of page, passage, change or why`;
              return { answer: { accepted: false, error: refusal }, isError: true };
            }
            const page = item.page;
            const passage = item.passage;
            const change = item.change.trim();
            const why = item.why.trim();
            if (!shown.has(page)) { refusal = `request ${index + 1} names a page this pack did not show: ${page}`; return { answer: { accepted: false, error: refusal }, isError: true }; }
            if (!shown.get(page)!.has(passage)) { refusal = `request ${index + 1} names a passage this pack did not show on ${page}: ${passage}`; return { answer: { accepted: false, error: refusal }, isError: true }; }
            if (change === '' || why === '') { refusal = `request ${index + 1} has no change or no reason`; return { answer: { accepted: false, error: refusal }, isError: true }; }
            if (change.length > 2000 || why.length > 2000) { refusal = `request ${index + 1} is longer than 2000 characters`; return { answer: { accepted: false, error: refusal }, isError: true }; }
            const count = perPage.get(page) ?? 0;
            if (count >= pack.maxPerPage) { refusal = `request ${index + 1} is beyond the ${pack.maxPerPage} request(s) this pack allows on ${page}`; return { answer: { accepted: false, error: refusal }, isError: true }; }
            perPage.set(page, count + 1);
            requests.push({ page, passage, change, why });
          }
          answer = { requests };
          return { answer: { accepted: true }, isError: false };
        },
        finished() {
          return answer !== undefined || calls >= 4;
        },
      };
      const judgeAgent = started();
      let status: UnitRunStatus | void;
      try {
        status = await judgeAgent.run({ id: 'editorial-pass', prompt: promptOf(pack), tools: client });
      } finally {
        for (const line of judgeAgent.warnings?.() ?? []) if (!warnings.includes(line)) warnings.push(line);
      }
      if (status !== undefined && status.completed !== true) throw new EditorialJudgeError(`src/writer/editorial-acp-judge.ts: the editing judge did not complete: ${status.stopped ?? 'the run was stopped before it answered'}`);
      if (answer === undefined) throw new EditorialJudgeError(`src/writer/editorial-acp-judge.ts: the editing judge gave no answer${refusal === undefined ? '' : `: ${refusal}`}`);
      return answer;
    },
    warnings(): readonly string[] {
      return [...warnings];
    },
    async close() {
      await agent?.close();
      agent = undefined;
    },
  };
}
