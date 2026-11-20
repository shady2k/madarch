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


## Follow-up: stop hypothesis and repository inputs (madarch-64o5.74)

The owner-path order is unambiguous: init starts the daemon at
`test/owner-fill-path.test.ts:77-84`; `stop` runs at line 88, **before** the new
standalone serve is spawned at line 89. Pages are read at lines 104-110 and
GraphQL at lines 112-114. This is not a read after stopping that serve. The
message “the daemon is stopping; manifest publication was cancelled” concerns
the old daemon, not proof of termination of the newly started API's backend.
No test reordering is justified by this sequence.

`test/owner-stop.test.ts:9-48` tests one store with a connect-only HTTP API child
(`test/owner-stop-driver.ts:5-12`). It records the backend PID and
`application_name=api`, releases the parent's cluster hold before the real CLI
stop, and confirms the same connection answers afterwards. The API is the sole
store holder during stop. No daemon is running in this case: it exercises the
shared database sweep and users lock, not a live daemon shutdown race. Next, an explicit `pg_terminate_backend` produces an
isolated FATAL with no fast shutdown in the PostgreSQL journal; the following
HTTP request succeeds on another backend. The role-specific journal is retained
in `/work/reports/alx-fixOwner-minimal-api-only.log`. This test passes on the
unmodified database owner: the stop hypothesis is disproved in this minimal
case, and idle backend replacement already works. It is a hypothesis test,
not a red regression proving the original 500 repaired. No pool retry was added:
blindly replaying a failed transaction could duplicate committed work.

Repository selection has an independent red/green regression at
`test/fill-snapshot.test.ts:522-542`. Before the fix it received only orders-api
instead of shop plus orders-api (19 pass, 1 fail). After the fix all 20 pass,
including reading the pinned README from each isolated object store.
`src/plugin/repository-input.ts:38-40` now preserves every pin. The owner-path
expectation of both trees at `test/owner-fill-path.test.ts:165-178` is unchanged.

Contract interpretation: product-wiki.md:293-301 specifies the manifest-driven
repository navigation, not the complete set of disk/git plugin input trees.
The product repository's Markdown remains written knowledge under decision
0029; indexing its file identity and commit evidence does not turn it into an
agent-authored code claim. Decision 0039's parent identities (lines 128-136)
and canonical repository identities (lines 786-800) do not exclude product
origins. The repeat-fill investigation at
`docs/changes/madarch-64o5.28/repeat-fill-investigation.md:23-31` records that
product commits change disk/git inputs. Filtering the product pin
contradicted that behavior. This change restores that input contract; it does
not alter the `/r` navigation contract or guess equivalence across origins.

No time limit, performance behavior, lock file or owner-path expectation was
changed. The full owner-path test was not rerun in this follow-up, as requested.
The original connection failure remains unproven and unresolved.


## Live daemon stop/restart check (madarch-64o5.74)

`test/owner-daemon-stop.test.ts:16-104` now checks two real-process transitions:
a live daemon (preparation launcher, API and fill role), successful GraphQL
read, real `stop`, then either a new daemon or standalone `serve` on the same
store, and its first GraphQL read. It uses a single person-origin note kind,
not the full starter catalogue, and presses no fill. The fill-role queue worker
still runs. The minimal query covers bootstrap/navigation, not allCatalogueEntity
(which the one-note fixture does not declare). The first daemon's catalogue must be published before the initial
read (`:48-59`); transient publication-pending 503 is not mistaken for the 500.
Both reads must return 200 without GraphQL errors (`:61-66`). Stop must remove
postmaster.pid and record a fast shutdown (`:87-90`); restart must use a new
postmaster (`:93-94`). These are green hypothesis checks, not red regressions
for a diagnosed defect. The new case's 120 s bound does not change any existing
case or startup allowance (30 s). No product pool change is retained.

Diagnostic-only instrumentation set Pool application_name to
`madarch:<role>:<process.pid>` and PostgreSQL log_line_prefix to `%m [%p] %a `;
connection/disconnection logging and pg_stat_activity supplied the backend
mapping. The Pool edit was removed before final tests. Logs are retained:

- `/work/reports/alx-fixOwner-live-daemon.log:16,202`: both GraphQL reads 200.
  `:94-161` maps preparation PID 1032707, API 1032724 and fill 1032745 to
  postmaster 1032791. Fast shutdown occurs at `:182`. The restarted server is
  1033041, API 1032988, fill 1033009 (`:245-285`). No FATAL in this run.
- `/work/reports/alx-fixOwner-live-to-serve.log:15,129`: both GraphQL reads
  200. Old postmaster 1033528 shuts down at `:121`, standalone starts 1033743
  (`:170`). The final cleanup has fast shutdown at `:266` and FATAL at `:268`:
  backend **1033824 belongs to fill process 1033783**, not the new API and not
  the test psql client. The new API 1033758 disconnects backend 1033798 normally
  at `:263`, before that shutdown. This observed FATAL is after the successful
  GraphQL response, not its cause; it cannot identify the original run's owner.
- `/work/reports/alx-fixOwner-live-final2.log`: both transition cases pass
  without the temporary Pool instrumentation: 2 pass, 0 fail, 18 assertions.

Source review agrees with the measured separation: `src/product/daemon.ts:717-738`
waits for the old daemon and runs the synchronous sweep before reporting stopped;
`src/product/cli.ts:647-662` prepares standalone state before spawning a new API
and keeps the preparation scope alive through child exit. Normal owner close
ends the pool before releasing its cluster hold
(`src/adapters/database-owner.ts:475-495,580-598`). Cross-process users locks
protect a held store from sweeps (`src/adapters/postgres-cluster.ts:1234-1242`).
The exact pg error is secondary: `node_modules/pg/lib/client.js:420` marks a
client not queryable after its connection error, and `:767` returns the quoted
message on a later query. It does not alone prove pool reuse across processes.
The original 500 was not reproduced; no safe red/green pool fix is established.

### Repository-input change relative to decision 0029

The removal of `form === 'code'` in `src/plugin/repository-input.ts:38-40` and
replacement of the exclusion expectation in `test/fill-snapshot.test.ts:523-542`
**changes the previous interpretation of decision 0029** embodied in that filter
and its test. Decision 0029
(`docs/decisions/0029-knowledge-in-markdown-graph-as-index.md:61-70`) separates
written Markdown from rebuildable code facts; the old test used that split to
exclude the product tree altogether. We now include that tree as file and
history input, without changing where authored knowledge lives. Justification:
0039 (`docs/decisions/0039-core-graph-model.md:128-136,786-800`) assigns parent
and repository identities without excluding product origins, and
`docs/changes/madarch-64o5.28/repeat-fill-investigation.md:23-31` records complete
disk/git snapshots changing on product commits. The unchanged two-tree acceptance
expectation at `test/owner-fill-path.test.ts:165-180` makes that interpretation
explicit. This is not a claim that 0039 itself explicitly orders removal of the
filter. The manifest `/r` navigation contract at
`docs/system/capabilities/product-wiki.md:293-301` is unchanged. No other existing
test was modified in this follow-up.


## Final full owner-path run: original 500 reproduced

This supersedes any earlier suggestion that symptom #1 was only resource load.
One clean run of the complete `test/owner-fill-path.test.ts`, with no strace,
no temporary code edits and unchanged deadlines, reproduced the exact step-2
GraphQL 500. Start load averages were **1.78 / 2.66 / 2.80**, available memory
4.5 GiB, free disk 9.4 GiB (`/work/reports/alx-fixOwner-final-load.log`).
`/work/reports/alx-fixOwner-owner-final.log` records:

- `test/owner-fill-path.test.ts:112-114`: GraphQL error “Client has encountered
  a connection error and is not queryable”, status 500.
- Fill plan and fill-selected then also return 500. Later requests cannot
  connect; these are secondary failures, not evidence of the repository count.
- The case expires at **300005.43 ms** against its unchanged **300000 ms** bound
  (`test/owner-fill-path.test.ts:195`); total file run **313.45 s**, 0 pass,
  1 fail, 1 unhandled error. Bun reports one dangling process killed.

A follow-up diagnostic attempt temporarily labelled database-owner pools with
role and process PID, enabled server-side PostgreSQL connection/disconnection
logs, and copied fixture files before cleanup. It failed earlier, at the
unchanged serve-address wait (`test/owner-fill-path.test.ts:93-100`): no address
within **30000 ms**; case **85353.46 ms**, file **99.62 s**. Per the owner's
stop condition, no more runs or deadline changes were attempted. Evidence:
`/work/reports/alx-fixOwner-owner-diagnostic.log`,
`/work/reports/alx-fixOwner-latest-serve.log` (empty), and
`/work/reports/alx-fixOwner-latest-evidence/` (copied fixture).
Its PostgreSQL journal maps preparation process **1040385** to backends
**1040481,1040491,1040492** on postmaster **1040469**. All disconnect normally;
fast shutdown at 01:33:33.519 completes at 01:33:33.746. There is no API backend
or FATAL in this attempt. It does not attribute the earlier clean run's FATAL.
An initial diagnostic invocation using PGOPTIONS for server-only settings was
refused before fixture work; that invocation was corrected to server-side
logging. Its error is not a product regression.

All diagnostic source/test edits were restored exactly; only this evidence
addition is retained. `/proc` was checked for both fixture names/run roots after
completion: no matching live process. No commands remain running. Load at the
final check was 2.30 / 2.46 / 2.65. The full file's original 500 is now confirmed
at lower start load, but no minimal red regression isolates its cause, no pool
fix is justified, and the owner path remains unaccepted. The repository-input
repair and previously passing live-daemon hypothesis tests remain intact.


## External observation: API count backend killed by earlyoom

A further owner-authorized run used only an external observer: no product/test
edits, no strace, no changed expectations or deadlines. The observer sampled
`pg_stat_activity` and Unix sockets every 0.5 seconds (with a busy guard), read
process command lines, and copied the PostgreSQL log every 2 seconds. Actual
samples can be further apart while commands run. The start-load log records
**0.93 / 1.88 / 2.41**, below the requested 2.5 threshold for the one-minute
load. The retained log, rather than an earlier in-flight summary, is the source
for these numbers and this run's result.

`/work/reports/alx-fixOwner-owner-observed.log` again records the exact step-2
500 at `test/owner-fill-path.test.ts:112-114`: “Client has encountered a
connection error and is not queryable”. The unchanged 300000 ms case bound
expired at **300001.44 ms**; total file run **311.64 s**, **0 pass, 1 fail,
1 unhandled error**. Later fill requests failed and then the API refused
connections. No second full validation was run because no fix was made.

### Correlated backend and signal evidence

All times below are 2026-11-20 CET; observer JSON timestamps use UTC, one hour
earlier. Postmaster **1042064** was ready at **01:37:37.570** following the
initial daemon stop and standalone serve transition.

- Backend **1042547** started at **01:38:30.763189**. The final activity samples
  before its death show it active on `SELECT $1::text AS kind, count(*)::int AS n
  FROM node n JOIN entity en ON en.id = n.entity_id WHERE ((n.`. PostgreSQL's
  failed-statement detail includes the active-assertion predicate. This prefix
  matches `vertexCounts()` at `src/graph/graphql-read.ts:1504-1521`, specifically
  the per-kind SELECT at lines 1510-1512 and UNION ALL execution at 1515-1517.
  The activity observer retained only the first 120 query characters; the
  journal also truncates the long statement. Neither is a complete query plan.
- Unix socket endpoints **4703770 / 4705445** pair backend **1042547** with Bun
  PID **1042170**, whose command line is `scripts/madarch.ts --role api serve`
  for this fixture. Thus the killed backend belongs to the API, not the fill
  child or the external observer. `application_name` was empty; ownership
  comes from the paired socket endpoints and process command line.
- `/work/reports/alx-fixOwner-earlyoom.log` records earlyoom sending SIGTERM to
  **1042547** at **01:38:51**, with **2493 MiB VmRSS**, available memory
  **1163 / 11954 MiB (9.73%)** and no swap. At **01:38:55** it escalated to
  SIGKILL after 3.8 seconds and reported exit after 4.5 seconds.
- The PostgreSQL journal records that same backend killed by signal 9 at
  **01:38:55.974**; at **01:38:55.978** it terminates the other active server
  processes, and at **01:38:55.989** it begins reinitializing. Recovery/not-yet-
  accepting-connections FATAL messages follow. This is direct evidence for
  the API connection loss in this reproduction, not an inference from a later
  cleanup FATAL. Zero cgroup oom/oom_kill counters do not exclude a userspace
  earlyoom kill.
- A separate **01:41:32.772** fast shutdown produces the administrator-command
  FATAL for backend **1043880** at **01:41:32.786**. Its socket endpoints
  **4802252 / 4803369** map to fill child **1042231** (`--role fill`). This is
  later cleanup, not the backend killed during the step-2 API read.

Evidence retained outside the checkout:
`/work/reports/alx-fixOwner-observed-load.log`,
`/work/reports/alx-fixOwner-owner-observed.log`,
`/work/reports/alx-fixOwner-pg-activity.log`,
`/work/reports/alx-fixOwner-postgres-616.log`,
`/work/reports/alx-fixOwner-earlyoom.log`, and the observer source
`/work/reports/alx-fixOwner-observer.ts`. Earlier numbered journal snapshots
remain alongside the final snapshot.

### Disposition and limits

This supersedes the earlier lack of backend attribution **for this observed
reproduction**. It does not retroactively prove the cause of every historical
500. Low initial CPU load did not prevent memory pressure during the run.
The API count query was using substantial memory when earlyoom selected its
backend. The evidence does not yet explain why that query grows to this size,
which plan PostgreSQL used, or how much competing work contributed to the
machine's low available memory. No EXPLAIN or isolated memory regression was
collected. A speculative pool retry/reset is not supported by these facts.

No product fix follows from this observation alone. The remaining work is to
isolate the catalogue count query's memory growth with a minimal red regression,
then fix and validate it without weakening the owner-path expectations. This
is not fill-speed work (ALX-616). The original owner-path case remains red and
unaccepted; the validated repository-input repair and passing live-daemon
hypothesis tests remain intact. No constants, deadlines, locks or source/test
files changed in this follow-up. Only this evidence is committed.

The observer and full test handles are both finished. A `/proc` command-line
scan found no live process matching this run's scratch root
`madarch-test-run-UIu06N`, fixture `madarch-owner-fill-wuCfI5`, or observer
script. No own diagnostic/test command remains running. Documentation-only
follow-up: no new test/check run; earlier validation results remain above.
