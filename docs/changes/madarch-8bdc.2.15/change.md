# Confined plugin execution: the protocol, the host's bounds, the sandbox, the SDK and the commands

Change: madarch-8bdc.2.15
Base: e335efaa01eacc907245ec8df2abd9c25ce2c636
Tasks: madarch-8bdc.2.15
Kind: behavior

## Intent
Decision 0035's increment (a2) makes a plugin a separate process madarch drives
and keeps in bounds, and it makes confinement a condition of running one at
all. This change lands the increment's items except the one the decision gives
to a later branch: item 7's protocol, item 5's bounds, item 4's closure and
trust, item 9's sandbox, item 8's SDK, conformance kit and local runner, and
item 13's concurrency setting. The git reader's move into the first plugin is
not part of it: another branch lands the publication boundary it moves through,
and this increment adds no caller inside `src/fill/stages`, `src/graph` or the
wiki.

A plugin is a folder with a `plugin.json` (name, version, entry, interpreter
pin). Its **closure** is every file it may load — its code and locked
dependencies, its manifest, the SDK madarch hands it, and the interpreter pin —
hashed into one sha256 over the paths and their digests in code point order. A
run copies the closure into a private snapshot, hashes the copy, and executes
only that copy. A closure whose hash a release carries runs; any other is
refused as needing approval, except as validation (the conformance kit), which
publishes nothing.

The plugin introduces itself over JSON-RPC on its standard input and output,
and the host holds it to a handshake deadline, a deadline per unit and per run,
a heartbeat deadline a pause suspends, a bound on one message and on a unit's
whole answer, and a stop that becomes a cancel after a grace period. Every
answer is validated against the plugin's own declaration: an undeclared kind,
field or edge kind is refused with its place, and a partial unit's removals
are dropped. A plugin that fails, times out, forks too far or exceeds its
memory is recorded as not extracted with its cause; nothing fails silently.

Stories:
- As the engineer who asks a question about a plugin's behaviour, a timeout, a
  cancellation or a crash is a record with a cause, a span and the plugin's own
  log, not a line that stopped.
- As a person running madarch, no plugin runs unconfined: where the machine
  lacks the cgroup delegation or the user namespaces, the command says what to
  enable and runs nothing.
- As the plugin author, one `extract(unit)` function is the whole plugin: the
  SDK carries the introduction, the heartbeats, batching, pause, stop and
  cancellation.

## Out of scope
- Moving the git reader into the first plugin, and deleting its old execution
  path: `src/fill/stages`, `src/graph` and the wiki are untouched here, and the
  change that moves the reader lands after another branch's publication
  boundary.
- Approval of a closure by a person, recorded as a journal operation: this
  increment refuses a closure no release carries and names what is missing; the
  approval itself is a later stage's.
- The product's settings file, and the orchestrator's turn-by-turn binding of a
  plugin to a unit (decision 0035, items 6 and 11): the host takes the
  concurrency setting as an option, and its units are the caller's.
- The Python SDK and the pinned Python interpreter: TypeScript plugins only.
- The upstream plugins themselves, and the release list they fill: no plugin
  ships in this build, so the release list is empty and every closure is
  validated, not trusted.
- The proxy network profile: the host refuses any rights but `none`.

## Rationale
The bounds are the point of the increment: a plugin that hangs, floods its
output, forks past its process bound or fills its memory must fail a unit, with
the cause, rather than block a fill or take the machine with it. So every bound
is enforced by the host over the process boundary, and the numbers that are
facts about the plugin's tree — peak memory, oom kills, forks refused, live
processes — are read from the kernel's own cgroup, never from the plugin's
claim.

Confinement is not optional and not a later stage: a plugin is code nobody in
this repository wrote, and running it unconfined to test it would be the same
program with a worse answer. Where the machine cannot confine it, the host
refuses and says what to enable; the tests of the sandbox skip with that
sentence printed rather than passing on a machine that never confined anything.

The closure is the unit of trust because a plugin's meaning is its files: the
hash over paths and digests in code point order makes two machines agree on the
same folder, and hashing the copy the run executes makes a change between the
hash and the run a refusal rather than a quieter answer.

The SDK is embedded in the binary and written into each closure, so a plugin
runs against the SDK of the build that runs it: there is no second copy to go
stale, and the plugin's closure hash includes the SDK it was built against.

## Changes to requirements
- plugin-host/protocol (new): one published, versioned JSON Schema renders the
  host/plugin messages — introduce with contract, version, rights and limits;
  unit requests and results with vertices, edges, authoritative attributes,
  claims, evidence, removals and the unit's end; progress, heartbeat, error,
  pause, resume, stop and cancel — and references name kinds and key values,
  never node ids.
- plugin-host/closure (new): a closure is every file a plugin may load, hashed
  once in code point order; a run copies it, hashes the copy and executes only
  the copy; a closure a release carries runs and any other needs approval, save
  as validation that publishes nothing.
- plugin-host/bounds (new): handshake, per-unit and per-run deadlines, a
  heartbeat deadline suspended while paused, a bound on one message and on a
  unit's whole answer, a bounded stderr log, pause and resume of the whole
  tree, stop with a grace period that becomes cancel, and a cancel that kills
  the whole tree.
- plugin-host/results (new): every answer is held against the plugin's
  declaration; an undeclared kind, field or edge kind is refused with its
  place; a partial unit's removals are dropped and counted.
- plugin-host/sandbox (new): on Linux, pinned bubblewrap with all namespaces
  unshared, a cleared environment, read-only closure and repository, one
  writable temp folder, the seccomp filter and a cgroup of the tree's own with
  memory, cpu and pids; on macOS, sandbox-exec with rlimits and the process
  group, and its setsid limit stated. A missing delegation or user namespaces
  is an operations problem and no run at all.
- plugin-host/sdk (new): the TypeScript SDK carries the protocol, heartbeat,
  cancellation and batching, so a plugin's author writes one `extract(unit)`.
- plugin-host/commands (new): `madarch plugin check <dir>` runs the conformance
  kit in the sandbox and publishes nothing; `madarch plugin run <dir> --repo
  <path> --unit <json>` runs units and prints the validated results.
- plugin-host/concurrency (new): the host runs no more plugins at once than the
  setting and no more units per plugin than the smaller of the setting and what
  the plugin declared, one by default.

## Preserved contracts
- fill-orchestrator/publish: the publication is untouched; the host publishes nothing, and its units are the caller's.
- fill-stages/registry: the stage registry and the fill's steps are untouched; no stage runs a plugin in this change.
- graph-queries/rebuild: the graph is read by the fill as it was; the host writes no row of it.
- product-repository/draft: `madarch new` writes the same starter set; the `plugin` command group stands beside it.
- fill-orchestrator/host: the background server still owns the orchestrator and starts no plugin here.

## Coverage
- plugin-host/protocol: test
- plugin-host/closure: test
- plugin-host/bounds: test
- plugin-host/results: test
- plugin-host/sandbox: test
- plugin-host/sdk: test
- plugin-host/commands: test
- plugin-host/concurrency: test

## Where it is seen
Kind: command
Place: `MADARCH_SKIP_PERF=1 bun test test/plugin-protocol.test.ts test/plugin-host.test.ts` in a checkout, and `madarch plugin check` on a plugin folder

1. A person runs `bun test test/plugin-protocol.test.ts` and sees the published
   schema compared with the module's own render, a result of an undeclared kind
   refused with its place, a partial unit's removals dropped, a closure changed
   after its hash refused, and a closure no release carries refused as needing
   approval while the conformance kit still runs it.
2. A person runs `bun test test/plugin-host.test.ts` on a machine with a
   delegated cgroup: a plugin that never introduces itself fails the handshake
   deadline, one that floods its output fails a unit on one message, one that
   stops sending heartbeats fails the unit, one paused past the heartbeat
   deadline still answers, one that ignores stop is cancelled, one that forks
   past the pids bound and one that exceeds its memory are recorded with the
   kernel's counts, one that opens a socket, writes outside its temporary
   folder or reads outside its snapshot is refused, a setsid child dies with the
   cgroup, and every one of those stands beside a run of the same fixture that
   succeeds. Where the machine cannot confine a plugin the cases are skipped
   with the reason printed.
3. A person runs `madarch plugin check path/to/plugin` and reads the kit's
   lines — the introduction, the contract, the unit, the pause and the stop —
   and `madarch plugin run path/to/plugin --repo . --unit '{"unitId":"u1","kind":"file","key":{"path":"a.ts"}}'`
   prints the validated results, or the refusal that names the approval a
   closure needs.

## Blocking questions
None.

## Design and decisions
`src/plugin/protocol.ts` is the one source of the message shapes (TypeBox), and
`schema/plugin-protocol.schema.json` is its render, held to it by a test.
`src/plugin/wire.ts` is the bytes: newline delimited JSON with a bound on one
message, the request/notification/answer guards and the JSON-RPC error codes.

`src/plugin/closure.ts` reads a folder's manifest, refuses a symlink and a
folder that carries its own SDK, adds the SDK (`src/plugin-sdk.ts` through
`src/plugin/sdk-asset.ts`, Bun's text loader) and hashes every path and digest
in code point order. `src/plugin/snapshot.ts` copies the closure, re-hashes the
copy and names the first difference; `src/plugin/release-closures.ts` is the
list a release carries, empty in this build, and the trust rule is a release
closure or validation.

`src/plugin/sandbox.ts` starts bubblewrap with `--unshare-all`, a cleared
environment, read-only binds, `--tmpfs /tmp`, `--remount-ro /`, the seccomp
filter on one fd and a sync fd on another; the spawned process is a shell that
writes its own pid into the cgroup and execs bubblewrap, because bubblewrap
forks early and a fork inherits the cgroup of its parent — moving only the
spawned pid afterwards would leave the plugin's work outside the bounds.
`src/plugin/cgroup.ts` checks the delegation and writes `memory.max`,
`memory.swap.max`, `cpu.max` and `pids.max` before the first instruction, and
freezes, thaws and kills through `cgroup.freeze` and `cgroup.kill`.
`src/plugin/seccomp.ts` composes the BPF program itself (no vendored applier):
refusing sockets, io_uring and ptrace for the platform's ABI, and answering
ENOSYS for a foreign ABI. `src/plugin/bwrap-install.ts` installs the pinned
static bubblewrap into the tools cache PostgreSQL's install shares and hashes
it before every use; `src/plugin/bwrap-builds.ts` holds the pin.

`src/plugin/host.ts` is the session: the handshake, one deadline timer for the
session and its units, the heartbeat window, the message and unit-output
bounds, the pause that suspends the heartbeat window, stop with its grace and
cancel, the answer validation and the record of a unit that was not extracted.
`runUnits` is the concurrency setting: plugins at once, and per plugin the
smaller of the setting and the declared `maxParallelUnits`. Every decision and
every iteration leaves a span and a log line, and a unit's record carries the
cgroup's numbers.

`src/plugin-sdk.ts` is the SDK: the introduction, a heartbeat timer, batching
of concurrent units, progress, pause, stop with an abort signal, and exit on
cancel. `src/plugin/conformance.ts` is the kit (introduction, contract, a unit
and its validation, a pause past the heartbeat deadline, a stop), and
`src/plugin/cli.ts` is `madarch plugin check|run`, the host's production
callers, with the run's trace and logs under the scratch folder it prints.

## Acceptance evidence
Measured in the Lima VM `lima-madarch-plugin-host` (Ubuntu 24.04, aarch64, kernel 6.8, bun 1.4.2), 2026-11-09, as the
ordinary user `shady` unless a line says root:

- `bun run check`: green — `tsc --noEmit`, the architecture check with **no-unreachable-code 0** and the list unchanged
  at 33 entries (all `sql-only-in-storage-layer` debt of earlier changes), the catalog (28 areas, 515 kinds) and the
  workflows (4).
- `MADARCH_SKIP_PERF=1 bun test test/` run as `shady` inside the delegated cgroup (the wrapper below) with
  `MADARCH_SANDBOX_REQUIRED=1`: **2871 pass, 157 skip, 0 fail**, 3028 tests across 208 files, 329.13 s, exit 0, and
  the plugin sandbox file **27 pass, 0 skip** inside it. The run needs `XDG_CONFIG_HOME` unset: this box points it at
  a root-only folder, and git then refuses to read an attributes file it finds there, which four `own-wiki` cases
  read as a dirty checkout. Nothing of the change touches those cases; the 157 skips are the suite's own named
  skips (stages out of the fill's list, PostgreSQL legs without a server, performance cases under `MADARCH_SKIP_PERF`).
- `bun test test/plugin-protocol.test.ts test/plugin-host.test.ts`: **55 pass, 0 fail** (28 and 27), 197 assertions,
  18.7 s.
- The host and sandbox cases run for real as the ordinary user `shady` (uid 501) inside a cgroup v2 subtree delegated
  to that account, with the pinned bubblewrap 0.11.2 (the step below), `MADARCH_SANDBOX_REQUIRED=1`:
  **27 pass, 0 fail, 0 skip** — the forked tree past the pids bound, the oom kill, the refused socket, the refused
  write outside the temporary folder, the refused read outside the snapshot, the setsid child killed with the cgroup
  and the pause/stop/cancel cases all ran under confinement. The delegation is made by
  `scripts/plugin-sandbox-cgroup.sh`: as root it creates `/sys/fs/cgroup/madarch-test`, hands it `+memory +cpu
  +pids`, chowns it to the account, and runs the command inside a leaf (`run`) of it — a cgroup that hands
  controllers on may hold no process, and the kernel lets a process move between cgroups only inside the subtree it
  owns. Unprivileged user namespaces are on for the account (`kernel.apparmor_restrict_unprivileged_userns=0` on this
  Ubuntu 24.04, `kernel.unprivileged_userns_clone=1`).
- Without the delegation and without the flag the same file prints `plugin host cases skipped: …` and reports 27
  skip; with `MADARCH_SANDBOX_REQUIRED=1` it fails (exit 1, `1 fail, 1 error`), so a machine that cannot confine a
  plugin never reports a green it did not earn. CI sets the flag in the shard job: the step
  `Delegate a cgroup to the plugin sandbox, and allow user namespaces` of `test-shard` makes the subtree with sudo and
  switches `kernel.apparmor_restrict_unprivileged_userns` off, and the step `Run shard and record its file list` runs
  the shard through `scripts/plugin-sandbox-cgroup.sh`, which re-enters as the runner inside the subtree's leaf and
  exports `MADARCH_PLUGIN_CGROUP` and `MADARCH_SANDBOX_REQUIRED=1`. The plugin cgroup is removed with a short retry
  when a killed tree is still being reaped, so a run leaves no cgroup behind.
- StrykerJS 9 (command runner `bun test test/plugin-protocol.test.ts`, `coverageAnalysis: off`, in place, from a
  scratch folder with `@stryker-mutator/core@9` and `typescript@5.9.3` beside it), on the host's answer and byte
  modules: `src/plugin/results.ts` 217 mutants — **135 killed, 82 survived, 62.21%**; `src/plugin/wire.ts` 270
  mutants — **190 killed, 2 timed out, 78 survived, 71.11%**. The survivors are message text (the tests assert the
  place a refusal names, not the sentence's wording), the fallbacks of the code point comparators where both sides tie
  (equivalent), and the `?? []` arms of loops over lists a result may leave out.


## DONE WHEN
The protocol is published as a versioned JSON Schema rendered from one source;
the host keeps a plugin to its handshake, unit, run, heartbeat, message, output
and stderr bounds and to pause, stop and cancel; a closure is hashed, copied,
re-hashed, trusted only when a release carries it, and run as validation
otherwise; bubblewrap, seccomp and cgroup v2 confine the whole tree on Linux
with the macOS shape and its limit stated; the SDK, the conformance kit and the
two `madarch plugin` commands exist as the host's callers; the concurrency
setting hands out the smaller bound; every test named in the increment exists
and passes beside a normal run that succeeds, or skips with the reason printed;
and `bun run check` and the root suite are green with no new architecture
violation.
