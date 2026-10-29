/**
 * The ACP-backed graph judge (madarch-mwhd.1). One process serves one role,
 * reused for that role's batches; its only tool is `verdicts`. The prompt is
 * built from the batch alone: ids, kinds, labels, properties and evidence
 * places, never a model name and never page text.
 */
import { makeUnitAgent } from './agents.js';
import type { ModelPair } from './model-roles.js';
import type { DraftEnv } from '../product/home.js';
import type { McpToolDefinition } from '../fill/unit-mcp.js';
import type { ToolClient, UnitAgent, UnitRunStatus } from '../writer/run.js';
import type { Journal } from '../writer/journal.js';
import type { AgentPreferences } from '../fill/acp-choices.js';
import { JudgeExecutionError } from './answer-key-judge.js';
import {
  JUDGE_BATCH_SIZE,
  type GraphJudge,
  type GraphJudgeAnswer,
  type GraphJudgeItem,
} from './graph-verdicts.js';

const VERDICT_TOOL: McpToolDefinition = {
  name: 'verdicts',
  description: 'Give one verdict and a one-line reason for each item below. Use only ids shown. Call exactly once with as many answers as you can decide.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['answers'],
    properties: {
      answers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'verdict', 'reason'],
          properties: {
            id: { type: 'string', description: 'An id shown in this batch.' },
            verdict: { type: 'string', enum: ['valid', 'invalid', 'unsure'] },
            reason: { type: 'string', minLength: 1, description: 'One line saying why.' },
          },
        },
      },
    },
  },
};

export interface AcpGraphJudgeOptions {
  readonly env: DraftEnv;
  readonly progress?: (line: string) => void;
  readonly journal?: Journal;
  readonly makeAgent?: typeof makeUnitAgent;
}

const promptOf = (items: readonly GraphJudgeItem[], role: 'classification' | 'analysis'): string => {
  const lines = [
    role === 'analysis'
      ? 'You are the second reader. The classification judge stayed unsure about these graph items. Judge each only from the evidence below; answer unsure if it still does not decide.'
      : 'You are the classification judge. Judge each graph item only from the evidence below.',
    '',
    'A graph node or edge is valid when its kind and source evidence are consistent; invalid when the item claims something its evidence contradicts; unsure when the evidence below cannot decide.',
    'Use only the ids shown. Never invent an id, text, path or line.',
    `There are ${items.length} items, at most ${JUDGE_BATCH_SIZE}.`,
    '',
  ];
  for (const item of items) {
    lines.push(`[${item.id}] ${item.role} ${item.kind}: ${item.label}`);
    lines.push(`  rule could not decide: ${item.reason}`);
    if (item.from !== undefined) lines.push(`  from: ${item.from.id} (${item.from.kind}) ${item.from.label}`);
    if (item.to !== undefined) lines.push(`  to: ${item.to.id} (${item.to.kind}) ${item.to.label}`);
    if (item.evidence.length === 0) lines.push('  evidence places: (none)');
    else for (const place of item.evidence) {
      lines.push(`  evidence place: ${place.path}${place.lineStart === undefined ? '' : `:${place.lineStart}${place.lineEnd === undefined ? '' : `-${place.lineEnd}`}`}`);
      if (place.unresolved !== undefined) lines.push(`    not resolved: ${place.unresolved}`);
      else if (place.excerpt !== undefined) for (const held of place.excerpt.split('\n')) lines.push(`    | ${held}`);
    }
    lines.push(`  evidence resolved at the fill's commit: ${item.evidenceResolved ? 'yes' : 'no; a valid answer cannot stand'}`);
    if (item.neighbourhood.length === 0) lines.push('  neighbourhood: (no edge)');
    else {
      lines.push('  neighbourhood:');
      for (const fact of item.neighbourhood) lines.push(`    ${fact}`);
    }
    lines.push(`  properties: ${JSON.stringify(item.properties)}`);
  }
  lines.push('', 'Call the verdicts tool exactly once. The reason is one line.');
  return lines.join('\n');
};

export function acpGraphJudge(pair: ModelPair, role: 'classification' | 'analysis', options: AcpGraphJudgeOptions): GraphJudge {
  const preferences: AgentPreferences = {
    ...(pair.model === undefined ? {} : { model: pair.model }),
    ...(pair.reasoning === undefined ? {} : { reasoning: pair.reasoning }),
  };
  let agent: (UnitAgent & { close(): Promise<void> }) | undefined;
  const started = (): UnitAgent & { close(): Promise<void> } => {
    if (agent !== undefined) return agent;
    const made = (options.makeAgent ?? makeUnitAgent)(pair.agent, options.env, options.progress, Object.keys(preferences).length === 0 ? undefined : preferences, options.journal);
    if ('error' in made) throw new JudgeExecutionError(`src/knowledge/graph-verdict-acp-judge.ts:1: cannot start the ${role} graph judge (${pair.agent}): ${made.error}; full path ${import.meta.dir}/graph-verdict-acp-judge.ts`);
    agent = made;
    return made;
  };
  return {
    async judge(items: readonly GraphJudgeItem[]): Promise<readonly GraphJudgeAnswer[]> {
      const allowed = new Set(items.map((item) => item.id));
      let answers: GraphJudgeAnswer[] | undefined;
      let refusal: string | undefined;
      let calls = 0;
      const client: ToolClient = {
        definitions: [VERDICT_TOOL],
        async call(tool: string, argumentsValue: unknown) {
          if (tool !== 'verdicts') return { answer: { error: `the ${role} graph judge has only the verdicts tool` }, isError: true };
          calls += 1;
          const held = typeof argumentsValue === 'object' && argumentsValue !== null ? argumentsValue as Record<string, unknown> : {};
          const raw = Array.isArray(held.answers) ? held.answers : [];
          const accepted: GraphJudgeAnswer[] = [];
          const seen = new Set<string>();
          for (const entry of raw) {
            const one = typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : {};
            const id = one.id;
            if (typeof id !== 'string' || !allowed.has(id)) {
              refusal = `the ${role} graph judge answered ${JSON.stringify(id)}, which is not an id in this batch`;
              return { answer: { accepted: false, error: refusal }, isError: true };
            }
            if (seen.has(id)) continue;
            seen.add(id);
            const verdict = one.verdict;
            if (verdict !== 'valid' && verdict !== 'invalid' && verdict !== 'unsure') {
              refusal = `the ${role} graph judge answered ${JSON.stringify(verdict)} for ${id}; it is valid, invalid or unsure`;
              return { answer: { accepted: false, error: refusal }, isError: true };
            }
            const reason = one.reason;
            if (typeof reason !== 'string' || reason.trim() === '') {
              refusal = `the ${role} graph judge gave no reason for ${id}`;
              return { answer: { accepted: false, error: refusal }, isError: true };
            }
            accepted.push({ id, verdict, reason: reason.split('\n').join(' ').split('\t').join(' ').split(' ').filter((word) => word !== '').join(' ') });
          }
          if (accepted.length === 0) {
            refusal = `the ${role} graph judge answered no items`;
            return { answer: { accepted: false, error: refusal }, isError: true };
          }
          answers = accepted;
          return { answer: { accepted: true, count: accepted.length }, isError: false };
        },
        finished() {
          return answers !== undefined || calls >= 4;
        },
      };
      let status: UnitRunStatus | void;
      try {
        status = await started().run({ id: `graph-verdicts-${role}-${items[0]?.id ?? 'none'}`, prompt: promptOf(items, role), tools: client });
      } catch (error) {
        if (error instanceof JudgeExecutionError) throw error;
        throw new JudgeExecutionError(error instanceof Error ? error.message : String(error));
      }
      // A stopped run is not evidence: an answer the tool accepted before a limit must not become a verdict.
      if (status !== undefined && status.completed !== true) {
        throw new JudgeExecutionError(`src/knowledge/graph-verdict-acp-judge.ts:1: the ${role} graph judge did not complete: ${status.stopped ?? 'the run was stopped before it answered'}; full path ${import.meta.dir}/graph-verdict-acp-judge.ts`);
      }
      if (answers === undefined) throw new JudgeExecutionError(`src/knowledge/graph-verdict-acp-judge.ts:1: the ${role} graph judge gave no valid answer${refusal === undefined ? '' : `: ${refusal}`}; full path ${import.meta.dir}/graph-verdict-acp-judge.ts`);
      return answers;
    },
    async close() {
      await agent?.close();
      agent = undefined;
    },
  };
}
