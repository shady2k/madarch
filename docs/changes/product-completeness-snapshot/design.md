# Design: product-owned completeness snapshot contract

## Drivers and constraints
The product skill set computes completeness once. Its committed snapshot is the
truth at the source revision and time it names. Madarch reads and renders that
snapshot, without recomputation or comparison with current content. The existing
product registry owns stage order and per-stage expected records.

## Inventory and choice
The registry contract lives in `src/product/schema.ts`, is published as
`schema/product-registry.schema.json`, and has pinned examples in
`examples/contract/registry-cases.json`; `bun run contract:check` runs those
cases. Follow that naming pattern for the new result: TypeBox source
`ProductCompleteness`, published file `schema/product-completeness.schema.json`,
and pinned cases `examples/contract/completeness-cases.json`. The product's
snapshot file is `docs/completeness.json`, parallel to its `docs/kinds.yaml`
registry. Its fields are `contract`, `computedAt`, `sourceRevision`, and
`findings` (`stage`, `message`). The snapshot uses contract version 1 and a
versioned schema `$id`, following the registry schema's published contract
pattern.

Extend registry v1 with additive optional manifest data: stage `expected` and
`sections` (the engine-provided architecture/repositories sections),
registry `overview.audience` source, and per-kind `questions` form. Keep v1
because these fields add optional declarations without changing prior v1
interpretation; the previous v1 files remain valid.

## Consequences
The engine validates the snapshot schema, exposes its findings with stages,
and includes snapshot content in its live revision. Missing snapshots have no
findings. `src/wiki/stages.ts` does not calculate missing records. The demo's
existing product-specific labels and expectations live in its manifest and
snapshot. The external skill-set writer and the later empty-folder instruction
remain out of scope.
