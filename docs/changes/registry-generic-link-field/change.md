# The registry reader refuses a link field named after a generic document field

Change: registry-generic-link-field
Base: 9ac753e557c3428e77573dab3f786cc2a27c1fbc
Tasks: madarch-jhyf
Kind: no-behavior

## Intent
The contract-v1 proposal (standalone-contract-v1) and decision 0021's
amendment require the reading of a kinds registry to refuse a link field
named `id`, `kind`, `status` or `links` — the generic fields madarch reads
itself, the case never making it another field. `parseContractText`
accepted such a field; found by the closure review of the spec sync
(madarch-m8eo.1, 2026-10-13), whose closure waits on it. The behavior was
already decided: this record carries the missed refusal to its place, so
the branch closes through its own record whose gate can pass, and says
plainly that no new behavior decision is claimed and no approval is
fabricated — the approval stays with the behavior change that owns the
decision (standalone-contract-v1).

Stories:
- As a person declaring in `docs/kinds.yaml` a link field named `status`,
  the reading refuses naming the file, the line, the field's path and the
  words — like every other registry refusal — instead of reading clean and
  letting the engine and the links disagree about one field name.

## Rationale
A missing refusal the spec already carried. The check stands beside the
link-field checks it belongs with, the words follow the reader's own
grammar (the field as written, the full generic list, never a silently
smaller one), and the case rides the conformance cases both the check
command and the test read.

## Out of scope
- The other surfaces the refusal rides (the `ContractError` shape, the
  wiki's plain-pages degradation for a refused registry): both already
  specified and landed; nothing about them changes.
- The set's pinned copy of the cases: mirrored deliberately on its side
  after the head sha is reported.

## Preserved contracts
- product-repository/draft: the created product's layout and its manifest reading are unchanged; the refusal joins the registry reading the draft's products carry (test)

## Coverage
- product-repository/draft: static, test
