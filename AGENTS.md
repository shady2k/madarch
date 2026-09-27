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
  (TypeScript 7 has no JS API); see `.shady2k/integration.md`.
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
  size and overlaps and record the numbers.
