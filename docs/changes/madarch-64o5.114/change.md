# Protect engine kinds at catalogue admission

Change: madarch-64o5.114
Base: 46459a319240b88b5a218c07ee0646ba0ef28856
Tasks: madarch-64o5.114
Kind: behavior

## Intent
Implement the catalogue admission part of decision 0039 items 8 and 9:
engine-owned system-kind declarations and explicit additive product inheritance.
This is a partial increment, not installation or automatic upgrade acceptance.

## Out of scope
System installation into every product; durable immutable contract versions and
effective-version edges; migration and activation transactions; per-kind holds;
durable upgrade problems and agent-first resolution; operational entities moved
from their old storage. These require the assertion-storage and generated
migration boundary of madarch-64o5.74. Decision 0039 item 34 is not implemented.
No temporary version store, sidecar, new table, or real agent fill is introduced.

## Changes to requirements
- product-repository/system-kind-admission: explicit inheritance and immutable base fields at product catalogue admission.

## Preserved contracts
- product-repository/contract: ordinary product kinds retain the existing catalogue validator and graph generator.

## Coverage
- product-repository/system-kind-admission: static test mutation review
- product-repository/contract: static test review

## Where it is seen
Kind: internal
Place: catalogue validation before publication
Reason: no screen layout or UI component changes.

1. Validate a product declaration that replaces a system kind without inheritance.
2. Read the refusal's absolute file path and YAML line.
3. Add explicit inheritance and a new scalar field; validate the composed declaration.

## Design and decisions
The shipped declarations are engine input, not proof that every product has
installed system assertions. Direct parser admission and declared extensions
must not be confused with a graph effective-version resolver. On this base,
publication still records one whole product catalogue, schema preparation can
prune absent kinds, and runtime contracts read that global snapshot. Activating
per-kind holds through those paths would be unsafe. The final integration must
select the effective catalogue before preparation and atomically migrate graph
assertions and switch effective-version edges using the new storage boundary.

The admission syntax is `extends: system:run` for a declaration named `run`.
Each minimal base declares only an optional display label produced by `system`;
operational fields are not guessed from old tables. Descriptive and presentation
metadata may be validated on top. Catalogue-only declarations retain their
existing no-page behavior; they do not install a hidden runtime contract in this
increment. Plugin-bound additions to these keyless bases are explicitly refused in this
increment: the existing plugin transport cannot update or retract them by UID.
Admitted additions still require the ordinary explicit producer declaration. No version constant or
confidence threshold is introduced.

## Acceptance evidence
After the final explicit plugin-binding refusal, the foreground focused run
passes 147 tests across seven files, with 1 978 assertions and zero failures:
`system-catalogue`, `manifest-publication`, `manifest-contract`,
`kinds-folder-loader`, `draft-templates`, `architecture-gates`, and `catalog-read`.
Foreground `bun run check` passes all TypeScript, architecture, UI, catalogue,
workflow and quarantine checks. Architecture debt remains 1 229, with no gained
entry; the catalogue has 526 kinds and 83 page/member kinds.

The unchanged wiki app previously passed its check and all 129 tests. Bounded
manual mutations killed four original admission mutants, the architecture
vocabulary mutant, and the final explicit plugin-binding-refusal mutant. Each
original was restored before the final green checks. This is not a full Stryker
run. Logs: `/tmp/madarch-64o5.114-focused.log` and
`/tmp/madarch-64o5.114-check.log`.

Independent review found and prompted fixes for catalogue-only page/fill
activation and unsafe keyless plugin binding. Catalogue-only extensions now
remain metadata-only, graph additions under that policy are refused, and
plugin-bound extensions receive an explicit UID-transport limitation refusal.
No keyless plugin runtime exception remains.

The document check remains blocked by the explicitly recorded blocking questions,
tracker task lookup and owner approval; no tracker tools or approval bypass was used. No full root suite or installed-system/upgrade
acceptance is claimed. The task remains partial and must not be closed on this
record.
