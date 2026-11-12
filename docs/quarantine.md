# Quarantined root tests

Quarantine keeps known flaky cases out of the blocking root suite while keeping
repair feedback visible. It does not delete tests or make the quarantine job a
required dependency of the stable `test` status.

Mark a case with `quarantined('madarch-<id>', test, 'slow', '<introducing commit hash>')(literalName, body, timeout)`
using the helper from `test/quarantine.ts`. A `describe` can be marked in the same
way when its shared setup fails. The task must be a literal tracker id; dotted
ids such as `madarch-64o5.14` are valid. The current three markers use that repair
task. The reason is one of `slow`, `flaky`, or `broken`; `since` is the full
commit hash that introduced the quarantine, not the latest fill revision. The
three existing cases name their original quarantine commit from madarch-64o5.15.
The `test-quarantine` plugin reads these literal facts from graph-hosted test
files into `code.test-quarantine`; it does not inspect the checkout directly.
The knowledge-documents marker covers the whole describe because its
`beforeAll` setup is part of the failure, not just the leaf assertion.

- Ordinary `bun test test/` registers marked cases/scopes as skipped. Names are
  unchanged. Tests outside those markers still run normally.
- `bun run check:quarantine` validates markers and prints every quarantined leaf
  case, including descendants of a marked describe. It is part of `bun run check`.
  Parent describe names and quarantined case names must be string literals.
  This is a static TypeScript AST inventory using the existing SWC parser; it
  never queries the tracker or depends on tracker connectivity. Tracker task
  state is checked by the tracker gate, not by CI: CI checks marker syntax only.
- `bun run test:quarantine` runs one subprocess per listed leaf, using an escaped,
  anchored full-name pattern and `MADARCH_QUARANTINE=1`. It does not enable the
  entire suite. Each process has a 900-second wall-clock limit, including setup
  and cleanup hooks. A timeout kills its process group. Exit/hook failures count
  as failures; a successful exit also requires exactly one non-skipped JUnit case.
  Results include the repair task, file, full case name and pass/fail status in
  logs and, in CI, the job's step summary. The command fails if any case fails.
- The separate CI `quarantine` job has `continue-on-error: true` and is not in
  `test.needs`. Its failures are visible but never block the normal test status.

## Catalogue and CI evidence

The starter/everything catalogue includes `code.test-quarantine`, with a page per
quarantined leaf, `quarantines` → `code.test-case`, and `fixedBy` → `task`.
The page shows the test location, task, reason and introducing commit. The stored
reason field is `quarantine_reason`: `reason` is reserved for graph opinion metadata.
Removing a marker removes its entity on the next complete fill.

CI exports `quarantine-results.json` as an artifact. Locally, set
`MADARCH_QUARANTINE_REPORT=/path/to/quarantine-results.json` to export it.
To make results available to the graph, commit that file into an ingested code
repository. The plugin reads it only through host graph file/content requests;
it does not fetch CI artifacts. Report entries use
`{file,name,task,since,result,commit,runUrl?,finishedAt?}`, under a `cases` array.
The plugin chooses the latest matching repository/file/name/task/since result.
Without matching graph evidence, `latest_result` stays absent, never invented.

Practice sources: [GitLab quarantining tests](https://docs.gitlab.com/development/testing_guide/quarantining_tests/)
and [Google flaky tests](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html).

After the repair is verified, remove the wrapper call (and any unused helper
import). The unchanged test name then returns to the ordinary blocking suite.
Setting `MADARCH_QUARANTINE=1` manually enables all wrappers in a selected file;
use `test:quarantine` rather than enabling it for the full root test suite.
