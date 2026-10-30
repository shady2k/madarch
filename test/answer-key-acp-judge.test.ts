/**
 * The ACP-backed judge (madarch-j6ho.2), tested with a scripted agent: the
 * factory starts nothing, and the agent calls the same `judge` tool the model
 * sees. A passage id outside the pack is refused and the agent may answer again;
 * a judge that never gives a valid answer fails in words.
 */
import { describe, expect, test } from 'bun:test';
import type { AnswerKeyPack, EvidenceQuestion } from '../src/knowledge/answer-key-check.js';
import { acpJudge } from '../src/knowledge/answer-key-acp-judge.js';
import { JudgeExecutionError } from '../src/knowledge/answer-key-judge.js';
import type { UnitAgent, UnitRequest, UnitRunStatus } from '../src/writer/run.js';

function pack(over: Partial<AnswerKeyPack> = {}): AnswerKeyPack {
  const item = {
    id: 'code.symbol:a.ts#a',
    expectedWikiStatement: 'A is one.',
    evidenceClass: 'structural' as const,
    viewpoints: ['developer'],
    requiredNow: true,
    judge: { readerTask: 'Find a and its value.', mustShow: ['export const a = 1'], mustLink: [], mustNotClaim: ['a is two'] },
  };
  return {
    item,
    classification: 'unsure',
    reason: 'semantic',
    questionItem: false,
    locations: [],
    passages: [{ id: 'p1', page: 'code.symbol:a.ts#a', block: 'code', line: 1, text: 'export const a = 1;' }],
    elsewhere: [],
    checks: { locationsPresent: 0, locationsTotal: 0, locationsFound: 0, mustShowMatched: [], mustShowMissing: [], mustLinkMatched: [], mustLinkUnresolved: [], statementExact: false },
    ...over,
  };
}

/** An agent whose run ends with the status it reports: a cancelled or timed-out run says so. */
function endingAgent(status: UnitRunStatus | void, script: (request: UnitRequest) => Promise<void>, closed: { count: number }): (id: string) => UnitAgent & { close(): Promise<void> } {
  return () => ({
    async run(request: UnitRequest): Promise<UnitRunStatus | void> {
      await script(request);
      return status;
    },
    async close() { closed.count += 1; },
  });
}

const questionPages = (count: number): readonly EvidenceQuestion[] => Array.from({ length: count }, (_, index) => ({
  slug: `q${index}`, id: `question:q${index}`, title: `Which value ${index} is authoritative?`, type: 'contradiction', state: 'open', about: [`docs/q${index}.md`],
}));

function agentOf(script: (request: UnitRequest) => Promise<void>, closed: { count: number }): (id: string) => UnitAgent & { close(): Promise<void> } {
  return (id: string) => ({
    async run(request: UnitRequest): Promise<void> {
      expect(id).toBe('claude-code');
      await script(request);
    },
    async close() { closed.count += 1; },
  });
}

describe('the ACP judge', () => {
  test('one process serves its packs, the prompt holds the pack and no model name, and a refused passage may be corrected', async () => {
    const requests: UnitRequest[] = [];
    const closed = { count: 0 };
    let starts = 0;
    const judge = acpJudge({ agent: 'claude-code', model: 'model-a' }, 'classification', {
      env: {},
      makeAgent: (id) => { starts += 1; return agentOf(async (request) => {
        requests.push(request);
        expect(request.tools.definitions.map((definition) => definition.name)).toEqual(['judge']);
        const refused = await request.tools.call('judge', { verdict: 'fully', reason: 'shown', passages: ['p9'] });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.answer)).toContain('not a passage in this pack');
        const accepted = await request.tools.call('judge', { verdict: 'fully', reason: 'the export is\nshown', passages: ['p1'] });
        expect(accepted.isError).toBe(false);
      }, closed)(id); },
    });
    const answer = await judge.judge(pack());
    expect(answer).toEqual({ verdict: 'fully', reason: 'the export is shown', passages: ['p1'] });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.id).toBe('answer-key-classification-code.symbol:a.ts#a');
    expect(requests[0]!.prompt).toContain('[p1] code.symbol:a.ts#a / code line 1: export const a = 1;');
    expect(requests[0]!.prompt).toContain('Find a and its value.');
    expect(requests[0]!.prompt).not.toContain('model-a');
    await judge.judge(pack());
    expect(starts).toBe(1); // the one agent stays for this role's next pack
    await judge.close?.();
    expect(closed.count).toBe(1);
  });

  test('the prompt carries the expected questions and the product’s question pages', async () => {
    const prompts: string[] = [];
    const closed = { count: 0 };
    const judge = acpJudge({ agent: 'claude-code' }, 'classification', {
      env: {},
      makeAgent: () => endingAgent({ completed: true }, async (request) => {
        prompts.push(request.prompt);
        await request.tools.call('judge', { verdict: 'unsure', reason: 'not enough', passages: [] });
      }, closed)('claude-code'),
    });
    const expected = [{ type: 'contradiction', subject: 'Which value is authoritative?', file: 'docs/alpha.md' }];
    await judge.judge(pack({ expectedQuestions: expected, currentQuestions: [] }));
    await judge.judge(pack({ expectedQuestions: expected, currentQuestions: questionPages(8) }));
    // The same passages, two very different products: a judge must be able to tell whether the questions were asked.
    expect(prompts[0]).not.toBe(prompts[1]);
    for (const prompt of prompts) {
      expect(prompt).toContain('Expected open questions (1):');
      expect(prompt).toContain('[contradiction] Which value is authoritative? (docs/alpha.md)');
    }
    expect(prompts[0]).toContain('Question pages in the product: 0');
    expect(prompts[1]).toContain('Question pages in the product: 8');
    expect(prompts[1]).toContain('question:q7');
    expect(prompts[1]).toContain('Which value 7 is authoritative?');
    await judge.close?.();
  });

  test('a timed-out or cancelled run never yields an accepted verdict', async () => {
    const closed = { count: 0 };
    const judge = acpJudge({ agent: 'claude-code' }, 'classification', {
      env: {},
      // The tool call was accepted before the time limit stopped the run; the answer must not be reused.
      makeAgent: () => endingAgent({ completed: false, stopped: 'the time limit of 10 minutes was reached' }, async (request) => {
        await request.tools.call('judge', { verdict: 'fully', reason: 'shown', passages: ['p1'] });
      }, closed)('claude-code'),
    });
    const failure = await Promise.resolve(judge.judge(pack())).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JudgeExecutionError);
    expect((failure as Error).message).toContain('the time limit of 10 minutes was reached');
    expect((failure as Error).message).toContain('did not complete');
  });

  test('a retired saved model is reported by the judge, never silently dropped', async () => {
    const seen = ['the agent no longer offers "retired-model" as the model, so the agent\'s own was kept'];
    const closed = { count: 0 };
    const judge = acpJudge({ agent: 'claude-code', model: 'retired-model' }, 'classification', {
      env: {},
      makeAgent: () => ({
        async run(request: UnitRequest) { await request.tools.call('judge', { verdict: 'unsure', reason: 'not enough', passages: [] }); return { completed: true }; },
        warnings: () => seen,
        async close() { closed.count += 1; },
      }),
    });
    await judge.judge(pack());
    await judge.judge(pack());
    // Two packs, one process: the warning is reported once, not repeated for every pack.
    expect(judge.warnings?.()).toEqual(seen);
  });

  test('an agent that never answers with a valid passage fails in words', async () => {
    const closed = { count: 0 };
    const judge = acpJudge({ agent: 'claude-code' }, 'analysis', {
      env: {},
      makeAgent: (id) => agentOf(async (request) => {
        await request.tools.call('judge', { verdict: 'partly', reason: 'invented', passages: ['p7'] });
      }, closed)(id),
    });
    await expect(judge.judge(pack())).rejects.toThrow('the analysis judge for item code.symbol:a.ts#a gave no valid answer');
    await judge.close?.();
    expect(closed.count).toBe(1);
  });
});
