# Record a start's stop, lock and readiness evidence as the same paired records

Change: startup-trace-s2-s3
Base: 691aff07f25b98d6482be5acf60c7bfc788d89f6
Tasks: madarch-64o5.74
Kind: no-behavior

## Intent

The S1 slice (`startup-trace-s1`) gave a start its paired versioned records: every phase wrote a `begin` and a
`terminal` carrying the role, the process instance, the pair, the clock reading with its domain and the process start
ticks. What it recorded was the start's own work — the manifest, the catalogue, the listener, the schema preparation and
the store's cluster start.

The part of a start spent waiting on something else stayed invisible. A start that waited for another process's lock on
the same store, that reused a PostgreSQL server another process had started, that stopped a server a crashed process had
left behind, or that asked its owner process to prepare a schema, recorded nothing that told those apart: `cluster.start`
said `reused` and named no server, a lock's wait was a sentence in an error message, and a stop's result was a line of
text in a log.

This slice records them, in the same format and under the same switch:

- **Locks.** `cluster.lock.users` and `cluster.lock.start`, each with the outcome `acquired`, `busy` — the deadline passed
  with the lock still held — or `error`.
- **The daemon's own start.** `daemon.lock`, `daemon.proof` (the child's HMAC answer to a fresh nonce) and `daemon.spawn`
  and `daemon.wait`. The last two carry the child's pid only when a receipt or a direct child gave one: a delegated scope
  whose pid receipt is missing or unreadable is `unknown`, never the launcher's pid.
- **The server's identity.** The terminal record of `cluster.start` and `cluster.stop` carries the identity sampled from
  `postmaster.pid` and the process's own start ticks: `observed`, `verified` — the server answered its own `psql` and its
  directory is this data directory — or `unknown`, with `postmasterPid` and `postmasterTicks` when the sample read them.
- **A stop.** `cluster.stop` carries what the stop observed: `identity`, `holder` (`held`, `gone`, `released`,
  `unreadable` or `absent`), `probe` (`answered`, `failed`, `other`, `skipped` or `unavailable`), the ending of its own
  command (`none`, `exit`, `signal`, `timeout` or `launch-error`), that command's `code` where it has one, and the product
  signal the fallback sent (`none`, `term` or `kill`). Its outcome is `stopped` only when the old process really left,
  `absent` when no record named one, `unresponsive` for a server that holds its record and does not answer, `skipped` for
  a stop another process's lock put aside, and `unknown` or `error` otherwise.
- **The stop's command.** `cluster.stop.command` pairs the `pg_ctl stop` the stop ran with its ending, so the stop's wait
  and the command's own time are two pairs and not one.
- **A schema transaction.** `schema.request` pairs the request a role sends its owner process, and `schema.commit` and
  `schema.rollback` pair the owner's own `COMMIT` and `ROLLBACK`: `acknowledged` when PostgreSQL answered the command by
  name, `unknown` when the answer could not say — a connection lost, or an error the command did not reach.
- **The address.** `address.write.human` and `address.write.json` pair the line a start prints once its server answers.

A record observes and never decides. The stop's order of probe, command, signal and file removal, the values it compares,
the locks it takes and the errors it raises are the ones the product already had, and with the records off no new read
happens at all. The one read the records add is the holder sample: bounded to four kilobytes, refusing a symbolic link,
taken under the locks the stop already holds, and never a database query.

A scope wrapper that cannot be written is a start that did not happen with its reason rather than a stack from inside the
spawn, and it leaves no partial `.madarch-daemon-scope.sh` file beside the pid file.

## Out of scope

- **The stop command's own pair and the role boundaries.** S1 already writes `command.stop` for the `madarch stop`
  command and the `terminal` record of `role.daemon`, `role.api`, `role.fill` and `role.launcher` when those processes
  exit. This slice adds no pair for a command and no new role boundary: the `cluster.stop` pairs are written under those
  roles, inside the processes S1 already closes.
- **The Windows channel.** A Windows stop records the same phases with the identity always `unknown`, because a
  `postmaster.pid` supplies no Windows start ticks; a record that appears after the capture found none claims no holder.
  The Windows file channel stays `unavailable`, as S1 left it.
- **A real systemd 262 and a real Windows host.** The delegated scope is recorded through its pid receipt. The receipt on
  the newer systemd is `madarch-4ag1`'s subject, and this slice neither retests it nor claims a host it did not run on.
- **A faster start, and the cause of a slow one.** The records say where a start waited; making the wait shorter is not
  this change. `madarch-64o5.74` stays open until a real fill run is measured.

## Rationale

Same format, same switch, same channel as S1: `MADARCH_STARTUP_TIMING=1` turns the records on, `MADARCH_TRACE=off` turns
them off, and they go to the command's stderr or the home's `.madarch-daemon.log`. Nothing about a start's or a stop's
result depends on a record: one that cannot be written is dropped.

The evidence fields are closed vocabularies on purpose. A start that reuses another process's server must not claim a pid
it did not read, and a stop must not claim that a server left when only its file did, so identity, holder, probe, command
and signal each name what was seen and nothing more. A field whose observation did not happen is absent from the record
rather than set to a guess.

The holder sample is the one new read because a stop already holds both locks and already knows the pid it will signal:
what it lacked was the identity of that pid — the start ticks that tell a live holder from a reused pid. It is bounded,
path-limited and synchronous, so it cannot turn one stop into a wait.

## Preserved contracts

- fill-orchestrator/host: the background server is still built and owned by the process that serves it, is stopped by the same ordered rule — verify, `pg_ctl stop`, the platform's own signal fallback, then the socket files — and is left alone while another process holds the store. This change records that rule and does not reorder it, re-read it under another lock, or signal a pid the product did not verify.

## Coverage

- fill-orchestrator/host: static, test

## Where it is seen

Kind: log
Place: the command's stderr and the home's `.madarch-daemon.log`, the two places S1 names; the first start after this change adds the lock, spawn, readiness and stop pairs to them, in the order the phases happened.

1. Write a private context file as S1 step 1 does, then run
   `MADARCH_OWN_WIKI=off MADARCH_STARTUP_TIMING=1 MADARCH_STARTUP_CONTEXT=~/startup-context.json madarch init ~/idea --home ~/products --template everything --port 0`
   and read the command's stderr: `daemon.lock`, `daemon.spawn` and `daemon.wait` each hold one pair, and the terminal of
   `daemon.spawn` and of `daemon.wait` carry `childPid` — the daemon the state file names.
2. Read `~/products/.madarch-daemon.log` once the `begin` and `terminal` of `api`'s `catalogue.publish` are both there. The
   `cluster.start` pair of the `daemon` role carries `identity: "observed"` with `postmasterPid` and `postmasterTicks`,
   and the `cluster.start` pair of the `api` role is `reused` with an identity of its own: the same cluster, a second read
   of the server it found answering.
3. `MADARCH_STARTUP_TIMING=1 MADARCH_STARTUP_CONTEXT=~/startup-context.json madarch stop --home ~/products` ends the
   server. The command's stderr holds the `command.stop` pair S1 writes and a `daemon.lock` pair with `acquired`; its own
   sweep of the store runs after the daemon's roles gave the store up, so that sweep's `cluster.stop` pair is `absent` —
   the server's record is gone by then. The home's log holds the roles' own stops: a `cluster.lock.users` pair with
   `acquired`, a `cluster.stop.command` pair with `exit` and `code: 0`, and the `cluster.stop` pair it ends, `stopped`
   with `holder: "gone"`, `probe: "answered"`, `command: "exit"` and `identity: "observed"`. The `api` role's own end
   then stops every database under the home once more, `pg_ctl stop` answers a
   server that is already gone, and the log therefore also ends with a `cluster.stop.command` pair with `error` and
   `code: 1` and the `cluster.stop` pair it ends, `absent` with `holder: "absent"`. That last pair is the cleanup finding
   nothing left to stop, not a failed stop: the stop's own result is the pairs above it.
4. Run the `init` command of step 1 a second time with a second product folder. The log holds the `schema.request` pair
   the `api` role writes when it asks for preparation, and the `schema.commit` pair the owner answers it with,
   `acknowledged` because PostgreSQL answered `COMMIT` by name. A transaction that failed pairs `schema.rollback`
   instead; a process that prepared nothing adds neither pair.
5. Read the `fill` role's pairs in the same log: a `store.open` pair is followed by a `cluster.start` pair with outcome
   `reused` and `identity: "observed"`, naming the server the daemon's own `cluster.start` started.
6. Stop a store another process of the same binary still holds — a second `madarch` process of that home, or a process
   still preparing the store — and read its log: that stop's `cluster.stop` pair is `skipped` with `identity: "unknown"`,
   `command: "none"` and no pid, because the lock another process holds decides and this stop reads nothing more.
7. Without `MADARCH_STARTUP_TIMING=1`, or with `MADARCH_TRACE=off`, neither place gets a record of this slice, and the
   start, the reuse and the stop behave exactly as they do with the records on.

- What confirms each step: the suite that runs the real launcher, daemon, roles and stores under fixtures, never a stub
  of the product — these commands were not hand-run on a personal machine for this slice. Steps 1 and 2 come from
  `test/startup-trace-launch-delegated.test.ts`, `startup-trace-launch-direct.test.ts`,
  `startup-trace-launch-fallback.test.ts` and `startup-trace-launch-evidence.test.ts`, which read a real start's
  `daemon.lock`, `daemon.spawn` and `daemon.wait` pairs with `childPid`, and from `test/startup-trace-handover.test.ts`
  and `startup-trace-start.test.ts`, which read the `identity` and `reused` of the two roles' `cluster.start` pairs. Step
  3 is the handover test's real stop and the stop matrix (`test/startup-trace-stop*.test.ts`); step 4 is
  `test/startup-trace-rpc.test.ts` and `startup-trace-schema.test.ts`; step 5 is `test/startup-trace-store.test.ts`, where
  a second process opens the answering store. Step 6 is `test/startup-trace-stop-ownership.test.ts`, whose second holder
  turns the stop into `skipped` without a command, and step 7 is the records-off case every file above runs beside its
  records-on one.

## Blocking questions

None.
