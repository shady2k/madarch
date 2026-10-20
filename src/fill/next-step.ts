/**
 * What a page recommends next (the self-filling charter's outcome 5; decision 0026,
 * "Pages"): the rule, and the one place it is decided.
 *
 * The owner's words: «Всегда должна быть рекомендация что делать. Это зачатки
 * трекера» — every page says what to do next, and the graph says it. The order is the
 * charter's own list of outcomes and the order it names them in: **open questions
 * first, then uncovered important nodes.**
 *
 * 1. **A question the page itself raises.** The page's open questions are ranked by
 *    what depends on the answer (`GraphQuestion.rank`), so the question that would
 *    change the most pages comes first.
 * 2. **A scope nobody read.** A node the fill ranked as important (`importance`, stage
 *    5's PageRank) whose scope has no complete coverage is a hole the graph knows
 *    about: the step names it and nothing invents what stands there.
 * 3. **An assumption to review.** A page of facts no person has accepted yet (0005:
 *    an agent's reading is `proposed`) asks for the person's word when nothing else is
 *    waiting.
 * 4. **Nothing.** A page whose questions are answered, whose scope is covered and
 *    whose assumptions a person accepted has no step, and the page says so instead of
 *    inventing one.
 *
 * The product's own page (the graph's index) is the same rule over the whole graph:
 * its most asked question, else the most important node no coverage reached.
 *
 * Everything here is a pure function of what the graph answered, so the same facts
 * recommend the same step on every machine, and a test states the expectation from
 * the charter rather than from this code.
 */
import type { FactKind } from './facts.js';

/** The page address a step opens, as the server hands it out (`pageAddress`). */
export type PageAddress = string;

/** Which rule decided a step; a reader shows the step's words, a test names the rule. */
export const NEXT_STEP_RULES = ['answer-question', 'cover-node', 'review-assumption', 'nothing-to-do'] as const;
export type GraphNextStepRule = (typeof NEXT_STEP_RULES)[number];

/** One open question as a step names it: enough for a reader to know what to answer. */
export interface NextStepQuestion {
  readonly id: string;
  /** The charter's own type of the question (`meaning`, `contradiction`, …). */
  readonly type: string;
  /** The question as a person reads it, one sentence. */
  readonly prompt: string;
  /** How many pages depend on the answer; the question's place in the order. */
  readonly rank: number;
  /** The page the question stands on, which is where a person answers it. */
  readonly page: PageAddress;
}

/** The step a page or the product recommends, in the one shape both are read as. */
export interface GraphNextStep {
  readonly rule: GraphNextStepRule;
  /** The question to answer, for the rules that answer one. */
  readonly question?: NextStepQuestion;
  /** The page the step opens: a question's page, a node's page, or the page that carries the step. */
  readonly target: PageAddress;
  /** The node the step is about: the uncovered one, or the node whose question it answers. */
  readonly node: { readonly id: string; readonly kind: FactKind | null; readonly label: string };
  /** Why this is the step, one sentence. */
  readonly reason: string;
}

/** One question a page may recommend answering: what the rule needs of it. */
export interface RankedQuestion {
  readonly id: string;
  readonly type: string;
  readonly prompt: string;
  readonly rank: number;
}

/** One node a rule names: its fact id, the kind the graph holds it at, its label, its page and its rank. */
export interface StepNode {
  readonly id: string;
  readonly kind: FactKind | null;
  readonly label: string;
  readonly page: PageAddress;
  /** The rank stage 5 measured of the node, when its kind carries one. */
  readonly importance?: number;
}

/**
 * The most asked question of the ones given, by rank, then the question's words and
 * id in code point order (the order `byQuestionRank` states once for every reader): a
 * question's page is passed in, since this rule reads no graph of its own.
 */
export function mostAskedQuestion<Q extends RankedQuestion & { readonly page: PageAddress }>(questions: readonly Q[]): Q | undefined {
  let best: Q | undefined;
  for (const question of questions) {
    if (best === undefined) { best = question; continue; }
    if (question.rank > best.rank) { best = question; continue; }
    if (question.rank < best.rank) continue;
    if (question.prompt < best.prompt) { best = question; continue; }
    if (question.prompt > best.prompt) continue;
    if (question.id < best.id) best = question;
  }
  return best;
}

/** The question step: the question, its page, and why answering it is the next thing. */
export function answerQuestionStep(question: RankedQuestion & { readonly page: PageAddress; readonly node: StepNode }): GraphNextStep {
  const pages = question.rank === 1 ? 'one page depends' : `${String(question.rank)} pages depend`;
  return {
    rule: 'answer-question',
    question: { id: question.id, type: question.type, prompt: question.prompt, rank: question.rank, page: question.page },
    target: question.page,
    node: question.node,
    reason: `the answer changes ${pages} on it (${question.type}): answer it, and only those pages are read again`,
  };
}

/** The uncovered-scope step: an important node whose scope no complete coverage reached. */
export function coverNodeStep(node: StepNode, why: string): GraphNextStep {
  return { rule: 'cover-node', target: node.page, node, reason: why };
}

/** The assumption step: a page whose proposed content waits for a person's word (0005). */
export function reviewAssumptionStep(node: StepNode, assumptions: number): GraphNextStep {
  return {
    rule: 'review-assumption',
    target: node.page,
    node,
    reason: `nothing waits on an answer here, and this page holds ${assumptions === 1 ? 'one proposal' : `${String(assumptions)} proposals`} no person has accepted: accept or reject them`,
  };
}

/** The step a page with nothing waiting recommends: a step, and an honest one. */
export function nothingToDo(node: StepNode): GraphNextStep {
  return { rule: 'nothing-to-do', target: node.page, node, reason: 'no question on this page or the pages it is bound to is open, its scope is covered, and its proposals are settled: nothing waits for a person here' };
}

/**
 * Whether a node is important enough for an uncovered scope to be a step: the rank
 * stage 5's PageRank measured of it (decision 0026, "importance by PageRank"), and a
 * node the graph measured no rank of is not one this rule names — a page set's
 * hundreds of unranked tables are not the next thing to do.
 */
export function isImportant(node: { readonly importance?: number }): boolean {
  return node.importance !== undefined && node.importance > 0;
}

/** What a page's own next step is read from: the page, its questions, its neighbours' questions and its coverage. */
export interface PageStepInput {
  readonly node: StepNode;
  /** The open questions about this page's node, in any order; the rule ranks them. */
  readonly questions: readonly RankedQuestion[];
  /** Whether a complete coverage of any of the page's scopes exists. */
  readonly covered: boolean;
  /** How many of the page's facts an agent inferred and no person accepted (0005: `proposed`). */
  readonly assumptions: number;
}

/**
 * The step one node's page recommends: the charter's order — a question of its own
 * first, then a scope nobody read, then an assumption to review, and nothing when
 * nothing waits.
 */
export function pageNextStep(input: PageStepInput): GraphNextStep {
  const own = mostAskedQuestion(input.questions.map((question) => ({ ...question, page: input.node.page, node: input.node })));
  if (own !== undefined) return answerQuestionStep(own);
  if (input.covered === false && isImportant(input.node)) {
    return coverNodeStep(input.node, `no complete coverage of this node's scope was published, and the fill ranked it important (${String(input.node.importance)}): read it, so what stands here is read and not assumed`);
  }
  if (input.assumptions > 0) return reviewAssumptionStep(input.node, input.assumptions);
  return nothingToDo(input.node);
}

/** What the product's own step is read from: every open question, and the most important node no coverage reached. */
export interface ProductStepInput {
  readonly product: StepNode;
  readonly questions: readonly (RankedQuestion & { readonly page: PageAddress; readonly node: StepNode })[];
  /** The most important node whose scope no complete coverage names, when the product holds one. */
  readonly uncovered?: StepNode;
}

/**
 * The step the product's own page recommends: the most asked open question of the
 * whole graph, else the most important node no coverage reached, else nothing.
 */
export function productNextStep(input: ProductStepInput): GraphNextStep {
  const question = mostAskedQuestion(input.questions);
  if (question !== undefined) return answerQuestionStep(question);
  if (input.uncovered !== undefined) {
    return coverNodeStep(input.uncovered, `no complete coverage reached this node, and the fill ranked it the most important of those (${String(input.uncovered.importance)}): read it next`);
  }
  return nothingToDo(input.product);
}
