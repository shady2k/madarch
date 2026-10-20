/**
 * One agent unit's limits (madarch-tzte.22.3; decision 0026, "Units and limits"): a
 * 272K-token window with a wrap-up signal at 70% and a hard stop at 80%, at most
 * ~30 turns, ~10 minutes and 16K output tokens, and "a unit at a limit returns what
 * it has with its coverage".
 *
 * Every expectation is taken from the decision and from the task, never from the
 * module: 0026's numbers (272000, 70%, 80%, 30, 10 minutes, 16000), the arithmetic
 * of a percentage of that window, and the words a stop must name. The clock is a
 * seam this test moves by hand, so ten minutes pass without waiting.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_STAGE_LIMITS } from '../src/fill/stage.js';
import {
  createUnitLimitGuard,
  unitLimitBounds,
  UNIT_LIMIT_CAUSES,
  watchUnitTimeLimit,
  type UnitLimitCause,
  type UnitLimitVerdict,
  type UnitTimers,
} from '../src/fill/unit-limits.js';

/** 0026's numbers, as the task and the decision state them. */
const WINDOW = 272_000;
const WRAP_AT = 0.7 * WINDOW;   // 190400
const STOP_AT = 0.8 * WINDOW;   // 217600

/** A clock the test moves by hand: a guard never sleeps and never reads the real time. */
function movableClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

/**
 * A timers seam the test fires by hand: the watch arms its deadline here and nothing
 * runs until the test says so. `fire` runs the callback armed last whether or not it
 * was cleared — a runtime that already queued a callback is what a disarm meets.
 */
function handTimers(): { readonly timers: UnitTimers; readonly waits: readonly number[]; readonly cleared: readonly unknown[]; fire(): void } {
  const callbacks: (() => void)[] = [];
  const waits: number[] = [];
  const cleared: unknown[] = [];
  return {
    waits,
    cleared,
    timers: {
      setTimeout: (callback: () => void, ms: number): unknown => { waits.push(ms); callbacks.push(callback); return callbacks.length; },
      clearTimeout: (handle: unknown): void => { cleared.push(handle); },
    },
    fire(): void {
      const callback = callbacks.pop();
      if (callback === undefined) throw new Error('the watch armed no timer for this test to fire');
      callback();
    },
  };
}

describe('the limits of one agent unit', () => {
  test('the bounds are 0026\'s numbers: 272K, 70%, 80%, ~30 turns, ~10 minutes, 16K output', () => {
    const bounds = unitLimitBounds(DEFAULT_STAGE_LIMITS);
    expect(bounds.contextTokens).toBe(WINDOW);
    expect(bounds.wrapAtTokens).toBe(Math.floor(WRAP_AT));
    expect(bounds.wrapAtTokens).toBe(190_400);
    expect(bounds.stopAtTokens).toBe(Math.floor(STOP_AT));
    expect(bounds.stopAtTokens).toBe(217_600);
    expect(bounds.maxTurns).toBe(30);
    expect(bounds.maxDurationMs).toBe(600_000);
    expect(bounds.maxOutputTokens).toBe(16_000);
    expect([...UNIT_LIMIT_CAUSES]).toEqual(['context', 'output', 'turns', 'time']);
  });

  test('a limit that cannot bound anything is refused by name, with the field it stands at', () => {
    expect(() => unitLimitBounds({ ...DEFAULT_STAGE_LIMITS, contextTokens: 0 })).toThrow(/contextTokens is 0: a limit is a whole number of at least 1/);
    // The refusal names this module's own file and line, which is what a reader acts on.
    expect(() => unitLimitBounds({ ...DEFAULT_STAGE_LIMITS, maxTurns: 2.5 })).toThrow(/src\/fill\/unit-limits\.ts:\d+:\d+: the unit's maxTurns is 2\.5/);
    expect(() => unitLimitBounds({ ...DEFAULT_STAGE_LIMITS, stopAtFraction: 1 })).toThrow(/stopAtFraction is 1: a fraction of the window is a number in \(0, 1\)/);
    expect(() => unitLimitBounds({ ...DEFAULT_STAGE_LIMITS, wrapAtFraction: 0.9, stopAtFraction: 0.8 })).toThrow(/wrap-up fraction 0\.9 is not below its stop fraction 0\.8/);
  });

  test('a unit below 70% is within its limits and is warned once, at the first moment past 70%', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    expect(guard.observe({ contextUsed: 100_000 }).kind).toBe('within');
    expect(guard.warned()).toBe(false);
    // Exactly 70% is past the signal: 0026 says "a wrap-up signal at 70%".
    const warned = guard.observe({ contextUsed: Math.floor(WRAP_AT) });
    expect(warned.kind).toBe('wrap');
    expect(guard.warned()).toBe(true);
    // The signal goes once: the next moment of the same turn is not a second warning.
    expect(guard.observe({ contextUsed: Math.floor(WRAP_AT) + 1 }).kind).toBe('within');
    const message = guard.wrapUpMessage();
    expect(message).toContain('wrap-up:');
    expect(message).toContain(`of its ${WINDOW}-token window`);
    expect(message).toContain('80%');
    // The message names what the unit spent, as the guard read it at that moment.
    expect(message).toContain('used 190401 of its 272000-token window (70%;');
  });

  test('80% of the window stops the unit, and the stop names the context it crossed', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    expect(guard.observe({ contextUsed: Math.floor(STOP_AT) - 1 }).kind).toBe('wrap');
    const stopped = guard.observe({ contextUsed: Math.floor(STOP_AT) });
    expect(stopped.kind).toBe('stop');
    if (stopped.kind !== 'stop') throw new Error('the unit was not stopped at 80% of its window');
    expect(stopped.cause).toBe('context');
    expect(stopped.state.used).toBe(217_600);
    expect(stopped.state.fraction).toBeCloseTo(0.8, 5);
    const words = guard.describe(stopped);
    expect(words).toContain('stopped at its context window');
    expect(words).toContain('217600 of 272000 tokens');
    expect(words).toContain('80%');
  });

  test('a window an agent names narrows the unit\'s own, and a million-token one never widens it', () => {
    const clock = movableClock();
    const narrow = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    // 0026: "a unit never relies on a 1M window". The unit's own 272K is the ceiling over whatever the agent says.
    expect(narrow.observe({ contextUsed: 100_000, contextSize: 1_000_000 }).kind).toBe('within');
    expect(narrow.state().window).toBe(WINDOW);
    // A narrower window moves both thresholds with it: 70% of 200000 is 140000 and 80% is 160000.
    expect(narrow.observe({ contextUsed: 139_000, contextSize: 200_000 }).kind).toBe('within');
    expect(narrow.observe({ contextUsed: 140_000 }).kind).toBe('wrap');
    const stopped = narrow.observe({ contextUsed: 160_000 });
    expect(stopped.kind).toBe('stop');
    expect(narrow.state().window).toBe(200_000);
    // The window never rises back: a wider report afterwards does not reopen the unit.
    expect(narrow.observe({ contextUsed: 160_000, contextSize: 1_000_000 }).kind).toBe('stop');
  });

  test('a turn count of 30 stops the unit, and the stop names the turns', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    expect(guard.observe({ contextUsed: 10_000, turns: 29 }).kind).toBe('within');
    const stopped = guard.observe({ turns: 30 });
    expect(stopped.kind).toBe('stop');
    if (stopped.kind !== 'stop') throw new Error('the unit was not stopped at 30 turns');
    expect(stopped.cause).toBe('turns');
    expect(guard.describe(stopped)).toContain('stopped at its turn limit: 30 of 30 turns');
  });

  test('ten minutes of wall clock stop the unit, and the time is the seam\'s own', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    clock.advance(599_999);
    expect(guard.observe({ contextUsed: 1_000 }).kind).toBe('within');
    clock.advance(1);
    const stopped = guard.observe({ contextUsed: 1_000 });
    expect(stopped.kind).toBe('stop');
    if (stopped.kind !== 'stop') throw new Error('the unit was not stopped at ten minutes');
    expect(stopped.cause).toBe('time');
    expect(stopped.state.elapsedMs).toBe(600_000);
    expect(guard.describe(stopped)).toContain('stopped at its time limit: 600 of 600 seconds');
  });

  test('16K output tokens stop the unit, and the stop names what it wrote', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    expect(guard.observe({ contextUsed: 1_000, outputTokens: 15_999 }).kind).toBe('within');
    const stopped = guard.observe({ outputTokens: 16_000 });
    expect(stopped.kind).toBe('stop');
    if (stopped.kind !== 'stop') throw new Error('the unit was not stopped at 16K output tokens');
    expect(stopped.cause).toBe('output');
    expect(guard.describe(stopped)).toContain('stopped at its output limit: 16000 of 16000 output tokens');
  });

  test('what madarch itself sent is the floor under an agent that reports no usage', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    // The packet alone is small; the session's own report is the larger figure while it exceeds madarch's count.
    guard.sent(20_000);
    expect(guard.observe({ contextUsed: 30_000 }).state.used).toBe(30_000);
    // An agent that reports nothing leaves madarch's own count standing, so "not reported" is not "no room used".
    const quiet = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    quiet.sent(200_000);
    const warned = quiet.observe({});
    expect(warned.kind).toBe('wrap');
    expect(warned.state.used).toBe(200_000);
    // The two counts are never added: 100000 sent and 180000 reported is 180000, not 280000.
    const both = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    both.sent(100_000);
    expect(both.observe({ contextUsed: 180_000 }).state.used).toBe(180_000);
    expect(() => both.sent(-1)).toThrow(/sent the unit -1 tokens/);
  });

  test('a report that is no count is refused by name rather than read as a smaller unit', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    expect(() => guard.observe({ contextUsed: Number.NaN })).toThrow(/reported NaN tokens in its context: a count of tokens is a number of no less than zero/);
    expect(() => guard.observe({ contextUsed: 1, contextSize: 0 })).toThrow(/named a context window of 0 tokens: a window holds at least one token/);
    expect(() => guard.observe({ turns: 1.5 })).toThrow(/ran 1\.5 turns: a count of turns is a whole number/);
  });

  test('the verdict a unit ends with is one a reader can act on, whatever it ended at', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    const within: UnitLimitVerdict = guard.observe({ contextUsed: 1_000, turns: 2 });
    expect(guard.describe(within)).toContain('within its limits: 1000 of 272000 tokens (0.4%)');
    expect(guard.describe(within)).toContain('2 of 30 turns');
  });
});

describe('the unit\'s clock reaches a turn that streams nothing', () => {
  test('the time left is 0026\'s ten minutes, read from the guard\'s own clock and never below zero', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    expect(guard.remainingMs()).toBe(600_000);
    clock.advance(599_999);
    expect(guard.remainingMs()).toBe(1);
    clock.advance(1);
    expect(guard.remainingMs()).toBe(0);
    // A clock past the limit leaves no time to arm, never a negative wait.
    clock.advance(120_000);
    expect(guard.remainingMs()).toBe(0);
  });

  test('a watch armed on that time answers the guard\'s own time limit, and nothing before it', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    const timers = handTimers();
    const stops: UnitLimitCause[] = [];
    const watch = watchUnitTimeLimit({ guard, timers: timers.timers, onStop: (cause) => stops.push(cause) });
    try {
      expect(timers.waits).toEqual([600_000]);
      // A fire before the limit judges the unit within it, and the watch arms again for the millisecond left.
      clock.advance(599_999);
      timers.fire();
      expect(stops).toEqual([]);
      expect(timers.waits).toEqual([600_000, 1]);
      clock.advance(1);
      timers.fire();
      expect(stops).toEqual(['time']);
      // The cause is the guard's own, and its words are 0026's ten minutes: the watch invents no limit.
      expect(guard.describe({ kind: 'stop', cause: 'time', state: guard.state() })).toContain('stopped at its time limit: 600 of 600 seconds');
    } finally {
      watch.disarm();
    }
  });

  test('a watch disarmed by the turn\'s own end stops, and a callback the runtime already queued does nothing', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    const timers = handTimers();
    const stops: UnitLimitCause[] = [];
    const watch = watchUnitTimeLimit({ guard, timers: timers.timers, onStop: (cause) => stops.push(cause) });
    watch.disarm();
    expect(timers.cleared).toEqual([1]);
    clock.advance(600_000);
    timers.fire();
    expect(stops).toEqual([]);
    // Nothing re-armed it, so the seam holds the one wait it was armed for and no second one.
    expect(timers.waits).toEqual([600_000]);
    expect(guard.remainingMs()).toBe(0);
  });

  test('a watch reports the wrap-up signal the guard crosses while the turn runs, and still bounds the time', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    const timers = handTimers();
    const stops: UnitLimitCause[] = [];
    let wraps = 0;
    // What madarch sent stands as the guard's floor when the agent reports nothing: 70% of 0026's window is crossed.
    guard.sent(190_400);
    const watch = watchUnitTimeLimit({ guard, timers: timers.timers, onStop: (cause) => stops.push(cause), onWrap: () => { wraps += 1; } });
    try {
      timers.fire();
      expect(wraps).toBe(1);
      expect(stops).toEqual([]);
      expect(guard.warned()).toBe(true);
      // The wrap-up message is a turn of its own, so the watch stays armed behind the turn in flight.
      expect(timers.waits).toEqual([600_000, 600_000]);
      clock.advance(600_000);
      timers.fire();
      expect(stops).toEqual(['time']);
      // A stopped watch arms nothing: the two waits above are every timer it ever asked for.
      expect(timers.waits).toEqual([600_000, 600_000]);
    } finally {
      watch.disarm();
    }
  });

  test('a watch the wrap-up handler disarms arms nothing behind it', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    const timers = handTimers();
    const stops: UnitLimitCause[] = [];
    guard.sent(190_400);
    // A caller may end the watch where it learns the unit is wrapping up — the turn it bounds may already be over.
    const watch = watchUnitTimeLimit({ guard, timers: timers.timers, onStop: (cause) => stops.push(cause), onWrap: () => watch.disarm() });
    try {
      timers.fire();
      expect(stops).toEqual([]);
      // Nothing is armed behind the disarm: the watch asked for one timer and cannot outlive it.
      expect(timers.cleared).toEqual([]);
      expect(timers.waits).toEqual([600_000]);
    } finally {
      watch.disarm();
    }
  });

  test('a unit with no time left is stopped by the first fire there is', () => {
    const clock = movableClock();
    const guard = createUnitLimitGuard({ limits: DEFAULT_STAGE_LIMITS, clock: clock.now });
    clock.advance(600_000);
    const timers = handTimers();
    const stops: UnitLimitCause[] = [];
    const watch = watchUnitTimeLimit({ guard, timers: timers.timers, onStop: (cause) => stops.push(cause) });
    try {
      // A timer of no milliseconds is one some runtimes fire at once and others refuse: the watch asks for the
      // shortest wait there is, and the guard answers the stop.
      expect(timers.waits).toEqual([1]);
      timers.fire();
      expect(stops).toEqual(['time']);
    } finally {
      watch.disarm();
    }
  });
});
