# Ten seconds per test, in a preload both suites read

Change: madarch-tzte.36
Base: c0a297f8f3c9a995685a486e81e508d8563f251b
Tasks: madarch-tzte.36
Kind: no-behavior

## Intent

CI's suite fails merges at random. Several tests take 5.0-6.0 s on GitHub's
runners against Bun's five-second default — `server-graphs`, `server-views`,
`hub`, `requirements-resolve` — so a shard goes red on a test that passes on its
own and a merge waits for a rerun it never needed. The owner's decision
(2026-10-19 09:40 MSK, "make it ten seconds per test for now"): every test runs
under a ten-second bound until the slow ones are fixed.

Where the bound lives was measured, not assumed. Bun 1.4.2 does read
`bunfig.toml`'s `[test]` section — the scratch preload declared there runs — but
it does not apply `[test] timeout`: with `timeout = 10000` there, and with
`timeout = "10s"`, and with `testTimeout = 10000`, a test that sleeps 7 s still
fails at 5 003 ms. `setDefaultTimeout(10_000)` from a preload does take effect,
so both `bunfig.toml` files preload `test/deadline.ts` beside the scratch one,
and the app's copy re-exports the engine's file the way its scratch preload does.

## Rationale

What the suite proves does not change: every assertion, fixture and test file
stays as it was, and only the deadline of a test that names none of its own
moves, from 5 000 ms to 10 000 ms. A test that names its own bound keeps it —
`test/product-cli.test.ts` (15 s and 12 s), `test/fill-claims.test.ts` (60 s) and
the repeated-render test of `model-check/views` (15 s) run exactly as before.

What moves besides the deadline is two preload lines and one new file of ten
lines that states the bound: no product source, no fixture, no assertion.

The preserved references below are the requirements the suites that crossed the
default prove, and the one whose own bound this change must not take away.

## Out of scope

- Making any test faster. That is madarch-cznn, next milestone; the deadline
  comes back down with it.
- Any test's own bound: a test that passes a timeout to `test(...)` keeps it.
- Any assertion, fixture or product source.
- CI's job timeouts and the shard split, untouched.
- bunfig's own `[test] timeout` key: it is not set, because it does nothing on
  1.4.2 and a key that looks live but is not would mislead the next reader. The
  measurement stands in "Design and decisions"; a Bun that honours the key makes
  adding the line a one-line change.

## Changes to requirements

None. The deadline is a property of how the suite runs, not of what any
capability does.

## Preserved contracts

- model-check/requirements-resolve: the check still reports every unresolved requirement as a failure naming the scenario, the requirement, the model file and the line, and which of the two is missing; only the deadline of the suite that proves it moves.
- server/view: `POST /views` still answers with the one-view renderer's own text for the source's graph, and a request it cannot answer still explains why; only the deadline moves.
- model-check/views: the repeated-render test keeps the 15-second bound it names itself; the suite-wide default does not reach it.

## Coverage

- model-check/requirements-resolve: test
- server/view: test
- model-check/views: test

## Blocking questions

None.

## Design and decisions

- The bound is `setDefaultTimeout(10_000)` in `test/deadline.ts`, a preload both
  `bunfig.toml` files declare beside `test/run-scratch.ts`; the app's
  `wiki/app/test/deadline.ts` re-exports the engine's file, the way its scratch
  preload does, so one number rules both suites. A preload reaches every run
  started in the folder — `bun test`, `bun test test/`, CI's shards, and
  `bun test` inside `wiki/app` — where `--timeout` reaches only the run that
  passes the flag.
- Measured on Bun 1.4.2 on the SkyPilot pod, 2026-10-19, with one throwaway case
  file that never entered the repository: three tests, one sleeping 7 s with no
  bound of its own, one sleeping 12 s with none, one sleeping 12 s under its own
  20 s.
  - `[test] timeout = 10000` in `bunfig.toml`: the 7 s test fails at 5 004 ms.
    The same with `timeout = "10s"` (5 005 ms) and with `testTimeout = 10000`
    (5 004 ms). The file is read all the same: in the first of those runs the
    preload it declares put `MADARCH_TEST_SCRATCH` and `HOME` inside the run's
    scratch folder.
  - `bun test --timeout 10000`: the 7 s test passes, 7 002 ms.
  - `setDefaultTimeout(10_000)` from a preload: the 7 s test passes (7 003 ms),
    the 12 s one fails at 10 001 ms, and the 12 s one with its own 20 s passes
    (12 004 ms).
- With the files as committed, in both suites: the engine's 7 s test passes
  (7 004 ms), its 12 s test fails at 10 004 ms, its 12 s test with its own bound
  passes (12 003 ms); the wiki app's suite gives 7 004 ms, 10 004 ms and
  12 004 ms.
- Mutation sample: with `setDefaultTimeout` commented out of `test/deadline.ts`,
  the same file in both suites goes back to failing the 7 s test at 5 004 ms and
  the 12 s one at 5 005 ms, while the 12 s test with its own bound still passes
  (12 003 ms) — the call is what sets the bound in both suites, and nothing else
  in the tree does.
- Nothing is committed to prove the deadline: a committed test would have to
  sleep past it on every run, and the owner asked for the throwaway proof. What
  CI checks is that the suite passes under the new bound.

## Acceptance evidence

ACCEPTANCE

## DONE WHEN

Every test of both suites runs under a ten-second bound: a test that sleeps 7 s
passes, one that sleeps 12 s fails, and a test that names its own longer bound
keeps it, in `bun test` of the engine and of the wiki app; CI is green on the
change; madarch-cznn is named as the follow-up that brings the bound down.
