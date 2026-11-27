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
repository: an unconfined reader must never answer a caller that asked for a confined one.

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
is not a cgroup, so the confined path can only refuse on any machine, and its own environment carries no
`MADARCH_PLUGIN_SANDBOX`. It asserts the read answers `complete` and that the child's variable is still what the
run gave it. The child closes its readers with `closeFileTextSessions()` before it exits.

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

Review: pending; this record is for the review.

## Blocking questions
None.
