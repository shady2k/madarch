# The measurement suite

`test/measure/` holds every test that asserts elapsed time or memory. No other
folder may read an elapsed clock: that is rule 4 of `check:tests`, landing with
T2. A functional case checks behaviour; this suite checks speed. The suite is
given its own CI job, `measure`, on the same runner shape as the functional
tests (GitHub `ubuntu-24.04`, 4 vCPU); the job is added after ALX-342 splits the
suite, so this slice adds no workflow file.

`test/support/measure.ts` is the one way to take a measurement, and
`test/measure/measure.test.ts` is its deterministic unit test: the clock and the
baselines are injected, and no assertion reads or waits for the wall.

## A measurement

```ts
import { measure } from '../support/measure.js';

await measure('api-role-first-page: first status', async () => { await firstStatus(); }, {
  runs: 5,
  absolute: {
    ms: 5_000,
    source: {
      ref: 'docs/changes/madarch-64o5.32/capabilities/fill-orchestrator.md:339',
      quote: 'first answer arrives within 5 seconds and the unchanged second answer within 50 milliseconds',
    },
  },
});
```

`measure()` runs the case `runs` times (default 5, at least 3), takes the median
of the clock readings, and fails when either bound is passed:

- the **baseline**: `2 × medianMs` of the case's entry in `baselines.json`;
- the **absolute limit** the case names. `source` is `{ ref, quote }`: the reference names the file and line where the words stand, and validation reads that line and checks the quote occurs there. A missing file, line, or quote is refused. The quote must be present verbatim and cannot be a placeholder. A suite-wide statement (such as the owner's 15-minute remark on ALX-12) justifies no per-case limit. Words are not attributed to the owner unless the reference is to the owner.

A case whose name has no baseline fails naming `baselines.json` and the case:
record the median in the commit that measures it. An entry is taken on CI's
runner shape, in milliseconds, so a slower machine is told apart from a
regression by the factor, not by the entry.

## `baselines.json`

`test/measure/baselines.json` starts empty. Its schema, written beside it in
`baselines.schema.json`, is:

```json
{
  "schema": 1,
  "environment": "GitHub Actions ubuntu-24.04, 4 vCPU",
  "baselines": {
    "<case name>": {
      "medianMs": 41000,
      "runs": 5,
      "measuredAt": "2026-11-25",
      "commit": "<the commit that measured it>",
      "note": "optional"
    }
  }
}
```

`readBaselines` refuses an unknown field, a `medianMs` that is not a positive
number, and a `runs` below 3, and names the file, the case and the field. Only a
commit that carries a measurement changes a number.

## Work list: requirements to move here

Nothing is moved yet; this table is the work list for A8, from row A8 and
section 2 of the plan (ALX-340). A row's home is where the requirement stands
today, by file and line.

| requirement | current home | A8 action |
|---|---|---|
| 80 related kinds render within 200 ms warm | `test/catalogue-diagram.test.ts:99` (reading at `:91`) | — |
| the file catalogue's diagram within 200 ms | `test/catalogue-kind-relations.test.ts:161` (`:133`), gated by `MADARCH_SKIP_PERF` | — |
| a child stops within 10 s of SIGTERM; one ignoring SIGTERM stops within 10 s; one holding its output stops within 5 s | `test/child-stop.test.ts:20`, `:34`, `:48` | — |
| diagram fold under 5 ms, fold and layout under 400 ms | `test/diagram-budget.test.ts:51`, `:52`, gated by `MADARCH_SKIP_PERF` | — |
| another diagram answers under 650 ms while a CPU-looping renderer runs, and the looping one's timeout is answered under 1 500 ms | `test/diagram-route.test.ts:255`, `:258` | — |
| the static fill's peak per 100 files varies at most 25 % between 100, 200 and 400 files (memory) | `test/fill-static-heap.test.ts:77`, `:78`; `MADARCH_SKIP_PERF` at `:39` | — |
| `graphql-executor`: a diagram read over 1 324 children, bounded to its sample, under 2 s | `test/graphql-executor.test.ts:653` (reading at `:639`) | — |
| storing a new version of a 10 000-element model under 5 s | `test/history.test.ts:572`; `MADARCH_SKIP_PERF` at `:553` | — |
| an open stands behind another process's start over 300 ms, and a refusal waits at least 300 ms (ordering, not a speed bar) | `test/postgres-cluster-owner.test.ts:203`, `:298` | ordering, not a speed bar |
| producer reads keep one query count for 2 and 200 entities; the reading is printed | `test/producer-read.test.ts:27` (arrives with the 0039 stack `64fed185b`; query count at `:45`; no elapsed assertion) | — |
| two api and two fill roles: one press, polled for up to 600 s | `test/roles-two-and-two.test.ts:117`; `MADARCH_SKIP_PERF` at `:19` | — |
| a page answers under 500 ms while a render is stuck | `test/server-observability.test.ts:166` (reading at `:164`) | — |
| the first publication of `everything` through the `madarch init` path | `test/madarch-init-e2e.test.ts:80`; the press waits up to 3600 × 500 ms at `:197`, with no elapsed assertion | — |
| `graph-records`: the two passes over one fixture, 120 s (ALX-29) | `test/graph-records.test.ts:168` (case at `:156`) | — |
| `fill-states`: the press and the refusal, 300 s each | `test/fill-states.test.ts:115`, `:143` | — |
| `api-role-first-page`: the first status answer on a 150 000-span store within 5 s, the cached answer within 50 ms | `test/api-role-first-page.test.ts:77`, `:82`, gated by `MADARCH_SKIP_PERF` | — |
| process exits with stdout held: `expect(elapsed).toBeLessThan(10_000)` | `test/postgres-cluster-owner.test.ts:615` | measurement needed |
| foreign PID preparation: `expect(performance.now() - started).toBeLessThan(12_000)` | `test/postgres-cluster-owner.test.ts:637` | measurement needed |
| ACP install: `expect(Date.now() - started).toBeLessThan(2_500)` | `test/fill-acp-install.test.ts:260` | measurement needed |
| ignored SIGTERM: `expect(Date.now() - started).toBeGreaterThan(2_000)` before checking stopped process group | `test/fill-acp-install.test.ts:295` | controlled-timer event check: after SIGTERM, advance to just before `KILL_GRACE_MS` and assert no SIGKILL; advance to the grace deadline and assert SIGKILL; assert the process group has exited before tree removal. Replacing `KILL_GRACE_MS` with 0 must fail this check |
| PostgreSQL 404: `expect(Date.now() - started).toBeLessThan(10_000)` | `test/postgres-install.test.ts:189` | measurement needed |

Six files read `MADARCH_SKIP_PERF`, and three of them are this table's rows:
`fill-static-heap`, `history` and `roles-two-and-two`. The other three are
`api-role-first-page`, `catalogue-kind-relations` and `diagram-budget`: their
wall-clock assertions are gated (P2, `madarch-x9a7.6`) because the bounds are
the GitHub `ubuntu-24.04`, 4 vCPU runner's shape, and each names its source, or
says that no user requirement was found for it. `fill-static-heap` and `history`
read the variable as `!== undefined` (`test/fill-static-heap.test.ts:39`,
`test/history.test.ts:553`), `roles-two-and-two` as `=== '1'`
(`test/roles-two-and-two.test.ts:19`) and the P2 files as `!== undefined`; A8
settles that spelling with the variable's removal.
