# Checkpoint claims-answer fixture

`omp-claims-answer.txt` is the verbatim final assistant answer of the checkpoint 1 rerun
(madarch-p45j.4, 2026-10-17) claims agent call: `omp` with `shady2k-gateway/glm-5.3-flash-auto`
against the generated training repository, recorded by the wrapper tee in
`/tmp/madarch-p45j4-ckpt2/omp-calls/call-001-2026-10-17T15:14:18Z.jsonl` and documented in
`docs/changes/fill-pipeline-monday/checkpoint-1.md`. `registry.yaml` is the product registry that
run filled under (the training checkpoint authored it under `.madarch/fill/`).

The training repository that recorded answer cites is regenerated deterministically by
`examples/training-repository/generate.mjs`; its source ids reproduce byte-identically, so the
tests rebuild the real pinned sources instead of stubs.
