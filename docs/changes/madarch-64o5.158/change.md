# A fill's progress sink reaches the orchestrator the service creates

Change: madarch-64o5.158
Base: f1c275289ba34eec5240a11aa573cabb76cac256
Tasks: madarch-64o5.158
Kind: no-behavior

## Intent

`FillOrchestratorServiceOptions` declares the caller's progress `sink` and the
service dropped it while building the orchestrator it holds, so a caller of
`runFill` that named a sink heard no progress event at all: not `run-planned`,
not `stage-planned`, not the `unit-failed` of a failed plugin unit. The service
now forwards the sink it was given to the `FillOrchestrator` it creates, so the
sink hears every event the orchestrator appends to the run's durable progress
record, in the order the record holds them.

## Out of scope

- What a progress event is and when it is appended: `src/fill/orchestrator.ts` keeps deciding both.
- The durable progress record's shape, its reader and its ordering.
- Every other option of the service: the audit beside the fix found none of the remaining options dropped.

## Rationale

Callers already hand a sink over — `runFill` forwards `options.sink` into the service, and
several tests name one for diagnostics — and nothing heard it. The harvest of `unit-failed`
and `unit-blocked` events a caller relies on was silently empty, which reads as a run with
nothing to report rather than as a dropped wire. The fix is the one missing forwarded option.
The one consumer a running product already names hears it now: `startKnowledgeFill`
(`src/knowledge/fill-run.ts:296-309`) hands `unit-published` to `KnowledgeProduct.published()`
(`src/knowledge/product.ts:1244`), so an embedded fill revisits the store as it fills — once at
once, then no more than once every 8 s, never awaited and inside a `catch`.

## Preserved contracts

- fill-orchestrator/host: the service still creates the orchestrator once per product and holds it; it only hands it the sink its caller gave.

## Coverage

- fill-orchestrator/host: static, test

## Where it is seen

Kind: internal
Place: `src/fill/orchestrator-host.ts`, `test/plugin-fill-scenarios.test.ts`
Reason: the fill's progress reaches a caller that asks for it; nothing a reader sees changes.

1. Run a fill whose plugin unit fails, handing `runFill` a sink that records every event.
2. Read the run's durable progress record and compare it with what the sink heard: the same events in the same order, the failed unit's `unit-failed` among them.
3. Ask a caller that names no sink for its run's progress: the durable record answers as before.

## Blocking questions

None.
