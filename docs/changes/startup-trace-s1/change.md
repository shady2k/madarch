# Record startup phases as paired versioned JSON records with a private context file

Change: startup-trace-s1
Base: e38d9bcba41bd793c139c2ba689a319d787710de
Tasks: madarch-64o5.74
Kind: no-behavior

## Intent

A start printed its own legacy timings as bare lines on stderr — `startup ensureDaemon`, `startup manifest.validate`,
`startup catalogue.publish`, `startup catalogue.transaction`, `startup listener`, `startup schema.prepare`,
`postgres.initdb` and `postgres.start` — each a duration with no phase pair, no order and nothing that told one
process's line from another's, so a slow start named the wait that was long and not what the wait belonged to.

The records are now paired versioned JSON lines: a `begin` record and its `terminal` record carry the phase, the role,
the process instance and pid, a sequence and a pair, the clock reading with the domain it belongs to, the process
start ticks, a hashed cluster identity where the phase opens a store, the operation and the outcome. One start's
records are joined across processes by a private context: the entry consumes the controller-created context file once,
removes its path from the process environment and forwards it only to the Madarch roles that read it, so the records
of one start carry the same `collection` and `keyId` without a secret in a command line and without putting the path
in the environment of every child the process starts. Nothing about a start's result depends on them: a record that
cannot be written is dropped.

## Out of scope

- **S2, shutdown and postmaster identity.** This slice records startup only; what a stop or the server's own identity
  records is a later slice.
- **S3, detailed readiness marks.** A start reports readiness exactly as it did; no mark is added.
- **A faster start.** The records answer where a start spends its time. Making it shorter is not part of this change.
- **A new switch or a new output channel.** `MADARCH_STARTUP_TIMING=1` stays the switch that turns the records on and
  stderr stays the channel they are written to; the records replace what that switch printed. Two inputs are read
  beside it: `MADARCH_STARTUP_CONTEXT`, the private context file the controller writes (see `## Where it is seen`),
  and `MADARCH_TRACE=off`, which turns the records off (`src/obs/startup-context.ts:9`). No other configuration is
  added.

## Rationale

Replace legacy startup timings with paired versioned JSON records on stderr. Capture a private controller-created context file once at entry, remove its path from the process environment, and forward it only to intended Madarch roles. Derive opaque cluster identities with the supplied key. Authenticated schema preparation carries non-secret identifiers and a distinct operation identifier.

Linux uses CLOCK_BOOTTIME with a hashed boot and time-namespace domain. If the kernel clock or its domain cannot be obtained, or on another platform, use the process clock. Process-clock records preserve local order and do not establish cross-process durations. Trace output failures do not change the product result.

This slice does not implement S2 shutdown/postmaster identity or S3 detailed readiness marks.

## Preserved contracts

- fill-orchestrator/host: the background server still builds the orchestrator over the process's one database owner, holds it for the life of the process and stops it with its own shutdown. The change records the publication transaction the fill service runs on that owner (`catalogue.transaction`) and the fill process's own entry (`role.fill`), and hands the private context path to the roles that already start there; the orchestrator's construction is not a recorded phase and nothing about it moves.

## Coverage

- fill-orchestrator/host: test

## Where it is seen

Kind: log
Place: the command's stderr and the home's `.madarch-daemon.log` — a command records its own phases on its stderr (`madarch serve` `command.serve`, `madarch stop` `command.stop`, and every other command, `madarch init` and `madarch start` among them, `command.other`), while the server's roles `daemon`, `api` and `fill`, and the `launcher` that starts `api` and `fill`, record theirs in the home's `.madarch-daemon.log`, the file the background server's own stdout and stderr are kept in.

1. Write the private context file the controller hands down: an absolute path, a regular file (not a symlink) that the
   current user owns, mode `0600`, holding a JSON object with exactly three fields — `version` set to 1, `collection` a
   UUID and `key` 64 hex digits — where the `collection` is the id one start's records are joined by and the `key`
   seeds the keyed cluster identities.
   `(umask 077; printf '{"version":1,"collection":"%s","key":"%s"}' "$(uuidgen)" "$(openssl rand -hex 32)" > ~/startup-context.json)`
   writes one.
2. With a Git author identity configured, as `init` requires, run
   `MADARCH_OWN_WIKI=off MADARCH_STARTUP_TIMING=1 MADARCH_STARTUP_CONTEXT=~/startup-context.json madarch init ~/idea --home ~/products --template everything --port 0`
   and read the command's stderr. `MADARCH_OWN_WIKI=off` only keeps the walk off the network; it changes no record.
3. The command's stderr holds one `begin` and one `terminal` record for `command.other` and one pair for `ensureDaemon`,
   in the order the phases happened, each with `context: "ready"`, the file's `collection` and its `keyId`.
4. Read `~/products/.madarch-daemon.log`: the `daemon`, `api`, `fill` and `launcher` records there carry the same
   `collection` and the same `keyId` with `context: "ready"` — the daemon's `role.daemon`, `store.open`,
   `cluster.initdb`, `cluster.start` and `schema.prepare`, the api's `role.api`, `manifest.validate`, `listener`,
   `catalogue.publish` and `catalogue.transaction`, and the fill's `role.fill` with its `store.open` and
   `cluster.start` pairs.
5. `MADARCH_STARTUP_TIMING=1 MADARCH_STARTUP_CONTEXT=~/startup-context.json madarch stop --home ~/products` ends the
   background server and writes the stop command's own `command.stop` pair to its stderr.
6. Run the same `init` command once more without `MADARCH_STARTUP_CONTEXT`, which makes a second product in the same
   home: the command's records on stderr and the records the restarted server's roles add to the log both say
   `context: "absent"` and carry no `collection` or `keyId`. Without `MADARCH_STARTUP_TIMING=1`, or with
   `MADARCH_TRACE=off`, neither place gets a record.
7. `madarch stop --home ~/products` ends the server step 6 started.
