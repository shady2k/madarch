# Checkpoint 1 — stopped at claims validation

This is a partial run record, not a completed found/missed/invented evaluation. The fill did not produce a validated claims extraction or synthesized pages, so answer-key scoring and per-category results are unavailable.

## Setup

- Agent/model: OMP with `shady2k-gateway/glm-5.3-flash-auto` only.
- Scratch root: `/tmp/madarch-p45j4-6bo1p3w5`.
- Generated training source: `/tmp/madarch-p45j4-6bo1p3w5/training-source`.
- Scratch product: `/tmp/madarch-p45j4-6bo1p3w5/products/training-source`.
- Private answer key remains outside the generated repository at `examples/training-repository/answer-key.json`.
- Product registry was created in the scratch product at `docs/kinds.yaml` using the answer-key entity kind names. It was not added to the generated source repo or this repository.

## Run result

- First attempt exited before dispatch: the product had no `docs/kinds.yaml`; zero agent calls.
- After adding the scratch registry, its duplicate `S` prefix was rejected before dispatch; zero agent calls.
- The linked repository path was not a Git root for the dispatcher, so the generated training source was cloned into the product's `repos/training-source` directory.
- The fill then ran OMP. Inventory and four index units completed. The claims unit failed validation: `Agent output field sourceIds must be an array`.
- One resume invocation reused the same run and call counter, but its second OMP answer failed the same validation. The total persisted OMP call count is 2; `agent-calls.json` retains this count.
- Run ID: `0d81b5b0-bc0a-489e-9baa-bae31c78707a`. Current run status: blocked. Completed units are in `.madarch/fill/units/`; no claims output was written.
- First fill attempt duration was about 56 seconds; resume attempt about 144 seconds. These are tool wall times, not provider-only elapsed time. The assistant was stopped before using the 45-minute limit or 60-call cap.
- The single approved JSON probe used to confirm OMP JSON output reported 19,518 input tokens and 12 output tokens, with a 5,358 ms provider-reported duration. This probe was not a fill unit and is excluded from the fill totals. Fill-call token usage is not available because output did not pass unit validation; the run ledger records calls and the configured adapter can collect usage, but no valid claim unit persisted usage.
- Resume/reuse: the resume invocation reused inventory and four index outputs. It ran claims again. No second successful resume check was possible.

## Timing note

The coordinator reported that a prior `madarch init` served the wiki in the foreground for 1h37m before being killed. I did not start a foreground server. The first init attempt in this span also blocked in the foreground until the owner killed it; the coordinator attributed 1h37m to that wait. This delay is not part of the fill attempt durations above.

## Next step

A fresh worker owns parser/retry task `madarch-tzte.10`: tolerate only unambiguous malformed-answer forms, retry with validation errors, and persist a failed unit after bounded retries. After that fix lands, rerun the checkpoint from a clean scratch product under the same agent/model and limits. Do not treat this partial attempt as evidence of extraction accuracy.
