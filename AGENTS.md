# madarch

All retained work and commits belong to tracked tasks. File discoveries through
`to-backlog`; implement through `take-task`; close only after stage acceptance
through `close-out`. Read Backlog integration in `.shady2k/integration.md` before writes. When a
skill reports the installation is out of date, run `setup-shady2k-skills`.

Artifacts (documents, tasks, commit messages, code comments) are written in English.

## Lessons

- Checks: `bun run check`, `bun test`; `MADARCH_SKIP_PERF=1 bun test` skips the
  performance tests (about 6 s instead of minutes). `bun run check` is `tsc
  --noEmit` and then the architecture check of decision 0033 (item 4,
  `scripts/check-architecture.ts`): dependency-cruiser over the import graph
  (one writer for the graph, one storage layer), a name-level rule for the one
  fill entry point, and knip for code and exports no declared entry reaches. Its
  findings are held against `.architecture/violations.json`, today's debt, and a
  violation that is not listed fails the check, as does an entry no rule finds
  any more — the list only shrinks. Fix a violation, or list it in a commit that
  carries a line `Owner-decision: <the owner's words>`; CI compares the list with
  the merge base and refuses a gained entry without one. `bun run
  check:architecture` runs it alone, `--update` writes the list from what the
  rules find now, `--rules <names>` runs some of them. The `madarch` command
  (`bun link` in a checkout, or `bun scripts/madarch.ts new|serve|list …`)
  creates a draft product repository with madarch's own lifecycle code,
  serves its wiki, and lists the products of the
  products home; the home is `~/madarch/products`, moved by `MADARCH_HOME`
  (or `--home` for one command).
  The wiki app's own checks run inside `wiki/app`:
  `bun install --frozen-lockfile && bun run check && bun test && bun run build`.
  `madarch demo` clones or updates the Madarch product repository and serves
  its wiki; `bun run wiki:shots` renders the side-by-side
  mockup/ours pairs of the mockup-fidelity acceptance (`--mockup <the mockup's
  dist folder>` to pair; without it ours only) into a scratch folder outside
  the repository and prints it.
  Mutation testing is StrykerJS 9
  run from a scratch folder outside the repository with `typescript@5` beside it
  (TypeScript 7 has no JS API); see `.shady2k/integration.md`. With bun's command
  runner, mutate only the changed line ranges (`"src/x.ts:120-180"`) against one
  fast test file, under `timeout 600`: a whole file run through a suite that builds
  sites takes hours and finishes no mutant.
- This machine is shared: other projects' Go tests and indexers can take most of
  the memory and fill the disk. Timeouts in a full `bun test` outside the changed
  code are load, not a defect: check `free` and `df`, rerun the failing files alone,
  and never blame the change before that. The wiki's real builds run only with
  `MADARCH_WIKI_E2E=1`; point `MADARCH_WIKI_CACHE` at a scratch folder in tests.
- A check on an outside repository is a one-time walk at acceptance, recorded
  in the acceptance record. Committed tests use only fixtures the project holds
  or creates; none needs a checkout, commit or variable naming another
  repository, and product messages and specs use neutral example names
  (madarch-l2f: the server e2e test required an outside checkout).
- Briefing workers: state the quality bar up front (every error with file, line
  and full path; no silently smaller result; code-point sorting; mutation run
  before the report), or review takes three or four rounds.
- A single task outside a stage is never labelled `implemented`: it stays in
  progress until it lands, then closes on its acceptance record.
- Every `bun test` run is isolated in its own scratch home and temporary
  folder (madarch-1xq): `bunfig.toml`'s `[test] preload` makes
  `<temp>/madarch-test-run-*` before any test file loads, points `HOME`,
  `MADARCH_HOME`, `TMPDIR` and `MADARCH_WIKI_CACHE` inside it, and removes it
  when the run ends, pass or fail — `test/run-scratch.ts` holds the mechanism,
  the wiki app's `bunfig.toml` shares it, and CI snapshots the home and the
  temporary folder before and after the suites with
  `.shady2k/run-scratch-check.mjs`. A leftover run folder in the temp folder
  therefore means a run was killed; the next run sweeps it.
- A test that names no bound of its own is meant to run under a ten-second
  default rather than Bun's five (madarch-tzte.36): `setDefaultTimeout` in
  `test/deadline.ts`, which both `bunfig.toml` files preload — not bunfig's
  `[test] timeout`, which Bun 1.4.2 ignores (measured: a test that sleeps 7 s
  still fails at 5 s with it set). The preload does not reach every file of a
  run that holds several: measured on the pod 2026-10-20 (madarch-cznn), a
  throwaway case that sleeps 6 s passed three times in a row under
  `bun test test/tmp-probe-a.test.ts` and was stopped at 5 000 ms in
  `bun test test/tmp-probe-a.test.ts test/server-graphs.test.ts`, and CI shard
  run 39351539188 stopped a case with no bound at 5 036 ms while its own file's
  cases naming 15 000 ran 5.9 s and passed. So a case whose work is long names
  its own bound in the test; the five seconds are what an unnamed case really
  runs under, in a shard or a full run alike. The default is not the fix for a
  slow test either — the cause is usually the databases a case opens. Since
  2026-11-07 a run holds **one PostgreSQL server**, started by the preload
  (`test/run-postgres.ts`) in the run's scratch folder, and a case opens a
  database on it (`createTestDatabaseOwner` in `test/test-database.ts`): the
  database costs about 30 ms, where the in-process database it replaced cost a
  1.66 s boot per case (measured on the pod 2026-10-20, madarch-cznn: a bare
  instance 1.66 s, the adapters' schema 0.07 s more). A case that needs a *store
  folder* of its own — a second process reopens it, a queue's data directory —
  names one with `store` and pays for that store's cluster: 370 ms to `initdb`
  and start on this box (measured 2026-11-07), which is why
  `test/server-graphs.test.ts`'s two-source cases keep their own 20 s bound.
- Views are accepted by rendering every page the way a reader sees it, not by
  parse checks: GitHub's own Mermaid renderer in a 1150 px column (open
  `viewscreen.githubusercontent.com/markdown/mermaid?color_mode=dark` and
  dispatch `code_rendering_service:data:ready` on `document` with the block
  and `width: 1150`, one block per page load), then read each page's label
  size and overlaps and record the numbers. Headless Chromium (nixpkgs
  chromium with puppeteer-core) on the same page works and reads about 0.4 px
  below Chrome. On that renderer word labels widen a `flowchart LR` until it
  shrinks under 12 px; `%%{init}%%` flowchart settings are honoured, ELK is
  not.
- The SkyPilot pool is shared, and its scarce shape is a 2 CPU / 8 GB AVX2 pod
  (the browser walk's). When `madarch-sky-test` exits 3 with "Failed to
  provision", neither shrink the request (the evidence needs the memory) nor
  poll the wrapper in a loop: queue the same launch once with `sky-pilot
  launch -y -c <cluster> recipes:madarch-avx2 --workdir
  ~/.cache/madarch-sky-test/<cluster>/stage … --retry-until-up`, the wrapper's
  own cluster name and staged folder, and it retries every 30 s and starts the
  moment a slot frees (measured 2026-10-20: fifteen wrapper attempts over
  40 minutes all refused, the queued launch held the queue and started).
- The knowledge wiki (decision 0029) is accepted by `bun scripts/knowledge-shots.ts
  --out shots` on the pod (`madarch-sky-test --avx2 --cmd`, after `bun run build` in
  `wiki/app`, then `--fetch` the folder): it serves the generated training repository
  as two products, walks the empty one into its fill and the filled one from the home
  page to a function.
- A store runs on a PostgreSQL server madarch installs (decision 0024, amended
  2026-11-07): the cluster is `<store>/pgdata`, its Unix socket `<store>/pgsock`,
  and a fill of `/work/madarch` peaks at 213 MB of RSS in the process plus 12 MB
  of the server, where the in-process database it replaced peaked at 1 127 MB.
  The wiki has no reader process any more (madarch-8bdc.9): one binary runs
  as `--role api` (HTTP, MCP and the web files, reading the store directly, a
  page in its own `REPEATABLE READ` transaction) or `--role fill` (claims
  pressed fills from the store's queue); `madarch serve` runs the api role and
  one fill child at nice 10. The 4 GB pod and `MADARCH_SKY_MEMORY=8` stay the
  shape the wiki's acceptance runs need: two products, their fills and a
  browser walk.
- madarch's own wiki (decision 0031, madarch-m38l.10) is the repository
  `shady2k/madarch-product`, not content of this repository. `own-wiki.lock` pins the
  revision `scripts/build-binary.ts` embeds as a git bundle; a first start installs it at
  `<madarch home>/madarch-wiki` and later starts fast-forward it when untouched. Change the
  lock when the binary should carry newer pages. `MADARCH_OWN_WIKI=off` switches it off (the
  test preload sets it, so a run never reaches the network; the tests of the wiki install a
  fixture repository themselves). The reader's role lives in `<madarch home>/settings.json`.
