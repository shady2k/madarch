# Hold the runner's wall-clock bounds out of a machine that is not that runner

Change: madarch-x9a7.6
Base: ec810f1f4dabec929c88b93e20a94d3eafc0ef50
Tasks: madarch-x9a7.6
Kind: no-behavior

## Intent
Rows 1–3 and 12 of the ALX-1543 list say that a handful of cases fail on a machine that is not the GitHub `ubuntu-24.04`, 4 vCPU runner: three of them assert an elapsed time whose bound belongs to that runner's shape, and one lowered the plugin host's own five-second silence bound to a second. Put the three timing assertions behind `MADARCH_SKIP_PERF` without changing a single number, and let the heartbeat case run under the bound the product actually sets.

## Rationale
The numbers stay where they are, and CI keeps asserting them on the shape they were measured on. Only the assertion is dropped where that shape is not the machine under test, so a slower box or a developer's laptop no longer reports the runner's speed as a defect. The heartbeat case proves the reader yields by a clockless count of the event-loop turns the read makes, so nothing about it depends on how fast the machine is either.

## Out of scope
- Changing any bound, deadline or number of files: 5 s, 50 ms, 200 ms, 5 ms, 400 ms and the eight hundred files all stay.
- Deciding whether the 200 ms, 5 ms and 400 ms bounds should exist at all: `madarch-x9a7` settles their disposition, and no user requirement was found for any of them.
- `plugins/imports/read.ts`: the reader is untouched, and the negative control only removes its yield to prove the new case sees it.
- `.github/workflows/single-file-timings.json`: the coordinator measures the moved files on the standard runner after this commit, and only that run may write the entries.
- Moving the cases into `test/measure/`.

## Changes to requirements
None. No requirement changes: three existing bounds keep their numbers and keep their evidence on the runner they were measured on, and one test stops lowering a bound the product chose.

## Preserved contracts
- fill-orchestrator/host: a status answer on a store whose last fill wrote a 150 000-span trace is bounded at 5 s for the first answer and 50 ms for the cached one, per `docs/changes/madarch-64o5.32/capabilities/fill-orchestrator.md:339`, with the assertions and numbers unchanged on the runner; and the imports producer keeps its heartbeat while it reads a repository, under the host's own five-second silence bound, with the case testing that bound instead of a lowered one, reading the same eight hundred files, and the reader answering one event-loop turn per file it reads, which the new clockless case proves without a clock.
- wiki/diagrams: the depth-1 diagram of a folder of 1 324 children still folds to four nodes and is still laid out in a process of its own; only the two wall-clock assertions are gated.

## Coverage
- fill-orchestrator/host: test
- wiki/diagrams: test

## Where it is seen
Kind: internal
Place: the test runs of the fill host's api role, the imports plugin and the diagram, on a machine that is not the GitHub runner
Reason: nothing a person reaches changes. The commit gates test assertions and adds one test case; no screen, route, string, command or product behaviour differs.

1. Run the five changed files with `MADARCH_SKIP_PERF=1` on a machine that is not the GitHub runner: every functional assertion runs, and the wall-clock assertions do not.
2. Run them again without the variable: every wall-clock assertion runs with its number unchanged.

## Blocking questions
None.

## Design and decisions
The guard is `if (process.env['MADARCH_SKIP_PERF'] === undefined)` — the spelling the existing cases use (`test/fill-static-heap.test.ts:39`, `test/history.test.ts:553`) — and each guard carries the source of its bound, or states that no user requirement was found for it and names the commit that introduced it (`ffa450754` for 200 ms, `105a9f597` for 5 ms and 400 ms), with the runner shape it belongs to. The clockless case counts the event-loop turns an immediate chain makes while `readRepository` reads 24 files: the reader owes one turn per file, and a read that never yields turns the timestamp into the defect.

## Acceptance evidence
Filled at acceptance from the task `madarch-x9a7.6`.

## DONE WHEN
The three wall-clock assertions are gated with every number unchanged and every functional assertion still unconditional; the heartbeat case runs under the host's five-second silence bound; a clockless case fails when the reader's yield is removed and passes with it; the changed files run green under `MADARCH_SKIP_PERF=1`; and the single-file timings for them are recorded from a standard-runner run.
