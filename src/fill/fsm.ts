/**
 * The fill's state machines (decision 0027): a unit's generations and attempts, a
 * run, and the chain of runs per product. Pure transitions only — the tables
 * below are the whole of what each machine allows, XState performs every step,
 * and persistence is `state-store.ts`.
 *
 * A unit has a logical identity, immutable generations (a new input set opens a
 * new generation) and attempts (retries inside a generation). A lease carries a
 * monotonically increasing fencing token: every step a worker takes names its
 * token, and a step naming an older one is refused, so a worker that lost its
 * lease cannot publish, block or fail the generation that replaced it. A
 * published generation stays an immutable record: it is never retried or
 * cancelled, only marked stale and linked to its replacement.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> planned
 *   blocked --> cancelled: cancel
 *   blocked --> stale: invalidate [replacement-named]
 *   blocked --> ready: unblock [resolution-named]
 *   draft --> blocked: block [fence-current & block-reason-named]
 *   draft --> cancelled: cancel
 *   draft --> stale: invalidate [replacement-named]
 *   draft --> validating: validate-draft [fence-current & generation-current]
 *   leased --> blocked: block [fence-current & block-reason-named]
 *   leased --> cancelled: cancel
 *   leased --> stale: invalidate [replacement-named]
 *   leased --> retry_wait: retry [retries-remain & retry-time-named & cause-lease-expired]
 *   leased --> running: start [fence-current]
 *   planned --> ready: admit
 *   planned --> cancelled: cancel
 *   published --> stale: invalidate [replacement-named]
 *   ready --> blocked: block [block-reason-named]
 *   ready --> cancelled: cancel
 *   ready --> stale: invalidate [replacement-named]
 *   ready --> leased: lease [fence-advances]
 *   retry_wait --> cancelled: cancel
 *   retry_wait --> failed: fail [cause-retries-exhausted & retries-exhausted]
 *   retry_wait --> stale: invalidate [replacement-named]
 *   retry_wait --> ready: retry [retry-elapsed]
 *   running --> blocked: block [fence-current & block-reason-named]
 *   running --> cancelled: cancel
 *   running --> failed: fail [fence-current & cause-budget-exhausted]
 *   running --> stale: invalidate [replacement-named]
 *   running --> retry_wait: retry [retries-remain & retry-time-named & cause-lease-expired]
 *   running --> retry_wait: retry [retries-remain & retry-time-named & cause-transient-failure]
 *   running --> draft: submit-draft [fence-current & generation-current]
 *   running --> waiting_children: wait-for-children [fence-current & generation-current & children-sealed]
 *   validating --> blocked: block [fence-current & block-reason-named]
 *   validating --> cancelled: cancel
 *   validating --> stale: invalidate [replacement-named]
 *   validating --> published: publish [fence-current & generation-current & reads-fresh]
 *   validating --> retry_wait: retry [retries-remain & retry-time-named & cause-validation-problem]
 *   waiting_children --> blocked: block [block-reason-named]
 *   waiting_children --> cancelled: cancel
 *   waiting_children --> stale: invalidate [replacement-named]
 *   waiting_children --> ready: join [children-published-and-fresh]
 *   cancelled --> [*]
 *   failed --> [*]
 *   stale --> [*]
 * ```
 *
 * The run machine walks created → planning → running → succeeded,
 * completed_partial, blocked or failed, pauses through pausing → paused →
 * planning, and cancels through cancelling → cancelled from any non-terminal
 * state. The chain of runs per product walks idle → active → quiescent and back.
 * `state-store.ts` persists all three; their diagrams render from the same
 * tables (see `unitMachine.mermaid()`, `runMachine.mermaid()`,
 * `chainMachine.mermaid()`).
 */
import type { MachineSpec } from './fsm-core.js';
import { createFillMachine } from './fsm-core.js';

// ---------------------------------------------------------------------------------------------
// Unit machine
// ---------------------------------------------------------------------------------------------

/** The states of a unit generation, in the order decision 0027 lists them. */
export const UNIT_STATES = [
  'planned', 'ready', 'leased', 'running', 'draft', 'validating', 'published',
  'waiting_children', 'retry_wait', 'blocked', 'failed', 'stale', 'cancelled',
] as const;
export type UnitState = typeof UNIT_STATES[number];

/** What a unit generation carries in the database besides its state name. */
export interface UnitContext {
  /** The generation this row is; a new input set opens the next generation of the same unit. */
  readonly generation: number;
  /** Attempts spent on this generation, the first lease included. */
  readonly attempt: number;
  /** The fencing token in force: every lease takes a greater one, and a step naming an older one is refused. */
  readonly fence: number;
  /** Retries left on this generation before it fails. */
  readonly retriesLeft: number;
  /** Epoch milliseconds the current retry wait may go ready; null when the unit is not waiting. */
  readonly retryAt: number | null;
  /** The generation that replaces this one once it went stale; null while it stands. */
  readonly replacedBy: number | null;
}

/** What a unit failed on, when its retries or its budget ran out. */
export type UnitFailCause = 'budget-exhausted' | 'retries-exhausted';

/** What sent a unit back to a retry wait. */
export type UnitRetryCause = 'lease-expired' | 'transient-failure' | 'validation-problem';

/** One child of a split, as the parent's join judges it. */
export interface UnitChildOutcome {
  readonly unitId: string;
  readonly generation: number;
  /** True when the child's generation was published. */
  readonly published: boolean;
  /** True when nothing the child read has changed since it published. */
  readonly fresh: boolean;
}

/** A step a caller asks of a unit generation. Each carries the evidence its transition's guards read. */
export type UnitEvent =
  | { readonly type: 'admit'; readonly at: number }
  | { readonly type: 'lease'; readonly at: number; readonly fence: number; readonly attempt: number }
  | { readonly type: 'start'; readonly at: number; readonly fence: number }
  | { readonly type: 'submit-draft'; readonly at: number; readonly fence: number; readonly generation: number }
  | { readonly type: 'validate-draft'; readonly at: number; readonly fence: number; readonly generation: number }
  | { readonly type: 'publish'; readonly at: number; readonly fence: number; readonly generation: number; readonly readsFresh: boolean }
  | { readonly type: 'wait-for-children'; readonly at: number; readonly fence: number; readonly generation: number; readonly children: readonly UnitChildOutcome[] }
  | { readonly type: 'join'; readonly at: number; readonly children: readonly UnitChildOutcome[] }
  | { readonly type: 'retry'; readonly at: number; readonly cause: UnitRetryCause; readonly retryAt: number | null }
  | { readonly type: 'block'; readonly at: number; readonly fence: number | null; readonly reason: string }
  | { readonly type: 'unblock'; readonly at: number; readonly resolution: string }
  | { readonly type: 'fail'; readonly at: number; readonly fence: number | null; readonly cause: UnitFailCause }
  | { readonly type: 'invalidate'; readonly at: number; readonly replacement: number; readonly cause: string }
  | { readonly type: 'cancel'; readonly at: number; readonly cause: string };

const named = (value: string): boolean => value.trim() !== '';
const fenced = (event: { readonly fence: number | null }): boolean => event.fence !== null;

/** Every unit guard, named and pure: it reads the persisted generation and the event, nothing else. */
const unitGuards: MachineSpec<UnitState, UnitEvent, UnitContext>['guards'] = {
  'fence-advances': {
    describe: 'the new lease takes a greater fencing token than the generation holds',
    check: (context, event) => event.type === 'lease' && event.fence > context.fence,
  },
  'fence-current': {
    describe: 'the step names the generation\'s current fencing token, so a late worker holding an older lease is refused',
    check: (context, event) => 'fence' in event && fenced(event) && event.fence === context.fence,
  },
  'generation-current': {
    describe: 'the step names the generation in force',
    check: (context, event) => 'generation' in event && event.generation === context.generation,
  },
  'retries-remain': {
    describe: 'the generation has a retry left before it fails',
    check: (context) => context.retriesLeft > 0,
  },
  'retries-exhausted': {
    describe: 'the generation has spent every retry of its budget',
    check: (context) => context.retriesLeft === 0,
  },
  'retry-time-named': {
    describe: 'the retry names the moment it may run again',
    check: (_context, event) => event.type === 'retry' && event.retryAt !== null,
  },
  'retry-elapsed': {
    describe: 'the retry wait is over',
    check: (context, event) => context.retryAt !== null && event.at >= context.retryAt,
  },
  'cause-lease-expired': {
    describe: 'the lease of the attempt expired',
    check: (_context, event) => event.type === 'retry' && event.cause === 'lease-expired',
  },
  'cause-transient-failure': {
    describe: 'the attempt failed transiently',
    check: (_context, event) => event.type === 'retry' && event.cause === 'transient-failure',
  },
  'cause-validation-problem': {
    describe: 'validation found a problem the unit may fix in another attempt',
    check: (_context, event) => event.type === 'retry' && event.cause === 'validation-problem',
  },
  'cause-budget-exhausted': {
    describe: 'the run\'s budget for the unit is spent',
    check: (_context, event) => event.type === 'fail' && event.cause === 'budget-exhausted',
  },
  'cause-retries-exhausted': {
    describe: 'the unit reports that it has no retry left',
    check: (_context, event) => event.type === 'fail' && event.cause === 'retries-exhausted',
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
  'reads-fresh': {
    describe: 'the reads the generation recorded are unchanged at publication',
    check: (_context, event) => event.type === 'publish' && event.readsFresh,
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
};

/** Every unit action, named: context updates XState applies, then effects the orchestrator performs. */
const unitActions: MachineSpec<UnitState, UnitEvent, UnitContext>['actions'] = {
  'take-fence': {
    kind: 'context',
    describe: 'records the lease\'s fencing token and its attempt number on the generation',
    apply: (context, event) => (event.type === 'lease' ? { ...context, fence: event.fence, attempt: event.attempt } : context),
  },
  'spend-retry': {
    kind: 'context',
    describe: 'spends one retry of the generation',
    apply: (context) => ({ ...context, retriesLeft: Math.max(0, context.retriesLeft - 1) }),
  },
  'wait-for-retry': {
    kind: 'context',
    describe: 'records the moment the retry may run',
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
  'enqueue-ready': {
    kind: 'effect',
    describe: 'the orchestrator makes the generation runnable on the queue',
  },
  'revoke-lease': {
    kind: 'effect',
    describe: 'the orchestrator revokes the generation\'s lease, if it holds one, so no late worker may advance it',
  },
  'schedule-retry': {
    kind: 'effect',
    describe: 'the orchestrator schedules the retry for the recorded moment',
  },
  'suspend-parent': {
    kind: 'effect',
    describe: 'the orchestrator releases the parent\'s lease while its children run',
  },
  'resume-join': {
    kind: 'effect',
    describe: 'the orchestrator re-enqueues the parent\'s join',
  },
  'record-draft': {
    kind: 'effect',
    describe: 'the orchestrator records the draft set the unit wrote',
  },
  'record-validation': {
    kind: 'effect',
    describe: 'the orchestrator records that validation started on the draft',
  },
  'record-publication': {
    kind: 'effect',
    describe: 'the database owner writes the one publication record of this generation',
  },
  'retract-draft': {
    kind: 'effect',
    describe: 'the orchestrator retracts the generation\'s unpublished draft set',
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

/** A transition the whole table shares: a control step the orchestrator takes on any live generation. */
const unitTransition = (from: UnitState, id: string, event: UnitEvent['type'], to: UnitState, guards: readonly string[], actions: readonly string[]): MachineSpec<UnitState, UnitEvent, UnitContext>['transitions'][number] =>
  ({ id, from, event, to, guards, actions });

/**
 * Every transition a unit generation allows, and nothing else: the states absent
 * from a line here are the ones refused. `published`, `failed`, `stale` and
 * `cancelled` leave the table never: a published generation only goes stale with
 * a replacement, and stale work continues in its replacement generation.
 */
const unitTransitions: MachineSpec<UnitState, UnitEvent, UnitContext>['transitions'] = [
  unitTransition('planned', 'unit/planned--admit-->ready', 'admit', 'ready', [], ['enqueue-ready', 'emit-progress']),
  unitTransition('ready', 'unit/ready--lease-->leased', 'lease', 'leased', ['fence-advances'], ['take-fence', 'emit-progress']),
  unitTransition('leased', 'unit/leased--start-->running', 'start', 'running', ['fence-current'], ['emit-progress']),
  unitTransition('running', 'unit/running--submit-draft-->draft', 'submit-draft', 'draft', ['fence-current', 'generation-current'], ['record-draft', 'emit-progress']),
  unitTransition('draft', 'unit/draft--validate-draft-->validating', 'validate-draft', 'validating', ['fence-current', 'generation-current'], ['record-validation', 'emit-progress']),
  unitTransition('validating', 'unit/validating--publish-->published', 'publish', 'published', ['fence-current', 'generation-current', 'reads-fresh'], ['record-publication', 'emit-progress']),
  unitTransition('running', 'unit/running--wait-for-children-->waiting_children', 'wait-for-children', 'waiting_children', ['fence-current', 'generation-current', 'children-sealed'], ['suspend-parent', 'emit-progress']),
  unitTransition('waiting_children', 'unit/waiting_children--join-->ready', 'join', 'ready', ['children-published-and-fresh'], ['resume-join', 'enqueue-ready', 'emit-progress']),
  unitTransition('validating', 'unit/validating--retry-validation-problem-->retry_wait', 'retry', 'retry_wait', ['retries-remain', 'retry-time-named', 'cause-validation-problem'], ['spend-retry', 'wait-for-retry', 'retract-draft', 'schedule-retry', 'emit-progress']),
  unitTransition('leased', 'unit/leased--retry-lease-expired-->retry_wait', 'retry', 'retry_wait', ['retries-remain', 'retry-time-named', 'cause-lease-expired'], ['spend-retry', 'wait-for-retry', 'revoke-lease', 'schedule-retry', 'emit-progress']),
  unitTransition('running', 'unit/running--retry-lease-expired-->retry_wait', 'retry', 'retry_wait', ['retries-remain', 'retry-time-named', 'cause-lease-expired'], ['spend-retry', 'wait-for-retry', 'revoke-lease', 'schedule-retry', 'emit-progress']),
  unitTransition('running', 'unit/running--retry-transient-failure-->retry_wait', 'retry', 'retry_wait', ['retries-remain', 'retry-time-named', 'cause-transient-failure'], ['spend-retry', 'wait-for-retry', 'schedule-retry', 'emit-progress']),
  unitTransition('retry_wait', 'unit/retry_wait--retry-->ready', 'retry', 'ready', ['retry-elapsed'], ['clear-retry', 'enqueue-ready', 'emit-progress']),
  unitTransition('ready', 'unit/ready--block-->blocked', 'block', 'blocked', ['block-reason-named'], ['emit-progress']),
  unitTransition('leased', 'unit/leased--block-->blocked', 'block', 'blocked', ['fence-current', 'block-reason-named'], ['revoke-lease', 'emit-progress']),
  unitTransition('running', 'unit/running--block-->blocked', 'block', 'blocked', ['fence-current', 'block-reason-named'], ['revoke-lease', 'emit-progress']),
  unitTransition('draft', 'unit/draft--block-->blocked', 'block', 'blocked', ['fence-current', 'block-reason-named'], ['revoke-lease', 'emit-progress']),
  unitTransition('validating', 'unit/validating--block-->blocked', 'block', 'blocked', ['fence-current', 'block-reason-named'], ['revoke-lease', 'emit-progress']),
  unitTransition('waiting_children', 'unit/waiting_children--block-->blocked', 'block', 'blocked', ['block-reason-named'], ['emit-progress']),
  unitTransition('blocked', 'unit/blocked--unblock-->ready', 'unblock', 'ready', ['resolution-named'], ['record-resolution', 'enqueue-ready', 'emit-progress']),
  unitTransition('running', 'unit/running--fail-budget-exhausted-->failed', 'fail', 'failed', ['fence-current', 'cause-budget-exhausted'], ['retract-draft', 'emit-progress']),
  unitTransition('retry_wait', 'unit/retry_wait--fail-retries-exhausted-->failed', 'fail', 'failed', ['cause-retries-exhausted', 'retries-exhausted'], ['retract-draft', 'emit-progress']),
  unitTransition('ready', 'unit/ready--invalidate-->stale', 'invalidate', 'stale', ['replacement-named'], ['link-replacement', 'retract-draft', 'revoke-lease', 'emit-progress']),
  unitTransition('leased', 'unit/leased--invalidate-->stale', 'invalidate', 'stale', ['replacement-named'], ['link-replacement', 'retract-draft', 'revoke-lease', 'emit-progress']),
  unitTransition('running', 'unit/running--invalidate-->stale', 'invalidate', 'stale', ['replacement-named'], ['link-replacement', 'retract-draft', 'revoke-lease', 'emit-progress']),
  unitTransition('draft', 'unit/draft--invalidate-->stale', 'invalidate', 'stale', ['replacement-named'], ['link-replacement', 'retract-draft', 'revoke-lease', 'emit-progress']),
  unitTransition('validating', 'unit/validating--invalidate-->stale', 'invalidate', 'stale', ['replacement-named'], ['link-replacement', 'retract-draft', 'revoke-lease', 'emit-progress']),
  unitTransition('waiting_children', 'unit/waiting_children--invalidate-->stale', 'invalidate', 'stale', ['replacement-named'], ['link-replacement', 'retract-draft', 'revoke-lease', 'emit-progress']),
  unitTransition('retry_wait', 'unit/retry_wait--invalidate-->stale', 'invalidate', 'stale', ['replacement-named'], ['link-replacement', 'retract-draft', 'revoke-lease', 'emit-progress']),
  unitTransition('blocked', 'unit/blocked--invalidate-->stale', 'invalidate', 'stale', ['replacement-named'], ['link-replacement', 'retract-draft', 'revoke-lease', 'emit-progress']),
  unitTransition('published', 'unit/published--invalidate-->stale', 'invalidate', 'stale', ['replacement-named'], ['link-replacement', 'revoke-lease', 'emit-progress']),
  unitTransition('planned', 'unit/planned--cancel-->cancelled', 'cancel', 'cancelled', [], ['revoke-authority', 'retract-draft', 'emit-progress']),
  unitTransition('ready', 'unit/ready--cancel-->cancelled', 'cancel', 'cancelled', [], ['revoke-authority', 'revoke-lease', 'retract-draft', 'emit-progress']),
  unitTransition('leased', 'unit/leased--cancel-->cancelled', 'cancel', 'cancelled', [], ['revoke-authority', 'revoke-lease', 'retract-draft', 'emit-progress']),
  unitTransition('running', 'unit/running--cancel-->cancelled', 'cancel', 'cancelled', [], ['revoke-authority', 'revoke-lease', 'retract-draft', 'emit-progress']),
  unitTransition('draft', 'unit/draft--cancel-->cancelled', 'cancel', 'cancelled', [], ['revoke-authority', 'revoke-lease', 'retract-draft', 'emit-progress']),
  unitTransition('validating', 'unit/validating--cancel-->cancelled', 'cancel', 'cancelled', [], ['revoke-authority', 'revoke-lease', 'retract-draft', 'emit-progress']),
  unitTransition('waiting_children', 'unit/waiting_children--cancel-->cancelled', 'cancel', 'cancelled', [], ['revoke-authority', 'revoke-lease', 'retract-draft', 'emit-progress']),
  unitTransition('retry_wait', 'unit/retry_wait--cancel-->cancelled', 'cancel', 'cancelled', [], ['revoke-authority', 'revoke-lease', 'retract-draft', 'emit-progress']),
  unitTransition('blocked', 'unit/blocked--cancel-->cancelled', 'cancel', 'cancelled', [], ['revoke-authority', 'revoke-lease', 'retract-draft', 'emit-progress']),
];

/** The unit machine: generations, attempts and fencing tokens, as decision 0027 declares them. */
export const unitMachine = createFillMachine<UnitState, UnitEvent, UnitContext>({
  id: 'fill-unit',
  initial: 'planned',
  states: UNIT_STATES,
  transitions: unitTransitions,
  guards: unitGuards,
  actions: unitActions,
});

/** A generation's context when the unit is first created. */
export function newUnitContext(options: { readonly generation: number; readonly retries: number }): UnitContext {
  return { generation: options.generation, attempt: 0, fence: 0, retriesLeft: options.retries, retryAt: null, replacedBy: null };
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
export interface RunContext {
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
  | { readonly type: 'complete'; readonly at: number; readonly evidence: RunEvidence }
  | { readonly type: 'complete-partial'; readonly at: number; readonly evidence: RunEvidence }
  | { readonly type: 'block'; readonly at: number; readonly starvationPath: string }
  | { readonly type: 'fail'; readonly at: number; readonly cause: 'budget-exhausted'; readonly detail: string }
  | { readonly type: 'pause'; readonly at: number }
  | { readonly type: 'drain'; readonly at: number; readonly evidence: RunEvidence }
  | { readonly type: 'resume'; readonly at: number }
  | { readonly type: 'cancel'; readonly at: number; readonly cause: string }
  | { readonly type: 'drained'; readonly at: number; readonly evidence: RunEvidence };

const noRunnableLeft = (evidence: RunEvidence): boolean => evidence.runnable === 0 && evidence.inFlight === 0 && evidence.waiting === 0;
const nothingInFlight = (evidence: RunEvidence): boolean => evidence.inFlight === 0 && evidence.waiting === 0;

/** Every run guard, named and pure. */
const runGuards: MachineSpec<RunState, RunEvent, RunContext>['guards'] = {
  'configuration-resolved': {
    describe: 'the run snapshot names the resolved configuration it plans with',
    check: (_context, event) => event.type === 'plan' && named(event.configuration),
  },
  'stage-graph-resolved': {
    describe: 'planning resolved at least one stage to run',
    check: (_context, event) => event.type === 'start' && event.stages > 0,
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

/**
 * Every transition a run allows. A run never pauses, resumes or cancels after it
 * ended: `succeeded`, `completed_partial`, `blocked`, `failed` and `cancelled`
 * are terminal, and the next attempt is a new run on the same chain.
 */
const runTransitions: MachineSpec<RunState, RunEvent, RunContext>['transitions'] = [
  { id: 'run/created--plan-->planning', from: 'created', event: 'plan', to: 'planning', guards: ['configuration-resolved'], actions: ['snapshot-configuration', 'emit-progress'] },
  { id: 'run/planning--start-->running', from: 'planning', event: 'start', to: 'running', guards: ['stage-graph-resolved'], actions: ['close-planning-epoch', 'bump-planning-epoch', 'enqueue-stages', 'emit-progress'] },
  { id: 'run/running--complete-->succeeded', from: 'running', event: 'complete', to: 'succeeded', guards: ['planning-closed', 'nothing-runnable-in-flight-or-waiting', 'required-coverage-met', 'no-pending-publication'], actions: ['record-completion', 'emit-progress'] },
  { id: 'run/running--complete-partial-->completed_partial', from: 'running', event: 'complete-partial', to: 'completed_partial', guards: ['planning-closed', 'nothing-runnable-in-flight-or-waiting', 'no-pending-publication', 'required-coverage-unmet'], actions: ['record-partial-completion', 'emit-progress'] },
  { id: 'run/running--block-->blocked', from: 'running', event: 'block', to: 'blocked', guards: ['starvation-path-named'], actions: ['record-starvation', 'emit-progress'] },
  { id: 'run/running--fail-budget-exhausted-->failed', from: 'running', event: 'fail', to: 'failed', guards: ['cause-budget-exhausted'], actions: ['record-failure', 'emit-progress'] },
  { id: 'run/running--pause-->pausing', from: 'running', event: 'pause', to: 'pausing', guards: [], actions: ['record-pause-intent', 'emit-progress'] },
  { id: 'run/pausing--drain-->paused', from: 'pausing', event: 'drain', to: 'paused', guards: ['nothing-in-flight-or-waiting'], actions: ['record-paused', 'emit-progress'] },
  { id: 'run/paused--resume-->planning', from: 'paused', event: 'resume', to: 'planning', guards: [], actions: ['reopen-planning-epoch', 'emit-progress'] },
  { id: 'run/created--cancel-->cancelling', from: 'created', event: 'cancel', to: 'cancelling', guards: [], actions: ['revoke-run-authority', 'record-cancel-intent', 'emit-progress'] },
  { id: 'run/planning--cancel-->cancelling', from: 'planning', event: 'cancel', to: 'cancelling', guards: [], actions: ['revoke-run-authority', 'record-cancel-intent', 'emit-progress'] },
  { id: 'run/running--cancel-->cancelling', from: 'running', event: 'cancel', to: 'cancelling', guards: [], actions: ['revoke-run-authority', 'record-cancel-intent', 'emit-progress'] },
  { id: 'run/pausing--cancel-->cancelling', from: 'pausing', event: 'cancel', to: 'cancelling', guards: [], actions: ['revoke-run-authority', 'record-cancel-intent', 'emit-progress'] },
  { id: 'run/paused--cancel-->cancelling', from: 'paused', event: 'cancel', to: 'cancelling', guards: [], actions: ['revoke-run-authority', 'record-cancel-intent', 'emit-progress'] },
  { id: 'run/cancelling--drained-->cancelled', from: 'cancelling', event: 'drained', to: 'cancelled', guards: ['nothing-runnable-in-flight-or-waiting', 'no-pending-publication'], actions: ['record-cancelled', 'emit-progress'] },
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
export function newRunContext(): RunContext {
  return { planningEpoch: 0, planningClosed: false };
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

/** Every transition a product's chain allows: idle → active → quiescent and back to active. */
const chainTransitions: MachineSpec<ChainState, ChainEvent, ChainContext>['transitions'] = [
  { id: 'chain/idle--start-->active', from: 'idle', event: 'start', to: 'active', guards: ['run-named'], actions: ['record-active-run', 'emit-progress'] },
  { id: 'chain/active--settle-->quiescent', from: 'active', event: 'settle', to: 'quiescent', guards: ['nothing-outstanding'], actions: ['clear-active-run', 'emit-progress'] },
  { id: 'chain/quiescent--wake-->active', from: 'quiescent', event: 'wake', to: 'active', guards: ['run-named'], actions: ['record-active-run', 'emit-progress'] },
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
