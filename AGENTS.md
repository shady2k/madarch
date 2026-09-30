# madarch

All retained work and commits belong to tracked tasks. File discoveries through
`to-backlog`; implement through `take-task`; close only after stage acceptance
through `close-out`. Read Backlog integration in `.shady2k/integration.md` before writes. When a
skill reports the installation is out of date, run `setup-shady2k-skills`.

Artifacts (documents, tasks, commit messages, code comments) are written in English.

## Lessons

- Checks: `bun run check`, `bun test`; `MADARCH_SKIP_PERF=1 bun test` skips the
  performance tests (about 6 s instead of minutes). Mutation testing is StrykerJS 9
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
- LadybugDB 0.20.4: close every query result, or the buffer pool fills after a few
  hundred queries. `$parameters` are refused inside list lambdas and recursive
  relationship filters, so validated literals go into the query text; bound any
  statement cache. Transitive queries use `SHORTEST` with the per-hop filter
  (`*1..N (r, n | WHERE ...)`), never "match every path, then filter".
- Briefing workers: state the quality bar up front (every error with file, line
  and full path; no silently smaller result; code-point sorting; mutation run
  before the report), or review takes three or four rounds.
- A single task outside a stage is never labelled `implemented`: it stays in
  progress until it lands, then closes on its acceptance record.
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
