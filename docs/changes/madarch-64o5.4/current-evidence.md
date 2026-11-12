# Current record and validation, 2026-11-12

## Owner contract

The owner's 2026-11-11 decision governs: one start command, `madarch init`.
`new` is deleted, including its help, with no alias. A terminal asks only the
catalogue starter-template question; Enter chooses the first declared entry.
Explicit `--template` skips that question. Without a terminal and without
that option, no kind or workflow manifest is written. No agent or token-cap
question is asked. This records the decision, not an approval receipt.

## Baseline and requirement deltas

Base is fetched origin/main 7cbfed93effa7a4e3592b2c522f1cbd1f2760a2d.
Each complete proposal replaces requirements individually relative to that
base. The product-repository contract and describe-skill sections retain
main's current structured-publication semantics. The known malformed historical
heading is rendered as prose in the proposal; main's forthcoming 41074352
heading repair is unavailable on origin at this writing. No system spec was
edited. Concrete checkout-folder wording replaces angle-bracket syntax in the
proposed Given/When/Then scenario, which the gate treats as a placeholder.

## Coverage references

- static: /work/out/init-r4-check.log, `bun run check`, exit 0 on b2760959:
  TypeScript, architecture (18 already listed SQL-layer violations), UI (0),
  catalogue (519 kinds), workflows (4), quarantine (0). This validates the
  declarations referenced by catalog, extractor-mapping, pov, presentation,
  views and workflows; it does not claim all rendering journeys were tested.
- test: /work/out/init-r4-matrix.log, single-start-command tests in
  test/product-cli.test.ts: 7 passed, 0 failed, 61 assertions. Empty-folder and
  checkout nonterminal omitted/explicit-template cases, pseudoterminal Enter
  default, linked repositories, wiki answers and deleted-command refusal.
- test: /work/out/init-r4-tests.log, full test/describe-repos.test.ts,
  test/madarch-init-e2e.test.ts and test/draft-templates.test.ts: 14 passed,
  1 existing skip, 0 failed, 82 assertions. These cover guide sections,
  unchanged draft identity/constitution, explicit e2e starter and wiki state.
- review: requirement-level comparison of the command-reference renames in
  manifest, list, describe-step, demo, serve and installers; implementation
  and guide retain existing identity, listing, demo updates, shared server,
  platform selection and installer machinery. This is static source review,
  not a new native platform walk or a passing whole product suite.

## Mutation record

not-made: mutation — no complete mutation suite was run for b2760959 or this
record-only revision. Earlier targeted successful-fill-stamp mutation on
parent a90771a1 removed the successful-run count; the real PostgreSQL regression
failed on the unchanged stamp. Restored focused regression passed 1 test,
5 assertions, 16.45 seconds. Reference /work/out/init3-publication-report.md
and /tmp/publication-stamp-mutant.log. It is earlier targeted evidence, not
full current mutation coverage. No surviving mutant was observed in that
single experiment; no survivors task is invented.

## Limits

Earlier evidence and follow-up-evidence remain chronological, not current
whole-suite green claims. The two test-bound increases were reverted as the
follow-up records. Broader CLI/serve timing and sandbox failures remain
reported there. No constants or bounds changed in this documentation update.
No native Windows/macOS execution is claimed. Tracker export was supplied by
the coordinator at /tmp/issues.jsonl, copied untracked to .beads/issues.jsonl;
it is never included in the commit or bundle. No owner approval is written.

## Gate constraints under documentation-only scope

The required worktree gate reads current specs outside docs/changes/ as well
as the record. Its feature phase requires current specs equal main, while
close requires those same specs equal replayed proposals. This branch already
holds current specs with init changes. With only docs/changes/ editable, those
current specs cannot be synchronized for both phases. This is not repaired by
pretending the change is approved or changing gate code. Final outputs and
isolated diagnostic results are delivered alongside the bundle.

## Receipts and final diagnostic

Static, targeted-test and independent same-model review receipts were appended
only to the supplied untracked export. Mutation status is skipped with explicit
not-made wording; it is not passed. No approval receipt was appended. The review
found one starter-set scenario missing explicit everything; that setup is now
corrected in the wiki proposal. The fixed content remains under docs/changes/.
Actual feature and close outputs both exit2 on the unreadable main heading.
An isolated scratch adapter that normalizes only that heading reports feature
current-spec synchronization errors plus missing-approval; close reports the
current draft scenario placeholder and draft/views synchronization plus missing-approval.
Receipts resolve unproved-check items; mutation skipped is informational only.
The scratch run is diagnostic, not the requested actual gate passing.
