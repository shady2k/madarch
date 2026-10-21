# Training repository generator

`node examples/training-repository/generate.mjs <destination>` writes a git repository
of a small online shop's ordering and payments back end: four services (orders and
promotions in Go, payments and checkout in TypeScript), contracts, documents,
migrations, lock files, Dockerfiles, a compose file, Kubernetes manifest, CI and a
six-month history. The wiki is judged against it. The destination must be outside the
Madarch checkout. Two runs give identical commit ids.

## What is here

- `template/` is the final state of the generated repository as real files (Go,
  TypeScript, SQL, Prisma, proto, YAML, Markdown, Dockerfiles, lock files). One file
  name differs: `_env.example` is written as `.env.example` (the test pods do not
  receive files named `.env*`). Files named `*.template` are written without the suffix; the jest test files use it so that `bun test` does not pick them up from the template.
- `history.mjs` is the plan: about seventy commits by three authors with fixed dates,
  task keys and messages, which files each commit adds, moves or removes, and which of
  the three counted files (the hotspot `order_service.go`, `pricing.go`, `tax.go`) it
  touches.
- `generate.mjs` replays the plan. Earlier states are read from the same template files:
  a line that is only a comment carrying `@@` is a directive and is never written.
  `@@ since <id> [until <id>]` opens a block that exists while commit `<id>` is in the
  history of the commit being built (and the other is not); `@@ end` closes it; blocks
  may nest. The generator fails, naming file and line, when a directive is malformed,
  names an unknown commit, a commit changes no file, a moved file changes, or a commit
  touches other counted files than it declares.
- Git is run with fixed `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, `TZ=UTC`, `LC_ALL=C`, no
  system or global config and `-c` overrides, so the machine's settings do not matter.
- `answer-key.json` says, item by item, what the wiki must show. It is not part of the
  output, nor are `SPEC.md`, the plan or the template. Its shape is in `SPEC.md`. Items
  carry one location (or several) as `{snapshot, path, symbol, anchor}` that is found
  verbatim in the file at that snapshot; some carry `checks` (a path absent at a
  snapshot, a file that differs from the final one, a text that must or must not occur).
- `SPEC.md` is the agreed specification.

## Counting rules and planted numbers

Written in the key (`plantedCounts`, `countingRules`) and recomputed by the test from
`git log` and from the plan's own declarations: commits (72), first-parent commits (70),
the merge (1), commits that change `order_service.go` (28), commits that change
`pricing.go` and `tax.go` together (6, every commit that touches either; none touches one alone), the lines
of `legacy-report.ts` (796), and the dependency counts of the two lock files. Merge
commits are never counted; the feature branch's commits are.

## Dependencies and lock files

`package-lock.json` (lockfile v3) and `go.sum` were produced by `npm install` and
`go mod tidy` on 2026-10-21 against the public registries, so they are real and
resolvable (the `funding` entries of the lock were removed: they are links to sponsor pages, not part of resolution); they are committed by the history's `Commit the lock files` step, after
the last dependency was added. The generated repository's Docker images and compose
file were not built or run when the fixture was made; the Go and TypeScript code was
vetted, type-checked and tested (see the change record).

## Tests

`madarch-sky-test <worktree> examples/training-repository/generator.test.ts` checks
determinism, the excluded files, the history (authors, merge, rename, date anomaly,
provider authorship), the snapshots, the planted counts against git and the plan, every
key location at its snapshot, and that the generated TypeScript, JSON and `go.sum`
are well formed. The mutation of the generator is not part of this fixture's checks.

## The agent-stage fixture

`agent-stage/` holds the previous generator and answer key, unchanged except for paths. The fill pipeline tests (`test/fill-claims.test.ts`, `test/fill-critic-persistence.test.ts`, `test/fill-impact.test.ts`, `test/fill-intent-history-stage.test.ts`) keep this old input until the fill pipeline is rebuilt per decision 0028, which deletes them together.
