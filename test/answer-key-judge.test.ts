/**
 * The role-based judging step (madarch-j6ho.2). Every judge here is a fake: no
 * test starts a model. The tests prove the order (jev first; otherwise
 * classification, then only its unsure packs to analysis), the fallback note,
 * the unjudged report when no pair exists, and that a passage id outside the
 * pack is never accepted.
 */
import { describe, expect, test } from 'bun:test';
import type { AnswerKeyCheck, AnswerKeyItem, AnswerKeyPack } from '../src/knowledge/answer-key-check.js';
import { JudgeExecutionError, judgeAnswerKeyCheck, judgeLines, validateJudgeAnswer, type Judge, type JudgeAnswer } from '../src/knowledge/answer-key-judge.js';
import { emptyModelAssignments, resolveModelRoles, roleOf, type ModelAssignments, type ModelPair, type ModelRole } from '../src/knowledge/model-roles.js';

const PAIR: ModelPair = { agent: 'agent-a', model: 'model-a' };

function item(id: string): AnswerKeyItem {
  return {
    id,
    expectedWikiStatement: `Statement ${id}`,
    evidenceClass: 'structural',
    viewpoints: ['developer'],
    requiredNow: true,
    judge: { readerTask: `Read ${id}`, mustShow: [], mustLink: [], mustNotClaim: [] },
  };
}

function pack(id: string, passages: readonly string[] = ['p1']): AnswerKeyPack {
  return {
    item: item(id),
    classification: 'unsure',
    reason: 'semantic',
    questionItem: false,
    locations: [],
    passages: passages.map((passage, index) => ({ id: passage, page: `code.file:${id}.ts`, block: `b${index + 1}`, line: index + 1, text: `text ${id} ${passage}` })),
    elsewhere: [],
    checks: { locationsPresent: 0, locationsTotal: 0, locationsFound: 0, mustShowMatched: [], mustShowMissing: [], mustLinkMatched: [], mustLinkUnresolved: [], statementExact: false },
  };
}

function check(ids: readonly string[]): AnswerKeyCheck {
  const items = ids.map((id) => pack(id));
  return {
    keyFile: 'key.json',
    productFolder: '/product',
    totalItems: items.length,
    counts: { fully: 0, partly: 0, none: 0, unsure: items.length },
    fullyRatio: 0,
    threshold: { fullyAtLeast: 0.9, noneAtMost: 0, expectedQuestions: 8 },
    thresholdMet: false,
    gate: 'reported-only',
    seam: { mainKeyField: 'missing', mainKeyOpenItems: 8, expectedQuestionSource: 'questions.json', expectedQuestionField: 'expectedOpenQuestions', expectedQuestionCount: 8, questionsMatched: 'unsure', note: 'separate', problems: [] },
    questions: { source: 'questions.json', field: 'expectedOpenQuestions', expected: Array.from({ length: 8 }, (_, index) => ({ type: 'open', subject: `q${index}`, file: `q${index}.md` })), current: [], matched: 0 },
    items,
  };
}

class FakeJudge implements Judge {
  readonly calls: string[] = [];
  readonly answers = new Map<string, JudgeAnswer>();
  readonly fallback: JudgeAnswer;
  readonly seen: string[] = [];
  closed = 0;

  constructor(answers: Readonly<Record<string, JudgeAnswer>> = {}, fallback: JudgeAnswer = { verdict: 'unsure', reason: 'not enough', passages: [] }) {
    for (const [id, answer] of Object.entries(answers)) this.answers.set(id, answer);
    this.fallback = fallback;
  }

  async judge(pack: AnswerKeyPack): Promise<JudgeAnswer> {
    this.calls.push(pack.item.id);
    return this.answers.get(pack.item.id) ?? this.fallback;
  }

  warnings(): readonly string[] { return this.seen; }

  async close(): Promise<void> { this.closed += 1; }
}

/** A judge whose run failed before it could read anything: the difference between unjudged and unsure. */
class FailingJudge implements Judge {
  constructor(private readonly failure: Error) {}

  async judge(): Promise<JudgeAnswer> { throw this.failure; }
}

function roles(assignments: Partial<ModelAssignments> = {}): ReturnType<typeof resolveModelRoles> {
  return resolveModelRoles({ ...emptyModelAssignments(), ...assignments });
}

describe('the judging step', () => {
  test('a jev judge reads every unsure pack first, and only what it leaves unsure goes on', async () => {
    const jev = new FakeJudge({ a: { verdict: 'fully', reason: 'the symbol is shown', passages: ['p1'] }, b: { verdict: 'unsure', reason: 'one link is unread', passages: [] } });
    const classification = new FakeJudge({ b: { verdict: 'fully', reason: 'the link is shown further down', passages: ['p1'] } });
    const made: { role: ModelRole }[] = [];
    const judged = await judgeAnswerKeyCheck(check(['a', 'b']), {
      jev,
      roles: roles({ writing: PAIR, classification: PAIR, analysis: PAIR }),
      judgeForPair: (_pair, role) => { made.push({ role }); return classification; },
    });
    expect(jev.calls).toEqual(['a', 'b']);
    expect(made).toEqual([{ role: 'classification' }]);
    expect(jev.closed).toBe(1);
    expect(judged.items.map((entry) => entry.classification)).toEqual(['fully', 'fully']);
    expect(judged.items[0]!.judgedBy).toBe('jev');
    expect(judged.items[1]!.judgedBy).toBe('classification');
    expect(judged.judge?.jevUsed).toBe(true);
    expect(judged.judge?.tiers.jev).toEqual({ read: 2, fully: 1, partly: 0, none: 0, unsure: 1 });
    expect(judged.judge?.tiers.classification.read).toBe(1);
    expect(judged.judge?.person).toEqual([]);
  });

  test('without jev, classification reads every pack and only its unsure answers go to analysis', async () => {
    const classification = new FakeJudge({
      a: { verdict: 'fully', reason: 'all shown', passages: ['p1'] },
      b: { verdict: 'unsure', reason: 'the location is not enough', passages: [] },
    });
    const analysis = new FakeJudge({
      b: { verdict: 'partly', reason: 'the symbol is missing', passages: ['p1'] },
    });
    const made: { role: ModelRole; pair: ModelPair }[] = [];
    const judged = await judgeAnswerKeyCheck(check(['a', 'b']), {
      roles: roles({ writing: PAIR, classification: PAIR, analysis: { agent: 'agent-b', model: 'model-b' } }),
      judgeForPair: (pair, role) => {
        made.push({ role, pair });
        return role === 'classification' ? classification : analysis;
      },
    });
    expect(made.map((entry) => entry.role)).toEqual(['classification', 'analysis']);
    expect(classification.calls).toEqual(['a', 'b']);
    expect(analysis.calls).toEqual(['b']);
    expect(judged.items.map((entry) => entry.classification)).toEqual(['fully', 'partly']);
    expect(judged.items[1]!.judgedBy).toBe('analysis');
    expect(judged.counts).toEqual({ fully: 1, partly: 1, none: 0, unsure: 0 });
    expect(judged.judge?.tiers.classification).toEqual({ read: 2, fully: 1, partly: 0, none: 0, unsure: 1 });
    expect(judged.judge?.tiers.analysis).toEqual({ read: 1, fully: 0, partly: 1, none: 0, unsure: 0 });
    expect(judged.judge?.person).toEqual([]);
  });

  test('a pack both tiers leave unsure is listed for a person, with the second reason', async () => {
    const classification = new FakeJudge({}, { verdict: 'unsure', reason: 'needs a reader', passages: [] });
    const analysis = new FakeJudge({}, { verdict: 'unsure', reason: 'still needs a reader', passages: [] });
    const judged = await judgeAnswerKeyCheck(check(['a', 'b']), {
      roles: roles({ writing: PAIR, classification: PAIR, analysis: PAIR }),
      judgeForPair: (_pair, role) => role === 'classification' ? classification : analysis,
    });
    expect(analysis.calls).toEqual(['a', 'b']);
    expect(judged.judge?.person).toEqual([
      { itemId: 'a', reason: 'still needs a reader' },
      { itemId: 'b', reason: 'still needs a reader' },
    ]);
    expect(judged.judge?.tiers.classification.unsure).toBe(2);
    expect(judged.judge?.tiers.analysis.unsure).toBe(2);
    expect(judged.counts.unsure).toBe(2);
  });

  test('with jev present, what jev leaves unsure goes on to classification, then analysis, then a person', async () => {
    const jev = new FakeJudge({
      a: { verdict: 'unsure', reason: 'jev cannot tell', passages: [] },
      b: { verdict: 'fully', reason: 'jev read it', passages: ['p1'] },
      c: { verdict: 'unsure', reason: 'jev cannot tell', passages: [] },
    });
    const classification = new FakeJudge({
      a: { verdict: 'unsure', reason: 'the link is not shown', passages: [] },
      c: { verdict: 'unsure', reason: 'the link is not shown', passages: [] },
    });
    const analysis = new FakeJudge({
      a: { verdict: 'partly', reason: 'the link is still not shown', passages: ['p1'] },
      c: { verdict: 'unsure', reason: 'still no link', passages: [] },
    });
    const made: ModelRole[] = [];
    const judged = await judgeAnswerKeyCheck(check(['a', 'b', 'c']), {
      jev,
      roles: roles({ writing: PAIR, classification: PAIR, analysis: { agent: 'agent-b', model: 'model-b' } }),
      judgeForPair: (_pair, role) => { made.push(role); return role === 'classification' ? classification : analysis; },
    });
    expect(jev.calls).toEqual(['a', 'b', 'c']);
    expect(made).toEqual(['classification', 'analysis']);
    // Only the packs jev left unsure go on; jev's own answers stand.
    expect(classification.calls).toEqual(['a', 'c']);
    expect(analysis.calls).toEqual(['a', 'c']);
    expect(judged.items.map((entry) => entry.classification)).toEqual(['partly', 'fully', 'unsure']);
    expect(judged.items.map((entry) => entry.judgedBy)).toEqual(['analysis', 'jev', undefined]);
    expect(judged.judge?.person).toEqual([{ itemId: 'c', reason: 'still no link' }]);
    expect(judged.judge?.unjudged).toEqual([]);
    expect(judged.judge?.tiers.jev).toEqual({ read: 3, fully: 1, partly: 0, none: 0, unsure: 2 });
    expect(judged.judge?.tiers.classification.read).toBe(2);
    expect(judged.judge?.tiers.analysis.read).toBe(2);
    expect(judged.judge?.notes.some((note) => note.includes('jev read every unsure pack'))).toBe(true);
  });

  test('with jev and no model role, what jev leaves unsure reaches a person rather than staying unjudged', async () => {
    const jev = new FakeJudge({ a: { verdict: 'unsure', reason: 'jev cannot tell', passages: [] } });
    const judged = await judgeAnswerKeyCheck(check(['a']), {
      jev,
      roles: roles(),
      judgeForPair: () => { throw new Error('no model role is assigned, so none may be started'); },
    });
    expect(judged.judge?.status).toBe('judged');
    expect(judged.judge?.unjudged).toEqual([]);
    expect(judged.judge?.person).toEqual([{ itemId: 'a', reason: 'jev cannot tell' }]);
  });

  test('a judge that saw a retired saved model reports it in the report, never silently', async () => {
    const judge = new FakeJudge({ a: { verdict: 'fully', reason: 'shown', passages: ['p1'] } });
    judge.seen.push('the agent no longer offers "retired-model" as the model, so the agent\'s own was kept');
    const judged = await judgeAnswerKeyCheck(check(['a']), {
      roles: roles({ writing: PAIR, classification: PAIR, analysis: PAIR }),
      judgeForPair: () => judge,
    });
    expect(judged.judge?.warnings).toEqual(['the agent no longer offers "retired-model" as the model, so the agent\'s own was kept']);
    expect(judgeLines(judged)).toContain('judging warning: the agent no longer offers "retired-model" as the model, so the agent\'s own was kept');
  });

  test('a judge that could not run leaves its packs unjudged, never unsure', async () => {
    const judged = await judgeAnswerKeyCheck(check(['a', 'b']), {
      roles: roles({ writing: PAIR, classification: PAIR, analysis: PAIR }),
      judgeForPair: (_pair, role) => new FailingJudge(new JudgeExecutionError(`src/knowledge/answer-key-acp-judge.ts: the ${role} judge (agent-a) did not start: the adapter is not installed`)),
    });
    expect(judged.judge?.status).toBe('unjudged');
    expect(judged.judge?.unjudged.map((one) => one.itemId)).toEqual(['a', 'b']);
    expect(judged.judge?.unjudged[0]!.reason).toContain('did not start');
    expect(judged.judge?.verdicts).toEqual([]);
    expect(judged.judge?.person).toEqual([]);
    expect(judged.judge?.tiers.classification.read).toBe(0);
    expect(judged.judge?.tiers.analysis.read).toBe(0);
    expect(judged.items.map((entry) => entry.classification)).toEqual(['unsure', 'unsure']);
  });

  test('an ordinary judge error is still an unsure answer, not a missing run', async () => {
    const judged = await judgeAnswerKeyCheck(check(['a']), {
      roles: roles({ writing: PAIR, classification: PAIR, analysis: PAIR }),
      judgeForPair: () => new FailingJudge(new Error('a bug in the answer checker')),
    });
    expect(judged.judge?.status).toBe('judged');
    expect(judged.judge?.verdicts[0]!.verdict).toBe('unsure');
    expect(judged.judge?.verdicts[0]!.reason).toBe('judge failed: a bug in the answer checker');
  });

  test('an unassigned role uses writing’s pair and carries a visible fallback note', async () => {
    const judge = new FakeJudge({ a: { verdict: 'unsure', reason: 'the reading needs the next role', passages: [] } });
    const view = roles({ writing: PAIR });
    expect(roleOf(view, 'classification')).toMatchObject({ source: 'fallback', fallbackFrom: 'writing', pair: PAIR, note: 'classification is not assigned, so it uses the default pair (writing)' });
    const made: { pair: ModelPair; role: ModelRole }[] = [];
    const judged = await judgeAnswerKeyCheck(check(['a']), {
      roles: view,
      judgeForPair: (pair, role) => { made.push({ pair, role }); return judge; },
    });
    expect(made).toEqual([
      { pair: PAIR, role: 'classification' },
      { pair: PAIR, role: 'analysis' },
    ]);
    expect(judged.judge?.roles.find((role) => role.role === 'classification')).toEqual({ role: 'classification', source: 'fallback', note: 'classification is not assigned, so it uses the default pair (writing)' });
    expect(judged.judge?.notes).toContain('classification is not assigned, so it uses the default pair (writing)');
    expect(judged.judge?.notes).toContain('analysis is not assigned, so it uses the default pair (writing)');
  });

  test('with no assignment and no default pair, nothing is judged and the report says where to assign roles', async () => {
    const judged = await judgeAnswerKeyCheck(check(['a', 'b']), {
      roles: roles(),
      judgeForPair: () => { throw new Error('nothing may be started'); },
    });
    expect(judged.judge?.status).toBe('unjudged');
    expect(judged.judge?.unjudged).toHaveLength(2);
    expect(judged.judge?.unjudged[0]).toEqual({ itemId: 'a', reason: 'no classification role is assigned and there is no default pair (writing) to fall back to' });
    expect(judged.judge?.person).toEqual([]);
    expect(judged.judge?.notes.join('\n')).toContain('section Model roles');
    expect(judged.judge?.whereToAssign).toContain('/k/settings');
    expect(judged.counts).toEqual({ fully: 0, partly: 0, none: 0, unsure: 2 });
  });

  test('an answer that cites a passage outside the pack is not accepted', async () => {
    expect(() => validateJudgeAnswer(pack('a'), { verdict: 'fully', reason: 'shown', passages: ['p9'] })).toThrow('item a: a judge cited "p9"');
    expect(() => validateJudgeAnswer(pack('a'), { verdict: 'partly', reason: 'looks close', passages: [] })).toThrow('partly without citing a passage');
    const classifier = new FakeJudge({ a: { verdict: 'fully', reason: 'shown', passages: ['p9'] } });
    const judged = await judgeAnswerKeyCheck(check(['a']), {
      roles: roles({ writing: PAIR, classification: PAIR, analysis: PAIR }),
      judgeForPair: (_pair, role) => role === 'classification' ? classifier : new FakeJudge(),
    });
    expect(judged.items[0]!.classification).toBe('unsure');
    expect(judged.items[0]!.judgedBy).toBeUndefined();
    expect(judged.judge?.verdicts[0]!.verdict).toBe('unsure');
    expect(judged.judge?.verdicts[0]!.reason).toContain('not a passage in this pack');
  });

  test('a check with no unsure packs starts no judge', async () => {
    const decided = check([]);
    const judged = await judgeAnswerKeyCheck(decided, {
      roles: roles({ writing: PAIR }),
      judgeForPair: () => { throw new Error('no pack to judge'); },
    });
    expect(judged.judge?.status).toBe('judged');
    expect(judged.judge?.verdicts).toEqual([]);
    expect(judged.judge?.notes).toContain('there were no unsure packs to judge');
    expect(judgeLines(judged)).toContain('judging: there were no unsure packs to judge');
  });
});
