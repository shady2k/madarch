import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFillMachine, type MachineSpec } from '../src/fill/fsm-core.js';
import {
  CHAIN_STATES,
  RUN_STATES,
  UNIT_STATES,
  chainMachine,
  newChainContext,
  newRunContext,
  newUnitContext,
  runMachine,
  unitMachine,
} from '../src/fill/fsm.js';
import type {
  ChainEvent,
  ChainState,
  RunContext,
  RunEvent,
  RunEvidence,
  RunState,
  UnitChildOutcome,
  UnitContext,
  UnitEvent,
  UnitFailedChildPolicy,
  UnitFailCause,
  UnitRetryCause,
  UnitState,
} from '../src/fill/fsm.js';

/**
 * The transitions decision 0027 allows, written out from the decision rather than
 * from the table: "planned → ready → leased → running → draft → validating →
 * published; running → waiting_children → ready (join); validating → retry_wait →
 * ready and leased/running → retry_wait on lease expiry or transient failure; →
 * blocked and back after an explicit resolution; → failed when budget or retries
 * are exhausted; an unpublished generation → stale or cancelled, a published one
 * marked stale and linked to its replacement". Every step that advances, blocks or
 * ends a generation names the generation in force, and every one of them names the
 * fencing token in force as well; only `invalidate` and `cancel` speak for the unit
 * as a whole. A failed child is judged by the run's resolved policy: propagate,
 * block or accept partial.
 */
interface UnitExpectation {
  readonly from: UnitState;
  readonly event: UnitEvent['type'];
  readonly to: UnitState;
  readonly guards: readonly string[];
  readonly actions: readonly string[];
  /** The cause a retry or a fail names, when the transition needs one. */
  readonly cause?: string;
  /** The policy a join names, and the children it judges, when it is not the all-published one. */
  readonly failedChildPolicy?: UnitFailedChildPolicy;
  readonly children?: readonly UnitChildOutcome[];
  /** Context a step from this state carries, beyond `contextIn`. */
  readonly context?: Partial<UnitContext>;
}

/** The states in which a unit holds a lease, so its steps name the token as well as the generation. */
const LEASED_STATES = ['leased', 'running', 'draft', 'validating'] as const;
/** The states an attempt can end in, so the last retry spent there fails the unit. */
const ATTEMPT_ENDS = ['leased', 'running', 'draft', 'validating'] as const;
/** Every live state; the run's budget ends the generation wherever it stands. */
const LIVE_STATES = ['planned', 'ready', ...LEASED_STATES, 'waiting_children', 'retry_wait', 'blocked'] as const;
/** The states that held a draft set or a lease, so a rerun retracts and revokes it. */
const RERUN_STATES = ['leased', 'running', 'draft', 'validating'] as const;

const retract = ['retract-draft', 'emit-progress'];
const revokeAndRetract = ['revoke-lease', 'retract-draft', 'emit-progress'];
const invalidate = ['link-replacement', 'retract-draft', 'revoke-lease', 'emit-progress'];
const cancel = ['revoke-authority', 'revoke-lease', 'retract-draft', 'emit-progress'];
const fenced = ['generation-current', 'fence-current'];

const UNIT_EXPECTED: readonly UnitExpectation[] = [
  { from: 'planned', event: 'admit', to: 'ready', guards: ['generation-current'], actions: ['enqueue-ready', 'emit-progress'] },
  { from: 'ready', event: 'lease', to: 'leased', guards: ['fence-advances'], actions: ['take-fence', 'emit-progress'] },
  { from: 'leased', event: 'start', to: 'running', guards: fenced, actions: ['emit-progress'] },
  { from: 'running', event: 'submit-draft', to: 'draft', guards: fenced, actions: ['record-draft', 'emit-progress'] },
  { from: 'draft', event: 'validate-draft', to: 'validating', guards: fenced, actions: ['record-validation', 'emit-progress'] },
  { from: 'validating', event: 'publish', to: 'published', guards: [...fenced, 'reads-fresh'], actions: ['record-publication', 'emit-progress'] },
  { from: 'running', event: 'wait-for-children', to: 'waiting_children', guards: [...fenced, 'children-sealed'], actions: ['suspend-parent', 'emit-progress'] },
  // The join under the run's resolved policy for a failed child: all published, or the failed ones accepted.
  { from: 'waiting_children', event: 'join', to: 'ready', guards: ['generation-current', 'children-published-and-fresh'], actions: ['resume-join', 'enqueue-ready', 'emit-progress'] },
  {
    from: 'waiting_children', event: 'join', to: 'ready', failedChildPolicy: 'accept-partial',
    guards: ['generation-current', 'children-accepted-partial'], actions: ['resume-join', 'enqueue-ready', 'emit-progress'],
    children: [{ unitId: 'child-a', generation: 1, published: true, fresh: true, failed: false }, { unitId: 'child-b', generation: 1, published: false, fresh: false, failed: true }],
  },
  { from: 'validating', event: 'retry', to: 'retry_wait', cause: 'validation-problem', guards: ['generation-current', 'retries-remain', 'retry-time-named', 'cause-validation-problem'], actions: ['spend-retry', 'wait-for-retry', 'retract-draft', 'schedule-retry', 'emit-progress'] },
  { from: 'leased', event: 'retry', to: 'retry_wait', cause: 'lease-expired', guards: ['generation-current', 'retries-remain', 'retry-time-named', 'cause-lease-expired'], actions: ['spend-retry', 'wait-for-retry', 'revoke-lease', 'retract-draft', 'schedule-retry', 'emit-progress'] },
  { from: 'leased', event: 'retry', to: 'retry_wait', cause: 'transient-failure', guards: ['generation-current', 'retries-remain', 'retry-time-named', 'cause-transient-failure'], actions: ['spend-retry', 'wait-for-retry', 'revoke-lease', 'retract-draft', 'schedule-retry', 'emit-progress'] },
  { from: 'running', event: 'retry', to: 'retry_wait', cause: 'lease-expired', guards: ['generation-current', 'retries-remain', 'retry-time-named', 'cause-lease-expired'], actions: ['spend-retry', 'wait-for-retry', 'revoke-lease', 'retract-draft', 'schedule-retry', 'emit-progress'] },
  { from: 'running', event: 'retry', to: 'retry_wait', cause: 'transient-failure', guards: ['generation-current', 'retries-remain', 'retry-time-named', 'cause-transient-failure'], actions: ['spend-retry', 'wait-for-retry', 'retract-draft', 'schedule-retry', 'emit-progress'] },
  { from: 'retry_wait', event: 'retry', to: 'ready', guards: ['generation-current', 'retry-elapsed'], actions: ['clear-retry', 'enqueue-ready', 'emit-progress'] },
  { from: 'ready', event: 'block', to: 'blocked', guards: [...fenced, 'block-reason-named'], actions: ['emit-progress'] },
  ...LEASED_STATES.map((from): UnitExpectation => ({ from, event: 'block', to: 'blocked', guards: [...fenced, 'block-reason-named'], actions: ['revoke-lease', 'emit-progress'] })),
  { from: 'waiting_children', event: 'block', to: 'blocked', guards: [...fenced, 'block-reason-named'], actions: ['emit-progress'] },
  { from: 'blocked', event: 'unblock', to: 'ready', guards: ['generation-current', 'resolution-named'], actions: ['record-resolution', 'enqueue-ready', 'emit-progress'] },
  // "→ failed when budget or retries are exhausted": one rule, from every live generation.
  ...LIVE_STATES.map((from): UnitExpectation => ({
    from, event: 'fail', to: 'failed', cause: 'budget-exhausted',
    guards: [...fenced, 'fail-cause'],
    actions: (LEASED_STATES as readonly string[]).includes(from) ? revokeAndRetract : retract,
  })),
  // The third policy for a failed child: the run propagates it, and the waiting parent fails with it.
  { from: 'waiting_children', event: 'fail', to: 'failed', cause: 'child-failed', guards: [...fenced, 'cause-child-failed'], actions: revokeAndRetract },
  // Staleness: every live generation — a planned one whose inputs changed before admission included,
  // since the decision lets any unpublished generation go stale — and the published one, which only goes stale.
  ...LIVE_STATES.map((from): UnitExpectation => ({ from, event: 'invalidate', to: 'stale', guards: ['replacement-named'], actions: invalidate })),
  { from: 'published', event: 'invalidate', to: 'stale', guards: ['replacement-named'], actions: ['link-replacement', 'revoke-lease', 'emit-progress'] },
  // Cancellation is the run control's authority over whatever generation stands, so it names none.
  { from: 'planned', event: 'cancel', to: 'cancelled', guards: [], actions: ['revoke-authority', 'retract-draft', 'emit-progress'] },
  ...(['ready', ...LEASED_STATES, 'waiting_children', 'retry_wait', 'blocked'] as const).map((from): UnitExpectation => ({ from, event: 'cancel', to: 'cancelled', guards: [], actions: cancel })),
];

const UNIT_EVENTS: readonly UnitEvent['type'][] = [
  'admit', 'lease', 'start', 'submit-draft', 'validate-draft', 'publish', 'wait-for-children',
  'join', 'retry', 'block', 'unblock', 'fail', 'invalidate', 'cancel',
];

function contextIn(from: UnitState): UnitContext {
  return {
    generation: 1,
    attempt: 1,
    fence: 1,
    retriesLeft: 2,
    retryAt: from === 'retry_wait' ? 5 : null,
    replacedBy: null,
  };
}

const holdsLease = (from: UnitState): boolean => (LEASED_STATES as readonly string[]).includes(from);

/** The token in force for a state's context: the same one every step names, leased or not. */
const tokenIn = (context: UnitContext): number => context.fence;

function eventFor(expectation: UnitExpectation): UnitEvent {
  const at = 10;
  const context = { ...contextIn(expectation.from), ...expectation.context };
  const fence = tokenIn(context);
  switch (expectation.event) {
    case 'admit': return { type: 'admit', at, generation: context.generation };
    case 'lease': return { type: 'lease', at, fence: 2, attempt: 2 };
    case 'start': return { type: 'start', at, generation: context.generation, fence };
    case 'submit-draft': return { type: 'submit-draft', at, generation: context.generation, fence };
    case 'validate-draft': return { type: 'validate-draft', at, generation: context.generation, fence };
    case 'publish': return { type: 'publish', at, generation: context.generation, fence, readsFresh: true };
    case 'wait-for-children': return { type: 'wait-for-children', at, generation: context.generation, fence, children: [{ unitId: 'child-a', generation: 1, published: false, fresh: true, failed: false }] };
    case 'join': return {
      type: 'join', at, generation: context.generation,
      failedChildPolicy: expectation.failedChildPolicy ?? 'propagate',
      children: expectation.children ?? [{ unitId: 'child-a', generation: 1, published: true, fresh: true, failed: false }],
    };
    case 'retry': return { type: 'retry', at, generation: context.generation, cause: expectation.cause as UnitRetryCause, retryAt: 30 };
    case 'block': return { type: 'block', at, generation: context.generation, fence, reason: 'waiting for a producer' };
    case 'unblock': return { type: 'unblock', at, generation: context.generation, resolution: 'the producer was enabled' };
    case 'fail': return { type: 'fail', at, generation: context.generation, fence, cause: expectation.cause as UnitFailCause };
    case 'invalidate': return { type: 'invalidate', at, replacement: 2, cause: 'inputs changed' };
    case 'cancel': return { type: 'cancel', at, cause: 'the person stopped the run' };
  }
}

const descriptor = (from: string, event: string, to: string): string => `${from} --${event}--> ${to}`;
const nameOf = (expectation: UnitExpectation): string => `${descriptor(expectation.from, expectation.event, expectation.to)}${expectation.cause === undefined ? '' : ` on ${expectation.cause}`}${expectation.failedChildPolicy === undefined ? '' : ` under ${expectation.failedChildPolicy}`}`;


describe('unit machine: every allowed transition, from decision 0027', () => {
  test('the table holds exactly the transitions the decision allows, no more and no fewer', () => {
    const declared = unitMachine.spec.transitions.map((transition) => descriptor(transition.from, transition.event, transition.to)).sort();
    const expected = UNIT_EXPECTED.map((expectation) => descriptor(expectation.from, expectation.event, expectation.to)).sort();
    expect(declared).toEqual(expected);
    const ids = unitMachine.spec.transitions.map((transition) => transition.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.each(UNIT_EXPECTED.map((expectation) => [nameOf(expectation), expectation] as const))(
    '%s is allowed, names its guards and returns its effects',
    (_name, expectation) => {
      const context = { ...contextIn(expectation.from), ...expectation.context };
      const result = unitMachine.step({ state: expectation.from, context }, eventFor(expectation));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state).toBe(expectation.to);
      const declared = unitMachine.spec.transitions.find((transition) => transition.from === expectation.from
        && transition.event === expectation.event
        && transition.to === expectation.to
        && transition.guards.join(',') === expectation.guards.join(','));
      expect(declared).toBeDefined();
      expect(declared!.actions).toEqual(expectation.actions);
      // Effects are the declared actions the caller performs; the others are context updates XState applied.
      expect(result.effects).toEqual(expectation.actions.filter((name) => unitMachine.spec.actions[name]!.kind === 'effect'));
      expect(result.transition).toBe(declared!.id);
    },
  );

  test('every transition names its effects and every named effect and guard is used somewhere', () => {
    for (const transition of unitMachine.spec.transitions) {
      expect(transition.id.startsWith('unit/')).toBe(true);
      expect(transition.actions.length).toBeGreaterThan(0);
      for (const guard of transition.guards) expect(unitMachine.spec.guards[guard]?.describe).toBeTruthy();
      for (const action of transition.actions) expect(unitMachine.spec.actions[action]?.describe).toBeTruthy();
    }
    const effects = Object.entries(unitMachine.spec.actions).filter(([, action]) => action.kind === 'effect').map(([name]) => name);
    const used = new Set(unitMachine.spec.transitions.flatMap((transition) => transition.actions));
    expect(effects.filter((name) => !used.has(name))).toEqual([]);
    const guardUse = new Set(unitMachine.spec.transitions.flatMap((transition) => transition.guards));
    expect(Object.keys(unitMachine.spec.guards).filter((name) => !guardUse.has(name))).toEqual([]);
  });

  test('every state and event pair the decision does not allow is refused with a named reason', () => {
    let refused = 0;
    for (const state of UNIT_STATES) {
      for (const event of UNIT_EVENTS) {
        if (UNIT_EXPECTED.some((expectation) => expectation.from === state && expectation.event === event)) continue;
        const result = unitMachine.step({ state, context: contextIn(state) }, { type: event, at: 10 } as UnitEvent);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.refusal.code).toBe('fill-unit/no-transition');
        expect(result.refusal.state).toBe(state);
        expect(result.refusal.event).toBe(event);
        expect(result.refusal.reason).toContain(`state "${state}"`);
        expect(result.refusal.reason).toContain(`event "${event}"`);
        refused++;
      }
    }
    const allowedPairs = new Set(UNIT_EXPECTED.map((expectation) => `${expectation.from}/${expectation.event}`));
    expect(refused).toBe(UNIT_STATES.length * UNIT_EVENTS.length - allowedPairs.size);
  });

  test('a published generation is never cancelled or retried: only stale with a replacement', () => {
    for (const event of [{ type: 'cancel', at: 10, cause: 'stop' }, { type: 'retry', at: 10, generation: 1, cause: 'transient-failure', retryAt: 30 }] as UnitEvent[]) {
      const result = unitMachine.step({ state: 'published', context: { ...contextIn('published'), retriesLeft: 2 } }, event);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.refusal.code).toBe('fill-unit/no-transition');
      expect(result.refusal.reason).toContain('invalidate→stale');
    }
  });
});

describe('unit machine: the properties decision 0027 states in prose', () => {
  test('every live generation can fail, and every state where an attempt ends can fail on its last retry', () => {
    for (const state of LIVE_STATES) {
      const budget = unitMachine.step({ state, context: contextIn(state) }, { type: 'fail', at: 10, generation: 1, fence: tokenIn(contextIn(state)), cause: 'budget-exhausted' });
      expect(budget.ok).toBe(true);
      if (!budget.ok) continue;
      expect(budget.state).toBe('failed');
      expect(budget.effects).toContain('retract-draft');
    }
    for (const state of ATTEMPT_ENDS) {
      const retry = unitMachine.step({ state, context: { ...contextIn(state), retriesLeft: 0 } }, { type: 'retry', at: 10, generation: 1, cause: 'transient-failure', retryAt: 30 });
      expect(retry.ok).toBe(false);
      const failure = unitMachine.step({ state, context: { ...contextIn(state), retriesLeft: 0 } }, { type: 'fail', at: 10, generation: 1, fence: 1, cause: 'retries-exhausted' });
      expect(failure.ok).toBe(true);
      if (!failure.ok) continue;
      expect(failure.state).toBe('failed');
    }
  });

  test('every rerun retracts the draft set the abandoned attempt wrote', () => {
    for (const expectation of UNIT_EXPECTED.filter((entry) => entry.event === 'retry' && entry.to === 'retry_wait')) {
      expect(expectation.actions).toContain('retract-draft');
      const result = unitMachine.step({ state: expectation.from, context: contextIn(expectation.from) }, eventFor(expectation));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.effects).toContain('retract-draft');
    }
  });

  // The decision's own sentences, checked against the table rather than through the expectation list:
  // "an unpublished generation → stale or cancelled ... a published generation stays an immutable record
  // marked stale and linked to its replacement" and "→ failed when budget or retries are exhausted".
  test('every unpublished generation may go stale, be cancelled and fail, and a published one may only go stale', () => {
    const live: readonly UnitState[] = ['planned', 'ready', 'leased', 'running', 'draft', 'validating', 'waiting_children', 'retry_wait', 'blocked'];
    for (const state of live) {
      const leaving = unitMachine.from(state).map((transition) => `${transition.event}→${transition.to}`);
      expect(leaving).toContain('invalidate→stale');
      expect(leaving).toContain('cancel→cancelled');
      expect(leaving).toContain('fail→failed');
    }
    expect(unitMachine.from('published').map((transition) => `${transition.event}→${transition.to}`)).toEqual(['invalidate→stale']);
    for (const terminal of ['failed', 'stale', 'cancelled'] as const) expect(unitMachine.from(terminal)).toEqual([]);
  });

  test('every worker step names its generation as well as its token, and no lease token is reused', () => {
    // `retry` is the orchestrator's own report of a lost lease, so it carries no token; every other step
    // that advances, blocks or ends a generation names both the generation in force and the token it acts
    // under, wherever the unit stands — a revoked lease's token cannot block or fail a later attempt.
    for (const transition of unitMachine.spec.transitions) {
      if (['invalidate', 'cancel'].includes(transition.event)) {
        expect(transition.guards).not.toContain('fence-current');
        continue;
      }
      // `lease` is the store's own issue for the generation in force: `fence-advances` is its rule, and
      // there is no earlier token to name.
      if (transition.event === 'lease') continue;
      expect(transition.guards).toContain('generation-current');
      if (transition.event === 'admit' || transition.event === 'join' || transition.event === 'unblock' || transition.event === 'retry') continue;
      expect(transition.guards).toContain('fence-current');
    }
    for (const transition of unitMachine.spec.transitions) {
      if (transition.event === 'invalidate') {
        expect(transition.guards).toContain('replacement-named');
        expect(unitMachine.spec.guards['replacement-named']!.check({ ...newUnitContext({ generation: 3, retries: 0 }), replacedBy: null }, { type: 'invalidate', at: 1, replacement: 5, cause: 'x' })).toBe(false);
      }
    }
  });

  test('a failed child follows the run\'s resolved policy: propagate fails the parent, block waits, accept partial joins', () => {
    const failedChild: UnitChildOutcome = { unitId: 'child-b', generation: 1, published: false, fresh: false, failed: true };
    const goodChild: UnitChildOutcome = { unitId: 'child-a', generation: 1, published: true, fresh: true, failed: false };
    const joined = unitMachine.step({ state: 'waiting_children', context: contextIn('waiting_children') },
      { type: 'join', at: 10, generation: 1, failedChildPolicy: 'accept-partial', children: [goodChild, failedChild] });
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.transition).toBe('unit/waiting_children--join-accepted-partial-->ready');
    const propagated = unitMachine.step({ state: 'waiting_children', context: contextIn('waiting_children') },
      { type: 'fail', at: 10, generation: 1, fence: 1, cause: 'child-failed' });
    expect(propagated.ok).toBe(true);
    if (!propagated.ok) return;
    expect(propagated.transition).toBe('unit/waiting_children--fail-child-failed-->failed');
    // The block policy is the parent waiting with the child named: an ordinary block.
    const blocked = unitMachine.step({ state: 'waiting_children', context: contextIn('waiting_children') },
      { type: 'block', at: 10, generation: 1, fence: 1, reason: 'child-b failed and the run blocks' });
    expect(blocked.ok).toBe(true);
    // A partial join left for the children's own states: a failed child is never published.
    expect(unitMachine.spec.guards['children-published-and-fresh']!.check(contextIn('waiting_children'),
      { type: 'join', at: 10, generation: 1, failedChildPolicy: 'accept-partial', children: [goodChild, failedChild] })).toBe(false);
  });
});

describe('unit machine: a disallowed step is refused with the guard that refused it', () => {
  const held = (from: UnitState): UnitContext => contextIn(from);
  const refusals: readonly { readonly what: string; readonly state: UnitState; readonly context: UnitContext; readonly event: UnitEvent; readonly guard: string; readonly guards?: readonly string[] }[] = [
    { what: 'a late worker names an older fencing token than the unit holds', state: 'running', context: { ...held('running'), fence: 3 }, event: { type: 'submit-draft', at: 10, generation: 1, fence: 2 }, guard: 'fence-current' },
    { what: 'a late worker names an older token when it starts', state: 'leased', context: { ...held('leased'), fence: 4 }, event: { type: 'start', at: 10, generation: 1, fence: 3 }, guard: 'fence-current' },
    { what: 'a lease does not advance the fencing token', state: 'ready', context: { ...held('ready'), fence: 4 }, event: { type: 'lease', at: 10, fence: 4, attempt: 2 }, guard: 'fence-advances' },
    { what: 'a message from an attempt the unit left cannot block a ready generation', state: 'ready', context: { ...held('ready'), fence: 3 }, event: { type: 'block', at: 10, generation: 1, fence: 2, reason: 'waiting' }, guard: 'fence-current' },
    { what: 'a message from an attempt the unit left cannot block a waiting parent', state: 'waiting_children', context: { ...held('waiting_children'), fence: 3 }, event: { type: 'block', at: 10, generation: 1, fence: 2, reason: 'waiting' }, guard: 'fence-current' },
    { what: 'a message from an attempt the unit left cannot fail a ready generation', state: 'ready', context: { ...held('ready'), fence: 3 }, event: { type: 'fail', at: 10, generation: 1, fence: 2, cause: 'budget-exhausted' }, guard: 'fence-current' },
    { what: 'a message from an attempt the unit left cannot fail a planned generation', state: 'planned', context: { ...held('planned'), fence: 1 }, event: { type: 'fail', at: 10, generation: 1, fence: 0, cause: 'budget-exhausted' }, guard: 'fence-current' },
    { what: 'a message from an attempt the unit left cannot fail a blocked generation', state: 'blocked', context: { ...held('blocked'), fence: 5 }, event: { type: 'fail', at: 10, generation: 1, fence: 4, cause: 'budget-exhausted' }, guard: 'fence-current' },
    { what: 'a worker names a generation that is no longer in force', state: 'running', context: { ...held('running'), generation: 2 }, event: { type: 'submit-draft', at: 10, generation: 1, fence: 1 }, guard: 'generation-current' },
    { what: 'an admit names the generation that was replaced', state: 'planned', context: { ...held('planned'), generation: 2 }, event: { type: 'admit', at: 10, generation: 1 }, guard: 'generation-current' },
    { what: 'a fail names the generation that was replaced', state: 'running', context: { ...held('running'), generation: 2 }, event: { type: 'fail', at: 10, generation: 1, fence: 1, cause: 'budget-exhausted' }, guard: 'generation-current' },
    { what: 'a block names the generation that was replaced', state: 'running', context: { ...held('running'), generation: 2 }, event: { type: 'block', at: 10, generation: 1, fence: 1, reason: 'waiting' }, guard: 'generation-current' },
    { what: 'a join names the generation that was replaced', state: 'waiting_children', context: { ...held('waiting_children'), generation: 2 }, event: { type: 'join', at: 10, generation: 1, failedChildPolicy: 'propagate', children: [{ unitId: 'child-a', generation: 1, published: true, fresh: true, failed: false }] }, guard: 'generation-current' },
    { what: 'an unblock names the generation that was replaced', state: 'blocked', context: { ...held('blocked'), generation: 2 }, event: { type: 'unblock', at: 10, generation: 1, resolution: 'the producer was enabled' }, guard: 'generation-current' },
    { what: 'a retry names the generation that was replaced', state: 'running', context: { ...held('running'), generation: 2 }, event: { type: 'retry', at: 10, generation: 1, cause: 'transient-failure', retryAt: 30 }, guard: 'generation-current' },
    { what: 'the generation has no retry left', state: 'running', context: { ...held('running'), retriesLeft: 0 }, event: { type: 'retry', at: 10, generation: 1, cause: 'transient-failure', retryAt: 30 }, guard: 'retries-remain' },
    { what: 'the retry comes before its time', state: 'retry_wait', context: { ...held('retry_wait'), retryAt: 50 }, event: { type: 'retry', at: 10, generation: 1, cause: 'transient-failure', retryAt: 50 }, guard: 'retry-elapsed' },
    { what: 'a retry names no time to run again', state: 'running', context: held('running'), event: { type: 'retry', at: 10, generation: 1, cause: 'transient-failure', retryAt: null }, guard: 'retry-time-named' },
    { what: 'a retry names a cause the validating state does not retry on', state: 'validating', context: held('validating'), event: { type: 'retry', at: 10, generation: 1, cause: 'lease-expired', retryAt: 30 }, guard: 'cause-validation-problem' },
    { what: 'a running unit names a cause neither retry transition of its state accepts', state: 'running', context: held('running'), event: { type: 'retry', at: 10, generation: 1, cause: 'validation-problem', retryAt: 30 }, guard: 'cause-lease-expired', guards: ['cause-lease-expired', 'cause-transient-failure'] },
    { what: 'a leased unit names a cause neither retry transition of its state accepts', state: 'leased', context: held('leased'), event: { type: 'retry', at: 10, generation: 1, cause: 'validation-problem', retryAt: 30 }, guard: 'cause-lease-expired', guards: ['cause-lease-expired', 'cause-transient-failure'] },
    { what: 'a split seals no child', state: 'running', context: held('running'), event: { type: 'wait-for-children', at: 10, generation: 1, fence: 1, children: [] }, guard: 'children-sealed' },
    { what: 'a child of the split is still unpublished', state: 'waiting_children', context: held('waiting_children'), event: { type: 'join', at: 10, generation: 1, failedChildPolicy: 'propagate', children: [{ unitId: 'child-a', generation: 1, published: false, fresh: true, failed: false }] }, guard: 'children-published-and-fresh' },
    { what: 'a child of the split went stale', state: 'waiting_children', context: held('waiting_children'), event: { type: 'join', at: 10, generation: 1, failedChildPolicy: 'propagate', children: [{ unitId: 'child-a', generation: 1, published: true, fresh: false, failed: false }] }, guard: 'children-published-and-fresh' },
    { what: 'a partial join names an unpublished child that did not fail', state: 'waiting_children', context: held('waiting_children'), event: { type: 'join', at: 10, generation: 1, failedChildPolicy: 'accept-partial', children: [{ unitId: 'child-a', generation: 1, published: false, fresh: true, failed: false }] }, guard: 'children-published-and-fresh', guards: ['children-published-and-fresh', 'children-accepted-partial'] },
    { what: 'a propagated failed child is no partial acceptance', state: 'waiting_children', context: held('waiting_children'), event: { type: 'join', at: 10, generation: 1, failedChildPolicy: 'propagate', children: [{ unitId: 'child-a', generation: 1, published: true, fresh: true, failed: false }, { unitId: 'child-b', generation: 1, published: false, fresh: false, failed: true }] }, guard: 'children-published-and-fresh', guards: ['children-published-and-fresh', 'children-accepted-partial'] },
    { what: 'the reads the generation recorded changed before publication', state: 'validating', context: held('validating'), event: { type: 'publish', at: 10, generation: 1, fence: 1, readsFresh: false }, guard: 'reads-fresh' },
    { what: 'a block names nothing it waits on', state: 'running', context: held('running'), event: { type: 'block', at: 10, generation: 1, fence: 1, reason: '  ' }, guard: 'block-reason-named' },
    { what: 'an unblock names no resolution', state: 'blocked', context: held('blocked'), event: { type: 'unblock', at: 10, generation: 1, resolution: '' }, guard: 'resolution-named' },
    { what: 'an invalidation names no later generation', state: 'published', context: held('published'), event: { type: 'invalidate', at: 10, replacement: 1, cause: 'inputs changed' }, guard: 'replacement-named' },
    { what: 'an invalidation skips the generation in between', state: 'published', context: held('published'), event: { type: 'invalidate', at: 10, replacement: 3, cause: 'inputs changed' }, guard: 'replacement-named' },
    { what: 'a fail reports retries exhausted while retries remain', state: 'retry_wait', context: { ...held('retry_wait'), retriesLeft: 1 }, event: { type: 'fail', at: 10, generation: 1, fence: 1, cause: 'retries-exhausted' }, guard: 'fail-cause' },
    { what: 'a leased unit reports retries exhausted while retries remain', state: 'leased', context: { ...held('leased'), retriesLeft: 3 }, event: { type: 'fail', at: 10, generation: 1, fence: 1, cause: 'retries-exhausted' }, guard: 'fail-cause' },
    { what: 'a waiting parent reports retries exhausted while retries remain', state: 'waiting_children', context: { ...held('waiting_children'), retriesLeft: 2 }, event: { type: 'fail', at: 10, generation: 1, fence: 1, cause: 'retries-exhausted' }, guard: 'fail-cause', guards: ['fail-cause', 'cause-child-failed'] },
  ];

  test.each(refusals.map((refusal) => [refusal.what, refusal] as const))('refused: %s', (_what, refusal) => {
    const result = unitMachine.step({ state: refusal.state, context: refusal.context }, refusal.event);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('fill-unit/guard-refused');
    expect(result.refusal.guard).toBe(refusal.guard);
    expect(result.refusal.reason).toContain(`guard "${refusal.guard}"`);
    expect(result.refusal.reason).toContain(unitMachine.spec.guards[refusal.guard]!.describe);
    expect(result.refusal.state).toBe(refusal.state);
    for (const guard of refusal.guards ?? [refusal.guard]) expect(result.refusal.guards).toContain(guard);
  });

  test('every declared guard has at least one refusal above that names it', () => {
    const named = new Set(refusals.flatMap((refusal) => [refusal.guard, ...(refusal.guards ?? [])]));
    const unexercised = Object.keys(unitMachine.spec.guards).filter((guard) => !named.has(guard));
    expect(unexercised).toEqual([]);
  });

  test('a state the machine does not declare is refused by name', () => {
    const result = unitMachine.step({ state: 'zombie' as UnitState, context: newUnitContext({ generation: 1, retries: 1 }) }, { type: 'admit', at: 1, generation: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('fill-unit/unknown-state');
    expect(result.refusal.reason).toContain('"zombie" is not a state of this machine');
  });

  test('a refused step leaves the state and the context exactly as they were', () => {
    const context = { ...contextIn('running'), fence: 3 };
    const result = unitMachine.step({ state: 'running', context }, { type: 'submit-draft', at: 10, generation: 1, fence: 2 });
    expect(result.ok).toBe(false);
    expect(context.fence).toBe(3);
    expect(unitMachine.step({ state: 'running', context }, { type: 'submit-draft', at: 10, generation: 1, fence: 3 }).ok).toBe(true);
  });
});

describe('unit machine: the named context updates', () => {
  test('a lease records its fencing token and attempt number', () => {
    const result = unitMachine.step({ state: 'ready', context: { ...contextIn('ready'), fence: 0, attempt: 0 } }, { type: 'lease', at: 10, fence: 1, attempt: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.fence).toBe(1);
    expect(result.context.attempt).toBe(1);
  });

  test('a retry spends one retry and records the moment it may run again', () => {
    const result = unitMachine.step({ state: 'running', context: contextIn('running') }, { type: 'retry', at: 10, generation: 1, cause: 'transient-failure', retryAt: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.retriesLeft).toBe(1);
    expect(result.context.retryAt).toBe(30);
  });

  test('a retry that comes due clears the retry time', () => {
    const result = unitMachine.step({ state: 'retry_wait', context: contextIn('retry_wait') }, { type: 'retry', at: 10, generation: 1, cause: 'transient-failure', retryAt: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.retryAt).toBeNull();
    expect(result.context.retriesLeft).toBe(2);
  });

  test('a replacement generation keeps a fencing floor, so a token is never reused by the unit', () => {
    const next = newUnitContext({ generation: 2, retries: 2, fence: 7 });
    expect(next.fence).toBe(7);
    const refused = unitMachine.step({ state: 'ready', context: next }, { type: 'lease', at: 10, fence: 7, attempt: 1 });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.guard).toBe('fence-advances');
    expect(unitMachine.step({ state: 'ready', context: next }, { type: 'lease', at: 10, fence: 8, attempt: 1 }).ok).toBe(true);
  });

  test('an invalidation links the replacement generation', () => {
    const result = unitMachine.step({ state: 'published', context: contextIn('published') }, { type: 'invalidate', at: 10, replacement: 2, cause: 'inputs changed' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.replacedBy).toBe(2);
  });
});

/** The run transitions decision 0027 allows, written from the decision. */
interface RunExpectation {
  readonly from: RunState;
  readonly event: RunEvent['type'];
  readonly to: RunState;
  readonly guards: readonly string[];
  readonly actions: readonly string[];
}

const RUN_EXPECTED: readonly RunExpectation[] = [
  { from: 'created', event: 'plan', to: 'planning', guards: ['configuration-resolved'], actions: ['snapshot-configuration', 'emit-progress'] },
  { from: 'planning', event: 'start', to: 'running', guards: ['stage-graph-resolved'], actions: ['close-planning-epoch', 'bump-planning-epoch', 'enqueue-stages', 'emit-progress'] },
  { from: 'planning', event: 'block', to: 'blocked', guards: ['starvation-path-named'], actions: ['record-starvation', 'emit-progress'] },
  { from: 'planning', event: 'fail', to: 'failed', guards: ['cause-budget-exhausted'], actions: ['record-failure', 'emit-progress'] },
  { from: 'running', event: 'complete', to: 'succeeded', guards: ['planning-closed', 'nothing-runnable-in-flight-or-waiting', 'required-coverage-met', 'no-pending-publication'], actions: ['record-completion', 'emit-progress'] },
  { from: 'running', event: 'complete-partial', to: 'completed_partial', guards: ['planning-closed', 'nothing-runnable-in-flight-or-waiting', 'no-pending-publication', 'required-coverage-unmet'], actions: ['record-partial-completion', 'emit-progress'] },
  { from: 'running', event: 'block', to: 'blocked', guards: ['starvation-path-named'], actions: ['record-starvation', 'emit-progress'] },
  { from: 'running', event: 'fail', to: 'failed', guards: ['cause-budget-exhausted'], actions: ['record-failure', 'emit-progress'] },
  { from: 'running', event: 'pause', to: 'pausing', guards: [], actions: ['record-pause-intent', 'emit-progress'] },
  { from: 'pausing', event: 'drain', to: 'paused', guards: ['nothing-in-flight-or-waiting'], actions: ['record-paused', 'emit-progress'] },
  { from: 'paused', event: 'resume', to: 'planning', guards: [], actions: ['reopen-planning-epoch', 'emit-progress'] },
  ...(['created', 'planning', 'running', 'pausing', 'paused'] as const).map((from): RunExpectation => ({
    from, event: 'cancel', to: 'cancelling', guards: [], actions: ['revoke-run-authority', 'record-cancel-intent', 'emit-progress'],
  })),
  { from: 'cancelling', event: 'drained', to: 'cancelled', guards: ['nothing-runnable-in-flight-or-waiting', 'no-pending-publication'], actions: ['record-cancelled', 'emit-progress'] },
];

const RUN_EVENTS: readonly RunEvent['type'][] = ['plan', 'start', 'complete', 'complete-partial', 'block', 'fail', 'pause', 'drain', 'resume', 'cancel', 'drained'];

const settled: RunEvidence = { runnable: 0, inFlight: 0, waiting: 0, coverageMet: true, pendingPublications: 0 };

function runContextIn(from: RunState): RunContext {
  return { planningEpoch: 1, planningClosed: from !== 'created' && from !== 'planning' };
}

function runEventFor(expectation: RunExpectation): RunEvent {
  const at = 10;
  switch (expectation.event) {
    case 'plan': return { type: 'plan', at, configuration: 'sha256:configuration' };
    case 'start': return { type: 'start', at, stages: 3 };
    case 'complete': return { type: 'complete', at, evidence: settled };
    case 'complete-partial': return { type: 'complete-partial', at, evidence: { ...settled, coverageMet: false } };
    case 'block': return { type: 'block', at, starvationPath: 'synthesis → claims → inventory (disabled)' };
    case 'fail': return { type: 'fail', at, cause: 'budget-exhausted', detail: 'the run spent its token budget' };
    case 'pause': return { type: 'pause', at };
    case 'drain': return { type: 'drain', at, evidence: settled };
    case 'resume': return { type: 'resume', at };
    case 'cancel': return { type: 'cancel', at, cause: 'the person stopped the run' };
    case 'drained': return { type: 'drained', at, evidence: settled };
  }
}

describe('run machine: every allowed transition, from decision 0027', () => {
  test('the table holds exactly the transitions the decision allows', () => {
    const declared = runMachine.spec.transitions.map((transition) => descriptor(transition.from, transition.event, transition.to)).sort();
    const expected = RUN_EXPECTED.map((expectation) => descriptor(expectation.from, expectation.event, expectation.to)).sort();
    expect(declared).toEqual(expected);
    const ids = runMachine.spec.transitions.map((transition) => transition.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.each(RUN_EXPECTED.map((expectation) => [descriptor(expectation.from, expectation.event, expectation.to), expectation] as const))(
    '%s is allowed, names its guards and returns its effects',
    (_name, expectation) => {
      const result = runMachine.step({ state: expectation.from, context: runContextIn(expectation.from) }, runEventFor(expectation));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state).toBe(expectation.to);
      const declared = runMachine.spec.transitions.find((transition) => transition.from === expectation.from
        && transition.event === expectation.event && transition.to === expectation.to);
      expect(declared?.guards).toEqual(expectation.guards);
      expect(declared?.actions).toEqual(expectation.actions);
      expect(result.effects).toEqual(expectation.actions.filter((name) => runMachine.spec.actions[name]!.kind === 'effect'));
    },
  );

  test('every state and event pair the decision does not allow is refused with a named reason', () => {
    let refused = 0;
    for (const state of RUN_STATES) {
      for (const event of RUN_EVENTS) {
        if (RUN_EXPECTED.some((expectation) => expectation.from === state && expectation.event === event)) continue;
        const result = runMachine.step({ state, context: runContextIn(state) }, { type: event, at: 10 } as RunEvent);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.refusal.code).toBe('fill-run/no-transition');
        expect(result.refusal.reason).toContain(`state "${state}"`);
        expect(result.refusal.reason).toContain(`event "${event}"`);
        refused++;
      }
    }
    const allowedPairs = new Set(RUN_EXPECTED.map((expectation) => `${expectation.from}/${expectation.event}`));
    expect(refused).toBe(RUN_STATES.length * RUN_EVENTS.length - allowedPairs.size);
  });

  test('an ended run cannot be cancelled: succeeded, completed_partial, blocked, failed and cancelled are terminal', () => {
    for (const state of ['succeeded', 'completed_partial', 'blocked', 'failed', 'cancelled'] as const) {
      const result = runMachine.step({ state, context: runContextIn(state) }, { type: 'cancel', at: 10, cause: 'stop' });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.refusal.code).toBe('fill-run/no-transition');
      expect(result.refusal.reason).toContain('terminal');
    }
  });

  test('a plan that resolves no stage records its starvation path, and a spent budget fails the run while planning', () => {
    const zeroStages = runMachine.step({ state: 'planning', context: runContextIn('planning') }, { type: 'start', at: 10, stages: 0 });
    expect(zeroStages.ok).toBe(false);
    if (zeroStages.ok) return;
    expect(zeroStages.refusal.guard).toBe('stage-graph-resolved');
    const blocked = runMachine.step({ state: 'planning', context: runContextIn('planning') }, { type: 'block', at: 10, starvationPath: 'synthesis → claims → inventory (disabled)' });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(blocked.state).toBe('blocked');
    expect(blocked.effects).toEqual(['record-starvation', 'emit-progress']);
    const failed = runMachine.step({ state: 'planning', context: runContextIn('planning') }, { type: 'fail', at: 10, cause: 'budget-exhausted', detail: 'spent' });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.state).toBe('failed');
  });

  test('a block without a starvation path is refused at planning and while running', () => {
    for (const state of ['planning', 'running'] as const) {
      const result = runMachine.step({ state, context: runContextIn(state) }, { type: 'block', at: 10, starvationPath: ' ' });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.refusal.guard).toBe('starvation-path-named');
    }
  });

  test('completion names every criterion the decision requires, and each one alone refuses it', () => {
    const criteria: readonly { readonly context: RunContext; readonly event: RunEvent; readonly guard: string }[] = [
      { context: { planningEpoch: 1, planningClosed: false }, event: { type: 'complete', at: 10, evidence: settled }, guard: 'planning-closed' },
      { context: runContextIn('running'), event: { type: 'complete', at: 10, evidence: { ...settled, runnable: 1 } }, guard: 'nothing-runnable-in-flight-or-waiting' },
      { context: runContextIn('running'), event: { type: 'complete', at: 10, evidence: { ...settled, inFlight: 1 } }, guard: 'nothing-runnable-in-flight-or-waiting' },
      { context: runContextIn('running'), event: { type: 'complete', at: 10, evidence: { ...settled, waiting: 1 } }, guard: 'nothing-runnable-in-flight-or-waiting' },
      { context: runContextIn('running'), event: { type: 'complete', at: 10, evidence: { ...settled, coverageMet: false } }, guard: 'required-coverage-met' },
      { context: runContextIn('running'), event: { type: 'complete', at: 10, evidence: { ...settled, pendingPublications: 1 } }, guard: 'no-pending-publication' },
    ];
    for (const criterion of criteria) {
      const result = runMachine.step({ state: 'running', context: criterion.context }, criterion.event);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.refusal.code).toBe('fill-run/guard-refused');
      expect(result.refusal.guard).toBe(criterion.guard);
      expect(result.refusal.reason).toContain(`guard "${criterion.guard}"`);
    }
  });
});

describe('chain machine: idle → active → quiescent, from decision 0027', () => {
  const evidence = { runnable: 0, inFlight: 0, waiting: 0, pendingPublications: 0 };

  test('the table holds exactly the three transitions the decision names', () => {
    expect(chainMachine.spec.transitions.map((transition) => descriptor(transition.from, transition.event, transition.to)))
      .toEqual(['idle --start--> active', 'active --settle--> quiescent', 'quiescent --wake--> active']);
  });

  test('a run starts the chain and the chain becomes active', () => {
    const result = chainMachine.step({ state: 'idle', context: newChainContext() }, { type: 'start', at: 10, runId: 'run-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe('active');
    expect(result.context.activeRunId).toBe('run-1');
    expect(result.effects).toEqual(['emit-progress']);
  });

  test('a chain settles only when nothing is outstanding', () => {
    const running = chainMachine.step({ state: 'idle', context: newChainContext() }, { type: 'start', at: 10, runId: 'run-1' });
    expect(running.ok).toBe(true);
    if (!running.ok) return;
    const busy = chainMachine.step({ state: running.state, context: running.context }, { type: 'settle', at: 11, evidence: { ...evidence, inFlight: 1 } });
    expect(busy.ok).toBe(false);
    if (busy.ok) return;
    expect(busy.refusal.code).toBe('fill-chain/guard-refused');
    expect(busy.refusal.guard).toBe('nothing-outstanding');
    const settled = chainMachine.step({ state: running.state, context: running.context }, { type: 'settle', at: 12, evidence });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.state).toBe('quiescent');
    expect(settled.context.activeRunId).toBeNull();
  });

  test('a quiescent chain wakes for the next run', () => {
    const result = chainMachine.step({ state: 'quiescent', context: newChainContext() }, { type: 'wake', at: 10, runId: 'run-2' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe('active');
    expect(result.context.activeRunId).toBe('run-2');
  });

  test('every other state and event pair is refused with a named reason', () => {
    let refused = 0;
    for (const state of CHAIN_STATES) {
      for (const event of ['start', 'settle', 'wake'] as const) {
        const named = (state === 'idle' && event === 'start') || (state === 'active' && event === 'settle') || (state === 'quiescent' && event === 'wake');
        if (named) continue;
        const step = chainMachine.step({ state, context: newChainContext() }, { type: event, at: 10, runId: 'run-1', evidence } as ChainEvent);
        expect(step.ok).toBe(false);
        if (step.ok) continue;
        expect(step.refusal.code).toBe('fill-chain/no-transition');
        refused++;
      }
    }
    expect(refused).toBe(CHAIN_STATES.length * 3 - 3);
  });

  test('a chain never leaves the work it followed without a run named', () => {
    const result: { ok: boolean; refusal?: { guard: string | null } } = chainMachine.step({ state: 'idle', context: newChainContext() }, { type: 'start', at: 10, runId: ' ' }) as never;
    expect(result.ok).toBe(false);
    expect(result.refusal?.guard).toBe('run-named');
  });
});

describe('the module doc comment carries the unit machine\'s diagram', () => {
  test('the Mermaid stateDiagram in src/fill/fsm.ts is exactly what the table renders', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/fill/fsm.ts', import.meta.url)), 'utf8');
    const block = /```mermaid\n([\s\S]*?)```/.exec(source);
    expect(block).not.toBeNull();
    const diagram = block![1]!.split('\n').map((line) => line.replace(/^\s*\* ?/, '')).join('\n').trim();
    expect(diagram).toBe(unitMachine.mermaid());
  });
});

describe('a table that cannot be built is refused with the file, line and path it was declared at', () => {
  const base = (): MachineSpec<UnitState, UnitEvent, UnitContext> => ({
    id: 'fill-probe',
    initial: 'planned',
    states: ['planned', 'ready'],
    transitions: [{ id: 'probe/planned--admit-->ready', from: 'planned', event: 'admit', to: 'ready', guards: [], actions: ['emit-progress'] }],
    guards: {},
    actions: { 'emit-progress': { kind: 'effect', describe: 'progress' } },
  });

  test('an undeclared guard is named with the module path and the throwing line', () => {
    const spec = base();
    const broken = { ...spec, transitions: [{ ...spec.transitions[0]!, guards: ['ghost-guard'] }] } as MachineSpec<UnitState, UnitEvent, UnitContext>;
    let error: Error | undefined;
    try {
      createFillMachine(broken);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).toContain('names guard "ghost-guard"');
    expect(error!.message).toContain('table entry 1');
    expect(error!.message).toMatch(/src\/fill\/fsm-core\.ts:\d+:\d+:/);
    expect(error!.message.startsWith(fileURLToPath(new URL('../src/fill/fsm-core.ts', import.meta.url)))).toBe(true);
  });

  test('an undeclared action, a repeat and an unreachable state are refused too', () => {
    const spec = base();
    const badAction = { ...spec, transitions: [{ ...spec.transitions[0]!, actions: ['ghost-effect'] }] } as MachineSpec<UnitState, UnitEvent, UnitContext>;
    const repeated = { ...spec, states: ['planned', 'planned'] } as unknown as MachineSpec<UnitState, UnitEvent, UnitContext>;
    const unreachable = { ...spec, states: ['planned', 'ready', 'orphan'] } as MachineSpec<UnitState, UnitEvent, UnitContext>;
    expect(() => createFillMachine(badAction)).toThrow(/names action "ghost-effect"/);
    expect(() => createFillMachine(repeated)).toThrow(/declares state "planned" twice/);
    expect(() => createFillMachine(unreachable)).toThrow(/states no transition reaches: orphan/);
  });
});
