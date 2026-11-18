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

await measure('graph-records: two passes', async () => { await fill(); }, {
  runs: 5,
  absolute: {
    ms: 120_000,
    source: 'owner, 2026-11-18 (ALX-12): «Ну до 15 минут я бы еще понял.»',
  },
});
```

`measure()` runs the case `runs` times (default 5, at least 3), takes the median
of the clock readings, and fails when either bound is passed:

- the **baseline**: `2 × medianMs` of the case's entry in `baselines.json`;
- the **absolute limit** the case names. Its `source` is the owner's words,
  verbatim, and an error quotes them. A limit without those words is refused.

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

| requirement | current home |
|---|---|
| 80 related kinds render within 200 ms warm | `test/catalogue-diagram.test.ts:99` (reading at `:91`) |
| the file catalogue's diagram within 200 ms | `test/catalogue-kind-relations.test.ts:158` (`:133`) |
| a child stops within 10 s of SIGTERM; one ignoring SIGTERM stops within 10 s; one holding its output stops within 5 s | `test/child-stop.test.ts:20`, `:34`, `:48` |
| diagram fold under 5 ms, fold and layout under 400 ms | `test/diagram-budget.test.ts:47`, `:48` |
| another diagram answers under 650 ms while a CPU-looping renderer runs, and the looping one's timeout is answered under 1 500 ms | `test/diagram-route.test.ts:255`, `:258` |
| the static fill's peak per 100 files varies at most 25 % between 100, 200 and 400 files (memory) | `test/fill-static-heap.test.ts:77`, `:78`; `MADARCH_SKIP_PERF` at `:39` |
| `graphql-executor`: a diagram read over 1 324 children, bounded to its sample, under 2 s | `test/graphql-executor.test.ts:653` (reading at `:639`) |
| storing a new version of a 10 000-element model under 5 s | `test/history.test.ts:572`; `MADARCH_SKIP_PERF` at `:553` |
| an open stands behind another process's start over 300 ms, and a refusal waits at least 300 ms (ordering, not a speed bar) | `test/postgres-cluster-owner.test.ts:203`, `:298` |
| producer reads keep one query count for 2 and 200 entities; the reading is printed | `test/producer-read.test.ts:27` (arrives with the 0039 stack `64fed185b`; query count at `:45`; no elapsed assertion) |
| two api and two fill roles: one press, polled for up to 600 s | `test/roles-two-and-two.test.ts:117`; `MADARCH_SKIP_PERF` at `:19` |
| a page answers under 500 ms while a render is stuck | `test/server-observability.test.ts:166` (reading at `:164`) |
| the first publication of `everything` through the `madarch init` path | `test/madarch-init-e2e.test.ts:80`; the press waits up to 3600 × 500 ms at `:197`, with no elapsed assertion |
| `graph-records`: the two passes over one fixture, 120 s (ALX-29) | `test/graph-records.test.ts:168` (case at `:156`) |
| `fill-states`: the press and the refusal, 300 s each | `test/fill-states.test.ts:115`, `:143` |
| `api-role-first-page`: the first status answer on a 150 000-span store within 5 s, the cached answer within 50 ms | `test/api-role-first-page.test.ts:74`, `:79` |

The three files under `MADARCH_SKIP_PERF` are this table's rows for
`fill-static-heap`, `history` and `roles-two-and-two`. Two of them read the
variable as `!== undefined` (`test/fill-static-heap.test.ts:39`,
`test/history.test.ts:553`) and `roles-two-and-two` as `=== '1'`
(`test/roles-two-and-two.test.ts:19`); A8 settles that spelling with the
variable's removal.
