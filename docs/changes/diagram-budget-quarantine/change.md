# The diagram budget's wall-clock case is quarantined, and the fold's result stays required

Change: diagram-budget-quarantine
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-h9x5
Kind: no-behavior

## Intent

The depth-1 diagram's budget test holds two different claims over one fixture: what a folder of 1 324 children folds
to, and what the fold and the warm layout cost in milliseconds. The first is a value the code decides; the second is a
wall-clock measure of whatever machine runs it. The second fails intermittently on hosted runners: on `main`
6d176f981 shard 1 measured 403.56 ms against the 400 ms bound in GitHub run 46076856429 (job 140766503340) with the
fixture and the layout code unchanged, and older evidence on `madarch-h9x5` records the same assertion failing there
several times. Neither the 5 ms nor the 400 ms number has a stated source: both arrived in commit
`105a9f5973a225cf5767dafe45899fef92bc21bb` without one.

`test/diagram-budget.test.ts` therefore holds two cases over the same fixture. The fold's result — four nodes, the two
groups counted and linked to their list — stays in the required suite and is unchanged. The wall-clock claim keeps the
fixture, both numbers and the warm layout measurement, and runs under the repository's case-level quarantine
(`test/quarantine.ts`) for repair task `madarch-h9x5`; `docs/quarantine.md` records what restores it. Quarantined cases
run in the allowed-to-fail `quarantine` job, so the required suite stops failing on a hosted runner's scheduling while
the timing claim stays measured and visible.

## Rationale

One case cannot be half-required. The repository's per-case convention (`docs/quarantine.md`, `test/quarantine.ts`) is
the mechanism the project already has for exactly this: a literal marker names the repair task, the reason and the
commit that introduced the case, the case keeps its body and its bounds, and the allowed-to-fail job keeps running it.
Splitting the original case instead of leaving the timing assertions in place is what keeps the deterministic fold
assertions blocking, which the hosted failure never touched.

The `MADARCH_SKIP_PERF` gate inside the original case is gone with the split: the quarantine marker is now the one
switch that keeps the timing claim out of the ordinary run, and a second, silent switch inside a quarantined case would
let a run report a bound it never measured.

## Out of scope

- Raising, lowering or sourcing the 5 ms and 400 ms bounds. They stay as they are; `madarch-x9a7` settles their
  disposition, and only its outcome or the owner's words may change or drop them.
- The fold itself, its fixture and its numbers: no production code changes.
- Any other file's quarantine or slow-file placement. `test/diagram-budget.test.ts` is not in `test/slow-files.json`
  and its shard placement is unchanged.

## Changes to requirements

None. No capability or requirement describes how long a fold or a layout takes, and no behaviour of the product
changes: the same fixture folds to the same four nodes and lays out through the same code.

## Preserved contracts

- product-wiki/architecture: the same fixture still folds to the same four nodes, with the two groups counted and linked, and the same view is laid out by the same code; only the job that measures the milliseconds changes.

## Coverage

- product-wiki/architecture: test

## Where it is seen

Kind: internal
Place: `test/diagram-budget.test.ts`, and the `quarantine` job that runs the marked case
Reason: nothing a person reaches changes: the diagram code, the fixture and the two bounds are what they were, and only which CI job measures the milliseconds moves.

1. Open a product with a folder of 1 324 children in the wiki: its Architecture page still draws the same folded diagram, the same four nodes, and its view is laid out by the same code.
2. Open a pull request: the required shards run the fold's result and no wall-clock assertion, and the `quarantine` job reports the `madarch-h9x5` case with the milliseconds it measured.

## Blocking questions

None.

## Acceptance evidence

GitHub CI on the branch is the merge check: the required shards must pass with the fold case and the quarantined case
skipped, and the `quarantine` job must report the timing case's own result. In the box `alx1713-a` the two cases were
run alone on the corrected case `a80a6b712`, where the fixture is built before the fold's clock starts: the ordinary
run gives one pass and one skip, and `MADARCH_QUARANTINE=1` gives two passes with the warm layout at 99 ms. The
earlier 91 ms figure came from `a9da748d8`, where the fold clock still covered `folderHood()` and therefore timed a
different interval. `bun run check` exits 0 with `check:quarantine` listing
`test/diagram-budget.test.ts:47 madarch-h9x5 …`.

## DONE WHEN

The required shards pass on a hosted runner with no timing assertion in them, the `quarantine` job reports the
`madarch-h9x5` case and its result, and `docs/quarantine.md` names what restores the case once the bounds have a source
and hold on the required runner.
