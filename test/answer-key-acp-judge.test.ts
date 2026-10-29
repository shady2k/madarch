/**
 * The ACP-backed judge (madarch-j6ho.2), tested with a scripted agent: the
 * factory starts nothing, and the agent calls the same `judge` tool the model
 * sees. A passage id outside the pack is refused and the agent may answer again;
 * a judge that never gives a valid answer fails in words.
 */
import { describe, expect, test } from 'bun:test';
import type { AnswerKeyPack } from '../src/knowledge/answer-key-check.js';
import { acpJudge } from '../src/knowledge/answer-key-acp-judge.js';
import type { UnitAgent, UnitRequest } from '../src/writer/run.js';

function pack(): AnswerKeyPack {
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
    checks: { locationsPresent: 0, locationsTotal: 0, locationsFound: 0, mustShowMatched: [], mustShowMissing: [], mustLinkMatched: [], mustLinkUnresolved: [], statementExact: false },
  };
}

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
