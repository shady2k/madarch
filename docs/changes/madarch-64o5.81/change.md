# A store whose initdb was cut short is prepared again, and a wait for PostgreSQL says how long and why

Change: madarch-64o5.81
Base: 1460a3b7dfeb14756a5cda0c017eab599b2837da
Tasks: madarch-64o5.81
Kind: no-behavior

## Intent
Main's windows-x64 clean-install walk failed after PR #311: a stop during first-use preparation ended initdb after its bootstrap checkpoint but before the postgres database existed; the next open saw PG_VERSION, global/pg_control and base/1 and accepted the folder, ignoring that madarch.prepared was never written; every later connection got «database "postgres" does not exist», and serve printed nothing until the walk killed it.

A folder carrying madarch.preparing is never whole by its files: madarch.prepared is the only proof. Such a folder is erased and prepared again only when its record is readable, names an attempt of madarch's own, and the cluster holds no database beyond the bootstrap's; an unreadable or foreign record, or any database written there, refuses the start naming the folder and what to do. The readiness wait says how long it has waited and refuses with the client's last word beside the log. The walk's bounds outlast preparation plus readiness.

## Rationale
A store accepted half-prepared serves nothing and says nothing; a store erased on a guess loses data. Only madarch's own unfinished attempt, provably empty, may be redone.

## Preserved contracts
- fill-queue/owner: the queue still lives in the process's one database; only how that database's folder is judged whole and how its wait is reported change.

## Coverage
- fill-queue/owner: static, test, mutation, review

## Where it is seen

Kind: command
Place: madarch start / madarch serve, first use after a stop during preparation

1. On Windows, stopping madarch while its store is still being prepared and starting it again: the start prepares the store again and serves, printing «waiting for PostgreSQL on its folder, N s of 60» while it waits; a folder madarch cannot prove is its own empty attempt is refused with its path and what to do.

## Out of scope
Linux and macOS walks (unchanged); the sandbox (madarch-64o5.86).
