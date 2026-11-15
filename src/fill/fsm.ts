/**
 * The fill's state machines (decision 0027, as decision 0039 item 12 amends it):
 * a unit's generations, a run, and the chain of runs per product. Pure
 * transitions only — the tables below are the whole of what each machine allows,
 * XState performs every step, and persistence is `state-store.ts`.
 *
 * A unit has a logical identity and immutable generations (a new input set opens a
 * new generation). A generation's attempts are the queue's: the unit is a pg-boss
 * job (0039 item 12), its claim is the lock on one attempt, its expiry the bound
 * of that attempt and its retry allowance the number of attempts the generation
 * may spend. So the machine records which attempt the unit stands in
 * (`context.attempt`, the job's own number) and nothing about leases or fencing
 * tokens: a claim the queue hands out again is a later attempt, and a step that
 * names an attempt the generation already passed is refused. A published
 * generation stays an immutable record: it is never retried or cancelled, only
 * marked stale and linked to its replacement. There is no draft and no validation
 * state (0039 item 13): a unit's writes go through the one writer while it runs,
 * accepted or refused at once, and a generation that fails leaves what it wrote
 * visible.
 *
 * ```mermaid
stateDiagram-v2
  [*] --> planned
  blocked --> cancelled: cancel
  blocked --> failed: fail [generation-current & fail-cause]
  blocked --> stale: invalidate [replacement-named]
  blocked --> skipped: skip [skip-cause-named]
  blocked --> ready: unblock [generation-current & resolution-named]
  planned --> ready: admit [generation-current]
  planned --> cancelled: cancel
  planned --> failed: fail [generation-current & fail-cause]
  planned --> stale: invalidate [replacement-named]
  planned --> skipped: skip [skip-cause-named]
  published --> stale: invalidate [replacement-named]
  ready --> blocked: block [generation-current & block-reason-named]
  ready --> cancelled: cancel
  ready --> failed: fail [generation-current & fail-cause]
  ready --> stale: invalidate [replacement-named]
  ready --> skipped: skip [skip-cause-named]
  ready --> running: start [generation-current & attempt-advances]
  retry_wait --> cancelled: cancel
  retry_wait --> failed: fail [generation-current & fail-cause]
  retry_wait --> stale: invalidate [replacement-named]
  retry_wait --> skipped: skip [skip-cause-named]
  retry_wait --> running: start [generation-current & attempt-advances]
  running --> blocked: block [generation-current & block-reason-named]
  running --> cancelled: cancel
  running --> failed: fail [generation-current & fail-cause]
  running --> stale: invalidate [replacement-named]
  running --> published: publish [generation-current]
  running --> retry_wait: retry [generation-current & retry-time-named & cause-transient-failure]
  running --> retry_wait: retry [generation-current & retry-time-named & cause-validation-problem]
  running --> skipped: skip [skip-cause-named]
  running --> running: start [generation-current & attempt-advances]
  running --> waiting_children: wait-for-children [generation-current & children-sealed]
  waiting_children --> blocked: block [generation-current & block-reason-named]
  waiting_children --> cancelled: cancel
  waiting_children --> failed: fail [generation-current & fail-cause]
  waiting_children --> failed: fail [generation-current & cause-child-failed]
  waiting_children --> stale: invalidate [replacement-named]
  waiting_children --> ready: join [generation-current & children-accepted-partial]
  waiting_children --> ready: join [generation-current & children-published-and-fresh]
  waiting_children --> skipped: skip [skip-cause-named]
  cancelled --> [*]
  failed --> [*]
  skipped --> [*]
  stale --> [*]
```
 *
 * The run machine walks created → planning → running → succeeded,
 * completed_partial, blocked or failed, pauses through pausing → paused →
 * planning, and cancels through cancelling → cancelled from any non-terminal
 * state. The chain of runs per product walks idle → active → quiescent, and a
 * quiescent chain wakes to active for the next run; nothing returns it to idle,
 * which is a chain that never ran.
 * `state-store.ts` persists all three; their diagrams render from the same
 * tables (see `unitMachine.mermaid()`, `runMachine.mermaid()`,
 * `chainMachine.mermaid()`).
 */
import type { MachineSpec, TransitionSpec } from './fsm-core.js';
import { createFillMachine, transition } from './fsm-core.js';
import type { ProducerOutcomeDraft } from './producer-outcomes.js';

// ---------------------------------------------------------------------------------------------
// Unit machine
// ---------------------------------------------------------------------------------------------

/** The states of a unit generation, in the order decision 0027 lists them without the lease, draft and validation states 0039 removed. */
export const UNIT_STATES = [
  'planned', 'ready', 'running', 'published', 'waiting_children', 'retry_wait', 'blocked',
  'failed', 'stale', 'cancelled', 'skipped',
] as const;
export type UnitState = typeof UNIT_STATES[number];

/** What a unit generation carries in the database besides its state name. */
export interface UnitContext {
  /** The generation this row is; a new input set opens the next generation of the same unit. */
  readonly generation: number;
  /** The attempt the unit stands in, as the queue numbers it: the first attempt is 1, and its job's `retryCount` is one less. */
  readonly attempt: number;
  /** Epoch milliseconds the queue will hand the job out again, while the unit waits on a retry; null when it is not waiting. */
  readonly retryAt: number | null;
  /** The generation that replaces this one once it went stale; null while it stands. */
  readonly replacedBy: number | null;
  /** Why the run skipped this generation, when it ended without the generation finishing. */
  readonly skippedBecause?: string | null;
  /** What the producer answered of its kind, recorded by the generation that published it (0039 item 11). */
  readonly unitOutcome?: ProducerOutcomeDraft | null;
}

/** What a unit failed on: its budget, the queue's retries, a child whose failure the policy propagates, or an answer the writer refused. */
export type UnitFailCause = 'budget-exhausted' | 'retries-exhausted' | 'child-failed' | 'answer-refused';

/** What sent a unit back to a retry wait. */
export type UnitRetryCause = 'transient-failure' | 'validation-problem';

/** One child of a split, as the parent's join judges it. */
export interface UnitChildOutcome {
  readonly unitId: string;
  readonly generation: number;
  /** True when the child's generation was published. */
  readonly published: boolean;
  /** True when nothing the child read has changed since it published. */
  readonly fresh: boolean;
  /** True when the child ended failed or cancelled, so it will never publish. */
  readonly failed: boolean;
}

/**
 * What a waiting parent does with a child that ended failed, from the run's
 * resolved configuration (decision 0027: "an explicit policy for a failed child
 * (propagate, block, accept partial)").
 */
export type UnitFailedChildPolicy = 'propagate' | 'block' | 'accept-partial';

/**
 * A step a caller asks of a unit generation. Every step names the generation in
 * force, so a message for a superseded generation is refused; an attempt's step
 * names the attempt it runs under, so a claim the queue handed out again is a
 * later attempt and not a second step of the same one. `invalidate` and `cancel`
 * name no attempt: they are the run control's authority over whatever generation
 * stands.
 */
export type UnitEvent =
  | { readonly type: 'admit'; readonly at: number; readonly generation: number }
  | { readonly type: 'start'; readonly at: number; readonly generation: number; readonly attempt: number }
  | { readonly type: 'publish'; readonly at: number; readonly generation: number; readonly outcome: ProducerOutcomeDraft | null }
  | { readonly type: 'wait-for-children'; readonly at: number; readonly generation: number; readonly children: readonly UnitChildOutcome[] }
  | { readonly type: 'join'; readonly at: number; readonly generation: number; readonly children: readonly UnitChildOutcome[]; readonly failedChildPolicy: UnitFailedChildPolicy }
  | { readonly type: 'retry'; readonly at: number; readonly generation: number; readonly cause: UnitRetryCause; readonly retryAt: number | null }
  | { readonly type: 'block'; readonly at: number; readonly generation: number; readonly reason: string }
  | { readonly type: 'unblock'; readonly at: number; readonly generation: number; readonly resolution: string }
  | { readonly type: 'fail'; readonly at: number; readonly generation: number; readonly cause: UnitFailCause }
  | { readonly type: 'invalidate'; readonly at: number; readonly replacement: number; readonly cause: string }
  | { readonly type: 'cancel'; readonly at: number; readonly cause: string }
  | { readonly type: 'skip'; readonly at: number; readonly cause: string };

/** Every unit step; the store takes each of them through `advanceUnit`. */
export type UnitAdvanceEvent = UnitEvent;

const named = (value: string): boolean => value.trim() !== '';

/** Every unit guard, named and pure: it reads the persisted generation and the event, nothing else. */
const unitGuards: MachineSpec<UnitState, UnitEvent, UnitContext>['guards'] = {
  'attempt-advances': {
    describe: 'the attempt the queue hands this unit out as is later than the one the generation stands in',
    check: (context, event) => event.type === 'start' && event.attempt > context.attempt,
  },
  'generation-current': {
    describe: 'the step names the generation in force, so a message for a superseded generation is refused',
    check: (context, event) => 'generation' in event && event.generation === context.generation,
  },
  'retry-time-named': {
    describe: 'the retry names the moment the queue will hand the unit out again',
    check: (_context, event) => event.type === 'retry' && event.retryAt !== null,
  },
  'cause-transient-failure': {
    describe: 'the attempt failed transiently',
    check: (_context, event) => event.type === 'retry' && event.cause === 'transient-failure',
  },
  'cause-validation-problem': {
    describe: 'the attempt ended with a problem the unit may fix in another attempt',
    check: (_context, event) => event.type === 'retry' && event.cause === 'validation-problem',
  },
  'fail-cause': {
    describe: 'the step fails the unit for the run\'s spent budget, because the queue has no attempt left, or because the writer refused its answer',
    check: (_context, event) => event.type === 'fail' && (event.cause === 'budget-exhausted' || event.cause === 'retries-exhausted' || event.cause === 'answer-refused'),
  },
  'cause-child-failed': {
    describe: 'a child the run resolves as propagated ended failed, so the waiting parent fails with it',
    check: (_context, event) => event.type === 'fail' && event.cause === 'child-failed',
  },
  'children-sealed': {
    describe: 'the split sealed at least one child generation',
    check: (_context, event) => event.type === 'wait-for-children' && event.children.length > 0
      && event.children.every((child) => child.unitId.trim() !== '' && child.generation > 0),
  },
  'children-published-and-fresh': {
    describe: 'every child generation of the split is published and still fresh',
    check: (_context, event) => event.type === 'join' && event.children.length > 0
      && event.children.every((child) => child.published && child.fresh),
  },
  'children-accepted-partial': {
    describe: 'the run resolves a failed child as accepted partial, every other child generation is published and still fresh, and at least one child did fail',
    check: (_context, event) => event.type === 'join' && event.failedChildPolicy === 'accept-partial'
      && event.children.length > 0
      && event.children.some((child) => child.failed)
      && event.children.every((child) => child.failed || (child.published && child.fresh)),
  },
  'block-reason-named': {
    describe: 'the block names what it waits on',
    check: (_context, event) => event.type === 'block' && named(event.reason),
  },
  'resolution-named': {
    describe: 'the resolution that unblocks the unit is named',
    check: (_context, event) => event.type === 'unblock' && named(event.resolution),
  },
  'replacement-named': {
    describe: 'the replacement generation is the next one after this generation',
    check: (context, event) => event.type === 'invalidate' && event.replacement === context.generation + 1,
  },
  'skip-cause-named': {
    describe: 'the run names the failed unit or the ending that leaves this generation skipped',
    check: (_context, event) => event.type === 'skip' && named(event.cause),
  },
};

const retryActions = ['wait-for-retry', 'schedule-retry', 'emit-progress'] as const;
const failFenced = ['revoke-authority', 'emit-progress'] as const;
const failActions = ['emit-progress'] as const;
const blockActions = ['emit-progress'] as const;
const invalidateActions = ['link-replacement', 'emit-progress'] as const;
const cancelActions = ['revoke-authority', 'emit-progress'] as const;

/** Every unit action, named: context updates XState applies, then effects the orchestrator performs. */
const unitActions: MachineSpec<UnitState, UnitEvent, UnitContext>['actions'] = {
  'record-attempt': {
    kind: 'context',
    describe: 'records the attempt the queue handed the unit out as',
    apply: (context, event) => (event.type === 'start' ? { ...context, attempt: event.attempt } : context),
  },
  'wait-for-retry': {
    kind: 'context',
    describe: 'records the moment the queue will hand the unit out again',
    apply: (context, event) => ({ ...context, retryAt: event.type === 'retry' ? event.retryAt : context.retryAt }),
  },
  'clear-retry': {
    kind: 'context',
    describe: 'clears the retry time an earlier attempt set',
    apply: (context) => ({ ...context, retryAt: null }),
  },
  'link-replacement': {
    kind: 'context',
    describe: 'links this generation to the one that replaces it',
    apply: (context, event) => ({ ...context, replacedBy: event.type === 'invalidate' ? event.replacement : context.replacedBy }),
  },
  'record-skip': {
    kind: 'context',
    describe: 'records why the run skipped this generation',
    apply: (context, event) => ({ ...context, skippedBecause: event.type === 'skip' ? event.cause : context.skippedBecause ?? null }),
  },
  'record-outcome': {
    kind: 'context',
    describe: 'records what the producer answered of its kind, with the generation that answered it',
    apply: (context, event) => (event.type === 'publish' ? { ...context, unitOutcome: event.outcome } : context),
  },
  'enqueue-ready': {
    kind: 'effect',
    describe: 'the orchestrator makes the generation runnable on the queue',
  },
  'schedule-retry': {
    kind: 'effect',
    describe: 'the orchestrator asks the queue to hand the job out again after its retry delay',
  },
  'suspend-parent': {
    kind: 'effect',
    describe: 'the orchestrator settles the parent\'s job while its children run',
  },
  'resume-join': {
    kind: 'effect',
    describe: 'the orchestrator re-enqueues the parent\'s join',
  },
  'record-publication': {
    kind: 'effect',
    describe: 'the database owner writes the one publication record of this generation',
  },
  'revoke-authority': {
    kind: 'effect',
    describe: 'the orchestrator aborts the unit\'s agent and tool sessions',
  },
  'record-resolution': {
    kind: 'effect',
    describe: 'the orchestrator records the explicit resolution that unblocked the generation',
  },
  'emit-progress': {
    kind: 'effect',
    describe: 'the orchestrator emits the durable progress event a watching person sees',
  },
};

/** Every state a generation is live in: each may go stale, each may fail, and each may be cancelled. */
const LIVE_UNIT_STATES = ['planned', 'ready', 'running', 'waiting_children', 'retry_wait', 'blocked'] as const;

/** One line of the unit table, with its id built from its machine, states and event. */
const unitTransition = (
  from: UnitState,
  event: UnitEvent['type'],
  to: UnitState,
  entry: { readonly guards?: readonly string[]; readonly actions: readonly string[]; readonly label?: string },
): TransitionSpec<UnitState, UnitEvent> => transition<UnitState, UnitEvent>('unit', from, event, to, entry);

/**
 * Every transition a unit generation allows, and nothing else: the states absent
 * from a line here are the ones refused. `published`, `failed`, `stale` and
 * `cancelled` leave the table never: a published generation only goes stale with
 * a replacement, and stale work continues in its replacement generation.
 *
 * A generation fails for each cause the decision names: when the run's budget is
 * spent, from every live state; when the queue hands the job out no more, from the
 * states an attempt can end in; and when a child the run resolves as propagated
 * fails, from the state whose join was waiting for it.
 */
const unitTransitions: MachineSpec<UnitState, UnitEvent, UnitContext>['transitions'] = [
  unitTransition('planned', 'admit', 'ready', { guards: ['generation-current'], actions: ['enqueue-ready', 'emit-progress'] }),
  // The queue's claim is the unit's lock (0039 item 12): the attempt it hands out is the attempt the
  // generation records, and a claim handed out again is a later attempt of the same generation.
  unitTransition('ready', 'start', 'running', { guards: ['generation-current', 'attempt-advances'], actions: ['record-attempt', 'emit-progress'] }),
  unitTransition('running', 'start', 'running', { label: 'another-attempt', guards: ['generation-current', 'attempt-advances'], actions: ['record-attempt', 'emit-progress'] }),
  unitTransition('retry_wait', 'start', 'running', { guards: ['generation-current', 'attempt-advances'], actions: ['record-attempt', 'clear-retry', 'emit-progress'] }),
  // A unit's writes went through the one writer while it ran (0039 item 13); publishing the generation
  // records what it answered and that it is complete.
  unitTransition('running', 'publish', 'published', { guards: ['generation-current'], actions: ['record-outcome', 'record-publication', 'emit-progress'] }),
  unitTransition('running', 'wait-for-children', 'waiting_children', { guards: ['generation-current', 'children-sealed'], actions: ['suspend-parent', 'emit-progress'] }),
  // The join under the run's resolved policy for a failed child: every child published and fresh, or
  // the failed ones accepted as partial. A propagated failure fails the parent itself, below.
  unitTransition('waiting_children', 'join', 'ready', { label: 'all-published', guards: ['generation-current', 'children-published-and-fresh'], actions: ['resume-join', 'enqueue-ready', 'emit-progress'] }),
  unitTransition('waiting_children', 'join', 'ready', { label: 'accepted-partial', guards: ['generation-current', 'children-accepted-partial'], actions: ['resume-join', 'enqueue-ready', 'emit-progress'] }),
  // An attempt that ends short of its answer asks the queue for the generation's next attempt; the
  // queue's own retry allowance decides whether there is one, and the failure below is what a spent one
  // takes.
  unitTransition('running', 'retry', 'retry_wait', { label: 'transient-failure', guards: ['generation-current', 'retry-time-named', 'cause-transient-failure'], actions: retryActions }),
  unitTransition('running', 'retry', 'retry_wait', { label: 'validation-problem', guards: ['generation-current', 'retry-time-named', 'cause-validation-problem'], actions: retryActions }),
  unitTransition('ready', 'block', 'blocked', { guards: ['generation-current', 'block-reason-named'], actions: blockActions }),
  unitTransition('running', 'block', 'blocked', { guards: ['generation-current', 'block-reason-named'], actions: blockActions }),
  unitTransition('waiting_children', 'block', 'blocked', { guards: ['generation-current', 'block-reason-named'], actions: blockActions }),
  unitTransition('blocked', 'unblock', 'ready', { guards: ['generation-current', 'resolution-named'], actions: ['record-resolution', 'enqueue-ready', 'emit-progress'] }),
  // "→ failed when budget or retries are exhausted": from every live generation, whichever ended it.
  ...(['planned', 'ready', 'waiting_children', 'retry_wait', 'blocked'] as const).map((from) => unitTransition(from, 'fail', 'failed', { guards: ['generation-current', 'fail-cause'], actions: failActions })),
  unitTransition('running', 'fail', 'failed', { guards: ['generation-current', 'fail-cause'], actions: failFenced }),
  // The third policy for a failed child: the run propagates the child's failure, and the waiting parent
  // fails with it without spending an attempt of its own.
  unitTransition('waiting_children', 'fail', 'failed', { label: 'child-failed', guards: ['generation-current', 'cause-child-failed'], actions: failFenced }),
  // Staleness: every live generation — a planned one whose inputs changed before admission included —
  // and the published one, which only goes stale.
  ...LIVE_UNIT_STATES.map((from) => unitTransition(from, 'invalidate', 'stale', { guards: ['replacement-named'], actions: invalidateActions })),
  unitTransition('published', 'invalidate', 'stale', { guards: ['replacement-named'], actions: invalidateActions }),
  // Cancellation is the run control's authority over whatever generation stands, so it names none.
  unitTransition('planned', 'cancel', 'cancelled', { actions: cancelActions }),
  ...(['ready', 'running', 'waiting_children', 'retry_wait', 'blocked'] as const).map((from) => unitTransition(from, 'cancel', 'cancelled', { actions: cancelActions })),
  // The run ends and this generation never finished: a final record that names the failed unit it waited on,
  // instead of a pending state a reader could mistake for work still to come.
  ...LIVE_UNIT_STATES.map((from) => unitTransition(from, 'skip', 'skipped', { guards: ['skip-cause-named'], actions: ['record-skip'] })),
];

/** The unit machine: generations and the attempts the queue hands them out as. */
export const unitMachine = createFillMachine<UnitState, UnitEvent, UnitContext>({
  id: 'fill-unit',
  initial: 'planned',
  states: UNIT_STATES,
  transitions: unitTransitions,
  guards: unitGuards,
  actions: unitActions,
});

/** A generation's context when the unit is first created or a replacement opens: no attempt yet. */
export function newUnitContext(options: { readonly generation: number }): UnitContext {
  return { generation: options.generation, attempt: 0, retryAt: null, replacedBy: null, skippedBecause: null, unitOutcome: null };
}

// ---------------------------------------------------------------------------------------------
// Run machine
// ---------------------------------------------------------------------------------------------

/** The states of one fill run, in the order decision 0027 lists them. */
export const RUN_STATES = [
  'created', 'planning', 'running', 'pausing', 'paused', 'cancelling', 'cancelled',
  'succeeded', 'completed_partial', 'blocked', 'failed',
] as const;
export type RunState = typeof RUN_STATES[number];

/** What a run carries in the database besides its state name. */
/** The original press and the resolved dependency order, kept with the run it requested. */
export interface RunSelection {
  readonly selected: readonly string[];
  readonly order: readonly string[];
  readonly vertex?: string;
  readonly groups?: readonly { readonly kind: string; readonly group: string | null; readonly plugin: string; readonly stageUnitId: string }[];
}

/** The process identity that owns a run: the daemon/store-owner token it was started under, never a pid alone. */
export interface RunOwner {
  readonly token: string;
  readonly pid: number;
}

export interface RunContext {
  readonly selection?: RunSelection;
  /** The process identity that created this run; null when it had no token to name itself with. */
  readonly owner?: RunOwner | null;
  /** How many times planning ran; a resume after a pause opens the next epoch. */
  readonly planningEpoch: number;
  /** True once planning closed its epoch; completion needs it closed. */
  readonly planningClosed: boolean;
}

/** What the orchestrator observed when it asks a run to complete, drain or settle. */
export interface RunEvidence {
  /** Units the scheduler could admit now. */
  readonly runnable: number;
  /** Units holding a lease or running. */
  readonly inFlight: number;
  /** Units waiting for their children. */
  readonly waiting: number;
  /** True when every required capability's coverage is met. */
  readonly coverageMet: boolean;
  /** Publication effects not yet applied. */
  readonly pendingPublications: number;
}

/** A step a caller asks of a run. Each carries the evidence its transition's guards read. */
export type RunEvent =
  | { readonly type: 'plan'; readonly at: number; readonly configuration: string }
  | { readonly type: 'start'; readonly at: number; readonly stages: number }
  | { readonly type: 'replan'; readonly at: number; readonly stages: number }
  | { readonly type: 'complete'; readonly at: number; readonly evidence: RunEvidence }
  | { readonly type: 'complete-partial'; readonly at: number; readonly evidence: RunEvidence }
  | { readonly type: 'block'; readonly at: number; readonly starvationPath: string }
  | { readonly type: 'fail'; readonly at: number; readonly cause: 'budget-exhausted' | 'initialization-failed' | 'process-ended' | 'no-units-published'; readonly detail: string }
  | { readonly type: 'pause'; readonly at: number }
  | { readonly type: 'drain'; readonly at: number; readonly evidence: RunEvidence }
  | { readonly type: 'resume'; readonly at: number }
  | { readonly type: 'cancel'; readonly at: number; readonly cause: string }
  | { readonly type: 'drained'; readonly at: number; readonly evidence: RunEvidence };

const noRunnableLeft = (evidence: RunEvidence): boolean => evidence.runnable === 0 && evidence.inFlight === 0 && evidence.waiting === 0;
const nothingInFlight = (evidence: RunEvidence): boolean => evidence.inFlight === 0 && evidence.waiting === 0;

/** Every run guard, named and pure. */
const runGuards: MachineSpec<RunState, RunEvent, RunContext>['guards'] = {
  'initialization-failure-named': {
    describe: 'initialization failed before planning, with its reason named',
    check: (_context, event) => event.type === 'fail' && event.cause === 'initialization-failed' && named(event.detail),
  },
  'configuration-resolved': {
    describe: 'the run snapshot names the resolved configuration it plans with',
    check: (_context, event) => event.type === 'plan' && named(event.configuration),
  },
  'stage-graph-resolved': {
    describe: 'planning resolved at least one stage to run',
    check: (_context, event) => event.type === 'start' && event.stages > 0,
  },
  'replan-stages-named': {
    describe: 'the reopened planning names the stages it is about to plan',
    check: (_context, event) => event.type === 'replan' && event.stages > 0,
  },
  'planning-closed': {
    describe: 'the run\'s planning epoch is closed',
    check: (context) => context.planningClosed,
  },
  'nothing-runnable-in-flight-or-waiting': {
    describe: 'no unit is runnable, in flight or waiting for its children',
    check: (_context, event) => 'evidence' in event && noRunnableLeft(event.evidence),
  },
  'nothing-in-flight-or-waiting': {
    describe: 'no unit is in flight or waiting for its children',
    check: (_context, event) => 'evidence' in event && nothingInFlight(event.evidence),
  },
  'required-coverage-met': {
    describe: 'every required capability\'s coverage is met',
    check: (_context, event) => 'evidence' in event && event.evidence.coverageMet,
  },
  'required-coverage-unmet': {
    describe: 'required coverage is not met, so the run may only complete partially',
    check: (_context, event) => 'evidence' in event && !event.evidence.coverageMet,
  },
  'no-pending-publication': {
    describe: 'no publication effect is still pending',
    check: (_context, event) => 'evidence' in event && event.evidence.pendingPublications === 0,
  },
  'starvation-path-named': {
    describe: 'the block names the starvation path, consumer → capability → producer',
    check: (_context, event) => event.type === 'block' && named(event.starvationPath),
  },
  'cause-budget-exhausted': {
    describe: 'the run\'s budget is spent',
    check: (_context, event) => event.type === 'fail' && event.cause === 'budget-exhausted',
  },
  'process-ended': {
    describe: 'the process that ran this run is gone, and its ending is named',
    check: (_context, event) => event.type === 'fail' && event.cause === 'process-ended' && named(event.detail),
  },
  'no-units-published': {
    describe: 'the run ended with no published unit, so it failed rather than completed partially',
    check: (_context, event) => event.type === 'fail' && event.cause === 'no-units-published' && named(event.detail),
  },
};

/** Every run action, named. */
const runActions: MachineSpec<RunState, RunEvent, RunContext>['actions'] = {
  'close-planning-epoch': {
    kind: 'context',
    describe: 'marks the run\'s planning epoch closed',
    apply: (context) => ({ ...context, planningClosed: true }),
  },
  'bump-planning-epoch': {
    kind: 'context',
    describe: 'opens the next planning epoch number',
    apply: (context) => ({ ...context, planningEpoch: context.planningEpoch + 1 }),
  },
  'reopen-planning-epoch': {
    kind: 'context',
    describe: 'marks the run\'s planning epoch open again',
    apply: (context) => ({ ...context, planningClosed: false }),
  },
  'snapshot-configuration': {
    kind: 'effect',
    describe: 'the orchestrator persists the resolved configuration and stage versions the run plans with',
  },
  'enqueue-stages': {
    kind: 'effect',
    describe: 'the orchestrator admits the planned units within the resource limits',
  },
  'record-completion': {
    kind: 'effect',
    describe: 'the orchestrator records that the run succeeded with its required coverage',
  },
  'record-partial-completion': {
    kind: 'effect',
    describe: 'the orchestrator records the run as completing partially, with what it did not cover',
  },
  'record-starvation': {
    kind: 'effect',
    describe: 'the orchestrator records the starvation path that blocked the run',
  },
  'record-failure': {
    kind: 'effect',
    describe: 'the orchestrator records the run\'s terminal failure',
  },
  'record-pause-intent': {
    kind: 'effect',
    describe: 'the orchestrator records that the run is pausing and admits no new work',
  },
  'record-paused': {
    kind: 'effect',
    describe: 'the orchestrator records the run as paused once its work drained',
  },
  'revoke-run-authority': {
    kind: 'effect',
    describe: 'the orchestrator revokes the authority of the run\'s in-flight units and their sessions',
  },
  'record-cancel-intent': {
    kind: 'effect',
    describe: 'the orchestrator records the persisted cancellation intent',
  },
  'record-cancelled': {
    kind: 'effect',
    describe: 'the orchestrator records the run as cancelled once nothing is in flight',
  },
  'emit-progress': {
    kind: 'effect',
    describe: 'the orchestrator emits the durable progress event a watching person sees',
  },
};

/** One line of the run table, with its id built from its machine, states and event. */
const runTransition = (
  from: RunState,
  event: RunEvent['type'],
  to: RunState,
  entry: { readonly guards?: readonly string[]; readonly actions: readonly string[]; readonly label?: string },
): TransitionSpec<RunState, RunEvent> => transition<RunState, RunEvent>('run', from, event, to, entry);

/**
 * Every transition a run allows. A run never pauses, resumes or cancels after it
 * ended: `succeeded`, `completed_partial`, `blocked`, `failed` and `cancelled`
 * are terminal, and the next attempt is a new run on the same chain. Planning
 * itself can end the run: a plan that resolves no stage for a required producer
 * records its starvation path as `blocked`, and a spent budget fails it there.
 */
const runTransitions: MachineSpec<RunState, RunEvent, RunContext>['transitions'] = [
  runTransition('created', 'plan', 'planning', { guards: ['configuration-resolved'], actions: ['snapshot-configuration', 'emit-progress'] }),
  runTransition('created', 'fail', 'failed', { label: 'initialization-failed', guards: ['initialization-failure-named'], actions: ['record-failure', 'emit-progress'] }),
  runTransition('planning', 'start', 'running', { guards: ['stage-graph-resolved'], actions: ['close-planning-epoch', 'bump-planning-epoch', 'enqueue-stages', 'emit-progress'] }),
  runTransition('planning', 'block', 'blocked', { guards: ['starvation-path-named'], actions: ['record-starvation', 'emit-progress'] }),
  runTransition('planning', 'fail', 'failed', { label: 'budget-exhausted', guards: ['cause-budget-exhausted'], actions: ['record-failure', 'emit-progress'] }),
  runTransition('running', 'complete', 'succeeded', { guards: ['planning-closed', 'nothing-runnable-in-flight-or-waiting', 'required-coverage-met', 'no-pending-publication'], actions: ['record-completion', 'emit-progress'] }),
  runTransition('running', 'complete-partial', 'completed_partial', { guards: ['planning-closed', 'nothing-runnable-in-flight-or-waiting', 'no-pending-publication', 'required-coverage-unmet'], actions: ['record-partial-completion', 'emit-progress'] }),
  runTransition('running', 'block', 'blocked', { guards: ['starvation-path-named'], actions: ['record-starvation', 'emit-progress'] }),
  runTransition('running', 'fail', 'failed', { label: 'budget-exhausted', guards: ['cause-budget-exhausted'], actions: ['record-failure', 'emit-progress'] }),
  // A run whose process died is ended by the next start, never left standing `running` with no one to
  // advance it. The next start names the process ending as the cause and the run reaches `failed`.
  ...(['created', 'planning', 'running', 'pausing', 'cancelling'] as const).map((from) => runTransition(from, 'fail', 'failed', { label: 'process-ended', guards: ['process-ended'], actions: ['record-failure', 'emit-progress'] })),
  runTransition('running', 'fail', 'failed', { label: 'no-units-published', guards: ['no-units-published'], actions: ['record-failure', 'emit-progress'] }),

  runTransition('running', 'pause', 'pausing', { actions: ['record-pause-intent', 'emit-progress'] }),
  runTransition('pausing', 'drain', 'paused', { guards: ['nothing-in-flight-or-waiting'], actions: ['record-paused', 'emit-progress'] }),
  runTransition('paused', 'resume', 'planning', { actions: ['reopen-planning-epoch', 'emit-progress'] }),
  // A stage whose producers have settled inside the run plans then (madarch-tzte.26.3): the run
  // reopens its planning epoch for the stages that are due and closes it again when they are planned.
  runTransition('running', 'replan', 'planning', { guards: ['replan-stages-named'], actions: ['reopen-planning-epoch', 'emit-progress'] }),
  ...(['created', 'planning', 'running', 'pausing', 'paused'] as const).map((from) => runTransition(from, 'cancel', 'cancelling', { actions: ['revoke-run-authority', 'record-cancel-intent', 'emit-progress'] })),
  runTransition('cancelling', 'drained', 'cancelled', { guards: ['nothing-runnable-in-flight-or-waiting', 'no-pending-publication'], actions: ['record-cancelled', 'emit-progress'] }),
];

/** The run machine: one fill run's life, as decision 0027 declares it. */
export const runMachine = createFillMachine<RunState, RunEvent, RunContext>({
  id: 'fill-run',
  initial: 'created',
  states: RUN_STATES,
  transitions: runTransitions,
  guards: runGuards,
  actions: runActions,
});

/** A run's context when it is first created. */
export function newRunContext(owner: RunOwner | null = ownerOfProcess()): RunContext {
  return { planningEpoch: 0, planningClosed: false, ...(owner === null ? {} : { owner }) };
}

/** The token this process can prove it owns a run with: the daemon token, else the store-owner token. */
export function ownerOfProcess(env: NodeJS.ProcessEnv = process.env, pid = process.pid): RunOwner | null {
  const token = env['MADARCH_DAEMON_TOKEN'] ?? env['MADARCH_STORE_OWNER_TOKEN'];
  return token === undefined || token === '' ? null : { token, pid };
}


// ---------------------------------------------------------------------------------------------
// The public state machines
// ---------------------------------------------------------------------------------------------

/**
 * The run's reader-facing state machine: queued → running ⇄ paused → succeeded | partial |
 * failed | stopped. The persisted run machine has finer steps; every reader maps through
 * `runPhaseOf`, and no page, API answer or indicator keeps its own idea of "finished".
 */
export const RUN_PHASES = ['queued', 'running', 'paused', 'succeeded', 'partial', 'failed', 'stopped'] as const;
export type RunPhase = typeof RUN_PHASES[number];

/** Every transition of the public run machine, with the reason it carries. */
const RUN_PHASE_TRANSITIONS: readonly { readonly from: RunPhase; readonly event: string; readonly to: RunPhase; readonly reason: string }[] = [
  { from: 'queued', event: 'start', to: 'running', reason: 'the run began planning' },
  { from: 'running', event: 'pause', to: 'paused', reason: 'a person paused the run after its work drained' },
  { from: 'paused', event: 'resume', to: 'running', reason: 'a person resumed the run' },
  { from: 'running', event: 'succeed', to: 'succeeded', reason: 'every required unit published' },
  { from: 'running', event: 'partial', to: 'partial', reason: 'the run ended with some work uncovered' },
  { from: 'running', event: 'fail', to: 'failed', reason: 'the run failed or became blocked' },
  { from: 'running', event: 'stop', to: 'stopped', reason: 'a person stopped the run' },
  { from: 'queued', event: 'fail', to: 'failed', reason: 'initialization failed before any work ran' },
  { from: 'queued', event: 'stop', to: 'stopped', reason: 'a person stopped the run before it began' },
  { from: 'paused', event: 'fail', to: 'failed', reason: 'a paused run could not continue' },
  { from: 'paused', event: 'stop', to: 'stopped', reason: 'a person stopped the paused run' },
];

/** The states a run never leaves. */
const FINAL_RUN_PHASES: readonly RunPhase[] = ['succeeded', 'partial', 'failed', 'stopped'];

/** Whether a public run phase is final. */
export function isFinalRunPhase(phase: RunPhase): boolean {
  return FINAL_RUN_PHASES.includes(phase) && !RUN_PHASE_TRANSITIONS.some((transition) => transition.from === phase);
}

/** The public phase of one persisted run state. */
export function runPhaseOf(state: RunState): RunPhase {
  switch (state) {
    case 'created': case 'planning': return 'queued';
    case 'running': case 'pausing': return 'running';
    case 'paused': return 'paused';
    case 'succeeded': return 'succeeded';
    case 'completed_partial': return 'partial';
    case 'blocked': case 'failed': return 'failed';
    case 'cancelling': return 'running';
    case 'cancelled': return 'stopped';
  }
}

/** The persisted states a run never leaves: a paused run is not finished, a cancelled one is. */
export const FINAL_RUN_STATES: readonly RunState[] = ['succeeded', 'completed_partial', 'blocked', 'failed', 'cancelled'];

/** Whether a persisted run state is final in the public machine. */
export function isFinalRunState(state: RunState): boolean {
  return FINAL_RUN_STATES.includes(state);
}

/**
 * The unit's reader-facing state machine: waiting → running → done | failed | skipped |
 * cancelled. `skipped` always carries the failed unit or the ending that left it unrun.
 */
export const UNIT_PHASES = ['waiting', 'running', 'done', 'failed', 'skipped', 'cancelled'] as const;
export type UnitPhase = typeof UNIT_PHASES[number];

/** Every transition of the public unit machine, with the reason it carries. */
const UNIT_PHASE_TRANSITIONS: readonly { readonly from: UnitPhase; readonly event: string; readonly to: UnitPhase; readonly reason: string }[] = [
  { from: 'waiting', event: 'start', to: 'running', reason: 'a worker took the unit' },
  { from: 'waiting', event: 'skip', to: 'skipped', reason: 'a required unit failed or the run ended' },
  { from: 'waiting', event: 'cancel', to: 'cancelled', reason: 'a person stopped the run' },
  { from: 'running', event: 'publish', to: 'done', reason: 'the unit published its facts' },
  { from: 'running', event: 'fail', to: 'failed', reason: 'the unit exhausted its attempts or budget' },
  { from: 'running', event: 'skip', to: 'skipped', reason: 'a required unit failed or the run ended' },
  { from: 'running', event: 'cancel', to: 'cancelled', reason: 'a person stopped the run' },
];

/** The states a unit never leaves. */
const FINAL_UNIT_PHASES: readonly UnitPhase[] = ['done', 'failed', 'skipped', 'cancelled'];

/** Whether a public unit phase is final. */
export function isFinalUnitPhase(phase: UnitPhase): boolean {
  return FINAL_UNIT_PHASES.includes(phase) && !UNIT_PHASE_TRANSITIONS.some((transition) => transition.from === phase);
}

/** The public phase of one persisted unit generation. */
export function unitPhaseOf(state: UnitState): UnitPhase {
  switch (state) {
    case 'published': return 'done';
    case 'failed': return 'failed';
    case 'skipped': case 'stale': return 'skipped';
    case 'cancelled': return 'cancelled';
    case 'running': return 'running';
    case 'planned': case 'ready': case 'waiting_children': case 'retry_wait': case 'blocked': return 'waiting';
  }
}

/** The persisted unit states that are already final; `superseded` is a legacy record of a replaced generation. */
export const FINAL_UNIT_STATES: readonly string[] = ['published', 'failed', 'stale', 'cancelled', 'skipped', 'superseded'];

/** Whether a persisted unit generation is final. */
export function isFinalUnitState(state: string): boolean {
  return FINAL_UNIT_STATES.includes(state);
}

// ---------------------------------------------------------------------------------------------
// Chain machine
// ---------------------------------------------------------------------------------------------

/** The states of a product's chain of runs, in the order decision 0027 lists them. */
export const CHAIN_STATES = ['idle', 'active', 'quiescent'] as const;
export type ChainState = typeof CHAIN_STATES[number];

/** What a product's chain carries besides its state name. */
export interface ChainContext {
  /** The run the chain is following, or null when none is. */
  readonly activeRunId: string | null;
}

/** What the orchestrator observed when it asks a chain to settle. */
export interface ChainEvidence {
  readonly runnable: number;
  readonly inFlight: number;
  readonly waiting: number;
  readonly pendingPublications: number;
}

/** A step a caller asks of a product's chain. */
export type ChainEvent =
  | { readonly type: 'start'; readonly at: number; readonly runId: string }
  | { readonly type: 'settle'; readonly at: number; readonly evidence: ChainEvidence }
  | { readonly type: 'wake'; readonly at: number; readonly runId: string };

/** Every chain guard, named and pure. */
const chainGuards: MachineSpec<ChainState, ChainEvent, ChainContext>['guards'] = {
  'run-named': {
    describe: 'the step names the run the chain follows',
    check: (_context, event) => 'runId' in event && named(event.runId),
  },
  'nothing-outstanding': {
    describe: 'no unit is runnable, in flight or waiting, and no publication effect is pending',
    check: (_context, event) => 'evidence' in event && event.evidence.runnable === 0 && event.evidence.inFlight === 0
      && event.evidence.waiting === 0 && event.evidence.pendingPublications === 0,
  },
};

/** Every chain action, named. */
const chainActions: MachineSpec<ChainState, ChainEvent, ChainContext>['actions'] = {
  'record-active-run': {
    kind: 'context',
    describe: 'records the run the chain follows',
    apply: (context, event) => ({ ...context, activeRunId: 'runId' in event ? event.runId : context.activeRunId }),
  },
  'clear-active-run': {
    kind: 'context',
    describe: 'clears the run the chain followed',
    apply: (context) => ({ ...context, activeRunId: null }),
  },
  'emit-progress': {
    kind: 'effect',
    describe: 'the orchestrator emits the durable progress event a watching person sees',
  },
};

/** One line of the chain table, with its id built from its machine, states and event. */
const chainTransition = (
  from: ChainState,
  event: ChainEvent['type'],
  to: ChainState,
  entry: { readonly guards?: readonly string[]; readonly actions: readonly string[]; readonly label?: string },
): TransitionSpec<ChainState, ChainEvent> => transition<ChainState, ChainEvent>('chain', from, event, to, entry);

/** Every transition a product's chain allows: idle → active → quiescent and back to active. */
const chainTransitions: MachineSpec<ChainState, ChainEvent, ChainContext>['transitions'] = [
  chainTransition('idle', 'start', 'active', { guards: ['run-named'], actions: ['record-active-run', 'emit-progress'] }),
  chainTransition('active', 'settle', 'quiescent', { guards: ['nothing-outstanding'], actions: ['clear-active-run', 'emit-progress'] }),
  chainTransition('quiescent', 'wake', 'active', { guards: ['run-named'], actions: ['record-active-run', 'emit-progress'] }),
];

/** The chain machine: a product's chain of runs, idle → active → quiescent. */
export const chainMachine = createFillMachine<ChainState, ChainEvent, ChainContext>({
  id: 'fill-chain',
  initial: 'idle',
  states: CHAIN_STATES,
  transitions: chainTransitions,
  guards: chainGuards,
  actions: chainActions,
});

/** A chain's context when it is first opened. */
export function newChainContext(): ChainContext {
  return { activeRunId: null };
}
