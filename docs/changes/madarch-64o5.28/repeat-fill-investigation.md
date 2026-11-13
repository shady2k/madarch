# PR280 controlled repeat-fill investigation (base 4772e82f)

This checkpoint adds regression coverage, not a production performance repair.
The changed-input repeat-fill slowdown remains unresolved. No production files,
configuration constants, budgets, bounds, hooks, sandbox policy or assertions were relaxed.

## Controlled measurement

Fresh native Bun processes used the same one-file/sample-pages fixture and
`MADARCH_PLUGIN_SANDBOX=off`; this is diagnostic, not enforced acceptance.
The third phase changes nothing after the second phase. Times are fill-only.

| Phase | Fill seconds | Plugin starts | Work units | Scheduler passes | Inherited roots |
| --- | ---: | ---: | ---: | ---: | ---: |
| First fill | 50.278 | 23 | 39 | 40 | 0 |
| Product newline committed | 48.553 | 23 | 39 | 40 | 0 |
| Repeat with no edit | 4.122 | 0 | 0 | 1 | 8 |

A separate fresh pre-change newline repeat measured 46.728 seconds. The earlier
45.126-second result is the same changed-input case; these measurements are not
before/after speedups. There is no production change in this checkpoint.

## Why these inputs differ

The benchmark appends a newline to `docs/domains/payment.md` and commits it in
the product repository. Filesystem-capable disk/git plugins receive complete
repository snapshots and pin metadata. Disk facts include the pinned commit in
their evidence, and git interprets commit history. Their inputs therefore change
although many visible values remain equal. Ignoring HEAD would retain stale
provenance. The no-edit case already skips all plugin work and exposes inherited
successful producer outcomes as `unchanged` in committed reads.

Speculative graph-only pin narrowing was stopped without production edits:
it would not improve this disk/git-only fixture. Replaying old immutable snapshot
queries also needs care before any future graph-only cache optimization. No
current-generation or failure gate was weakened.

## Phase detail

The changed-input phase recorded 6,824 SQL statements / 20.833 summed seconds,
13.499 seconds of scheduler passes, 10.026 seconds of plugin.unit spans,
1.477 seconds of handshake spans and 5.227 seconds of publication spans.
The no-edit phase recorded 909 SQL statements / 2.224 summed seconds and
0.128 seconds of scheduler passes; plugin start/handshake/snapshot/extraction
and publication span counts were all zero. Nested span times overlap and must
not be added to the fill total.

## Validation and remaining work

- Strengthened the existing no-edit integration test: zero work, no admission,
  start or publication events, disk/git/glossary outcomes inherited as unchanged,
  and the same outcomes observable in another committed read.
- Added a pure regression for immutable partition/aggregate references and
  successful empty outcomes, including non-mutation of original drafts.
- Integration diagnostic: 1 pass, 12 assertions, 2 filtered, 90.96s overall.
- Pure producer-outcomes tests: 4 pass, 12 assertions.
- `bun run check` passed, with the same 17 inventoried SQL architecture findings.
- `git diff --check` passed. No new CI log existed at
  `/tmp/m28-ci-4772e82f.log` when checked.
- Enforced acceptance remains blocked by the previously documented host user
  namespace restriction; sandbox-off does not establish acceptance.
- The changed-input slowdown and earlier cold-commit page budget remain open.
  A future safe optimization can reduce repeated plugin planning/extraction or
  introduce enforced narrower filesystem inputs; neither is implemented here.

Raw diagnostics: `/tmp/m28-unchanged-three-before/markers.jsonl`, preserved traces
under that directory, `/tmp/m28-unchanged-controlled-metrics.json`, and
`/tmp/m28-unchanged-regression.log`. The fixture was not assumed to have identical
inputs across the committed-newline boundary.
