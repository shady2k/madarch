# A sixty-second hang guard for tests that name no bound

Change: madarch-x9a7.5
Base: ec810f1f4dabec929c88b93e20a94d3eafc0ef50
Tasks: madarch-x9a7.5
Kind: no-behavior

## Intent

Rows 4–11 and 14 of the ALX-1516/1517 publication gate: eight cases in
`test/enabled-plugins-fixture.test.ts`, `test/graph-write.test.ts` and
`test/history.test.ts`, and one `afterAll` hook in
`test/removed-routes.test.ts`, were stopped at 5 000 ms on the box, although
`test/deadline.ts` declared ten seconds. The five seconds are Bun's own default:
the preload's default does not reach every file of a run that holds several
(measured 2026-10-20, madarch-cznn), and the runner passed no `--timeout`. On
GitHub's runner the same cases run in 0.3–1.8 s ([CI 45600096045][ci]); the box
is 4.5 times slower in the median, so the deadline, not the case, is what fails.
The owner-facing cost is a red shard and a merge that waits for a rerun it never
needed.

[ci]: https://github.com/shady2k/madarch/actions/runs/45600096045

## Out of scope

- Making any of the eight cases faster, and any change to their fixtures: the
  Architect's ruling says the fixtures are not to be repaired.
- Rows 1–3, 12 and 13, which are packages P2 and P3 of the same gate.
- An explicit `afterAll` bound in `test/removed-routes.test.ts`: the probe below
  shows `--timeout=60000` reaches hooks in Bun 1.4.2, so the fallback the ruling
  allows is not needed and the file is not touched.
- The 30-second single-file rule (`test/slow-files.json`,
  `SLOW_THRESHOLD_SECONDS` in `scripts/run-tests.ts`) and the suite budget
  (madarch-x9a7): unchanged, because the sixty seconds are a hang guard and not
  a licence for a slow test.
- `madarch-6mes`, which stays open.

## Rationale

`no-behavior`: no product source, fixture or assertion moves. What changes is
the deadline a test that names no bound of its own runs under, from Bun's
5 000 ms to 60 000 ms, and the runner now names that deadline as well as the
preload. The value is a hang guard: at least three times the worst single case
measured on the box (11.2 s).

## Changes to requirements

None. The deadline of the suite is a property of how the suite runs, not of what
any capability does.

## Preserved contracts

- model-history/store-version: storing a source's model at a commit and reading it as of that commit's valid time is unchanged; `test/history.test.ts` keeps every case, fixture and assertion, and only the deadline it runs under moves.
- model-history/replace: a new version still replaces what the source asserted, closing what it removes and reopening what it changes; the cases and their expected values are untouched.
- graph-queries/rebuild: the graph is still written by its one writer from the manifest's field bindings and rebuilt from the histories; `test/graph-write.test.ts` keeps its vertex, opinion and removal cases as they were.
- fill-stages/configuration: a product's manifest still enables, disables and limits a stage; `test/enabled-plugins-fixture.test.ts` keeps the fixture plugin selection and the kinds its plugins fill, assertions unchanged.

## Coverage

- model-history/store-version: test
- model-history/replace: test
- graph-queries/rebuild: test
- fill-stages/configuration: test

## Where it is seen

Kind: internal
Place: `bun run test`, CI's test shards and the single-file timing run

Reason: only the deadline a test runs under changes; nothing a person reaches moves.

1. A person runs `bun run test` on a machine slower than GitHub's runner and the cases that take five to eleven seconds pass instead of being stopped at 5 000 ms.

## Blocking questions

None.

## Design and decisions

- `scripts/run-tests.ts` appends `--timeout=60000` to `bun test`'s arguments when
  neither `--timeout=<ms>` nor `--timeout <ms>` is among the forwarded flags; a
  caller's own flag is forwarded unchanged and no default is added beside it.
- `test/deadline.ts` raises the preload's `setDefaultTimeout` to 60 000, so a
  run started in the folder directly — `bun test`, `bun test test/`, CI's
  shards, and `bun test` inside `wiki/app`, whose `test/deadline.ts` re-exports
  the engine's file — is covered whichever file the preload reaches.
- Probe outside the commit, two temporary files, the second holding a 6 s case
  and a 6 s `afterAll`, neither naming a bound, run together through
  `scripts/run-tests.ts` on the box: red at the base (case stopped at
  5 001.74 ms, hook stopped at 5 001.61 ms, exit 1) and green with the change
  (case 6 002.62 ms, hook 6 s, exit 0). The flag therefore reaches `afterAll` in
  Bun 1.4.2, and `test/removed-routes.test.ts` needs no explicit hook bound.
- `bunfig.toml`, `wiki/app/bunfig.toml`, `test/deadline.ts` and the lesson in
  `AGENTS.md` state the same thing: sixty seconds are a hang guard, and the
  30-second single-file rule and the suite budget stay.

## Acceptance evidence

- The probe above, its red and green logs kept with the evidence of the task.
- `bun run test --only test/e2e/run-tests.test.ts`: 20 pass, 0 fail, exit 0 on
  the box after the change; the two new cases name both rules.
- `bun run test --only test/enabled-plugins-fixture.test.ts --only
  test/graph-write.test.ts --only test/history.test.ts --only
  test/removed-routes.test.ts`: exit 0 on the box, once.
- `bun run check`: exit 0 on the committed tree.
- The single-file timing of every changed test file is recorded in
  `.github/workflows/single-file-timings.json` and is at most 30 s.
- CI's five shards, `checks`, `quarantine` and `test` on the pull request.

## DONE WHEN

A test that names no bound of its own runs under a sixty-second hang guard
whichever way the suite is started, a caller's own `--timeout` is kept, the four
affected files pass together once, and the single-file timings of the changed
test files are recorded.
