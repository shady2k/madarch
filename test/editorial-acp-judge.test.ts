
/**
 * The ACP-backed editing judge (madarch-ztyq.9), with a scripted agent: the factory starts nothing,
 * and the agent calls the same `revisions` tool the model sees. A request outside the pack's pages
 * or passages is refused and the agent may answer again; a judge that never answers fails in words.
 */
import { describe, expect, test } from 'bun:test';
import { editorialAcpJudge, EditorialJudgeError } from '../src/writer/editorial-acp-judge.js';
import type { EditorialJudgePack } from '../src/writer/editorial.js';
import type { UnitAgent, UnitRequest, UnitRunStatus } from '../src/writer/run.js';

const pack = (): EditorialJudgePack => ({
  pages: [{
    path: 'docs/product.md', title: 'Tiny shop',
    statements: [{ id: 'window', line: 4, text: 'The refund window is 14 days from the delivery date.' }],
  }],
  findings: [],
  maxPerPage: 1,
});

function agentOf(script: (request: UnitRequest) => Promise<void>, closed: { count: number }): (id: string) => UnitAgent & { close(): Promise<void> } {
  return (id: string) => ({
    async run(request: UnitRequest): Promise<void> {
      expect(id).toBe('claude-code');
      await script(request);
    },
    async close() { closed.count += 1; },
  });
}

describe('the ACP editing judge', () => {
  test('one process serves its passes, the prompt holds the shown passages and no model name, and a refused page may be corrected', async () => {
    const requests: UnitRequest[] = [];
    const closed = { count: 0 };
    let starts = 0;
    const judge = editorialAcpJudge({ agent: 'claude-code', model: 'model-a' }, {
      env: {},
      makeAgent: (id) => {
        starts += 1;
        return agentOf(async (request) => {
          requests.push(request);
          expect(request.tools.definitions.map((definition) => definition.name)).toEqual(['revisions']);
          const refusedPage = await request.tools.call('revisions', { revisions: [{ page: 'docs/other.md', passage: 'window', change: 'x', why: 'y' }] });
          expect(refusedPage.isError).toBe(true);
          expect(JSON.stringify(refusedPage.answer)).toContain('did not show');
          const refusedPassage = await request.tools.call('revisions', { revisions: [{ page: 'docs/product.md', passage: 'invented', change: 'x', why: 'y' }] });
          expect(refusedPassage.isError).toBe(true);
          expect(JSON.stringify(refusedPassage.answer)).toContain('did not show');
          const accepted = await request.tools.call('revisions', { revisions: [{ page: 'docs/product.md', passage: 'window', change: 'Say what the window protects.', why: 'A newcomer cannot tell.' }] });
          expect(accepted.isError).toBe(false);
        }, closed)(id);
      },
    });
    const answer = await judge.judge(pack());
    expect(answer.requests).toEqual([{ page: 'docs/product.md', passage: 'window', change: 'Say what the window protects.', why: 'A newcomer cannot tell.' }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain('[window] line 4: The refund window is 14 days');
    expect(requests[0]!.prompt).toContain('at most 1 requests for each page');
    expect(requests[0]!.prompt).not.toContain('model-a');
    await judge.judge(pack());
    expect(starts).toBe(1);
    await judge.close?.();
    expect(closed.count).toBe(1);
  });

  test('a judge that never answers, and one whose run stopped, fail in words', async () => {
    const closed = { count: 0 };
    const silent = editorialAcpJudge({ agent: 'claude-code' }, { env: {}, makeAgent: () => agentOf(async () => undefined, closed)('claude-code') });
    await expect(silent.judge(pack())).rejects.toBeInstanceOf(EditorialJudgeError);
    const stopped = editorialAcpJudge({ agent: 'claude-code' }, {
      env: {},
      makeAgent: () => ({
        async run(): Promise<UnitRunStatus> { return { completed: false, stopped: 'the time limit' }; },
        async close() { closed.count += 1; },
      }),
    });
    await expect(stopped.judge(pack())).rejects.toThrow('the time limit');
  });
});
