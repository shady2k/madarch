/**
 * The role-based judging step (madarch-j6ho.2). Every judge here is a fake: no
 * test starts a model. The tests prove the order (jev first; otherwise
 * classification, then only its unsure packs to analysis), the fallback note,
 * the unjudged report when no pair exists, and that a passage id outside the
 * pack is never accepted.
 */
import { describe, expect, test } from 'bun:test';
import type { AnswerKeyCheck, AnswerKeyItem, AnswerKeyPack } from '../src/knowledge/answer-key-check.js';
import { judgeAnswerKeyCheck, judgeLines, validateJudgeAnswer, type Judge, type JudgeAnswer } from '../src/knowledge/answer-key-judge.js';
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
    questions: { source: 'questions.json', field: 'expectedOpenQuestions', expected: Array.from({ length: 8 }, (_, index) => ({ type: 'open', subject: `q${index}`, file: `q${index}.md` })), current: [] },
    items,
  };
}

class FakeJudge implements Judge {
  readonly calls: string[] = [];
  readonly answers = new Map<string, JudgeAnswer>();
  readonly fallback: JudgeAnswer;
  closed = 0;

  constructor(answers: Readonly<Record<string, JudgeAnswer>> = {}, fallback: JudgeAnswer = { verdict: 'unsure', reason: 'not enough', passages: [] }) {
    for (const [id, answer] of Object.entries(answers)) this.answers.set(id, answer);
    this.fallback = fallback;
  }

  async judge(pack: AnswerKeyPack): Promise<JudgeAnswer> {
    this.calls.push(pack.item.id);
    return this.answers.get(pack.item.id) ?? this.fallback;
  }

  async close(): Promise<void> { this.closed += 1; }
}

function roles(assignments: Partial<ModelAssignments> = {}): ReturnType<typeof resolveModelRoles> {
  return resolveModelRoles({ ...emptyModelAssignments(), ...assignments });
}

describe('the judging step', () => {
  test('a jev judge reads every unsure pack and no model role is started', async () => {
    const jev = new FakeJudge({ a: { verdict: 'fully', reason: 'the symbol is shown', passages: ['p1'] }, b: { verdict: 'unsure', reason: 'one link is unread', passages: [] } });
    let made = 0;
    const judged = await judgeAnswerKeyCheck(check(['a', 'b']), {
      jev,
      roles: roles({ writing: PAIR, classification: PAIR, analysis: PAIR }),
      judgeForPair: () => { made += 1; throw new Error('a model role must not be started when jev is present'); },
    });
    expect(jev.calls).toEqual(['a', 'b']);
    expect(made).toBe(0);
    expect(jev.closed).toBe(1);
    expect(judged.items.map((entry) => entry.classification)).toEqual(['fully', 'unsure']);
    expect(judged.items[0]!.judgedBy).toBe('jev');
    expect(judged.judge?.jevUsed).toBe(true);
    expect(judged.judge?.tiers.jev).toEqual({ read: 2, fully: 1, partly: 0, none: 0, unsure: 1 });
    expect(judged.judge?.tiers.classification.read).toBe(0);
    expect(judged.judge?.person.map((person) => person.itemId)).toEqual(['b']);
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

  test('an unassigned role uses writing’s pair and carries a visible fallback note', async () => {
    const judge = new FakeJudge({ a: { verdict: 'fully', reason: 'shown', passages: ['p1'] } });
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
