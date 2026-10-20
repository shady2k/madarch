/**
 * The limits one agent unit runs inside (decision 0026, "Units and limits"): a
 * 272K-token context window with a wrap-up signal at 70% and a hard stop at 80%
 * (the rest of the window is the agent's room to reason and to answer), at most
 * ~30 turns and ~10 minutes of wall-clock time, and at most 16K output tokens.
 * A unit at a limit returns what it has with its coverage; the scheduler splits
 * its scope and runs the parts (madarch-tzte.22.3).
 *
 * The numbers are 0026's own and arrive here as the stage's resolved
 * configuration (`StageLimits`, `stage.ts`): the defaults are the decision's, and
 * a product may narrow them for its own fill (`fill.stages.<id>.limits`, 0027).
 * This module decides nothing about a wallet: it answers, from what the agent
 * session and this process report, whether the unit is still within its limits,
 * has reached the point where it is told to wrap up, or must be stopped — and
 * names the cause.
 *
 * **Where the token count comes from, and why it is two counts.** 0026 says
 * "madarch counts tokens from the session and the server". The session's own
 * figure is the agent's `usage_update` (`AcpUpdate.contextUsed`, the tokens the
 * agent says are in its context); the server's is what madarch itself put into that
 * context — the packet, the wrap-up message and every turn's prompt (`sent`), and
 * the answers the unit's own MCP server returned (`src/fill/unit-tools.ts` counts
 * them per session, and the unit adds what it has answered since the last turn).
 * The unit's account is the larger of the two counts: an agent that reports a fuller
 * context than madarch's own sum is the one to believe, and an agent that reports
 * nothing at all leaves madarch's own sum as the floor, so "not reported" is never
 * read as "no room used". The two are never added: the session's figure already
 * holds what madarch sent, and a sum of the two would count the packet twice.
 *
 * **Nothing here waits, and the guard's clock also reaches a silent turn.**
 * Every moment is read from the clock the caller passes, and the guard is
 * evaluated on the events a session produces — each streamed update and each
 * turn's end. A test moves that clock by hand and its scenario crosses ten
 * minutes without sleeping; a real run reads `Date.now`. A turn that sends
 * nothing at all is not an event, so the stage arms `watchUnitTimeLimit` on the
 * timers it is given: the watch reads this same clock, and when the unit's
 * remaining time is gone it answers the guard's own verdict — the time limit —
 * and the turn in flight is cancelled (madarch-tzte.38). A watch is no second
 * judge: it asks the guard, and its cause is the guard's.
 */
import { here, raise } from './fsm-core.js';
import type { StageLimits } from './stage.js';

/** Why a unit was stopped or warned: one limit of 0026's four. */
export type UnitLimitCause = 'context' | 'output' | 'turns' | 'time';

/** Every cause, in the order this module checks them: the window first, then what the turn spent, then the count of turns and the time. */
export const UNIT_LIMIT_CAUSES: readonly UnitLimitCause[] = ['context', 'output', 'turns', 'time'];

/** What one moment of a unit's session says about its limits: wherever a figure is known. */
export interface UnitMoment {
  /** Tokens the agent says are in the session's context, from a `usage_update`. */
  readonly contextUsed?: number;
  /** The context window the agent names, from the same `usage_update`; the unit's own window holds where none is named. */
  readonly contextSize?: number;
  /** Output tokens the agent reports for the session, its latest report (never a sum of reports). */
  readonly outputTokens?: number;
  /** Prompt turns the session has run. */
  readonly turns?: number;
}

/** One unit's limits, as this module reads them, with the two thresholds in tokens. */
export interface UnitLimitBounds {
  readonly contextTokens: number;
  readonly wrapAtTokens: number;
  readonly stopAtTokens: number;
  readonly maxTurns: number;
  readonly maxDurationMs: number;
  readonly maxOutputTokens: number;
}

/** What a unit's limits are at one moment, as a report or a limit's own words name them. */
export interface UnitLimitState {
  readonly bounds: UnitLimitBounds;
  /** The larger of the session's reported context and what madarch itself sent. */
  readonly used: number;
  /** The window the fraction is taken of: the agent's own where it named one, the unit's otherwise. */
  readonly window: number;
  /** How many of that window's tokens are used, in [0, 1]; a window of no tokens reads as a full one. */
  readonly fraction: number;
  readonly turns: number;
  readonly elapsedMs: number;
  readonly outputTokens: number;
}

/** What the guard answers about one moment. */
export type UnitLimitVerdict =
  | { readonly kind: 'within'; readonly state: UnitLimitState }
  | { readonly kind: 'wrap'; readonly state: UnitLimitState }
  | { readonly kind: 'stop'; readonly cause: UnitLimitCause; readonly state: UnitLimitState };

/** What the guard holds and answers; one guard per attempt. */
export interface UnitLimitGuard {
  /** One moment of the session: the agent's report, madarch's own count, and how many turns ran. */
  observe(moment: UnitMoment): UnitLimitVerdict;
  /**
   * Records what madarch itself put into the session, in tokens: the packet, a
   * wrap-up message, a turn's prompt, and — as the unit adds them each turn — the
   * answers the unit's own MCP server returned.
   */
  sent(tokens: number): void;
  /** The limits as they stand, without observing anything. */
  state(): UnitLimitState;
  /**
   * How long the unit may still run before its time limit, read from the same
   * clock and never below zero: what a watch is armed for while a turn runs.
   */
  remainingMs(): number;
  /** Whether the wrap-up signal was already sent: it goes once, at the first moment past 70%. */
  warned(): boolean;
  /** The wrap-up message to send the agent, naming the fraction used and what to do. */
  wrapUpMessage(): string;
  /** One sentence a reader acts on, naming the limit the unit stopped at and what it had used. */
  describe(verdict: UnitLimitVerdict): string;
}

/** The bounds one stage's resolved limits name, refused by name where a number cannot bound anything. */
export function unitLimitBounds(limits: StageLimits, at = here()): UnitLimitBounds {
  const whole = (field: keyof StageLimits, value: number, least: number): number => {
    if (!Number.isInteger(value) || value < least) raise(`${at}: the unit's ${field} is ${String(value)}: a limit is a whole number of at least ${least}`);
    return value;
  };
  const contextTokens = whole('contextTokens', limits.contextTokens, 1);
  const fraction = (field: 'wrapAtFraction' | 'stopAtFraction'): number => {
    const value = limits[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) raise(`${at}: the unit's ${field} is ${String(value)}: a fraction of the window is a number in (0, 1)`);
    return value;
  };
  const wrapAtFraction = fraction('wrapAtFraction');
  const stopAtFraction = fraction('stopAtFraction');
  if (wrapAtFraction >= stopAtFraction) raise(`${at}: the unit's wrap-up fraction ${wrapAtFraction} is not below its stop fraction ${stopAtFraction}: the unit is told to wrap up before it is stopped`);
  return {
    contextTokens,
    // Both thresholds are whole tokens, rounded down: a warning at 70% of 272000 is at token 190400, and no
    // fraction of a token can make a unit cross one earlier than the number it names.
    wrapAtTokens: Math.floor(contextTokens * wrapAtFraction),
    stopAtTokens: Math.floor(contextTokens * stopAtFraction),
    maxTurns: whole('maxTurns', limits.maxTurns, 1),
    maxDurationMs: whole('maxDurationMs', limits.maxDurationMs, 1),
    maxOutputTokens: whole('maxOutputTokens', limits.maxOutputTokens, 1),
  };
}

/**
 * One unit's guard. It holds the attempt's start (the clock's own reading when it
 * was made), the largest context the session reported, how much madarch itself
 * sent, the turns that ran and the output the agent last reported — and it answers
 * about each moment without ever reading the clock for itself beyond the caller's
 * seam.
 */
export function createUnitLimitGuard(options: { readonly limits: StageLimits; readonly clock: () => number; readonly startedAt?: number }): UnitLimitGuard {
  const bounds = unitLimitBounds(options.limits);
  const startedAt = options.startedAt ?? options.clock();
  if (!Number.isFinite(startedAt)) raise(`the unit's guard was started at ${String(startedAt)}: the clock a guard reads answers a finite time in milliseconds`);
  let reported = 0;
  let window = bounds.contextTokens;
  /** What madarch itself put into the session; the floor under an agent that reports no usage. */
  let sent = 0;
  let turns = 0;
  let outputTokens = 0;
  let warned = false;
  const state = (): UnitLimitState => {
    const used = Math.max(reported, sent);
    const elapsedMs = Math.max(0, options.clock() - startedAt);
    return {
      bounds,
      used,
      window,
      fraction: window <= 0 ? 1 : used / window,
      turns,
      elapsedMs,
      outputTokens,
    };
  };
  return {
    state,
    remainingMs: (): number => Math.max(0, bounds.maxDurationMs - state().elapsedMs),
    sent(tokens: number): void {
      if (!Number.isFinite(tokens) || tokens < 0) raise(`madarch sent the unit ${String(tokens)} tokens: a count of tokens is a number of no less than zero`);
      sent += Math.floor(tokens);
    },
    warned: () => warned,
    observe(moment: UnitMoment): UnitLimitVerdict {
      if (moment.contextUsed !== undefined) {
        // A report of no tokens is a report: the agent's own figure replaces what it said before, and the
        // largest it ever said is what the window holds — a context that shrank is still a full one to plan by.
        if (!Number.isFinite(moment.contextUsed) || moment.contextUsed < 0) raise(`the unit's agent reported ${String(moment.contextUsed)} tokens in its context: a count of tokens is a number of no less than zero`);
        reported = Math.max(reported, Math.floor(moment.contextUsed));
      }
      if (moment.contextSize !== undefined) {
        if (!Number.isFinite(moment.contextSize) || moment.contextSize < 1) raise(`the unit's agent named a context window of ${String(moment.contextSize)} tokens: a window holds at least one token`);
        // The agent's own window is the one its report is against, and 0026's 272K is the ceiling over it: a
        // narrower window an agent names stops the unit earlier, and a wider one — a million-token model — never
        // buys it a unit of 0026's fill ("a unit never relies on a 1M window"). A window the unit has already
        // narrowed to stands: a later report of a wider one does not reopen the room it lost.
        window = Math.max(1, Math.min(window, Math.floor(moment.contextSize), bounds.contextTokens));
      }
      if (moment.outputTokens !== undefined) {
        if (!Number.isFinite(moment.outputTokens) || moment.outputTokens < 0) raise(`the unit's agent reported ${String(moment.outputTokens)} output tokens: a count of tokens is a number of no less than zero`);
        outputTokens = Math.max(outputTokens, Math.floor(moment.outputTokens));
      }
      if (moment.turns !== undefined) {
        if (!Number.isInteger(moment.turns) || moment.turns < 0) raise(`the unit ran ${String(moment.turns)} turns: a count of turns is a whole number of no less than zero`);
        turns = Math.max(turns, moment.turns);
      }
      const now = state();
      const crossed = (): UnitLimitCause | undefined => {
        if (now.used >= Math.floor(now.window * (bounds.stopAtTokens / bounds.contextTokens))) return 'context';
        if (now.outputTokens >= bounds.maxOutputTokens) return 'output';
        if (now.turns >= bounds.maxTurns) return 'turns';
        if (now.elapsedMs >= bounds.maxDurationMs) return 'time';
        return undefined;
      };
      const cause = crossed();
      if (cause !== undefined) return { kind: 'stop', cause, state: now };
      // The wrap threshold is the whole number of tokens the fixed part tells the unit (the same floor the stop
      // takes), so the promise and the behaviour are one number.
      const wrapsAt = Math.floor(now.window * (bounds.wrapAtTokens / bounds.contextTokens));
      if (warned || now.used < wrapsAt) return { kind: 'within', state: now };
      warned = true;
      return { kind: 'wrap', state: now };
    },
    wrapUpMessage(): string {
      const now = state();
      // The message is a turn of its own (ACP cannot speak into a turn in flight): the unit is told how much
      // of its window it spent and that this turn is its last chance to put what it has into the graph.
      return [
        `wrap-up: this unit has used ${String(now.used)} of its ${String(now.window)}-token window (${percent(now.fraction)}; 0026's wrap-up signal is at 70%, its hard stop at 80%).`,
        'Stop reading new material now. Write what you have already established as facts through this session\'s tools, then answer with the result object the unit contract asks for, naming what you covered and what you did not.',
      ].join(' ');
    },
    describe(verdict: UnitLimitVerdict): string {
      const now = verdict.state;
      if (verdict.kind === 'within') return `within its limits: ${String(now.used)} of ${String(now.window)} tokens (${percent(now.fraction)}), ${String(now.turns)} of ${String(bounds.maxTurns)} turns, ${String(Math.round(now.elapsedMs / 1000))} of ${String(Math.round(bounds.maxDurationMs / 1000))} seconds`;
      if (verdict.kind === 'wrap') return `at its wrap-up signal: ${String(now.used)} of ${String(now.window)} tokens (${percent(now.fraction)})`;
      switch (verdict.cause) {
        case 'context': return `stopped at its context window: ${String(now.used)} of ${String(now.window)} tokens (${percent(now.fraction)}; 0026's hard stop at 80%)`;
        case 'output': return `stopped at its output limit: ${String(now.outputTokens)} of ${String(bounds.maxOutputTokens)} output tokens`;
        case 'turns': return `stopped at its turn limit: ${String(now.turns)} of ${String(bounds.maxTurns)} turns`;
        case 'time': return `stopped at its time limit: ${String(Math.round(now.elapsedMs / 1000))} of ${String(Math.round(bounds.maxDurationMs / 1000))} seconds`;
      }
    },
  };
}

/**
 * The timers a unit's watch is armed on. A real run leaves this out and the
 * stage arms the process's own; a test hands its own, so the deadline arrives
 * when the test says and nothing waits.
 */
export interface UnitTimers {
  /** Calls `callback` once `ms` have passed, as `setTimeout` does in a process; the handle returns to `clearTimeout`. */
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** This process's own timers: the watch a real run arms. */
export const PROCESS_TIMERS: UnitTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

/** What a watch answers its caller. */
export interface UnitWatch {
  /** Stops the watch: a callback that fires after this line judges nothing, and a pending one is cleared. */
  disarm(): void;
}

/**
 * The watch one turn in flight is armed on: it reads the unit's own clock
 * through the timers it is given, so the guard judges a turn that streams
 * nothing at all (madarch-tzte.38). It is armed for the time the guard has left,
 * asks the guard at each fire, and answers the guard's verdict — a stop is the
 * guard's own cause, never a limit the watch invented — so 0026's ten minutes
 * reach a silent turn exactly as they reach one that streams its progress.
 *
 * A watch that finds the unit within its limits arms itself again for what is
 * left, and one that finds the wrap-up signal crossed reports it and arms itself
 * once more: the wrap-up is a turn of its own, and the time limit still stands
 * behind the turn in flight.
 */
export function watchUnitTimeLimit(options: {
  readonly guard: UnitLimitGuard;
  readonly timers: UnitTimers;
  /** Called once, with the guard's own cause, when the unit must stop. */
  readonly onStop: (cause: UnitLimitCause) => void;
  /** Called where the guard crosses 70% while the turn runs: the wrap-up message is the unit's next turn. */
  readonly onWrap?: () => void;
}): UnitWatch {
  let handle: unknown = undefined;
  let armed = false;
  let disarmed = false;
  const fire = (): void => {
    armed = false;
    if (disarmed) return;
    const judged = options.guard.observe({});
    if (judged.kind === 'stop') {
      options.onStop(judged.cause);
      return;
    }
    if (judged.kind === 'wrap') options.onWrap?.();
    // A caller that disarmed the watch from `onWrap` armed nothing: a timer here would outlive the turn it bounded.
    if (!disarmed) arm();
  };
  const arm = (): void => {
    armed = true;
    // A unit with no time left is armed for the shortest wait there is: the guard answers the stop on the fire, and
    // a timer of its own of no milliseconds is a timer some runtimes fire at once and others refuse.
    handle = options.timers.setTimeout(fire, Math.max(1, options.guard.remainingMs()));
  };
  arm();
  return {
    disarm(): void {
      disarmed = true;
      if (!armed) return;
      armed = false;
      options.timers.clearTimeout(handle);
    },
  };
}

/** A fraction of a window as a reader reads it: a percentage to one decimal place. */
function percent(fraction: number): string {
  return `${String(Math.round(fraction * 1000) / 10)}%`;
}
