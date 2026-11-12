# Implementation evidence: madarch-64o5.4

This is worker evidence, not stage acceptance or task closure.

## Contract followed

The latest owner correction governs: terminal init asks only the catalogue's
starter-template question; Enter takes its first declared entry. Nonterminal
init without an explicit template writes neither kind nor workflow manifest,
and its wiki API reports `no-manifest`. Explicit selection never asks.
Git checkout init links that checkout; empty or non-Git init creates an empty
product in the products home. Both serve the wiki. `clone` remains unchanged.

## Checks

- Root `bun run check`: passed (TypeScript, architecture, catalogue, workflows).
- Independent same-model worker review: no blocking CLI/lifecycle finding;
  documentation and install-walk edits reviewed separately. The optional gap
  it found (checking both absent manifests) is now covered.
- Catalogue/workflow/architecture focused tests: 33 passed, no failures.
- Lifecycle, draft and starter-template files: 51 passed, 1 skipped, no failures.
- Two multi-command timeout cases: both passed with their own 30-second bounds
  (12.35 s and 11.28 s).
- Nonterminal empty-folder/checkout x default/explicit-template matrix:
  4 passed, no failures, including both manifest files and live wiki API state.
- Pseudo-terminal Enter-default tests: passed in empty folder and checkout;
  these assert one template question, no repository/agent/token question,
  linked-repository count, browser invocation and live wiki response.
- Compiled Linux x64 binary with graph-store smoke: passed, version 0.0.1
  (validation-only version, not a source version change).
- Local clean npm install: passed as an ordinary user, using `npx madarch init`
  with explicit `--template everything`, stopping the daemon and reopening
  the same product with foreground serve.
- Shell syntax, workflow YAML parse and whitespace checks: passed.

## Limits and environment

The first broad product run was stopped: PostgreSQL correctly refuses root.
Relevant tests were rerun as ordinary user `box`, with outer `timeout 900`.
Two existing multi-command CLI tests reached their explicit/preload ten-second
bound on this machine. Their own bounds were changed from ten to thirty seconds;
production timeout constants are unchanged. The four new matrix cases name
sixty seconds because each starts a wiki process. macOS, Windows and Homebrew
walks were updated, not executed on this Linux machine.

The tracker export `.beads/issues.jsonl` and take-task/close-out tooling are
absent in this checkout. No tracker was initialized or edited. This worker
cannot claim or submit through the tracker, or run its tracker-backed commit
hook. The coordinator must integrate and run stage acceptance before closure.

## Assumptions

- The latest owner correction supersedes the intermediate first-template
  nonterminal default; none of the implementation asks agent or token cap.
- The install walk needs kinds to inspect, so it selects `everything` explicitly.
- Historical decisions, milestones and earlier change records retain the old
  command's wording. Current source, docs, help, installers and CI use init.

## Broad-run outcome

The eight-file ordinary-user run completed: 182 passed, 1 skipped, 6 failed,
with 1 unhandled error. Two failures were the ten-second multi-command tests
subsequently fixed and passed above. One other release-help case hit its
existing ten-second bound. Three existing fill-backed cases could not complete:
the host has not delegated cpu/memory/pids controllers to madarch's cgroup,
so sandboxed plugin execution refuses; one case timed out and its continued
poll reported a refused connection after cleanup. Confinement was not disabled.

The separate serve/executable run completed: 132 passed, 5 failed, 1 error.
That executable test imports the CLI file and therefore also registers its
tests. The remaining failures were existing ten-second bounds and the same
fill/cgroup limitation. All init-specific serve cases passed, including
explicit template, default no manifest, unknown template and parser refusals.
This is not a claim that either broad run was green.
