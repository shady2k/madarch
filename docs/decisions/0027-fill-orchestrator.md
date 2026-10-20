# 0027. The fill runs on a declared stage registry, persisted state machines and a pg-boss queue owned by madarch's orchestrator

Status: accepted
Date: 2026-10-18

Refines 0026 (the graph-first fill) with how its stages and units are orchestrated. Keeps 0010/0021
(one offline binary), 0023/0024 (PGlite on the laptop, PostgreSQL on the server, one database owner).

## Context and problem

0026 makes the fill a set of stages that read and write the product graph in bounded units, which may
finish partially, split into children, wait for their children's summaries and go stale when what they
read changes. The owner asked for the architecture to be right from the start: «Сделай правильную
архитектуру сразу так, чтобы потом было легко изменить флоу обработки, добавить новые этапы,
паралелльность, исключить этапы. Нужен конечный автомат. Может быть какой-то оркестратор?», and then:
«Делай как лучше, я предупредил тебя о верной архитектуре. Спроси еще codex». The landed
`fill-runtime.ts` has fixed stage names, JSON files for state, process-local locks, and marks a unit
complete before its stage is committed.

## Decision drivers

- A flow that changes by configuration: add, remove, disable, parallelize stages without rewriting the
  runtime.
- An explicit, tested finite-state machine for units and runs.
- One binary, offline on a laptop with embedded PGlite owned by the background server; the same code on
  a server with PostgreSQL and several worker processes.
- Units that split, join, go stale, are cancelled, retried and resumed, with exactly one publication
  per unit generation.

## Considered options

1. BullMQ flows. Rejected: needs Redis (breaks the offline single binary); flows are trees with one
   parent, not a DAG.
2. Temporal, Hatchet, Inngest. Rejected: each needs its own service or sidecar.
3. DBOS Transact. Durable workflows on PostgreSQL, but the flow lives in code and PGlite support is not
   documented. Held as an alternative.
4. Graphile Worker. A good PostgreSQL queue, but no documented PGlite integration and long lock
   recovery after a crash.
5. An own leased queue on `FOR UPDATE SKIP LOCKED`. Viable, but re-implements recovery, backoff, dead
   letters and maintenance. Kept as the fallback behind the same queue interface.
6. **A declared stage registry and madarch's own orchestrator with persisted state machines (pure
   XState transitions), using pg-boss as the durable queue in the same database.** pg-boss documents
   tested PGlite support (`backend: 'pglite'`, `fromPglite(existing)`) and Bun.

## Decision

Option 6, recommended by an independent review (Codex, 2026-10-18) and taken by the coordinator under
the owner's instruction to do it the best way.

- **Stage registry.** A stage is one module plus registration: id, version, `consumes` (required and
  optional capabilities with scope and freshness), `produces` (fact kinds with schema version and
  ownership scope), optional ordering, a configuration schema and defaults (enabled, concurrency, limits:
  272K context, wrap at 70%, stop at 80%, ~30 turns, ~10 minutes), `plan` (units from the graph),
  `execute` (deterministic or agent via ACP with the unit's MCP server) returning a draft, a split or a
  block, and `validate`. Contexts give tracked graph reads, private draft writes, progress and
  cancellation — never direct database writes. The stage DAG is derived from declared capabilities;
  product configuration (`fill.stages.<id>`, versioned in the product's git) enables, disables and
  limits stages; planning reports the exact starvation path when a required producer is disabled, and
  distinguishes "no producer" from "producer found nothing". Each run snapshots its resolved
  configuration and stage versions. These processing stages are distinct from the lifecycle stages of
  decision 0021.
- **Orchestrator.** A component of the background server that plans, resolves dependencies, admits
  work within resource limits (transactional slots; PageRank as a priority with ageing and a
  deterministic tie-break), reconciles and recovers. The dynamic unit graph (dependencies, splits,
  joins) is persisted. Splits atomically persist the parent's checkpoint and a sealed child set, within
  limits on depth, children and total work. A waiting parent releases its lease and resumes its join
  only when every required child summary of that generation is published and fresh, with an explicit
  policy for a failed child (propagate, block, accept partial). Staleness comes from tracked reads,
  including query membership and empty results, rechecked at publication. Cancellation is a persisted
  intent that revokes authority, then aborts ACP and MCP sessions.
- **State machines** (pure transitions, persisted, tested). A unit has a logical identity, immutable
  generations (new inputs) and attempts (retries): planned → ready → leased → running → draft →
  validating → published; running → waiting_children → ready (join); validating → retry_wait →
  ready; leased/running → retry_wait on lease expiry or transient failure; → blocked and back after an
  explicit resolution; → failed when budget or retries are exhausted; an unpublished generation →
  stale or cancelled with a replacement generation for stale work; a published generation stays an
  immutable record marked stale and linked to its replacement. Leases carry a monotonically increasing
  fencing token; late workers are refused. A run: created → planning → running → succeeded |
  completed_partial | blocked | failed; running → pausing → paused → planning; cancelling → cancelled
  from any non-terminal state; completion needs a closed planning epoch, nothing runnable, in flight or
  waiting, required coverage met and no pending publication effects. A chain of runs per product:
  idle → active → quiescent.
- **Publication, exactly once per unit generation.** One short transaction in the database owner:
  check version, generation, fence, run control and cancellation; revalidate recorded reads; insert a
  uniquely constrained publication record and apply the unit's fact set within its ownership scope;
  update freshness, dependencies, state, queue settlement and durable events. A repeated request with
  the same identity and digest returns the existing result; a different digest is refused. Git commits
  of pages are a separate idempotent outbox step.
- **Queue.** pg-boss in the same database: in PGlite inside the background server, in PostgreSQL on the
  server. Claim and settlement are short transactions; an agent session never holds one. Domain
  dependencies and publication stay in madarch, not in pg-boss. With the background server as the only
  writer, worker processes on a server take work, heartbeat, submit drafts and report through its API.
- **Storage ownership.** One database owner per process for the fact log, the query database, the queue
  and the orchestrator's tables (today the history and query adapters each open their own PGlite);
  transaction-aware operations over the borrowed owner; a unit's publication replaces only that unit's
  facts, never a whole source's.

## Consequences

- From `fill-runtime.ts` stay: pinned snapshots, input hashing, resumable identity, normalized
  progress and usage, pause-drain versus stop-abort, and the human-edit conflict guard. Replaced: fixed
  stage names, JSON state files and journal, process-local locks, unbounded dispatch, and completion
  before publication.
- The first work is a crash-injection prototype with fake agents, built as the compiled binary:
  extractor → splitting unit → child summaries → parent join → consumer, on persistent PGlite and on
  PostgreSQL with several executor processes; killing processes around claim, split, publication and
  acknowledgement; duplicate and late results; an empty query turning non-empty; cancellation during
  validation; a disabled required producer. Pass: one publication per generation, no lost children,
  barrier recovery, refused stale fences, enforced concurrency, eventual recovery, an explicit
  starvation diagnostic. Real agent runs come after it passes.
- Risks: transaction integration and packaging in one compiled binary; incorrect invalidation
  (missing query dependencies, self-triggered staleness, loops); unbounded decomposition and recovery.
- Revisit if pg-boss on PGlite fails inside the compiled binary (fall back to the own leased queue
  behind the same interface) or if a declared registry cannot express a needed flow.

## Sources

pg-boss database backends: https://pgboss.io/database-backends ·
pg-boss PGlite adapter: https://github.com/timgit/pg-boss/blob/master/src/adapters/pglite.ts ·
pg-boss workers and adapters: https://pgboss.io/api/workers, https://pgboss.io/api/adapters ·
Graphile Worker: https://worker.graphile.org/docs/faq, https://worker.graphile.org/docs/error-handling ·
DBOS configuration: https://docs.dbos.dev/typescript/reference/configuration ·
XState pure transitions: https://stately.ai/docs/pure-transitions ·
Temporal: https://docs.temporal.io/production-deployment · Hatchet: https://docs.hatchet.run/v1/embedded ·
Inngest: https://www.inngest.com/docs/self-hosting · BullMQ: https://docs.bullmq.io/guide/connections

## Amendment (2026-10-18, madarch-tzte.19.6)

The crash-injection suite found that a worker killed between its draft and its
publication leaves its unit in `draft` or `validating`, and that the table above
retried a lapsed lease only from `leased` and `running`: no step could move such a
unit, while the run's evidence went on counting it runnable and the product's chain
stayed active, so nothing could ever fill that product again. A lapsed lease is
therefore retried from every state an attempt holds a lease in — `leased`,
`running`, `draft` and `validating` — under the same guards, with the dead
attempt's draft retracted; the decision's own sentence is read as the four states
rather than the two it named. The same suite found that a unit whose job the queue
lost before its lease stands `ready` with nothing for a worker to claim, so the
run's sweep offers such a unit the queue again under its own singleton key, which
is idempotent. Both are in `docs/changes/fill-crash-suite`, with the tests that
hold them.

## Amendment (2026-10-20, madarch-tzte.26.3)

The first fill measured in madarch-tzte.26.1 planned no agent unit: a run plans
before any stage publishes, and a stage whose plan reads the graph its producers
write — every agent stage of 0026 — read an empty graph. The run therefore takes
one more step the table above did not name: `running → replan → planning`, which
reopens the planning epoch, taken when the run is quiet — nothing runnable, in
flight or waiting — and followed by `start` once the stages that planned no unit
and whose producers have published past their recorded attempt are planned. The
completion guard is the same closed planning epoch, closed again by the
re-planning's start; a stage whose plan answered is never planned again by the
run that recorded it, and a commit's update run (madarch-tzte.26.1) still reruns
only what it reaches. The change record names why this shape and not planning
deferred into the run: the deterministic stages' plans are incremental against
what the previous runs published, and a stage planned after its producer's
publication would diff the run's own output and plan nothing.
