# Owner fill path investigation (madarch-64o5.74)

Base: `8f03f3946a1b4ba4aa835aa26b9a16055f000ada`.
Result: blocked; no product fix is established.

## Reproduction

All test commands used `scripts/plugin-sandbox-cgroup.sh bun test <one file>`
as the non-root test account. No test expectation, timeout, lock file or
performance constant was changed. Mutation testing was not run, as requested.
Temporary connection logging and role/PID application names were removed after
collection. Raw results are in `/work/reports/alx-fixOwner-*.log` on the worker.

- The initial owner-path run reached GraphQL but hit its unchanged 30-second
  read deadline, then the unchanged 300-second case deadline. It did not
  establish the reported connection-termination cause.
- With `log_connections=on`, `log_disconnections=on`, role/PID
  `application_name`, and signal tracing, init hit its unchanged 180-second
  subprocess deadline. The trace identifies the test process sending TERM to
  init at that deadline. This is **not** evidence for the original isolated
  backend termination after daemon stop: that step was not reached.
- Two subsequent logged attempts and an unchanged sequential reproduction
  stopped at the existing 30-second serve-address deadline
  (`test/owner-fill-path.test.ts:89-102`). The sequential reproduction took
  96.19 seconds overall. Increasing that limit or reducing the fixture is not
  an accepted repair, and neither was done.

## Repository count: unresolved contract conflict

The owner-path assertion explicitly expects two repositories and counts files
from both trees (`test/owner-fill-path.test.ts:165-178`). Product code explicitly
filters the pinned inputs to `form === 'code'`
(`src/plugin/repository-input.ts:38-41`), while the disk producer makes one
repository vertex for each input (`plugins/disk/main.ts:13-29`). This is a
concrete path that can explain a count of one, not a completed reproduction of
step 5 on this worker.

The current repositories requirement describes manifest-declared **code**
repositories (`docs/system/capabilities/product-wiki.md:293-301`). Decision
0039 requires parent-edge identity (`docs/decisions/0039-core-graph-model.md:128-136`)
and canonical shared repository identities (item 28, lines 786-800), but those
rules alone do not decide whether a product repository is also a code input.
The older repeat-fill investigation says product commits change the disk/git
inputs (`docs/changes/madarch-64o5.28/repeat-fill-investigation.md:23-31`),
which conflicts with the current filter. No assertion was weakened and no
specification was rewritten to conceal this conflict. The count symptom
remains unresolved; the test has not been declared wrong.

## Completed checks

- `bun run check`: type checking, architecture, UI, catalogue and workflow
  checks passed; only `check:slow-tests` refused missing/stale single-file
  evidence on the supplied stack. The short-circuited `check:quarantine` and
  `check:tests` were then run separately and passed.
- `graph-write.test.ts`: 27 passed, 0 failed, 52.17 seconds.
- `postgres-cluster-owner.test.ts`: 29 passed, 0 failed, 105.63 seconds.
- `postgres-cluster-start.test.ts`: passed.
- `stop-databases.test.ts`: 16 passed, 0 failed, 267.57 seconds.
- `postgres-cleanup.test.ts`: 1 passed, 0 failed, 12.95 seconds.
- `status-work.test.ts`: failed in its existing 180-second setup hook;
  teardown then reported EPIPE. It did not reach its assertions.

The requested full neighbour inventory from imports of `postgres-cluster`
was not completed. No minimal regression or green owner-path result is claimed.

## Next evidence needed

Reproduce on a machine where init and serve reach their existing deadlines,
with connection logs and a low-overhead signal trace enabled for the same run.
Correlate the terminated backend PID with the actual signal sender or SQL
cancellation, rather than inferring a sender from shutdown timestamps. Then
write a minimal failing regression before changing product code. Resolve the
repository input inventory against the intended product/code contract before
changing either the filter or its expectations.
