/**
 * The ACP-backed graph judge (madarch-mwhd.1), tested with a scripted agent:
 * the factory starts nothing, and the agent calls the same `verdicts` tool the
 * model sees. An id outside the batch is refused; a subset is accepted; a
 * judge that never gives a valid answer fails in words. The prompt names
 * evidence places, never the model.
 */
import { describe, expect, test } from 'bun:test';
import { acpGraphJudge } from '../src/knowledge/graph-verdict-acp-judge.js';
import { JudgeExecutionError } from '../src/knowledge/answer-key-judge.js';
import type { GraphJudgeItem } from '../src/knowledge/graph-verdicts.js';
import type { UnitAgent, UnitRequest, UnitRunStatus } from '../src/writer/run.js';

const items: GraphJudgeItem[] = [
  {
    id: 'n1', role: 'node', kind: 'code.database', label: 'shop', reason: 'no rule decides this database',
    evidence: [{ path: 'db/schema.sql', lineStart: 2, lineEnd: 4 }],
    properties: { path: 'db/schema.sql', evidence: [{ evidenceKind: 'schema' }] },
  },
  {
    id: 'e1', role: 'edge', kind: 'code.uses-database', label: 'service uses shop', reason: 'no rule decides this use',
    evidence: [], properties: {},
    from: { id: 's1', kind: 'code.service', label: 'checkout' },
    to: { id: 'n1', kind: 'code.database', label: 'shop' },
  },
];

function agentOf(script: (request: UnitRequest) => Promise<void>, closed: { count: number }): (id: string) => UnitAgent & { close(): Promise<void> } {
  return (id: string) => ({
    async run(request: UnitRequest): Promise<UnitRunStatus | void> {
      expect(id).toBe('claude-code');
      await script(request);
    },
    async close() { closed.count += 1; },
  });
}

describe('the ACP graph judge', () => {
  test('one process serves its role, the prompt holds the batch and no model name, and a refused id may be corrected', async () => {
    const requests: UnitRequest[] = [];
    const closed = { count: 0 };
    let starts = 0;
    const judge = acpGraphJudge({ agent: 'claude-code', model: 'model-a' }, 'classification', {
      env: {},
      makeAgent: (id) => { starts += 1; return agentOf(async (request) => {
        requests.push(request);
        expect(request.tools.definitions.map((definition) => definition.name)).toEqual(['verdicts']);
        const refused = await request.tools.call('verdicts', { answers: [{ id: 'n9', verdict: 'valid', reason: 'shown' }] });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.answer)).toContain('not an id in this batch');
        const accepted = await request.tools.call('verdicts', { answers: [
          { id: 'n1', verdict: 'invalid', reason: 'the schema is\nnot this database' },
          { id: 'e1', verdict: 'unsure', reason: 'the use is not shown' },
        ] });
        expect(accepted.isError).toBe(false);
      }, closed)(id); },
    });
    const answer = await judge.judge(items);
    expect(answer).toEqual([
      { id: 'n1', verdict: 'invalid', reason: 'the schema is not this database' },
      { id: 'e1', verdict: 'unsure', reason: 'the use is not shown' },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.id).toBe('graph-verdicts-classification-n1');
    expect(requests[0]!.prompt).toContain('[n1] node code.database: shop');
    expect(requests[0]!.prompt).toContain('evidence place: db/schema.sql:2-4');
    expect(requests[0]!.prompt).toContain('from: s1 (code.service) checkout');
    expect(requests[0]!.prompt).toContain('properties: {"path":"db/schema.sql"');
    expect(requests[0]!.prompt).not.toContain('model-a');
    await judge.judge(items);
    expect(starts).toBe(1);
    await judge.close?.();
    expect(closed.count).toBe(1);
  });


  test('a stopped run never yields an accepted verdict', async () => {
    const closed = { count: 0 };
    const judge = acpGraphJudge({ agent: 'claude-code' }, 'classification', {
      env: {},
      makeAgent: () => ({
        async run(request: UnitRequest): Promise<UnitRunStatus> {
          await request.tools.call('verdicts', { answers: [{ id: 'n1', verdict: 'valid', reason: 'shown before the stop' }] });
          return { completed: false, stopped: 'the time limit of 10 minutes was reached' };
        },
        async close() { closed.count += 1; },
      }),
    });
    const failure = await Promise.resolve(judge.judge(items)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JudgeExecutionError);
    expect((failure as Error).message).toContain('did not complete');
    expect((failure as Error).message).toContain('the time limit of 10 minutes was reached');
    await judge.close?.();
    expect(closed.count).toBe(1);
  });

  test('a subset is accepted, and an agent that never answers with a valid id fails in words', async () => {
    const closed = { count: 0 };
    const subset = acpGraphJudge({ agent: 'claude-code' }, 'analysis', {
      env: {},
      makeAgent: (id) => agentOf(async (request) => {
        const accepted = await request.tools.call('verdicts', { answers: [{ id: 'e1', verdict: 'valid', reason: 'the relation is shown' }] });
        expect(accepted.isError).toBe(false);
      }, closed)(id),
    });
    expect(await subset.judge(items)).toEqual([{ id: 'e1', verdict: 'valid', reason: 'the relation is shown' }]);
    await subset.close?.();
    let starts = 0;
    const silent = acpGraphJudge({ agent: 'claude-code' }, 'analysis', {
      env: {},
      makeAgent: (id) => { starts += 1; return agentOf(async (request) => {
        await request.tools.call('verdicts', { answers: [{ id: 'n9', verdict: 'valid', reason: 'invented' }] });
      }, closed)(id); },
    });
    await expect(silent.judge(items)).rejects.toThrow('the analysis graph judge gave no valid answer');
    expect(starts).toBe(1);
    await silent.close?.();
    expect(closed.count).toBe(2);
  });
});
