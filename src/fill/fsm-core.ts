/**
 * The declared, pure transition layer the fill's state machines share (decision 0027).
 *
 * A machine is a table. Every allowed transition names the state it leaves, the
 * event that triggers it, the state it enters, the guards that must all hold and
 * the actions it performs — each action either an effect the caller performs
 * after the new state is persisted or a context update XState applies while it
 * steps. XState's pure `transition` performs the step: nothing here reads a clock,
 * a database or an agent session, and no effect runs in place.
 *
 * A step the table does not allow is refused as a value with a stable code and a
 * sentence naming the state, the event and, when a guard refused it, the guard —
 * never as a thrown error and never as a silent no-op. A table that names an
 * undeclared guard or action, repeats a transition id or leaves a state
 * unreachable from the initial one is a construction error, thrown with this
 * module's path and the throwing line.
 */
import { fileURLToPath } from 'node:url';
import { assign, createMachine, transition as xstateTransition } from 'xstate';

const MODULE_PATH = fileURLToPath(import.meta.url);

/** The one frame above the helper that names where an error was raised: the file, its line and column. */
function throwSite(): string {
  // Frames 0 and 1 are this helper and `raise` itself; the first frame after them is the
  // line that raised, whether it is in this module or in the store that calls it.
  const frames = (new Error().stack ?? '').split('\n').slice(3);
  const frame = frames.find((candidate) => candidate.trim().startsWith('at '));
  const located = frame === undefined ? null : /\(?([^\s()]+):(\d+):(\d+)\)?\s*$/.exec(frame.trim());
  return located ? `${located[1]}:${located[2]}:${located[3]}` : MODULE_PATH;
}

/** Raises an error that names the file, line and column it was raised from, then what is wrong. */
export function raise(message: string): never {
  throw new Error(`${throwSite()}: ${message}`);
}

/** The shape every fill event shares: a `type` the table matches, plus the evidence its guards read. */
export interface FillEventObject { readonly type: string }

/** One allowed transition of a machine's table. */
export interface TransitionSpec<State extends string, Event extends FillEventObject> {
  /** Stable id, `<machine>/<from>--<event>-->` used in every refusal, in the journal and in the diagram. */
  readonly id: string;
  readonly from: State;
  readonly event: Event['type'];
  readonly to: State;
  /** Named guards that must all hold; empty when the table allows the transition unconditionally. */
  readonly guards: readonly string[];
  /** Named actions, in the order they are meant to happen. */
  readonly actions: readonly string[];
}

/** A named guard: a pure predicate over the persisted context and the event. */
export interface GuardSpec<Context, Event extends FillEventObject> {
  /** What the guard means, in the words the refusal and the diagram use. */
  readonly describe: string;
  readonly check: (context: Context, event: Event) => boolean;
}

/**
 * A named action. `effect` is performed by the caller after the new state is
 * persisted; `context` is a pure update XState applies while it steps.
 */
export type ActionSpec<Context, Event extends FillEventObject> =
  | { readonly kind: 'effect'; readonly describe: string }
  | { readonly kind: 'context'; readonly describe: string; readonly apply: (context: Context, event: Event) => Context };

/** A machine declaration: its states, its allowed transitions and every name they use. */
export interface MachineSpec<State extends string, Event extends FillEventObject, Context> {
  /** Stable machine id, also the refusal code's prefix. */
  readonly id: string;
  readonly initial: State;
  readonly states: readonly State[];
  readonly transitions: readonly TransitionSpec<State, Event>[];
  readonly guards: { readonly [name: string]: GuardSpec<Context, Event> };
  readonly actions: { readonly [name: string]: ActionSpec<Context, Event> };
}

/** A machine's state and context as they are persisted: plain data, never an XState object. */
export interface MachineSnapshot<State extends string, Context> {
  readonly state: State;
  readonly context: Context;
}

/** Why a step was refused: a stable code, a sentence and the rule that refused it. */
export interface Refusal<State extends string> {
  /** `<machine id>/<kind>`, one of `unknown-state`, `no-transition`, `guard-refused`. */
  readonly code: string;
  /** Names the state, the event and the guard that refused it. */
  readonly reason: string;
  readonly state: State;
  readonly event: string;
  /** The guard that refused the step, or null when the table has no such transition at all. */
  readonly guard: string | null;
  /** The transition ids the table declares for this state and event, empty when it declares none. */
  readonly transitions: readonly string[];
}

export type StepResult<State extends string, Context> =
  | {
    readonly ok: true;
    /** The transition id that was taken. */
    readonly transition: string;
    readonly state: State;
    readonly context: Context;
    /** The effects the caller performs, in order. */
    readonly effects: readonly string[];
  }
  | { readonly ok: false; readonly refusal: Refusal<State> };

/** A machine ready to step persisted snapshots; built once per module load. */
export interface FillMachine<State extends string, Event extends FillEventObject, Context> {
  readonly spec: MachineSpec<State, Event, Context>;
  initial(context: Context): MachineSnapshot<State, Context>;
  step(snapshot: MachineSnapshot<State, Context>, event: Event): StepResult<State, Context>;
  /** The table's transitions leaving a state, in declaration order. */
  from(state: State): readonly TransitionSpec<State, Event>[];
  /** The `stateDiagram-v2` this table renders to; the module's doc comment carries it and a test keeps the two equal. */
  mermaid(): string;
}

const codePointCompare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

interface XStateConfigState { on: Record<string, unknown[]> }

/** Checks a table before XState sees it: a machine that cannot be built must not step anything. */
function validateSpec<State extends string, Event extends FillEventObject, Context>(
  spec: MachineSpec<State, Event, Context>,
): void {
  if (spec.states.length === 0) raise(`machine ${spec.id} declares no states, in ${MODULE_PATH}`);
  if (!spec.states.includes(spec.initial)) raise(`machine ${spec.id} declares initial state "${spec.initial}", which is not among its states`);
  const seenStates = new Set<string>();
  for (const state of spec.states) {
    if (seenStates.has(state)) raise(`machine ${spec.id} declares state "${state}" twice`);
    seenStates.add(state);
  }
  const seenTransitions = new Set<string>();
  for (const [index, transition] of spec.transitions.entries()) {
    const at = `machine ${spec.id}, table entry ${index + 1} ("${transition.id}")`;
    if (seenTransitions.has(transition.id)) raise(`${at}: transition id declared twice`);
    seenTransitions.add(transition.id);
    if (!seenStates.has(transition.from)) raise(`${at}: leaves state "${transition.from}", which the machine does not declare`);
    if (!seenStates.has(transition.to)) raise(`${at}: enters state "${transition.to}", which the machine does not declare`);
    if (transition.event.trim() === '') raise(`${at}: names no event`);
    for (const guard of transition.guards) {
      if (!(guard in spec.guards)) raise(`${at}: names guard "${guard}", which the machine does not declare`);
    }
    for (const action of transition.actions) {
      if (!(action in spec.actions)) raise(`${at}: names action "${action}", which the machine does not declare`);
    }
  }
  // Every state must be reachable from the initial one, or the machine declares work nothing can start.
  const reached = new Set<string>([spec.initial]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const transition of spec.transitions) {
      if (reached.has(transition.from) && !reached.has(transition.to)) {
        reached.add(transition.to);
        grew = true;
      }
    }
  }
  const unreachable = spec.states.filter((state) => !reached.has(state)).sort(codePointCompare);
  if (unreachable.length > 0) raise(`machine ${spec.id} declares states no transition reaches: ${unreachable.join(', ')}`);
  const effects = Object.entries(spec.actions);
  for (const [name, action] of effects) {
    if (name.trim() === '') raise(`machine ${spec.id} declares an action with an empty name`);
    if (action.describe.trim() === '') raise(`machine ${spec.id} declares action "${name}" without a description`);
  }
  for (const [name, guard] of Object.entries(spec.guards)) {
    if (guard.describe.trim() === '') raise(`machine ${spec.id} declares guard "${name}" without a description`);
  }
}

/** Builds the fill machine a table declares, with XState performing every step. */
export function createFillMachine<State extends string, Event extends FillEventObject, Context>(
  spec: MachineSpec<State, Event, Context>,
): FillMachine<State, Event, Context> {
  validateSpec(spec);

  const configStates: Record<string, XStateConfigState> = {};
  for (const state of spec.states) configStates[state] = { on: {} };
  for (const transition of spec.transitions) {
    const on = configStates[transition.from]!.on;
    const candidates = (on[transition.event] ??= []);
    candidates.push({ target: transition.to, guard: transition.id, actions: [...transition.actions] });
  }

  // XState names one guard per transition: the composite holds when every declared guard holds.
  const machineGuards: Record<string, unknown> = {};
  for (const transition of spec.transitions) {
    machineGuards[transition.id] = ({ context, event }: { context: Context; event: Event }): boolean =>
      transition.guards.every((name) => spec.guards[name]!.check(context, event));
  }
  const machineActions: Record<string, unknown> = {};
  for (const [name, action] of Object.entries(spec.actions)) {
    if (action.kind === 'context') {
      machineActions[name] = assign(({ context, event }: { context: Context; event: Event }) => action.apply(context, event) as never);
    }
  }

  // The config is built from the table at load time; XState's own types describe a literal
  // state chart, so the declared one is handed over as the shape it validates at runtime above.
  const machine = createMachine(
    { id: spec.id, initial: spec.initial, context: {} as Context, states: configStates } as never,
    { guards: machineGuards, actions: machineActions } as never,
  );

  const transitionsFor = (state: State): readonly TransitionSpec<State, Event>[] =>
    spec.transitions.filter((transition) => transition.from === state);

  function refusal(
    state: State,
    event: Event,
    kind: 'unknown-state' | 'no-transition' | 'guard-refused',
    guard: string | null,
    candidates: readonly TransitionSpec<State, Event>[],
    transitionId: string | null = null,
  ): Refusal<State> {
    const ids = candidates.map((candidate) => candidate.id);
    const where = `${spec.id}: state "${state}" and event "${event.type}"`;
    const allowed = [...new Set(transitionsFor(state).map((candidate) => `${candidate.event}→${candidate.to}`))];
    const sentence = kind === 'unknown-state'
      ? `${where}: "${state}" is not a state of this machine`
      : kind === 'no-transition'
        ? `${where}: the table allows no transition (allowed from here: ${allowed.join(', ') || 'none; this state is terminal'})`
        : `${where}: guard "${guard}" refused "${transitionId ?? ''}" (${spec.guards[guard ?? '']?.describe ?? 'no such guard'})`;
    return { code: `${spec.id}/${kind}`, reason: sentence, state, event: event.type, guard, transitions: ids };
  }

  function step(snapshot: MachineSnapshot<State, Context>, event: Event): StepResult<State, Context> {
    const { state, context } = snapshot;
    if (!spec.states.includes(state)) return { ok: false, refusal: refusal(state, event, 'unknown-state', null, []) };
    const candidates = transitionsFor(state).filter((candidate) => candidate.event === event.type);
    if (candidates.length === 0) return { ok: false, refusal: refusal(state, event, 'no-transition', null, []) };

    const resolved = machine.resolveState({ value: state, context } as never);
    const [next, actions] = xstateTransition(machine, resolved, event);
    const target = next.value;
    if (typeof target !== 'string') raise(`machine ${spec.id}: state "${state}" is not atomic after event "${event.type}"; the fill's machines keep flat states`);

    if (target === state) {
      // XState found no transition whose guard holds. Name the guard that refused, from the table.
      for (const candidate of candidates) {
        const failed = candidate.guards.find((name) => !spec.guards[name]!.check(context, event));
        if (failed !== undefined) return { ok: false, refusal: refusal(state, event, 'guard-refused', failed, candidates, candidate.id) };
      }
      raise(`machine ${spec.id}: XState refused "${event.type}" in "${state}" although every declared guard holds; the table and the machine disagree`);
    }

    const taken = candidates.find((candidate) => candidate.to === target
      && candidate.guards.every((name) => spec.guards[name]!.check(context, event)));
    if (taken === undefined) raise(`machine ${spec.id}: XState entered "${target}" on "${event.type}" from "${state}", where the table declares no such transition`);
    const effects = taken.actions.filter((name) => spec.actions[name]!.kind === 'effect');
    const reported = (actions as { type: string }[]).map((action) => action.type).filter((type) => type in spec.actions);
    if (reported.length !== effects.length || reported.some((type, index) => type !== effects[index])) {
      raise(`machine ${spec.id}: transition "${taken.id}" declared effects [${effects.join(', ')}] but XState reported [${reported.join(', ')}]`);
    }
    return { ok: true, transition: taken.id, state: target as State, context: next.context as Context, effects };
  }

  function mermaid(): string {
    const ordered = [...spec.transitions].sort((left, right) => codePointCompare(left.from, right.from)
      || codePointCompare(left.event, right.event)
      || codePointCompare(left.to, right.to));
    const lines = ['stateDiagram-v2', `  [*] --> ${spec.initial}`];
    for (const transition of ordered) {
      const guards = transition.guards.length > 0 ? ` [${transition.guards.join(' & ')}]` : '';
      lines.push(`  ${transition.from} --> ${transition.to}: ${transition.event}${guards}`);
    }
    const terminals = spec.states.filter((state) => transitionsFor(state).length === 0).sort(codePointCompare);
    for (const terminal of terminals) lines.push(`  ${terminal} --> [*]`);
    return lines.join('\n');
  }

  return {
    spec,
    initial: (context: Context) => ({ state: spec.initial, context }),
    step,
    from: transitionsFor,
    mermaid,
  };
}
