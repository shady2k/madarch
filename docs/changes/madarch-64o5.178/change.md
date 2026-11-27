# An unconfined host's core file read runs the way the host runs its plugins

Change: madarch-64o5.178
Base: adb2100e1b84af68b50d4a50011ef6440bacb0b5
Tasks: madarch-64o5.178
Kind: no-behavior

## Intent
A host runs its plugins the way it was told to: an unconfined host — the mode every walk with an agent uses,
because the machine delegates no cgroup to confine a plugin in — asks its plugin for a file's text, and the
host answers by opening the core plugin that owns git's object store. That read is made by the host itself
(`PluginHost.readBlobThroughCore` → `readBlobThroughPlugin`), and it took neither the host's environment nor the
host's `unconfined` choice: the reader fell back to the process's own `MADARCH_PLUGIN_SANDBOX` and to
`process.env` for the repository's path. On a machine with no sandbox the read was then refused
(`cgroup-delegation`) even though the host that asked had deliberately chosen no isolation, and the walk hid it
by setting `MADARCH_PLUGIN_SANDBOX=off` around its fill.

The change gives the nested read the host's own settings, in a copy the caller never sees changed, and removes
that workaround from the foundation walk. No product behavior, page or command changes: a confined host still
reads through a confined reader.

## Rationale
`readBlobThroughPlugin` already took a `releaseHashes` and an `env` option, and the fill role's own file-text
queue (`src/knowledge/file-texts.ts`) passes its environment that way; only the host's core reader passed
nothing. Two things followed from `process.env`: the child that runs the reader was spawned with the process's
sandbox mode instead of the host's, and `sandboxRepositoryPath` named the repository `/repo` (the sandbox's
mount) instead of the folder it lies in — so even a reader that started unconfined would have read the wrong
path. Deriving `MADARCH_PLUGIN_SANDBOX=off` in the copy for an unconfined read keeps one source of truth for
both: the child runs as a plain child, and the path it is given is the one a plain child can open.

The readers this process keeps (`READERS`) are now keyed by the way a reader runs as well as by its plugin and
repository: an unconfined reader must never answer a caller that asked for a confined one, and a reader opened
with one environment must never answer a call that names another. The core plugin finds git on the `PATH` it was
opened with and reads `MADARCH_*` through the same environment, so the settings the call names are part of the
reader's identity — a digest of their sorted names and values, never the process's own.

## Out of scope
- `restrictToSlice` and the `document` kind in the foundation walk: that is the separate task for the walk's
  catalogue frame.
- The wiki's page rendering on the box this landed on, which is red there for its own reasons (page title and a
  repository page's link), and the acceptance box the parent task names for it.
- Any change to the sandbox itself, to `MADARCH_PLUGIN_SANDBOX`'s semantics or to the fill role's file-text queue.

## Changes to requirements
None. The change keeps every requirement it touches: a plugin's read of a file's text is still the host's one
read, confined the way the host was told to run its plugins.

## Preserved contracts
- fill-orchestrator/attempt: a worker still runs one unit of its stage through the lease, the draft and the validation, and what a unit's plugins may read is still decided by the host that runs them — now including the host's own environment and isolation choice, which the nested core read used to take from the process instead.

## Coverage
- fill-orchestrator/attempt: test

## Where it is seen
Kind: command
Place: `MADARCH_FOUNDATION_E2E=1 bun test test/foundation-slice-e2e.test.ts`, and a product's own `madarch fill` on a machine that delegates no cgroup for plugins

1. On a machine whose cgroup delegates nothing to madarch, start a fill of a product that declares the disk, git and imports plugins.
2. The imports plugin asks the host for the text of every file it reads; the host opens the git core plugin for it.
3. The fill reaches the graph the same way it does on a machine that can confine a plugin: the file texts arrive, and no `cgroup-delegation` refusal is recorded for a read the host itself made.

## Design and decisions
The host passes `env` and, when it runs its plugins without isolation, `unconfined: true`. `readBlobThroughPlugin`
derives its own environment for an unconfined read — `{ ...(options.env ?? process.env), MADARCH_PLUGIN_SANDBOX:
'off' }` — and hands it to both the reader's host and `sandboxRepositoryPath`, so the mode and the path agree.
The caller's object and `process.env` are never written.

The regression case is a child process (`test/plugin-file-read.test.ts`): it names a `MADARCH_PLUGIN_CGROUP` that
is not a cgroup, so the confined path can only refuse on any machine, and its environment is the run's own
without `MADARCH_PLUGIN_SANDBOX`, whatever the run holds — an inherited `off` would make the same answer mean
nothing about the host's choice. It asserts the read answers `complete` and that the child's variable is still
`undefined` afterwards. The child closes its readers with `closeFileTextSessions()` before it exits.

A second case names one repository, one process and two environments: with an empty `PATH` the core plugin's own
check refuses by name (`no git executable on PATH`), with the run's `PATH` the read answers, and the empty `PATH`
is refused again rather than served from the reader the full one opened.

## Acceptance evidence
Static: `bun run check` passed on the box (tsc, architecture with its 499 listed violations and no new one, UI
architecture 0, catalog, workflows, quarantined-file inventory, tests 0 violations).

Test: `bun test test/plugin-file-read.test.ts` → red before the fix (`1 pass, 2 fail`: the new case failed with
`src/plugin/cgroup.ts:1: … is not a cgroup v2 folder` from the nested read, and the existing case with the same
refusal), green after it (`3 pass, 0 fail`, 13.75 s). Seven affected plugin and file-read files passed 28 of 30
cases; the two failures, both in `test/file-text-bound.test.ts`, are the same on the base commit in the same box
(they call `readBlobThroughPlugin` with no options at all, and the box delegates no cgroup). The foundation
walk's own graph case passed (`343 179 ms`) with the `MADARCH_PLUGIN_SANDBOX` workaround deleted and only
`unconfined: true` handed to `runFill`.

Review round (a reader keyed by its environment, and a child that starts without `MADARCH_PLUGIN_SANDBOX`):
`bun run check` passed on the box over the fix (exit 0; 499 listed architecture violations, no new entry).
`bun test --timeout=60000 test/plugin-file-read.test.ts` → `3 pass, 1 fail` before the reader key carried the
environment (the third call with an empty `PATH` resolved from the reader the full `PATH` opened: `expected
promise that rejects, received promise that resolved`), `4 pass, 0 fail` (17.8 s) after it, and the same file
passes when the run itself holds `MADARCH_PLUGIN_SANDBOX=off` (20.4 s). The seven affected plugin and file-read
files pass 31 of 31 cases (80.3 s).

The foundation walk still passes its declaration, fill, graph, value and agent cases (`326 702 ms` for the
graph case with the fix). Its wiki browser case times out on this box on the base commit as well (one failure of
six there, `75 095 ms`), and the catalogue case, which passed on the base commit in 20.9 s, timed out once at
71.1 s under load and passed at 42.9 s in a second run with the fix. Both waits are the page walk's known cost
on a shared 3-vCPU box, not the reader's.

## Blocking questions
None.
