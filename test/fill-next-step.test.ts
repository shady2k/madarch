/**
 * What a page recommends next (the self-filling charter's outcome 5, «Всегда должна
 * быть рекомендация что делать. Это зачатки трекера»; decision 0026, "Pages").
 *
 * The order the rules are held to is the charter's own sentence: **open questions first,
 * then uncovered important nodes** — and a page whose questions are answered, whose scope
 * is covered and whose proposals are settled says so rather than inventing work.
 */
import { describe, expect, test } from 'bun:test';
import { isImportant, mostAskedQuestion, pageNextStep, productNextStep, type RankedQuestion, type StepNode } from '../src/fill/next-step.js';

const MODULE_ID = `module:${'1'.repeat(64)}`;
const QUESTION_ID = `question:${'2'.repeat(64)}`;
const OTHER_QUESTION = `question:${'3'.repeat(64)}`;

const node: StepNode = { id: MODULE_ID, kind: 'module', label: 'checkout', page: `/p/graph/${MODULE_ID}`, importance: 0.42 };

const question = (over: Partial<RankedQuestion> = {}): RankedQuestion => ({ id: QUESTION_ID, type: 'assumption-check', prompt: 'Is an order placed at authorization or at capture?', rank: 3, ...over });

describe('the step one page recommends', () => {
  test('the page\'s own open question comes first, the most depended-on of them, and the step names what its answer changes', () => {
    const step = pageNextStep({
      node,
      questions: [question({ rank: 1, prompt: 'Why is the total rounded down?', id: OTHER_QUESTION }), question()],
      covered: false,
      assumptions: 2,
    });
    expect(step.rule).toBe('answer-question');
    expect(step.question).toEqual({ id: QUESTION_ID, type: 'assumption-check', prompt: 'Is an order placed at authorization or at capture?', rank: 3, page: `/p/graph/${QUESTION_ID}` });
    // The page the step opens is the question's own page: that is where a person answers it.
    expect(step.target).toBe(`/p/graph/${QUESTION_ID}`);
    expect(step.node.id).toBe(MODULE_ID);
    expect(step.reason).toBe('the answer changes 3 pages depend on it (assumption-check): answer it, and only those pages are read again');
  });

  test('a page with no question asks for the scope nobody read, when the fill ranked it important', () => {
    const step = pageNextStep({ node, questions: [], covered: false, assumptions: 1 });
    expect(step.rule).toBe('cover-node');
    expect(step.target).toBe(`/p/graph/${MODULE_ID}`);
    expect(step.reason).toContain('0.42');
  });

  test('a page nobody ranked is not told to cover its scope: an unranked node is not the next thing to do', () => {
    const unranked: StepNode = { id: MODULE_ID, kind: 'package', label: '@acme/orders', page: `/p/graph/${MODULE_ID}` };
    expect(isImportant(unranked)).toBe(false);
    expect(pageNextStep({ node: unranked, questions: [], covered: false, assumptions: 1 }).rule).toBe('review-assumption');
    // A rank of zero is no importance either: stage 5 measured that nothing depends on it.
    expect(isImportant({ importance: 0 })).toBe(false);
  });

  test('a page that is itself an open question recommends answering it, and a page a person decided no longer asks', () => {
    // A question's own page is the page a person answers it on, so it names that act first — and its own address.
    const own = pageNextStep({ node: { ...node, kind: 'question' }, questions: [], own: { id: QUESTION_ID, type: 'term', prompt: 'does "placed" mean authorized or captured?', rank: 2 }, covered: true, assumptions: 1 });
    expect(own.rule).toBe('answer-question');
    expect(own.question?.id).toBe(QUESTION_ID);
    expect(own.target).toBe(`/p/graph/${MODULE_ID}`);
    // A page whose proposals a person has accepted no longer asks for that word (the same page, with a decision).
    expect(pageNextStep({ node, questions: [], covered: true, assumptions: 2 }).rule).toBe('review-assumption');
    expect(pageNextStep({ node, questions: [], covered: true, assumptions: 2, decided: true }).rule).toBe('nothing-to-do');
  });

  test('a covered page with settled proposals has nothing to do, and says so', () => {
    const step = pageNextStep({ node, questions: [question({ rank: 4 })], covered: true, assumptions: 0 });
    // An open question is still the step even when the scope is covered: questions come first.
    expect(step.rule).toBe('answer-question');
    const answered = pageNextStep({ node, questions: [], covered: true, assumptions: 0 });
    expect(answered.rule).toBe('nothing-to-do');
    expect(answered.reason).toContain('nothing waits for a person here');
  });
});

describe('the product\'s own step', () => {
  test('the most asked open question of the whole graph, else the most important uncovered node', () => {
    const product: StepNode = { id: 'Fixture Product', kind: null, label: 'Fixture Product', page: '/p/graph' };
    const asked = productNextStep({
      product,
      questions: [
        { ...question({ rank: 2, id: OTHER_QUESTION }), page: `/p/graph/${OTHER_QUESTION}`, node: { id: OTHER_QUESTION, kind: 'question', label: 'Why?', page: `/p/graph/${OTHER_QUESTION}` } },
        { ...question(), page: `/p/graph/${QUESTION_ID}`, node: { id: QUESTION_ID, kind: 'question', label: 'What?', page: `/p/graph/${QUESTION_ID}` } },
      ],
      uncovered: { id: MODULE_ID, kind: 'module', label: 'checkout', page: `/p/graph/${MODULE_ID}`, importance: 0.9 },
    });
    expect(asked.rule).toBe('answer-question');
    expect(asked.target).toBe(`/p/graph/${QUESTION_ID}`);
    const uncovered = productNextStep({ product, questions: [], uncovered: { id: MODULE_ID, kind: 'module', label: 'checkout', page: `/p/graph/${MODULE_ID}`, importance: 0.9 } });
    expect(uncovered.rule).toBe('cover-node');
    expect(uncovered.target).toBe(`/p/graph/${MODULE_ID}`);
    const nothing = productNextStep({ product, questions: [] });
    expect(nothing.rule).toBe('nothing-to-do');
    expect(nothing.target).toBe('/p/graph');
  });

  test('the most asked question is one answer, chosen the same way on every machine', () => {
    const at = (rank: number, prompt: string, id: string) => ({ rank, prompt, id, type: 'meaning', page: `/p/graph/${id}`, node: { id, kind: 'question' as const, label: prompt, page: `/p/graph/${id}` } });
    expect(mostAskedQuestion([at(1, 'b', OTHER_QUESTION), at(5, 'z', QUESTION_ID)])?.id).toBe(QUESTION_ID);
    expect(mostAskedQuestion([at(5, 'b', OTHER_QUESTION), at(5, 'a', QUESTION_ID)])?.id).toBe(QUESTION_ID);
    expect(mostAskedQuestion([])).toBeUndefined();
  });
});
