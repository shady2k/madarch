# A prompt turn that never streams is stopped at 0026's ten minutes, by a clock the unit's guard owns

Change: madarch-tzte.38
Base: dbf138d80a8a83a4b60f691e39fd18ee369dcf14
Tasks: madarch-tzte.38
Kind: behavior

## Intent

Decision 0026, "Units and limits": "at most ~30 turns, ~10 minutes, 16K output … A unit at a limit
returns what it has with its coverage; the scheduler splits the scope and runs the parts." The
agent unit stage reads those limits from the session's own events — every streamed `usage_update`
and every turn's end — and cancels the turn in flight when 80% of the window, the turn count or
the wall clock says so. A turn that streams nothing at all produces no event, so the ten minutes
never arrive: the stage waits inside `session.prompt` (`src/fill/stages/agent-unit.ts`), the
connection closes only when the attempt ends, and 0027's lease — a database row the sweep retries —
is the only thing behind it. The change record of madarch-tzte.22.3 named exactly this as its open
point, and this change answers it.

What lands:

- **`src/fill/acp.ts`** — a prompt turn takes the caller's `AbortSignal`. An aborted bound sends
  `session/cancel` and resolves the turn as `cancelled` without waiting for the agent, so a turn
  the agent never answers is bounded by madarch's clock and not by the agent's willingness to read
  a cancel. A signal already aborted when the prompt is asked sends no turn at all. A turn the
  agent ends first keeps its own stop reason, and a bound nobody needed cancels nothing.
- **`src/fill/unit-limits.ts`** — the guard says how much of its own time is left
  (`remainingMs()`), and `watchUnitTimeLimit` turns that clock into the one moment a turn that
  streams nothing cannot produce: it is armed on the timers the stage is given, asks the same guard
  at each fire, and answers the guard's own cause. A watch that finds the unit within its limits
  arms itself again for what is left; one that finds the wrap-up signal crossed reports it and
  stays armed behind the turn in flight.
- **`src/fill/stages/agent-unit.ts`** — every turn in flight is armed on that watch, on the stage's
  own timer seam (`AgentUnitWiring.timers`, this process's timers by default), and disarmed when
  the turn ends. The pass cancel and the run's cancellation both abort the turn rather than calling
  `session.cancel()` themselves, so one place ends a turn. A silent turn is therefore one the unit
  stops at with 0026's time limit, writes its coverage for and splits its scope over, exactly like
  a turn that streams what it does.

Tests: the guard's remaining time and the watch's four answers through a hand-fired timer seam;
the client's bounded turn against a fake agent that accepts the prompt and answers nothing at all,
cancel included — the cancel on the wire after the prompt, a signal aborted before the turn, a
turn the agent ends first, and an agent that stops reading its input, whose turn ends anyway; and,
end to end on a real orchestrator, a unit whose agent never ends its turn: the attempt ends, the
guard names the time limit, and the unit's coverage and its children are recorded. No test sleeps:
the clock and the timers are seams the tests move by hand.

## Out of scope

- **The rest of the unit's limits.** The 70% and 80% thresholds of the window, the turn count and
  the 16K output are judged where they already were — on the streamed reports and at each turn's
  end — and their words, numbers and causes do not move.
- **A bound on `initialize` and `session/new`.** Those already have their own bounds
  (`ConnectAcpOptions.timeoutMs`, `sessionTimeoutMs`), and 0026's limits are about a unit's turn.
- **What a stopped unit hands over.** The coverage, the split bounds and the publication are the
  landed ones: this change makes an existing end reachable, not a new outcome.
- **The lease, the sweep and the run's own control.** 0027's lease stays the bound behind a dead
  process; nothing here changes the orchestrator.

## Changes to requirements

- product-wiki: **replace** the requirement `acp-agent`. The baseline (at the `Base:` revision)
  says a turn "shall be cancellable: madarch sends `session/cancel`, answers any permission request
  pending at that moment as cancelled, and reads the turn's end as cancelled whether the agent
  answers with the `cancelled` stop reason or with the protocol's request-cancelled error." The
  new text keeps every sentence of it and adds: "A turn shall also end when the caller's own bound
  passes: madarch sends `session/cancel` and ends the turn as cancelled here, without waiting for
  the agent to answer, so a bound madarch sets is not the agent's to keep — 0026's ten minutes for
  a unit whose agent went silent. A prompt whose bound has already passed when it is asked shall
  send no turn at all." Its new scenario `acp-bounded-turn` is written with it; the complete
  requirement stands in `capabilities/product-wiki.md`.

## Preserved contracts

- fill-orchestrator/split: a unit that stops at a limit still hands its uncovered places to the orchestrator as its children, in code point order, bounded as before; what this change adds is that a silent turn reaches that stop instead of holding the attempt open.
- fill-orchestrator/publish: a unit's facts and its coverage are still published in one transaction, at most once per generation, with its reads rechecked; the coverage a unit writes after a silent turn is the same fact a turn that streams writes.
- fill-orchestrator/cancel: a cancelled run still aborts its attempts' signal and cancels the turn in flight; the turn is now ended by this client as well, so a cancelled attempt no longer waits for an agent's answer to `session/cancel`.
- fill-orchestrator/attempt: a worker still follows one unit through a lease, a draft, a validation and a publication under one fence, and a silent turn now reaches the unit's own end inside that attempt rather than at the lease's expiry.
- fill-stages/configuration: a product still narrows a unit's limits through its manifest and a run still snapshots what it resolved; the time a watch is armed for is the resolved `maxDurationMs`, so a product that shortens it shortens the bound.

## Coverage

- product-wiki/acp-agent: test
- fill-orchestrator/split: test
- fill-orchestrator/publish: test
- fill-orchestrator/cancel: test
- fill-orchestrator/attempt: test
- fill-stages/configuration: test

## Blocking questions

None.

## Design and decisions

Taken from decisions 0026 (units and limits) and 0027 (the orchestrator); nothing here re-decides
them.

- **The guard keeps the clock, the client keeps the protocol.** 0026's ten minutes are the unit's,
  read from the stage's resolved limits through the guard's own seam, so a product that narrows
  `maxDurationMs` narrows what stops the turn. The ACP client is told only that a turn's bound has
  passed; it is the one place that knows a turn ends through `session/cancel`, and it ends the
  turn on its own side as well, because a bound that waited for the agent to answer a cancel would
  be no bound for the case that matters — an agent that answers nothing.
- **The watch asks the guard rather than judging itself.** Its answer is the guard's verdict: the
  cause it reports is one of 0026's four, and the words a watching person reads come from
  `describe`, so the time limit is written in one place. A watch that finds the unit within its
  limits re-arms for what is left, which is also how a timer that fires early stays harmless.
- **A timer seam, not a sleep.** The stage arms the watch on `AgentUnitWiring.timers`, this
  process's timers by default. A test's seam calls the callback when the test says, so a deadline
  arrives in the test and the clock it reads is the one the test moves: no test waits and no test
  depends on wall-clock timing.
- **A turn in flight is the only thing a watch bounds.** The watch is armed just before the prompt
  is asked and disarmed when the turn ends, so nothing outlives the turn it was armed for, and a
  turn that ends first is never stopped by a bound it did not need.
- **The run's cancellation and the limit share one end.** Both abort the turn's controller: the
  client sends the protocol's cancel and stops waiting, so a cancelled run also stops paying for an
  agent that never answers.
- **A turn bounded before it was asked sends nothing.** A signal already aborted at the prompt
  returns cancelled with no turn on the wire, so no agent is asked a question madarch has already
  given up on.
- **Known limitations, named rather than hidden.** A turn this client ends is over for madarch but
  may still be open in the agent: the agent gets `session/cancel` and nothing more is awaited. The
  stage ends the unit's session at once (`connection.close()` ends the process group), which is
  what makes that safe; a caller that kept the connection would need the agent's own end before it
  asked the session another question. The cancel is a notification on the same ordered write queue
  as the prompt, so an agent that has stopped reading its standard input never sees it — which is
  why the turn ends on the caller's word and not on the cancel's delivery; `test/fill-acp.test.ts`
  proves that with a fake agent that reads nothing after `session/new`.
- **A run cancellation during a turn is untested, and named here.** The attempt's own signal now
  aborts the turn's controller (`turnInFlight.abort()`) exactly where a limit stop does, so the
  client ends the turn by the path the limit tests cover; no test drives a run cancellation while
  an ACP turn is in flight, because the attempt would have to be cancelled in the middle of a turn
  and the landed cancel tests use a stage that never prompts (`test/fill-orchestrator.test.ts`).
  What that path changes is one call for another in the same place; what it would need is a stage
  double whose attempt holds a turn open while the run is cancelled.
- **What the agent's own record can prove.** The stage closes the connection as soon as a turn
  ends, so a test that read the agent's record for the cancel would race the kill of the agent
  process: the record holds what the agent read, and nothing orders that read against `close()`.
  The end-to-end tests therefore assert the guard's own stop, the coverage and the split, and the
  protocol's cancel with the order it is sent in is asserted where it can be waited for — in
  `test/fill-acp.test.ts`, where the agent is not killed behind it.

## Acceptance evidence

The checks, each with its own exit status, at hand-over.

- `bun run check` (`tsc --noEmit`) exit 0 locally, at every commit of the branch and after the
  rebase onto `origin/main`.
- The focused suites in SkyPilot (`madarch-sky-test`, the owner's rule): `test/fill-unit-limits.test.ts`,
  `test/fill-acp.test.ts` and `test/fill-agent-unit.test.ts`, with their tests' own exit status,
  and CI on the exact SHA for the full suite.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature --change
  madarch-tzte.38 --candidate worktree --target origin/main`) exit 0.
- The independent read-only review over `git diff origin/main...HEAD` and its findings' answers.

## DONE WHEN

- A prompt turn that streams nothing and never answers is cancelled at 0026's ten minutes, through
  the guard's own clock, and the unit returns its partial result with its coverage instead of
  holding the attempt open.
