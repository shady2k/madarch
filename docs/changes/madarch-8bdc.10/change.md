# One store-owned schema preparation boundary

Change: madarch-8bdc.10
Base: 73cb90d20641facd03696df2aeaf74333d5feeb5
Tasks: madarch-8bdc.10
Kind: behavior

## Intent

Move all schema mutation into one store-owner preparation function. Prepare before API and fill roles start, and before activating new sources or changed pinned contracts. Clients only connect and refuse unprepared stores instead of repairing them. Keep pg-boss in the store's PostgreSQL database.

## Preserved contracts
- fill-queue/owner: the queue remains in the store's one PostgreSQL database.

## Coverage
- fill-queue/preparation: schema-stamp, architecture-schema-preparation
- fill-queue/owner: queue

## Out of scope
- Authored entities and agent usage implementation; their modules register schemas through the same preparation boundary.

## Where it is seen
Kind: command
Place: madarch start and API or fill role startup

1. Start a fresh store and connect its API and fill clients concurrently.
2. Try a client against an unprepared store and read its folder-specific madarch start refusal.
3. Activate a changed graph contract without restarting the daemon.

## DONE WHEN
Only the store-owning process prepares schemas, clients perform no schema mutation, and concurrent startup succeeds without retries.
