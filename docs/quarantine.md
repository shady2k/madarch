# Quarantined root tests

Quarantine keeps known flaky cases out of the blocking root suite while keeping
repair feedback visible. It does not delete tests or make the quarantine job a
required dependency of the stable `test` status.

Mark a case with `quarantined('madarch-<id>', test)(literalName, body, timeout)`
using the helper from `test/quarantine.ts`. A `describe` can be marked in the same
way when its shared setup fails. The task must be a literal tracker id; dotted
ids such as `madarch-64o5.14` are valid. The current three markers use that repair
task. The knowledge-documents marker covers the whole describe because its
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

After the repair is verified, remove the wrapper call (and any unused helper
import). The unchanged test name then returns to the ordinary blocking suite.
Setting `MADARCH_QUARANTINE=1` manually enables all wrappers in a selected file;
use `test:quarantine` rather than enabling it for the full root test suite.
