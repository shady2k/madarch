/**
 * The ACP-backed judge (madarch-j6ho.2). It reuses the writer's ACP unit agent
 * (`src/writer/acp-agent.ts`) rather than connecting an agent itself: one
 * process serves the packs of one role, each pack in a session of its own whose
 * only tool is `judge`.
 *
 * The tool accepts only an answer whose passages are ids the prompt showed. The
 * prompt is built from the pack, never from a model name; the caller assigns
 * the pair and this file starts it.
 */
import type { AnswerKeyPack } from './answer-key-check.js';
import { JudgeExecutionError, validateJudgeAnswer, type Judge, type JudgeAnswer } from './answer-key-judge.js';
import type { ModelPair, ModelRole } from './model-roles.js';
import type { DraftEnv } from '../product/home.js';
import { makeUnitAgent } from './agents.js';
import type { McpToolDefinition } from '../fill/unit-mcp.js';
import type { ToolClient } from '../writer/run.js';
import type { UnitAgent, UnitRunStatus } from '../writer/run.js';
import type { Journal } from '../writer/journal.js';
import type { AgentPreferences } from '../fill/acp-choices.js';

const JUDGE_TOOL: McpToolDefinition = {
  name: 'judge',
  description: 'Answer with one verdict, a one-line reason, and the ids of the passages in this pack that support it. Call exactly once.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'reason', 'passages'],
    properties: {
      verdict: { type: 'string', enum: ['fully', 'partly', 'none', 'unsure'], description: 'fully, partly, none or unsure' },
      reason: { type: 'string', minLength: 1, description: 'One line saying why.' },
      passages: { type: 'array', items: { type: 'string' }, description: 'Ids of passages in this pack only; never text of your own.' },
    },
  },
};

export interface AcpJudgeOptions {
  readonly env: DraftEnv;
  readonly progress?: (line: string) => void;
  readonly journal?: Journal;
  /** The production factory; tests pass a scripted agent that calls the judge tool. */
  readonly makeAgent?: typeof makeUnitAgent;
}

function promptOf(pack: AnswerKeyPack, role: ModelRole): string {
  const item = pack.item;
  const passages = pack.passages.map((passage) => `[${passage.id}] ${passage.page} / ${passage.block}${passage.line === undefined ? '' : ` line ${passage.line}`}: ${passage.text}`);
  // What the product was expected to ask, and the question pages it actually has: a judge cannot tell whether the
  // expected questions were asked from an item's own evidence alone (madarch-j6ho.2, finding 5).
  const expected = pack.expectedQuestions ?? [];
  const current = pack.currentQuestions ?? [];
  const locations = pack.locations.map((location) => {
    const pages = location.pages.map((page) => `${page.id} (${page.kind}, ${page.title})`);
    return `- location ${location.location.path}${location.location.symbol === undefined ? '' : `#${location.location.symbol}`}${location.location.anchor === undefined ? '' : `#${location.location.anchor}`}: present ${location.present ? 'yes' : 'no'}, found ${location.found ? 'yes' : 'no'}, pages ${pages.length === 0 ? '(none)' : pages.join(', ')}`;
  });
  const line = role === 'analysis'
    ? 'You are the second reader. The classification judge stayed unsure. Judge only from the evidence below; answer unsure if it still does not decide.'
    : 'You are the classification judge. Judge only from the evidence below.';
  return [
    line,
    'Verdicts:',
    '- fully: every part of the reader task is answered by the evidence shown, including every mustShow phrase and every mustLink target.',
    '- partly: some part is answered and some is missing.',
    '- none: the evidence does not answer any part.',
    '- unsure: the evidence is not enough to decide; a person should read it.',
    '',
    `Item: ${item.id}`,
    `Reader task: ${item.judge.readerTask}`,
    `Wiki statement expected: ${item.expectedWikiStatement}`,
    `Must show: ${item.judge.mustShow.length === 0 ? '(none)' : item.judge.mustShow.join(' | ')}`,
    `Must link: ${item.judge.mustLink.length === 0 ? '(none)' : item.judge.mustLink.join(' | ')}`,
    `Must not claim: ${item.judge.mustNotClaim.length === 0 ? '(none)' : item.judge.mustNotClaim.join(' | ')}`,
    `Evidence class: ${item.evidenceClass}`,
    '',
    'Pages at the locations:',
    ...(locations.length === 0 ? ['(none)'] : locations),
    '',
    `Expected open questions (${expected.length}):`,
    ...(expected.length === 0 ? ['(none)'] : expected.map((question, index) => `  ${index + 1}. [${question.type}] ${question.subject} (${question.file})`)),
    `Question pages in the product: ${current.length}`,
    ...current.map((page) => `  ${page.id} "${page.title}" [${page.type}] ${page.state}${page.about.length === 0 ? '' : ` about ${page.about.join(', ')}`}`),
    ...(expected.length === 0 ? [] : ['Every expected question must correspond to one of these pages. When one has no page, or a page asks something else, say so in the reason.']),
    '',
    'Passages (quote only these ids):',
    ...(passages.length === 0 ? ['(none)'] : passages),
    '',
    'Call the judge tool exactly once with verdict, reason and passages. The reason is one line. Never paste page text into the answer.',
  ].join('\n');
}

/**
 * One judge for one resolved pair. It starts the agent on the first pack and
 * keeps it for the rest of this role's packs; `close` stops it.
 */
export function acpJudge(pair: ModelPair, role: ModelRole, options: AcpJudgeOptions): Judge {
  const preferences: AgentPreferences = {
    ...(pair.model === undefined ? {} : { model: pair.model }),
    ...(pair.reasoning === undefined ? {} : { reasoning: pair.reasoning }),
  };
  let agent: (UnitAgent & { close(): Promise<void> }) | undefined;
  const warnings: string[] = [];
  const started = (): UnitAgent & { close(): Promise<void> } => {
    if (agent !== undefined) return agent;
    const made = (options.makeAgent ?? makeUnitAgent)(pair.agent, options.env, options.progress, Object.keys(preferences).length === 0 ? undefined : preferences, options.journal);
    // An adapter that does not start is not an answer about the pack: the pack is unjudged.
    if ('error' in made) throw new JudgeExecutionError(`src/knowledge/answer-key-acp-judge.ts: cannot start the ${role} judge (${pair.agent}): ${made.error}`);
    agent = made;
    return made;
  };
  return {
    async judge(pack: AnswerKeyPack): Promise<JudgeAnswer> {
      let answer: JudgeAnswer | undefined;
      let refusal: string | undefined;
      let calls = 0;
      const client: ToolClient = {
        definitions: [JUDGE_TOOL],
        async call(tool: string, argumentsValue: unknown) {
          if (tool !== 'judge') return { answer: { error: `the ${role} judge has only the judge tool` }, isError: true };
          calls += 1;
          const held = typeof argumentsValue === 'object' && argumentsValue !== null ? argumentsValue as Record<string, unknown> : {};
          const candidate: JudgeAnswer = {
            verdict: held.verdict as JudgeAnswer['verdict'],
            reason: typeof held.reason === 'string' ? held.reason : '',
            passages: Array.isArray(held.passages) ? held.passages.filter((id): id is string => typeof id === 'string') : [],
          };
          try {
            answer = validateJudgeAnswer(pack, candidate);
            return { answer: { accepted: true }, isError: false };
          } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
            return { answer: { accepted: false, error: refusal }, isError: true };
          }
        },
        finished() {
          return answer !== undefined || calls >= 4;
        },
      };
      const judgeAgent = started();
      let status: UnitRunStatus | void;
      try {
        status = await judgeAgent.run({ id: `answer-key-${role}-${pack.item.id}`, prompt: promptOf(pack, role), tools: client });
      } finally {
        // A warning is the agent's, whether the run completed or not; it is never dropped.
        for (const line of judgeAgent.warnings?.() ?? []) if (!warnings.includes(line)) warnings.push(line);
      }
      // A run the limits stopped, or a reader cancelled, is not a reading of the pack: what a tool accepted before
      // the stop must not become a verdict (madarch-j6ho.2, the review's second rare finding).
      if (status !== undefined && status.completed !== true) {
        throw new JudgeExecutionError(`src/knowledge/answer-key-acp-judge.ts: the ${role} judge for item ${pack.item.id} did not complete: ${status.stopped ?? 'the run was stopped before it answered'}`);
      }
      if (answer === undefined) throw new JudgeExecutionError(`src/knowledge/answer-key-acp-judge.ts: the ${role} judge for item ${pack.item.id} gave no valid answer${refusal === undefined ? '' : `: ${refusal}`}`);
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
